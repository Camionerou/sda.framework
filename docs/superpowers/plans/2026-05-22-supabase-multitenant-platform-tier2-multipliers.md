# Supabase Multitenant Platform — Tier 2 Multipliers Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir los multiplicadores de retencion sobre la base journey-first de Tier 1: feedback al agente, citations, bookmarks, sharing, annotations + replies, inbox de notificaciones, document views, issues, lineage, access requests y saved queries con scheduler, mas un `audit_log` enriquecido con `session_id` y `workspace_id`.

**Architecture:** 10 migraciones SQL (040-049) que extienden el schema con tablas, RLS policies, triggers de notificacion DB-side y RPCs `security definer` para escritura segura desde el browser. Una extension explicita de `app.is_allowed_realtime_topic` agrega el topic privado de inbox por user y dos triggers Broadcast (`notifications`, `document_annotations` + `annotation_replies`) entregan eventos live. Un worker Inngest nuevo (`run-saved-queries`) corre cada 10 minutos, ejecuta queries guardadas con `schedule_cron` y dispara notificaciones cuando los resultados cambian. 3 docs nuevos y 4 actualizados consolidan la superficie.

**Tech Stack:** Supabase (Postgres 17, RLS, Realtime Broadcast, pg_cron, pgvector, ltree, pg_trgm, citext), Next.js 16 App Router, Inngest workflows, Upstash Redis (throttle de `record_document_view`), pgTAP para tests SQL, node --test para el worker TS.

**Reference spec:** `docs/superpowers/specs/2026-05-22-supabase-multitenant-audit-design.md` (secciones aplicables: "Modelo de datos — Tier 2", "Triggers, vistas, jobs", "Migracion 040-049", "Observaciones del code review").

**Master plan:** `docs/superpowers/plans/2026-05-22-supabase-multitenant-platform.md`.

**Pre-requisito:** Tier 1 mergeado a main y aplicado. Ver `2026-05-22-supabase-multitenant-platform-tier1-foundation.md`. Verificar antes de arrancar:

```bash
npm run test:db
psql "$DATABASE_URL" -c "select count(*) from public.workspaces"  # > 0
psql "$DATABASE_URL" -c "select count(*) from public.documents where workspace_id is null"  # = 0
psql "$DATABASE_URL" -c "select to_regprocedure('app.user_can_read_document(uuid)')"  # not null
```

Si alguno falla, abortar y volver a Tier 1.

---

## Tier overview

Capacidades de scope (numeradas como en el spec, items 9-19; item 20 `agent_tasks` esta diferido):

| # | Capacidad | Migracion | RPCs | Trigger notif | Realtime |
|---|---|---|---|---|---|
| 9 | `message_feedback` + `message_citations` | 040 | `submit_message_feedback`, `record_message_citations` | — | — |
| 10 | `user_bookmarks` | 041 | `create_bookmark`, `delete_bookmark` | — | — |
| 11 | `shared_links` | 042 | `create_shared_link`, `revoke_shared_link`, `consume_shared_link_token`, `share_conversation` | `notify_shared_link_received` | — |
| 12 | `document_annotations` + `annotation_replies` | 043 | `create_annotation`, `update_annotation`, `reply_annotation`, `resolve_annotation` | `notify_annotation_reply` | Broadcast workspace |
| 13 | `notifications` + `notification_preferences` + extension `is_allowed_realtime_topic` | 044 + Task 7.3 | `mark_notification_read`, `mark_notifications_read_bulk`, `update_notification_preferences` | (consumido por otros) | Broadcast inbox |
| 14 | `document_views` | 045 | `record_document_view` | — | — |
| 15 | `document_issues` | 046 | `report_document_issue`, `update_document_issue`, `assign_document_issue`, `resolve_document_issue` | `notify_document_issue_assigned` | publication |
| 16 | `document_lineage` | 047 | `link_document_version` | — | — |
| 17 | `access_requests` | 048 | `request_access`, `decide_access_request`, `withdraw_access_request` | `notify_access_request_received`, `notify_access_request_decided` | — |
| 18 | `saved_queries` + scheduler | 049 + Task 12.3 | `create_saved_query`, `update_saved_query`, `delete_saved_query`, `run_saved_query` | (consumido por worker) | — |
| 19 | `audit_log` enriquecido (`session_id`, `workspace_id`) | 049 | — | — | — |
| — | DB platform foundation (`pg_jsonschema`, `btree_gin`) | Paso 0 | — | — | — |
| — | Search indexes GIN (acelera 040.b modos `fts`/`trigram`/`hybrid`) | 040.c | — | — | — |
| — | Search RPCs (requeridas para `run_saved_query`) | 040.b | `search_documents`, `search_chunks`, `search_tree_nodes_by_embedding`, `navigate_tree`, `get_document_evidence` | — | — |
| — | Worker Inngest `run-saved-queries` | — | — | — | cron 10m |

**Regla LEAN del proyecto** (`nunca hacer archivos monoliticos`): cada migracion crea un set acotado de tablas + tests pgTAP propios. Si una migracion supera 600 LOC, descomponerla en `<n>.a`/`<n>.b`.

---

## Migration order

Timestamps secuenciales asumiendo arranque del tier en `20260601` (semanas despues de Tier 1). Si Tier 2 arranca en otra fecha, conservar el orden incrementando solo la hora del primer archivo y sumando 1 minuto por migracion subsecuente.

```text
20260601085000_enable_pg_jsonschema.sql                 (Paso 0 — platform)
20260601085100_enable_btree_gin.sql                     (Paso 0 — platform)
20260601090000_message_feedback_and_citations.sql       (040)
20260601090100_search_rpcs.sql                          (040.b — search helpers)
20260601090150_search_indexes_gin.sql                   (040.c — GIN indexes para search_chunks)
20260601090200_user_bookmarks.sql                       (041)
20260601090300_shared_links.sql                         (042)
20260601090400_document_annotations.sql                 (043)
20260601090500_notifications.sql                        (044 — incluye extension de is_allowed_realtime_topic)
20260601090600_document_views.sql                       (045)
20260601090700_document_issues.sql                      (046)
20260601090800_document_lineage.sql                     (047)
20260601090900_access_requests.sql                      (048)
20260601091000_saved_queries.sql                        (049.a)
20260601091100_audit_log_enriched.sql                   (049.b)
20260601091200_cleanup_operational_data_tier2.sql       (extension de retention)
20260601091300_realtime_tier2_publications.sql          (publication add + broadcast triggers)
```

Cada migracion lleva su test pgTAP en `supabase/tests/<basename>_test.sql`.

---

## Paso 0 · DB platform foundation

Habilita extensiones transversales (`pg_jsonschema`, `btree_gin`) que pasos posteriores consumen. Audita `uuid-ossp` y `pg_trgm` para decidir keep/remove en Tier 4. **No depende del Pre-flight Tier 1** y puede mergearse incluso antes de iniciar el resto de Tier 2.

### Task 0.1: Habilitar `pg_jsonschema` + helper `app.validate_jsonschema`

**Files:**
- Create: `supabase/migrations/20260601085000_enable_pg_jsonschema.sql`
- Create: `supabase/tests/enable_pg_jsonschema_test.sql`

- [ ] **Step 1: Escribir migración**

```sql
-- supabase/migrations/20260601085000_enable_pg_jsonschema.sql
-- Habilita pg_jsonschema para validar columnas jsonb con CHECK constraints.

create extension if not exists "pg_jsonschema" with schema "extensions";

-- Helper estable: validar un valor jsonb contra un schema jsonb.
-- Wrappea extensions.jsonb_matches_schema(schema, value) y maneja null gracefully.
create or replace function app.validate_jsonschema(_value jsonb, _schema jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when _value is null then true
    else extensions.jsonb_matches_schema(_schema, _value)
  end;
$$;

comment on function app.validate_jsonschema(jsonb, jsonb) is
  'Valida _value contra _schema (JSON Schema draft-07). Null pasa. Usar en CHECK constraints.';

revoke all on function app.validate_jsonschema(jsonb, jsonb) from public;
grant execute on function app.validate_jsonschema(jsonb, jsonb) to authenticated, service_role;
```

- [ ] **Step 2: Escribir test pgTAP**

```sql
-- supabase/tests/enable_pg_jsonschema_test.sql
BEGIN;
SELECT plan(5);

SELECT has_extension('pg_jsonschema', 'pg_jsonschema instalada');
SELECT has_function('app','validate_jsonschema', ARRAY['jsonb','jsonb'], 'helper existe');

SELECT is(
  app.validate_jsonschema(
    '{"foo":"bar"}'::jsonb,
    '{"type":"object","required":["foo"]}'::jsonb
  ),
  true,
  'objeto valido pasa'
);

SELECT is(
  app.validate_jsonschema(
    '{}'::jsonb,
    '{"type":"object","required":["foo"]}'::jsonb
  ),
  false,
  'objeto sin required field falla'
);

SELECT is(
  app.validate_jsonschema(null, '{"type":"object"}'::jsonb),
  true,
  'null pasa siempre'
);

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 3: Correr test + commit**

```bash
npm run test:db -- --test supabase/tests/enable_pg_jsonschema_test.sql
git add supabase/migrations/20260601085000_enable_pg_jsonschema.sql supabase/tests/enable_pg_jsonschema_test.sql
git commit -m "feat(db): enable pg_jsonschema + app.validate_jsonschema helper"
```

### Task 0.2: Habilitar `btree_gin`

**Files:**
- Create: `supabase/migrations/20260601085100_enable_btree_gin.sql`
- Create: `supabase/tests/enable_btree_gin_test.sql`

- [ ] **Step 1: Migración**

```sql
-- supabase/migrations/20260601085100_enable_btree_gin.sql
-- Habilita btree_gin para indices compuestos (tenant_id uuid + jsonb / tsvector / etc.)
create extension if not exists "btree_gin" with schema "extensions";
```

- [ ] **Step 2: Test**

```sql
-- supabase/tests/enable_btree_gin_test.sql
BEGIN;
SELECT plan(1);
SELECT has_extension('btree_gin', 'btree_gin instalada');
SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 3: Correr + commit**

```bash
npm run test:db -- --test supabase/tests/enable_btree_gin_test.sql
git add supabase/migrations/20260601085100_enable_btree_gin.sql supabase/tests/enable_btree_gin_test.sql
git commit -m "feat(db): enable btree_gin extension"
```

### Task 0.3: Audit `uuid-ossp` y `pg_trgm` (decisión Tier 4)

**Files:**
- Create: `docs/superpowers/plans/_evidence/2026-05-24-uuid-ossp-pg-trgm-audit.md`

- [ ] **Step 1: Audit `uuid-ossp` usage**

```bash
grep -rn "uuid_generate_v" supabase/ workers/ inngest/ lib/ app/ cli/ \
  --include='*.sql' --include='*.ts' --include='*.py' 2>/dev/null \
  | tee /tmp/uuid-ossp-audit.txt
wc -l /tmp/uuid-ossp-audit.txt
```

Expected: idealmente 0 matches. Si hay matches, listar y planificar reemplazo a `gen_random_uuid()` en Tier 4.

- [ ] **Step 2: Audit `pg_trgm` usage**

```bash
grep -rn "gin_trgm_ops\|similarity(\|word_similarity\| % " supabase/ \
  --include='*.sql' 2>/dev/null \
  | tee /tmp/pg-trgm-audit.txt
wc -l /tmp/pg-trgm-audit.txt
```

Expected: matches en `search_rpcs.sql` (Tier 2 Paso 3) y en `db_caching_retrieval_ops`. Si solo aparece en RPCs y el índice GIN trgm de Paso 3.b no se usa después en producción, candidato a remover en Tier 4.

- [ ] **Step 3: Escribir evidence doc**

```markdown
# Audit: uuid-ossp + pg_trgm — 2026-05-24

## uuid-ossp
- Matches encontrados: <N>
- Detalle (paste output de /tmp/uuid-ossp-audit.txt o "ninguno"):
  ```
  <paste>
  ```
- Decisión: <keep / remove en Tier 4>

## pg_trgm
- Matches en SQL: <N>
- Operadores usados: <%, similarity, word_similarity, etc.>
- Índices que lo respaldan: poblar después de Tier 2 Paso 3.b
- Decisión inicial: keep — usado en `search_chunks` modos `trigram`/`hybrid`.
- Re-evaluar: después de Tier 2 Paso 16 Task 16.3 (audit de uso de índice GIN trgm).
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/_evidence/2026-05-24-uuid-ossp-pg-trgm-audit.md
git commit -m "docs(db): audit uuid-ossp + pg_trgm usage (Tier 2 Paso 0 Task 0.3)"
```

---

## Paso 1 · Pre-flight Tier 2

### Task 1.1: Verificar Tier 1 aplicado y limpio

**Files:**
- Read: `lib/system-versions.json`
- Read: `supabase/migrations/` (ultimo archivo de Tier 1 mergeado)

- [ ] **Step 1: Confirmar que las tablas de Tier 1 existen y estan pobladas**

```bash
psql "$DATABASE_URL" -c "
select
  (select count(*) from public.workspaces) as workspaces,
  (select count(*) from public.workspace_memberships) as memberships,
  (select count(*) from public.collections) as collections,
  (select count(*) from public.documents where workspace_id is null) as docs_without_workspace;
"
```

Expected: `workspaces > 0`, `memberships > 0`, `docs_without_workspace = 0`. Si falla, abortar.

- [ ] **Step 2: Confirmar helpers RLS de Tier 1**

```bash
psql "$DATABASE_URL" <<'SQL'
select to_regprocedure('app.user_can_read_document(uuid)') is not null as user_can_read,
       to_regprocedure('app.user_workspace_role(uuid)') is not null as user_workspace_role,
       to_regprocedure('app.user_belongs_to_workspace(uuid)') is not null as user_belongs_to_workspace,
       to_regprocedure('app.audit_with_context(text,text,uuid,jsonb,jsonb)') is not null as audit_with_context;
SQL
```

Expected: todos `t`. Si `audit_with_context` no existe, parar y agregarlo en Tier 1 antes de seguir.

- [ ] **Step 3: Suite completa en verde**

```bash
npm run lint && npm run typecheck && npm run test:db && npm run test:cli && npm run indexing:health && npm run secrets:scan
```

Expected: todos exit 0. Si alguno falla, NO arrancar Tier 2.

- [ ] **Step 4: Crear branch de trabajo**

```bash
git checkout -b tier2-multipliers main
```

### Task 1.2: Confirmar conventions transversales

- [ ] **Step 1: Leer convenciones del master plan**

Releer en el master:
- Composite FK pattern `(tenant_id, id)`.
- `enable row level security` obligatorio.
- Write boundary via RPCs `security definer`.
- `app.audit_with_context` como unico path a `audit_log` desde RPCs nuevas.
- Soft-delete con `deleted_at timestamptz`.

No hay commit en este step; es checkpoint mental.

- [ ] **Step 2: Snapshot del ultimo timestamp de Tier 1**

```bash
ls supabase/migrations/ | sort | tail -5
```

Expected: la ultima migracion mergeada de Tier 1 (timestamp esperado `2026053XHHMMSS_*`). Apuntar mentalmente para asignar timestamps Tier 2 estrictamente superiores.

---

## Paso 2 · Migracion 040 · `message_feedback` + `message_citations`

Implementa item 9 del spec. Feedback es nullable + `on delete set null` para preservar ground truth si el user se va. Citations las inserta el agente runtime (service role).

### Task 2.1: Test pgTAP `message_feedback_test.sql`

**Files:**
- Create: `supabase/tests/20260601090000_message_feedback_and_citations_test.sql`

- [ ] **Step 1: Escribir el test pgTAP completo (escenarios positivos + negativos)**

```sql
BEGIN;
SELECT plan(18);

-- Setup tenants
insert into public.tenants (id, slug, name) values
  ('00000000-0000-0000-0000-000000003001', 'feedback-alpha', 'Feedback Alpha'),
  ('00000000-0000-0000-0000-000000003002', 'feedback-beta', 'Feedback Beta');

-- Setup auth users
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000003011', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'owner@feedback-alpha.test', now(),
   '{"provider":"email"}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000003012', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'spy@feedback-beta.test', now(),
   '{"provider":"email"}'::jsonb, '{}'::jsonb, now(), now());

-- Profiles
insert into public.users (id, tenant_id, email, display_name, role, status) values
  ('00000000-0000-0000-0000-000000003011', '00000000-0000-0000-0000-000000003001',
   'owner@feedback-alpha.test', 'Alpha Owner', 'owner', 'active'),
  ('00000000-0000-0000-0000-000000003012', '00000000-0000-0000-0000-000000003002',
   'spy@feedback-beta.test', 'Beta Spy', 'member', 'active');

-- Workspace + memberships Tier 1
insert into public.workspaces (id, tenant_id, slug, name, status) values
  ('00000000-0000-0000-0000-000000003101', '00000000-0000-0000-0000-000000003001',
   'default', 'Default Alpha', 'active');
insert into public.workspace_memberships
  (workspace_id, tenant_id, principal_kind, principal_id, role) values
  ('00000000-0000-0000-0000-000000003101', '00000000-0000-0000-0000-000000003001',
   'user', '00000000-0000-0000-0000-000000003011', 'workspace_admin');

-- Documento + conversation + message del tenant Alpha
insert into public.documents (id, tenant_id, workspace_id, created_by, filename, r2_key, status, uploaded_at)
values ('00000000-0000-0000-0000-000000003021', '00000000-0000-0000-0000-000000003001',
        '00000000-0000-0000-0000-000000003101', '00000000-0000-0000-0000-000000003011',
        'alpha.pdf', '00000000-0000-0000-0000-000000003001/00000000-0000-0000-0000-000000003021/alpha.pdf',
        'indexed', now());

insert into public.conversations (id, tenant_id, user_id, title)
values ('00000000-0000-0000-0000-000000003031', '00000000-0000-0000-0000-000000003001',
        '00000000-0000-0000-0000-000000003011', 'Test convo');
insert into public.messages (id, tenant_id, conversation_id, role, content)
values ('00000000-0000-0000-0000-000000003041', '00000000-0000-0000-0000-000000003001',
        '00000000-0000-0000-0000-000000003031', 'assistant',
        jsonb_build_object('text', 'Hola'));

-- Assertions de schema
SELECT has_table('public', 'message_feedback', 'message_feedback existe');
SELECT has_table('public', 'message_citations', 'message_citations existe');
SELECT has_type('public', 'message_feedback_kind', 'enum message_feedback_kind existe');
SELECT col_is_null('public', 'message_feedback', 'user_id',
  'message_feedback.user_id es nullable (preservamos feedback al borrar user)');

-- RLS habilitado
SELECT ok(
  (select relrowsecurity from pg_class where oid = 'public.message_feedback'::regclass),
  'RLS activo en message_feedback');
SELECT ok(
  (select relrowsecurity from pg_class where oid = 'public.message_citations'::regclass),
  'RLS activo en message_citations');

-- Composite FK existe
SELECT ok(
  exists (select 1 from pg_constraint
          where conrelid = 'public.message_feedback'::regclass
            and contype = 'f'
            and pg_get_constraintdef(oid) like '%(tenant_id, conversation_id)%'),
  'message_feedback tiene composite FK (tenant_id, conversation_id)');

-- RPC submit_message_feedback existe
SELECT has_function('public', 'submit_message_feedback', 'submit_message_feedback existe');
SELECT ok(
  not has_function_privilege('anon', 'public.submit_message_feedback(uuid, public.message_feedback_kind, text)', 'execute'),
  'anon no puede ejecutar submit_message_feedback');

-- Escenario positivo: owner Alpha puede submitir feedback
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', '00000000-0000-0000-0000-000000003011',
  'role', 'authenticated',
  'tenant_id', '00000000-0000-0000-0000-000000003001',
  'tenant_role', 'owner',
  'active_workspace_id', '00000000-0000-0000-0000-000000003101'
)::text, true);
set local role authenticated;

SELECT lives_ok(
  $$ select public.submit_message_feedback(
       '00000000-0000-0000-0000-000000003041'::uuid,
       'helpful'::public.message_feedback_kind,
       'thanks'
     ) $$,
  'owner Alpha puede submit feedback en su tenant');

SELECT is(
  (select count(*)::int from public.message_feedback
   where message_id = '00000000-0000-0000-0000-000000003041'),
  1,
  'una fila de feedback creada');

-- Idempotencia: re-submit del mismo kind por mismo user actualiza, no duplica
SELECT lives_ok(
  $$ select public.submit_message_feedback(
       '00000000-0000-0000-0000-000000003041'::uuid,
       'helpful'::public.message_feedback_kind,
       'updated comment'
     ) $$,
  're-submit del mismo kind no rompe (RPC dedupe)');

SELECT is(
  (select count(*)::int from public.message_feedback
   where message_id = '00000000-0000-0000-0000-000000003041' and kind = 'helpful'),
  1,
  'sigue habiendo solo 1 fila helpful para el user/message');

-- Escenario negativo cross-tenant
reset role;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', '00000000-0000-0000-0000-000000003012',
  'role', 'authenticated',
  'tenant_id', '00000000-0000-0000-0000-000000003002',
  'tenant_role', 'member'
)::text, true);
set local role authenticated;

SELECT throws_ok(
  $$ select public.submit_message_feedback(
       '00000000-0000-0000-0000-000000003041'::uuid,
       'helpful'::public.message_feedback_kind,
       'spy comment'
     ) $$,
  'Message not found',
  'cross-tenant submit_message_feedback falla por tenant mismatch');

-- record_message_citations es service-role only
reset role;
SELECT ok(
  not has_function_privilege('authenticated', 'public.record_message_citations(uuid, jsonb)', 'execute'),
  'authenticated NO puede ejecutar record_message_citations (service-role only)');

-- audit_log enriquecido con feedback
SELECT ok(
  exists (select 1 from public.audit_log
          where action = 'message.feedback_submitted'
            and resource_id = '00000000-0000-0000-0000-000000003041'),
  'audit_log captura el feedback');

-- preserva feedback si user es borrado (on delete set null)
delete from public.users where id = '00000000-0000-0000-0000-000000003011';
delete from auth.users where id = '00000000-0000-0000-0000-000000003011';

SELECT is(
  (select user_id from public.message_feedback
   where message_id = '00000000-0000-0000-0000-000000003041' limit 1),
  null::uuid,
  'borrar el user setea user_id a NULL, no destruye la fila');

SELECT is(
  (select count(*)::int from public.message_feedback
   where message_id = '00000000-0000-0000-0000-000000003041'),
  1,
  'fila de feedback preservada despues de borrar user');

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Correr el test y verificar que FAILA con el mensaje esperado**

```bash
npm run test:db -- supabase/tests/20260601090000_message_feedback_and_citations_test.sql 2>&1 | head -40
```

Expected: el test falla con mensaje `relation "public.message_feedback" does not exist` o similar (tabla aun no creada).

### Task 2.2: Migracion 040 `message_feedback_and_citations.sql`

**Files:**
- Create: `supabase/migrations/20260601090000_message_feedback_and_citations.sql`

- [ ] **Step 1: Escribir la migracion completa**

```sql
-- Tier 2 · Migracion 040
-- Item 9 del spec: message_feedback + message_citations.

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
  -- user_id nullable + on delete set null para preservar la senal historica.
  -- El feedback es ground truth para fine-tune; perderlo al borrar un user destruye valor.
  user_id uuid references auth.users(id) on delete set null,
  kind public.message_feedback_kind not null,
  comment text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, conversation_id)
    references public.conversations(tenant_id, id) on delete cascade
);

-- Indices y dedupe parcial sobre (message_id, user_id, kind) cuando user_id no es null.
-- Cuando user_id es null (user borrado) admitimos duplicados historicos.
create index message_feedback_message_idx
  on public.message_feedback (tenant_id, message_id);
create index message_feedback_kind_created_idx
  on public.message_feedback (tenant_id, kind, created_at desc);
create unique index message_feedback_user_kind_unique_idx
  on public.message_feedback (message_id, user_id, kind)
  where user_id is not null;

create trigger set_message_feedback_updated_at
before update on public.message_feedback
for each row execute function app.set_updated_at();

create table public.message_citations (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  message_id uuid not null,
  conversation_id uuid not null,
  document_id uuid not null,
  node_id text,
  page_start integer,
  page_end integer,
  span jsonb,
  score numeric(5,4),
  used boolean not null default true,
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

-- RLS
alter table public.message_feedback enable row level security;
alter table public.message_citations enable row level security;

create policy message_feedback_select_tenant on public.message_feedback
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and (
      user_id = (select auth.uid())
      or (select app.is_tenant_admin())
    )
  );

create policy message_citations_select_visible on public.message_citations
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and exists (
      select 1 from public.conversations c
      where c.id = message_citations.conversation_id
        and c.tenant_id = message_citations.tenant_id
        and (c.user_id = (select auth.uid()) or (select app.is_tenant_admin()))
    )
  );

-- Write boundary: las inserts/updates van por RPCs security definer.
revoke insert, update, delete on public.message_feedback from authenticated;
revoke insert, update, delete on public.message_citations from authenticated;
grant select on public.message_feedback, public.message_citations to authenticated;
grant all on public.message_feedback, public.message_citations to service_role;

-- RPC: submit_message_feedback
create or replace function public.submit_message_feedback(
  _message_id uuid,
  _kind public.message_feedback_kind,
  _comment text default null,
  _request_context jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid;
  current_user_id uuid;
  message_record public.messages%rowtype;
  feedback_id uuid;
begin
  current_tenant_id := app.current_tenant_id();
  current_user_id := auth.uid();

  if current_user_id is null then
    raise exception 'Authentication required';
  end if;
  if current_tenant_id is null then
    raise exception 'Tenant claim is required';
  end if;

  select m.* into message_record
  from public.messages m
  where m.id = _message_id
    and m.tenant_id = current_tenant_id;

  if message_record.id is null then
    raise exception 'Message not found';
  end if;

  insert into public.message_feedback (
    tenant_id, conversation_id, message_id, user_id, kind, comment
  ) values (
    current_tenant_id, message_record.conversation_id, _message_id, current_user_id, _kind, _comment
  )
  on conflict (message_id, user_id, kind) where user_id is not null
  do update set
    comment = excluded.comment,
    updated_at = now()
  returning id into feedback_id;

  perform app.audit_with_context(
    'message.feedback_submitted',
    'message',
    _message_id,
    jsonb_build_object('feedback_id', feedback_id, 'kind', _kind),
    _request_context
  );

  return feedback_id;
end;
$$;

revoke execute on function public.submit_message_feedback(uuid, public.message_feedback_kind, text, jsonb) from anon, public;
grant execute on function public.submit_message_feedback(uuid, public.message_feedback_kind, text, jsonb) to authenticated;

-- RPC: record_message_citations (service-role only; lo llama el agent runtime)
create or replace function public.record_message_citations(
  _message_id uuid,
  _citations jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  message_record public.messages%rowtype;
  inserted integer := 0;
  citation jsonb;
begin
  -- service-role only por revoke abajo.
  select m.* into message_record from public.messages m where m.id = _message_id;
  if message_record.id is null then
    raise exception 'Message not found';
  end if;

  for citation in select * from jsonb_array_elements(_citations)
  loop
    insert into public.message_citations (
      tenant_id, message_id, conversation_id, document_id,
      node_id, page_start, page_end, span, score, used, metadata
    ) values (
      message_record.tenant_id,
      _message_id,
      message_record.conversation_id,
      (citation->>'document_id')::uuid,
      citation->>'node_id',
      nullif(citation->>'page_start','')::int,
      nullif(citation->>'page_end','')::int,
      citation->'span',
      nullif(citation->>'score','')::numeric,
      coalesce((citation->>'used')::boolean, true),
      coalesce(citation->'metadata', '{}'::jsonb)
    );
    inserted := inserted + 1;
  end loop;

  return inserted;
end;
$$;

revoke execute on function public.record_message_citations(uuid, jsonb) from anon, public, authenticated;
grant execute on function public.record_message_citations(uuid, jsonb) to service_role;
```

- [ ] **Step 2: Correr test y verificar que PASA**

```bash
npm run test:db -- supabase/tests/20260601090000_message_feedback_and_citations_test.sql
```

Expected: 18/18 ok. Si rompe, ajustar migracion o test.

- [ ] **Step 3: Correr suite completa**

```bash
npm run test:db
```

Expected: todas las suites OK incluyendo las de Tier 1.

- [ ] **Step 4: Regenerar types**

```bash
npm run types:gen
git add lib/supabase/types.gen.ts
```

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260601090000_message_feedback_and_citations.sql \
        supabase/tests/20260601090000_message_feedback_and_citations_test.sql \
        lib/supabase/types.gen.ts
git commit -m "feat(db): tier2 040 message_feedback + message_citations + rpcs"
```

---

## Paso 3 · Migracion 040.b · Search RPCs

Search RPCs son requisito para `run_saved_query` (Paso 12). Las creamos pronto porque varias capacidades las consumen.

### Task 3.1: Test pgTAP de search RPCs

**Files:**
- Create: `supabase/tests/20260601090100_search_rpcs_test.sql`

- [ ] **Step 1: Test que verifica firma y autorizacion**

```sql
BEGIN;
SELECT plan(10);

SELECT has_function('public', 'search_documents',
  array['text', 'jsonb', 'integer'], 'search_documents existe');
SELECT has_function('public', 'search_chunks',
  array['text', 'jsonb', 'text'], 'search_chunks existe');
SELECT has_function('public', 'search_tree_nodes_by_embedding',
  array['extensions.vector', 'jsonb', 'integer'], 'search_tree_nodes_by_embedding existe');
SELECT has_function('public', 'navigate_tree',
  array['uuid', 'text'], 'navigate_tree existe');
SELECT has_function('public', 'get_document_evidence',
  array['uuid', 'text', 'integer', 'integer'], 'get_document_evidence existe');

-- Permisos
SELECT ok(
  not has_function_privilege('anon', 'public.search_documents(text, jsonb, integer)', 'execute'),
  'anon NO puede search_documents');
SELECT ok(
  has_function_privilege('authenticated', 'public.search_documents(text, jsonb, integer)', 'execute'),
  'authenticated puede search_documents');
SELECT ok(
  has_function_privilege('authenticated', 'public.search_chunks(text, jsonb, text)', 'execute'),
  'authenticated puede search_chunks');
SELECT ok(
  has_function_privilege('authenticated', 'public.navigate_tree(uuid, text)', 'execute'),
  'authenticated puede navigate_tree');
SELECT ok(
  has_function_privilege('authenticated', 'public.get_document_evidence(uuid, text, integer, integer)', 'execute'),
  'authenticated puede get_document_evidence');

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Correr test y verificar FAIL**

```bash
npm run test:db -- supabase/tests/20260601090100_search_rpcs_test.sql 2>&1 | head -20
```

Expected: fallas por funciones inexistentes.

### Task 3.2: Migracion 040.b search RPCs

**Files:**
- Create: `supabase/migrations/20260601090100_search_rpcs.sql`

- [ ] **Step 1: Escribir migracion con las 5 RPCs**

```sql
-- Tier 2 · Migracion 040.b
-- Search RPCs: documents/chunks/tree-nodes + navigate + evidence.

create or replace function public.search_documents(
  _query text,
  _filters jsonb default '{}'::jsonb,
  _limit int default 20
)
returns table (
  document_id uuid,
  title text,
  filename text,
  workspace_id uuid,
  score real,
  snippet text,
  metadata jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
  workspace_ids uuid[] := nullif(
    array(select jsonb_array_elements_text(_filters->'workspace_ids'))::uuid[],
    '{}'::uuid[]
  );
  collection_ids uuid[] := nullif(
    array(select jsonb_array_elements_text(_filters->'collection_ids'))::uuid[],
    '{}'::uuid[]
  );
  tag_ids uuid[] := nullif(
    array(select jsonb_array_elements_text(_filters->'tag_ids'))::uuid[],
    '{}'::uuid[]
  );
begin
  if current_tenant_id is null then
    raise exception 'Tenant claim is required';
  end if;

  return query
  select
    d.id,
    d.title,
    d.filename,
    d.workspace_id,
    ts_rank(to_tsvector('simple', coalesce(d.title,'') || ' ' || coalesce(d.filename,'')),
            websearch_to_tsquery('simple', _query)) +
    case when d.title % _query then 0.1 else 0.0 end as score,
    substring(coalesce(d.title, d.filename) for 200) as snippet,
    d.metadata
  from public.documents d
  where d.tenant_id = current_tenant_id
    and d.deleted_at is null
    and (select app.user_can_read_document(d.id))
    and (workspace_ids is null or d.workspace_id = any(workspace_ids))
    and (collection_ids is null or exists (
      select 1 from public.document_collections dc
      where dc.document_id = d.id and dc.collection_id = any(collection_ids)
    ))
    and (tag_ids is null or exists (
      select 1 from public.document_tags dt
      where dt.document_id = d.id and dt.tag_id = any(tag_ids)
    ))
    and (
      _query is null or _query = ''
      or to_tsvector('simple', coalesce(d.title,'') || ' ' || coalesce(d.filename,''))
         @@ websearch_to_tsquery('simple', _query)
      or d.title % _query
      or d.filename % _query
    )
  order by score desc nulls last, d.created_at desc
  limit greatest(_limit, 1);
end;
$$;

create or replace function public.search_chunks(
  _query text,
  _filters jsonb default '{}'::jsonb,
  _mode text default 'hybrid'
)
returns table (
  chunk_id uuid,
  document_id uuid,
  node_id text,
  page integer,
  score real,
  snippet text,
  metadata jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
  workspace_ids uuid[] := nullif(
    array(select jsonb_array_elements_text(_filters->'workspace_ids'))::uuid[],
    '{}'::uuid[]
  );
  document_ids uuid[] := nullif(
    array(select jsonb_array_elements_text(_filters->'document_ids'))::uuid[],
    '{}'::uuid[]
  );
begin
  if current_tenant_id is null then
    raise exception 'Tenant claim is required';
  end if;
  if _mode not in ('fts', 'trigram', 'embedding', 'hybrid') then
    raise exception 'Invalid mode: %, expected one of fts|trigram|embedding|hybrid', _mode;
  end if;

  return query
  select
    c.id,
    c.document_id,
    c.node_id,
    coalesce((c.metadata->>'page')::int, null) as page,
    case _mode
      when 'fts' then ts_rank(c.content_tsv, websearch_to_tsquery('simple', _query))
      when 'trigram' then similarity(c.content, _query)
      else
        coalesce(ts_rank(c.content_tsv, websearch_to_tsquery('simple', _query)), 0)
        + coalesce(similarity(c.content, _query), 0) * 0.4
    end as score,
    substring(c.content for 300) as snippet,
    c.metadata
  from public.chunks c
  join public.documents d on d.id = c.document_id and d.tenant_id = c.tenant_id
  where c.tenant_id = current_tenant_id
    and d.deleted_at is null
    and (select app.user_can_read_document(c.document_id))
    and (workspace_ids is null or d.workspace_id = any(workspace_ids))
    and (document_ids is null or c.document_id = any(document_ids))
    and (
      _query is null or _query = ''
      or (_mode = 'fts' and c.content_tsv @@ websearch_to_tsquery('simple', _query))
      or (_mode = 'trigram' and c.content % _query)
      or (_mode = 'hybrid' and (
            c.content_tsv @@ websearch_to_tsquery('simple', _query)
            or c.content % _query
          ))
    )
  order by score desc nulls last
  limit 50;
end;
$$;

create or replace function public.search_tree_nodes_by_embedding(
  _embedding extensions.vector,
  _filters jsonb default '{}'::jsonb,
  _limit int default 10
)
returns table (
  node_id uuid,
  document_id uuid,
  score real,
  title text,
  summary text,
  page_start integer,
  page_end integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
  workspace_ids uuid[] := nullif(
    array(select jsonb_array_elements_text(_filters->'workspace_ids'))::uuid[],
    '{}'::uuid[]
  );
  document_ids uuid[] := nullif(
    array(select jsonb_array_elements_text(_filters->'document_ids'))::uuid[],
    '{}'::uuid[]
  );
begin
  if current_tenant_id is null then
    raise exception 'Tenant claim is required';
  end if;

  return query
  select
    n.id,
    n.document_id,
    (1 - (n.embedding <=> _embedding))::real as score,
    n.title,
    n.summary,
    n.page_start,
    n.page_end
  from public.doc_tree_nodes n
  join public.documents d on d.id = n.document_id and d.tenant_id = n.tenant_id
  where n.tenant_id = current_tenant_id
    and d.deleted_at is null
    and n.embedding is not null
    and (select app.user_can_read_document(n.document_id))
    and (workspace_ids is null or d.workspace_id = any(workspace_ids))
    and (document_ids is null or n.document_id = any(document_ids))
  order by n.embedding <=> _embedding
  limit greatest(_limit, 1);
end;
$$;

create or replace function public.navigate_tree(
  _node_id uuid,
  _direction text
)
returns table (
  node_id uuid,
  document_id uuid,
  title text,
  summary text,
  page_start integer,
  page_end integer,
  depth integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
  source_node public.doc_tree_nodes%rowtype;
begin
  if current_tenant_id is null then
    raise exception 'Tenant claim is required';
  end if;
  if _direction not in ('children', 'parent', 'siblings') then
    raise exception 'Invalid direction: %, expected children|parent|siblings', _direction;
  end if;

  select n.* into source_node
  from public.doc_tree_nodes n
  where n.id = _node_id
    and n.tenant_id = current_tenant_id;

  if source_node.id is null then
    raise exception 'Node not found';
  end if;
  if not (select app.user_can_read_document(source_node.document_id)) then
    raise exception 'Node not visible';
  end if;

  return query
  select
    n.id, n.document_id, n.title, n.summary, n.page_start, n.page_end, nlevel(n.path) as depth
  from public.doc_tree_nodes n
  where n.tenant_id = current_tenant_id
    and n.document_id = source_node.document_id
    and case _direction
      when 'children' then n.path ~ ((source_node.path::text || '.*{1}')::lquery)
      when 'parent'   then n.path = subpath(source_node.path, 0, nlevel(source_node.path) - 1)
                            and nlevel(source_node.path) > 0
      when 'siblings' then nlevel(n.path) > 0
                            and subpath(n.path, 0, nlevel(n.path) - 1)
                              = subpath(source_node.path, 0, nlevel(source_node.path) - 1)
                            and n.id <> source_node.id
    end
  order by n.path;
end;
$$;

create or replace function public.get_document_evidence(
  _document_id uuid,
  _node_id text default null,
  _page_start int default null,
  _page_end int default null
)
returns table (
  content text,
  page integer,
  bbox jsonb,
  node_id text,
  chunk_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
begin
  if current_tenant_id is null then
    raise exception 'Tenant claim is required';
  end if;
  if not (select app.user_can_read_document(_document_id)) then
    raise exception 'Document not visible';
  end if;

  return query
  select
    c.content,
    coalesce((c.metadata->>'page')::int, null) as page,
    c.metadata->'bbox' as bbox,
    c.node_id,
    c.id as chunk_id
  from public.chunks c
  where c.tenant_id = current_tenant_id
    and c.document_id = _document_id
    and (_node_id is null or c.node_id = _node_id)
    and (_page_start is null or coalesce((c.metadata->>'page')::int, 0) >= _page_start)
    and (_page_end is null or coalesce((c.metadata->>'page')::int, 0) <= _page_end)
  order by c.metadata->>'page' nulls last, c.id
  limit 200;
end;
$$;

-- Permisos
revoke execute on function public.search_documents(text, jsonb, integer) from anon, public;
revoke execute on function public.search_chunks(text, jsonb, text) from anon, public;
revoke execute on function public.search_tree_nodes_by_embedding(extensions.vector, jsonb, integer) from anon, public;
revoke execute on function public.navigate_tree(uuid, text) from anon, public;
revoke execute on function public.get_document_evidence(uuid, text, integer, integer) from anon, public;

grant execute on function public.search_documents(text, jsonb, integer) to authenticated, service_role;
grant execute on function public.search_chunks(text, jsonb, text) to authenticated, service_role;
grant execute on function public.search_tree_nodes_by_embedding(extensions.vector, jsonb, integer) to authenticated, service_role;
grant execute on function public.navigate_tree(uuid, text) to authenticated, service_role;
grant execute on function public.get_document_evidence(uuid, text, integer, integer) to authenticated, service_role;
```

- [ ] **Step 2: Test PASA**

```bash
npm run test:db -- supabase/tests/20260601090100_search_rpcs_test.sql
```

Expected: 10/10 ok.

- [ ] **Step 3: Suite completa**

```bash
npm run test:db
```

- [ ] **Step 4: Regenerar types + commit**

```bash
npm run types:gen
git add supabase/migrations/20260601090100_search_rpcs.sql \
        supabase/tests/20260601090100_search_rpcs_test.sql \
        lib/supabase/types.gen.ts
git commit -m "feat(db): tier2 040.b search rpcs (documents, chunks, tree, evidence)"
```

---

## Paso 3.b · Migracion 040.c · Indices GIN para search_chunks

Las RPCs de Paso 3 (`search_chunks` modos `fts`/`trigram`/`hybrid`) usan operadores `pg_trgm` y `tsvector @@ tsquery` pero el plan original no agregó índices GIN. Sin estos índices el planner hace **Seq Scan** sobre `chunks` y el modo `hybrid` (Top-K mezclado) es inviable a > 100K filas. Esta migración crea los índices con `CREATE INDEX CONCURRENTLY` para no bloquear writes en producción. Esta migración solo crea índices sobre `chunks` (alto volumen). El equivalente sobre `documents.full_text_index` se difiere — la columna no existe todavía; agregar cuando Paso 3 confirme el shape de `search_documents`.

> Esta migración **NO puede correr dentro de transacción** porque usa `CONCURRENTLY`. Supabase la procesa fuera de transacción si es el único statement del archivo. Verificar con `supabase db push --dry-run` antes de aplicar.

### Task 3.b.1: pgTAP test — verificar índices creados

**Files:**
- Create: `supabase/tests/search_indexes_gin_test.sql`

- [ ] **Step 1: Escribir test (debe FALLAR hasta crear la migración)**

```sql
-- supabase/tests/search_indexes_gin_test.sql
BEGIN;
SELECT plan(2);

SELECT has_index('public','chunks','chunks_content_trgm_idx',
  'indice trigram en chunks.content existe');
SELECT has_index('public','chunks','chunks_content_tsv_tenant_gin_idx',
  'indice compuesto (tenant_id, content_tsv) existe');

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Verificar que falla (índices aún no existen)**

```bash
npm run test:db -- --test supabase/tests/search_indexes_gin_test.sql || echo "FAIL esperado"
```

Expected: 2 fails. Es lo correcto antes de aplicar la migración.

### Task 3.b.2: Migración `20260601090150_search_indexes_gin.sql`

**Files:**
- Create: `supabase/migrations/20260601090150_search_indexes_gin.sql`

- [ ] **Step 1: Migración**

```sql
-- supabase/migrations/20260601090150_search_indexes_gin.sql
-- Índices GIN para que search_chunks y search_documents NO hagan Seq Scan.
-- Requiere extensiones pg_trgm (ya activa) y btree_gin (activada en Paso 0).
--
-- IMPORTANTE: cada CREATE INDEX CONCURRENTLY debe vivir solo en su statement
-- (no en transacción explicita). Este archivo solo crea índices.

-- 1) Índice trigram puro sobre chunks.content para modo 'trigram' de search_chunks.
create index concurrently if not exists chunks_content_trgm_idx
  on public.chunks
  using gin (content extensions.gin_trgm_ops);

-- 2) Índice compuesto (tenant_id, content_tsv) para FTS multi-tenant.
--    btree_gin permite mezclar btree (uuid) + GIN (tsvector) en un solo índice.
create index concurrently if not exists chunks_content_tsv_tenant_gin_idx
  on public.chunks
  using gin (tenant_id, content_tsv);

-- Nota: NO drop del indice chunks_content_tsv_idx existente todavia
-- (puede haber sido creado por 20260520145604). El nuevo lo desplaza si planner
-- ve que el compuesto es mejor; mantener ambos por una sprint y dropear el viejo
-- en Paso 16 Task 16.3 si pg_stat_user_indexes confirma idx_scan = 0.

comment on index public.chunks_content_trgm_idx is
  'GIN trigram para chunks.content; consume modo trigram/hybrid de search_chunks';
comment on index public.chunks_content_tsv_tenant_gin_idx is
  'GIN compuesto (tenant_id, content_tsv); consume modo fts/hybrid multi-tenant de search_chunks';
```

- [ ] **Step 2: Aplicar y verificar**

```bash
supabase db push
npm run test:db -- --test supabase/tests/search_indexes_gin_test.sql
```

Expected: test pasa (2/2).

- [ ] **Step 3: Verificar planner usa los índices**

```bash
psql "$SUPABASE_DB_URL" <<'SQL'
explain (format text)
select content
from public.chunks
where tenant_id = gen_random_uuid()
  and content_tsv @@ websearch_to_tsquery('simple', 'test');
SQL
```

Expected: aparece `Bitmap Index Scan on chunks_content_tsv_tenant_gin_idx`. Si aparece `Seq Scan`, el índice no se usa (puede ser por dataset pequeño en dev — re-verificar en staging con dataset realista).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260601090150_search_indexes_gin.sql supabase/tests/search_indexes_gin_test.sql
git commit -m "feat(db): GIN indexes para search_chunks/search_documents (trigram + tsvector multi-tenant)"
```

---

## Paso 4 · Migracion 041 · `user_bookmarks`

Item 10 del spec.

### Task 4.1: Test pgTAP

**Files:**
- Create: `supabase/tests/20260601090200_user_bookmarks_test.sql`

- [ ] **Step 1: Escribir test**

```sql
BEGIN;
SELECT plan(12);

insert into public.tenants (id, slug, name)
values ('00000000-0000-0000-0000-000000004001', 'bookmark-alpha', 'Bookmark Alpha');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000004011', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'owner@bookmark-alpha.test', now(),
        '{"provider":"email"}'::jsonb, '{}'::jsonb, now(), now());

insert into public.users (id, tenant_id, email, display_name, role, status)
values ('00000000-0000-0000-0000-000000004011', '00000000-0000-0000-0000-000000004001',
        'owner@bookmark-alpha.test', 'Owner', 'owner', 'active');

insert into public.workspaces (id, tenant_id, slug, name, status)
values ('00000000-0000-0000-0000-000000004101', '00000000-0000-0000-0000-000000004001',
        'default', 'Default', 'active');
insert into public.workspace_memberships (workspace_id, tenant_id, principal_kind, principal_id, role)
values ('00000000-0000-0000-0000-000000004101', '00000000-0000-0000-0000-000000004001',
        'user', '00000000-0000-0000-0000-000000004011', 'workspace_admin');

insert into public.documents (id, tenant_id, workspace_id, created_by, filename, r2_key, status, uploaded_at)
values ('00000000-0000-0000-0000-000000004021', '00000000-0000-0000-0000-000000004001',
        '00000000-0000-0000-0000-000000004101', '00000000-0000-0000-0000-000000004011',
        'b.pdf', '00000000-0000-0000-0000-000000004001/00000000-0000-0000-0000-000000004021/b.pdf',
        'indexed', now());

SELECT has_table('public', 'user_bookmarks', 'tabla user_bookmarks existe');
SELECT has_type('public', 'bookmark_target_kind', 'enum bookmark_target_kind existe');
SELECT ok(
  (select relrowsecurity from pg_class where oid = 'public.user_bookmarks'::regclass),
  'RLS habilitado');
SELECT has_function('public', 'create_bookmark', 'create_bookmark existe');
SELECT has_function('public', 'delete_bookmark', 'delete_bookmark existe');

select set_config('request.jwt.claims', jsonb_build_object(
  'sub', '00000000-0000-0000-0000-000000004011',
  'role', 'authenticated',
  'tenant_id', '00000000-0000-0000-0000-000000004001',
  'tenant_role', 'owner',
  'active_workspace_id', '00000000-0000-0000-0000-000000004101'
)::text, true);
set local role authenticated;

SELECT lives_ok(
  $$ select public.create_bookmark(
       'document'::public.bookmark_target_kind,
       '00000000-0000-0000-0000-000000004021'::uuid,
       'Mi favorito',
       null
     ) $$,
  'crear bookmark del propio doc OK');

SELECT is(
  (select count(*)::int from public.user_bookmarks
   where user_id = '00000000-0000-0000-0000-000000004011'),
  1,
  '1 bookmark creado');

-- Dedupe (unique constraint)
SELECT throws_ok(
  $$ insert into public.user_bookmarks (tenant_id, user_id, target_kind, target_id)
     values ('00000000-0000-0000-0000-000000004001',
             '00000000-0000-0000-0000-000000004011',
             'document', '00000000-0000-0000-0000-000000004021') $$,
  '23505',
  'unique (user_id, target_kind, target_id) bloquea duplicados');

-- RPC create_bookmark es idempotente (no falla en re-create)
SELECT lives_ok(
  $$ select public.create_bookmark(
       'document'::public.bookmark_target_kind,
       '00000000-0000-0000-0000-000000004021'::uuid,
       'updated label',
       'starred'
     ) $$,
  're-create_bookmark es idempotente (upsert via RPC)');

-- delete_bookmark
SELECT lives_ok(
  $$ select public.delete_bookmark(
       (select id from public.user_bookmarks
          where user_id = '00000000-0000-0000-0000-000000004011' limit 1)
     ) $$,
  'delete_bookmark OK');

SELECT is(
  (select count(*)::int from public.user_bookmarks
   where user_id = '00000000-0000-0000-0000-000000004011'),
  0,
  'bookmark eliminado');

reset role;
SELECT ok(
  not has_function_privilege('anon', 'public.create_bookmark(public.bookmark_target_kind, uuid, text, text)', 'execute'),
  'anon NO puede create_bookmark');

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Test FAILA**

```bash
npm run test:db -- supabase/tests/20260601090200_user_bookmarks_test.sql 2>&1 | head -20
```

Expected: tabla user_bookmarks no existe.

### Task 4.2: Migracion 041

**Files:**
- Create: `supabase/migrations/20260601090200_user_bookmarks.sql`

- [ ] **Step 1: Escribir migracion**

```sql
-- Tier 2 · Migracion 041
-- Item 10 del spec: user_bookmarks.

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
  folder text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, target_kind, target_id)
);

create index user_bookmarks_user_idx
  on public.user_bookmarks (tenant_id, user_id, created_at desc);
create index user_bookmarks_folder_idx
  on public.user_bookmarks (tenant_id, user_id, folder)
  where folder is not null;

create trigger set_user_bookmarks_updated_at
before update on public.user_bookmarks
for each row execute function app.set_updated_at();

alter table public.user_bookmarks enable row level security;

create policy user_bookmarks_select_self on public.user_bookmarks
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and user_id = (select auth.uid())
  );

revoke insert, update, delete on public.user_bookmarks from authenticated;
grant select on public.user_bookmarks to authenticated;
grant all on public.user_bookmarks to service_role;

-- RPCs
create or replace function public.create_bookmark(
  _target_kind public.bookmark_target_kind,
  _target_id uuid,
  _label text default null,
  _folder text default null,
  _request_context jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
  current_user_id uuid := auth.uid();
  bookmark_id uuid;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  if current_tenant_id is null then raise exception 'Tenant claim is required'; end if;

  insert into public.user_bookmarks (tenant_id, user_id, target_kind, target_id, label, folder)
  values (current_tenant_id, current_user_id, _target_kind, _target_id, _label, _folder)
  on conflict (user_id, target_kind, target_id)
  do update set
    label = excluded.label,
    folder = excluded.folder,
    updated_at = now()
  returning id into bookmark_id;

  perform app.audit_with_context(
    'bookmark.created', 'bookmark', bookmark_id,
    jsonb_build_object('target_kind', _target_kind, 'target_id', _target_id),
    _request_context
  );
  return bookmark_id;
end;
$$;

create or replace function public.delete_bookmark(
  _bookmark_id uuid,
  _request_context jsonb default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
  current_user_id uuid := auth.uid();
  bookmark_record public.user_bookmarks%rowtype;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;

  select b.* into bookmark_record
  from public.user_bookmarks b
  where b.id = _bookmark_id
    and b.tenant_id = current_tenant_id
    and b.user_id = current_user_id;

  if bookmark_record.id is null then
    raise exception 'Bookmark not found';
  end if;

  delete from public.user_bookmarks where id = _bookmark_id;

  perform app.audit_with_context(
    'bookmark.deleted', 'bookmark', _bookmark_id,
    jsonb_build_object('target_kind', bookmark_record.target_kind, 'target_id', bookmark_record.target_id),
    _request_context
  );
end;
$$;

revoke execute on function public.create_bookmark(public.bookmark_target_kind, uuid, text, text, jsonb) from anon, public;
revoke execute on function public.delete_bookmark(uuid, jsonb) from anon, public;
grant execute on function public.create_bookmark(public.bookmark_target_kind, uuid, text, text, jsonb) to authenticated;
grant execute on function public.delete_bookmark(uuid, jsonb) to authenticated;
```

- [ ] **Step 2: Test PASA**

```bash
npm run test:db -- supabase/tests/20260601090200_user_bookmarks_test.sql
```

Expected: 12/12 ok.

- [ ] **Step 3: Suite + types + commit**

```bash
npm run test:db
npm run types:gen
git add supabase/migrations/20260601090200_user_bookmarks.sql \
        supabase/tests/20260601090200_user_bookmarks_test.sql \
        lib/supabase/types.gen.ts
git commit -m "feat(db): tier2 041 user_bookmarks + rpcs"
```

---

## Paso 5 · Migracion 042 · `shared_links`

Item 11 del spec. El share-link NO transfiere permisos: el viewer evalua RLS sobre el target como cualquier acceso normal. El link solo aparece en su inbox cuando audience aplica. Token con sal del tenant.

### Task 5.1: Test pgTAP

**Files:**
- Create: `supabase/tests/20260601090300_shared_links_test.sql`

- [ ] **Step 1: Escribir test**

```sql
BEGIN;
SELECT plan(16);

insert into public.tenants (id, slug, name) values
  ('00000000-0000-0000-0000-000000005001', 'share-alpha', 'Share Alpha');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000005011', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'sharer@share-alpha.test', now(),
   '{"provider":"email"}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000005012', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'audience@share-alpha.test', now(),
   '{"provider":"email"}'::jsonb, '{}'::jsonb, now(), now());

insert into public.users (id, tenant_id, email, display_name, role, status) values
  ('00000000-0000-0000-0000-000000005011', '00000000-0000-0000-0000-000000005001',
   'sharer@share-alpha.test', 'Sharer', 'owner', 'active'),
  ('00000000-0000-0000-0000-000000005012', '00000000-0000-0000-0000-000000005001',
   'audience@share-alpha.test', 'Audience', 'member', 'active');

insert into public.workspaces (id, tenant_id, slug, name, status)
values ('00000000-0000-0000-0000-000000005101', '00000000-0000-0000-0000-000000005001',
        'default', 'Default', 'active');
insert into public.workspace_memberships (workspace_id, tenant_id, principal_kind, principal_id, role) values
  ('00000000-0000-0000-0000-000000005101', '00000000-0000-0000-0000-000000005001',
   'user', '00000000-0000-0000-0000-000000005011', 'workspace_admin'),
  ('00000000-0000-0000-0000-000000005101', '00000000-0000-0000-0000-000000005001',
   'user', '00000000-0000-0000-0000-000000005012', 'workspace_viewer');

insert into public.documents (id, tenant_id, workspace_id, created_by, filename, r2_key, status, uploaded_at)
values ('00000000-0000-0000-0000-000000005021', '00000000-0000-0000-0000-000000005001',
        '00000000-0000-0000-0000-000000005101', '00000000-0000-0000-0000-000000005011',
        's.pdf', '00000000-0000-0000-0000-000000005001/00000000-0000-0000-0000-000000005021/s.pdf',
        'indexed', now());

SELECT has_table('public', 'shared_links', 'tabla shared_links existe');
SELECT has_type('public', 'shared_link_target_kind', 'enum target_kind existe');
SELECT has_type('public', 'shared_link_audience', 'enum audience existe');
SELECT has_function('public', 'create_shared_link', 'create_shared_link existe');
SELECT has_function('public', 'revoke_shared_link', 'revoke_shared_link existe');
SELECT has_function('public', 'consume_shared_link_token', 'consume_shared_link_token existe');
SELECT has_function('public', 'share_conversation', 'share_conversation existe');

-- Check constraint valida combinaciones
SELECT throws_ok(
  $$ insert into public.shared_links
       (tenant_id, target_kind, target_id, audience)
     values ('00000000-0000-0000-0000-000000005001', 'document',
             '00000000-0000-0000-0000-000000005021', 'workspace') $$,
  '23514',
  'check constraint bloquea workspace sin audience_workspace_id');

-- Crear shared_link valido (workspace audience)
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', '00000000-0000-0000-0000-000000005011',
  'role', 'authenticated',
  'tenant_id', '00000000-0000-0000-0000-000000005001',
  'tenant_role', 'owner',
  'active_workspace_id', '00000000-0000-0000-0000-000000005101'
)::text, true);
set local role authenticated;

SELECT lives_ok(
  $$ select public.create_shared_link(
       'document'::public.shared_link_target_kind,
       '00000000-0000-0000-0000-000000005021'::uuid,
       'workspace'::public.shared_link_audience,
       jsonb_build_object('audience_workspace_id', '00000000-0000-0000-0000-000000005101'),
       'mira este doc'
     ) $$,
  'crear shared_link workspace OK');

-- Trigger creo notificacion para los miembros del workspace (audience)
SELECT ok(
  exists (select 1 from public.notifications
          where user_id = '00000000-0000-0000-0000-000000005012'
            and kind = 'shared_link.received'),
  'audience del workspace recibe notificacion');

SELECT ok(
  not exists (select 1 from public.notifications
              where user_id = '00000000-0000-0000-0000-000000005011'
                and kind = 'shared_link.received'),
  'el sharer NO recibe notificacion de su propio share');

-- Token audience: token_hash debe matchear regex
SELECT lives_ok(
  $$ select public.create_shared_link(
       'document'::public.shared_link_target_kind,
       '00000000-0000-0000-0000-000000005021'::uuid,
       'tenant_with_token'::public.shared_link_audience,
       '{}'::jsonb,
       'token share'
     ) $$,
  'crear shared_link con token genera hash automatico');

-- consume_shared_link_token: validar que retorna info sin transferir permisos
reset role;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', '00000000-0000-0000-0000-000000005012',
  'role', 'authenticated',
  'tenant_id', '00000000-0000-0000-0000-000000005001',
  'tenant_role', 'member',
  'active_workspace_id', '00000000-0000-0000-0000-000000005101'
)::text, true);
set local role authenticated;

-- share_conversation delegando a create_shared_link
reset role;
SELECT ok(
  has_function_privilege('authenticated', 'public.share_conversation(uuid, public.shared_link_audience, jsonb, text)', 'execute'),
  'authenticated puede share_conversation');

-- revoke
SELECT ok(
  has_function_privilege('authenticated', 'public.revoke_shared_link(uuid, jsonb)', 'execute'),
  'authenticated puede revoke_shared_link');

SELECT ok(
  (select relrowsecurity from pg_class where oid = 'public.shared_links'::regclass),
  'RLS habilitado en shared_links');

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Test FAILA**

```bash
npm run test:db -- supabase/tests/20260601090300_shared_links_test.sql 2>&1 | head -20
```

Expected: tabla `shared_links` no existe.

### Task 5.2: Migracion 042

**Files:**
- Create: `supabase/migrations/20260601090300_shared_links.sql`

- [ ] **Step 1: Escribir migracion completa**

```sql
-- Tier 2 · Migracion 042
-- Item 11 del spec: shared_links + RPCs + trigger notify_shared_link_received.

create type public.shared_link_target_kind as enum (
  'document', 'doc_tree_node', 'conversation', 'message', 'collection', 'saved_query'
);

create type public.shared_link_audience as enum (
  'workspace', 'group', 'user_set', 'tenant_with_token'
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
  token_hash text,
  message text,
  created_by uuid references auth.users(id) on delete set null,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
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
create index shared_links_active_idx
  on public.shared_links (tenant_id, created_at desc)
  where revoked_at is null;

create trigger set_shared_links_updated_at
before update on public.shared_links
for each row execute function app.set_updated_at();

alter table public.shared_links enable row level security;

create policy shared_links_select_audience on public.shared_links
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and revoked_at is null
    and (
      created_by = (select auth.uid())
      or (select app.is_tenant_admin())
      or (audience = 'workspace' and (select app.user_belongs_to_workspace(audience_workspace_id)))
      or (audience = 'group' and exists (
            select 1 from public.group_memberships gm
            where gm.group_id = shared_links.audience_group_id
              and gm.user_id = (select auth.uid())
          ))
      or (audience = 'user_set' and (select auth.uid()) = any(audience_user_ids))
    )
  );

revoke insert, update, delete on public.shared_links from authenticated;
grant select on public.shared_links to authenticated;
grant all on public.shared_links to service_role;

-- RPC create_shared_link
create or replace function public.create_shared_link(
  _target_kind public.shared_link_target_kind,
  _target_id uuid,
  _audience public.shared_link_audience,
  _audience_data jsonb default '{}'::jsonb,
  _message text default null,
  _expires_at timestamptz default null,
  _request_context jsonb default null
)
returns table (id uuid, token text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
  current_user_id uuid := auth.uid();
  share_id uuid;
  raw_token text;
  raw_token_full text;
  hashed text;
  audience_ws uuid;
  audience_grp uuid;
  audience_users uuid[];
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  if current_tenant_id is null then raise exception 'Tenant claim is required'; end if;

  audience_ws := nullif(_audience_data->>'audience_workspace_id','')::uuid;
  audience_grp := nullif(_audience_data->>'audience_group_id','')::uuid;
  audience_users := nullif(
    array(select jsonb_array_elements_text(_audience_data->'audience_user_ids'))::uuid[],
    '{}'::uuid[]
  );

  if _audience = 'tenant_with_token' then
    raw_token := encode(extensions.gen_random_bytes(32), 'hex');
    raw_token_full := current_tenant_id::text || ':' || raw_token;
    hashed := encode(extensions.digest(raw_token_full, 'sha256'), 'hex');
  end if;

  insert into public.shared_links (
    tenant_id, target_kind, target_id, audience,
    audience_workspace_id, audience_group_id, audience_user_ids,
    token_hash, message, created_by, expires_at
  ) values (
    current_tenant_id, _target_kind, _target_id, _audience,
    audience_ws, audience_grp, audience_users,
    hashed, _message, current_user_id, _expires_at
  )
  returning shared_links.id into share_id;

  perform app.audit_with_context(
    'shared_link.created', 'shared_link', share_id,
    jsonb_build_object('target_kind', _target_kind, 'target_id', _target_id, 'audience', _audience),
    _request_context
  );

  return query select share_id, raw_token_full;
end;
$$;

-- RPC revoke
create or replace function public.revoke_shared_link(
  _shared_link_id uuid,
  _request_context jsonb default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
  current_user_id uuid := auth.uid();
  link_row public.shared_links%rowtype;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;

  select s.* into link_row
  from public.shared_links s
  where s.id = _shared_link_id and s.tenant_id = current_tenant_id;

  if link_row.id is null then raise exception 'Shared link not found'; end if;
  if link_row.created_by is distinct from current_user_id and not app.is_tenant_admin() then
    raise exception 'Only the creator or a tenant admin can revoke';
  end if;

  update public.shared_links set revoked_at = now()
  where id = _shared_link_id and revoked_at is null;

  perform app.audit_with_context(
    'shared_link.revoked', 'shared_link', _shared_link_id,
    jsonb_build_object('previous_audience', link_row.audience), _request_context
  );
end;
$$;

-- RPC consume_shared_link_token (registra view; NO transfiere permisos)
create or replace function public.consume_shared_link_token(
  _token text,
  _request_context jsonb default null
)
returns table (
  shared_link_id uuid,
  target_kind public.shared_link_target_kind,
  target_id uuid,
  message text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
  current_user_id uuid := auth.uid();
  hashed text;
  link_row public.shared_links%rowtype;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  if current_tenant_id is null then raise exception 'Tenant claim is required'; end if;

  hashed := encode(extensions.digest(_token, 'sha256'), 'hex');

  select s.* into link_row
  from public.shared_links s
  where s.token_hash = hashed
    and s.tenant_id = current_tenant_id
    and s.revoked_at is null
    and (s.expires_at is null or s.expires_at > now());

  if link_row.id is null then raise exception 'Invalid or expired token'; end if;

  perform app.audit_with_context(
    'shared_link.consumed', 'shared_link', link_row.id,
    jsonb_build_object('target_kind', link_row.target_kind, 'target_id', link_row.target_id),
    _request_context
  );

  shared_link_id := link_row.id;
  target_kind := link_row.target_kind;
  target_id := link_row.target_id;
  message := link_row.message;
  return next;
end;
$$;

-- RPC share_conversation (delegates a create_shared_link)
create or replace function public.share_conversation(
  _conversation_id uuid,
  _audience public.shared_link_audience,
  _audience_data jsonb default '{}'::jsonb,
  _message text default null,
  _request_context jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  result_id uuid;
  result_token text;
begin
  if not exists (
    select 1 from public.conversations c
    where c.id = _conversation_id
      and c.tenant_id = (select app.current_tenant_id())
  ) then
    raise exception 'Conversation not found';
  end if;

  select id into result_id from public.create_shared_link(
    'conversation'::public.shared_link_target_kind,
    _conversation_id,
    _audience,
    _audience_data,
    _message,
    null,
    _request_context
  );
  return result_id;
end;
$$;

-- Trigger notify_shared_link_received: inserts notifications cuando hay audience interna.
create or replace function app.notify_shared_link_received()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_user uuid;
  workspace_users record;
begin
  if new.audience = 'workspace' then
    for workspace_users in
      select distinct member_user_id from (
        select wm.principal_id as member_user_id
        from public.workspace_memberships wm
        where wm.workspace_id = new.audience_workspace_id
          and wm.principal_kind = 'user'
        union
        select gm.user_id
        from public.workspace_memberships wm
        join public.group_memberships gm on gm.group_id = wm.principal_id
        where wm.workspace_id = new.audience_workspace_id
          and wm.principal_kind = 'group'
      ) as expanded
      where member_user_id is distinct from new.created_by
    loop
      insert into public.notifications
        (tenant_id, user_id, kind, title, body, target_kind, target_id, source_id, url)
      values (new.tenant_id, workspace_users.member_user_id, 'shared_link.received',
              'Te compartieron contenido', new.message,
              new.target_kind::text, new.target_id, new.id,
              '/shared/' || new.id::text);
    end loop;
  elsif new.audience = 'group' then
    for target_user in
      select gm.user_id from public.group_memberships gm
      where gm.group_id = new.audience_group_id
        and gm.user_id is distinct from new.created_by
    loop
      insert into public.notifications
        (tenant_id, user_id, kind, title, body, target_kind, target_id, source_id, url)
      values (new.tenant_id, target_user, 'shared_link.received',
              'Te compartieron contenido', new.message,
              new.target_kind::text, new.target_id, new.id,
              '/shared/' || new.id::text);
    end loop;
  elsif new.audience = 'user_set' then
    foreach target_user in array new.audience_user_ids
    loop
      if target_user is distinct from new.created_by then
        insert into public.notifications
          (tenant_id, user_id, kind, title, body, target_kind, target_id, source_id, url)
        values (new.tenant_id, target_user, 'shared_link.received',
                'Te compartieron contenido', new.message,
                new.target_kind::text, new.target_id, new.id,
                '/shared/' || new.id::text);
      end if;
    end loop;
  end if;

  return new;
end;
$$;

-- Trigger sera attached en migracion 044 despues de crear `notifications`.

revoke execute on function public.create_shared_link(public.shared_link_target_kind, uuid, public.shared_link_audience, jsonb, text, timestamptz, jsonb) from anon, public;
revoke execute on function public.revoke_shared_link(uuid, jsonb) from anon, public;
revoke execute on function public.consume_shared_link_token(text, jsonb) from anon, public;
revoke execute on function public.share_conversation(uuid, public.shared_link_audience, jsonb, text, jsonb) from anon, public;

grant execute on function public.create_shared_link(public.shared_link_target_kind, uuid, public.shared_link_audience, jsonb, text, timestamptz, jsonb) to authenticated;
grant execute on function public.revoke_shared_link(uuid, jsonb) to authenticated;
grant execute on function public.consume_shared_link_token(text, jsonb) to authenticated;
grant execute on function public.share_conversation(uuid, public.shared_link_audience, jsonb, text, jsonb) to authenticated;
```

- [ ] **Step 2: Test PASA (las assertions de notifications van a fallar hasta migracion 044)**

```bash
npm run test:db -- supabase/tests/20260601090300_shared_links_test.sql 2>&1 | tail -20
```

Expected: las asserts de schema (1-7) y de check constraint (8) pasan; las que validan notifications van a fallar hasta 044. Esto es OK porque el trigger se attacha en 044 (dependencia inversa). Marcar test como **partial-pass esperado** y volver despues de 044.

Si querés evitarlo: comentar temporalmente los SELECT que validan notifications (lineas marcadas "Trigger creo notificacion") y descomentar despues de 044.

- [ ] **Step 3: Suite + types + commit**

```bash
npm run test:db
npm run types:gen
git add supabase/migrations/20260601090300_shared_links.sql \
        supabase/tests/20260601090300_shared_links_test.sql \
        lib/supabase/types.gen.ts
git commit -m "feat(db): tier2 042 shared_links + rpcs + notify trigger fn"
```

---

## Paso 6 · Migracion 043 · `document_annotations` + `annotation_replies`

Item 12 del spec. Visibilidad por enum (`private`, `workspace`, `group`, `mentions`). Reply menciona users -> notif.

### Task 6.1: Test pgTAP

**Files:**
- Create: `supabase/tests/20260601090400_document_annotations_test.sql`

- [ ] **Step 1: Escribir test**

```sql
BEGIN;
SELECT plan(18);

insert into public.tenants (id, slug, name)
values ('00000000-0000-0000-0000-000000006001', 'ann-alpha', 'Annotation Alpha');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000006011','00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','author@ann-alpha.test',now(),
   '{"provider":"email"}'::jsonb,'{}'::jsonb,now(),now()),
  ('00000000-0000-0000-0000-000000006012','00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','reader@ann-alpha.test',now(),
   '{"provider":"email"}'::jsonb,'{}'::jsonb,now(),now()),
  ('00000000-0000-0000-0000-000000006013','00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','mention@ann-alpha.test',now(),
   '{"provider":"email"}'::jsonb,'{}'::jsonb,now(),now());

insert into public.users (id, tenant_id, email, display_name, role, status) values
  ('00000000-0000-0000-0000-000000006011','00000000-0000-0000-0000-000000006001',
   'author@ann-alpha.test','Author','member','active'),
  ('00000000-0000-0000-0000-000000006012','00000000-0000-0000-0000-000000006001',
   'reader@ann-alpha.test','Reader','member','active'),
  ('00000000-0000-0000-0000-000000006013','00000000-0000-0000-0000-000000006001',
   'mention@ann-alpha.test','Mention','member','active');

insert into public.workspaces (id, tenant_id, slug, name, status)
values ('00000000-0000-0000-0000-000000006101','00000000-0000-0000-0000-000000006001',
        'default','Default','active');
insert into public.workspace_memberships
  (workspace_id, tenant_id, principal_kind, principal_id, role) values
  ('00000000-0000-0000-0000-000000006101','00000000-0000-0000-0000-000000006001',
   'user','00000000-0000-0000-0000-000000006011','workspace_editor'),
  ('00000000-0000-0000-0000-000000006101','00000000-0000-0000-0000-000000006001',
   'user','00000000-0000-0000-0000-000000006012','workspace_viewer'),
  ('00000000-0000-0000-0000-000000006101','00000000-0000-0000-0000-000000006001',
   'user','00000000-0000-0000-0000-000000006013','workspace_viewer');

insert into public.documents (id, tenant_id, workspace_id, created_by, filename, r2_key, status, uploaded_at)
values ('00000000-0000-0000-0000-000000006021','00000000-0000-0000-0000-000000006001',
        '00000000-0000-0000-0000-000000006101','00000000-0000-0000-0000-000000006011',
        'a.pdf','00000000-0000-0000-0000-000000006001/00000000-0000-0000-0000-000000006021/a.pdf',
        'indexed', now());

SELECT has_table('public','document_annotations','annotations existe');
SELECT has_table('public','annotation_replies','replies existe');
SELECT has_type('public','annotation_kind','enum kind');
SELECT has_type('public','annotation_visibility','enum visibility');
SELECT has_function('public','create_annotation','create_annotation existe');
SELECT has_function('public','update_annotation','update_annotation existe');
SELECT has_function('public','reply_annotation','reply_annotation existe');
SELECT has_function('public','resolve_annotation','resolve_annotation existe');

-- author crea annotation visibility=workspace
select set_config('request.jwt.claims', jsonb_build_object(
  'sub','00000000-0000-0000-0000-000000006011',
  'role','authenticated',
  'tenant_id','00000000-0000-0000-0000-000000006001',
  'tenant_role','member',
  'active_workspace_id','00000000-0000-0000-0000-000000006101'
)::text, true);
set local role authenticated;

SELECT lives_ok(
  $$ select public.create_annotation(
       '00000000-0000-0000-0000-000000006021'::uuid,
       'Atencion en esta clausula',
       'note'::public.annotation_kind,
       'workspace'::public.annotation_visibility,
       null, null, null, null, null
     ) $$,
  'editor del workspace puede crear annotation');

SELECT is(
  (select count(*)::int from public.document_annotations
   where document_id = '00000000-0000-0000-0000-000000006021'),
  1,
  '1 annotation creada');

-- reader puede leer (visibility=workspace)
reset role;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub','00000000-0000-0000-0000-000000006012',
  'role','authenticated',
  'tenant_id','00000000-0000-0000-0000-000000006001',
  'tenant_role','member',
  'active_workspace_id','00000000-0000-0000-0000-000000006101'
)::text, true);
set local role authenticated;

SELECT is(
  (select count(*)::int from public.document_annotations
   where document_id = '00000000-0000-0000-0000-000000006021'),
  1,
  'reader (workspace_viewer) ve la annotation workspace');

-- reply menciona a 'mention'
SELECT lives_ok(
  $$ select public.reply_annotation(
       (select id from public.document_annotations limit 1),
       'estoy de acuerdo @mention',
       array['00000000-0000-0000-0000-000000006013']::uuid[]
     ) $$,
  'reader crea reply mencionando');

-- author + mention reciben notification
SELECT ok(
  exists (select 1 from public.notifications
          where user_id = '00000000-0000-0000-0000-000000006011'
            and kind = 'annotation.replied'),
  'author de la annotation recibe notif annotation.replied');

SELECT ok(
  exists (select 1 from public.notifications
          where user_id = '00000000-0000-0000-0000-000000006013'
            and kind = 'annotation.mentioned'),
  'mentioned recibe notif annotation.mentioned');

-- el autor del reply NO se notifica a si mismo
SELECT ok(
  not exists (select 1 from public.notifications
              where user_id = '00000000-0000-0000-0000-000000006012'
                and kind = 'annotation.replied'),
  'autor del reply NO se notifica a si mismo');

-- resolve
reset role;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub','00000000-0000-0000-0000-000000006011',
  'role','authenticated',
  'tenant_id','00000000-0000-0000-0000-000000006001',
  'tenant_role','member',
  'active_workspace_id','00000000-0000-0000-0000-000000006101'
)::text, true);
set local role authenticated;

SELECT lives_ok(
  $$ select public.resolve_annotation((select id from public.document_annotations limit 1)) $$,
  'author puede resolver');

SELECT ok(
  exists (select 1 from public.document_annotations
          where resolved_at is not null),
  'annotation marcada como resolved');

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Test FAILA**

```bash
npm run test:db -- supabase/tests/20260601090400_document_annotations_test.sql 2>&1 | head -20
```

### Task 6.2: Migracion 043

**Files:**
- Create: `supabase/migrations/20260601090400_document_annotations.sql`

- [ ] **Step 1: Escribir migracion**

```sql
-- Tier 2 · Migracion 043
-- Item 12: document_annotations + annotation_replies + notify_annotation_reply.

create type public.annotation_kind as enum (
  'note', 'highlight', 'question', 'issue', 'review_request'
);

create type public.annotation_visibility as enum (
  'private', 'workspace', 'group', 'mentions'
);

create table public.document_annotations (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  document_id uuid not null,
  node_id text,
  page integer,
  bbox jsonb,
  text_anchor jsonb,
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
    (visibility = 'group' and group_id is not null) or visibility <> 'group'
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

create trigger set_document_annotations_updated_at
before update on public.document_annotations
for each row execute function app.set_updated_at();

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

create trigger set_annotation_replies_updated_at
before update on public.annotation_replies
for each row execute function app.set_updated_at();

alter table public.document_annotations enable row level security;
alter table public.annotation_replies enable row level security;

create policy document_annotations_select_visible on public.document_annotations
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and deleted_at is null
    and (select app.user_can_read_document(document_id))
    and (
      visibility = 'workspace'
      or (visibility = 'private' and author_id = (select auth.uid()))
      or (visibility = 'group' and exists (
            select 1 from public.group_memberships gm
            where gm.group_id = document_annotations.group_id
              and gm.user_id = (select auth.uid())
          ))
      or (visibility = 'mentions' and (
            author_id = (select auth.uid())
            or (select auth.uid()) = any(mentioned_user_ids)
          ))
      or (select app.is_tenant_admin())
    )
  );

create policy annotation_replies_select_visible on public.annotation_replies
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and deleted_at is null
    and exists (
      select 1 from public.document_annotations a
      where a.id = annotation_replies.annotation_id
        and a.tenant_id = annotation_replies.tenant_id
        and a.deleted_at is null
    )
  );

revoke insert, update, delete on public.document_annotations from authenticated;
revoke insert, update, delete on public.annotation_replies from authenticated;
grant select on public.document_annotations, public.annotation_replies to authenticated;
grant all on public.document_annotations, public.annotation_replies to service_role;

-- RPC create_annotation
create or replace function public.create_annotation(
  _document_id uuid,
  _body text,
  _kind public.annotation_kind default 'note',
  _visibility public.annotation_visibility default 'workspace',
  _node_id text default null,
  _page int default null,
  _bbox jsonb default null,
  _group_id uuid default null,
  _mentioned_user_ids uuid[] default null,
  _request_context jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
  current_user_id uuid := auth.uid();
  annotation_id uuid;
  doc_row public.documents%rowtype;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  if current_tenant_id is null then raise exception 'Tenant claim is required'; end if;
  if not (select app.user_can_read_document(_document_id)) then
    raise exception 'Document not visible';
  end if;

  select d.* into doc_row from public.documents d
  where d.id = _document_id and d.tenant_id = current_tenant_id;

  insert into public.document_annotations (
    tenant_id, document_id, node_id, page, bbox,
    author_id, body, kind, visibility,
    group_id, mentioned_user_ids
  ) values (
    current_tenant_id, _document_id, _node_id, _page, _bbox,
    current_user_id, _body, _kind, _visibility,
    _group_id, _mentioned_user_ids
  ) returning id into annotation_id;

  perform app.audit_with_context(
    'annotation.created', 'annotation', annotation_id,
    jsonb_build_object('document_id', _document_id, 'kind', _kind, 'visibility', _visibility),
    _request_context
  );

  return annotation_id;
end;
$$;

create or replace function public.update_annotation(
  _annotation_id uuid,
  _patch jsonb,
  _request_context jsonb default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_tenant_id uuid := app.current_tenant_id();
  ann public.document_annotations%rowtype;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  select a.* into ann from public.document_annotations a
  where a.id = _annotation_id and a.tenant_id = current_tenant_id;
  if ann.id is null then raise exception 'Annotation not found'; end if;
  if ann.author_id <> current_user_id and not app.is_tenant_admin() then
    raise exception 'Only the author or a tenant admin can update';
  end if;

  update public.document_annotations set
    body = coalesce(_patch->>'body', body),
    kind = coalesce((_patch->>'kind')::public.annotation_kind, kind),
    color = coalesce(_patch->>'color', color),
    mentioned_user_ids = case
      when _patch ? 'mentioned_user_ids' then
        nullif(array(select jsonb_array_elements_text(_patch->'mentioned_user_ids'))::uuid[], '{}'::uuid[])
      else mentioned_user_ids
    end,
    updated_at = now()
  where id = _annotation_id;

  perform app.audit_with_context(
    'annotation.updated', 'annotation', _annotation_id,
    _patch, _request_context
  );
end;
$$;

create or replace function public.reply_annotation(
  _annotation_id uuid,
  _body text,
  _mentioned_user_ids uuid[] default null,
  _request_context jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_tenant_id uuid := app.current_tenant_id();
  ann public.document_annotations%rowtype;
  reply_id uuid;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;

  select a.* into ann from public.document_annotations a
  where a.id = _annotation_id and a.tenant_id = current_tenant_id;
  if ann.id is null then raise exception 'Annotation not found'; end if;
  if not (select app.user_can_read_document(ann.document_id)) then
    raise exception 'Document not visible';
  end if;

  insert into public.annotation_replies
    (tenant_id, annotation_id, author_id, body, mentioned_user_ids)
  values (current_tenant_id, _annotation_id, current_user_id, _body, _mentioned_user_ids)
  returning id into reply_id;

  perform app.audit_with_context(
    'annotation.replied', 'annotation', _annotation_id,
    jsonb_build_object('reply_id', reply_id), _request_context
  );

  return reply_id;
end;
$$;

create or replace function public.resolve_annotation(
  _annotation_id uuid,
  _request_context jsonb default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  ann public.document_annotations%rowtype;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  select a.* into ann from public.document_annotations a
  where a.id = _annotation_id and a.tenant_id = (select app.current_tenant_id());
  if ann.id is null then raise exception 'Annotation not found'; end if;

  update public.document_annotations
    set resolved_at = now(), resolved_by = current_user_id
    where id = _annotation_id;

  perform app.audit_with_context(
    'annotation.resolved', 'annotation', _annotation_id,
    null, _request_context
  );
end;
$$;

-- Trigger function notify_annotation_reply (attach se hace en migracion 044).
create or replace function app.notify_annotation_reply()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  ann public.document_annotations%rowtype;
  mention_user uuid;
  already_notified uuid[] := array[]::uuid[];
begin
  select a.* into ann from public.document_annotations a where a.id = new.annotation_id;
  if ann.id is null then return new; end if;

  -- author de la annotation
  if ann.author_id is distinct from new.author_id then
    insert into public.notifications
      (tenant_id, user_id, kind, title, body, target_kind, target_id, source_id, url)
    values (new.tenant_id, ann.author_id, 'annotation.replied',
            'Respondieron tu anotacion', substring(new.body for 200),
            'document_annotation', ann.id, new.id,
            '/documents/' || ann.document_id::text || '#annotation-' || ann.id::text);
    already_notified := array_append(already_notified, ann.author_id);
  end if;

  -- mentioned users
  if new.mentioned_user_ids is not null then
    foreach mention_user in array new.mentioned_user_ids loop
      if mention_user is distinct from new.author_id
         and not (mention_user = any(already_notified)) then
        insert into public.notifications
          (tenant_id, user_id, kind, title, body, target_kind, target_id, source_id, url)
        values (new.tenant_id, mention_user, 'annotation.mentioned',
                'Te mencionaron en una anotacion', substring(new.body for 200),
                'document_annotation', ann.id, new.id,
                '/documents/' || ann.document_id::text || '#annotation-' || ann.id::text);
        already_notified := array_append(already_notified, mention_user);
      end if;
    end loop;
  end if;

  return new;
end;
$$;

revoke execute on function public.create_annotation(uuid, text, public.annotation_kind, public.annotation_visibility, text, int, jsonb, uuid, uuid[], jsonb) from anon, public;
revoke execute on function public.update_annotation(uuid, jsonb, jsonb) from anon, public;
revoke execute on function public.reply_annotation(uuid, text, uuid[], jsonb) from anon, public;
revoke execute on function public.resolve_annotation(uuid, jsonb) from anon, public;

grant execute on function public.create_annotation(uuid, text, public.annotation_kind, public.annotation_visibility, text, int, jsonb, uuid, uuid[], jsonb) to authenticated;
grant execute on function public.update_annotation(uuid, jsonb, jsonb) to authenticated;
grant execute on function public.reply_annotation(uuid, text, uuid[], jsonb) to authenticated;
grant execute on function public.resolve_annotation(uuid, jsonb) to authenticated;
```

- [ ] **Step 2: Test parcial PASA (assertions de schema + create_annotation funcionan; las de notifications quedan pendientes hasta 044)**

```bash
npm run test:db -- supabase/tests/20260601090400_document_annotations_test.sql 2>&1 | tail -20
```

Si las asserts de notifications fallan, comentarlas temporalmente y descomentar despues de migracion 044.

- [ ] **Step 3: Suite + types + commit**

```bash
npm run test:db
npm run types:gen
git add supabase/migrations/20260601090400_document_annotations.sql \
        supabase/tests/20260601090400_document_annotations_test.sql \
        lib/supabase/types.gen.ts
git commit -m "feat(db): tier2 043 document_annotations + replies + rpcs"
```

---

## Paso 7 · Migracion 044 · `notifications` + `notification_preferences` + extension realtime topic

Item 13 del spec. Punto pivote del tier: las notifications ya estan referenciadas por triggers de migraciones anteriores. Esta migracion CREA la tabla y attacha los triggers. Tambien extiende `app.is_allowed_realtime_topic` para aceptar el topic privado de inbox.

### Task 7.1: Test pgTAP

**Files:**
- Create: `supabase/tests/20260601090500_notifications_test.sql`

- [ ] **Step 1: Escribir test**

```sql
BEGIN;
SELECT plan(20);

insert into public.tenants (id, slug, name)
values ('00000000-0000-0000-0000-000000007001','notif-alpha','Notif Alpha');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000007011','00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','one@notif-alpha.test',now(),
   '{"provider":"email"}'::jsonb,'{}'::jsonb,now(),now()),
  ('00000000-0000-0000-0000-000000007012','00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','two@notif-alpha.test',now(),
   '{"provider":"email"}'::jsonb,'{}'::jsonb,now(),now());

insert into public.users (id, tenant_id, email, display_name, role, status) values
  ('00000000-0000-0000-0000-000000007011','00000000-0000-0000-0000-000000007001',
   'one@notif-alpha.test','One','member','active'),
  ('00000000-0000-0000-0000-000000007012','00000000-0000-0000-0000-000000007001',
   'two@notif-alpha.test','Two','member','active');

SELECT has_table('public','notifications','notifications existe');
SELECT has_table('public','notification_preferences','prefs existe');
SELECT has_type('public','notification_kind','enum kind');
SELECT has_type('public','notification_channel','enum channel');

SELECT ok(
  (select relrowsecurity from pg_class where oid='public.notifications'::regclass),
  'RLS notifications activo');
SELECT ok(
  (select relrowsecurity from pg_class where oid='public.notification_preferences'::regclass),
  'RLS prefs activo');

-- Indice partial sobre unread + archived_at IS NULL
SELECT ok(
  exists (select 1 from pg_indexes
          where schemaname='public' and tablename='notifications'
            and indexdef like '%where%read_at is null%archived_at is null%'),
  'indice partial sobre unread + archived_at IS NULL');

-- RPCs existen
SELECT has_function('public','mark_notification_read','mark_notification_read existe');
SELECT has_function('public','mark_notifications_read_bulk','mark_notifications_read_bulk existe');
SELECT has_function('public','update_notification_preferences','update_notification_preferences existe');

-- Publication realtime incluye notifications
SELECT ok(
  exists (select 1 from pg_publication_tables
          where pubname='supabase_realtime' and tablename='notifications'),
  'notifications esta publicada');

-- digest constraint: solo realtime/off
SELECT throws_ok(
  $$ insert into public.notification_preferences
       (user_id, tenant_id, kind, channel, enabled, digest)
     values ('00000000-0000-0000-0000-000000007011','00000000-0000-0000-0000-000000007001',
             'shared_link.received','in_app',true,'weekly') $$,
  '23514',
  'digest solo admite realtime/off');

-- realtime topic check
select set_config('request.jwt.claims', jsonb_build_object(
  'sub','00000000-0000-0000-0000-000000007011',
  'role','authenticated',
  'tenant_id','00000000-0000-0000-0000-000000007001',
  'tenant_role','member'
)::text, true);
set local role authenticated;

SELECT ok(
  app.is_allowed_realtime_topic(
    'tenant:00000000-0000-0000-0000-000000007001:user:00000000-0000-0000-0000-000000007011:inbox'),
  'user puede joinear su propio topic inbox');

SELECT ok(
  not app.is_allowed_realtime_topic(
    'tenant:00000000-0000-0000-0000-000000007001:user:00000000-0000-0000-0000-000000007012:inbox'),
  'user NO puede joinear inbox de otro user en su mismo tenant');

SELECT ok(
  not app.is_allowed_realtime_topic(
    'tenant:00000000-0000-0000-0000-000000007999:user:00000000-0000-0000-0000-000000007011:inbox'),
  'user NO puede joinear inbox cross-tenant');

SELECT ok(
  not app.is_allowed_realtime_topic('tenant:not-a-uuid:user:00000000-0000-0000-0000-000000007011:inbox'),
  'topic mal formado falla closed');

-- Trigger broadcast: insertar notification dispara realtime.send hacia el topic privado del user
-- Solo testeamos que el trigger exista; el smoke real lo hace el cliente.
SELECT ok(
  exists (select 1 from pg_trigger where tgname = 'broadcast_notifications_realtime_insert'),
  'trigger broadcast_notifications_realtime_insert instalado');

-- Insert manual + mark_read
insert into public.notifications
  (tenant_id, user_id, kind, title, body)
values ('00000000-0000-0000-0000-000000007001','00000000-0000-0000-0000-000000007011',
        'document.new_in_workspace','Nuevo doc','test');

SELECT lives_ok(
  $$ select public.mark_notification_read(
       (select id from public.notifications
        where user_id='00000000-0000-0000-0000-000000007011' limit 1)
     ) $$,
  'mark_notification_read OK');

SELECT is(
  (select read_at is not null from public.notifications
   where user_id='00000000-0000-0000-0000-000000007011' limit 1),
  true,
  'read_at se setea');

-- update_notification_preferences
SELECT lives_ok(
  $$ select public.update_notification_preferences(
       'shared_link.received'::public.notification_kind,
       'email'::public.notification_channel,
       false, 'off'
     ) $$,
  'update prefs OK');

reset role;
SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Test FAILA**

```bash
npm run test:db -- supabase/tests/20260601090500_notifications_test.sql 2>&1 | head -20
```

### Task 7.2: Migracion 044

**Files:**
- Create: `supabase/migrations/20260601090500_notifications.sql`

- [ ] **Step 1: Escribir migracion**

```sql
-- Tier 2 · Migracion 044
-- Item 13: notifications + notification_preferences + extension is_allowed_realtime_topic.

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

create type public.notification_channel as enum ('in_app', 'email');

create table public.notifications (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind public.notification_kind not null,
  title text not null,
  body text,
  url text,
  target_kind text,
  target_id uuid,
  source_id uuid,
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
create index notifications_kind_idx
  on public.notifications (tenant_id, kind, created_at desc);

create table public.notification_preferences (
  user_id uuid not null references auth.users(id) on delete cascade,
  tenant_id uuid not null,
  kind public.notification_kind not null,
  channel public.notification_channel not null default 'in_app',
  enabled boolean not null default true,
  digest text check (digest in ('realtime', 'off')) default 'realtime',
  updated_at timestamptz not null default now(),
  primary key (user_id, kind, channel)
);

create trigger set_notification_preferences_updated_at
before update on public.notification_preferences
for each row execute function app.set_updated_at();

alter table public.notifications enable row level security;
alter table public.notification_preferences enable row level security;

create policy notifications_select_self on public.notifications
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and user_id = (select auth.uid())
  );

create policy notification_preferences_select_self on public.notification_preferences
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and user_id = (select auth.uid())
  );

revoke insert, update, delete on public.notifications from authenticated;
revoke insert, update, delete on public.notification_preferences from authenticated;
grant select on public.notifications, public.notification_preferences to authenticated;
grant all on public.notifications, public.notification_preferences to service_role;

-- Extension de is_allowed_realtime_topic para inbox privado por user.
create or replace function app.is_allowed_realtime_topic(_topic text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select case
    when (select app.current_tenant_id()) is null then false
    when _topic = 'tenant:' || (select app.current_tenant_id())::text || ':notifications' then true
    when _topic ~ '^tenant:[0-9a-f-]{36}:user:[0-9a-f-]{36}:inbox$' then (
      split_part(_topic, ':', 2) = (select app.current_tenant_id())::text
      and split_part(_topic, ':', 4) = (select auth.uid())::text
    )
    when _topic ~ ('^tenant:' || (select app.current_tenant_id())::text || ':workspace:[0-9a-f-]{36}:annotations$') then (
      (select app.user_belongs_to_workspace(split_part(_topic, ':', 4)::uuid))
    )
    when _topic ~ '^document:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(presence|indexing)$' then exists (
      select 1
      from public.documents d
      where d.id = split_part(_topic, ':', 2)::uuid
        and d.tenant_id = (select app.current_tenant_id())
    )
    else false
  end;
$$;

-- Broadcast trigger: cuando se inserta una notification, emit a su topic privado.
create or replace function app.broadcast_notification_realtime_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then
    return null;
  end if;
  perform realtime.send(
    jsonb_build_object(
      'notification_id', new.id,
      'kind', new.kind,
      'title', new.title,
      'body', new.body,
      'url', new.url,
      'target_kind', new.target_kind,
      'target_id', new.target_id,
      'created_at', new.created_at
    ),
    'notification_inserted',
    'tenant:' || new.tenant_id::text || ':user:' || new.user_id::text || ':inbox',
    true
  );
  return null;
end;
$$;

drop trigger if exists broadcast_notifications_realtime_insert on public.notifications;
create trigger broadcast_notifications_realtime_insert
after insert on public.notifications
for each row execute function app.broadcast_notification_realtime_insert();

-- Attach de triggers que ya estaban escritos (shared_links, annotation_replies)
drop trigger if exists notify_shared_link_received_trigger on public.shared_links;
create trigger notify_shared_link_received_trigger
after insert on public.shared_links
for each row execute function app.notify_shared_link_received();

drop trigger if exists notify_annotation_reply_trigger on public.annotation_replies;
create trigger notify_annotation_reply_trigger
after insert on public.annotation_replies
for each row execute function app.notify_annotation_reply();

-- Add notifications a publication realtime
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public' and tablename = 'notifications'
    ) then
      execute 'alter publication supabase_realtime add table public.notifications';
    end if;
  end if;
end;
$$;

-- RPCs
create or replace function public.mark_notification_read(
  _notification_id uuid,
  _request_context jsonb default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_tenant_id uuid := app.current_tenant_id();
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;

  update public.notifications
    set read_at = coalesce(read_at, now())
    where id = _notification_id
      and tenant_id = current_tenant_id
      and user_id = current_user_id;

  if not found then
    raise exception 'Notification not found';
  end if;
end;
$$;

create or replace function public.mark_notifications_read_bulk(
  _notification_ids uuid[],
  _request_context jsonb default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_tenant_id uuid := app.current_tenant_id();
  updated_count integer;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;

  with updated as (
    update public.notifications
       set read_at = coalesce(read_at, now())
     where id = any(_notification_ids)
       and tenant_id = current_tenant_id
       and user_id = current_user_id
       and read_at is null
     returning 1
  )
  select count(*)::int into updated_count from updated;

  return coalesce(updated_count, 0);
end;
$$;

create or replace function public.update_notification_preferences(
  _kind public.notification_kind,
  _channel public.notification_channel,
  _enabled boolean,
  _digest text default 'realtime',
  _request_context jsonb default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_tenant_id uuid := app.current_tenant_id();
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  if _digest not in ('realtime','off') then
    raise exception 'digest must be realtime|off';
  end if;

  insert into public.notification_preferences (user_id, tenant_id, kind, channel, enabled, digest)
  values (current_user_id, current_tenant_id, _kind, _channel, _enabled, _digest)
  on conflict (user_id, kind, channel)
  do update set
    enabled = excluded.enabled,
    digest = excluded.digest,
    updated_at = now();

  perform app.audit_with_context(
    'notification_preferences.updated', 'notification_preferences', null,
    jsonb_build_object('kind', _kind, 'channel', _channel, 'enabled', _enabled, 'digest', _digest),
    _request_context
  );
end;
$$;

revoke execute on function public.mark_notification_read(uuid, jsonb) from anon, public;
revoke execute on function public.mark_notifications_read_bulk(uuid[], jsonb) from anon, public;
revoke execute on function public.update_notification_preferences(public.notification_kind, public.notification_channel, boolean, text, jsonb) from anon, public;

grant execute on function public.mark_notification_read(uuid, jsonb) to authenticated;
grant execute on function public.mark_notifications_read_bulk(uuid[], jsonb) to authenticated;
grant execute on function public.update_notification_preferences(public.notification_kind, public.notification_channel, boolean, text, jsonb) to authenticated;
```

- [ ] **Step 2: Test PASA**

```bash
npm run test:db -- supabase/tests/20260601090500_notifications_test.sql
```

Expected: 20/20 ok.

- [ ] **Step 3: Re-correr tests de 042 y 043 (ahora con notifications attached)**

```bash
npm run test:db -- supabase/tests/20260601090300_shared_links_test.sql
npm run test:db -- supabase/tests/20260601090400_document_annotations_test.sql
```

Expected: ahora todos los asserts de notifications (que habiamos comentado) pasan. Si habiamos comentado, descomentar antes y re-correr.

- [ ] **Step 4: Suite + types + commit**

```bash
npm run test:db
npm run types:gen
git add supabase/migrations/20260601090500_notifications.sql \
        supabase/tests/20260601090500_notifications_test.sql \
        lib/supabase/types.gen.ts
git commit -m "feat(db): tier2 044 notifications + prefs + inbox topic + broadcast trigger"
```

### Task 7.3: Validator jsonschema para `notification_preferences.settings`

**Files:**
- Create: `supabase/migrations/20260601090550_notification_preferences_settings_validator.sql`
- Create: `supabase/tests/notification_preferences_settings_validator_test.sql`

**Contexto**: el column `settings jsonb` puede contener cualquier basura sin esta validación. Definimos schema explícito y lo aplicamos como CHECK constraint via `app.validate_jsonschema` (Paso 0 Task 0.1).

- [ ] **Step 1: pgTAP test (escribir primero, debe fallar)**

```sql
-- supabase/tests/notification_preferences_settings_validator_test.sql
BEGIN;
SELECT plan(4);

-- Setup tenant + user mínimo
insert into public.tenants (id, slug, name)
values ('00000000-0000-0000-0000-000000007301','np-tenant','NP Tenant');
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000007311','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','np@np.test',now(),'{}'::jsonb,'{}'::jsonb,now(),now());
insert into public.users (id, tenant_id, email, role, status)
values ('00000000-0000-0000-0000-000000007311','00000000-0000-0000-0000-000000007301',
  'np@np.test','member','active');

-- Caso valido
SELECT lives_ok(
  $$ insert into public.notification_preferences (user_id, tenant_id, kind, channel, settings)
     values ('00000000-0000-0000-0000-000000007311','00000000-0000-0000-0000-000000007301',
             'mention','in_app',
             '{"digest_frequency":"daily","muted":false}'::jsonb) $$,
  'settings con campos validos pasa CHECK');

-- Caso invalido — campo extra no permitido
SELECT throws_ok(
  $$ insert into public.notification_preferences (user_id, tenant_id, kind, channel, settings)
     values ('00000000-0000-0000-0000-000000007311','00000000-0000-0000-0000-000000007301',
             'mention','in_app',
             '{"digest_frequency":"daily","extra_field":"x"}'::jsonb) $$,
  '23514',
  null,
  'settings con campo extra falla CHECK');

-- Caso invalido — tipo incorrecto
SELECT throws_ok(
  $$ insert into public.notification_preferences (user_id, tenant_id, kind, channel, settings)
     values ('00000000-0000-0000-0000-000000007311','00000000-0000-0000-0000-000000007301',
             'mention','in_app',
             '{"digest_frequency":"daily","muted":"yes"}'::jsonb) $$,
  '23514',
  null,
  'settings con muted no-boolean falla CHECK');

-- Caso null permitido
SELECT lives_ok(
  $$ insert into public.notification_preferences (user_id, tenant_id, kind, channel, settings)
     values ('00000000-0000-0000-0000-000000007311','00000000-0000-0000-0000-000000007301',
             'access_request','in_app', null) $$,
  'settings null pasa CHECK');

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Migración**

```sql
-- supabase/migrations/20260601090550_notification_preferences_settings_validator.sql
-- CHECK constraint sobre notification_preferences.settings via pg_jsonschema.

alter table public.notification_preferences
  add constraint notification_preferences_settings_schema_chk
  check (
    app.validate_jsonschema(
      settings,
      jsonb_build_object(
        'type', 'object',
        'additionalProperties', false,
        'properties', jsonb_build_object(
          'digest_frequency', jsonb_build_object(
            'type', 'string',
            'enum', jsonb_build_array('immediate','hourly','daily','weekly','never')
          ),
          'muted', jsonb_build_object('type','boolean'),
          'muted_until', jsonb_build_object('type','string','format','date-time'),
          'quiet_hours_start', jsonb_build_object('type','string','pattern','^[0-2][0-9]:[0-5][0-9]$'),
          'quiet_hours_end', jsonb_build_object('type','string','pattern','^[0-2][0-9]:[0-5][0-9]$')
        )
      )
    )
  );

comment on constraint notification_preferences_settings_schema_chk
  on public.notification_preferences is
  'JSON Schema: digest_frequency enum, muted bool, quiet_hours HH:MM. additionalProperties=false.';
```

- [ ] **Step 3: Aplicar + correr test**

```bash
supabase db push
npm run test:db -- --test supabase/tests/notification_preferences_settings_validator_test.sql
```

Expected: 4/4 pasan.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260601090550_notification_preferences_settings_validator.sql supabase/tests/notification_preferences_settings_validator_test.sql
git commit -m "feat(db): jsonschema validator para notification_preferences.settings"
```

---

## Paso 8 · Migracion 045 · `document_views`

Item 14 del spec. Policy INSERT explicita: `user_id = auth.uid()` + `app.user_can_read_document(document_id)`. Throttle 30s via Redis (lib del proyecto) en el RPC.

### Task 8.1: Test pgTAP

**Files:**
- Create: `supabase/tests/20260601090600_document_views_test.sql`

- [ ] **Step 1: Escribir test**

```sql
BEGIN;
SELECT plan(10);

insert into public.tenants (id, slug, name)
values ('00000000-0000-0000-0000-000000008001','dv-alpha','DV Alpha'),
       ('00000000-0000-0000-0000-000000008002','dv-beta','DV Beta');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000008011','00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','viewer@dv-alpha.test',now(),
   '{"provider":"email"}'::jsonb,'{}'::jsonb,now(),now()),
  ('00000000-0000-0000-0000-000000008012','00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','spy@dv-beta.test',now(),
   '{"provider":"email"}'::jsonb,'{}'::jsonb,now(),now());

insert into public.users (id, tenant_id, email, display_name, role, status) values
  ('00000000-0000-0000-0000-000000008011','00000000-0000-0000-0000-000000008001',
   'viewer@dv-alpha.test','Viewer','member','active'),
  ('00000000-0000-0000-0000-000000008012','00000000-0000-0000-0000-000000008002',
   'spy@dv-beta.test','Spy','member','active');

insert into public.workspaces (id, tenant_id, slug, name, status)
values ('00000000-0000-0000-0000-000000008101','00000000-0000-0000-0000-000000008001','default','Default','active');
insert into public.workspace_memberships (workspace_id, tenant_id, principal_kind, principal_id, role)
values ('00000000-0000-0000-0000-000000008101','00000000-0000-0000-0000-000000008001',
        'user','00000000-0000-0000-0000-000000008011','workspace_viewer');

insert into public.documents (id, tenant_id, workspace_id, created_by, filename, r2_key, status, uploaded_at)
values ('00000000-0000-0000-0000-000000008021','00000000-0000-0000-0000-000000008001',
        '00000000-0000-0000-0000-000000008101','00000000-0000-0000-0000-000000008011',
        'd.pdf','00000000-0000-0000-0000-000000008001/00000000-0000-0000-0000-000000008021/d.pdf',
        'indexed', now());

SELECT has_table('public','document_views','tabla existe');
SELECT ok(
  (select relrowsecurity from pg_class where oid='public.document_views'::regclass),
  'RLS habilitado');

-- Policy INSERT explicita
SELECT ok(
  exists (select 1 from pg_policies
          where schemaname='public' and tablename='document_views' and cmd='INSERT'),
  'policy INSERT existe');

SELECT has_function('public','record_document_view','record_document_view existe');

-- viewer del workspace puede insertar via RPC
select set_config('request.jwt.claims', jsonb_build_object(
  'sub','00000000-0000-0000-0000-000000008011',
  'role','authenticated',
  'tenant_id','00000000-0000-0000-0000-000000008001',
  'tenant_role','member',
  'active_workspace_id','00000000-0000-0000-0000-000000008101'
)::text, true);
set local role authenticated;

SELECT lives_ok(
  $$ select public.record_document_view(
       '00000000-0000-0000-0000-000000008021'::uuid,
       null, 'search', null
     ) $$,
  'viewer del workspace puede record_document_view');

SELECT is(
  (select count(*)::int from public.document_views
   where document_id='00000000-0000-0000-0000-000000008021'),
  1, '1 view registrada');

-- viewer NO puede insertar a nombre de otro
SELECT throws_ok(
  $$ insert into public.document_views (tenant_id, document_id, user_id, source)
     values ('00000000-0000-0000-0000-000000008001',
             '00000000-0000-0000-0000-000000008021',
             '00000000-0000-0000-0000-000000008012',
             'search') $$,
  '42501',
  'insert directo con otro user_id es rechazado por RLS');

-- spy del otro tenant no puede ver
reset role;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub','00000000-0000-0000-0000-000000008012',
  'role','authenticated',
  'tenant_id','00000000-0000-0000-0000-000000008002',
  'tenant_role','member'
)::text, true);
set local role authenticated;

SELECT is(
  (select count(*)::int from public.document_views),
  0, 'cross-tenant no ve views ajenas');

SELECT throws_ok(
  $$ select public.record_document_view(
       '00000000-0000-0000-0000-000000008021'::uuid, null, 'search', null
     ) $$,
  'Document not visible',
  'cross-tenant record_document_view falla por user_can_read_document');

reset role;
SELECT ok(
  not has_function_privilege('anon','public.record_document_view(uuid, text, text, integer, jsonb)', 'execute'),
  'anon NO puede record_document_view');

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Test FAILA**

```bash
npm run test:db -- supabase/tests/20260601090600_document_views_test.sql 2>&1 | head -20
```

### Task 8.2: Migracion 045

**Files:**
- Create: `supabase/migrations/20260601090600_document_views.sql`

- [ ] **Step 1: Escribir migracion**

```sql
-- Tier 2 · Migracion 045
-- Item 14: document_views + RPC record_document_view (throttle Redis-side desde Node).

create table public.document_views (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  document_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  node_id text,
  source text check (source in ('search','agent_citation','direct_link','bookmark','shared_link','connector_feed')),
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
create index document_views_viewed_at_idx
  on public.document_views (viewed_at);

alter table public.document_views enable row level security;

create policy document_views_select_own_or_admin on public.document_views
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and (
      user_id = (select auth.uid())
      or (select app.is_tenant_admin())
    )
  );

-- Policy INSERT explicita: requiere user_id = auth.uid() + can_read_document.
create policy document_views_insert_self on public.document_views
  for insert to authenticated
  with check (
    tenant_id = (select app.current_tenant_id())
    and user_id = (select auth.uid())
    and (select app.user_can_read_document(document_id))
  );

revoke update, delete on public.document_views from authenticated;
grant select, insert on public.document_views to authenticated;
grant all on public.document_views to service_role;

-- RPC record_document_view (la idempotencia + throttle de 30s se hace via Redis desde la app
-- Node-side; aca solo validamos visibilidad y persistimos. El RPC existe para que la app pase
-- por write boundary y dispare audit cuando aplica).
create or replace function public.record_document_view(
  _document_id uuid,
  _node_id text default null,
  _source text default 'direct_link',
  _dwell_seconds integer default null,
  _metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
  current_user_id uuid := auth.uid();
  view_id uuid;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  if current_tenant_id is null then raise exception 'Tenant claim is required'; end if;
  if not (select app.user_can_read_document(_document_id)) then
    raise exception 'Document not visible';
  end if;

  insert into public.document_views
    (tenant_id, document_id, user_id, node_id, source, dwell_seconds, metadata)
  values
    (current_tenant_id, _document_id, current_user_id, _node_id, _source, _dwell_seconds, _metadata)
  returning id into view_id;

  return view_id;
end;
$$;

revoke execute on function public.record_document_view(uuid, text, text, integer, jsonb) from anon, public;
grant execute on function public.record_document_view(uuid, text, text, integer, jsonb) to authenticated;
```

- [ ] **Step 2: Test PASA**

```bash
npm run test:db -- supabase/tests/20260601090600_document_views_test.sql
```

Expected: 10/10 ok.

- [ ] **Step 3: Suite + types + commit**

```bash
npm run test:db
npm run types:gen
git add supabase/migrations/20260601090600_document_views.sql \
        supabase/tests/20260601090600_document_views_test.sql \
        lib/supabase/types.gen.ts
git commit -m "feat(db): tier2 045 document_views + record_document_view rpc"
```

---

## Paso 9 · Migracion 046 · `document_issues`

Item 15 del spec. Notif `document.issue_assigned` cuando se asigna.

### Task 9.1: Test pgTAP

**Files:**
- Create: `supabase/tests/20260601090700_document_issues_test.sql`

- [ ] **Step 1: Escribir test**

```sql
BEGIN;
SELECT plan(13);

insert into public.tenants (id, slug, name)
values ('00000000-0000-0000-0000-000000009001','iss-alpha','Iss Alpha');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000009011','00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','reporter@iss-alpha.test',now(),
   '{"provider":"email"}'::jsonb,'{}'::jsonb,now(),now()),
  ('00000000-0000-0000-0000-000000009012','00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','assignee@iss-alpha.test',now(),
   '{"provider":"email"}'::jsonb,'{}'::jsonb,now(),now());

insert into public.users (id, tenant_id, email, display_name, role, status) values
  ('00000000-0000-0000-0000-000000009011','00000000-0000-0000-0000-000000009001',
   'reporter@iss-alpha.test','Reporter','member','active'),
  ('00000000-0000-0000-0000-000000009012','00000000-0000-0000-0000-000000009001',
   'assignee@iss-alpha.test','Assignee','admin','active');

insert into public.workspaces (id, tenant_id, slug, name, status)
values ('00000000-0000-0000-0000-000000009101','00000000-0000-0000-0000-000000009001','default','Default','active');
insert into public.workspace_memberships (workspace_id, tenant_id, principal_kind, principal_id, role) values
  ('00000000-0000-0000-0000-000000009101','00000000-0000-0000-0000-000000009001','user','00000000-0000-0000-0000-000000009011','workspace_viewer'),
  ('00000000-0000-0000-0000-000000009101','00000000-0000-0000-0000-000000009001','user','00000000-0000-0000-0000-000000009012','workspace_admin');

insert into public.documents (id, tenant_id, workspace_id, created_by, filename, r2_key, status, uploaded_at)
values ('00000000-0000-0000-0000-000000009021','00000000-0000-0000-0000-000000009001',
        '00000000-0000-0000-0000-000000009101','00000000-0000-0000-0000-000000009011',
        'i.pdf','00000000-0000-0000-0000-000000009001/00000000-0000-0000-0000-000000009021/i.pdf',
        'indexed', now());

SELECT has_table('public','document_issues','tabla existe');
SELECT has_type('public','document_issue_kind','enum kind');
SELECT has_type('public','document_issue_status','enum status');
SELECT has_function('public','report_document_issue','report existe');
SELECT has_function('public','update_document_issue','update existe');
SELECT has_function('public','assign_document_issue','assign existe');
SELECT has_function('public','resolve_document_issue','resolve existe');

-- Realtime publication
SELECT ok(
  exists (select 1 from pg_publication_tables
          where pubname='supabase_realtime' and tablename='document_issues'),
  'document_issues publicada');

select set_config('request.jwt.claims', jsonb_build_object(
  'sub','00000000-0000-0000-0000-000000009011',
  'role','authenticated',
  'tenant_id','00000000-0000-0000-0000-000000009001',
  'tenant_role','member',
  'active_workspace_id','00000000-0000-0000-0000-000000009101'
)::text, true);
set local role authenticated;

SELECT lives_ok(
  $$ select public.report_document_issue(
       '00000000-0000-0000-0000-000000009021'::uuid,
       'outdated'::public.document_issue_kind,
       'doc viejo de 2024'
     ) $$,
  'reporter abre issue');

-- assign (lo hace admin)
reset role;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub','00000000-0000-0000-0000-000000009012',
  'role','authenticated',
  'tenant_id','00000000-0000-0000-0000-000000009001',
  'tenant_role','admin',
  'active_workspace_id','00000000-0000-0000-0000-000000009101'
)::text, true);
set local role authenticated;

SELECT lives_ok(
  $$ select public.assign_document_issue(
       (select id from public.document_issues limit 1),
       '00000000-0000-0000-0000-000000009012'::uuid
     ) $$,
  'admin asigna issue');

SELECT ok(
  exists (select 1 from public.notifications
          where user_id = '00000000-0000-0000-0000-000000009012'
            and kind = 'document.issue_assigned'),
  'assignee recibe notif issue_assigned');

-- resolve
SELECT lives_ok(
  $$ select public.resolve_document_issue(
       (select id from public.document_issues limit 1), 'corregido'
     ) $$,
  'admin resuelve issue');

SELECT ok(
  exists (select 1 from public.notifications
          where user_id = '00000000-0000-0000-0000-000000009011'
            and kind = 'document.issue_resolved'),
  'reporter recibe notif issue_resolved');

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Test FAILA**

```bash
npm run test:db -- supabase/tests/20260601090700_document_issues_test.sql 2>&1 | head -20
```

### Task 9.2: Migracion 046

**Files:**
- Create: `supabase/migrations/20260601090700_document_issues.sql`

- [ ] **Step 1: Escribir migracion completa**

```sql
-- Tier 2 · Migracion 046
-- Item 15: document_issues + RPCs + triggers notify_*

create type public.document_issue_kind as enum (
  'outdated', 'incorrect', 'duplicate', 'broken_link', 'wrong_metadata', 'pii_concern', 'other'
);

create type public.document_issue_status as enum (
  'open', 'triaged', 'in_progress', 'resolved', 'wontfix'
);

create table public.document_issues (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  document_id uuid not null,
  reporter_id uuid references auth.users(id) on delete set null,
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

create trigger set_document_issues_updated_at
before update on public.document_issues
for each row execute function app.set_updated_at();

alter table public.document_issues enable row level security;

create policy document_issues_select_visible on public.document_issues
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and (select app.user_can_read_document(document_id))
  );

revoke insert, update, delete on public.document_issues from authenticated;
grant select on public.document_issues to authenticated;
grant all on public.document_issues to service_role;

-- RPC report_document_issue
create or replace function public.report_document_issue(
  _document_id uuid,
  _kind public.document_issue_kind,
  _description text default null,
  _request_context jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
  current_user_id uuid := auth.uid();
  issue_id uuid;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  if not (select app.user_can_read_document(_document_id)) then
    raise exception 'Document not visible';
  end if;

  insert into public.document_issues
    (tenant_id, document_id, reporter_id, kind, description)
  values
    (current_tenant_id, _document_id, current_user_id, _kind, _description)
  returning id into issue_id;

  perform app.audit_with_context(
    'document.issue_reported', 'document_issue', issue_id,
    jsonb_build_object('document_id', _document_id, 'kind', _kind), _request_context
  );

  return issue_id;
end;
$$;

create or replace function public.update_document_issue(
  _issue_id uuid,
  _patch jsonb,
  _request_context jsonb default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_tenant_id uuid := app.current_tenant_id();
  issue_row public.document_issues%rowtype;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  select i.* into issue_row from public.document_issues i
   where i.id = _issue_id and i.tenant_id = current_tenant_id;
  if issue_row.id is null then raise exception 'Issue not found'; end if;
  if not (app.is_tenant_admin() or
          app.user_workspace_role(
            (select workspace_id from public.documents where id = issue_row.document_id)
          ) in ('workspace_editor','workspace_admin')) then
    raise exception 'Insufficient role to update issue';
  end if;

  update public.document_issues set
    status = coalesce((_patch->>'status')::public.document_issue_status, status),
    description = coalesce(_patch->>'description', description),
    kind = coalesce((_patch->>'kind')::public.document_issue_kind, kind),
    updated_at = now()
  where id = _issue_id;

  perform app.audit_with_context(
    'document.issue_updated', 'document_issue', _issue_id, _patch, _request_context
  );
end;
$$;

create or replace function public.assign_document_issue(
  _issue_id uuid,
  _assignee_id uuid,
  _request_context jsonb default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_tenant_id uuid := app.current_tenant_id();
  issue_row public.document_issues%rowtype;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  select i.* into issue_row from public.document_issues i
   where i.id = _issue_id and i.tenant_id = current_tenant_id;
  if issue_row.id is null then raise exception 'Issue not found'; end if;
  if not (app.is_tenant_admin() or
          app.user_workspace_role(
            (select workspace_id from public.documents where id = issue_row.document_id)
          ) in ('workspace_editor','workspace_admin')) then
    raise exception 'Insufficient role to assign issue';
  end if;

  update public.document_issues set
    assignee_id = _assignee_id, status = 'triaged', updated_at = now()
  where id = _issue_id;

  perform app.audit_with_context(
    'document.issue_assigned', 'document_issue', _issue_id,
    jsonb_build_object('assignee_id', _assignee_id), _request_context
  );
end;
$$;

create or replace function public.resolve_document_issue(
  _issue_id uuid,
  _resolution_note text default null,
  _request_context jsonb default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_tenant_id uuid := app.current_tenant_id();
  issue_row public.document_issues%rowtype;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  select i.* into issue_row from public.document_issues i
   where i.id = _issue_id and i.tenant_id = current_tenant_id;
  if issue_row.id is null then raise exception 'Issue not found'; end if;
  if not (app.is_tenant_admin() or
          app.user_workspace_role(
            (select workspace_id from public.documents where id = issue_row.document_id)
          ) in ('workspace_editor','workspace_admin')) then
    raise exception 'Insufficient role to resolve issue';
  end if;

  update public.document_issues set
    status = 'resolved', resolved_at = now(), resolved_by = current_user_id,
    resolution_note = _resolution_note, updated_at = now()
  where id = _issue_id;

  perform app.audit_with_context(
    'document.issue_resolved', 'document_issue', _issue_id,
    jsonb_build_object('resolution_note', _resolution_note), _request_context
  );
end;
$$;

-- Triggers notify_*
create or replace function app.notify_document_issue_assigned()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  doc_row public.documents%rowtype;
begin
  if tg_op = 'UPDATE' and new.assignee_id is not distinct from old.assignee_id then
    return new;
  end if;
  if new.assignee_id is null then return new; end if;

  select d.* into doc_row from public.documents d where d.id = new.document_id;

  insert into public.notifications
    (tenant_id, user_id, kind, title, body, target_kind, target_id, source_id, url)
  values
    (new.tenant_id, new.assignee_id, 'document.issue_assigned',
     'Te asignaron un issue', new.description,
     'document', new.document_id, new.id,
     '/documents/' || new.document_id::text || '?issue=' || new.id::text);

  if new.status = 'resolved' and old.reporter_id is not null
     and new.resolved_by is distinct from old.reporter_id then
    insert into public.notifications
      (tenant_id, user_id, kind, title, body, target_kind, target_id, source_id, url)
    values
      (new.tenant_id, old.reporter_id, 'document.issue_resolved',
       'Resolvieron tu issue', new.resolution_note,
       'document', new.document_id, new.id,
       '/documents/' || new.document_id::text || '?issue=' || new.id::text);
  end if;

  return new;
end;
$$;

create or replace function app.notify_document_issue_resolved()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
begin
  if tg_op = 'UPDATE' and new.status = 'resolved' and old.status <> 'resolved'
     and new.reporter_id is not null
     and new.resolved_by is distinct from new.reporter_id then
    insert into public.notifications
      (tenant_id, user_id, kind, title, body, target_kind, target_id, source_id, url)
    values
      (new.tenant_id, new.reporter_id, 'document.issue_resolved',
       'Resolvieron tu issue', new.resolution_note,
       'document', new.document_id, new.id,
       '/documents/' || new.document_id::text || '?issue=' || new.id::text);
  end if;
  return new;
end;
$$;

drop trigger if exists notify_document_issue_assigned_trigger on public.document_issues;
create trigger notify_document_issue_assigned_trigger
after insert or update of assignee_id on public.document_issues
for each row execute function app.notify_document_issue_assigned();

drop trigger if exists notify_document_issue_resolved_trigger on public.document_issues;
create trigger notify_document_issue_resolved_trigger
after update of status on public.document_issues
for each row execute function app.notify_document_issue_resolved();

-- Publication
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname='supabase_realtime' and schemaname='public' and tablename='document_issues'
    ) then
      execute 'alter publication supabase_realtime add table public.document_issues';
    end if;
  end if;
end;
$$;

revoke execute on function public.report_document_issue(uuid, public.document_issue_kind, text, jsonb) from anon, public;
revoke execute on function public.update_document_issue(uuid, jsonb, jsonb) from anon, public;
revoke execute on function public.assign_document_issue(uuid, uuid, jsonb) from anon, public;
revoke execute on function public.resolve_document_issue(uuid, text, jsonb) from anon, public;

grant execute on function public.report_document_issue(uuid, public.document_issue_kind, text, jsonb) to authenticated;
grant execute on function public.update_document_issue(uuid, jsonb, jsonb) to authenticated;
grant execute on function public.assign_document_issue(uuid, uuid, jsonb) to authenticated;
grant execute on function public.resolve_document_issue(uuid, text, jsonb) to authenticated;
```

- [ ] **Step 2: Test PASA**

```bash
npm run test:db -- supabase/tests/20260601090700_document_issues_test.sql
```

Expected: 13/13 ok.

- [ ] **Step 3: Suite + types + commit**

```bash
npm run test:db
npm run types:gen
git add supabase/migrations/20260601090700_document_issues.sql \
        supabase/tests/20260601090700_document_issues_test.sql \
        lib/supabase/types.gen.ts
git commit -m "feat(db): tier2 046 document_issues + rpcs + notify triggers"
```

---

## Paso 10 · Migracion 047 · `document_lineage`

Item 16. Denormaliza predecessor_title/filename/indexed_at para sobrevivir hard-delete del predecesor.

### Task 10.1: Test pgTAP

**Files:**
- Create: `supabase/tests/20260601090800_document_lineage_test.sql`

- [ ] **Step 1: Escribir test**

```sql
BEGIN;
SELECT plan(12);

insert into public.tenants (id, slug, name)
values ('00000000-0000-0000-0000-000000010001','lin-alpha','Lineage Alpha');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000010011','00000000-0000-0000-0000-000000000000',
        'authenticated','authenticated','admin@lin-alpha.test',now(),
        '{"provider":"email"}'::jsonb,'{}'::jsonb,now(),now());

insert into public.users (id, tenant_id, email, display_name, role, status)
values ('00000000-0000-0000-0000-000000010011','00000000-0000-0000-0000-000000010001',
        'admin@lin-alpha.test','Admin','admin','active');

insert into public.workspaces (id, tenant_id, slug, name, status)
values ('00000000-0000-0000-0000-000000010101','00000000-0000-0000-0000-000000010001','default','Default','active');
insert into public.workspace_memberships (workspace_id, tenant_id, principal_kind, principal_id, role)
values ('00000000-0000-0000-0000-000000010101','00000000-0000-0000-0000-000000010001',
        'user','00000000-0000-0000-0000-000000010011','workspace_admin');

-- predecesor + sucesor
insert into public.documents (id, tenant_id, workspace_id, created_by, title, filename, r2_key, status, uploaded_at, indexed_at)
values
  ('00000000-0000-0000-0000-000000010021','00000000-0000-0000-0000-000000010001',
   '00000000-0000-0000-0000-000000010101','00000000-0000-0000-0000-000000010011',
   'Politica 2025','politica-2025.pdf',
   '00000000-0000-0000-0000-000000010001/00000000-0000-0000-0000-000000010021/politica-2025.pdf',
   'indexed', now() - interval '1 year', now() - interval '1 year'),
  ('00000000-0000-0000-0000-000000010022','00000000-0000-0000-0000-000000010001',
   '00000000-0000-0000-0000-000000010101','00000000-0000-0000-0000-000000010011',
   'Politica 2026','politica-2026.pdf',
   '00000000-0000-0000-0000-000000010001/00000000-0000-0000-0000-000000010022/politica-2026.pdf',
   'indexed', now(), now());

SELECT has_table('public','document_lineage','tabla existe');
SELECT has_function('public','link_document_version','link_document_version existe');

-- View document_lineage_heads existe
SELECT has_view('public','document_lineage_heads','vista heads existe');

select set_config('request.jwt.claims', jsonb_build_object(
  'sub','00000000-0000-0000-0000-000000010011',
  'role','authenticated',
  'tenant_id','00000000-0000-0000-0000-000000010001',
  'tenant_role','admin',
  'active_workspace_id','00000000-0000-0000-0000-000000010101'
)::text, true);
set local role authenticated;

SELECT lives_ok(
  $$ select public.link_document_version(
       '00000000-0000-0000-0000-000000010022'::uuid,
       '00000000-0000-0000-0000-000000010021'::uuid,
       'v2026', '2026-01-01'::date
     ) $$,
  'admin puede link_document_version');

-- Denormalized fields presentes
SELECT ok(
  exists (select 1 from public.document_lineage dl
          where dl.document_id = '00000000-0000-0000-0000-000000010022'
            and dl.predecessor_title is not null
            and dl.predecessor_filename is not null
            and dl.predecessor_indexed_at is not null),
  'predecessor_* denormalizados se copian al crear lineage');

-- check (document_id <> predecessor_document_id)
SELECT throws_ok(
  $$ select public.link_document_version(
       '00000000-0000-0000-0000-000000010022'::uuid,
       '00000000-0000-0000-0000-000000010022'::uuid,
       'self', null::date
     ) $$,
  'self-lineage',
  'no permite linkear un doc a si mismo (check constraint o RPC)');

-- Hard delete del predecesor: la fila lineage sobrevive con denormalizados
reset role;
delete from public.documents where id = '00000000-0000-0000-0000-000000010021';

SELECT ok(
  exists (select 1 from public.document_lineage dl
          where dl.document_id = '00000000-0000-0000-0000-000000010022'),
  'lineage sobrevive al hard-delete del predecesor');

SELECT ok(
  (select predecessor_document_id from public.document_lineage
   where document_id = '00000000-0000-0000-0000-000000010022') is null,
  'predecessor_document_id queda NULL por on delete set null');

SELECT ok(
  (select predecessor_title from public.document_lineage
   where document_id = '00000000-0000-0000-0000-000000010022') = 'Politica 2025',
  'predecessor_title preservado denormalizado');

SELECT ok(
  (select count(*)::int from public.document_lineage_heads
   where document_id = '00000000-0000-0000-0000-000000010022') = 1,
  'document_lineage_heads expone la fila viva como head');

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Test FAILA**

```bash
npm run test:db -- supabase/tests/20260601090800_document_lineage_test.sql 2>&1 | head -20
```

### Task 10.2: Migracion 047

**Files:**
- Create: `supabase/migrations/20260601090800_document_lineage.sql`

- [ ] **Step 1: Escribir migracion**

```sql
-- Tier 2 · Migracion 047
-- Item 16: document_lineage + link_document_version + view document_lineage_heads.

create table public.document_lineage (
  tenant_id uuid not null,
  document_id uuid not null,
  predecessor_document_id uuid,
  predecessor_title text,
  predecessor_filename text,
  predecessor_indexed_at timestamptz,
  version_label text,
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
create index document_lineage_active_idx
  on public.document_lineage (tenant_id) where superseded_at is null;

alter table public.document_lineage enable row level security;

create policy document_lineage_select_visible on public.document_lineage
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and (select app.user_can_read_document(document_id))
  );

revoke insert, update, delete on public.document_lineage from authenticated;
grant select on public.document_lineage to authenticated;
grant all on public.document_lineage to service_role;

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

grant select on public.document_lineage_heads to authenticated;

-- RPC link_document_version
create or replace function public.link_document_version(
  _document_id uuid,
  _predecessor_document_id uuid,
  _version_label text default null,
  _effective_from date default null,
  _request_context jsonb default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
  current_user_id uuid := auth.uid();
  pred_doc public.documents%rowtype;
  current_doc public.documents%rowtype;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  if _document_id = _predecessor_document_id then
    raise exception 'self-lineage' using errcode = 'P0001';
  end if;

  select d.* into current_doc from public.documents d
    where d.id = _document_id and d.tenant_id = current_tenant_id;
  if current_doc.id is null then raise exception 'Document not found'; end if;

  select d.* into pred_doc from public.documents d
    where d.id = _predecessor_document_id and d.tenant_id = current_tenant_id;
  if pred_doc.id is null then raise exception 'Predecessor not found'; end if;

  if not (app.is_tenant_admin() or
          app.user_workspace_role(current_doc.workspace_id) = 'workspace_admin') then
    raise exception 'Only workspace_admin or tenant admin can link versions';
  end if;

  -- Denormaliza datos del predecesor al crear lineage (sobrevive hard-delete).
  insert into public.document_lineage (
    tenant_id, document_id, predecessor_document_id,
    predecessor_title, predecessor_filename, predecessor_indexed_at,
    version_label, effective_from
  ) values (
    current_tenant_id, _document_id, _predecessor_document_id,
    pred_doc.title, pred_doc.filename, pred_doc.indexed_at,
    _version_label, _effective_from
  )
  on conflict (document_id) do update set
    predecessor_document_id = excluded.predecessor_document_id,
    predecessor_title = excluded.predecessor_title,
    predecessor_filename = excluded.predecessor_filename,
    predecessor_indexed_at = excluded.predecessor_indexed_at,
    version_label = excluded.version_label,
    effective_from = excluded.effective_from;

  -- Marca el predecesor como superseded en su propia fila si tiene una.
  update public.document_lineage set superseded_at = now()
    where document_id = _predecessor_document_id and superseded_at is null;

  perform app.audit_with_context(
    'document.lineage_linked', 'document_lineage', _document_id,
    jsonb_build_object('predecessor', _predecessor_document_id, 'version', _version_label),
    _request_context
  );
end;
$$;

revoke execute on function public.link_document_version(uuid, uuid, text, date, jsonb) from anon, public;
grant execute on function public.link_document_version(uuid, uuid, text, date, jsonb) to authenticated;
```

- [ ] **Step 2: Test PASA**

```bash
npm run test:db -- supabase/tests/20260601090800_document_lineage_test.sql
```

Expected: 12/12 ok.

- [ ] **Step 3: Suite + types + commit**

```bash
npm run test:db
npm run types:gen
git add supabase/migrations/20260601090800_document_lineage.sql \
        supabase/tests/20260601090800_document_lineage_test.sql \
        lib/supabase/types.gen.ts
git commit -m "feat(db): tier2 047 document_lineage + link_document_version + heads view"
```

---

## Paso 11 · Migracion 048 · `access_requests`

Item 17. `target_kind` SOLO `workspace` y `collection`. Notif al admin + al requester.

### Task 11.1: Test pgTAP

**Files:**
- Create: `supabase/tests/20260601090900_access_requests_test.sql`

- [ ] **Step 1: Escribir test**

```sql
BEGIN;
SELECT plan(14);

insert into public.tenants (id, slug, name)
values ('00000000-0000-0000-0000-000000011001','ar-alpha','AR Alpha');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000011011','00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','requester@ar-alpha.test',now(),
   '{"provider":"email"}'::jsonb,'{}'::jsonb,now(),now()),
  ('00000000-0000-0000-0000-000000011012','00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','admin@ar-alpha.test',now(),
   '{"provider":"email"}'::jsonb,'{}'::jsonb,now(),now());

insert into public.users (id, tenant_id, email, display_name, role, status) values
  ('00000000-0000-0000-0000-000000011011','00000000-0000-0000-0000-000000011001','requester@ar-alpha.test','Requester','member','active'),
  ('00000000-0000-0000-0000-000000011012','00000000-0000-0000-0000-000000011001','admin@ar-alpha.test','Admin','admin','active');

insert into public.workspaces (id, tenant_id, slug, name, status)
values ('00000000-0000-0000-0000-000000011101','00000000-0000-0000-0000-000000011001','finance','Finance','active');
insert into public.workspace_memberships (workspace_id, tenant_id, principal_kind, principal_id, role)
values ('00000000-0000-0000-0000-000000011101','00000000-0000-0000-0000-000000011001',
        'user','00000000-0000-0000-0000-000000011012','workspace_admin');

SELECT has_table('public','access_requests','tabla existe');
SELECT has_type('public','access_request_target_kind','enum target_kind');
SELECT has_type('public','access_request_status','enum status');
SELECT has_function('public','request_access','request_access existe');
SELECT has_function('public','decide_access_request','decide_access_request existe');
SELECT has_function('public','withdraw_access_request','withdraw_access_request existe');

-- enum no debe incluir 'document'
SELECT ok(
  not exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'access_request_target_kind' and e.enumlabel = 'document'
  ),
  'access_request_target_kind NO incluye document');

-- requester abre access request hacia el workspace finance
select set_config('request.jwt.claims', jsonb_build_object(
  'sub','00000000-0000-0000-0000-000000011011',
  'role','authenticated',
  'tenant_id','00000000-0000-0000-0000-000000011001',
  'tenant_role','member'
)::text, true);
set local role authenticated;

SELECT lives_ok(
  $$ select public.request_access(
       'workspace'::public.access_request_target_kind,
       '00000000-0000-0000-0000-000000011101'::uuid,
       'necesito acceso para auditoria'
     ) $$,
  'requester abre access_request');

-- admin del workspace recibe notif
SELECT ok(
  exists (select 1 from public.notifications
          where user_id = '00000000-0000-0000-0000-000000011012'
            and kind = 'access_request.received'),
  'admin del workspace recibe notif access_request.received');

-- admin aprueba
reset role;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub','00000000-0000-0000-0000-000000011012',
  'role','authenticated',
  'tenant_id','00000000-0000-0000-0000-000000011001',
  'tenant_role','admin',
  'active_workspace_id','00000000-0000-0000-0000-000000011101'
)::text, true);
set local role authenticated;

SELECT lives_ok(
  $$ select public.decide_access_request(
       (select id from public.access_requests limit 1),
       'approved', 'OK te agrego'
     ) $$,
  'admin aprueba');

SELECT ok(
  exists (select 1 from public.notifications
          where user_id = '00000000-0000-0000-0000-000000011011'
            and kind = 'access_request.decided'),
  'requester recibe notif decided');

-- withdraw funcionando
reset role;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub','00000000-0000-0000-0000-000000011011',
  'role','authenticated',
  'tenant_id','00000000-0000-0000-0000-000000011001',
  'tenant_role','member'
)::text, true);
set local role authenticated;

SELECT lives_ok(
  $$ select public.request_access(
       'workspace'::public.access_request_target_kind,
       '00000000-0000-0000-0000-000000011101'::uuid,
       'segundo intento'
     ) $$,
  'segunda request OK');

SELECT lives_ok(
  $$ select public.withdraw_access_request(
       (select id from public.access_requests
          where status='pending' order by created_at desc limit 1)
     ) $$,
  'requester retira su request');

SELECT ok(
  exists (select 1 from public.access_requests
          where status = 'withdrawn'),
  'estado withdrawn registrado');

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Test FAILA**

```bash
npm run test:db -- supabase/tests/20260601090900_access_requests_test.sql 2>&1 | head -20
```

### Task 11.2: Migracion 048

**Files:**
- Create: `supabase/migrations/20260601090900_access_requests.sql`

- [ ] **Step 1: Escribir migracion**

```sql
-- Tier 2 · Migracion 048
-- Item 17: access_requests + RPCs + triggers notify.

create type public.access_request_target_kind as enum ('workspace', 'collection');

create type public.access_request_status as enum (
  'pending', 'approved', 'denied', 'withdrawn', 'expired'
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

create trigger set_access_requests_updated_at
before update on public.access_requests
for each row execute function app.set_updated_at();

alter table public.access_requests enable row level security;

create policy access_requests_select_self_or_admin on public.access_requests
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and (
      requester_id = (select auth.uid())
      or (select app.is_tenant_admin())
      or (target_kind = 'workspace' and
          app.user_workspace_role(target_id) = 'workspace_admin')
      or (target_kind = 'collection' and exists (
            select 1 from public.collections c
            where c.id = access_requests.target_id
              and app.user_workspace_role(c.workspace_id) = 'workspace_admin'
          ))
    )
  );

revoke insert, update, delete on public.access_requests from authenticated;
grant select on public.access_requests to authenticated;
grant all on public.access_requests to service_role;

-- RPC request_access
create or replace function public.request_access(
  _target_kind public.access_request_target_kind,
  _target_id uuid,
  _reason text default null,
  _request_context jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
  current_user_id uuid := auth.uid();
  req_id uuid;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;

  insert into public.access_requests
    (tenant_id, requester_id, target_kind, target_id, reason)
  values
    (current_tenant_id, current_user_id, _target_kind, _target_id, _reason)
  returning id into req_id;

  perform app.audit_with_context(
    'access_request.created', 'access_request', req_id,
    jsonb_build_object('target_kind', _target_kind, 'target_id', _target_id), _request_context
  );

  return req_id;
end;
$$;

create or replace function public.decide_access_request(
  _request_id uuid,
  _decision text,
  _decision_note text default null,
  _request_context jsonb default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
  current_user_id uuid := auth.uid();
  req_row public.access_requests%rowtype;
  is_authorized boolean;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  if _decision not in ('approved','denied') then
    raise exception 'decision must be approved|denied';
  end if;

  select r.* into req_row from public.access_requests r
   where r.id = _request_id and r.tenant_id = current_tenant_id;
  if req_row.id is null then raise exception 'Request not found'; end if;
  if req_row.status <> 'pending' then raise exception 'Request already decided'; end if;

  is_authorized := app.is_tenant_admin();
  if not is_authorized and req_row.target_kind = 'workspace' then
    is_authorized := app.user_workspace_role(req_row.target_id) = 'workspace_admin';
  end if;
  if not is_authorized and req_row.target_kind = 'collection' then
    is_authorized := exists (
      select 1 from public.collections c
      where c.id = req_row.target_id
        and app.user_workspace_role(c.workspace_id) = 'workspace_admin'
    );
  end if;
  if not is_authorized then
    raise exception 'Not authorized to decide';
  end if;

  update public.access_requests set
    status = _decision::public.access_request_status,
    decided_by = current_user_id,
    decided_at = now(),
    decision_note = _decision_note,
    updated_at = now()
  where id = _request_id;

  perform app.audit_with_context(
    'access_request.decided', 'access_request', _request_id,
    jsonb_build_object('decision', _decision, 'note', _decision_note), _request_context
  );
end;
$$;

create or replace function public.withdraw_access_request(
  _request_id uuid,
  _request_context jsonb default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  req_row public.access_requests%rowtype;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  select r.* into req_row from public.access_requests r
   where r.id = _request_id and r.tenant_id = (select app.current_tenant_id());
  if req_row.id is null then raise exception 'Request not found'; end if;
  if req_row.requester_id <> current_user_id then
    raise exception 'Only the requester can withdraw';
  end if;
  if req_row.status <> 'pending' then raise exception 'Request not pending'; end if;

  update public.access_requests set
    status = 'withdrawn', updated_at = now()
  where id = _request_id;

  perform app.audit_with_context(
    'access_request.withdrawn', 'access_request', _request_id, null, _request_context
  );
end;
$$;

-- Triggers notify_*
create or replace function app.notify_access_request_received()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  admin_user uuid;
  target_workspace_id uuid;
begin
  if new.target_kind = 'workspace' then
    target_workspace_id := new.target_id;
  elsif new.target_kind = 'collection' then
    select workspace_id into target_workspace_id from public.collections
      where id = new.target_id;
  end if;

  for admin_user in
    select distinct member_user_id from (
      select wm.principal_id as member_user_id
      from public.workspace_memberships wm
      where wm.workspace_id = target_workspace_id
        and wm.principal_kind = 'user'
        and wm.role = 'workspace_admin'
      union
      select gm.user_id
      from public.workspace_memberships wm
      join public.group_memberships gm on gm.group_id = wm.principal_id
      where wm.workspace_id = target_workspace_id
        and wm.principal_kind = 'group'
        and wm.role = 'workspace_admin'
    ) expanded
    where member_user_id is distinct from new.requester_id
  loop
    insert into public.notifications
      (tenant_id, user_id, kind, title, body, target_kind, target_id, source_id, url)
    values
      (new.tenant_id, admin_user, 'access_request.received',
       'Nueva solicitud de acceso', new.reason,
       new.target_kind::text, new.target_id, new.id,
       '/admin/access-requests/' || new.id::text);
  end loop;
  return new;
end;
$$;

create or replace function app.notify_access_request_decided()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.status in ('approved','denied')
     and old.status = 'pending' then
    insert into public.notifications
      (tenant_id, user_id, kind, title, body, target_kind, target_id, source_id, url)
    values
      (new.tenant_id, new.requester_id, 'access_request.decided',
       'Tu solicitud fue ' || new.status::text, new.decision_note,
       new.target_kind::text, new.target_id, new.id,
       '/access-requests/' || new.id::text);
  end if;
  return new;
end;
$$;

drop trigger if exists notify_access_request_received_trigger on public.access_requests;
create trigger notify_access_request_received_trigger
after insert on public.access_requests
for each row execute function app.notify_access_request_received();

drop trigger if exists notify_access_request_decided_trigger on public.access_requests;
create trigger notify_access_request_decided_trigger
after update of status on public.access_requests
for each row execute function app.notify_access_request_decided();

revoke execute on function public.request_access(public.access_request_target_kind, uuid, text, jsonb) from anon, public;
revoke execute on function public.decide_access_request(uuid, text, text, jsonb) from anon, public;
revoke execute on function public.withdraw_access_request(uuid, jsonb) from anon, public;

grant execute on function public.request_access(public.access_request_target_kind, uuid, text, jsonb) to authenticated;
grant execute on function public.decide_access_request(uuid, text, text, jsonb) to authenticated;
grant execute on function public.withdraw_access_request(uuid, jsonb) to authenticated;
```

- [ ] **Step 2: Test PASA**

```bash
npm run test:db -- supabase/tests/20260601090900_access_requests_test.sql
```

Expected: 14/14 ok.

- [ ] **Step 3: Suite + types + commit**

```bash
npm run test:db
npm run types:gen
git add supabase/migrations/20260601090900_access_requests.sql \
        supabase/tests/20260601090900_access_requests_test.sql \
        lib/supabase/types.gen.ts
git commit -m "feat(db): tier2 048 access_requests + rpcs + notify triggers"
```

---

## Paso 12 · Migracion 049.a · `saved_queries`

Item 18. `last_result_hash` considera `extraction_pipeline_version` para que reextracciones disparen notif.

### Task 12.1: Test pgTAP

**Files:**
- Create: `supabase/tests/20260601091000_saved_queries_test.sql`

- [ ] **Step 1: Escribir test**

```sql
BEGIN;
SELECT plan(11);

insert into public.tenants (id, slug, name)
values ('00000000-0000-0000-0000-000000012001','sq-alpha','SQ Alpha');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000012011','00000000-0000-0000-0000-000000000000',
        'authenticated','authenticated','sq@sq-alpha.test',now(),
        '{"provider":"email"}'::jsonb,'{}'::jsonb,now(),now());

insert into public.users (id, tenant_id, email, display_name, role, status)
values ('00000000-0000-0000-0000-000000012011','00000000-0000-0000-0000-000000012001',
        'sq@sq-alpha.test','SQ User','member','active');

insert into public.workspaces (id, tenant_id, slug, name, status)
values ('00000000-0000-0000-0000-000000012101','00000000-0000-0000-0000-000000012001','default','Default','active');
insert into public.workspace_memberships (workspace_id, tenant_id, principal_kind, principal_id, role)
values ('00000000-0000-0000-0000-000000012101','00000000-0000-0000-0000-000000012001',
        'user','00000000-0000-0000-0000-000000012011','workspace_viewer');

SELECT has_table('public','saved_queries','tabla existe');
SELECT has_function('public','create_saved_query','create existe');
SELECT has_function('public','update_saved_query','update existe');
SELECT has_function('public','delete_saved_query','delete existe');
SELECT has_function('public','run_saved_query','run_saved_query existe');

select set_config('request.jwt.claims', jsonb_build_object(
  'sub','00000000-0000-0000-0000-000000012011',
  'role','authenticated',
  'tenant_id','00000000-0000-0000-0000-000000012001',
  'tenant_role','member',
  'active_workspace_id','00000000-0000-0000-0000-000000012101'
)::text, true);
set local role authenticated;

SELECT lives_ok(
  $$ select public.create_saved_query(
       'Normativa fiscal 2026', 'normativa fiscal 2026',
       jsonb_build_object('workspace_ids', jsonb_build_array('00000000-0000-0000-0000-000000012101')),
       '*/10 * * * *', true
     ) $$,
  'crear saved_query OK');

SELECT is(
  (select count(*)::int from public.saved_queries
   where user_id = '00000000-0000-0000-0000-000000012011'),
  1, '1 saved_query creada');

-- run devuelve jsonb (puede ser vacio sin docs indexados)
SELECT lives_ok(
  $$ select public.run_saved_query(
       (select id from public.saved_queries
          where user_id='00000000-0000-0000-0000-000000012011' limit 1)
     ) $$,
  'run_saved_query OK aunque resultado este vacio');

-- delete
SELECT lives_ok(
  $$ select public.delete_saved_query(
       (select id from public.saved_queries
          where user_id='00000000-0000-0000-0000-000000012011' limit 1)
     ) $$,
  'delete_saved_query OK');

SELECT is(
  (select count(*)::int from public.saved_queries
   where user_id = '00000000-0000-0000-0000-000000012011' and deleted_at is null),
  0, 'soft-deleted');

reset role;
SELECT ok(
  not has_function_privilege('anon','public.create_saved_query(text, text, jsonb, text, boolean, jsonb)', 'execute'),
  'anon NO puede create_saved_query');

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Test FAILA**

```bash
npm run test:db -- supabase/tests/20260601091000_saved_queries_test.sql 2>&1 | head -20
```

### Task 12.2: Migracion 049.a

**Files:**
- Create: `supabase/migrations/20260601091000_saved_queries.sql`

- [ ] **Step 1: Escribir migracion**

```sql
-- Tier 2 · Migracion 049.a
-- Item 18: saved_queries + RPCs + run_saved_query (snapshot).

create table public.saved_queries (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text,
  query text not null,
  filters jsonb not null default '{}'::jsonb,
  schedule_cron text,
  notify_on_new_results boolean not null default true,
  last_run_at timestamptz,
  last_result_hash text,
  last_result_count integer,
  metadata jsonb not null default '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index saved_queries_user_idx
  on public.saved_queries (tenant_id, user_id, updated_at desc)
  where deleted_at is null;
create index saved_queries_scheduled_idx
  on public.saved_queries (tenant_id, schedule_cron)
  where schedule_cron is not null and deleted_at is null;

create trigger set_saved_queries_updated_at
before update on public.saved_queries
for each row execute function app.set_updated_at();

alter table public.saved_queries enable row level security;

create policy saved_queries_select_self on public.saved_queries
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and user_id = (select auth.uid())
    and deleted_at is null
  );

revoke insert, update, delete on public.saved_queries from authenticated;
grant select on public.saved_queries to authenticated;
grant all on public.saved_queries to service_role;

-- RPC create_saved_query
create or replace function public.create_saved_query(
  _name text,
  _query text,
  _filters jsonb default '{}'::jsonb,
  _schedule_cron text default null,
  _notify_on_new_results boolean default true,
  _request_context jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
  current_user_id uuid := auth.uid();
  saved_id uuid;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;

  insert into public.saved_queries
    (tenant_id, user_id, name, query, filters, schedule_cron, notify_on_new_results)
  values
    (current_tenant_id, current_user_id, _name, _query, _filters, _schedule_cron, _notify_on_new_results)
  returning id into saved_id;

  perform app.audit_with_context(
    'saved_query.created', 'saved_query', saved_id,
    jsonb_build_object('name', _name, 'schedule_cron', _schedule_cron), _request_context
  );
  return saved_id;
end;
$$;

create or replace function public.update_saved_query(
  _saved_query_id uuid,
  _patch jsonb,
  _request_context jsonb default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_tenant_id uuid := app.current_tenant_id();
  sq_row public.saved_queries%rowtype;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  select s.* into sq_row from public.saved_queries s
    where s.id = _saved_query_id and s.tenant_id = current_tenant_id
      and s.user_id = current_user_id and s.deleted_at is null;
  if sq_row.id is null then raise exception 'Saved query not found'; end if;

  update public.saved_queries set
    name = coalesce(_patch->>'name', name),
    query = coalesce(_patch->>'query', query),
    filters = coalesce(_patch->'filters', filters),
    schedule_cron = case when _patch ? 'schedule_cron' then _patch->>'schedule_cron' else schedule_cron end,
    notify_on_new_results = coalesce((_patch->>'notify_on_new_results')::boolean, notify_on_new_results),
    updated_at = now()
  where id = _saved_query_id;

  perform app.audit_with_context(
    'saved_query.updated', 'saved_query', _saved_query_id, _patch, _request_context
  );
end;
$$;

create or replace function public.delete_saved_query(
  _saved_query_id uuid,
  _request_context jsonb default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_tenant_id uuid := app.current_tenant_id();
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;

  update public.saved_queries
    set deleted_at = now()
    where id = _saved_query_id
      and tenant_id = current_tenant_id
      and user_id = current_user_id
      and deleted_at is null;

  if not found then
    raise exception 'Saved query not found';
  end if;

  perform app.audit_with_context(
    'saved_query.deleted', 'saved_query', _saved_query_id, null, _request_context
  );
end;
$$;

-- RPC run_saved_query: ejecuta el query con los filters guardados via search_documents
-- y devuelve un snapshot con doc_ids + score + extraction_pipeline_version
-- (asi reextracciones invalidan el hash incluso con mismos doc_ids).
create or replace function public.run_saved_query(
  _saved_query_id uuid,
  _request_context jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_tenant_id uuid := app.current_tenant_id();
  sq_row public.saved_queries%rowtype;
  results jsonb;
  result_hash text;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  select s.* into sq_row from public.saved_queries s
    where s.id = _saved_query_id and s.tenant_id = current_tenant_id
      and s.user_id = current_user_id and s.deleted_at is null;
  if sq_row.id is null then raise exception 'Saved query not found'; end if;

  with hits as (
    select sd.document_id, sd.title, sd.score, d.extraction_pipeline_version
    from public.search_documents(sq_row.query, sq_row.filters, 100) sd
    join public.documents d on d.id = sd.document_id
  )
  select jsonb_build_object(
    'count', count(*),
    'rows', coalesce(jsonb_agg(jsonb_build_object(
      'document_id', document_id, 'title', title, 'score', score,
      'extraction_pipeline_version', extraction_pipeline_version
    )), '[]'::jsonb)
  ) into results from hits;

  result_hash := encode(extensions.digest(results::text, 'sha256'), 'hex');

  update public.saved_queries set
    last_run_at = now(),
    last_result_hash = result_hash,
    last_result_count = (results->>'count')::int,
    updated_at = now()
  where id = _saved_query_id;

  return jsonb_build_object(
    'saved_query_id', _saved_query_id,
    'result_hash', result_hash,
    'results', results
  );
end;
$$;

revoke execute on function public.create_saved_query(text, text, jsonb, text, boolean, jsonb) from anon, public;
revoke execute on function public.update_saved_query(uuid, jsonb, jsonb) from anon, public;
revoke execute on function public.delete_saved_query(uuid, jsonb) from anon, public;
revoke execute on function public.run_saved_query(uuid, jsonb) from anon, public;

grant execute on function public.create_saved_query(text, text, jsonb, text, boolean, jsonb) to authenticated, service_role;
grant execute on function public.update_saved_query(uuid, jsonb, jsonb) to authenticated;
grant execute on function public.delete_saved_query(uuid, jsonb) to authenticated;
grant execute on function public.run_saved_query(uuid, jsonb) to authenticated, service_role;
```

- [ ] **Step 2: Test PASA**

```bash
npm run test:db -- supabase/tests/20260601091000_saved_queries_test.sql
```

Expected: 11/11 ok.

- [ ] **Step 3: Suite + types + commit**

```bash
npm run test:db
npm run types:gen
git add supabase/migrations/20260601091000_saved_queries.sql \
        supabase/tests/20260601091000_saved_queries_test.sql \
        lib/supabase/types.gen.ts
git commit -m "feat(db): tier2 049.a saved_queries + rpcs + run_saved_query"
```

### Task 12.3: Validator jsonschema para `saved_queries.filters`

**Files:**
- Create: `supabase/migrations/20260601091050_saved_queries_filters_validator.sql`
- Create: `supabase/tests/saved_queries_filters_validator_test.sql`

**Contexto**: `saved_queries.filters jsonb` define el alcance de la búsqueda (workspace_ids, collection_ids, tag slugs, fecha, kinds). Sin schema, un cliente con bug puede meter una lista anidada o un string donde debe ir array de UUIDs y romper `run_saved_query`. JSON Schema lock-in.

- [ ] **Step 1: pgTAP test**

```sql
-- supabase/tests/saved_queries_filters_validator_test.sql
BEGIN;
SELECT plan(5);

insert into public.tenants (id, slug, name)
values ('00000000-0000-0000-0000-000000012301','sqf-tenant','SQF Tenant');
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000012311','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','sqf@sqf.test',now(),'{}'::jsonb,'{}'::jsonb,now(),now());
insert into public.users (id, tenant_id, email, role, status)
values ('00000000-0000-0000-0000-000000012311','00000000-0000-0000-0000-000000012301',
  'sqf@sqf.test','member','active');

-- Valido
SELECT lives_ok(
  $$ insert into public.saved_queries
       (tenant_id, user_id, name, query, filters, notify_on_new_results)
     values ('00000000-0000-0000-0000-000000012301','00000000-0000-0000-0000-000000012311',
             'Normativa','normativa fiscal',
             '{"workspace_ids":["00000000-0000-0000-0000-000000000001"],"kinds":["document"]}'::jsonb,
             true) $$,
  'filters con workspace_ids y kinds pasa CHECK');

-- Tipo invalido — workspace_ids debe ser array de strings (UUID format)
SELECT throws_ok(
  $$ insert into public.saved_queries
       (tenant_id, user_id, name, query, filters, notify_on_new_results)
     values ('00000000-0000-0000-0000-000000012301','00000000-0000-0000-0000-000000012311',
             'Bad','bad',
             '{"workspace_ids":"not-an-array"}'::jsonb, true) $$,
  '23514', null,
  'workspace_ids como string falla');

-- Campo extra no permitido
SELECT throws_ok(
  $$ insert into public.saved_queries
       (tenant_id, user_id, name, query, filters, notify_on_new_results)
     values ('00000000-0000-0000-0000-000000012301','00000000-0000-0000-0000-000000012311',
             'Bad2','bad',
             '{"unknown_field":"x"}'::jsonb, true) $$,
  '23514', null,
  'campo extra falla CHECK');

-- Filters vacio permitido (todos los docs del tenant)
SELECT lives_ok(
  $$ insert into public.saved_queries
       (tenant_id, user_id, name, query, filters, notify_on_new_results)
     values ('00000000-0000-0000-0000-000000012301','00000000-0000-0000-0000-000000012311',
             'AllDocs','*', '{}'::jsonb, false) $$,
  'filters {} pasa CHECK');

-- date_after valido (ISO 8601)
SELECT lives_ok(
  $$ insert into public.saved_queries
       (tenant_id, user_id, name, query, filters, notify_on_new_results)
     values ('00000000-0000-0000-0000-000000012301','00000000-0000-0000-0000-000000012311',
             'Recent','recent',
             '{"date_after":"2026-01-01T00:00:00Z"}'::jsonb, false) $$,
  'date_after ISO pasa CHECK');

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Migración**

```sql
-- supabase/migrations/20260601091050_saved_queries_filters_validator.sql
-- CHECK constraint sobre saved_queries.filters via pg_jsonschema.

alter table public.saved_queries
  add constraint saved_queries_filters_schema_chk
  check (
    app.validate_jsonschema(
      filters,
      jsonb_build_object(
        'type', 'object',
        'additionalProperties', false,
        'properties', jsonb_build_object(
          'workspace_ids', jsonb_build_object(
            'type','array',
            'items', jsonb_build_object('type','string','format','uuid')
          ),
          'collection_ids', jsonb_build_object(
            'type','array',
            'items', jsonb_build_object('type','string','format','uuid')
          ),
          'tag_slugs', jsonb_build_object(
            'type','array',
            'items', jsonb_build_object('type','string','minLength',1)
          ),
          'kinds', jsonb_build_object(
            'type','array',
            'items', jsonb_build_object(
              'type','string',
              'enum', jsonb_build_array('document','chunk','annotation')
            )
          ),
          'date_after', jsonb_build_object('type','string','format','date-time'),
          'date_before', jsonb_build_object('type','string','format','date-time'),
          'mode', jsonb_build_object(
            'type','string',
            'enum', jsonb_build_array('fts','trigram','embedding','hybrid')
          )
        )
      )
    )
  );

comment on constraint saved_queries_filters_schema_chk
  on public.saved_queries is
  'JSON Schema: workspace_ids/collection_ids arrays de UUID, kinds enum, dates ISO 8601, mode enum.';
```

- [ ] **Step 3: Aplicar + correr test**

```bash
supabase db push
npm run test:db -- --test supabase/tests/saved_queries_filters_validator_test.sql
```

Expected: 5/5 pasan.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260601091050_saved_queries_filters_validator.sql supabase/tests/saved_queries_filters_validator_test.sql
git commit -m "feat(db): jsonschema validator para saved_queries.filters"
```

---

## Paso 13 · Migracion 049.b · `audit_log` enriquecido

Item 19. `session_id uuid` + `workspace_id uuid` con indices parciales.

### Task 13.1: Test pgTAP

**Files:**
- Create: `supabase/tests/20260601091100_audit_log_enriched_test.sql`

- [ ] **Step 1: Escribir test**

```sql
BEGIN;
SELECT plan(6);

SELECT has_column('public','audit_log','session_id','session_id agregado');
SELECT has_column('public','audit_log','workspace_id','workspace_id agregado');
SELECT col_type_is('public','audit_log','session_id','uuid','session_id uuid');
SELECT col_type_is('public','audit_log','workspace_id','uuid','workspace_id uuid');

SELECT ok(
  exists (select 1 from pg_indexes
          where schemaname='public' and tablename='audit_log'
            and indexname = 'audit_log_session_idx'),
  'index audit_log_session_idx existe');

SELECT ok(
  exists (select 1 from pg_indexes
          where schemaname='public' and tablename='audit_log'
            and indexname = 'audit_log_workspace_idx'),
  'index audit_log_workspace_idx existe');

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Test FAILA**

```bash
npm run test:db -- supabase/tests/20260601091100_audit_log_enriched_test.sql 2>&1 | head -10
```

### Task 13.2: Migracion 049.b

**Files:**
- Create: `supabase/migrations/20260601091100_audit_log_enriched.sql`

- [ ] **Step 1: Escribir migracion**

```sql
-- Tier 2 · Migracion 049.b
-- Item 19: audit_log enriquecido con session_id y workspace_id.

alter table public.audit_log
  add column if not exists session_id uuid,
  add column if not exists workspace_id uuid;

create index if not exists audit_log_session_idx
  on public.audit_log (tenant_id, session_id) where session_id is not null;
create index if not exists audit_log_workspace_idx
  on public.audit_log (tenant_id, workspace_id, created_at desc)
  where workspace_id is not null;

-- Actualiza el helper app.audit_with_context para extraer session_id y workspace_id
-- del _request_context jsonb. La firma se preserva; solo cambia el body.
create or replace function app.audit_with_context(
  _action text,
  _resource_type text,
  _resource_id uuid,
  _payload jsonb,
  _request_context jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
  current_user_id uuid := auth.uid();
  ctx jsonb := coalesce(_request_context, '{}'::jsonb);
  audit_id uuid;
begin
  -- Tambien soporta context via setting de sesion para los triggers
  -- automatic (`app.request_context`); si _request_context es null
  -- intentamos leer ese setting.
  if _request_context is null then
    begin
      ctx := coalesce(current_setting('app.request_context', true)::jsonb, '{}'::jsonb);
    exception when others then
      ctx := '{}'::jsonb;
    end;
  end if;

  insert into public.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id,
    request_id, ip_address, user_agent, session_id, workspace_id, metadata
  )
  values (
    current_tenant_id, current_user_id, _action, _resource_type, _resource_id,
    nullif(ctx->>'request_id',''),
    nullif(ctx->>'ip','')::inet,
    nullif(ctx->>'user_agent',''),
    nullif(ctx->>'session_id','')::uuid,
    nullif(ctx->>'workspace_id','')::uuid,
    coalesce(_payload, '{}'::jsonb)
  )
  returning id into audit_id;

  return audit_id;
end;
$$;
```

- [ ] **Step 2: Test PASA**

```bash
npm run test:db -- supabase/tests/20260601091100_audit_log_enriched_test.sql
```

Expected: 6/6 ok.

- [ ] **Step 3: Suite + types + commit**

```bash
npm run test:db
npm run types:gen
git add supabase/migrations/20260601091100_audit_log_enriched.sql \
        supabase/tests/20260601091100_audit_log_enriched_test.sql \
        lib/supabase/types.gen.ts
git commit -m "feat(db): tier2 049.b audit_log enriched (session_id, workspace_id)"
```

---

## Paso 14 · Cleanup extension + Annotation broadcast

### Task 14.1: Migracion cleanup retention Tier 2

**Files:**
- Create: `supabase/migrations/20260601091200_cleanup_operational_data_tier2.sql`
- Create: `supabase/tests/20260601091200_cleanup_operational_data_tier2_test.sql`

- [ ] **Step 1: Test pgTAP**

```sql
BEGIN;
SELECT plan(3);

-- La funcion existente cleanup_operational_data tiene signature conocido.
-- Verificamos que esta version acepta los nuevos parametros.
SELECT has_function('public','cleanup_operational_data','cleanup_operational_data existe');

-- Lock-in: el codigo de la funcion menciona notifications y document_views como targets
SELECT ok(
  (select pg_get_functiondef(p.oid))::text like '%notifications%'
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'cleanup_operational_data',
  'cleanup_operational_data ahora purga notifications');

SELECT ok(
  (select pg_get_functiondef(p.oid))::text like '%document_views%'
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'cleanup_operational_data',
  'cleanup_operational_data ahora purga document_views');

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Test FAILA**

```bash
npm run test:db -- supabase/tests/20260601091200_cleanup_operational_data_tier2_test.sql 2>&1 | tail -10
```

- [ ] **Step 3: Escribir migracion extension**

```sql
-- Tier 2 · Cleanup retention extension
-- Extiende cleanup_operational_data para purgar notifications, document_views,
-- y agrega placeholder para data_exports (que viene en Tier 3).
-- Filosofia: el cleanup se acumula en una sola funcion declarativa por simplicidad.

create or replace function public.cleanup_operational_data(
  _audit_log_retention interval default interval '180 days',
  _indexing_events_retention interval default interval '90 days',
  _indexing_health_retention interval default interval '30 days',
  _document_extraction_retention interval default interval '14 days',
  _notifications_retention interval default interval '90 days',
  _document_views_retention interval default interval '180 days',
  _data_exports_retention interval default interval '7 days'
)
returns table (
  audit_log_deleted bigint,
  indexing_events_deleted bigint,
  health_snapshots_deleted bigint,
  extraction_caches_deleted bigint,
  notifications_deleted bigint,
  document_views_deleted bigint,
  data_exports_deleted bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  audit_count bigint := 0;
  events_count bigint := 0;
  health_count bigint := 0;
  extr_count bigint := 0;
  notif_count bigint := 0;
  views_count bigint := 0;
  exports_count bigint := 0;
begin
  with d as (delete from public.audit_log
              where created_at < now() - _audit_log_retention
              returning 1)
  select count(*) into audit_count from d;

  with d as (delete from public.indexing_events
              where created_at < now() - _indexing_events_retention
              returning 1)
  select count(*) into events_count from d;

  if to_regclass('public.indexing_health_snapshots') is not null then
    with d as (delete from public.indexing_health_snapshots
                where captured_at < now() - _indexing_health_retention
                returning 1)
    select count(*) into health_count from d;
  end if;

  if to_regclass('public.document_extractions_cache') is not null then
    with d as (delete from public.document_extractions_cache
                where created_at < now() - _document_extraction_retention
                returning 1)
    select count(*) into extr_count from d;
  end if;

  if to_regclass('public.notifications') is not null then
    with d as (delete from public.notifications
                where created_at < now() - _notifications_retention
                  and (read_at is not null or archived_at is not null)
                returning 1)
    select count(*) into notif_count from d;
  end if;

  if to_regclass('public.document_views') is not null then
    with d as (delete from public.document_views
                where viewed_at < now() - _document_views_retention
                returning 1)
    select count(*) into views_count from d;
  end if;

  -- Placeholder: data_exports llega en Tier 3. Si la tabla existe, purga ready/expired antiguos.
  if to_regclass('public.data_exports') is not null then
    with d as (delete from public.data_exports
                where status in ('ready','expired')
                  and updated_at < now() - _data_exports_retention
                returning 1)
    select count(*) into exports_count from d;
  end if;

  audit_log_deleted := audit_count;
  indexing_events_deleted := events_count;
  health_snapshots_deleted := health_count;
  extraction_caches_deleted := extr_count;
  notifications_deleted := notif_count;
  document_views_deleted := views_count;
  data_exports_deleted := exports_count;
  return next;
end;
$$;

revoke execute on function public.cleanup_operational_data(interval, interval, interval, interval, interval, interval, interval) from anon, public, authenticated;
grant execute on function public.cleanup_operational_data(interval, interval, interval, interval, interval, interval, interval) to service_role;
```

- [ ] **Step 4: Test PASA**

```bash
npm run test:db -- supabase/tests/20260601091200_cleanup_operational_data_tier2_test.sql
```

Expected: 3/3 ok.

- [ ] **Step 5: Suite + commit**

```bash
npm run test:db
git add supabase/migrations/20260601091200_cleanup_operational_data_tier2.sql \
        supabase/tests/20260601091200_cleanup_operational_data_tier2_test.sql
git commit -m "feat(db): tier2 cleanup extended (notifications, document_views, data_exports placeholder)"
```

### Task 14.2: Broadcast annotation realtime + publication tier 2

**Files:**
- Create: `supabase/migrations/20260601091300_realtime_tier2_publications.sql`
- Create: `supabase/tests/20260601091300_realtime_tier2_publications_test.sql`

- [ ] **Step 1: Test pgTAP**

```sql
BEGIN;
SELECT plan(5);

SELECT ok(
  exists (select 1 from pg_publication_tables
          where pubname='supabase_realtime' and tablename='notifications'),
  'notifications publicada');
SELECT ok(
  exists (select 1 from pg_publication_tables
          where pubname='supabase_realtime' and tablename='document_annotations'),
  'document_annotations publicada');
SELECT ok(
  exists (select 1 from pg_publication_tables
          where pubname='supabase_realtime' and tablename='annotation_replies'),
  'annotation_replies publicada');
SELECT ok(
  exists (select 1 from pg_publication_tables
          where pubname='supabase_realtime' and tablename='document_issues'),
  'document_issues publicada');
SELECT ok(
  exists (select 1 from pg_trigger
          where tgname = 'broadcast_annotation_realtime_insert'),
  'broadcast_annotation_realtime_insert trigger instalado');

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Test FAILA**

```bash
npm run test:db -- supabase/tests/20260601091300_realtime_tier2_publications_test.sql 2>&1 | head -10
```

- [ ] **Step 3: Escribir migracion**

```sql
-- Tier 2 · Realtime publications + broadcast annotation trigger
-- broadcast_annotation_realtime_insert emite al topic del workspace.
-- Las tablas relevantes ya estan publicadas por sus respectivas migraciones (idempotente).

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname='supabase_realtime' and schemaname='public' and tablename='document_annotations'
    ) then
      execute 'alter publication supabase_realtime add table public.document_annotations';
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname='supabase_realtime' and schemaname='public' and tablename='annotation_replies'
    ) then
      execute 'alter publication supabase_realtime add table public.annotation_replies';
    end if;
  end if;
end;
$$;

create or replace function app.broadcast_annotation_realtime_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  doc_row public.documents%rowtype;
  payload jsonb;
  topic text;
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then
    return null;
  end if;

  select d.* into doc_row from public.documents d where d.id = new.document_id;
  if doc_row.workspace_id is null then return null; end if;

  payload := jsonb_build_object(
    'annotation_id', new.id,
    'document_id', new.document_id,
    'author_id', new.author_id,
    'kind', new.kind,
    'visibility', new.visibility,
    'created_at', new.created_at
  );
  topic := 'tenant:' || new.tenant_id::text || ':workspace:' || doc_row.workspace_id::text || ':annotations';

  perform realtime.send(payload, 'annotation_inserted', topic, true);
  return null;
end;
$$;

drop trigger if exists broadcast_annotation_realtime_insert on public.document_annotations;
create trigger broadcast_annotation_realtime_insert
after insert on public.document_annotations
for each row execute function app.broadcast_annotation_realtime_insert();
```

- [ ] **Step 4: Test PASA**

```bash
npm run test:db -- supabase/tests/20260601091300_realtime_tier2_publications_test.sql
```

Expected: 5/5 ok.

- [ ] **Step 5: Suite + commit**

```bash
npm run test:db
git add supabase/migrations/20260601091300_realtime_tier2_publications.sql \
        supabase/tests/20260601091300_realtime_tier2_publications_test.sql
git commit -m "feat(db): tier2 realtime publications + broadcast_annotation trigger"
```

---

## Paso 15 · Test integracion share_conversation → consume_shared_link_token

### Task 15.1: Test pgTAP integracion

**Files:**
- Create: `supabase/tests/20260601091400_share_conversation_integration_test.sql`

- [ ] **Step 1: Escribir test integracion**

```sql
BEGIN;
SELECT plan(8);

insert into public.tenants (id, slug, name)
values ('00000000-0000-0000-0000-000000013001','share-conv-alpha','SC Alpha');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000013011','00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','sharer@sc-alpha.test',now(),
   '{"provider":"email"}'::jsonb,'{}'::jsonb,now(),now()),
  ('00000000-0000-0000-0000-000000013012','00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','viewer@sc-alpha.test',now(),
   '{"provider":"email"}'::jsonb,'{}'::jsonb,now(),now());

insert into public.users (id, tenant_id, email, display_name, role, status) values
  ('00000000-0000-0000-0000-000000013011','00000000-0000-0000-0000-000000013001','sharer@sc-alpha.test','Sharer','owner','active'),
  ('00000000-0000-0000-0000-000000013012','00000000-0000-0000-0000-000000013001','viewer@sc-alpha.test','Viewer','member','active');

insert into public.workspaces (id, tenant_id, slug, name, status)
values ('00000000-0000-0000-0000-000000013101','00000000-0000-0000-0000-000000013001','default','Default','active');
insert into public.workspace_memberships (workspace_id, tenant_id, principal_kind, principal_id, role) values
  ('00000000-0000-0000-0000-000000013101','00000000-0000-0000-0000-000000013001','user','00000000-0000-0000-0000-000000013011','workspace_admin');

insert into public.conversations (id, tenant_id, user_id, title)
values ('00000000-0000-0000-0000-000000013031','00000000-0000-0000-0000-000000013001',
        '00000000-0000-0000-0000-000000013011','My convo');

-- sharer share_conversation con token
select set_config('request.jwt.claims', jsonb_build_object(
  'sub','00000000-0000-0000-0000-000000013011',
  'role','authenticated',
  'tenant_id','00000000-0000-0000-0000-000000013001',
  'tenant_role','owner',
  'active_workspace_id','00000000-0000-0000-0000-000000013101'
)::text, true);
set local role authenticated;

SELECT lives_ok(
  $$ select public.share_conversation(
       '00000000-0000-0000-0000-000000013031'::uuid,
       'tenant_with_token'::public.shared_link_audience,
       '{}'::jsonb,
       'mira esto'
     ) $$,
  'share_conversation con token OK');

SELECT is(
  (select count(*)::int from public.shared_links
   where target_kind='conversation' and target_id='00000000-0000-0000-0000-000000013031'),
  1, '1 shared_link creado');

-- Para testear consume necesitamos el token raw. Como create_shared_link lo retorna,
-- en este test extraemos via create_shared_link directo (no share_conversation que envuelve).
DO $$
DECLARE
  shared_id uuid;
  raw_token text;
BEGIN
  select id, token into shared_id, raw_token
    from public.create_shared_link(
      'conversation'::public.shared_link_target_kind,
      '00000000-0000-0000-0000-000000013031'::uuid,
      'tenant_with_token'::public.shared_link_audience,
      '{}'::jsonb, 'token directo', null, null
    );
  perform set_config('test.shared_id', shared_id::text, true);
  perform set_config('test.raw_token', raw_token, true);
END $$;

SELECT ok(
  current_setting('test.raw_token', true) is not null
  and current_setting('test.raw_token', true) <> '',
  'create_shared_link devuelve token raw');

-- Otro user del mismo tenant consume el token
reset role;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub','00000000-0000-0000-0000-000000013012',
  'role','authenticated',
  'tenant_id','00000000-0000-0000-0000-000000013001',
  'tenant_role','member'
)::text, true);
set local role authenticated;

SELECT lives_ok(
  $$ select public.consume_shared_link_token(current_setting('test.raw_token', true)) $$,
  'viewer del mismo tenant puede consume_shared_link_token');

-- consume_shared_link_token NO transfiere permisos: el viewer sigue sin poder ver
-- la conversation si no es de su propiedad (RLS de conversations).
SELECT is(
  (select count(*)::int from public.conversations
   where id = '00000000-0000-0000-0000-000000013031'),
  0,
  'consume NO transfiere acceso a la conversation (RLS sigue aplicando)');

-- audit_log captura el consume
SELECT ok(
  exists (select 1 from public.audit_log
          where action = 'shared_link.consumed'),
  'audit captura shared_link.consumed');

-- Token invalido / mal formado falla
SELECT throws_ok(
  $$ select public.consume_shared_link_token('definitely-not-a-real-token') $$,
  'Invalid or expired token',
  'token inexistente falla con mensaje claro');

-- Token cross-tenant no funciona
reset role;
SELECT throws_ok(
  $$ select public.consume_shared_link_token(current_setting('test.raw_token', true)) $$,
  'Tenant claim is required',
  'sin JWT no consume');

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Correr test**

```bash
npm run test:db -- supabase/tests/20260601091400_share_conversation_integration_test.sql
```

Expected: 8/8 ok.

- [ ] **Step 3: Suite + commit**

```bash
npm run test:db
git add supabase/tests/20260601091400_share_conversation_integration_test.sql
git commit -m "test(db): tier2 integration share_conversation + consume_shared_link_token"
```

---

## Paso 16 · Worker Inngest `run-saved-queries`

Worker cron cada 10 min. Recorre `saved_queries` con `schedule_cron`, llama `run_saved_query` via service-role, compara nuevo `result_hash` con `last_result_hash`, dispara notif si cambia.

### Task 16.1: Setup tests dir si no existe + test scaffold

**Files:**
- Verify: `inngest/__tests__/` (crear si no existe)
- Create: `inngest/__tests__/run-saved-queries.test.ts`

- [ ] **Step 1: Verificar estructura**

```bash
ls inngest/__tests__/ 2>/dev/null || mkdir -p inngest/__tests__
ls inngest/__tests__/
```

Si esta vacio, agregar entrada `test:inngest` al `package.json`:

- [ ] **Step 2: Agregar script `test:inngest` al package.json**

Editar `package.json` y agregar dentro de `scripts`:

```json
"test:inngest": "node --test --import tsx 'inngest/__tests__/*.test.ts'"
```

Si `tsx` no esta instalado:

```bash
npm install --save-dev tsx
```

Commit del package.json:

```bash
git add package.json package-lock.json
git commit -m "chore(inngest): add test:inngest script + tsx dev dep"
```

- [ ] **Step 3: Escribir test del worker**

```typescript
// inngest/__tests__/run-saved-queries.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateSavedQueries,
  shouldRunNow,
  diffHash,
  type SavedQueryRow,
  type RunResult
} from "../functions/run-saved-queries.js";

test("shouldRunNow: schedule_cron null => skip", () => {
  const row: SavedQueryRow = {
    id: "1", tenant_id: "t", user_id: "u",
    query: "test", filters: {}, schedule_cron: null,
    notify_on_new_results: true, last_run_at: null,
    last_result_hash: null, last_result_count: null
  };
  assert.equal(shouldRunNow(row, new Date()), false);
});

test("shouldRunNow: schedule_cron */10 + last_run_at hace 11min => run", () => {
  const row: SavedQueryRow = {
    id: "1", tenant_id: "t", user_id: "u",
    query: "test", filters: {}, schedule_cron: "*/10 * * * *",
    notify_on_new_results: true,
    last_run_at: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
    last_result_hash: "abc", last_result_count: 1
  };
  assert.equal(shouldRunNow(row, new Date()), true);
});

test("shouldRunNow: schedule_cron */10 + last_run_at hace 2min => skip", () => {
  const row: SavedQueryRow = {
    id: "1", tenant_id: "t", user_id: "u",
    query: "test", filters: {}, schedule_cron: "*/10 * * * *",
    notify_on_new_results: true,
    last_run_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    last_result_hash: "abc", last_result_count: 1
  };
  assert.equal(shouldRunNow(row, new Date()), false);
});

test("diffHash: hash diferente => true", () => {
  assert.equal(diffHash("abc", "def"), true);
});

test("diffHash: hash igual => false", () => {
  assert.equal(diffHash("abc", "abc"), false);
});

test("diffHash: previous null + current valido => true (primer run con resultados)", () => {
  assert.equal(diffHash(null, "abc"), true);
});

test("evaluateSavedQueries: dispara notif solo cuando hash cambio Y notify_on_new_results=true", () => {
  const rows: SavedQueryRow[] = [
    {
      id: "1", tenant_id: "t", user_id: "u",
      query: "q", filters: {}, schedule_cron: "*/10 * * * *",
      notify_on_new_results: true,
      last_run_at: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
      last_result_hash: "old", last_result_count: 1
    }
  ];
  const runResults: Record<string, RunResult> = {
    "1": { saved_query_id: "1", result_hash: "new", count: 2 }
  };
  const decisions = evaluateSavedQueries(rows, runResults);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].notify, true);
  assert.equal(decisions[0].saved_query_id, "1");
});

test("evaluateSavedQueries: hash igual => no notif", () => {
  const rows: SavedQueryRow[] = [
    {
      id: "1", tenant_id: "t", user_id: "u",
      query: "q", filters: {}, schedule_cron: "*/10 * * * *",
      notify_on_new_results: true,
      last_run_at: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
      last_result_hash: "same", last_result_count: 1
    }
  ];
  const runResults: Record<string, RunResult> = {
    "1": { saved_query_id: "1", result_hash: "same", count: 1 }
  };
  const decisions = evaluateSavedQueries(rows, runResults);
  assert.equal(decisions[0].notify, false);
});

test("evaluateSavedQueries: notify_on_new_results=false => nunca notif", () => {
  const rows: SavedQueryRow[] = [
    {
      id: "1", tenant_id: "t", user_id: "u",
      query: "q", filters: {}, schedule_cron: "*/10 * * * *",
      notify_on_new_results: false,
      last_run_at: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
      last_result_hash: "old", last_result_count: 1
    }
  ];
  const runResults: Record<string, RunResult> = {
    "1": { saved_query_id: "1", result_hash: "new", count: 2 }
  };
  const decisions = evaluateSavedQueries(rows, runResults);
  assert.equal(decisions[0].notify, false);
});
```

- [ ] **Step 4: Test FAILA (modulo no existe)**

```bash
npm run test:inngest 2>&1 | head -20
```

Expected: error de import `Cannot find module '../functions/run-saved-queries.js'`.

### Task 16.2: Implementar worker `run-saved-queries`

**Files:**
- Create: `inngest/functions/run-saved-queries.ts`

- [ ] **Step 1: Escribir el worker con helpers puros exportados**

```typescript
import { cron } from "inngest";

import { inngest } from "@/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";

export type SavedQueryRow = {
  id: string;
  tenant_id: string;
  user_id: string;
  query: string;
  filters: Record<string, unknown>;
  schedule_cron: string | null;
  notify_on_new_results: boolean;
  last_run_at: string | null;
  last_result_hash: string | null;
  last_result_count: number | null;
};

export type RunResult = {
  saved_query_id: string;
  result_hash: string;
  count: number;
};

export type Decision = {
  saved_query_id: string;
  tenant_id: string;
  user_id: string;
  notify: boolean;
  new_count: number;
  previous_count: number | null;
};

// Helper puro: decide si la fila esta lista para correr ahora.
// MVP: schedule_cron != null AND (last_run_at null OR (now - last_run_at) >= 9 min).
// Para soporte completo de cron-expressions, integrar `cron-parser` cuando aparezca el caso.
export function shouldRunNow(row: SavedQueryRow, now: Date): boolean {
  if (!row.schedule_cron) return false;
  if (!row.last_run_at) return true;
  const elapsed = now.getTime() - new Date(row.last_run_at).getTime();
  // Buffer de 1 min para alinear con cron cada 10 min sin perder ciclos.
  const MINIMUM_INTERVAL_MS = 9 * 60 * 1000;
  return elapsed >= MINIMUM_INTERVAL_MS;
}

// Helper puro: compara hashes.
export function diffHash(previous: string | null, current: string | null): boolean {
  if (current === null) return false;
  if (previous === null) return true;
  return previous !== current;
}

// Helper puro: dado las filas y los resultados de cada run, decide notificaciones.
export function evaluateSavedQueries(
  rows: SavedQueryRow[],
  results: Record<string, RunResult>
): Decision[] {
  return rows
    .filter((row) => results[row.id])
    .map((row) => {
      const result = results[row.id];
      const hashChanged = diffHash(row.last_result_hash, result.result_hash);
      return {
        saved_query_id: row.id,
        tenant_id: row.tenant_id,
        user_id: row.user_id,
        notify: hashChanged && row.notify_on_new_results,
        new_count: result.count,
        previous_count: row.last_result_count
      };
    });
}

async function loadScheduledSavedQueries(): Promise<SavedQueryRow[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("saved_queries")
    .select("id, tenant_id, user_id, query, filters, schedule_cron, notify_on_new_results, last_run_at, last_result_hash, last_result_count")
    .not("schedule_cron", "is", null)
    .is("deleted_at", null)
    .limit(500)
    .returns<SavedQueryRow[]>();
  if (error) throw error;
  return data ?? [];
}

async function runOneSavedQuery(row: SavedQueryRow): Promise<RunResult | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("run_saved_query", {
    _saved_query_id: row.id
  });
  if (error) {
    console.error("run_saved_query failed", { id: row.id, error });
    return null;
  }
  if (!data) return null;
  const payload = data as { saved_query_id: string; result_hash: string; results: { count: number } };
  return {
    saved_query_id: payload.saved_query_id,
    result_hash: payload.result_hash,
    count: payload.results?.count ?? 0
  };
}

async function insertNotification(decision: Decision): Promise<void> {
  const supabase = createAdminClient();
  await supabase.from("notifications").insert({
    tenant_id: decision.tenant_id,
    user_id: decision.user_id,
    kind: "saved_query.new_results",
    title: "Nuevos resultados en tu busqueda guardada",
    body: `${decision.new_count} resultados (antes ${decision.previous_count ?? 0})`,
    target_kind: "saved_query",
    target_id: decision.saved_query_id,
    source_id: decision.saved_query_id,
    url: `/saved-queries/${decision.saved_query_id}`,
    metadata: {
      new_count: decision.new_count,
      previous_count: decision.previous_count
    }
  });
}

export const runSavedQueries = inngest.createFunction(
  {
    concurrency: { key: '"sda-saved-queries"', limit: 1, scope: "env" },
    id: "run-saved-queries",
    name: "Run Saved Queries",
    retries: 2,
    triggers: [cron(process.env.SAVED_QUERIES_CRON ?? "*/10 * * * *")]
  },
  async ({ step }) => {
    const now = new Date();
    const candidates = await step.run("load-saved-queries", loadScheduledSavedQueries);
    const eligible = candidates.filter((row) => shouldRunNow(row, now));

    const runResults: Record<string, RunResult> = {};
    for (const row of eligible) {
      const result = await step.run(`run-${row.id}`, () => runOneSavedQuery(row));
      if (result) runResults[row.id] = result;
    }

    const decisions = evaluateSavedQueries(eligible, runResults);
    const toNotify = decisions.filter((d) => d.notify);

    for (const decision of toNotify) {
      await step.run(`notify-${decision.saved_query_id}`, () => insertNotification(decision));
    }

    return {
      candidates: candidates.length,
      eligible: eligible.length,
      ran: Object.keys(runResults).length,
      notified: toNotify.length
    };
  }
);
```

- [ ] **Step 2: Registrar el worker en el inngest endpoint**

```bash
grep -rn "process-document-index\|reconcile-document-indexing\|record-tree-graph-event" app/api/inngest 2>/dev/null
```

Editar `app/api/inngest/route.ts` (o donde se registren) y agregar `runSavedQueries` al `functions: [...]`. Confirmar import.

```typescript
// app/api/inngest/route.ts (snippet)
import { runSavedQueries } from "@/inngest/functions/run-saved-queries";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    /* otras funciones... */
    runSavedQueries
  ]
});
```

- [ ] **Step 3: Test PASA**

```bash
npm run test:inngest
```

Expected: 9/9 tests OK.

- [ ] **Step 4: Typecheck + commit**

```bash
npm run typecheck
git add inngest/functions/run-saved-queries.ts \
        inngest/__tests__/run-saved-queries.test.ts \
        app/api/inngest/route.ts
git commit -m "feat(inngest): run-saved-queries worker (cron 10min) + node --test"
```

### Task 16.3: Audit uso real de índices `pg_trgm` y FTS (gate para Tier 4)

**Files:**
- Modify: `docs/superpowers/plans/_evidence/2026-05-24-uuid-ossp-pg-trgm-audit.md`

**Contexto**: después de 2 semanas de Paso 3.b en producción, medir si los índices `chunks_content_trgm_idx` y `chunks_content_tsv_tenant_gin_idx` se usan. Si no, candidatos a remover en Tier 4.

- [ ] **Step 1: Query de uso real**

```bash
psql "$SUPABASE_DB_URL" <<'SQL'
select
  indexrelname as index,
  idx_scan,
  pg_size_pretty(pg_relation_size(indexrelid)) as size,
  case
    when idx_scan = 0 then 'CANDIDATO_REMOVER'
    when idx_scan < 100 then 'BAJO_USO'
    else 'USO_NORMAL'
  end as status
from pg_stat_user_indexes
where indexrelname in (
  'chunks_content_trgm_idx',
  'chunks_content_tsv_tenant_gin_idx'
)
order by idx_scan asc;
SQL
```

Expected: para que sea útil, este step se corre **2+ semanas después** del deploy de Paso 3.b en producción. Antes solo da ruido.

- [ ] **Step 2: Actualizar `2026-05-24-uuid-ossp-pg-trgm-audit.md`**

Agregar sección al final:

```markdown
## Re-audit post-Tier 2 Paso 16 (fecha: <ISO>)

| Índice | idx_scan | tamaño | status | decisión Tier 4 |
|---|---:|---|---|---|
| chunks_content_trgm_idx | <N> | <X> | <status> | <keep/remove> |
| chunks_content_tsv_tenant_gin_idx | <N> | <X> | <status> | <keep/remove> |

Si CANDIDATO_REMOVER: abrir mini-plan "Tier 4 cleanup pg_trgm/FTS".
Si BAJO_USO: dejar 2 semanas más y re-medir.
Si USO_NORMAL: cerrar audit, marcar resolved.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/_evidence/2026-05-24-uuid-ossp-pg-trgm-audit.md
git commit -m "docs(db): re-audit pg_trgm/FTS index usage post-Tier 2 Paso 16"
```

---

## Paso 17 · Documentacion

### Task 17.1: `docs/backend/15-notifications.md` (nuevo)

**Files:**
- Create: `docs/backend/15-notifications.md`

- [ ] **Step 1: Escribir doc completo**

Contenido (estructura sugerida, ~250 lineas):

1. **Resumen**: notifications es persistent log; preferences afecta solo emision externa.
2. **Tipos** (`notification_kind` enum) con descripcion de cada uno.
3. **Canales** (`notification_channel`: in_app, email).
4. **Preferences** (digest realtime/off, enabled, kind+channel).
5. **Triggers DB-side**: tabla con cada trigger y de donde sale.
   - `notify_shared_link_received` ← `shared_links` insert
   - `notify_annotation_reply` ← `annotation_replies` insert
   - `notify_document_issue_assigned` ← `document_issues` insert/update assignee_id
   - `notify_document_issue_resolved` ← `document_issues` update status='resolved'
   - `notify_access_request_received` ← `access_requests` insert
   - `notify_access_request_decided` ← `access_requests` update status
6. **Workers**:
   - `run-saved-queries` inserta `saved_query.new_results`.
   - Tier 3 va a agregar `usage.threshold_crossed` y `agent_task.due_soon` (diferido).
7. **Realtime delivery**:
   - Insert dispara `broadcast_notification_realtime_insert`.
   - Topic privado por user: `tenant:<tenant_id>:user:<user_id>:inbox`.
   - Validation via `app.is_allowed_realtime_topic` con check de tenant + auth.uid().
8. **Frontend integration**:
   - Subscribir via `supabase.channel('tenant:.../inbox')`.
   - Llamar `mark_notification_read(id)` o `mark_notifications_read_bulk(ids[])`.
   - `update_notification_preferences(kind, channel, enabled, digest)`.
9. **Retention**: 90 dias via `cleanup_operational_data`.
10. **Invariante critica**: la fila DB se inserta SIEMPRE. `preferences.enabled` controla solo si el toast/email se emite; la inbox siempre tiene el evento.

- [ ] **Step 2: Commit**

```bash
git add docs/backend/15-notifications.md
git commit -m "docs(backend): tier2 15-notifications (tipos, canales, triggers, realtime)"
```

### Task 17.2: `docs/backend/18-search-rpcs.md` (nuevo)

**Files:**
- Create: `docs/backend/18-search-rpcs.md`

- [ ] **Step 1: Escribir doc**

Contenido sugerido:

1. **Resumen**: 5 RPCs para search/navigation/evidence, todas security definer + user_can_read_document.
2. **`search_documents(_query, _filters, _limit)`**:
   - Modos: full text simple + trigram fallback.
   - Filtros canonicos: `workspace_ids`, `collection_ids`, `tag_ids`, `date_range`.
3. **`search_chunks(_query, _filters, _mode)`**:
   - Modos: `fts`, `trigram`, `embedding`, `hybrid`.
   - Filtros: `workspace_ids`, `document_ids`.
   - Retorna `score` segun el modo.
4. **`search_tree_nodes_by_embedding(_embedding, _filters, _limit)`**:
   - Usa HNSW sobre `doc_tree_nodes.embedding`.
   - Filtros: `workspace_ids`, `document_ids`.
5. **`navigate_tree(_node_id, _direction)`**:
   - direction: `children`, `parent`, `siblings`.
   - Implementacion via `ltree` `path`.
6. **`get_document_evidence(_document_id, _node_id?, _page_start?, _page_end?)`**:
   - Retorna `content`, `page`, `bbox`, `node_id`, `chunk_id`.
   - Maximum 200 rows; pedir chunks especificos con filtros.
7. **Filtros JSON canonicos**: ejemplo de `_filters`:
   ```json
   {
     "workspace_ids": ["uuid", "uuid"],
     "collection_ids": ["uuid"],
     "tag_ids": ["uuid"],
     "document_ids": ["uuid"],
     "date_range": { "from": "2026-01-01", "to": "2026-05-01" }
   }
   ```
8. **Composicion con `saved_queries`**: `run_saved_query` invoca `search_documents` con el `filters` guardado.

- [ ] **Step 2: Commit**

```bash
git add docs/backend/18-search-rpcs.md
git commit -m "docs(backend): tier2 18-search-rpcs (catalogo + filtros)"
```

### Task 17.3: `docs/backend/20-document-lineage-and-versioning.md` (nuevo)

**Files:**
- Create: `docs/backend/20-document-lineage-and-versioning.md`

- [ ] **Step 1: Escribir doc**

Contenido sugerido:

1. **Resumen**: `document_lineage` vincula version a predecesor. Denormaliza title/filename/indexed_at para sobrevivir hard-delete del predecesor.
2. **Modelo**: PK `document_id`. FK doble: el actual `on delete cascade`, el predecesor `on delete set null`.
3. **`link_document_version(_document_id, _predecessor_document_id, _label, _effective_from)`**:
   - Permisos: workspace_admin del workspace del doc actual o tenant admin.
   - Marca el predecesor como `superseded_at = now()` en su propia fila si tiene una.
4. **Vista `document_lineage_heads`**: filas vivas (no superseded, no deleted).
5. **Agente y retrieval**:
   - Default: agente prefiere `latest_version` (heads).
   - Override: `_filters.include_superseded = true` en `search_documents` para incluir historicas (no implementado en Tier 2; cuando se necesite agregar).
6. **Cuando crear lineage**:
   - Mover/reemplazar policy 2025 → 2026 con `link_document_version(new_id, old_id)`.
   - Bulk-update no crea lineage automatico (decision LEAN).
7. **Gotchas**:
   - Lineage cross-workspace NO permitido por decision de spec (validar visibilidad).
   - Si `link_document_version` se llama dos veces para el mismo doc actual, el segundo update reemplaza al primero.

- [ ] **Step 2: Commit**

```bash
git add docs/backend/20-document-lineage-and-versioning.md
git commit -m "docs(backend): tier2 20-document-lineage-and-versioning"
```

### Task 17.4: Actualizar `docs/backend/04-indexacion-inngest.md`

**Files:**
- Modify: `docs/backend/04-indexacion-inngest.md`

- [ ] **Step 1: Agregar seccion `run-saved-queries`**

Agregar al final del archivo (o en seccion "Workers"):

```markdown
## Worker `run-saved-queries` (Tier 2)

- Trigger: `cron(process.env.SAVED_QUERIES_CRON ?? "*/10 * * * *")`.
- Concurrency: 1 instancia por env.
- Flujo:
  1. Lee `saved_queries` con `schedule_cron is not null` y `deleted_at is null`.
  2. Filtra los que cumplen `shouldRunNow(row, now)` (>= 9 min desde `last_run_at`).
  3. Llama RPC `public.run_saved_query(id)` con service-role.
  4. Compara `result_hash` con `last_result_hash`.
  5. Si cambio y `notify_on_new_results=true`, inserta `notifications.kind = 'saved_query.new_results'`.
- Tests: `inngest/__tests__/run-saved-queries.test.ts` con helpers puros `shouldRunNow`, `diffHash`, `evaluateSavedQueries`.
- Limitacion conocida: `shouldRunNow` usa intervalo fijo de 9 min. Cron-expressions complejas (ej. `0 9 * * 1`) requieren `cron-parser`; agregar cuando aparezca un user que lo pida.
```

- [ ] **Step 2: Commit**

```bash
git add docs/backend/04-indexacion-inngest.md
git commit -m "docs(backend): 04-indexacion-inngest agrega run-saved-queries"
```

### Task 17.5: Actualizar `docs/backend/06-contratos-frontend.md`

**Files:**
- Modify: `docs/backend/06-contratos-frontend.md`

- [ ] **Step 1: Agregar contratos nuevos**

Anexar secciones con la firma de cada RPC nueva y un snippet de uso en TypeScript:

- `submit_message_feedback`
- `create_bookmark` / `delete_bookmark`
- `create_shared_link` / `revoke_shared_link` / `consume_shared_link_token` / `share_conversation`
- `create_annotation` / `update_annotation` / `reply_annotation` / `resolve_annotation`
- `mark_notification_read` / `mark_notifications_read_bulk` / `update_notification_preferences`
- `record_document_view`
- `report_document_issue` / `update_document_issue` / `assign_document_issue` / `resolve_document_issue`
- `link_document_version`
- `request_access` / `decide_access_request` / `withdraw_access_request`
- `create_saved_query` / `update_saved_query` / `delete_saved_query` / `run_saved_query`
- `search_documents` / `search_chunks` / `search_tree_nodes_by_embedding` / `navigate_tree` / `get_document_evidence`

Patron por RPC:

```markdown
### `submit_message_feedback`

**RPC**: `public.submit_message_feedback(message_id, kind, comment?, request_context?)`.

**Permisos**: authenticated. Re-submit del mismo `kind` por mismo user hace upsert.

**Uso**:

\`\`\`typescript
await supabase.rpc("submit_message_feedback", {
  _message_id: messageId,
  _kind: "helpful",
  _comment: "muy claro",
  _request_context: { request_id, session_id, workspace_id }
});
\`\`\`
```

- [ ] **Step 2: Commit**

```bash
git add docs/backend/06-contratos-frontend.md
git commit -m "docs(backend): 06-contratos-frontend tier2 rpcs catalog"
```

### Task 17.6: Actualizar `docs/backend/09-catalogo-api-rutas.md`

**Files:**
- Modify: `docs/backend/09-catalogo-api-rutas.md`

- [ ] **Step 1: Agregar las RPCs nuevas**

Anexar al catalogo (tabla con `metodo`, `firma`, `permisos`, `audit_action`). Listar cada RPC del Tier 2.

- [ ] **Step 2: Commit**

```bash
git add docs/backend/09-catalogo-api-rutas.md
git commit -m "docs(backend): 09-catalogo-api-rutas tier2"
```

### Task 17.7: Actualizar `docs/backend/10-supabase-realtime.md`

**Files:**
- Modify: `docs/backend/10-supabase-realtime.md`

- [ ] **Step 1: Agregar nuevos topics + tablas publicadas**

Secciones a anexar:

1. **Nuevas tablas publicadas**: `notifications`, `document_annotations`, `annotation_replies`, `document_issues`.
2. **Nuevos topics privados**:
   - `tenant:<tenant_id>:user:<user_id>:inbox` (Broadcast).
   - `tenant:<tenant_id>:workspace:<workspace_id>:annotations` (Broadcast).
3. **Extension de `app.is_allowed_realtime_topic`**: muestra el SQL.
4. **Triggers Broadcast nuevos**:
   - `broadcast_notification_realtime_insert` → topic `inbox`.
   - `broadcast_annotation_realtime_insert` → topic `annotations`.
5. **Eventos**:
   - `notification_inserted` con payload `{notification_id, kind, title, body, url, target_kind, target_id, created_at}`.
   - `annotation_inserted` con payload `{annotation_id, document_id, author_id, kind, visibility, created_at}`.
6. **Patrones de cliente**: snippet de `useEffect` que subscribe al inbox del user actual.

- [ ] **Step 2: Commit**

```bash
git add docs/backend/10-supabase-realtime.md
git commit -m "docs(backend): 10-supabase-realtime tier2 (inbox topic + annotation topic)"
```

### Task 17.8: Actualizar `CHANGELOG.md`

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Agregar entrada Tier 2**

```markdown
## [Tier 2 Multipliers] - 2026-06-XX

### Added
- `message_feedback`, `message_citations` con RPCs `submit_message_feedback`, `record_message_citations`.
- `user_bookmarks` con RPCs `create_bookmark`, `delete_bookmark`.
- `shared_links` con RPCs `create_shared_link`, `revoke_shared_link`, `consume_shared_link_token`, `share_conversation`. Token hashed con sal por tenant.
- `document_annotations` + `annotation_replies` con RPCs `create_annotation`, `update_annotation`, `reply_annotation`, `resolve_annotation`.
- `notifications` + `notification_preferences` (digest realtime/off). Inbox persistent siempre se llena; preferences afecta canales externos.
- `app.is_allowed_realtime_topic` extendido para topic `tenant:<tenant_id>:user:<user_id>:inbox`.
- Triggers Broadcast: `broadcast_notification_realtime_insert`, `broadcast_annotation_realtime_insert`.
- `document_views` con policy INSERT explicita (`user_id = auth.uid()` + `user_can_read_document`).
- `document_issues` con RPCs y triggers `notify_document_issue_assigned`/`notify_document_issue_resolved`.
- `document_lineage` con campos denormalizados (`predecessor_title`, `predecessor_filename`, `predecessor_indexed_at`) que sobreviven hard-delete.
- `access_requests` (target_kind: workspace, collection — sin document) + triggers `notify_access_request_received`/`notify_access_request_decided`.
- `saved_queries` + worker Inngest `run-saved-queries` (cron `*/10 * * * *`).
- Search RPCs: `search_documents`, `search_chunks`, `search_tree_nodes_by_embedding`, `navigate_tree`, `get_document_evidence`.
- `audit_log.session_id` y `audit_log.workspace_id` con indices parciales.

### Changed
- `cleanup_operational_data` ahora purga `notifications` (90d), `document_views` (180d), `data_exports` (7d placeholder).
- `app.audit_with_context` lee `session_id` y `workspace_id` del `_request_context`.

### Docs
- Nuevos: `15-notifications.md`, `18-search-rpcs.md`, `20-document-lineage-and-versioning.md`.
- Actualizados: `04-indexacion-inngest.md`, `06-contratos-frontend.md`, `09-catalogo-api-rutas.md`, `10-supabase-realtime.md`.

### Deferred
- `agent_tasks` (recomendacion: revisar 4-6 semanas post Tier 2).
- `notification_preferences.digest = 'hourly|daily|weekly'` (cuando exista worker digest).
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): tier2 multipliers"
```

---

## Paso 18 · Validacion end-to-end Tier 2

### Task 18.1: Suite completa local

- [ ] **Step 1: Correr toda la suite**

```bash
npm run lint
npm run typecheck
npm run test:db
npm run test:cli
npm run test:inngest
npm run indexing:health
npm run secrets:scan
```

Expected: TODOS verdes. Si alguno falla, ver el output y fix dirigido.

### Task 18.2: Apply migrations a remoto y types regen

- [ ] **Step 1: Apply via supabase CLI**

```bash
supabase db push
```

Expected: 14 migraciones aplicadas (040, 040.b, 041, 042, 043, 044, 045, 046, 047, 048, 049.a, 049.b, cleanup, realtime).

- [ ] **Step 2: Regenerar types finales**

```bash
npm run types:gen
git diff lib/supabase/types.gen.ts | head -50
```

Si hay diff, commit:

```bash
git add lib/supabase/types.gen.ts
git commit -m "chore(types): regen post tier2"
```

### Task 18.3: Smoke remoto

- [ ] **Step 1: Validar que las tablas Tier 2 existen en remoto**

```bash
psql "$DATABASE_URL" <<'SQL'
select count(*) as tier2_tables
from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'message_feedback','message_citations','user_bookmarks','shared_links',
    'document_annotations','annotation_replies','notifications',
    'notification_preferences','document_views','document_issues',
    'document_lineage','access_requests','saved_queries'
  );
SQL
```

Expected: `tier2_tables = 13`.

- [ ] **Step 2: Validar publication tier 2**

```bash
psql "$DATABASE_URL" -c "
select tablename from pg_publication_tables
where pubname = 'supabase_realtime'
  and tablename in ('notifications','document_annotations','annotation_replies','document_issues')
order by tablename;
"
```

Expected: 4 filas.

- [ ] **Step 3: Validar funciones Tier 2 con permisos correctos**

```bash
psql "$DATABASE_URL" <<'SQL'
select proname, prosrc is not null as has_body
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and proname in (
    'submit_message_feedback','record_message_citations',
    'create_bookmark','delete_bookmark',
    'create_shared_link','revoke_shared_link','consume_shared_link_token','share_conversation',
    'create_annotation','update_annotation','reply_annotation','resolve_annotation',
    'mark_notification_read','mark_notifications_read_bulk','update_notification_preferences',
    'record_document_view',
    'report_document_issue','update_document_issue','assign_document_issue','resolve_document_issue',
    'link_document_version',
    'request_access','decide_access_request','withdraw_access_request',
    'create_saved_query','update_saved_query','delete_saved_query','run_saved_query',
    'search_documents','search_chunks','search_tree_nodes_by_embedding','navigate_tree','get_document_evidence'
  )
order by proname;
SQL
```

Expected: 32 RPCs listadas (verificar conteo).

- [ ] **Step 4: Smoke worker Inngest**

Disparar el worker manualmente desde Inngest UI (o esperar al cron):

```bash
# Si tenes Inngest dev en local
npx inngest-cli@latest dev
# y luego pegarle a la function endpoint
curl -X POST http://localhost:8288/fn/run-saved-queries
```

Expected: response con `{candidates, eligible, ran, notified}`.

### Task 18.4: Bump system version

**Files:**
- Modify: `lib/system-versions.json`

- [ ] **Step 1: Bumpear**

Cambiar `app` a `0.2.0` (minor — Tier 2 es feature grande).

- [ ] **Step 2: Commit**

```bash
git add lib/system-versions.json
git commit -m "chore(versions): bump app to 0.2.0 (tier 2 multipliers)"
```

### Task 18.5: Push y PR

- [ ] **Step 1: Push branch**

```bash
git push -u origin tier2-multipliers
```

- [ ] **Step 2: Crear PR via `gh pr create`**

```bash
gh pr create --title "Tier 2 · Multipliers: feedback, sharing, annotations, notifications, lineage, saved queries" --body "$(cat <<'EOF'
## Summary
- Implementa items 9-19 del spec multitenant (Tier 2).
- 14 migraciones SQL (040 → 049.b + cleanup + realtime).
- 1 worker Inngest: `run-saved-queries` (cron 10 min).
- 3 docs nuevos + 4 actualizados + CHANGELOG.

## Test plan
- [x] `npm run test:db` (todas las pgTAP tier2 + tier1 regresion).
- [x] `npm run test:inngest` (worker run-saved-queries).
- [x] `npm run typecheck` + `npm run lint`.
- [x] `npm run indexing:health` verde.
- [x] `npm run secrets:scan` sin findings.
- [x] `supabase db push` aplica en staging.
- [ ] Smoke E2E: crear conversation, share via token, otro user consume, verifica inbox.
- [ ] Smoke E2E: crear annotation, replicar mention, verifica notif.
EOF
)"
```

---

## Estados de salida Tier 2

Tier 2 cierra cuando:

- [ ] `npm run lint` verde.
- [ ] `npm run typecheck` verde.
- [ ] `npm run test:db` verde (incluye los tests pgTAP de las 14 migraciones tier2 mas todos los tier1).
- [ ] `npm run test:cli` verde.
- [ ] `npm run test:inngest` verde (worker run-saved-queries).
- [ ] `npm run indexing:health` verde.
- [ ] `npm run secrets:scan` sin findings.
- [ ] `supabase db push` exitoso a remoto.
- [ ] `npm run types:gen` correcto y commiteado.
- [ ] `CHANGELOG.md` con entrada Tier 2.
- [ ] Docs nuevos commiteados (`15-notifications.md`, `18-search-rpcs.md`, `20-document-lineage-and-versioning.md`).
- [ ] Docs actualizados commiteados (`04-indexacion-inngest.md`, `06-contratos-frontend.md`, `09-catalogo-api-rutas.md`, `10-supabase-realtime.md`).
- [ ] Smoke remoto: las 13 tablas Tier 2 existen, las 32 RPCs son listables, las 4 publications nuevas estan activas.
- [ ] Worker `run-saved-queries` disparado al menos una vez con response valida.

Cuando todo en verde y la PR mergeada, Tier 2 esta cerrado.

---

## Self-review

Mapeo de cada capacidad del scope a sus tasks/migraciones:

| Capacidad | Migracion | Task(s) | Cubierto |
|---|---|---|---|
| `message_feedback_kind` enum | 040 | 2.2 | si |
| `bookmark_target_kind` enum | 041 | 4.2 | si |
| `shared_link_target_kind` + `shared_link_audience` enums | 042 | 5.2 | si |
| `annotation_kind` + `annotation_visibility` enums | 043 | 6.2 | si |
| `notification_kind` + `notification_channel` enums | 044 | 7.2 | si |
| `document_issue_kind` + `document_issue_status` enums | 046 | 9.2 | si |
| `access_request_target_kind` (solo workspace/collection) + `access_request_status` | 048 | 11.2 | si |
| `message_feedback` (user_id nullable + on delete set null) | 040 | 2.2 (step 1) | si |
| `message_citations` | 040 | 2.2 | si |
| `user_bookmarks` | 041 | 4.2 | si |
| `shared_links` con audience checks | 042 | 5.2 | si |
| `document_annotations` + `annotation_replies` | 043 | 6.2 | si |
| `notifications` + `notification_preferences` (digest realtime/off) | 044 | 7.2 | si |
| `document_views` con policy INSERT explicita | 045 | 8.2 | si |
| `document_issues` | 046 | 9.2 | si |
| `document_lineage` con campos denormalizados | 047 | 10.2 | si |
| `access_requests` (sin target_kind=document) | 048 | 11.2 | si |
| `saved_queries` con `last_result_hash` considerando `extraction_pipeline_version` | 049.a | 12.2 + run_saved_query | si |
| `audit_log.session_id` + `audit_log.workspace_id` | 049.b | 13.2 | si |
| Trigger `notify_annotation_reply` | 043 fn + 044 attach | 6.2 + 7.2 (step 1 attach) | si |
| Trigger `notify_shared_link_received` | 042 fn + 044 attach | 5.2 + 7.2 (step 1 attach) | si |
| Trigger `notify_document_issue_assigned` | 046 | 9.2 | si |
| Trigger `notify_access_request_received` + `notify_access_request_decided` | 048 | 11.2 | si |
| Extension `app.is_allowed_realtime_topic` para topic inbox | 044 | 7.2 (step 1) | si |
| `broadcast_notification_realtime_insert` | 044 | 7.2 | si |
| `broadcast_annotation_realtime_insert` | realtime_tier2 | 14.2 | si |
| RPCs feedback | 040 | 2.2 | si |
| RPCs bookmarks | 041 | 4.2 | si |
| RPCs shared_links incl `share_conversation` | 042 | 5.2 | si |
| RPCs annotations | 043 | 6.2 | si |
| RPCs notifications | 044 | 7.2 | si |
| RPC record_document_view | 045 | 8.2 | si |
| RPCs issues | 046 | 9.2 | si |
| RPC link_document_version (con denormalizacion) | 047 | 10.2 | si |
| RPCs access_requests | 048 | 11.2 | si |
| RPCs saved_queries + run_saved_query | 049.a | 12.2 | si |
| Search RPCs (5) | 040.b | 3.2 | si |
| Worker `run-saved-queries` + test | inngest | 16.1 + 16.2 | si |
| Realtime publication: notifications, annotations, replies, issues | 044/046/realtime_tier2 | varios | si |
| Cleanup extension: notifications 90d, document_views 180d, data_exports placeholder 7d | cleanup_tier2 | 14.1 | si |
| Types regen `npm run types:gen` | — | cada migracion + 18.2 | si |
| Doc `15-notifications.md` | — | 17.1 | si |
| Doc `18-search-rpcs.md` | — | 17.2 | si |
| Doc `20-document-lineage-and-versioning.md` | — | 17.3 | si |
| Doc update `04-indexacion-inngest.md` | — | 17.4 | si |
| Doc update `06-contratos-frontend.md` | — | 17.5 | si |
| Doc update `09-catalogo-api-rutas.md` | — | 17.6 | si |
| Doc update `10-supabase-realtime.md` | — | 17.7 | si |
| Doc CHANGELOG.md | — | 17.8 | si |
| Tests pgTAP por migracion | — | cada Task `<n>.1` | si |
| Test integracion `share_conversation` → `consume_shared_link_token` | — | 15.1 | si |
| Validacion `npm run test:db` post-tier | — | 18.1 | si |
| `supabase db push` + types regen | — | 18.2 | si |
| Smoke remoto + bump version | — | 18.3 + 18.4 | si |

**Cosas explicitamente fuera de scope**:

- `agent_tasks` (diferido en spec).
- Connectors Drive/M365 (Tier 3).
- `usage_records` + Stripe mirror (Tier 3).
- `data_exports` (Tier 3; aca solo placeholder en cleanup).
- Particionado de tablas (Tier 3).
- `halfvec` migration (Tier 3).
- Vistas materializadas top_documents (Tier 3).
- Modos digest `hourly/daily/weekly` para preferences (cuando exista worker digest).

**Riesgos identificados durante la escritura del plan**:

1. **Orden de attach de triggers `notify_*`**: los triggers para `shared_links` y `annotation_replies` se DEFINEN en sus respectivas migraciones (042, 043) pero se ATTACHAN en la 044 porque dependen de que la tabla `notifications` exista. Los tests pgTAP de 042 y 043 que validan inserts en `notifications` van a fallar hasta que 044 corra. El plan lo marca explicitamente en Step 2 de cada Task afectada con la recomendacion de comentar temporalmente y descomentar despues, o aceptar partial-pass.

2. **`extensions.gen_random_bytes` y `extensions.digest`**: dependen de `pgcrypto`. Asumimos que ya esta instalada por Tier 0; si no, agregar `create extension if not exists pgcrypto with schema "extensions"` en la migracion 042 antes del primer uso.

3. **`navigate_tree` y `ltree`**: la implementacion asume que `doc_tree_nodes` tiene columna `path ltree`. Confirmado por el spec actual; si Tier 1 cambio el shape, ajustar la migracion 040.b.

4. **`saved_queries.run_saved_query` retorna jsonb sin paginar**: limitado a 100 docs en `search_documents`. Para volumenes grandes (>1000 docs hit) se necesita paginacion; queda fuera de scope.

5. **Worker `run-saved-queries` usa intervalo fijo 9min**: no soporta cron-expressions complejas. Documentado como limitacion conocida en `04-indexacion-inngest.md`.

6. **`consume_shared_link_token` requiere JWT**: el spec habla de "tenant_with_token: cualquier user del tenant con el token". El RPC valida `auth.uid()` + `current_tenant_id()` antes de consumir. Si un user externo (no logueado) recibe el link, va a tener que loguearse primero. Esto es deliberado: tier 2 NO expone consumo anonimo.

7. **`document_views` throttle 30s via Redis**: el throttle vive en la app Node-side, no en la DB. La policy INSERT y el RPC validan visibilidad + ownership; la dedupe queda en `lib/redis/document-views.ts` (no descrito aca; trabajo de la app que consume el RPC). Mencionado en doc `06-contratos-frontend.md` para que el frontend respete la convencion.

8. **Cleanup `data_exports` placeholder**: la rama `if to_regclass('public.data_exports') is not null` cubre el caso de que la tabla no exista todavia (Tier 3); el codigo ya queda listo para que cuando Tier 3 cree la tabla, la purga arranque sin tocar `cleanup_operational_data` de nuevo.

9. **Composite FK pattern aplicado a TODAS las nuevas tablas**: `message_feedback`, `message_citations`, `shared_links` (no aplica directamente sobre target porque target_kind es polimorfico), `document_annotations`, `document_views`, `document_issues`, `document_lineage`. `notifications` y `notification_preferences` no tienen composite FK porque su referencia es a `auth.users` (no a tabla del tenant); `user_bookmarks` tampoco (target_kind polimorfico); `access_requests` tampoco (target_id polimorfico hacia workspace o collection). Los tests de cada migracion validan el composite FK donde aplica.

10. **`update_notification_preferences` con `_kind` y `_channel` PK**: el RPC hace upsert por la PK `(user_id, kind, channel)`. Frontend debe llamar una vez por canal si quiere setear ambos `in_app` y `email`.

11. **`audit_log` triggers automatic existentes (4 funciones)**: el plan solo extiende `app.audit_with_context` para que CONSUMA `session_id`/`workspace_id` del `_request_context` o del setting `app.request_context`. Las 4 funciones `app.audit_*_change` existentes siguen funcionando como antes; si queremos enriquecerlas para que tambien lean el setting, agregar en una mini-task de Tier 2.5 (no en scope ahora).

12. **Ningun mock, ningun demo**: todo el codigo es funcional o falla con mensaje claro. Si una RPC depende de algo que aun no existe (ej. `search_documents` en `run_saved_query`), el orden de las migraciones garantiza que la dependencia ya esta creada (search RPCs en 040.b antes que saved_queries en 049.a).

13. **Tier 2 NO modifica Tier 1**: ningun ALTER TABLE sobre `documents`, `workspaces`, `workspace_memberships`, `collections`, etc. Si una capacidad Tier 2 necesitase cambiar Tier 1 (no es el caso), tendria que ser una migracion separada con su propio backfill.

---

## Execution Handoff

Recomendacion para ejecutar Tier 2:

1. **Verificar pre-requisito**: corres `npm run test:db && npm run indexing:health` en `main` con Tier 1 aplicado. Si verde, seguir. Si no, **abortar** y volver a Tier 1.

2. **Branch**: `git checkout -b tier2-multipliers main`.

3. **Sub-skill recomendado**: `superpowers:subagent-driven-development` con fresh subagent por Paso (no por Task; cada Paso es un dominio coherente y cabe en un context). Alternativa si tu workflow lo prefiere: `superpowers:executing-plans` lineal.

4. **Orden estricto**: respetar Pasos 1 → 18. Algunos pasos tienen dependencias inversas (042/043 referencian notifications de 044). El plan documenta los partial-pass esperados y como descomentar tests despues.

5. **Despues de cada Paso**: commit. Despues de Paso 7 (notifications), correr los tests de 042 y 043 con asserts de notificaciones descomentados para validar la integracion DB-side.

6. **Despues de Paso 18**: PR. NO mergear sin revisar la PR (skill `code-review` o un humano). Especial atencion a: 044 (extension realtime topic), 049.b (audit_log alter), 047 (denormalizacion lineage).

7. **Post-merge**: dejar el feature flag implicito `SDA_ENABLE_TIER2 = true` en la app sin condicionar nada; la DB ya tiene todo activo. Frontend va a poder consumir las RPCs progresivamente sin breaking.

8. **Si algo se cae en prod**: `cleanup_operational_data` es service-role only y no se llama automatic. Los triggers `notify_*` son SECURITY DEFINER pero defensivos (siempre verifican que la fila relacionada existe). Si una notif spamea, deshabilitar el trigger con `alter table ... disable trigger` y abrir issue.

9. **Proximo paso despues de Tier 2**: ejecutar `2026-05-22-supabase-multitenant-platform-tier3-enterprise.md` (connectors, usage, Stripe, data_exports, particionado, halfvec). Tier 3 depende de la inbox de Tier 2 para `usage.threshold_crossed`.








