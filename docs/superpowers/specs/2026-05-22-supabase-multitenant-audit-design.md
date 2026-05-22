# Supabase Multitenant AI Platform — Audit + Capabilities Design

Estado: spec aprobado por enzo, listo para plan de implementacion.
Fecha: 2026-05-22.
Autor: brainstorming session journey-first con enzo.
Memoria base: [`journey_first_design`](../../../.claude/projects/-Users-enzo-sda-framework-sda-framework/memory/feedback_journey_first_design.md).

## Resumen

Cerrar la brecha entre el SDA Framework actual (excelente pipeline de ingesta
e indexacion documental) y una plataforma SaaS multi-tenant de IA empresarial
real: lo que un empleado, manager, knowledge admin y tenant owner necesitan
hacer todos los dias dentro del producto. El diseno parte de las acciones del
empleado (`journey-first`) y deriva tablas, RLS, RPCs, triggers y jobs desde
ahi. Cruza con las decisiones de modelo de negocio tomadas en sesion:

- Deploy: SaaS multi-tenant centralizado.
- LLM: tu app es duena de las keys; tenant solo paga.
- Billing: usage-puro, granular por LLM call y embedding.
- Compliance: liviano (data export + soft-delete + audit enriquecido).
- Knowledge orgs: workspaces + collections + tags + groups + ACL granular via
  visibilidad de coleccion.
- Connectors: Google Drive + Microsoft 365 (SharePoint/OneDrive).
- API externa: nada por ahora (solo browser JWT).

## Por que journey-first

El error de un disenio schema-first es agregar tablas que reflejan el
organigrama RBAC en vez de reflejar el trabajo real. En SaaS B2B documental el
valor lo dan las acciones cotidianas: preguntar, citar, anotar, compartir,
guardar, reportar, asignar, suscribirse, ver actividad reciente. Sin esas
capacidades el producto es un buscador con login. El spec las modela como
ciudadanos de primera clase.

## Estado actual

Lo que ya funciona y no se toca:

- 17 tablas con RLS por `tenant_id` y JWT hook que inyecta
  `tenant_id / tenant_role / tenant_slug / tenant_status / user_status /
  claims_version`.
- Doble representacion del arbol: `doc_tree` JSONB + `doc_tree_nodes`
  normalizada con `ltree` y embeddings HNSW por nodo, derivada via CTE
  recursivo desde el JSON.
- `chunks` con `tsvector`, `gin_trgm` y HNSW: retrieval hibrido listo.
- Versionado de pipeline en 5 ejes (`extraction`, `indexing`, `tree_indexer`,
  `embedding`, `tree_prompt`) propagado a `documents / indexing_runs /
  doc_tree / chunks / doc_tree_nodes`, con `lib/system-versions.json` como
  fuente de verdad y `system_component_versions` como auditoria historica.
- Idempotencia: unique parcial `indexing_runs (tenant_id, document_id) WHERE
  status in ('queued','running')` + `extraction_pipeline_version` en cache key
  de extracciones.
- Storage RLS regex strict: `<uuid-tenant>/<uuid-doc>/<safe-filename>`.
- Realtime triple capa: Postgres Changes (5 tablas), Broadcast desde DB (3
  triggers `realtime.send`), Presence/Broadcast cliente autorizado por
  `app.is_allowed_realtime_topic`.
- Observabilidad DB-side: vista `indexing_health_anomalies` (6 anomalias
  declarativas) + matview `indexing_health_snapshot` refresh cada 5 min via
  `pg_cron` + `cleanup_operational_data` diario.
- Audit log con 4 triggers automaticos (`documents.status`,
  `indexing_runs.status`, `users.role`, `tenant_invites.status`).
- RPCs `security definer` con check manual de tenant + audit_log: patron
  consistente para escritura desde browser.

Patron transversal de defensa: composite FK `(tenant_id, id)` desde tablas
hijas a `documents(tenant_id, id)`. Garantiza que un `doc_tree`, `chunks` o
`indexing_runs` no pueda apuntar a un documento de otro tenant aunque el
codigo se equivoque. Es belt-and-suspenders sobre RLS.

## Decisiones tomadas en la sesion

1. Deploy SaaS multi-tenant centralizado.
2. LLM centralizado (app dueno de las keys; sin BYO en esta version).
3. Billing usage-puro: granular por LLM call y embedding; Stripe externo;
   mirror minimal en DB.
4. Compliance liviano: data export + soft-delete + audit enriquecido. Sin
   SAML/SCIM/retention-configurable en este corte.
5. Jerarquia: `tenant -> workspaces -> collections`, con `groups` a nivel
   tenant (no por workspace).
6. Visibilidad: documentos pertenecen a un workspace "home"; comparticion
   entre workspaces ocurre cuando una `collection` se marca como
   `tenant_public`. ACL granular per-row queda descartada.
7. JWT con `active_workspace_id`: el user elige workspace activo en la UI
   (switcher), se refresca el JWT, RLS filtra por ese workspace activo.
8. Connectors prioritarios: Google Drive + Microsoft 365.
9. API externa diferida: nada de API keys / service accounts / webhooks
   salientes en este corte; el schema queda con la puerta abierta.
10. Chat conversational: las tablas (`conversations`, `messages`,
    `langgraph_checkpoints`) ya estan; este spec agrega capacidades
    necesarias para que el agente sea util (feedback, citations, sharing).

## Personas tipo y journeys

Cinco personas con sus acciones cotidianas. Cada journey se referencia mas
abajo como JN.

### Persona 1 — Empleado / Knowledge worker (Juan)

90% consumo, 10% contribucion.

| ID  | Accion                                                          | Tabla / capacidad nueva                          |
|-----|-----------------------------------------------------------------|--------------------------------------------------|
| J1  | Pregunta al agente, recibe respuesta con citas.                 | Agent runtime + RPC `start_conversation`         |
| J2  | Click en cita abre el PDF en la pagina exacta.                  | Ya existe (`source_blocks` + `file-url`)         |
| J3  | Marca respuesta como utl / mala con comentario.                 | `message_feedback`                               |
| J4  | Guarda respuesta o seccion como favorito.                       | `user_bookmarks`                                 |
| J5  | Comparte link de doc/respuesta con companeros.                  | `shared_links` (no transfiere permisos)          |
| J6  | Anota una seccion del doc.                                      | `document_annotations` + `annotation_replies`    |
| J7  | Busqueda literal "penalty clause" filtrada por workspace/tags.  | RPC `search_chunks` + `search_documents`         |
| J8  | Se suscribe a "novedades del workspace Contratos".              | `notifications` + `notification_preferences`     |
| J9  | "Avisame si aparece algo sobre normativa fiscal 2026".          | `saved_queries` + scheduler                      |
| J10 | Solicita acceso al workspace Finanzas.                          | `access_requests`                                |
| J11 | Reporta doc outdated / incorrecto.                              | `document_issues`                                |

### Persona 2 — Manager (Marta, lider de Legal)

| ID  | Accion                                                          | Tabla / capacidad nueva                          |
|-----|-----------------------------------------------------------------|--------------------------------------------------|
| J12 | Ve actividad reciente del workspace y top consultados.          | `document_views` + vistas materializadas         |
| J13 | Comparte hallazgo con todo el group "Legal".                    | `shared_links.audience = 'group'`                |
| J14 | Reasigna un `document_issue` a alguien del equipo.              | `document_issues.assignee_id` + notif            |
| J15 | Ve cuanto se uso la plataforma este mes en su workspace.        | Aggregations sobre conversations/messages        |
| J16 | Sube manual y elige workspace + coleccion.                      | `documents.workspace_id` + RPC actualizada       |
| J17 | Reemplaza la politica 2025 con la 2026 manteniendo linaje.      | `document_lineage`                               |

### Persona 3 — Knowledge Admin (Carlos)

| ID  | Accion                                                          | Tabla / capacidad nueva                          |
|-----|-----------------------------------------------------------------|--------------------------------------------------|
| J18 | Conecta Google Drive / M365 y elige carpetas a sincronizar.     | `document_sources` + `tenant_oauth_credentials`  |
| J19 | Bulk: mueve 30 docs y aplica tags.                              | RPC `bulk_update_documents`                      |
| J20 | Cambia visibility de coleccion a `tenant_public` (con warning). | `collections.visibility` + audit                 |
| J21 | Revisa health de ingesta (failed, sin tree, version drift).     | Ya existe `indexing_health_anomalies`            |
| J22 | Soft-delete de doc con ventana de recuperacion.                 | `documents.deleted_at` + retention job           |

### Persona 4 — Tenant Owner / IT (Sofia)

| ID  | Accion                                                          | Tabla / capacidad nueva                          |
|-----|-----------------------------------------------------------------|--------------------------------------------------|
| J23 | Invita user con rol tenant + workspaces/groups pre-asignados.   | `tenant_invites` extendido o `_grants`           |
| J24 | Ve consumo del mes desglosado por workspace/user/kind.          | `usage_records` + `usage_aggregates_daily`       |
| J25 | Revisa estado de subscripcion y proximo invoice.                | Mirror minimal Stripe                            |
| J26 | Audita actividad sensible: quien hizo que, cuando, desde donde. | `audit_log` enriquecido                          |
| J27 | Exporta todos los datos del tenant.                             | `data_exports` + worker dump                     |

### Persona 5 — El agente IA

| ID  | Accion                                                          | Tabla / capacidad nueva                          |
|-----|-----------------------------------------------------------------|--------------------------------------------------|
| J28 | Busca docs candidatos por summary global / routing summary.     | RPC `search_tree_nodes_by_embedding`             |
| J29 | Navega el arbol (padres/hijos/hermanos).                        | RPC `navigate_tree`                              |
| J30 | Recupera evidencia (pagina/bloque).                             | RPC `get_document_evidence`                      |
| J31 | Registra consumo de tokens y citation logs.                     | `usage_records` + `message_citations`            |
| J32 | Cuando recibe feedback, lo trazea a la cita exacta.             | `message_feedback` + `message_citations`         |
| J33 | Crea TODOs/agendas desde extracciones del agente.               | `agent_tasks` + notifications                    |

## Mapa de capacidades nuevas (27 items, 3 tiers)

Tier 1 — Foundation del modelo journey-first. Sin esto el resto no engancha.

1. `workspaces` + `workspace_memberships` + claim `active_workspace_id` en
   JWT.
2. `groups` + `group_memberships` (a nivel tenant).
3. `collections` + `document_collections` + `collections.visibility`.
4. `tags` + `document_tags`.
5. `documents.workspace_id` (NOT NULL post-backfill).
6. `documents.deleted_at` + soft-delete pattern + retention job.
7. RLS unificada con helpers `app.user_can_read_document`,
   `app.user_can_edit_document`, `app.current_workspace_id`,
   `app.user_belongs_to_workspace`.
8. Migracion: workspace `Default` por tenant; mover docs existentes.

Tier 2 — Multiplicadores de uso. Lo que hace que la gente vuelva.

9.  `message_feedback` + `message_citations`.
10. `user_bookmarks`.
11. `shared_links`.
12. `document_annotations` + `annotation_replies`.
13. `notifications` + `notification_preferences` + triggers + extension de
    `app.is_allowed_realtime_topic` para topic inbox.
14. `document_views`.
15. `document_issues`.
16. `document_lineage`.
17. `access_requests`.
18. `saved_queries` + scheduler worker.
19. `audit_log` enriquecido (`request_id`, `session_id`, `ip`, `user_agent`).
20. ~~`agent_tasks`~~ DIFERIDO — ver seccion al respecto.

Tier 3 — Enterprise depth.

21. `document_sources` + `document_source_cursors` +
    `tenant_oauth_credentials` (cifrado).
22. `usage_records` + `usage_aggregates_daily` + report RPCs.
23. Mirror minimal Stripe (`stripe_customers`, `stripe_subscriptions`).
24. `data_exports` + worker dump.
25. Particionado: `audit_log` y `indexing_events` por mes.
26. Migracion a `halfvec` en `chunks.embedding` y `doc_tree_nodes.embedding`.
27. Vistas materializadas: actividad reciente, top docs, hot issues.

## Modelo de datos — Tier 1

### `workspaces`

Sub-divisiones dentro del tenant: proyectos, departamentos, areas de
conocimiento. Un workspace agrupa colecciones y documentos. Hereda
`tenant_id` para defensa en profundidad.

```sql
create type public.workspace_status as enum ('active', 'archived');

create table public.workspaces (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9_-]*$'),
  name text not null,
  description text,
  status public.workspace_status not null default 'active',
  settings jsonb not null default '{}'::jsonb,
  archived_at timestamptz,
  deleted_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),       -- composite FK target
  unique (tenant_id, slug)
);

create index workspaces_tenant_status_idx on public.workspaces (tenant_id, status);
create index workspaces_tenant_deleted_at_idx
  on public.workspaces (tenant_id) where deleted_at is null;
```

### `workspace_memberships`

Acceso al workspace por usuario o por grupo. Roles por workspace independientes
del rol tenant.

```sql
-- IMPORTANTE: el orden de declaracion del enum define el orden de comparacion.
-- declarado de menor a mayor para que `max(role)` resuelva al rol mas alto
-- naturalmente cuando un user es miembro directo y via grupo a la vez.
create type public.workspace_role as enum (
  'workspace_viewer',   -- ve, busca, anota privado, comenta annotations
  'workspace_editor',   -- sube, edita, mueve, anota, comparte
  'workspace_admin'     -- gestiona miembros, settings, collections, lineage
);

create type public.principal_kind as enum ('user', 'group');

create table public.workspace_memberships (
  workspace_id uuid not null,
  tenant_id uuid not null,
  principal_kind public.principal_kind not null,
  principal_id uuid not null,    -- user_id o group_id segun principal_kind
  role public.workspace_role not null default 'workspace_viewer',
  added_at timestamptz not null default now(),
  added_by uuid references auth.users(id) on delete set null,
  primary key (workspace_id, principal_kind, principal_id),
  foreign key (tenant_id, workspace_id)
    references public.workspaces(tenant_id, id) on delete cascade
);

create index workspace_memberships_principal_idx
  on public.workspace_memberships (tenant_id, principal_kind, principal_id);
```

### `groups` y `group_memberships`

Grupos a nivel tenant. Un grupo puede ser miembro de varios workspaces. Los
roles los carga `workspace_memberships`; el grupo en si no tiene rol propio.

```sql
create table public.groups (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_-]*$'),
  name text not null,
  description text,
  metadata jsonb not null default '{}'::jsonb,
  deleted_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, key)
);

create table public.group_memberships (
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  tenant_id uuid not null,
  added_by uuid references auth.users(id) on delete set null,
  added_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create index group_memberships_tenant_user_idx
  on public.group_memberships (tenant_id, user_id);
create index groups_tenant_deleted_at_idx
  on public.groups (tenant_id) where deleted_at is null;
```

### `collections` y `document_collections`

Carpetas logicas dentro del workspace. Visibility define si el contenido se
queda en el workspace o se hace publico al tenant entero.

```sql
create type public.collection_visibility as enum (
  'workspace_private',  -- solo miembros del workspace
  'tenant_public'       -- todo el tenant lo ve
);

create table public.collections (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  workspace_id uuid not null,
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9_-]*$'),
  name text not null,
  description text,
  visibility public.collection_visibility not null default 'workspace_private',
  icon text,                         -- emoji o nombre de icono
  color text,
  metadata jsonb not null default '{}'::jsonb,
  deleted_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (workspace_id, slug),
  foreign key (tenant_id, workspace_id)
    references public.workspaces(tenant_id, id) on delete cascade
);

create index collections_workspace_idx on public.collections (tenant_id, workspace_id);
create index collections_visibility_idx
  on public.collections (tenant_id, visibility)
  where visibility = 'tenant_public' and deleted_at is null;

create table public.document_collections (
  tenant_id uuid not null,
  document_id uuid not null,
  collection_id uuid not null,
  added_by uuid references auth.users(id) on delete set null,
  added_at timestamptz not null default now(),
  primary key (document_id, collection_id),
  foreign key (tenant_id, document_id)
    references public.documents(tenant_id, id) on delete cascade,
  foreign key (tenant_id, collection_id)
    references public.collections(tenant_id, id) on delete cascade
);

create index document_collections_collection_idx
  on public.document_collections (tenant_id, collection_id);
```

### `tags` y `document_tags`

Taxonomia flexible a nivel tenant. Un mismo tag puede aplicarse desde
cualquier workspace.

```sql
create table public.tags (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  key text not null check (key ~ '^[a-z0-9][a-z0-9_-]*$'),
  label text not null,
  color text,
  description text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, key)
);

create table public.document_tags (
  tenant_id uuid not null,
  document_id uuid not null,
  tag_id uuid not null references public.tags(id) on delete cascade,
  added_by uuid references auth.users(id) on delete set null,
  added_at timestamptz not null default now(),
  primary key (document_id, tag_id),
  foreign key (tenant_id, document_id)
    references public.documents(tenant_id, id) on delete cascade
);

create index document_tags_tag_idx on public.document_tags (tenant_id, tag_id);
```

### Mutaciones a `documents`

```sql
alter table public.documents
  add column workspace_id uuid,
  add column deleted_at timestamptz,
  add column deleted_by uuid references auth.users(id) on delete set null,
  add constraint documents_workspace_fk
    foreign key (tenant_id, workspace_id)
    references public.workspaces(tenant_id, id) on delete restrict;

-- backfill: crear workspace "Default" por tenant y asignar documentos
-- existentes (ver seccion Migracion).

alter table public.documents
  alter column workspace_id set not null;

create index documents_workspace_status_idx
  on public.documents (tenant_id, workspace_id, status, created_at desc)
  where deleted_at is null;

create index documents_deleted_at_idx
  on public.documents (tenant_id, deleted_at)
  where deleted_at is not null;
```

## Modelo de visibilidad y RLS

Toda la nueva superficie comparte un patron RLS unico, soportado por funciones
en el esquema `app`. Las policies son `for select to authenticated using
(...)` y el `using` siempre arranca con `tenant_id = (select
app.current_tenant_id())`.

### Helpers en `app`

```sql
-- claim del JWT
create or replace function app.current_workspace_id()
returns uuid language sql stable set search_path = '' as $$
  select nullif(
    coalesce(
      auth.jwt() ->> 'active_workspace_id',
      auth.jwt() #>> '{app_metadata,active_workspace_id}'
    ),
    ''
  )::uuid;
$$;

-- user pertenece directamente o via group?
create or replace function app.user_belongs_to_workspace(_workspace_id uuid)
returns boolean language sql stable set search_path = '' as $$
  select exists (
    select 1
    from public.workspace_memberships wm
    where wm.tenant_id = (select app.current_tenant_id())
      and wm.workspace_id = _workspace_id
      and (
        (wm.principal_kind = 'user' and wm.principal_id = (select auth.uid()))
        or (
          wm.principal_kind = 'group'
          and exists (
            select 1 from public.group_memberships gm
            where gm.group_id = wm.principal_id
              and gm.user_id = (select auth.uid())
          )
        )
      )
  );
$$;

-- rol efectivo del user en el workspace (toma el mayor entre membresia
-- directa y via grupos). NOTA: Postgres no tiene `max(enum)`. Usamos
-- `order by ... desc limit 1` aprovechando que el enum se declara de menor
-- a mayor (viewer < editor < admin), por lo que el orden natural devuelve
-- el rol mas alto primero.
create or replace function app.user_workspace_role(_workspace_id uuid)
returns public.workspace_role language sql stable set search_path = '' as $$
  select role
  from (
    select wm.role
    from public.workspace_memberships wm
    where wm.tenant_id = (select app.current_tenant_id())
      and wm.workspace_id = _workspace_id
      and wm.principal_kind = 'user'
      and wm.principal_id = (select auth.uid())
    union all
    select wm.role
    from public.workspace_memberships wm
    join public.group_memberships gm on gm.group_id = wm.principal_id
    where wm.tenant_id = (select app.current_tenant_id())
      and wm.workspace_id = _workspace_id
      and wm.principal_kind = 'group'
      and gm.user_id = (select auth.uid())
  ) role_resolution
  order by role desc
  limit 1;
$$;

create or replace function app.user_can_read_document(_document_id uuid)
returns boolean language sql stable set search_path = '' as $$
  select exists (
    select 1
    from public.documents d
    where d.id = _document_id
      and d.tenant_id = (select app.current_tenant_id())
      and d.deleted_at is null
      and (
        (select app.is_tenant_admin())                                  -- admin tenant
        or (select app.user_belongs_to_workspace(d.workspace_id))       -- workspace home
        or exists (                                                     -- coleccion publica
          select 1
          from public.document_collections dc
          join public.collections c on c.id = dc.collection_id
          where dc.document_id = d.id
            and c.tenant_id = d.tenant_id
            and c.visibility = 'tenant_public'
            and c.deleted_at is null
        )
      )
  );
$$;

create or replace function app.user_can_edit_document(_document_id uuid)
returns boolean language sql stable set search_path = '' as $$
  select exists (
    select 1
    from public.documents d
    where d.id = _document_id
      and d.tenant_id = (select app.current_tenant_id())
      and d.deleted_at is null
      and (
        (select app.is_tenant_admin())
        or app.user_workspace_role(d.workspace_id)
             in ('workspace_editor','workspace_admin')
      )
  );
$$;
```

### Policies revisadas

`documents`:

```sql
drop policy if exists documents_select_tenant on public.documents;
create policy documents_select_visible on public.documents
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and deleted_at is null
    and (select app.user_can_read_document(id))
  );

-- escritura sigue siendo via RPCs (write boundary). El delete sigue restringido
-- al owner uploading/failed; el soft-delete normal se hace via RPC
-- `archive_document` que setea `deleted_at`.
```

`collections`, `document_collections`, `tags`, `document_tags`,
`document_annotations`, `user_bookmarks`, etc.: cada una replica el patron
"tenant + visibilidad efectiva" usando los helpers. Patron escrito en una
sola pagina de docs (`docs/backend/02-auth-tenants-rls.md`, revisada en este
spec).

`workspaces`:

```sql
create policy workspaces_select_member on public.workspaces
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and deleted_at is null
    and (
      (select app.is_tenant_admin())
      or (select app.user_belongs_to_workspace(id))
    )
  );
```

`groups`:

```sql
create policy groups_select_tenant on public.groups
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and deleted_at is null
  );
-- todos los users del tenant pueden ver los nombres de grupos (directorio).
-- la membership detallada se restringe en `group_memberships`.
```

## JWT claims extendidos

Hoy:
```
sub, email, tenant_id, tenant_role, tenant_slug, tenant_status,
user_status, claims_version, app_metadata.*
```

Despues:
```
+ active_workspace_id   (NUEVO, hint para UI)
+ active_workspace_role (NUEVO, hint para UI)
+ claims_version = 2    (bump)
```

`app.custom_access_token_hook` se extiende para:

1. Leer `user_metadata.active_workspace_id` (lo setea el cliente cuando
   cambia de workspace via `supabase.auth.updateUser({ data: {
   active_workspace_id } })`).
2. Validar que el user es miembro de ese workspace (directo o via group).
3. Si valido, inyectar el claim y el rol efectivo
   (`app.user_workspace_role`).
4. Si invalido o no existe, omitir el claim. En ese modo el user puede
   navegar la lista de workspaces pero queries de `documents` solo retornan
   admins-only o coleccion publica.

**Invariante critica de seguridad**: el claim `active_workspace_role` es
solo un *hint para UI*. RLS y `app.user_can_*_document` NUNCA deciden acceso
leyendo el claim; siempre consultan `workspace_memberships` y
`group_memberships` en runtime. Esto neutraliza el riesgo de un JWT vivo
(TTL hasta 1h) que conserve un rol que ya fue revocado: la siguiente query
del user re-verifica membership en la tabla y, si fue removido, no ve
nada. El claim solo sirve para que la UI elija que workspace abrir por
default y que controles mostrar/ocultar.

Ningun otro claim cambia. `tenant_id` sigue siendo la frontera dura.

## Modelo de datos — Tier 2

### Soft-delete pattern

Aplicable a `documents`, `conversations`, `collections`, `workspaces`,
`groups`, `tags`. Convencion: columna `deleted_at timestamptz` (null cuando
vivo). Las RLS policies excluyen filas con `deleted_at` no nulo (excepto las
de admin/restauracion). Hard-delete diferido por `cleanup_operational_data`
extendido (retention default 30 dias, configurable via parametro).

### `message_feedback` y `message_citations`

```sql
create type public.message_feedback_kind as enum (
  'helpful',
  'unhelpful',
  'wrong',
  'missing_citation',
  'inappropriate'
);

create table public.message_feedback (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  conversation_id uuid not null,
  message_id uuid not null,
  -- nullable + set null al borrar user: preservamos la senal de feedback
  -- aunque la persona se vaya de la empresa. Es ground truth para fine-tune
  -- y eval del agente; perder eso al borrar un user es destruir valor.
  user_id uuid references auth.users(id) on delete set null,
  kind public.message_feedback_kind not null,
  comment text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, conversation_id)
    references public.conversations(tenant_id, id) on delete cascade
);
-- nota: sin `unique (message_id, user_id, kind)` porque user_id es nullable
-- y la dedupe se hace en la RPC `submit_message_feedback` (un solo registro
-- por user/message/kind vivo).

create index message_feedback_message_idx
  on public.message_feedback (tenant_id, message_id);
create index message_feedback_kind_created_idx
  on public.message_feedback (tenant_id, kind, created_at desc);

create table public.message_citations (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  message_id uuid not null,
  conversation_id uuid not null,
  document_id uuid not null,
  node_id text,
  page_start integer,
  page_end integer,
  span jsonb,           -- {start,end,kind} si la cita es por offset
  score numeric(5,4),   -- score de retrieval (cosine / hybrid)
  used boolean not null default true,  -- si terminó usada en la respuesta
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, conversation_id)
    references public.conversations(tenant_id, id) on delete cascade,
  foreign key (tenant_id, document_id)
    references public.documents(tenant_id, id) on delete cascade
);

create index message_citations_message_idx
  on public.message_citations (tenant_id, message_id);
create index message_citations_document_idx
  on public.message_citations (tenant_id, document_id);
```

### `user_bookmarks`

```sql
create type public.bookmark_target_kind as enum (
  'document',
  'doc_tree_node',
  'conversation',
  'message',
  'collection'
);

create table public.user_bookmarks (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  target_kind public.bookmark_target_kind not null,
  target_id uuid not null,
  label text,
  folder text,                       -- agrupacion libre del user
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, target_kind, target_id)
);

create index user_bookmarks_user_idx
  on public.user_bookmarks (tenant_id, user_id, created_at desc);
```

### `shared_links`

```sql
create type public.shared_link_target_kind as enum (
  'document',
  'doc_tree_node',
  'conversation',
  'message',
  'collection',
  'saved_query'
);

create type public.shared_link_audience as enum (
  'workspace',           -- todos los miembros del workspace home
  'group',               -- miembros de un grupo especifico
  'user_set',            -- lista de user_ids explicita
  'tenant_with_token'    -- cualquier user del tenant con el token
);

create table public.shared_links (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  target_kind public.shared_link_target_kind not null,
  target_id uuid not null,
  audience public.shared_link_audience not null,
  audience_workspace_id uuid,
  audience_group_id uuid,
  audience_user_ids uuid[],
  token_hash text,                   -- presente solo si audience = tenant_with_token
  message text,                      -- mensaje opcional del compartidor
  created_by uuid references auth.users(id) on delete set null,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  check (
    (audience = 'workspace' and audience_workspace_id is not null) or
    (audience = 'group'     and audience_group_id is not null) or
    (audience = 'user_set'  and audience_user_ids is not null and array_length(audience_user_ids, 1) > 0) or
    (audience = 'tenant_with_token' and token_hash ~ '^[a-f0-9]{64}$')
  )
);

create index shared_links_tenant_target_idx
  on public.shared_links (tenant_id, target_kind, target_id);
create index shared_links_audience_workspace_idx
  on public.shared_links (audience_workspace_id) where audience_workspace_id is not null;
create index shared_links_audience_group_idx
  on public.shared_links (audience_group_id) where audience_group_id is not null;
create unique index shared_links_token_hash_idx
  on public.shared_links (token_hash) where token_hash is not null;
```

Regla critica documentada: el share-link NO transfiere permisos. El recurso
target se evalua siempre con las RLS del viewer. El share-link solo *senala*
y aparece en la inbox del audience cuando corresponde.

### `document_annotations` y `annotation_replies`

```sql
create type public.annotation_kind as enum (
  'note',
  'highlight',
  'question',
  'issue',
  'review_request'
);

create type public.annotation_visibility as enum (
  'private',           -- solo el author
  'workspace',         -- todos los miembros del workspace home del doc
  'group',             -- un group especifico
  'mentions'           -- author + users mencionados en `mentioned_user_ids`
);

create table public.document_annotations (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  document_id uuid not null,
  node_id text,                      -- doc_tree_nodes.node_id si aplica
  page integer,
  bbox jsonb,                        -- [x0,y0,x1,y1] normalizado 0..1
  text_anchor jsonb,                 -- alternativa: span del texto, hash
  author_id uuid not null references auth.users(id) on delete cascade,
  body text not null,
  kind public.annotation_kind not null default 'note',
  visibility public.annotation_visibility not null default 'workspace',
  group_id uuid references public.groups(id) on delete set null,
  mentioned_user_ids uuid[],
  color text,
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  foreign key (tenant_id, document_id)
    references public.documents(tenant_id, id) on delete cascade,
  check (
    (visibility = 'group' and group_id is not null) or
    visibility <> 'group'
  )
);

create index document_annotations_doc_idx
  on public.document_annotations (tenant_id, document_id, created_at desc)
  where deleted_at is null;
create index document_annotations_author_idx
  on public.document_annotations (tenant_id, author_id) where deleted_at is null;
create index document_annotations_mentioned_idx
  on public.document_annotations using gin (mentioned_user_ids)
  where mentioned_user_ids is not null;

create table public.annotation_replies (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  annotation_id uuid not null references public.document_annotations(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  body text not null,
  mentioned_user_ids uuid[],
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index annotation_replies_annotation_idx
  on public.annotation_replies (tenant_id, annotation_id, created_at)
  where deleted_at is null;
```

### `notifications` y `notification_preferences`

```sql
create type public.notification_kind as enum (
  'document.new_in_workspace',
  'document.new_in_subscribed_collection',
  'document.issue_assigned',
  'document.issue_resolved',
  'annotation.replied',
  'annotation.mentioned',
  'shared_link.received',
  'saved_query.new_results',
  'agent_task.due_soon',
  'access_request.received',
  'access_request.decided',
  'indexing.failed_visible',
  'usage.threshold_crossed'
);

create table public.notifications (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind public.notification_kind not null,
  title text not null,
  body text,
  url text,                          -- deeplink dentro de la app
  target_kind text,                  -- mismo enum semantico que bookmarks
  target_id uuid,
  source_id uuid,                    -- annotation_id, shared_link_id, etc.
  read_at timestamptz,
  archived_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index notifications_user_unread_idx
  on public.notifications (tenant_id, user_id, created_at desc)
  where read_at is null and archived_at is null;
create index notifications_user_all_idx
  on public.notifications (tenant_id, user_id, created_at desc);

create type public.notification_channel as enum ('in_app', 'email');

create table public.notification_preferences (
  user_id uuid not null references auth.users(id) on delete cascade,
  tenant_id uuid not null,
  kind public.notification_kind not null,
  channel public.notification_channel not null default 'in_app',
  enabled boolean not null default true,
  -- inicialmente solo realtime/off. Modos `hourly/daily/weekly` se agregan
  -- cuando exista el worker de digest que los procese; antes seria deuda.
  digest text check (digest in ('realtime', 'off')) default 'realtime',
  updated_at timestamptz not null default now(),
  primary key (user_id, kind, channel)
);
```

Notifications se crean desde triggers DB-side cuando el evento es atomico
(annotation reply, shared link inserted) y desde el worker cuando es agregado
(saved_query hit, usage threshold). Se publica a realtime via Broadcast en
`tenant:<tenant_id>:user:<user_id>:inbox` para entrega live.

**Autorizacion del topic privado de inbox**: el helper actual
`app.is_allowed_realtime_topic` (migracion `20260521210000_realtime_product_channels.sql`)
solo whitelista `tenant:<id>:notifications` y `document:<id>:(presence|indexing)`.
Hay que extenderlo en una migracion explicita (sugerido en orden: 044 antes de
poblar notifications) para aceptar el topic de inbox y, criticamente, validar
que el `user_id` del topic matchee `auth.uid()`:

```sql
when _topic ~ '^tenant:[0-9a-f-]{36}:user:[0-9a-f-]{36}:inbox$' then (
  split_part(_topic, ':', 2) = (select app.current_tenant_id())::text
  and split_part(_topic, ':', 4) = (select auth.uid())::text
)
```

Sin este check, cualquier user del tenant podria escuchar la inbox de otro.

### `document_views`

Heartbeat liviano cuando el user ve un doc desde la app. Sin spam: el client
hace upsert con throttle de 30 segundos.

```sql
create table public.document_views (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  document_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  node_id text,                      -- si vio un nodo especifico
  source text check (source in ('search', 'agent_citation', 'direct_link', 'bookmark', 'shared_link', 'connector_feed')),
  dwell_seconds integer check (dwell_seconds is null or dwell_seconds >= 0),
  viewed_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  foreign key (tenant_id, document_id)
    references public.documents(tenant_id, id) on delete cascade
);

create index document_views_user_idx
  on public.document_views (tenant_id, user_id, viewed_at desc);
create index document_views_document_idx
  on public.document_views (tenant_id, document_id, viewed_at desc);
```

Particionable por mes (ver Tier 3).

### `document_issues`

```sql
create type public.document_issue_kind as enum (
  'outdated',
  'incorrect',
  'duplicate',
  'broken_link',
  'wrong_metadata',
  'pii_concern',
  'other'
);

create type public.document_issue_status as enum (
  'open',
  'triaged',
  'in_progress',
  'resolved',
  'wontfix'
);

create table public.document_issues (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  document_id uuid not null,
  reporter_id uuid not null references auth.users(id) on delete set null,
  assignee_id uuid references auth.users(id) on delete set null,
  kind public.document_issue_kind not null,
  description text,
  status public.document_issue_status not null default 'open',
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id) on delete set null,
  resolution_note text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, document_id)
    references public.documents(tenant_id, id) on delete cascade
);

create index document_issues_document_idx
  on public.document_issues (tenant_id, document_id, status);
create index document_issues_assignee_idx
  on public.document_issues (tenant_id, assignee_id, status)
  where assignee_id is not null;
create index document_issues_open_idx
  on public.document_issues (tenant_id, status, created_at desc)
  where status in ('open', 'triaged', 'in_progress');
```

### `document_lineage`

Vinculo entre versiones logicas de un mismo documento. Cuando se sube una
nueva version, se vincula al predecesor; el agente prefiere `latest_version`
para retrieval salvo que el query pida explicitamente version anterior.

```sql
create table public.document_lineage (
  tenant_id uuid not null,
  document_id uuid not null,
  predecessor_document_id uuid,
  -- denormalizados para sobrevivir hard-delete del predecesor.
  -- el FK on delete set null mantiene la fila historica accesible.
  predecessor_title text,
  predecessor_filename text,
  predecessor_indexed_at timestamptz,
  version_label text,                -- 'v1.0', 'enero 2026', etc.
  effective_from date,
  effective_to date,
  superseded_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  primary key (document_id),
  foreign key (tenant_id, document_id)
    references public.documents(tenant_id, id) on delete cascade,
  foreign key (tenant_id, predecessor_document_id)
    references public.documents(tenant_id, id) on delete set null,
  check (document_id <> predecessor_document_id)
);

create index document_lineage_predecessor_idx
  on public.document_lineage (tenant_id, predecessor_document_id)
  where predecessor_document_id is not null;
```

Vista derivada para resolver "ultima version":

```sql
create or replace view public.document_lineage_heads as
select
  dl.tenant_id,
  dl.document_id,
  dl.version_label,
  dl.effective_from,
  d.title,
  d.status
from public.document_lineage dl
join public.documents d
  on d.id = dl.document_id and d.tenant_id = dl.tenant_id
where dl.superseded_at is null and d.deleted_at is null;
```

### `access_requests`

```sql
-- `document` no se incluye intencionalmente: la visibilidad es por
-- workspace/collection. Para pedir acceso a un doc puntual, el flujo es
-- pedir acceso a la collection que lo contiene (o al workspace si esta en
-- una collection privada). Simplifica el modelo.
create type public.access_request_target_kind as enum (
  'workspace',
  'collection'
);

create type public.access_request_status as enum (
  'pending',
  'approved',
  'denied',
  'withdrawn',
  'expired'
);

create table public.access_requests (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  requester_id uuid not null references auth.users(id) on delete cascade,
  target_kind public.access_request_target_kind not null,
  target_id uuid not null,
  reason text,
  status public.access_request_status not null default 'pending',
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  decision_note text,
  expires_at timestamptz default (now() + interval '14 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index access_requests_pending_idx
  on public.access_requests (tenant_id, status, created_at desc)
  where status = 'pending';
create index access_requests_requester_idx
  on public.access_requests (tenant_id, requester_id, created_at desc);
create index access_requests_target_idx
  on public.access_requests (tenant_id, target_kind, target_id);
```

### `saved_queries`

```sql
create table public.saved_queries (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text,
  query text not null,                  -- texto natural o keyword
  filters jsonb not null default '{}'::jsonb,  -- workspace_ids, collection_ids, tag_ids, date_range
  schedule_cron text,                   -- null = solo on-demand
  notify_on_new_results boolean not null default true,
  last_run_at timestamptz,
  last_result_hash text,                -- sha256 del set de doc_ids/score
  last_result_count integer,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index saved_queries_user_idx
  on public.saved_queries (tenant_id, user_id, updated_at desc);
create index saved_queries_scheduled_idx
  on public.saved_queries (tenant_id, schedule_cron)
  where schedule_cron is not null;
```

Worker Inngest cron corre cada hora, recorre `saved_queries` cuyo
`schedule_cron` matchea la ventana, ejecuta la query (misma RPC que J7),
compara hash con `last_result_hash`, dispara `notifications.kind =
'saved_query.new_results'` si cambia.

### `agent_tasks` — DIFERIDO

DDL completo movido a Tier 3 / decisiones diferidas. El journey J33 esta
contemplado conceptualmente pero hay dudas razonables: quien crea las
entries (agente automaticamente vs user-driven), como se valida la
extraccion ("el agente extrajo este deadline, aprobas?") y si las
notificaciones se mezclan con `notifications` o tienen inbox propia.

Recomendacion: implementar Tier 1 + Tier 2 sin `agent_tasks`, observar 4-6
semanas si users piden la capacidad de forma natural (via support, sales,
analytics), y entonces disenar el schema con feedback real. El payload
estimado es 1 tabla + 3 RPCs + 1 worker; bajo costo de agregarlo despues.

### `audit_log` enriquecido

```sql
alter table public.audit_log
  add column session_id uuid,
  add column workspace_id uuid;
-- request_id, ip_address, user_agent ya existen pero rara vez se setean.

create index audit_log_session_idx
  on public.audit_log (tenant_id, session_id) where session_id is not null;
create index audit_log_workspace_idx
  on public.audit_log (tenant_id, workspace_id, created_at desc)
  where workspace_id is not null;
```

Convention enforcement: las RPCs server-side aceptan parametro
`_request_context jsonb` opcional. Si presente, contiene
`{request_id, session_id, ip, user_agent, workspace_id}`. Se persiste tal cual
en cada `audit_log` insert. Helper `app.audit_with_context` extraido para
evitar repeticion en cada RPC.

## Modelo de datos — Tier 3

### Connectors: Google Drive + Microsoft 365

```sql
create type public.connector_provider as enum (
  'google_drive',
  'm365_sharepoint',
  'm365_onedrive'
);

create type public.connector_status as enum (
  'pending_auth',
  'active',
  'paused',
  'error',
  'revoked'
);

-- credenciales del tenant para un provider: cifradas at-rest con Supabase Vault
-- o `pgsodium`. Recomendacion: Supabase Vault (managed, simpler) salvo que
-- haga falta envelope encryption per-tenant.
create table public.tenant_oauth_credentials (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  provider public.connector_provider not null,
  account_subject text not null,             -- 'user@empresa.com' o tenant id externo
  display_name text,
  vault_secret_id uuid not null,             -- referencia a secret en vault.secrets
  scopes text[],
  expires_at timestamptz,
  status public.connector_status not null default 'pending_auth',
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, provider, account_subject)
);

-- el secret real (refresh_token, access_token) vive en vault.secrets gestionado
-- por Supabase Vault. nunca exponer al cliente.

create table public.document_sources (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  workspace_id uuid not null,
  collection_id uuid,                     -- destino opcional
  credential_id uuid not null references public.tenant_oauth_credentials(id) on delete restrict,
  provider public.connector_provider not null,
  name text not null,
  status public.connector_status not null default 'pending_auth',
  config jsonb not null default '{}'::jsonb,  -- folder_id, drive_id, mime filters
  sync_interval_seconds integer not null default 3600 check (sync_interval_seconds >= 300),
  last_synced_at timestamptz,
  last_error text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, workspace_id)
    references public.workspaces(tenant_id, id) on delete cascade,
  foreign key (tenant_id, collection_id)
    references public.collections(tenant_id, id) on delete set null
);

create index document_sources_active_idx
  on public.document_sources (tenant_id, status, last_synced_at)
  where status = 'active';

create table public.document_source_cursors (
  source_id uuid primary key references public.document_sources(id) on delete cascade,
  tenant_id uuid not null,
  cursor jsonb not null,                  -- driveChangeToken, siteId+deltaLink, etc.
  last_seen_external_at timestamptz,
  updated_at timestamptz not null default now()
);

create table public.document_source_items (
  id uuid primary key default extensions.gen_random_uuid(),
  source_id uuid not null references public.document_sources(id) on delete cascade,
  tenant_id uuid not null,
  document_id uuid,                       -- null hasta que se ingesta
  external_id text not null,              -- gdrive file id / m365 driveItem id
  external_etag text,
  external_path text,
  mime_type text,
  byte_size bigint,
  last_seen_at timestamptz not null default now(),
  ingestion_status text not null default 'pending'
    check (ingestion_status in ('pending', 'ingesting', 'indexed', 'failed', 'skipped')),
  ingestion_error text,
  metadata jsonb not null default '{}'::jsonb,
  unique (source_id, external_id),
  foreign key (tenant_id, document_id)
    references public.documents(tenant_id, id) on delete set null
);

create index document_source_items_pending_idx
  on public.document_source_items (tenant_id, source_id, last_seen_at)
  where ingestion_status = 'pending';
```

Worker Inngest cron recorre `document_sources` con `status='active'`,
respeta `sync_interval_seconds`, llama API del provider con el cursor,
upserta items, encola ingesta por cada item nuevo o cambiado. Decision: la
ingesta corre por el mismo pipeline que upload manual; el connector solo
preparara el archivo en Storage (subiendolo desde el provider via
service-side, sin tocar el browser).

### `usage_records` y aggregations

Granularidad evento-por-evento. La cardinalidad va a ser alta (cada LLM call,
cada batch de embeddings), por eso se parte por mes y se agrega diariamente.

```sql
create type public.usage_kind as enum (
  'llm_chat_completion',
  'llm_summary',
  'llm_tree_build',
  'llm_routing_summary',
  'embedding_chunk',
  'embedding_query',
  'document_extraction',
  'storage_bytes_day'                    -- snapshot diario, no event-driven
);

create table public.usage_records (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  workspace_id uuid,
  user_id uuid,
  kind public.usage_kind not null,
  model text,
  provider text,                         -- 'openrouter', 'openai', 'local'
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  units numeric(18,4),                   -- unidad generica (tokens, bytes, calls)
  cost_micro_usd bigint,                 -- micros para evitar floats
  conversation_id uuid,
  message_id uuid,
  document_id uuid,
  run_id uuid,
  request_id text,
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
) partition by range (occurred_at);
-- partition por mes con `pg_partman` o helper propio.

-- particion inicial para el mes corriente
create table public.usage_records_2026_05
  partition of public.usage_records
  for values from ('2026-05-01') to ('2026-06-01');

create index usage_records_tenant_kind_idx
  on public.usage_records (tenant_id, kind, occurred_at desc);
create index usage_records_workspace_idx
  on public.usage_records (tenant_id, workspace_id, occurred_at desc)
  where workspace_id is not null;
create index usage_records_user_idx
  on public.usage_records (tenant_id, user_id, occurred_at desc)
  where user_id is not null;

-- aggregations
create materialized view public.usage_aggregates_daily as
select
  tenant_id,
  workspace_id,
  user_id,
  kind,
  model,
  date_trunc('day', occurred_at) as day,
  sum(input_tokens)  as input_tokens,
  sum(output_tokens) as output_tokens,
  sum(units)         as units,
  sum(cost_micro_usd) as cost_micro_usd,
  count(*)           as event_count
from public.usage_records
group by 1, 2, 3, 4, 5, 6;

-- unique para soportar `refresh materialized view concurrently`. NO usamos
-- coalesce con sentinel: Postgres trata NULLs como distintos y eso permite
-- multiples rows con misma combinacion no-null cuando una columna nullable
-- es NULL. Solucion: 4 indices unicos parciales que cubren las 4
-- combinaciones de NULL en (workspace_id, user_id).
create unique index usage_aggregates_daily_pk_ws_user
  on public.usage_aggregates_daily (tenant_id, workspace_id, user_id, kind, coalesce(model, ''), day)
  where workspace_id is not null and user_id is not null;
create unique index usage_aggregates_daily_pk_ws_nouser
  on public.usage_aggregates_daily (tenant_id, workspace_id, kind, coalesce(model, ''), day)
  where workspace_id is not null and user_id is null;
create unique index usage_aggregates_daily_pk_nows_user
  on public.usage_aggregates_daily (tenant_id, user_id, kind, coalesce(model, ''), day)
  where workspace_id is null and user_id is not null;
create unique index usage_aggregates_daily_pk_nows_nouser
  on public.usage_aggregates_daily (tenant_id, kind, coalesce(model, ''), day)
  where workspace_id is null and user_id is null;
```

Refresh: `pg_cron` cada hora con `refresh materialized view concurrently`.

### Mirror Stripe (minimal)

```sql
create table public.stripe_customers (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  stripe_customer_id text not null unique,
  email text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.stripe_subscriptions (
  stripe_subscription_id text primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  status text not null,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at timestamptz,
  cancel_at_period_end boolean default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index stripe_subscriptions_tenant_status_idx
  on public.stripe_subscriptions (tenant_id, status);
```

Stripe webhook handler (route handler Next o Inngest function) hace upsert
sobre estas tablas. Service role only.

### `data_exports`

```sql
create type public.data_export_status as enum (
  'queued',
  'running',
  'ready',
  'failed',
  'expired'
);

create type public.data_export_scope as enum (
  'tenant',
  'workspace',
  'user'
);

create table public.data_exports (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  requested_by uuid not null references auth.users(id) on delete restrict,
  scope public.data_export_scope not null,
  scope_workspace_id uuid,
  scope_user_id uuid,
  format text not null default 'zip' check (format in ('zip', 'jsonl')),
  status public.data_export_status not null default 'queued',
  ready_url text,
  ready_storage_path text,
  byte_size bigint,
  expires_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index data_exports_tenant_status_idx
  on public.data_exports (tenant_id, status, created_at desc);
```

Worker Inngest function `process-data-export` toma `queued`, escribe a Storage
bajo `<tenant_id>/_exports/<export_id>/...`, marca `ready` con signed URL
larga (24h). `cleanup_operational_data` extendido borra ready/expired despues
de 7 dias.

### Particionado

Particionar `audit_log`, `indexing_events`, `document_views`, `usage_records`
y `notifications` por `created_at`/`occurred_at` mensual.

**Importante**: Postgres no permite convertir una tabla existente a
particionada in-place. El patron canonico es:

1. Crear `<tabla>_new` particionada con el mismo schema (sin FKs/triggers).
2. Copiar datos en chunks (`insert into ..._new select * from ...`).
3. En una transaccion corta: tomar lock exclusivo, recrear FKs/triggers/RLS
   sobre `<tabla>_new`, drop `<tabla>` original, rename `<tabla>_new` a
   `<tabla>`.
4. Verificar y refrescar publications de Realtime.

Esto SI requiere ventana de mantenimiento, aunque sea corta. Volumen actual
es bajo (audit_log <100k filas), por lo que el lock es de segundos. Para
tablas con mas filas (indexing_events) cortar en multiples chunks pre-swap.

**Disponibilidad de `pg_partman` en Supabase managed**: NO esta en la
allowlist por default. Validar con `supabase` CLI o tickets antes de
asumirlo. Alternativa si no esta disponible: particionado manual con worker
Inngest cron que crea particiones futuras 7 dias antes de necesitarlas
(`create table audit_log_YYYY_MM partition of audit_log for values from
... to ...`). Patron documentado en `14-retention-and-cleanup.md`.

Si `pg_partman` esta disponible:

```sql
create extension if not exists pg_partman with schema "extensions";

select extensions.create_parent(
  p_parent_table => 'public.audit_log',
  p_control => 'created_at',
  p_type => 'range',
  p_interval => '1 month',
  p_premake => 3
);
```

### `halfvec` migration para embeddings

`pgvector >= 0.7` soporta `halfvec` (FP16). 3x menos storage, perdida
marginal en calidad para coseno >0.5. Pendiente verificar version en
Supabase managed. Si esta disponible:

```sql
-- chunks
alter table public.chunks add column embedding_half extensions.halfvec(1536);
update public.chunks set embedding_half = embedding::extensions.halfvec
  where embedding is not null;
-- crear HNSW sobre embedding_half
create index chunks_embedding_half_hnsw_idx
  on public.chunks using hnsw (embedding_half extensions.halfvec_cosine_ops)
  where embedding_half is not null;
-- en otra migracion una vez verificado, drop la columna vector y rename.
```

Mismo patron para `doc_tree_nodes.embedding`.

### Vistas materializadas

Decision: empezar con vistas comunes indexadas, no materializadas.
Migrar a matview cuando el dolor sea real (>30k workspaces o queries >500ms
con indices). Razon: matviews requieren refresh cron, RLS no aplica
directamente (hay que vehicularla via funcion `security definer`), y la
data hot-path se desfasa por el intervalo de refresh.

```sql
-- top docs consultados (vistas + citations) por workspace, ultimos 30 dias.
-- vista comun por ahora.
create or replace view public.workspace_top_documents as
select
  d.tenant_id,
  d.workspace_id,
  d.id as document_id,
  d.title,
  count(distinct dv.user_id) as unique_viewers,
  count(dv.id)               as view_events,
  count(distinct mc.id)      as citation_events,
  max(dv.viewed_at)          as last_viewed_at
from public.documents d
left join public.document_views dv
  on dv.tenant_id = d.tenant_id
 and dv.document_id = d.id
 and dv.viewed_at >= now() - interval '30 days'
left join public.message_citations mc
  on mc.tenant_id = d.tenant_id
 and mc.document_id = d.id
 and mc.created_at >= now() - interval '30 days'
where d.deleted_at is null
group by 1, 2, 3, 4;

-- actividad reciente del workspace (heterogenea): vista comun union de
-- documents/annotations/issues/shared_links recientes.
```

Indices que hacen viable la vista comun:
`document_views (tenant_id, document_id, viewed_at desc)` (ya declarado),
`message_citations (tenant_id, document_id)` (ya declarado),
`documents (tenant_id, workspace_id) where deleted_at is null` (ya
declarado).

## RPCs nuevas y modificadas

Convencion: todas en `public` son `security definer`, validan `auth.uid()` y
`app.current_tenant_id()`, registran en `audit_log`. Wrappers de RPCs
sensibles aceptan `_request_context jsonb` para enriquecer audit.

### Workspaces y memberships

```text
public.create_workspace(_name, _slug?, _description?, _settings?, _request_context?) -> workspace_id
public.update_workspace(_workspace_id, _patch jsonb, _request_context?) -> workspace
public.archive_workspace(_workspace_id, _request_context?) -> void
public.delete_workspace(_workspace_id, _request_context?) -> void   -- soft

public.add_workspace_member(_workspace_id, _principal_kind, _principal_id, _role, _request_context?) -> void
public.remove_workspace_member(_workspace_id, _principal_kind, _principal_id, _request_context?) -> void
public.change_workspace_member_role(_workspace_id, _principal_kind, _principal_id, _role, _request_context?) -> void

public.set_active_workspace(_workspace_id) -> void  -- actualiza user_metadata, dispara refresh JWT
```

### Groups

```text
public.create_group(_key, _name, _description?, _metadata?) -> group_id
public.update_group(_group_id, _patch) -> group
public.archive_group(_group_id) -> void
public.add_group_member(_group_id, _user_id) -> void
public.remove_group_member(_group_id, _user_id) -> void
```

### Collections, tags

```text
public.create_collection(_workspace_id, _slug, _name, _visibility?, ...) -> collection_id
public.update_collection(_collection_id, _patch) -> collection
public.set_collection_visibility(_collection_id, _visibility, _request_context?) -> void
public.archive_collection(_collection_id) -> void

public.add_document_to_collection(_document_id, _collection_id) -> void
public.remove_document_from_collection(_document_id, _collection_id) -> void

public.create_tag(_key, _label, _color?, _description?) -> tag_id
public.tag_document(_document_id, _tag_id) -> void
public.untag_document(_document_id, _tag_id) -> void
```

### Documents (mutaciones extendidas)

```text
public.create_document_upload(..., _workspace_id, _collection_id?)
                                 ^^^^^^^^^^^^^ NUEVO arg
public.archive_document(_document_id, _request_context?) -> void  -- setea deleted_at
public.restore_document(_document_id) -> void
public.move_document(_document_id, _to_workspace_id, _collection_ids? uuid[]) -> void
public.bulk_update_documents(_document_ids uuid[], _patch jsonb) -> jsonb
public.link_document_version(_document_id, _predecessor_document_id, _label?, _effective_from?) -> void
```

### Search

```text
public.search_documents(
  _query text,
  _filters jsonb default '{}',   -- workspace_ids, collection_ids, tag_ids, date_range
  _limit int default 20
) -> table(document_id, title, score, snippet, metadata)

public.search_chunks(
  _query text,
  _filters jsonb default '{}',
  _mode text default 'hybrid'    -- 'fts' | 'trigram' | 'embedding' | 'hybrid'
) -> table(chunk_id, document_id, score, snippet)

public.search_tree_nodes_by_embedding(
  _embedding extensions.vector,
  _filters jsonb default '{}',
  _limit int default 10
) -> table(node_id, document_id, score, title, summary)

public.navigate_tree(
  _node_id uuid,
  _direction text                -- 'children' | 'parent' | 'siblings'
) -> table(node_id, title, summary, page_start, page_end)

public.get_document_evidence(
  _document_id uuid,
  _node_id text default null,
  _page_start int default null,
  _page_end int default null
) -> table(content text, page integer, bbox jsonb)
```

### Conversations y feedback

```text
public.start_conversation(_title?, _workspace_id?) -> conversation_id
public.append_message(_conversation_id, _role, _content, _metadata?) -> message_id
public.record_message_citations(_message_id, _citations jsonb) -> void
public.submit_message_feedback(_message_id, _kind, _comment?) -> feedback_id
public.share_conversation(_conversation_id, _audience, _audience_data jsonb) -> shared_link_id
```

### Annotations, bookmarks, issues, access, queries, tasks

```text
public.create_annotation(_document_id, _body, _kind?, _visibility?, _node_id?, _page?, _bbox?, _group_id?, _mentioned_user_ids?) -> annotation_id
public.reply_annotation(_annotation_id, _body, _mentioned_user_ids?) -> reply_id
public.resolve_annotation(_annotation_id) -> void

public.create_bookmark(_target_kind, _target_id, _label?, _folder?) -> bookmark_id
public.delete_bookmark(_bookmark_id) -> void

public.report_document_issue(_document_id, _kind, _description?) -> issue_id
public.update_document_issue(_issue_id, _patch) -> issue
public.assign_document_issue(_issue_id, _assignee_id) -> void

public.request_access(_target_kind, _target_id, _reason?) -> request_id
public.decide_access_request(_request_id, _decision text, _decision_note?) -> void

public.create_saved_query(_name, _query, _filters?, _schedule_cron?, _notify_on_new_results?) -> saved_query_id
public.run_saved_query(_saved_query_id) -> jsonb  -- snapshot del resultado

-- agent_tasks RPCs: diferidas. Ver seccion `agent_tasks` mas arriba.
```

### Connectors

```text
public.create_oauth_credential(_provider, _account_subject, _scopes?, _metadata?) -> credential_id, vault_secret_id
-- el secret real se setea via supabase Vault aparte; este RPC solo crea la row.
public.create_document_source(_workspace_id, _credential_id, _provider, _name, _config, _collection_id?) -> source_id
public.pause_document_source(_source_id) -> void
public.resume_document_source(_source_id) -> void
public.revoke_oauth_credential(_credential_id) -> void
```

### Data export

```text
public.request_data_export(_scope, _scope_workspace_id?, _scope_user_id?, _format?) -> export_id
public.list_data_exports() -> table(...)
```

### Usage / notifications

```text
public.report_usage(...)                       -- service role only
public.recompute_usage_aggregates()            -- service role
public.tenant_usage_summary(_start, _end) -> jsonb  -- read-only tenant admin

public.mark_notification_read(_notification_id) -> void
public.mark_notifications_read_bulk(_notification_ids uuid[]) -> integer
public.update_notification_preferences(_kind, _channel, _enabled, _digest?) -> void
```

## Triggers, vistas, jobs

### Triggers nuevos

- `set_updated_at` en todas las nuevas tablas mutables (sigue el patron
  existente).
- `audit_*` triggers:
  - `audit_collection_visibility_change` (cambio a `tenant_public` es
    explicito y critico).
  - `audit_workspace_membership_change`.
  - `audit_document_lineage_link`.
  - `audit_data_export_status_change`.
- `notify_*` triggers (db-side):
  - `notify_annotation_reply`: cuando se inserta `annotation_replies`,
    insertar `notifications` para el autor de la anotacion y los mentioned.
  - `notify_shared_link_received`: cuando se inserta `shared_links` con
    audience workspace/group/user_set, crear notifs para los users target.
  - `notify_document_issue_assigned`.
  - `notify_access_request_received` y `notify_access_request_decided`.

### Vistas

- `document_lineage_heads` (ver Tier 2).
- `workspace_top_documents` (matview, Tier 3).
- `workspace_recent_activity` (vista no materializada): union de inserts
  recientes (documents, annotations, issues, shared_links) filtrada por
  workspace.
- Vista `tenant_directory_workspaces`: lista resumida de workspaces visibles
  al user con conteos basicos.
- Extender `indexing_health_anomalies` con: `workspace_missing` (docs sin
  workspace despues de migracion), `lineage_loop` (linaje circular).

### Jobs `pg_cron`

- `sda-saved-queries` cada 10 min (worker side).
- `sda-usage-aggregates-refresh` cada hora.
- `sda-workspace-top-documents-refresh` cada 6 horas.
- `sda-cleanup-operational-data` ya existe; extender retention:
  - `notifications` 90 dias.
  - `document_views` 180 dias (a salvo de aggregations diarias).
  - `usage_records_*` cuyo periodo termino: mover a archive table o drop
    partition vieja despues de N meses (configurable).
  - `data_exports` ready/expired despues de 7 dias.
- `sda-access-requests-expire` diario: marca `expired` los pending vencidos.

### Workers (Inngest functions)

- `sync-document-source`: dispatch periodico por source activa, usa
  `document_source_cursors`, encola ingesta items nuevos/modificados.
- `process-data-export`: dump y zip de scope solicitado.
- `run-saved-queries`: ejecuta scheduled saved queries y dispara notifs.
- ~~`notify-agent-tasks-due`~~: diferido junto con `agent_tasks`.

## Migracion

Orden propuesto para minimizar disruption (los helpers RLS van ANTES del
JWT hook porque el hook los llama):

1. **Migracion 030 — workspaces + memberships + groups + tags**: crea las
   tablas Tier 1 sin tocar `documents`. Idempotente.
2. **Migracion 031.a — `documents.workspace_id` nullable**: solo agrega la
   columna y la FK composite. Sin set not null todavia.
3. **Migracion 031.b — workspace Default + backfill**: por cada tenant,
   crea workspace `Default`, agrega como miembros a todos los users active
   del tenant con rol mapeado:
   - tenant `owner` / `admin` -> `workspace_admin`.
   - `member` -> `workspace_editor`.
   - `viewer` -> `workspace_viewer`.
   Update masivo `documents.workspace_id = default_workspace.id`.
4. **Migracion 031.c — `documents.workspace_id` not null** + index.
5. **Migracion 032 — collections + document_collections**: cada documento se
   agrega a una collection `general` del workspace home (auto creada).
6. **Migracion 033 — RLS helpers `app.*`** (`user_can_read_document`,
   `user_workspace_role`, `user_belongs_to_workspace`,
   `current_workspace_id`). Sin tocar policies aun.
7. **Migracion 034 — JWT hook v2**: extender `app.custom_access_token_hook`
   para inyectar `active_workspace_id` cuando el user lo tiene en
   `user_metadata`. Bumpear `claims_version` a 2. La app trata
   `claims_version=1` como legacy (sin active_workspace_id) y RLS sigue
   funcionando porque los helpers no dependen del claim.
8. **Migracion 035 — policies revisadas para `documents`**: drop policy
   vieja, create policy `documents_select_visible`.
9. **Migracion 036 — soft-delete columnas y policies**: `deleted_at` en
   documents/conversations/collections/workspaces/groups/tags.
10. **Migraciones 040-049 — Tier 2 tabla por tabla**:
    - 040 message_feedback + message_citations
    - 041 user_bookmarks
    - 042 shared_links
    - 043 document_annotations + annotation_replies
    - 044 notifications + notification_preferences + extensión de
      `app.is_allowed_realtime_topic` para topic
      `tenant:<tenant_id>:user:<user_id>:inbox`
    - 045 document_views
    - 046 document_issues
    - 047 document_lineage
    - 048 access_requests
    - 049 saved_queries + audit_log enriquecido
      (`agent_tasks` se difiere a Tier 3 — ver "LEAN recortes" al final)
8. **Migraciones 050-059 — Tier 3**:
   - 050 tenant_oauth_credentials + document_sources + cursors + items
   - 051 usage_records (particionada) + usage_aggregates_daily
   - 052 stripe mirror
   - 053 data_exports
   - 054 particionado audit_log
   - 055 particionado indexing_events
   - 056 particionado document_views
   - 057 halfvec migration chunks + doc_tree_nodes (con dual-write window)
   - 058 vistas materializadas top_documents + workspace_recent_activity

Cada migracion incluye test SQL en `supabase/tests/`. Patron: setup tenant
ficticio, escenario positivo + negativo de RLS, cleanup. Tests existentes
sirven de template.

### Backfill no destructivo

- `audit_log.workspace_id` queda null para audits historicos; nuevos audits
  lo llenan via RPC `_request_context`.
- `documents.workspace_id` se llena con el workspace `Default`.
- `documents` antiguos no entran a ningun `collection` automatic; quedan
  visibles para miembros del workspace `Default`.
- `usage_records` arranca vacio. No hay backfill posible.

### Bandera de feature

Para Tier 1 y RLS: env var `SDA_ENABLE_WORKSPACE_HIERARCHY=true`. La app
puede correr en "modo legacy" (sin workspaces visibles en UI) si la flag
esta off mientras se completa rollout. La DB ya tiene las tablas, pero
`active_workspace_id` queda null y `app.user_can_read_document` admite null
como "ver todo el tenant para admins, nada para members" (decision a
confirmar). Recomendacion: aplicar inmediatamente sin feature flag dado que
el backfill garantiza que todo doc tiene workspace y todo user es miembro
del default.

## Documentacion

### Docs nuevos

- `docs/backend/11-workspaces-collections-groups.md`: modelo y reglas de
  visibilidad. Diagramas. Decisiones de visibility heredada por coleccion.
- `docs/backend/12-rls-patterns.md`: catalogo unico de patrones RLS, helpers
  `app.*`, como construir policies nuevas. Reemplaza la seccion superficial
  actual de `02-auth-tenants-rls.md`.
- `docs/backend/13-audit-log-conventions.md`: namespace de `action`,
  estructura de `metadata`, `_request_context` pattern, como agregar nuevos
  audits.
- `docs/backend/14-retention-and-cleanup.md`: `cleanup_operational_data`,
  retenciones por tabla, soft-delete pattern, particionado.
- `docs/backend/15-notifications.md`: tipos, canales, preferences,
  scheduling, triggers DB-side vs worker.
- `docs/backend/16-connectors-drive-m365.md`: arquitectura sync, OAuth flow,
  Vault, mapping a documents/workspaces/collections.
- `docs/backend/17-usage-and-billing.md`: `usage_records`, aggregations,
  Stripe mirror, como leer consumo de un tenant.
- `docs/backend/18-search-rpcs.md`: catalogo de search endpoints, modos
  (fts/trigram/embedding/hybrid), filtros canonicos.
- `docs/backend/19-data-export.md`: flujo, scope, formato JSONL/ZIP,
  retencion.
- `docs/backend/20-document-lineage-and-versioning.md`: como manejar
  reemplazos, agente prefiere ultima version, queries para historicas.

### Docs actualizados

- `docs/arquitectura.md`: agregar capa workspaces/collections/groups en el
  diagrama; mencionar lineage, annotations, notifications.
- `docs/backend/01-mapa-del-backend.md`: actualizar lista de carpetas
  (esperadas en lib: `workspaces/`, `collections/`, `annotations/`,
  `notifications/`, `connectors/`, `usage/`).
- `docs/backend/02-auth-tenants-rls.md`: re-escribir liviano, redirigiendo a
  `12-rls-patterns.md`.
- `docs/backend/03-documentos-storage-upload.md`: agregar `workspace_id` y
  `collection_id` en RPC `create_document_upload`; mencionar lineage,
  soft-delete, mover.
- `docs/backend/04-indexacion-inngest.md`: agregar `sync-document-source`,
  `process-data-export`, `run-saved-queries`, `notify-agent-tasks-due`.
- `docs/backend/06-contratos-frontend.md`: agregar contratos de annotations,
  bookmarks, notifications, search, shared links.
- `docs/backend/09-catalogo-api-rutas.md`: extender con nuevas RPCs y
  rutas.
- `docs/backend/10-supabase-realtime.md`: agregar topic
  `tenant:<tenant_id>:user:<user_id>:inbox` y eventos nuevos
  (`notification_inserted`, `annotation_inserted`, `issue_changed`).
- `docs/gotchas.md`: dividir en `gotchas-supabase.md`, `gotchas-inngest.md`,
  `gotchas-frontend.md`, `gotchas-server-ops.md`. Agregar gotchas nuevos del
  diseno (visibility cascada, share-link no transfiere permisos, soft-delete
  ventana, halfvec migration cuidados).

### ER overview

Generar `docs/db-schema-overview.md` con ER diagram en formato `dbml` o
mermaid (renderable en GitHub). Generado a mano la primera vez; despues
mantenido con cada migracion grande. No reemplaza las migraciones; sirve de
mapa.

## No-objetivos

- API keys / Personal Access Tokens / Service accounts (diferido por
  decision del user).
- Webhooks salientes (diferido).
- SAML SSO / SCIM provisioning.
- Tenant-configurable data retention (mas alla de defaults globales).
- Data residency / multi-region.
- Plans / quotas / overage enforcement (billing es usage-puro sin caps; la
  app emite alerts pero no bloquea).
- Tenant LLM provider config (BYO key) — sin schema, sin UI.
- Encrypted search / per-tenant CMK.
- DLP / PII detection automatica.
- Cross-tenant federation o sharing.
- OAuth server para terceros que se conecten al tenant.
- Native mobile app schema (push tokens, etc.).
- AI prompt template marketplace.
- Approval workflows complejos (mas alla de access_requests basicos).

## Riesgos y mitigaciones

| Riesgo | Mitigacion |
|---|---|
| RLS con helpers (subqueries) puede degradar perf con muchos tenants. | Marcar funciones `stable`, usar `(select fn())` en policies (patron actual), benchmark a 10k workspaces. Indices apropiados en `workspace_memberships`. |
| Particionado introduce complejidad operativa. | Usar `pg_partman` managed. Test sql que valide creacion de particion futura. Documentar en `14-retention-and-cleanup.md`. |
| Migracion `halfvec` exige rebuild de HNSW (largo). | Dual-write: nueva col + nuevo indice, swap atomico al final, dejar la vieja una semana antes de drop. |
| Backfill de `documents.workspace_id` puede fallar para tenants sin users active. | Crear workspace Default igual; el primer admin que se loguee se vuelve membro automaticamente via trigger. |
| `shared_links.audience = tenant_with_token` puede dispersar accesos. | Token expira (default 7 dias), rate-limit creacion, audit_log explicito. |
| `notifications` puede explotar (cardinalidad por user). | Indice partial sobre unread + archived_at. Cleanup 90d. Preferences default permiten silenciar tipos ruidosos. |
| Annotations + replies pueden generar mucho realtime. | Solo broadcast a topic privado del workspace, payload minimo (id + kind); cliente refetch. |
| Connectors OAuth Vault leak. | Usar Supabase Vault, nunca exponer al cliente; rotacion automatica del refresh_token. Audit explicito en credential creation/revocation. |
| Usage records cardinalidad. | Particionado mensual + aggregates diarios + cleanup automatico despues de 12 meses. Hot path consulta solo aggregates. |
| Soft-delete crea ambiguedad en queries antiguas. | Toda RLS y vista usa `deleted_at is null` por default. Endpoints "papelera" piden flag explicito. |
| Tenant admin extremo: ve todo aunque workspace sea privado. | Documentar explicitamente en T&C internos. Audit log captura cada acceso admin a docs cross-workspace. |
| `claims_version` salto a 2 puede invalidar sesiones viejas. | Tolerar v1 durante 7 dias; despues forzar reauth. |
| Bug en `user_workspace_role` con grupos puede dar permisos de mas. | Tests SQL exhaustivos para cada combo: user direct, user via group, ambos, ninguno. |

## Decisiones diferidas / open questions

- **Vault vs pgsodium para `tenant_oauth_credentials`**: recomendado Vault;
  validar disponibilidad en plan Supabase actual. Si no, usar `pgsodium` con
  master key en env.
- **Sintaxis JWT refresh al cambiar workspace**: con la sesion actual del
  user o requerir re-login. Recomendado: `supabase.auth.updateUser({ data: {
  active_workspace_id } })` y dejar que Supabase reissue el access_token.
  Validar latencia.
- ~~`workspace_role` ordering en enum~~: resuelto inline. El enum se declara
  de menor a mayor (`viewer < editor < admin`) para que `max(role)` resuelva
  al rol mas alto naturalmente.
- **Email channel de notifications**: integracion (Resend / Postmark) fuera
  del scope DB; el spec solo modela `notification_preferences.channel =
  'email'`. Implementacion del envio es decision futura.
- **Particionado actual de tablas pequenas (audit_log <100k filas)**: hacerlo
  ahora o cuando duela? Recomendacion: hacer ahora porque la migracion es
  mas barata con poca data.
- **`document_views` desde el agente** (cuando cita un doc en una respuesta,
  cuenta como view?): recomendacion: si, con `source='agent_citation'`,
  porque sirve a metricas. UI puede filtrar.
- **Multiple `tenant_oauth_credentials` por provider** (e.g. dos cuentas
  Google): permitido por design (`unique (tenant_id, provider,
  account_subject)`); cada source elige una credential.
- **Lineage cross-workspace**: predecesor en otro workspace permitido si el
  usuario tiene edit en el destino? Recomendacion: solo dentro del mismo
  workspace, simplifica visibilidad.

## Spec self-review notes

- Placeholders: ninguno. Todos los DDL son ejecutables (modulo el enum
  ordering noted arriba).
- Contradicciones internas: revisadas. `workspace_role` ordering enum es la
  unica que requiere atencion al DDL final.
- Scope: el spec abarca 27 capacidades en 3 tiers. Es grande pero coherente
  porque cada tier depende del anterior. Plan de implementacion deberia
  decomponer cada tier en sub-plans.
- Ambigüedades: `audit_log` enriquecido pide setting consistente desde
  RPCs; queda explicito el patron `_request_context` y el helper
  `app.audit_with_context`. Implementacion de ese helper queda al plan.

## Observaciones del code review — para el plan de implementacion

Estas observaciones surgieron de un segundo pase de review con fresh eyes
sobre el spec. Las CRITICAS ya estan corregidas inline en las secciones
correspondientes; las que quedan abajo son IMPORTANTES y MENORES que el
plan resolvera durante la implementacion.

### Importantes (el plan debe atacar explicitamente)

1. **Audit context enforcement**: `_request_context jsonb` solo funciona si
   las RPCs lo usan consistentemente. Plan debe crear `app.audit_with_context`
   como unico path de insert a `audit_log` desde RPCs, y revisar las 4
   funciones `audit_*_change` actuales para que tambien lo consuman cuando
   viene del JWT/sesion.

2. **`workspace_memberships.principal_id` polymorphic FK**: agregar trigger
   `app.check_workspace_membership_principal()` que valida que
   `principal_id` existe en `auth.users` o `groups` segun `principal_kind`.
   Sin esto se pueden insertar uuids fantasma.

3. **`group_memberships` tenant consistency**: declarar `unique (tenant_id,
   id)` en `groups` y agregar composite FK
   `(tenant_id, group_id) -> groups(tenant_id, id)` en `group_memberships`
   para evitar tenant cross-contamination.

4. **`halfvec` dual-write contract**: documentar y test que el codigo que
   escribe embeddings (Tree Indexer + cualquier RPC futura) escriba a ambas
   columnas durante la ventana de migracion. Sugerencia: trigger before
   insert/update que copia `embedding -> embedding_half` automatico hasta
   el swap. Despues del swap, drop el trigger.

5. **`notify_*` triggers vs `notification_preferences`**: decision a tomar
   en el plan. Recomendacion: los triggers SIEMPRE insertan en
   `notifications` (la inbox es el persistent log). El `preferences.enabled`
   y `digest` solo afectan emision de canal externo (email) y throttling de
   broadcast realtime. Asi la inbox siempre tiene el evento aunque el user
   silencie el toast.

6. **`workspaces.status='archived'` vs `deleted_at`**: clarificar que
   `archived` es estado funcional (read-only, no recibe nuevos docs) y
   `deleted_at` es soft-delete (no aparece en queries). Una policy
   `workspaces_select_member` debe filtrar `deleted_at is null` pero NO
   filtrar `status='archived'` (los users pueden seguir viendo workspaces
   archivados, solo no escriben). Documentar en `11-workspaces-...md`.

7. **`document_views` insert policy**: el spec dice "client hace upsert con
   throttle". Eso requiere policy de INSERT explicita:
   ```sql
   create policy document_views_insert_self on public.document_views
     for insert to authenticated
     with check (
       tenant_id = (select app.current_tenant_id())
       and user_id = (select auth.uid())
       and (select app.user_can_read_document(document_id))
     );
   ```

8. **`tenant_oauth_credentials` vault flow**: documentar end-to-end. El RPC
   `create_oauth_credential` crea la row con `vault_secret_id` nulo, luego
   un endpoint server-side (route handler con service_role) hace
   `vault.create_secret(...)` y actualiza el row. La lectura del secret
   solo ocurre desde el worker Inngest `sync-document-source` con
   service_role.

### Menores (estilo, defensa en profundidad)

- **`usage_records` PK**: una tabla particionada necesita la columna de
  particion en el PK. Cambiar `primary key (id)` a `primary key (id,
  occurred_at)`.
- **`document_collections` PK**: por consistencia con el resto del
  codebase, cambiar a `primary key (tenant_id, document_id, collection_id)`
  para defensa en profundidad.
- **`data_exports.scope_workspace_id`**: agregar composite FK
  `(tenant_id, scope_workspace_id) -> workspaces(tenant_id, id)` cuando no
  null.
- **`enable row level security`**: cada tabla nueva debe tener `alter table
  ... enable row level security` + al menos un `create policy` explicito. El
  plan debe incluir checklist por migracion.
- **`shared_links` token con sal del tenant**: hash con sal por tenant
  para evitar enumeracion cross-tenant. Generar token como
  `tenant_id || ':' || random_bytes(32)` y hashear el todo. Validar la
  estructura en el RPC consumer.
- **`saved_queries.last_result_hash` granularidad**: hash sobre `(doc_id,
  extraction_pipeline_version)` no solo `doc_id`. Asi cambios de contenido
  por reextraccion tambien disparan notif.
- **`claims_version=2` migration window**: documentar en
  `02-auth-tenants-rls.md` o donde corresponda que la app valida
  `claims_version >= 2` en route handlers que dependen de
  `active_workspace_id`. Despues de 7 dias, forzar reauth desde middleware
  si la sesion tiene `claims_version=1`.

### LEAN — recortes ya aplicados

- `agent_tasks` movido a "diferido"; revisamos en 4-6 semanas con feedback
  real antes de implementarlo.
- `notification_preferences.digest` reducido a `realtime`/`off`. Modos
  `hourly/daily/weekly` se agregan cuando exista worker que los procese.
- `access_request_target_kind` quitado `'document'`: para pedir acceso a un
  doc puntual, se pide acceso a su collection contenedora.
- `workspace_top_documents` y `workspace_recent_activity` mantenidos como
  vistas comunes (no materializadas) hasta que el dolor sea real.

## Cierre

El spec deja todo lo necesario para que un plan de implementacion lo
decomponga en migraciones (~30 nuevas), docs (~10 nuevos) y workers (~3
nuevos, agent_tasks diferido). El orden sugerido respeta dependencias y
permite cortar releases intermedias funcionales: post-Tier 1 ya hay
journey-first; Tier 2 multiplica retencion; Tier 3 desbloquea enterprise.

Las observaciones del code review estan documentadas en la seccion
anterior; el plan las absorbe sin necesidad de revisar este spec
nuevamente.
