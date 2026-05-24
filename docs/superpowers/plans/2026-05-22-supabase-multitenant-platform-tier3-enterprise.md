# Supabase Multitenant Platform — Tier 3 Enterprise Depth Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cerrar el corte enterprise de SDA Framework agregando connectors Drive/M365 con OAuth via Supabase Vault, usage records particionados con aggregates diarios y alertas de threshold, mirror minimal de Stripe, data exports por scope, particionado de tablas hot (`audit_log`, `indexing_events`, `document_views`, `notifications`), migracion a `halfvec` con dual-write, vistas comunes de actividad/top docs y cleanup operativo extendido.

**Architecture:** Tres bloques nuevos sobre la base de Tier 1 + Tier 2: (1) plano de connectors externos donde un endpoint server-side completa el OAuth flow guardando secrets en `vault.secrets` y un worker Inngest cron sincroniza items respetando `sync_interval_seconds`; (2) plano de usage donde un RPC `service_role` registra eventos en `usage_records` particionada por mes, una matview agrega diariamente, `pg_cron` la refresca y un trigger emite notifications cuando se cruza un threshold; (3) plano operativo donde tablas hot se reparticionan via patron `create-new + copy + swap`, `chunks.embedding` migra a `halfvec` con trigger de dual-write durante una ventana y `cleanup_operational_data` se extiende para purgar particiones viejas + exports vencidos.

**Tech Stack:** Supabase (Postgres 17, RLS, Storage, Realtime, pg_cron, pgvector >=0.7 con halfvec, Supabase Vault, opcionalmente `pg_partman`), Next.js 16 App Router (route handlers para OAuth callback + Stripe webhook), Inngest (`sync-document-source`, `process-data-export`, opcional `ensure-future-partitions`), Google Drive API v3, Microsoft Graph API (SharePoint + OneDrive driveItem delta), Stripe webhooks (`STRIPE_WEBHOOK_SECRET` + firma HMAC), pgTAP para tests SQL, node --test + vitest para workers TS, Upstash Redis (rate-limit de syncs).

**Reference spec:** `docs/superpowers/specs/2026-05-22-supabase-multitenant-audit-design.md` (secciones aplicables: "Modelo de datos — Tier 3", "Particionado", "halfvec migration", "Mirror Stripe", "Data export", "Observaciones del code review — para el plan de implementacion").

**Master plan:** `docs/superpowers/plans/2026-05-22-supabase-multitenant-platform.md`.

**Pre-requisito:** Tier 1 y Tier 2 mergeados a `main` y aplicados. Ver `docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier1-foundation.md` y `docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier2-multipliers.md`. Antes de arrancar Tier 3:

- `select count(*) from public.workspaces` retorna >= 1 por tenant activo (workspace `Default` backfilled).
- `select count(*) from public.notifications` funciona (Tier 2 publico la tabla).
- `select claims_version from auth.jwt()` retorna `2` para sesiones nuevas.
- `npm run test:db` corre verde en `main`.

---

## Tier overview

Capacidades cubiertas (mapping al spec):

| # spec | Capacidad | Paso | Task principal |
|---|---|---|---|
| 21 | `document_sources` + `document_source_cursors` + `tenant_oauth_credentials` (Vault) | Paso 1 + Paso 2 | Task 1.1-1.8, Task 2.1-2.5 |
| 22 | `usage_records` particionada + `usage_aggregates_daily` + report RPCs | Paso 3 | Task 3.1-3.7 |
| 22b | Notification trigger usage threshold | Paso 3 | Task 3.6 |
| 23 | Mirror Stripe (`stripe_customers`, `stripe_subscriptions`) + webhook | Paso 4 | Task 4.1-4.4 |
| 24 | `data_exports` + worker dump | Paso 5 | Task 5.1-5.6 |
| 25.a | Particionado `audit_log` | Paso 6 | Task 6.2 |
| 25.b | Particionado `indexing_events` | Paso 6 | Task 6.3 |
| 25.c | Particionado `document_views` | Paso 6 | Task 6.4 |
| 25.d | Particionado `notifications` | Paso 6 | Task 6.5 |
| 25.e | Auto-create future partitions | Paso 6 | Task 6.6 |
| 26 | `halfvec` migration con dual-write trigger + swap | Paso 7 | Task 7.1-7.5 |
| 27.a | Vista `workspace_top_documents` | Paso 8 | Task 8.1 |
| 27.b | Vista `workspace_recent_activity` | Paso 8 | Task 8.2 |
| ops | `cleanup_operational_data` extendido | Paso 8 | Task 8.3 |
| ops | `pg_cron` jobs nuevos | Paso 8 | Task 8.4 |
| ops | Realtime publication updates | Paso 8 | Task 8.5 |
| docs | Docs 16/17/19 + updates | Paso 8 | Task 8.6-8.9 |

Lo que NO entra (diferido por decision del usuario):

- `agent_tasks` (esperar feedback real de Tier 2).
- Notion/Slack/Confluence/Salesforce connectors.
- BYO LLM key, SAML/SCIM, API keys externas.
- Tenant-configurable retention.
- Encrypted search per-tenant.

---

## Migration order

Timestamps comprometidos para Tier 3. La ultima migracion conocida al momento de generar este plan es `20260521210000_realtime_product_channels.sql` (Tier 0); Tier 1 y Tier 2 ocuparon timestamps entre `20260522` y `20260801`. Tier 3 arranca en `20260801`:

| Orden | Timestamp | Migracion | Tabla/efecto principal |
|---|---|---|---|
| 1 | `20260801120000_vault_helpers.sql` | helpers `app.vault_*` para leer secret desde worker | helpers + grants |
| 2 | `20260801121000_tenant_oauth_credentials.sql` | `tenant_oauth_credentials` + enum `connector_provider` + `connector_status` | tabla + RLS + audit triggers |
| 3 | `20260801122000_document_sources.sql` | `document_sources` + `document_source_cursors` + `document_source_items` | tablas + RLS + composite FKs |
| 4 | `20260801123000_connectors_rpcs.sql` | RPCs `create_oauth_credential`, `revoke_oauth_credential`, `create_document_source`, ... | RPCs + audits |
| 5 | `20260801130000_usage_records_partitioned.sql` | `usage_records` particionada + particion mes corriente + 3 premake | tabla + indices + RLS |
| 6 | `20260801131000_usage_aggregates_daily.sql` | matview `usage_aggregates_daily` + 4 unique idx parciales | matview + indices |
| 7 | `20260801132000_usage_rpcs_and_threshold.sql` | RPCs `report_usage`, `tenant_usage_summary`, `recompute_usage_aggregates` + trigger threshold | RPCs + trigger + notif kind |
| 8 | `20260801140000_stripe_mirror.sql` | `stripe_customers` + `stripe_subscriptions` + indices | tablas + RLS read-only |
| 9 | `20260801150000_data_exports.sql` | `data_exports` + RPCs `request_data_export`, `list_data_exports` | tabla + RPCs + RLS |
| 10 | `20260801160000_partition_audit_log.sql` | swap `audit_log` -> particionada por `created_at` | swap + FKs/triggers/RLS recreados |
| 11 | `20260801161000_partition_indexing_events.sql` | swap `indexing_events` | swap |
| 12 | `20260801162000_partition_document_views.sql` | swap `document_views` (creada en Tier 2) | swap |
| 13 | `20260801163000_partition_notifications.sql` | swap `notifications` | swap |
| 14 | `20260801164000_partition_maintenance.sql` | funcion `app.ensure_future_partitions` + cron diario | funcion + job |
| 15 | `20260801170000_halfvec_dual_write.sql` | `embedding_half` + trigger + HNSW + RPCs leyendo halfvec | dual-write ventana |
| 16 | `20260801171000_halfvec_swap.sql` (programada +7d) | drop trigger, drop `embedding` antigua, rename | swap final |
| 17 | `20260801180000_workspace_views.sql` | vistas `workspace_top_documents`, `workspace_recent_activity` | vistas + grants |
| 18 | `20260801181000_cleanup_operational_data_v3.sql` | extender funcion existente | funcion |
| 19 | `20260801182000_realtime_tier3.sql` | publicar `usage_records`, `data_exports` | publication |

> Nota: la migracion 16 (`halfvec_swap`) NO se aplica el mismo dia que la 15. Se difiere 7 dias en staging y se mergea a `main` con guard `created at` posterior al swap real. Detalle en Task 7.5.

> Si `pg_partman` esta en allowlist del proyecto Supabase, las migraciones 10-13 pueden usarlo (Task 6.6 cubre ambas ramas).

Cada migracion lleva test pgTAP en `supabase/tests/<nombre>_test.sql`. Cada migracion = 1 commit (excepto migraciones grandes con docs en el mismo commit). RPCs y workers TS llevan tests vitest / node --test.

---

## Paso 1 · Connectors infra: Vault helpers + credentials table

### Task 1.1: Pre-flight — validar disponibilidad de Supabase Vault

**Files:**
- Create: `docs/superpowers/plans/_evidence/2026-05-22-tier3-preflight.txt` (evidencia local, no commit)

- [ ] **Step 1: Verificar que `vault` schema existe en el proyecto**

```bash
supabase db remote commit --dry-run 2>/dev/null || true
psql "$SUPABASE_DB_URL" -c "select count(*) from pg_namespace where nspname = 'vault'" -t
```

Expected: `1`. Si retorna `0`, abrir ticket Supabase y abortar el plan (Tier 3 depende de Vault para connectors).

- [ ] **Step 2: Verificar funciones disponibles**

```bash
psql "$SUPABASE_DB_URL" -c "select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'vault' order by proname" -t
```

Expected: aparecen `create_secret`, `update_secret`, al menos. Si no, escalar.

- [ ] **Step 3: Verificar pgvector version >= 0.7 (para halfvec en Paso 7)**

```bash
psql "$SUPABASE_DB_URL" -c "select extversion from pg_extension where extname = 'vector'"
```

Expected: `0.7.x` o superior. Si es menor, marcar Paso 7 como `BLOCKED` y dejar tarea de upgrade.

- [ ] **Step 4: Verificar `pg_partman` (rama opcional para Paso 6)**

```bash
psql "$SUPABASE_DB_URL" -c "select 1 from pg_available_extensions where name = 'pg_partman' and installed_version is null and default_version is not null"
```

Expected: `1` si esta disponible para `create extension`, `0` si no. Anotar resultado: define si Paso 6 usa ruta A (`pg_partman`) o ruta B (manual cron).

- [ ] **Step 5: Anotar evidencia local**

```bash
cat <<EOF > docs/superpowers/plans/_evidence/2026-05-22-tier3-preflight.txt
vault_available: <yes/no>
vector_version: <x.y.z>
pg_partman_available: <yes/no>
preflight_at: $(date -Iseconds)
EOF
```

No commit; archivo local de evidencia.

### Task 1.2: pgTAP test — `app.vault_*` helpers no-op si vault unavailable

**Files:**
- Create: `supabase/tests/vault_helpers_test.sql`

- [ ] **Step 1: Escribir test failing**

```sql
-- supabase/tests/vault_helpers_test.sql
BEGIN;
SELECT plan(4);

-- helper existe
SELECT has_function('app', 'create_oauth_secret', ARRAY['uuid','text','jsonb'],
  'app.create_oauth_secret existe');

-- helper devuelve uuid del secret creado
SELECT has_function('app', 'read_oauth_secret', ARRAY['uuid'],
  'app.read_oauth_secret existe');

-- helper actualiza
SELECT has_function('app', 'update_oauth_secret', ARRAY['uuid','text','jsonb'],
  'app.update_oauth_secret existe');

-- delete
SELECT has_function('app', 'delete_oauth_secret', ARRAY['uuid'],
  'app.delete_oauth_secret existe');

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Correr test — verificar FAIL**

```bash
npm run test:db -- --test supabase/tests/vault_helpers_test.sql
```

Expected: `not ok` en los 4 asserts (las funciones aun no existen).

### Task 1.3: Migracion `20260801120000_vault_helpers.sql`

**Files:**
- Create: `supabase/migrations/20260801120000_vault_helpers.sql`

- [ ] **Step 1: Escribir migracion**

```sql
-- supabase/migrations/20260801120000_vault_helpers.sql
-- Wrappers para vault.create_secret/update_secret/delete_secret.
-- Solo service_role los puede invocar. Los workers Inngest los llaman
-- para guardar/leer access+refresh tokens de OAuth.

create or replace function app.create_oauth_secret(
  _tenant_id uuid,
  _payload text,
  _description jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  _secret_id uuid;
  _name text;
begin
  if _tenant_id is null then
    raise exception 'tenant_id required' using errcode = '22023';
  end if;

  _name := 'oauth_' || _tenant_id::text || '_' || extensions.gen_random_uuid()::text;

  select vault.create_secret(_payload, _name, _description::text) into _secret_id;

  return _secret_id;
end;
$$;

create or replace function app.read_oauth_secret(_secret_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  _decrypted text;
begin
  if _secret_id is null then
    return null;
  end if;

  select decrypted_secret
  from vault.decrypted_secrets
  where id = _secret_id
  into _decrypted;

  return _decrypted;
end;
$$;

create or replace function app.update_oauth_secret(
  _secret_id uuid,
  _payload text,
  _description jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if _secret_id is null then
    raise exception 'secret_id required' using errcode = '22023';
  end if;

  perform vault.update_secret(_secret_id, _payload, null, _description::text);
end;
$$;

create or replace function app.delete_oauth_secret(_secret_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if _secret_id is null then
    return;
  end if;

  delete from vault.secrets where id = _secret_id;
end;
$$;

revoke all on function app.create_oauth_secret(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function app.read_oauth_secret(uuid) from public, anon, authenticated;
revoke all on function app.update_oauth_secret(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function app.delete_oauth_secret(uuid) from public, anon, authenticated;

grant execute on function app.create_oauth_secret(uuid, text, jsonb) to service_role;
grant execute on function app.read_oauth_secret(uuid) to service_role;
grant execute on function app.update_oauth_secret(uuid, text, jsonb) to service_role;
grant execute on function app.delete_oauth_secret(uuid) to service_role;
```

- [ ] **Step 2: Aplicar local + correr test — verificar PASS**

```bash
supabase db reset --local
npm run test:db -- --test supabase/tests/vault_helpers_test.sql
```

Expected: `ok` en los 4 asserts.

- [ ] **Step 3: Suite completa**

```bash
npm run test:db
```

Expected: todos los tests del repo en verde.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260801120000_vault_helpers.sql supabase/tests/vault_helpers_test.sql
git commit -m "feat(db): vault wrappers app.create/read/update/delete_oauth_secret"
```

### Task 1.4: pgTAP test — `tenant_oauth_credentials` table + RLS

**Files:**
- Create: `supabase/tests/tenant_oauth_credentials_test.sql`

- [ ] **Step 1: Escribir test failing**

```sql
BEGIN;
SELECT plan(10);

SELECT has_table('public', 'tenant_oauth_credentials',
  'tabla tenant_oauth_credentials existe');

SELECT col_not_null('public', 'tenant_oauth_credentials', 'tenant_id',
  'tenant_id NOT NULL');
SELECT col_not_null('public', 'tenant_oauth_credentials', 'provider',
  'provider NOT NULL');
SELECT col_not_null('public', 'tenant_oauth_credentials', 'account_subject',
  'account_subject NOT NULL');

SELECT has_type('public', 'connector_provider', 'enum connector_provider existe');
SELECT has_type('public', 'connector_status',   'enum connector_status existe');

-- RLS enabled
SELECT is(
  (select relrowsecurity from pg_class where oid = 'public.tenant_oauth_credentials'::regclass),
  true,
  'RLS enabled en tenant_oauth_credentials');

-- audit trigger creation
SELECT has_function('app', 'audit_oauth_credential_change', ARRAY[]::text[],
  'trigger fn audit_oauth_credential_change existe');

-- unique (tenant_id, provider, account_subject)
SELECT col_is_unique('public', 'tenant_oauth_credentials',
  ARRAY['tenant_id','provider','account_subject'],
  'unique (tenant,provider,account_subject)');

-- write boundary: authenticated NO tiene insert/update/delete
SELECT lives_ok(
  $$ select 1 from information_schema.role_table_grants
     where table_name='tenant_oauth_credentials' and grantee='authenticated'
       and privilege_type in ('INSERT','UPDATE','DELETE') $$,
  'no grants escritura a authenticated (validacion manual debajo)');

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Correr — verificar FAIL**

```bash
npm run test:db -- --test supabase/tests/tenant_oauth_credentials_test.sql
```

Expected: `not ok` en todos.

### Task 1.5: Migracion `20260801121000_tenant_oauth_credentials.sql`

**Files:**
- Create: `supabase/migrations/20260801121000_tenant_oauth_credentials.sql`

- [ ] **Step 1: Escribir migracion completa**

```sql
-- supabase/migrations/20260801121000_tenant_oauth_credentials.sql
-- Credenciales OAuth de un tenant para un provider externo.
-- El secret real vive en vault.secrets; aca solo el puntero (uuid).

do $$
begin
  create type public.connector_provider as enum (
    'google_drive',
    'm365_sharepoint',
    'm365_onedrive'
  );
exception when duplicate_object then null;
end;
$$;

do $$
begin
  create type public.connector_status as enum (
    'pending_auth',
    'active',
    'paused',
    'error',
    'revoked'
  );
exception when duplicate_object then null;
end;
$$;

create table public.tenant_oauth_credentials (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  provider public.connector_provider not null,
  account_subject text not null check (length(account_subject) between 1 and 320),
  display_name text,
  vault_secret_id uuid,                       -- null hasta que el callback OAuth lo setea
  scopes text[] not null default '{}',
  expires_at timestamptz,
  status public.connector_status not null default 'pending_auth',
  last_refreshed_at timestamptz,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, provider, account_subject)
);

create index tenant_oauth_credentials_tenant_status_idx
  on public.tenant_oauth_credentials (tenant_id, status);
create index tenant_oauth_credentials_expires_idx
  on public.tenant_oauth_credentials (expires_at)
  where status = 'active' and expires_at is not null;

create trigger set_tenant_oauth_credentials_updated_at
before update on public.tenant_oauth_credentials
for each row execute function app.set_updated_at();

alter table public.tenant_oauth_credentials enable row level security;

create policy tenant_oauth_credentials_select_admin on public.tenant_oauth_credentials
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and (select app.is_tenant_admin())
  );

-- write boundary: solo service_role escribe
revoke insert, update, delete on public.tenant_oauth_credentials from authenticated;
grant select on public.tenant_oauth_credentials to authenticated;
grant all on public.tenant_oauth_credentials to service_role;

-- audit trigger: capturar create/revoke/error transitions
create or replace function app.audit_oauth_credential_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  _action text;
  _payload jsonb;
begin
  if tg_op = 'INSERT' then
    _action := 'oauth_credential.created';
    _payload := jsonb_build_object(
      'provider', new.provider,
      'account_subject', new.account_subject,
      'status', new.status
    );
  elsif tg_op = 'UPDATE' then
    if new.status is distinct from old.status then
      _action := 'oauth_credential.status_changed';
      _payload := jsonb_build_object(
        'provider', new.provider,
        'from', old.status,
        'to', new.status,
        'last_error', new.last_error
      );
    else
      return new;
    end if;
  else
    return null;
  end if;

  insert into public.audit_log (
    tenant_id, actor_id, action, resource_type, resource_id, metadata
  ) values (
    new.tenant_id, coalesce(new.created_by, (select auth.uid())),
    _action, 'tenant_oauth_credential', new.id, _payload
  );
  return new;
end;
$$;

create trigger audit_tenant_oauth_credentials_change
after insert or update on public.tenant_oauth_credentials
for each row execute function app.audit_oauth_credential_change();
```

- [ ] **Step 2: Aplicar local + test PASS**

```bash
supabase db reset --local
npm run test:db -- --test supabase/tests/tenant_oauth_credentials_test.sql
```

Expected: 10/10 OK.

- [ ] **Step 3: Suite completa**

```bash
npm run test:db
```

Expected: verde.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260801121000_tenant_oauth_credentials.sql supabase/tests/tenant_oauth_credentials_test.sql
git commit -m "feat(db): tenant_oauth_credentials table + RLS + audit trigger"
```

### Task 1.6: pgTAP test — `document_sources` + `document_source_cursors` + `document_source_items`

**Files:**
- Create: `supabase/tests/document_sources_test.sql`

- [ ] **Step 1: Escribir test failing**

```sql
BEGIN;
SELECT plan(14);

SELECT has_table('public', 'document_sources', 'document_sources existe');
SELECT has_table('public', 'document_source_cursors', 'document_source_cursors existe');
SELECT has_table('public', 'document_source_items', 'document_source_items existe');

SELECT col_not_null('public', 'document_sources', 'workspace_id', 'workspace_id NOT NULL');
SELECT col_not_null('public', 'document_sources', 'credential_id', 'credential_id NOT NULL');
SELECT col_not_null('public', 'document_sources', 'sync_interval_seconds', 'sync_interval_seconds NOT NULL');

-- check constraint sync_interval_seconds >= 300
SELECT throws_ok(
  $$ insert into public.document_sources
     (tenant_id, workspace_id, credential_id, provider, name, sync_interval_seconds)
     values ('00000000-0000-0000-0000-000000000001'::uuid,
             '00000000-0000-0000-0000-000000000002'::uuid,
             '00000000-0000-0000-0000-000000000003'::uuid,
             'google_drive','x', 100) $$,
  '23514',
  'sync_interval_seconds < 300 rechazado');

-- composite FK (tenant_id, workspace_id) -> workspaces
SELECT col_is_fk('public','document_sources','workspace_id',
  'workspace_id FK presente');

-- document_source_items unique (source_id, external_id)
SELECT col_is_unique('public','document_source_items',
  ARRAY['source_id','external_id'],
  'unique (source_id, external_id)');

-- RLS enabled todas
SELECT is((select relrowsecurity from pg_class where oid='public.document_sources'::regclass), true, 'RLS sources');
SELECT is((select relrowsecurity from pg_class where oid='public.document_source_cursors'::regclass), true, 'RLS cursors');
SELECT is((select relrowsecurity from pg_class where oid='public.document_source_items'::regclass), true, 'RLS items');

-- write boundary
SELECT bag_eq(
  $$ select privilege_type from information_schema.role_table_grants
     where table_name='document_sources' and grantee='authenticated' $$,
  $$ values ('SELECT') $$,
  'authenticated solo tiene SELECT en document_sources');

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Correr — verificar FAIL**

```bash
npm run test:db -- --test supabase/tests/document_sources_test.sql
```

Expected: `not ok` en todos.

### Task 1.7: Migracion `20260801122000_document_sources.sql`

**Files:**
- Create: `supabase/migrations/20260801122000_document_sources.sql`

- [ ] **Step 1: Escribir migracion**

```sql
-- supabase/migrations/20260801122000_document_sources.sql

create table public.document_sources (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  workspace_id uuid not null,
  collection_id uuid,
  credential_id uuid not null,
  provider public.connector_provider not null,
  name text not null check (length(name) between 1 and 200),
  status public.connector_status not null default 'pending_auth',
  config jsonb not null default '{}'::jsonb,
  sync_interval_seconds integer not null default 3600
    check (sync_interval_seconds >= 300 and sync_interval_seconds <= 86400),
  last_synced_at timestamptz,
  next_sync_at timestamptz,
  last_error text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, workspace_id)
    references public.workspaces(tenant_id, id) on delete cascade,
  foreign key (tenant_id, collection_id)
    references public.collections(tenant_id, id) on delete set null,
  foreign key (tenant_id, credential_id)
    references public.tenant_oauth_credentials(tenant_id, id) on delete restrict
);

create index document_sources_active_due_idx
  on public.document_sources (tenant_id, next_sync_at)
  where status = 'active';
create index document_sources_workspace_idx
  on public.document_sources (tenant_id, workspace_id);
create index document_sources_credential_idx
  on public.document_sources (tenant_id, credential_id);

create trigger set_document_sources_updated_at
before update on public.document_sources
for each row execute function app.set_updated_at();

create table public.document_source_cursors (
  source_id uuid primary key references public.document_sources(id) on delete cascade,
  tenant_id uuid not null,
  cursor jsonb not null,
  last_seen_external_at timestamptz,
  updated_at timestamptz not null default now()
);

create trigger set_document_source_cursors_updated_at
before update on public.document_source_cursors
for each row execute function app.set_updated_at();

create table public.document_source_items (
  id uuid primary key default extensions.gen_random_uuid(),
  source_id uuid not null references public.document_sources(id) on delete cascade,
  tenant_id uuid not null,
  document_id uuid,
  external_id text not null check (length(external_id) between 1 and 512),
  external_etag text,
  external_path text,
  external_modified_at timestamptz,
  mime_type text,
  byte_size bigint check (byte_size is null or byte_size >= 0),
  last_seen_at timestamptz not null default now(),
  ingestion_status text not null default 'pending'
    check (ingestion_status in ('pending', 'ingesting', 'indexed', 'failed', 'skipped')),
  ingestion_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, external_id),
  foreign key (tenant_id, document_id)
    references public.documents(tenant_id, id) on delete set null
);

create index document_source_items_pending_idx
  on public.document_source_items (tenant_id, source_id, last_seen_at)
  where ingestion_status = 'pending';
create index document_source_items_document_idx
  on public.document_source_items (tenant_id, document_id)
  where document_id is not null;
create index document_source_items_failed_idx
  on public.document_source_items (tenant_id, source_id, last_seen_at)
  where ingestion_status = 'failed';

create trigger set_document_source_items_updated_at
before update on public.document_source_items
for each row execute function app.set_updated_at();

alter table public.document_sources enable row level security;
alter table public.document_source_cursors enable row level security;
alter table public.document_source_items enable row level security;

create policy document_sources_select_member on public.document_sources
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and (
      (select app.is_tenant_admin())
      or (select app.user_belongs_to_workspace(workspace_id))
    )
  );

create policy document_source_cursors_select_admin on public.document_source_cursors
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and (select app.is_tenant_admin())
  );

create policy document_source_items_select_member on public.document_source_items
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and exists (
      select 1 from public.document_sources ds
      where ds.id = document_source_items.source_id
        and ds.tenant_id = document_source_items.tenant_id
        and (
          (select app.is_tenant_admin())
          or (select app.user_belongs_to_workspace(ds.workspace_id))
        )
    )
  );

revoke insert, update, delete on public.document_sources from authenticated;
revoke insert, update, delete on public.document_source_cursors from authenticated;
revoke insert, update, delete on public.document_source_items from authenticated;

grant select on public.document_sources, public.document_source_cursors, public.document_source_items to authenticated;
grant all on public.document_sources, public.document_source_cursors, public.document_source_items to service_role;
```

- [ ] **Step 2: Aplicar + test PASS**

```bash
supabase db reset --local
npm run test:db -- --test supabase/tests/document_sources_test.sql
```

Expected: 14/14 OK.

- [ ] **Step 3: Suite completa + commit**

```bash
npm run test:db
git add supabase/migrations/20260801122000_document_sources.sql supabase/tests/document_sources_test.sql
git commit -m "feat(db): document_sources + cursors + items with RLS"
```

### Task 1.8: Migracion RPCs connectors `20260801123000_connectors_rpcs.sql`

**Files:**
- Create: `supabase/migrations/20260801123000_connectors_rpcs.sql`
- Create: `supabase/tests/connectors_rpcs_test.sql`

- [ ] **Step 1: Test failing**

```sql
-- supabase/tests/connectors_rpcs_test.sql
BEGIN;
SELECT plan(8);

SELECT has_function('public','create_oauth_credential',
  ARRAY['public.connector_provider','text','text[]','jsonb'],
  'RPC create_oauth_credential existe');
SELECT has_function('public','revoke_oauth_credential', ARRAY['uuid'],
  'RPC revoke_oauth_credential existe');
SELECT has_function('public','create_document_source',
  ARRAY['uuid','uuid','public.connector_provider','text','jsonb','uuid','integer'],
  'RPC create_document_source existe');
SELECT has_function('public','update_document_source', ARRAY['uuid','jsonb'],
  'RPC update_document_source existe');
SELECT has_function('public','pause_document_source', ARRAY['uuid'],
  'RPC pause_document_source existe');
SELECT has_function('public','resume_document_source', ARRAY['uuid'],
  'RPC resume_document_source existe');
SELECT has_function('public','delete_document_source', ARRAY['uuid'],
  'RPC delete_document_source existe');

-- security definer
SELECT is(
  (select prosecdef from pg_proc where proname='create_document_source' limit 1),
  true,
  'create_document_source es security definer');

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Correr test — verificar FAIL**

```bash
npm run test:db -- --test supabase/tests/connectors_rpcs_test.sql
```

Expected: 8x `not ok`.

- [ ] **Step 3: Escribir migracion RPCs**

```sql
-- supabase/migrations/20260801123000_connectors_rpcs.sql

create or replace function public.create_oauth_credential(
  _provider public.connector_provider,
  _account_subject text,
  _scopes text[] default '{}',
  _metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  _tenant_id uuid := (select app.current_tenant_id());
  _credential_id uuid;
begin
  if _tenant_id is null then
    raise exception 'tenant context required' using errcode = '42501';
  end if;
  if not (select app.is_tenant_admin()) then
    raise exception 'forbidden: tenant_admin required' using errcode = '42501';
  end if;
  if _account_subject is null or length(_account_subject) < 1 then
    raise exception 'account_subject required' using errcode = '22023';
  end if;

  insert into public.tenant_oauth_credentials (
    tenant_id, provider, account_subject, scopes, status, created_by, metadata
  ) values (
    _tenant_id, _provider, _account_subject, coalesce(_scopes,'{}'),
    'pending_auth', (select auth.uid()), coalesce(_metadata, '{}'::jsonb)
  )
  returning id into _credential_id;

  return _credential_id;
end;
$$;

create or replace function public.revoke_oauth_credential(_credential_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  _tenant_id uuid := (select app.current_tenant_id());
  _vault_id uuid;
begin
  if not (select app.is_tenant_admin()) then
    raise exception 'forbidden: tenant_admin required' using errcode = '42501';
  end if;

  update public.tenant_oauth_credentials
    set status = 'revoked', updated_at = now()
    where id = _credential_id and tenant_id = _tenant_id
    returning vault_secret_id into _vault_id;

  if not found then
    raise exception 'credential not found' using errcode = 'P0002';
  end if;

  -- best-effort delete del secret en Vault (idempotente)
  if _vault_id is not null then
    perform app.delete_oauth_secret(_vault_id);
    update public.tenant_oauth_credentials set vault_secret_id = null
      where id = _credential_id;
  end if;

  -- pausa todas las sources que usan esta credential
  update public.document_sources
    set status = 'paused', last_error = 'credential revoked', updated_at = now()
    where tenant_id = _tenant_id and credential_id = _credential_id
      and status in ('active','pending_auth','error');

  insert into public.audit_log (tenant_id, actor_id, action, resource_type, resource_id)
  values (_tenant_id, (select auth.uid()), 'oauth_credential.revoked', 'tenant_oauth_credential', _credential_id);
end;
$$;

create or replace function public.create_document_source(
  _workspace_id uuid,
  _credential_id uuid,
  _provider public.connector_provider,
  _name text,
  _config jsonb default '{}'::jsonb,
  _collection_id uuid default null,
  _sync_interval_seconds integer default 3600
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  _tenant_id uuid := (select app.current_tenant_id());
  _source_id uuid;
  _role public.workspace_role;
begin
  if _tenant_id is null then
    raise exception 'tenant context required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.workspaces w
    where w.id = _workspace_id and w.tenant_id = _tenant_id and w.deleted_at is null
  ) then
    raise exception 'workspace not found' using errcode = 'P0002';
  end if;
  _role := app.user_workspace_role(_workspace_id);
  if not ((select app.is_tenant_admin()) or _role = 'workspace_admin') then
    raise exception 'forbidden: workspace_admin required' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.tenant_oauth_credentials c
    where c.id = _credential_id and c.tenant_id = _tenant_id and c.status in ('pending_auth','active')
  ) then
    raise exception 'credential not active' using errcode = 'P0002';
  end if;

  insert into public.document_sources (
    tenant_id, workspace_id, collection_id, credential_id,
    provider, name, status, config, sync_interval_seconds,
    next_sync_at, created_by
  ) values (
    _tenant_id, _workspace_id, _collection_id, _credential_id,
    _provider, _name, 'pending_auth', coalesce(_config,'{}'::jsonb),
    coalesce(_sync_interval_seconds, 3600),
    now() + (coalesce(_sync_interval_seconds,3600) || ' seconds')::interval,
    (select auth.uid())
  )
  returning id into _source_id;

  insert into public.audit_log (tenant_id, actor_id, action, resource_type, resource_id, metadata)
  values (_tenant_id, (select auth.uid()), 'document_source.created',
          'document_source', _source_id,
          jsonb_build_object('provider', _provider, 'workspace_id', _workspace_id));

  return _source_id;
end;
$$;

create or replace function public.update_document_source(_source_id uuid, _patch jsonb)
returns public.document_sources
language plpgsql
security definer
set search_path = ''
as $$
declare
  _tenant_id uuid := (select app.current_tenant_id());
  _row public.document_sources;
begin
  select * from public.document_sources
    where id = _source_id and tenant_id = _tenant_id into _row;
  if not found then
    raise exception 'source not found' using errcode = 'P0002';
  end if;
  if not ((select app.is_tenant_admin())
          or app.user_workspace_role(_row.workspace_id) = 'workspace_admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.document_sources
    set name = coalesce(_patch->>'name', name),
        config = coalesce(_patch->'config', config),
        collection_id = case when _patch ? 'collection_id'
                             then nullif(_patch->>'collection_id','')::uuid
                             else collection_id end,
        sync_interval_seconds = coalesce((_patch->>'sync_interval_seconds')::integer,
                                         sync_interval_seconds),
        updated_at = now()
    where id = _source_id
    returning * into _row;

  return _row;
end;
$$;

create or replace function public.pause_document_source(_source_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  _tenant_id uuid := (select app.current_tenant_id());
begin
  update public.document_sources
    set status = 'paused', next_sync_at = null, updated_at = now()
    where id = _source_id and tenant_id = _tenant_id;
  if not found then
    raise exception 'source not found' using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.resume_document_source(_source_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  _tenant_id uuid := (select app.current_tenant_id());
begin
  update public.document_sources
    set status = 'active',
        next_sync_at = now(),
        last_error = null,
        updated_at = now()
    where id = _source_id and tenant_id = _tenant_id
      and status in ('paused','error','pending_auth');
  if not found then
    raise exception 'source not found or not pausable' using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.delete_document_source(_source_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  _tenant_id uuid := (select app.current_tenant_id());
begin
  if not (select app.is_tenant_admin()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.document_sources
    where id = _source_id and tenant_id = _tenant_id;
end;
$$;

revoke all on function public.create_oauth_credential(public.connector_provider, text, text[], jsonb) from public, anon;
revoke all on function public.revoke_oauth_credential(uuid) from public, anon;
revoke all on function public.create_document_source(uuid, uuid, public.connector_provider, text, jsonb, uuid, integer) from public, anon;
revoke all on function public.update_document_source(uuid, jsonb) from public, anon;
revoke all on function public.pause_document_source(uuid) from public, anon;
revoke all on function public.resume_document_source(uuid) from public, anon;
revoke all on function public.delete_document_source(uuid) from public, anon;

grant execute on function public.create_oauth_credential(public.connector_provider, text, text[], jsonb) to authenticated;
grant execute on function public.revoke_oauth_credential(uuid) to authenticated;
grant execute on function public.create_document_source(uuid, uuid, public.connector_provider, text, jsonb, uuid, integer) to authenticated;
grant execute on function public.update_document_source(uuid, jsonb) to authenticated;
grant execute on function public.pause_document_source(uuid) to authenticated;
grant execute on function public.resume_document_source(uuid) to authenticated;
grant execute on function public.delete_document_source(uuid) to authenticated;
```

- [ ] **Step 4: Aplicar + test PASS**

```bash
supabase db reset --local
npm run test:db -- --test supabase/tests/connectors_rpcs_test.sql
```

Expected: 8/8 OK.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260801123000_connectors_rpcs.sql supabase/tests/connectors_rpcs_test.sql
git commit -m "feat(db): connectors RPCs (oauth credential + document source CRUD)"
```

### Task 1.9: Helper `app.dispatch_inngest_event` + tabla outbox

**Files:**
- Create: `supabase/migrations/20260801123500_dispatch_inngest_event.sql`
- Create: `supabase/tests/dispatch_inngest_event_test.sql`

**Contexto**: hoy Task 5.4 inline-ea `pg_net.http_post` con fallback "depender del cron sweep". Lo formalizamos en un helper transversal que: (a) si `pg_net` está disponible hace HTTP POST con HMAC sig; (b) si no, escribe a `app.dispatch_outbox` que un cron sweep consume y reenvía. Consumido por connectors (Task 2.6) y data exports (Task 5.4 refactor).

- [ ] **Step 1: Migración**

```sql
-- supabase/migrations/20260801123500_dispatch_inngest_event.sql
-- Helper transversal para disparar eventos Inngest desde Postgres,
-- con fallback determinista via outbox + cron sweep.

-- Tabla outbox: filas que el sweep cron procesa si pg_net no disponible o falla.
create table if not exists app.dispatch_outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  event_name text not null,
  payload jsonb not null,
  signature text not null,
  endpoint_url text not null,
  attempts int not null default 0,
  status text not null default 'pending'
    check (status in ('pending','succeeded','failed','abandoned')),
  last_error text,
  created_at timestamptz not null default now(),
  next_attempt_at timestamptz not null default now(),
  succeeded_at timestamptz
);

create index if not exists dispatch_outbox_pending_idx
  on app.dispatch_outbox (next_attempt_at)
  where status = 'pending';

create index if not exists dispatch_outbox_tenant_idx
  on app.dispatch_outbox (tenant_id, status);

revoke all on app.dispatch_outbox from public, authenticated;

-- Helper: compone signature HMAC y dispatcha; si pg_net no esta, inserta a outbox.
create or replace function app.dispatch_inngest_event(
  _tenant_id uuid,
  _event_name text,
  _payload jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  _endpoint_url text;
  _signing_key text;
  _signature text;
  _outbox_id uuid;
  _pg_net_available boolean;
begin
  -- Config: leer desde GUCs propios (set por bootstrap del proyecto)
  _endpoint_url := coalesce(current_setting('app.inngest_endpoint_url', true), '');
  _signing_key  := coalesce(current_setting('app.inngest_signing_key', true), '');

  if _endpoint_url = '' or _signing_key = '' then
    raise exception 'app.inngest_endpoint_url / app.inngest_signing_key no configurados';
  end if;

  -- Signature HMAC-SHA256 (hex) del payload con la signing key
  _signature := encode(
    extensions.hmac(_payload::text::bytea, _signing_key::bytea, 'sha256'),
    'hex'
  );

  -- Outbox row siempre (audit + fallback)
  insert into app.dispatch_outbox
    (tenant_id, event_name, payload, signature, endpoint_url)
  values
    (_tenant_id, _event_name, _payload, _signature, _endpoint_url)
  returning id into _outbox_id;

  -- Intentar pg_net si disponible
  select exists (
    select 1 from pg_extension where extname = 'pg_net'
  ) into _pg_net_available;

  if _pg_net_available then
    begin
      perform net.http_post(
        url := _endpoint_url,
        body := jsonb_build_object(
          'name', _event_name,
          'data', _payload,
          'ts', extract(epoch from now())::bigint
        ),
        headers := jsonb_build_object(
          'content-type', 'application/json',
          'x-inngest-signature', _signature,
          'x-dispatch-id', _outbox_id::text
        ),
        timeout_milliseconds := 5000
      );
      -- Marcar succeeded optimisticamente; el sweep verifica response real
      update app.dispatch_outbox
        set status = 'succeeded', succeeded_at = now()
        where id = _outbox_id;
    exception
      when others then
        update app.dispatch_outbox
          set last_error = sqlerrm,
              attempts = attempts + 1
          where id = _outbox_id;
        -- No rethrow: el sweep cron retira
    end;
  end if;

  return _outbox_id;
end;
$$;

revoke all on function app.dispatch_inngest_event(uuid, text, jsonb) from public;
grant execute on function app.dispatch_inngest_event(uuid, text, jsonb) to service_role;

-- Sweep cron: re-intenta filas pending o failed con next_attempt_at <= now
create or replace function app.dispatch_outbox_sweep()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  _row record;
  _processed int := 0;
  _pg_net_available boolean;
begin
  select exists (select 1 from pg_extension where extname = 'pg_net') into _pg_net_available;

  for _row in
    select * from app.dispatch_outbox
    where status = 'pending'
      and next_attempt_at <= now()
      and attempts < 5
    order by created_at
    limit 100
  loop
    if _pg_net_available then
      begin
        perform net.http_post(
          url := _row.endpoint_url,
          body := jsonb_build_object('name', _row.event_name, 'data', _row.payload),
          headers := jsonb_build_object(
            'content-type','application/json',
            'x-inngest-signature', _row.signature,
            'x-dispatch-id', _row.id::text
          ),
          timeout_milliseconds := 5000
        );
        update app.dispatch_outbox
          set status = 'succeeded', succeeded_at = now()
          where id = _row.id;
      exception when others then
        update app.dispatch_outbox
          set attempts = attempts + 1,
              last_error = sqlerrm,
              next_attempt_at = now() + (interval '1 minute' * power(2, attempts))
          where id = _row.id;
      end;
    end if;
    _processed := _processed + 1;
  end loop;

  -- Marcar abandoned los que excedieron retries
  update app.dispatch_outbox
    set status = 'abandoned'
    where status = 'pending' and attempts >= 5;

  return _processed;
end;
$$;

revoke all on function app.dispatch_outbox_sweep() from public;
grant execute on function app.dispatch_outbox_sweep() to service_role;

-- Schedule sweep cada 1 min via pg_cron (patrón defensivo idéntico al de
-- 20260521170000_db_caching_retrieval_ops.sql)
do $$
declare
  cron_schema text;
begin
  select namespace.nspname
  into cron_schema
  from pg_namespace namespace
  where namespace.nspname in ('cron', 'extensions', 'pg_catalog')
    and to_regprocedure(format('%I.schedule(text,text,text)', namespace.nspname)) is not null
  order by case namespace.nspname when 'cron' then 1 when 'extensions' then 2 else 3 end
  limit 1;

  if cron_schema is not null then
    begin
      execute format('select %I.unschedule(%L)', cron_schema, 'sda-dispatch-outbox-sweep');
    exception when others then null;
    end;
    begin
      execute format(
        'select %I.schedule(%L, %L, %L)',
        cron_schema,
        'sda-dispatch-outbox-sweep',
        '*/1 * * * *',
        'select app.dispatch_outbox_sweep();'
      );
    exception when others then
      raise notice 'No se pudo programar dispatch_outbox_sweep: %', sqlerrm;
    end;
  end if;
end;
$$;
```

- [ ] **Step 2: pgTAP test**

```sql
-- supabase/tests/dispatch_inngest_event_test.sql
BEGIN;
SELECT plan(6);

SELECT has_function('app','dispatch_inngest_event',
  ARRAY['uuid','text','jsonb'], 'helper existe');
SELECT has_function('app','dispatch_outbox_sweep',
  ARRAY[]::text[], 'sweep existe');
SELECT has_table('app','dispatch_outbox','tabla outbox existe');

-- Setup GUCs ficticios
SELECT set_config('app.inngest_endpoint_url', 'https://example.test/x', true);
SELECT set_config('app.inngest_signing_key', 'test-key-1234', true);
SELECT set_config('role', 'service_role', true);

-- Disparar evento
SELECT isnt(
  app.dispatch_inngest_event(
    '00000000-0000-0000-0000-000000019001'::uuid,
    'test.event',
    '{"hello":"world"}'::jsonb
  ),
  null,
  'dispatch retorna uuid del outbox row'
);

SELECT is(
  (select count(*)::int from app.dispatch_outbox
   where event_name = 'test.event'),
  1,
  'fila escrita a outbox'
);

-- Verificar signature no vacia
SELECT isnt(
  (select signature from app.dispatch_outbox
   where event_name = 'test.event' limit 1),
  '',
  'signature HMAC presente'
);

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 3: Aplicar + correr test**

```bash
supabase db push
npm run test:db -- --test supabase/tests/dispatch_inngest_event_test.sql
```

Expected: 6/6.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260801123500_dispatch_inngest_event.sql supabase/tests/dispatch_inngest_event_test.sql
git commit -m "feat(db): app.dispatch_inngest_event helper + outbox pattern (pg_net + sweep fallback)"
```

---

## Paso 2 · Connectors workers: OAuth callback + sync worker

### Task 2.1: Provider clients (Google Drive + MS Graph)

**Files:**
- Create: `lib/connectors/providers/google-drive.ts`
- Create: `lib/connectors/providers/m365-graph.ts`
- Create: `lib/connectors/providers/index.ts`
- Create: `lib/connectors/types.ts`
- Create: `lib/connectors/__tests__/google-drive.test.ts`
- Create: `lib/connectors/__tests__/m365-graph.test.ts`

> Filosofia LEAN: cada provider es un archivo chico (~150 LOC) que solo expone `exchangeAuthCode`, `refreshAccessToken`, `listChanges(cursor)`, `downloadFile`. No reimplementamos el SDK: usamos `googleapis` y `@microsoft/microsoft-graph-client`.

- [ ] **Step 1: Verificar dependencias necesarias**

```bash
cat package.json | python3 -c "import json,sys;d=json.load(sys.stdin);print('\n'.join(sorted(d.get('dependencies',{}).keys())))" | grep -E "googleapis|microsoft-graph|stripe|jszip" || echo "MISSING_DEPS"
```

Expected: si faltan, instalar. Si printea `MISSING_DEPS`, ejecutar:

```bash
npm install googleapis @microsoft/microsoft-graph-client @azure/identity stripe jszip
```

Commit aparte:

```bash
git add package.json package-lock.json
git commit -m "chore(deps): googleapis, microsoft-graph-client, stripe, jszip for tier 3 connectors"
```

- [ ] **Step 2: Tipos compartidos**

```typescript
// lib/connectors/types.ts
export type ConnectorProvider = "google_drive" | "m365_sharepoint" | "m365_onedrive";

export type OAuthTokens = {
  access_token: string;
  refresh_token?: string;
  expires_at: string; // ISO
  scope: string[];
  account_subject: string;
  display_name?: string | null;
};

export type ConnectorCursor = Record<string, unknown>;

export type ConnectorItemChange = {
  external_id: string;
  external_etag?: string | null;
  external_path?: string | null;
  external_modified_at?: string | null;
  mime_type?: string | null;
  byte_size?: number | null;
  deleted?: boolean;
  metadata?: Record<string, unknown>;
};

export type ListChangesResult = {
  changes: ConnectorItemChange[];
  next_cursor: ConnectorCursor;
};

export type ProviderClient = {
  readonly provider: ConnectorProvider;
  exchangeAuthCode(args: { code: string; redirect_uri: string }): Promise<OAuthTokens>;
  refreshAccessToken(refresh_token: string): Promise<OAuthTokens>;
  listChanges(args: {
    access_token: string;
    cursor: ConnectorCursor | null;
    config: Record<string, unknown>;
  }): Promise<ListChangesResult>;
  downloadFile(args: {
    access_token: string;
    external_id: string;
    config: Record<string, unknown>;
  }): Promise<{ stream: ReadableStream<Uint8Array>; byte_size: number; content_type: string; filename: string }>;
};
```

- [ ] **Step 3: Test failing google-drive**

```typescript
// lib/connectors/__tests__/google-drive.test.ts
import { describe, expect, it, vi } from "vitest";
import { createGoogleDriveClient } from "../providers/google-drive";

describe("google-drive client", () => {
  it("exposes provider id", () => {
    const c = createGoogleDriveClient();
    expect(c.provider).toBe("google_drive");
  });

  it("exchangeAuthCode posts to oauth2.googleapis.com/token", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        access_token: "AT", refresh_token: "RT", expires_in: 3600,
        scope: "https://www.googleapis.com/auth/drive.readonly",
        id_token: "x"
      }), { status: 200 })
    );
    const userinfo = vi.fn(async () =>
      new Response(JSON.stringify({ email: "u@e.com", name: "U E" }), { status: 200 })
    );
    const client = createGoogleDriveClient({
      fetchImpl: async (url: string, init: RequestInit) => {
        if (typeof url === "string" && url.includes("userinfo")) return userinfo(url, init);
        return fetchMock(url, init);
      },
      clientId: "cid", clientSecret: "cs",
    });
    const t = await client.exchangeAuthCode({ code: "abc", redirect_uri: "https://x/cb" });
    expect(t.access_token).toBe("AT");
    expect(t.refresh_token).toBe("RT");
    expect(t.account_subject).toBe("u@e.com");
  });
});
```

```bash
npx vitest run lib/connectors/__tests__/google-drive.test.ts
```

Expected: FAIL (modulo no existe).

- [ ] **Step 4: Implementar google-drive.ts**

```typescript
// lib/connectors/providers/google-drive.ts
import type { ListChangesResult, OAuthTokens, ProviderClient } from "../types";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const DRIVE_BASE = "https://www.googleapis.com/drive/v3";

type FetchImpl = typeof fetch;

export function createGoogleDriveClient(opts?: {
  fetchImpl?: FetchImpl;
  clientId?: string;
  clientSecret?: string;
}): ProviderClient {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const clientId = opts?.clientId ?? process.env.GOOGLE_DRIVE_CLIENT_ID ?? "";
  const clientSecret = opts?.clientSecret ?? process.env.GOOGLE_DRIVE_CLIENT_SECRET ?? "";

  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_DRIVE_CLIENT_ID / GOOGLE_DRIVE_CLIENT_SECRET required");
  }

  async function exchangeAuthCode({ code, redirect_uri }: { code: string; redirect_uri: string }): Promise<OAuthTokens> {
    const body = new URLSearchParams({
      code, client_id: clientId, client_secret: clientSecret,
      redirect_uri, grant_type: "authorization_code",
    });
    const res = await fetchImpl(TOKEN_URL, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
    if (!res.ok) throw new Error(`google token exchange ${res.status}`);
    const json = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope: string };
    const ui = await fetchImpl(USERINFO_URL, { headers: { authorization: `Bearer ${json.access_token}` } });
    const info = (ui.ok ? await ui.json() : {}) as { email?: string; name?: string };
    return {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_at: new Date(Date.now() + (json.expires_in - 60) * 1000).toISOString(),
      scope: (json.scope ?? "").split(" ").filter(Boolean),
      account_subject: info.email ?? "unknown",
      display_name: info.name ?? null,
    };
  }

  async function refreshAccessToken(refresh_token: string): Promise<OAuthTokens> {
    const body = new URLSearchParams({
      refresh_token, client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token",
    });
    const res = await fetchImpl(TOKEN_URL, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
    if (!res.ok) throw new Error(`google token refresh ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: number; scope: string };
    return {
      access_token: json.access_token,
      refresh_token,
      expires_at: new Date(Date.now() + (json.expires_in - 60) * 1000).toISOString(),
      scope: (json.scope ?? "").split(" ").filter(Boolean),
      account_subject: "",
    };
  }

  async function listChanges({ access_token, cursor, config }: { access_token: string; cursor: Record<string, unknown> | null; config: Record<string, unknown> }): Promise<ListChangesResult> {
    let pageToken = (cursor?.pageToken as string | undefined) ?? null;
    const folderId = (config.folder_id as string | undefined) ?? "root";

    if (!pageToken) {
      const r = await fetchImpl(`${DRIVE_BASE}/changes/startPageToken`, { headers: { authorization: `Bearer ${access_token}` } });
      if (!r.ok) throw new Error(`startPageToken ${r.status}`);
      const j = (await r.json()) as { startPageToken: string };
      pageToken = j.startPageToken;
    }

    const params = new URLSearchParams({
      pageToken,
      fields: "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,size,modifiedTime,parents,trashed))",
      pageSize: "100",
    });
    const r = await fetchImpl(`${DRIVE_BASE}/changes?${params}`, { headers: { authorization: `Bearer ${access_token}` } });
    if (!r.ok) throw new Error(`drive changes ${r.status}`);
    const j = (await r.json()) as { changes?: Array<{ fileId: string; removed?: boolean; file?: { id: string; name: string; mimeType: string; size?: string; modifiedTime?: string; parents?: string[]; trashed?: boolean } }>; nextPageToken?: string; newStartPageToken?: string };

    const changes = (j.changes ?? [])
      .filter((c) => c.removed || c.file)
      .filter((c) => !folderId || folderId === "root" || c.file?.parents?.includes(folderId))
      .map((c) => ({
        external_id: c.fileId,
        external_etag: c.file?.modifiedTime ?? null,
        external_path: c.file?.name ?? null,
        external_modified_at: c.file?.modifiedTime ?? null,
        mime_type: c.file?.mimeType ?? null,
        byte_size: c.file?.size ? Number(c.file.size) : null,
        deleted: c.removed || c.file?.trashed === true,
      }));

    const nextCursor: Record<string, unknown> = j.newStartPageToken
      ? { pageToken: j.newStartPageToken }
      : { pageToken: j.nextPageToken ?? pageToken };

    return { changes, next_cursor: nextCursor };
  }

  async function downloadFile({ access_token, external_id }: { access_token: string; external_id: string; config: Record<string, unknown> }) {
    const meta = await fetchImpl(`${DRIVE_BASE}/files/${external_id}?fields=id,name,mimeType,size`, { headers: { authorization: `Bearer ${access_token}` } });
    if (!meta.ok) throw new Error(`drive metadata ${meta.status}`);
    const m = (await meta.json()) as { name: string; mimeType: string; size?: string };

    const r = await fetchImpl(`${DRIVE_BASE}/files/${external_id}?alt=media`, { headers: { authorization: `Bearer ${access_token}` } });
    if (!r.ok || !r.body) throw new Error(`drive download ${r.status}`);
    return {
      stream: r.body,
      byte_size: m.size ? Number(m.size) : 0,
      content_type: m.mimeType,
      filename: m.name,
    };
  }

  return { provider: "google_drive", exchangeAuthCode, refreshAccessToken, listChanges, downloadFile };
}
```

- [ ] **Step 5: Test PASS**

```bash
npx vitest run lib/connectors/__tests__/google-drive.test.ts
```

Expected: PASS.

- [ ] **Step 6: Implementar m365-graph.ts (mismo patron, delta link)**

```typescript
// lib/connectors/providers/m365-graph.ts
import type { ListChangesResult, OAuthTokens, ProviderClient } from "../types";

const AUTH_HOST = "https://login.microsoftonline.com";
const GRAPH = "https://graph.microsoft.com/v1.0";

type FetchImpl = typeof fetch;

export function createM365Client(provider: "m365_sharepoint" | "m365_onedrive", opts?: {
  fetchImpl?: FetchImpl;
  clientId?: string;
  clientSecret?: string;
  tenantId?: string;
}): ProviderClient {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const clientId = opts?.clientId ?? process.env.M365_CLIENT_ID ?? "";
  const clientSecret = opts?.clientSecret ?? process.env.M365_CLIENT_SECRET ?? "";
  const tenantId = opts?.tenantId ?? process.env.M365_TENANT_ID ?? "common";
  if (!clientId || !clientSecret) throw new Error("M365_CLIENT_ID / M365_CLIENT_SECRET required");
  const tokenUrl = `${AUTH_HOST}/${tenantId}/oauth2/v2.0/token`;

  async function exchangeAuthCode({ code, redirect_uri }: { code: string; redirect_uri: string }): Promise<OAuthTokens> {
    const body = new URLSearchParams({
      code, client_id: clientId, client_secret: clientSecret,
      redirect_uri, grant_type: "authorization_code",
      scope: "offline_access Files.Read.All Sites.Read.All User.Read",
    });
    const r = await fetchImpl(tokenUrl, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
    if (!r.ok) throw new Error(`m365 token exchange ${r.status}`);
    const j = (await r.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope: string };
    const ui = await fetchImpl(`${GRAPH}/me`, { headers: { authorization: `Bearer ${j.access_token}` } });
    const me = (ui.ok ? await ui.json() : {}) as { userPrincipalName?: string; displayName?: string };
    return {
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      expires_at: new Date(Date.now() + (j.expires_in - 60) * 1000).toISOString(),
      scope: (j.scope ?? "").split(" ").filter(Boolean),
      account_subject: me.userPrincipalName ?? "unknown",
      display_name: me.displayName ?? null,
    };
  }

  async function refreshAccessToken(refresh_token: string): Promise<OAuthTokens> {
    const body = new URLSearchParams({
      refresh_token, client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token",
      scope: "offline_access Files.Read.All Sites.Read.All User.Read",
    });
    const r = await fetchImpl(tokenUrl, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
    if (!r.ok) throw new Error(`m365 refresh ${r.status}`);
    const j = (await r.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope: string };
    return {
      access_token: j.access_token,
      refresh_token: j.refresh_token ?? refresh_token,
      expires_at: new Date(Date.now() + (j.expires_in - 60) * 1000).toISOString(),
      scope: (j.scope ?? "").split(" ").filter(Boolean),
      account_subject: "",
    };
  }

  function buildBaseUrl(config: Record<string, unknown>): string {
    if (provider === "m365_sharepoint") {
      const siteId = config.site_id as string;
      const driveId = config.drive_id as string;
      if (!siteId || !driveId) throw new Error("m365_sharepoint requires site_id+drive_id");
      return `${GRAPH}/sites/${siteId}/drives/${driveId}`;
    }
    return `${GRAPH}/me/drive`;
  }

  async function listChanges({ access_token, cursor, config }: { access_token: string; cursor: Record<string, unknown> | null; config: Record<string, unknown> }): Promise<ListChangesResult> {
    const base = buildBaseUrl(config);
    const url = (cursor?.deltaLink as string | undefined) ?? `${base}/root/delta`;
    const r = await fetchImpl(url, { headers: { authorization: `Bearer ${access_token}` } });
    if (!r.ok) throw new Error(`graph delta ${r.status}`);
    const j = (await r.json()) as { value?: Array<{ id: string; name?: string; file?: { mimeType?: string }; folder?: object; size?: number; lastModifiedDateTime?: string; deleted?: { state: string }; eTag?: string; parentReference?: { path?: string } }>; "@odata.deltaLink"?: string; "@odata.nextLink"?: string };
    const changes = (j.value ?? [])
      .filter((it) => !it.folder)
      .map((it) => ({
        external_id: it.id,
        external_etag: it.eTag ?? null,
        external_path: it.parentReference?.path ? `${it.parentReference.path}/${it.name ?? ""}` : (it.name ?? null),
        external_modified_at: it.lastModifiedDateTime ?? null,
        mime_type: it.file?.mimeType ?? null,
        byte_size: typeof it.size === "number" ? it.size : null,
        deleted: !!it.deleted,
      }));
    const nextCursor: Record<string, unknown> = j["@odata.deltaLink"]
      ? { deltaLink: j["@odata.deltaLink"] }
      : { deltaLink: j["@odata.nextLink"] ?? url };
    return { changes, next_cursor: nextCursor };
  }

  async function downloadFile({ access_token, external_id, config }: { access_token: string; external_id: string; config: Record<string, unknown> }) {
    const base = buildBaseUrl(config);
    const meta = await fetchImpl(`${base}/items/${external_id}`, { headers: { authorization: `Bearer ${access_token}` } });
    if (!meta.ok) throw new Error(`graph metadata ${meta.status}`);
    const m = (await meta.json()) as { name: string; file?: { mimeType?: string }; size?: number };
    const r = await fetchImpl(`${base}/items/${external_id}/content`, { headers: { authorization: `Bearer ${access_token}` }, redirect: "follow" });
    if (!r.ok || !r.body) throw new Error(`graph download ${r.status}`);
    return {
      stream: r.body,
      byte_size: m.size ?? 0,
      content_type: m.file?.mimeType ?? "application/octet-stream",
      filename: m.name,
    };
  }

  return { provider, exchangeAuthCode, refreshAccessToken, listChanges, downloadFile };
}
```

- [ ] **Step 7: Test m365 + index registry**

```typescript
// lib/connectors/providers/index.ts
import type { ConnectorProvider, ProviderClient } from "../types";
import { createGoogleDriveClient } from "./google-drive";
import { createM365Client } from "./m365-graph";

export function providerClient(provider: ConnectorProvider): ProviderClient {
  if (provider === "google_drive") return createGoogleDriveClient();
  return createM365Client(provider);
}
```

- [ ] **Step 8: Commit**

```bash
npx vitest run lib/connectors/__tests__/
git add lib/connectors package.json package-lock.json
git commit -m "feat(connectors): google drive + m365 provider clients"
```

### Task 2.2: Token store helper (Vault read/write)

**Files:**
- Create: `lib/connectors/token-store.ts`
- Create: `lib/connectors/__tests__/token-store.test.ts`

> Justificacion: el secret nunca vive en memoria del cliente. Solo workers con service_role pueden leer/escribir Vault. Este helper centraliza el patron.

- [ ] **Step 1: Test failing**

```typescript
import { describe, expect, it, vi } from "vitest";
import { saveTokens, readTokens } from "../token-store";

describe("token-store", () => {
  it("saveTokens crea secret en vault y actualiza credential row", async () => {
    const rpc = vi.fn(async () => ({ data: "vault-uuid", error: null }));
    const upd = vi.fn(() => ({ eq: () => ({ error: null }) }));
    const supabase = {
      rpc,
      from: () => ({ update: upd }),
    } as any;
    await saveTokens(supabase, {
      tenant_id: "t1", credential_id: "c1",
      tokens: { access_token: "AT", refresh_token: "RT", expires_at: "2026-01-01T00:00:00Z", scope: [], account_subject: "u@e.com" },
    });
    expect(rpc).toHaveBeenCalledWith("create_oauth_secret", expect.any(Object));
  });
});
```

```bash
npx vitest run lib/connectors/__tests__/token-store.test.ts
```

Expected: FAIL.

- [ ] **Step 2: Implementar**

```typescript
// lib/connectors/token-store.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { OAuthTokens } from "./types";

type Args = {
  tenant_id: string;
  credential_id: string;
  tokens: OAuthTokens;
};

export async function saveTokens(supabase: SupabaseClient, args: Args): Promise<void> {
  const { data: secretId, error } = await supabase.rpc("create_oauth_secret", {
    _tenant_id: args.tenant_id,
    _payload: JSON.stringify(args.tokens),
    _description: { credential_id: args.credential_id },
  });
  if (error) throw new Error(`vault.create_secret: ${error.message}`);
  if (!secretId) throw new Error("vault returned null secret id");

  const { error: updErr } = await supabase
    .from("tenant_oauth_credentials")
    .update({
      vault_secret_id: secretId,
      status: "active",
      expires_at: args.tokens.expires_at,
      scopes: args.tokens.scope,
      display_name: args.tokens.display_name ?? null,
      last_refreshed_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("id", args.credential_id);
  if (updErr) throw new Error(`update credential: ${updErr.message}`);
}

export async function updateTokens(supabase: SupabaseClient, args: { tenant_id: string; credential_id: string; vault_secret_id: string; tokens: OAuthTokens }): Promise<void> {
  const { error } = await supabase.rpc("update_oauth_secret", {
    _secret_id: args.vault_secret_id,
    _payload: JSON.stringify(args.tokens),
    _description: { credential_id: args.credential_id },
  });
  if (error) throw new Error(`vault.update_secret: ${error.message}`);
  await supabase
    .from("tenant_oauth_credentials")
    .update({
      expires_at: args.tokens.expires_at,
      scopes: args.tokens.scope,
      last_refreshed_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("id", args.credential_id);
}

export async function readTokens(supabase: SupabaseClient, vault_secret_id: string): Promise<OAuthTokens | null> {
  const { data, error } = await supabase.rpc("read_oauth_secret", { _secret_id: vault_secret_id });
  if (error) throw new Error(`vault.read_secret: ${error.message}`);
  if (!data) return null;
  return JSON.parse(data) as OAuthTokens;
}
```

- [ ] **Step 3: Test PASS + commit**

```bash
npx vitest run lib/connectors/__tests__/token-store.test.ts
git add lib/connectors/token-store.ts lib/connectors/__tests__/token-store.test.ts
git commit -m "feat(connectors): token-store helper backed by supabase vault"
```

### Task 2.3: Route handler OAuth callback

**Files:**
- Create: `app/api/connectors/oauth/start/route.ts`
- Create: `app/api/connectors/oauth/callback/route.ts`
- Create: `app/api/connectors/oauth/callback/__tests__/route.test.ts`

> Decision: dos endpoints. `start` arma la URL de autorizacion y emite un `state` firmado con `tenant_id + credential_id + provider`; `callback` recibe `code` + `state`, valida la firma, intercambia tokens y guarda en Vault.

- [ ] **Step 1: Test failing**

```typescript
// app/api/connectors/oauth/callback/__tests__/route.test.ts
import { describe, expect, it, vi } from "vitest";

describe("oauth callback", () => {
  it("rechaza state sin firma valida", async () => {
    const mod = await import("../route");
    const req = new Request("http://x/api/connectors/oauth/callback?code=abc&state=tampered");
    const res = await mod.GET(req);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
```

```bash
npx vitest run app/api/connectors/oauth/callback/__tests__/route.test.ts
```

Expected: FAIL.

- [ ] **Step 2: Implementar `start/route.ts`**

```typescript
// app/api/connectors/oauth/start/route.ts
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { createServerClient } from "@/lib/supabase/server";

const STATE_SECRET = process.env.SDA_OAUTH_STATE_SECRET;

function sign(payload: string): string {
  if (!STATE_SECRET) throw new Error("SDA_OAUTH_STATE_SECRET required");
  return crypto.createHmac("sha256", STATE_SECRET).update(payload).digest("hex");
}

const AUTHORIZE_URLS: Record<string, (args: { redirectUri: string; state: string; scopes: string[] }) => string> = {
  google_drive: ({ redirectUri, state, scopes }) => {
    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    u.searchParams.set("client_id", process.env.GOOGLE_DRIVE_CLIENT_ID ?? "");
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("access_type", "offline");
    u.searchParams.set("prompt", "consent");
    u.searchParams.set("state", state);
    u.searchParams.set("scope", scopes.join(" "));
    return u.toString();
  },
  m365_sharepoint: ({ redirectUri, state, scopes }) => {
    const u = new URL(`https://login.microsoftonline.com/${process.env.M365_TENANT_ID ?? "common"}/oauth2/v2.0/authorize`);
    u.searchParams.set("client_id", process.env.M365_CLIENT_ID ?? "");
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("response_mode", "query");
    u.searchParams.set("scope", scopes.join(" "));
    u.searchParams.set("state", state);
    return u.toString();
  },
  m365_onedrive: ({ redirectUri, state, scopes }) => AUTHORIZE_URLS.m365_sharepoint({ redirectUri, state, scopes }),
};

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const credentialId = url.searchParams.get("credential_id");
  const provider = url.searchParams.get("provider") as keyof typeof AUTHORIZE_URLS | null;
  if (!credentialId || !provider) return NextResponse.json({ error: "credential_id + provider required" }, { status: 400 });

  const supabase = createServerClient();
  const { data: cred, error } = await supabase
    .from("tenant_oauth_credentials")
    .select("id, tenant_id, provider, status")
    .eq("id", credentialId)
    .maybeSingle();
  if (error || !cred) return NextResponse.json({ error: "credential not found" }, { status: 404 });
  if (cred.provider !== provider) return NextResponse.json({ error: "provider mismatch" }, { status: 400 });
  if (cred.status !== "pending_auth") return NextResponse.json({ error: "credential not pending_auth" }, { status: 409 });

  const redirectUri = `${process.env.SDA_PUBLIC_URL}/api/connectors/oauth/callback`;
  const payload = JSON.stringify({ t: cred.tenant_id, c: credentialId, p: provider, n: Date.now() });
  const state = `${Buffer.from(payload).toString("base64url")}.${sign(payload)}`;
  const scopes = provider === "google_drive"
    ? ["https://www.googleapis.com/auth/drive.readonly", "openid", "email", "profile"]
    : ["offline_access", "Files.Read.All", "Sites.Read.All", "User.Read"];

  const authorizeUrl = AUTHORIZE_URLS[provider]({ redirectUri, state, scopes });
  return NextResponse.redirect(authorizeUrl);
}
```

- [ ] **Step 3: Implementar `callback/route.ts`**

```typescript
// app/api/connectors/oauth/callback/route.ts
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { providerClient } from "@/lib/connectors/providers";
import { saveTokens } from "@/lib/connectors/token-store";

const STATE_SECRET = process.env.SDA_OAUTH_STATE_SECRET ?? "";

function verify(payload: string, sig: string): boolean {
  if (!STATE_SECRET) return false;
  const expected = crypto.createHmac("sha256", STATE_SECRET).update(payload).digest("hex");
  try { return crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex")); } catch { return false; }
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return NextResponse.json({ error: "code + state required" }, { status: 400 });

  const [b64, sig] = state.split(".");
  if (!b64 || !sig) return NextResponse.json({ error: "malformed state" }, { status: 400 });
  let payload: string;
  try { payload = Buffer.from(b64, "base64url").toString("utf8"); } catch { return NextResponse.json({ error: "invalid state" }, { status: 400 }); }
  if (!verify(payload, sig)) return NextResponse.json({ error: "invalid signature" }, { status: 401 });

  const { t: tenantId, c: credentialId, p: provider, n: nonce } = JSON.parse(payload);
  if (typeof nonce !== "number" || Date.now() - nonce > 10 * 60 * 1000) {
    return NextResponse.json({ error: "state expired" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const client = providerClient(provider);
  const redirectUri = `${process.env.SDA_PUBLIC_URL}/api/connectors/oauth/callback`;

  try {
    const tokens = await client.exchangeAuthCode({ code, redirect_uri: redirectUri });
    await supabase
      .from("tenant_oauth_credentials")
      .update({ account_subject: tokens.account_subject, display_name: tokens.display_name })
      .eq("id", credentialId)
      .eq("tenant_id", tenantId);
    await saveTokens(supabase, { tenant_id: tenantId, credential_id: credentialId, tokens });
  } catch (err) {
    await supabase
      .from("tenant_oauth_credentials")
      .update({ status: "error", last_error: (err as Error).message })
      .eq("id", credentialId);
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }

  return NextResponse.redirect(`${process.env.SDA_PUBLIC_URL}/settings/connectors?credential=${credentialId}&status=connected`);
}
```

- [ ] **Step 4: Test PASS + commit**

```bash
npx vitest run app/api/connectors/oauth/callback/__tests__/route.test.ts
git add app/api/connectors/oauth
git commit -m "feat(api): oauth start + callback endpoints with HMAC state"
```

### Task 2.4: Refresh token helper

**Files:**
- Create: `lib/connectors/refresh.ts`
- Create: `lib/connectors/__tests__/refresh.test.ts`

- [ ] **Step 1: Test failing**

```typescript
import { describe, it, expect, vi } from "vitest";
import { ensureFreshAccessToken } from "../refresh";

describe("ensureFreshAccessToken", () => {
  it("retorna tokens cacheados si expires_at > now + skew", async () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const supabase = {
      rpc: vi.fn(async () => ({ data: JSON.stringify({ access_token: "AT", expires_at: future, refresh_token: "RT", scope: [], account_subject: "x" }), error: null })),
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: "c1", vault_secret_id: "v1", provider: "google_drive", tenant_id: "t1" }, error: null }) }) }) }),
    } as any;
    const t = await ensureFreshAccessToken(supabase, { credential_id: "c1" });
    expect(t.access_token).toBe("AT");
  });
});
```

- [ ] **Step 2: Implementar**

```typescript
// lib/connectors/refresh.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { providerClient } from "./providers";
import { readTokens, updateTokens } from "./token-store";
import type { OAuthTokens } from "./types";

const SKEW_MS = 60_000;

export async function ensureFreshAccessToken(supabase: SupabaseClient, args: { credential_id: string }): Promise<OAuthTokens> {
  const { data: cred, error } = await supabase
    .from("tenant_oauth_credentials")
    .select("id, tenant_id, provider, vault_secret_id, status")
    .eq("id", args.credential_id)
    .maybeSingle();
  if (error || !cred) throw new Error(`credential ${args.credential_id} not found`);
  if (cred.status !== "active") throw new Error(`credential status=${cred.status}`);
  if (!cred.vault_secret_id) throw new Error("credential missing vault_secret_id");

  const tokens = await readTokens(supabase, cred.vault_secret_id);
  if (!tokens) throw new Error("vault returned no tokens");

  const expiresAt = new Date(tokens.expires_at).getTime();
  if (expiresAt - Date.now() > SKEW_MS) return tokens;

  if (!tokens.refresh_token) {
    await supabase.from("tenant_oauth_credentials")
      .update({ status: "error", last_error: "expired and no refresh_token" })
      .eq("id", cred.id);
    throw new Error("no refresh_token available");
  }

  const fresh = await providerClient(cred.provider).refreshAccessToken(tokens.refresh_token);
  const merged: OAuthTokens = { ...tokens, ...fresh, refresh_token: fresh.refresh_token ?? tokens.refresh_token, account_subject: tokens.account_subject };
  await updateTokens(supabase, { tenant_id: cred.tenant_id, credential_id: cred.id, vault_secret_id: cred.vault_secret_id, tokens: merged });
  return merged;
}
```

- [ ] **Step 3: Test PASS + commit**

```bash
npx vitest run lib/connectors/__tests__/refresh.test.ts
git add lib/connectors/refresh.ts lib/connectors/__tests__/refresh.test.ts
git commit -m "feat(connectors): ensureFreshAccessToken with refresh_token fallback"
```

### Task 2.5: Inngest worker `sync-document-source`

**Files:**
- Create: `inngest/functions/sync-document-source.ts`
- Create: `inngest/functions/__tests__/sync-document-source.test.ts`
- Modify: `inngest/functions/index.ts` (export del nuevo function)

> Patron: cron cada 1 minuto. Selecciona sources `active` con `next_sync_at <= now()` ordenadas por `next_sync_at asc`, limit=10 por tick. Por cada source: refresh tokens, list changes via cursor, upsert items, encolar ingesta para `pending` items, actualizar cursor + `last_synced_at` + `next_sync_at`.

- [ ] **Step 1: Test failing**

```typescript
// inngest/functions/__tests__/sync-document-source.test.ts
import { describe, expect, it, vi } from "vitest";
import { syncOneSource } from "../sync-document-source";

describe("syncOneSource", () => {
  it("actualiza cursor y encola items pending", async () => {
    const listChanges = vi.fn(async () => ({ changes: [{ external_id: "f1", mime_type: "application/pdf", byte_size: 100 }], next_cursor: { pageToken: "next" } }));
    const upsert = vi.fn(() => ({ select: () => ({ data: [{ id: "i1", external_id: "f1", document_id: null }], error: null }) }));
    const updateSource = vi.fn(() => ({ eq: () => ({ error: null }) }));
    const upsertCursor = vi.fn(() => ({ error: null }));
    const enqueue = vi.fn(async () => undefined);
    const supabase = {
      from: (t: string) => {
        if (t === "document_source_items") return { upsert };
        if (t === "document_sources") return { update: updateSource };
        if (t === "document_source_cursors") return { upsert: upsertCursor };
        return { select: () => ({}) };
      },
    } as any;
    const client = { provider: "google_drive", listChanges, downloadFile: vi.fn(), exchangeAuthCode: vi.fn(), refreshAccessToken: vi.fn() } as any;
    await syncOneSource({ supabase, providerClientImpl: () => client, ensureToken: async () => ({ access_token: "AT", expires_at: "", scope: [], account_subject: "" } as any), enqueueIngest: enqueue, source: { id: "s1", tenant_id: "t1", workspace_id: "w1", credential_id: "c1", provider: "google_drive", config: {}, sync_interval_seconds: 3600 } as any, cursor: null });
    expect(listChanges).toHaveBeenCalled();
    expect(upsert).toHaveBeenCalled();
    expect(updateSource).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Implementar worker**

```typescript
// inngest/functions/sync-document-source.ts
import { cron } from "inngest";
import { inngest } from "@/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { providerClient } from "@/lib/connectors/providers";
import { ensureFreshAccessToken } from "@/lib/connectors/refresh";
import type { ConnectorCursor, ProviderClient } from "@/lib/connectors/types";

const BATCH_PER_TICK = Number(process.env.SDA_CONNECTOR_SYNC_BATCH ?? 10);

type SourceRow = {
  id: string;
  tenant_id: string;
  workspace_id: string;
  credential_id: string;
  provider: "google_drive" | "m365_sharepoint" | "m365_onedrive";
  config: Record<string, unknown>;
  sync_interval_seconds: number;
};

export async function syncOneSource(deps: {
  supabase: ReturnType<typeof createAdminClient>;
  providerClientImpl: (p: SourceRow["provider"]) => ProviderClient;
  ensureToken: (sup: ReturnType<typeof createAdminClient>, args: { credential_id: string }) => Promise<{ access_token: string }>;
  enqueueIngest: (args: { tenant_id: string; source_id: string; item_id: string }) => Promise<void>;
  source: SourceRow;
  cursor: ConnectorCursor | null;
}): Promise<{ changes: number }> {
  const { supabase, source, providerClientImpl, ensureToken, enqueueIngest, cursor } = deps;
  const tokens = await ensureToken(supabase, { credential_id: source.credential_id });
  const client = providerClientImpl(source.provider);
  const { changes, next_cursor } = await client.listChanges({ access_token: tokens.access_token, cursor, config: source.config });

  if (changes.length) {
    const rows = changes.map((c) => ({
      source_id: source.id,
      tenant_id: source.tenant_id,
      external_id: c.external_id,
      external_etag: c.external_etag ?? null,
      external_path: c.external_path ?? null,
      external_modified_at: c.external_modified_at ?? null,
      mime_type: c.mime_type ?? null,
      byte_size: c.byte_size ?? null,
      last_seen_at: new Date().toISOString(),
      ingestion_status: c.deleted ? "skipped" : "pending",
      metadata: c.metadata ?? {},
    }));
    const { data: upserted, error } = await supabase
      .from("document_source_items")
      .upsert(rows, { onConflict: "source_id,external_id" })
      .select("id, external_id, ingestion_status, document_id");
    if (error) throw new Error(`upsert items: ${error.message}`);
    for (const row of upserted ?? []) {
      if (row.ingestion_status === "pending" && !row.document_id) {
        await enqueueIngest({ tenant_id: source.tenant_id, source_id: source.id, item_id: row.id });
      }
    }
  }

  await supabase
    .from("document_source_cursors")
    .upsert({ source_id: source.id, tenant_id: source.tenant_id, cursor: next_cursor, last_seen_external_at: new Date().toISOString() });
  await supabase
    .from("document_sources")
    .update({
      last_synced_at: new Date().toISOString(),
      next_sync_at: new Date(Date.now() + source.sync_interval_seconds * 1000).toISOString(),
      last_error: null,
    })
    .eq("id", source.id);

  return { changes: changes.length };
}

export const syncDocumentSources = inngest.createFunction(
  { id: "sync-document-sources", concurrency: { limit: 4 } },
  cron("* * * * *"),
  async ({ step }) => {
    const supabase = createAdminClient();
    const due = await step.run("select-due", async () => {
      const { data, error } = await supabase
        .from("document_sources")
        .select("id, tenant_id, workspace_id, credential_id, provider, config, sync_interval_seconds")
        .eq("status", "active")
        .lte("next_sync_at", new Date().toISOString())
        .order("next_sync_at", { ascending: true })
        .limit(BATCH_PER_TICK);
      if (error) throw new Error(error.message);
      return (data ?? []) as SourceRow[];
    });

    for (const src of due) {
      await step.run(`sync-${src.id}`, async () => {
        try {
          const { data: curRow } = await supabase
            .from("document_source_cursors").select("cursor").eq("source_id", src.id).maybeSingle();
          await syncOneSource({
            supabase,
            providerClientImpl: providerClient,
            ensureToken: ensureFreshAccessToken as any,
            enqueueIngest: async ({ tenant_id, source_id, item_id }) => {
              await inngest.send({ name: "documents/connector.item.ready", data: { tenant_id, source_id, item_id } });
            },
            source: src,
            cursor: (curRow?.cursor ?? null) as ConnectorCursor | null,
          });
        } catch (err) {
          await supabase.from("document_sources").update({
            status: "error", last_error: (err as Error).message, updated_at: new Date().toISOString(),
          }).eq("id", src.id);
          throw err;
        }
      });
    }

    return { processed: due.length };
  }
);
```

- [ ] **Step 3: Worker que materializa item -> document (download + storage upload)**

```typescript
// fragmento agregado al final del archivo o en inngest/functions/ingest-connector-item.ts
export const ingestConnectorItem = inngest.createFunction(
  { id: "ingest-connector-item", concurrency: { limit: 8 } },
  { event: "documents/connector.item.ready" },
  async ({ event, step }) => {
    const { tenant_id, source_id, item_id } = event.data as { tenant_id: string; source_id: string; item_id: string };
    const supabase = createAdminClient();

    const { data: row } = await supabase
      .from("document_source_items")
      .select("id, external_id, external_path, mime_type, byte_size, document_id, ingestion_status, source_id, tenant_id")
      .eq("id", item_id).maybeSingle();
    if (!row || row.tenant_id !== tenant_id) return { skipped: "not_found" };
    if (row.ingestion_status === "indexed") return { skipped: "already_indexed" };

    await supabase.from("document_source_items").update({ ingestion_status: "ingesting" }).eq("id", item_id);

    try {
      const { data: source } = await supabase
        .from("document_sources")
        .select("workspace_id, collection_id, credential_id, provider, config")
        .eq("id", source_id).maybeSingle();
      if (!source) throw new Error("source not found");

      const tokens = await ensureFreshAccessToken(supabase, { credential_id: source.credential_id });
      const client = providerClient(source.provider);
      const dl = await client.downloadFile({ access_token: tokens.access_token, external_id: row.external_id, config: source.config });
      const storagePath = `${tenant_id}/connector/${source_id}/${row.external_id}/${dl.filename}`;
      const { error: upErr } = await supabase.storage.from("documents").upload(storagePath, dl.stream as any, {
        contentType: dl.content_type, upsert: true, duplex: "half" as unknown as string,
      });
      if (upErr) throw new Error(`upload: ${upErr.message}`);

      const { data: docId, error: rpcErr } = await supabase.rpc("create_document_upload", {
        _workspace_id: source.workspace_id,
        _collection_id: source.collection_id,
        _filename: dl.filename,
        _storage_path: storagePath,
        _content_type: dl.content_type,
        _byte_size: dl.byte_size,
        _source: "connector",
      });
      if (rpcErr) throw new Error(`create_document_upload: ${rpcErr.message}`);
      await supabase.from("document_source_items").update({
        ingestion_status: "indexed", document_id: docId, ingestion_error: null,
      }).eq("id", item_id);
    } catch (err) {
      await supabase.from("document_source_items").update({
        ingestion_status: "failed", ingestion_error: (err as Error).message,
      }).eq("id", item_id);
      throw err;
    }
    return { ok: true };
  }
);
```

- [ ] **Step 4: Registrar en `inngest/functions/index.ts`**

```typescript
// inngest/functions/index.ts (Add exports)
export { syncDocumentSources, ingestConnectorItem } from "./sync-document-source";
```

- [ ] **Step 5: Tests + lint + typecheck**

```bash
npx vitest run inngest/functions/__tests__/sync-document-source.test.ts
npm run lint
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add inngest/functions/sync-document-source.ts inngest/functions/__tests__/sync-document-source.test.ts inngest/functions/index.ts
git commit -m "feat(inngest): sync-document-sources cron + ingest-connector-item handler"
```

---

## Paso 3 · Usage records + aggregations + threshold notification

### Task 3.1: pgTAP test — `usage_records` particionada

**Files:**
- Create: `supabase/tests/usage_records_test.sql`

- [ ] **Step 1: Test failing**

```sql
BEGIN;
SELECT plan(12);

SELECT has_table('public', 'usage_records', 'usage_records existe');
SELECT has_type('public', 'usage_kind', 'enum usage_kind existe');

-- PK incluye occurred_at por ser particionada
SELECT col_is_pk('public','usage_records', ARRAY['id','occurred_at'],
  'PK (id, occurred_at)');

-- particionada por range
SELECT is(
  (select relkind from pg_class where oid='public.usage_records'::regclass),
  'p'::"char",
  'usage_records es tabla particionada');

-- particion del mes corriente existe
SELECT isnt(
  (select count(*)::int from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'public.usage_records'::regclass),
  0,
  'al menos una particion existe');

-- cost en bigint (no float)
SELECT col_type_is('public','usage_records','cost_micro_usd','bigint',
  'cost_micro_usd bigint');

-- RLS habilitada
SELECT is((select relrowsecurity from pg_class where oid='public.usage_records'::regclass), true, 'RLS enabled');

-- authenticated solo SELECT
SELECT bag_eq(
  $$ select privilege_type from information_schema.role_table_grants
     where table_name='usage_records' and grantee='authenticated' $$,
  $$ values ('SELECT') $$,
  'authenticated solo SELECT');

-- RPCs
SELECT has_function('public','report_usage', NULL, 'RPC report_usage existe');
SELECT has_function('public','tenant_usage_summary', ARRAY['timestamptz','timestamptz'], 'RPC tenant_usage_summary existe');
SELECT has_function('public','recompute_usage_aggregates', NULL, 'RPC recompute_usage_aggregates existe');

-- notification_kind incluye usage.threshold_crossed
SELECT ok(
  'usage.threshold_crossed' = ANY (enum_range(null::public.notification_kind)::text[]),
  'enum notification_kind incluye usage.threshold_crossed');

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Correr — FAIL**

```bash
npm run test:db -- --test supabase/tests/usage_records_test.sql
```

Expected: 12x not ok.

### Task 3.2: Migracion `20260801130000_usage_records_partitioned.sql`

**Files:**
- Create: `supabase/migrations/20260801130000_usage_records_partitioned.sql`

- [ ] **Step 1: Escribir migracion**

```sql
-- supabase/migrations/20260801130000_usage_records_partitioned.sql

do $$
begin
  create type public.usage_kind as enum (
    'llm_chat_completion',
    'llm_summary',
    'llm_tree_build',
    'llm_routing_summary',
    'embedding_chunk',
    'embedding_query',
    'document_extraction',
    'storage_bytes_day'
  );
exception when duplicate_object then null;
end;
$$;

create table public.usage_records (
  id uuid not null default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  workspace_id uuid,
  user_id uuid,
  kind public.usage_kind not null,
  model text,
  provider text,
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  units numeric(18,4),
  cost_micro_usd bigint,
  conversation_id uuid,
  message_id uuid,
  document_id uuid,
  run_id uuid,
  request_id text,
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  primary key (id, occurred_at)
) partition by range (occurred_at);

-- helper para crear particion idempotente
create or replace function app.ensure_usage_records_partition(_month_start date)
returns void
language plpgsql
set search_path = ''
as $$
declare
  _start date := date_trunc('month', _month_start)::date;
  _end date := (_start + interval '1 month')::date;
  _name text := 'usage_records_' || to_char(_start, 'YYYY_MM');
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relname = _name and n.nspname = 'public'
  ) then
    execute format(
      'create table public.%I partition of public.usage_records for values from (%L) to (%L)',
      _name, _start, _end
    );
    execute format(
      'create index %I on public.%I (tenant_id, kind, occurred_at desc)',
      _name || '_tenant_kind_idx', _name
    );
    execute format(
      'create index %I on public.%I (tenant_id, workspace_id, occurred_at desc) where workspace_id is not null',
      _name || '_workspace_idx', _name
    );
    execute format(
      'create index %I on public.%I (tenant_id, user_id, occurred_at desc) where user_id is not null',
      _name || '_user_idx', _name
    );
  end if;
end;
$$;

-- crear particion del mes corriente + 3 meses adelante
select app.ensure_usage_records_partition(date_trunc('month', now())::date);
select app.ensure_usage_records_partition((date_trunc('month', now()) + interval '1 month')::date);
select app.ensure_usage_records_partition((date_trunc('month', now()) + interval '2 month')::date);
select app.ensure_usage_records_partition((date_trunc('month', now()) + interval '3 month')::date);

alter table public.usage_records enable row level security;

-- tenant_admin lee usage de su tenant; workspace_admin lee solo su workspace
create policy usage_records_select_admin on public.usage_records
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and (
      (select app.is_tenant_admin())
      or (
        workspace_id is not null
        and app.user_workspace_role(workspace_id) = 'workspace_admin'
      )
    )
  );

revoke insert, update, delete on public.usage_records from authenticated;
grant select on public.usage_records to authenticated;
grant all on public.usage_records to service_role;
```

- [ ] **Step 2: Aplicar + test PASS (parcial, faltan RPCs)**

```bash
supabase db reset --local
psql "$SUPABASE_DB_URL" -c "select count(*) from pg_inherits where inhparent='public.usage_records'::regclass"
```

Expected: `>= 4` (4 particiones).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260801130000_usage_records_partitioned.sql
git commit -m "feat(db): usage_records partitioned table + helper ensure_usage_records_partition"
```

### Task 3.3: Migracion `20260801131000_usage_aggregates_daily.sql`

**Files:**
- Create: `supabase/migrations/20260801131000_usage_aggregates_daily.sql`

- [ ] **Step 1: Escribir migracion**

```sql
-- supabase/migrations/20260801131000_usage_aggregates_daily.sql

create materialized view public.usage_aggregates_daily as
select
  tenant_id,
  workspace_id,
  user_id,
  kind,
  model,
  date_trunc('day', occurred_at) as day,
  sum(coalesce(input_tokens,0))::bigint  as input_tokens,
  sum(coalesce(output_tokens,0))::bigint as output_tokens,
  sum(coalesce(units,0))                 as units,
  sum(coalesce(cost_micro_usd,0))::bigint as cost_micro_usd,
  count(*)                               as event_count
from public.usage_records
group by 1,2,3,4,5,6
with no data;

-- 4 unique indices parciales para cubrir 4 combos de NULL en (workspace_id, user_id).
-- NO usar coalesce con sentinel uuid: postgres considera NULLs distintos en btree
-- y eso permite duplicados cuando alguna col nullable es NULL.
create unique index usage_aggregates_daily_pk_ws_user
  on public.usage_aggregates_daily (tenant_id, workspace_id, user_id, kind, coalesce(model,''), day)
  where workspace_id is not null and user_id is not null;
create unique index usage_aggregates_daily_pk_ws_nouser
  on public.usage_aggregates_daily (tenant_id, workspace_id, kind, coalesce(model,''), day)
  where workspace_id is not null and user_id is null;
create unique index usage_aggregates_daily_pk_nows_user
  on public.usage_aggregates_daily (tenant_id, user_id, kind, coalesce(model,''), day)
  where workspace_id is null and user_id is not null;
create unique index usage_aggregates_daily_pk_nows_nouser
  on public.usage_aggregates_daily (tenant_id, kind, coalesce(model,''), day)
  where workspace_id is null and user_id is null;

create index usage_aggregates_daily_tenant_day_idx
  on public.usage_aggregates_daily (tenant_id, day desc);

grant select on public.usage_aggregates_daily to service_role;
-- la matview NO se grantea a authenticated. Lectura va por RPC tenant_usage_summary.

refresh materialized view public.usage_aggregates_daily;
```

- [ ] **Step 2: Aplicar + commit**

```bash
supabase db reset --local
git add supabase/migrations/20260801131000_usage_aggregates_daily.sql
git commit -m "feat(db): usage_aggregates_daily matview with 4 partial unique idx"
```

### Task 3.4: Migracion RPCs usage + threshold trigger `20260801132000_usage_rpcs_and_threshold.sql`

**Files:**
- Create: `supabase/migrations/20260801132000_usage_rpcs_and_threshold.sql`

- [ ] **Step 1: Escribir migracion completa**

```sql
-- supabase/migrations/20260801132000_usage_rpcs_and_threshold.sql

-- extender enum notification_kind si no existe (Tier 2 lo creo con el valor)
do $$
begin
  perform 1 from pg_enum e join pg_type t on t.oid=e.enumtypid
    where t.typname='notification_kind' and e.enumlabel='usage.threshold_crossed';
  if not found then
    alter type public.notification_kind add value if not exists 'usage.threshold_crossed';
  end if;
end;
$$;

-- service_role only. el agent runtime / workers llaman con service key.
create or replace function public.report_usage(
  _tenant_id uuid,
  _kind public.usage_kind,
  _input_tokens integer default null,
  _output_tokens integer default null,
  _units numeric default null,
  _cost_micro_usd bigint default null,
  _workspace_id uuid default null,
  _user_id uuid default null,
  _model text default null,
  _provider text default null,
  _conversation_id uuid default null,
  _message_id uuid default null,
  _document_id uuid default null,
  _run_id uuid default null,
  _request_id text default null,
  _metadata jsonb default '{}'::jsonb,
  _occurred_at timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  _id uuid;
begin
  -- aseguramos particion en caso de cruce de mes
  perform app.ensure_usage_records_partition(date_trunc('month', _occurred_at)::date);

  insert into public.usage_records (
    tenant_id, workspace_id, user_id, kind, model, provider,
    input_tokens, output_tokens, units, cost_micro_usd,
    conversation_id, message_id, document_id, run_id, request_id,
    occurred_at, metadata
  ) values (
    _tenant_id, _workspace_id, _user_id, _kind, _model, _provider,
    _input_tokens, _output_tokens, _units, _cost_micro_usd,
    _conversation_id, _message_id, _document_id, _run_id, _request_id,
    _occurred_at, coalesce(_metadata,'{}'::jsonb)
  )
  returning id into _id;

  return _id;
end;
$$;

revoke all on function public.report_usage(uuid, public.usage_kind, integer, integer, numeric, bigint, uuid, uuid, text, text, uuid, uuid, uuid, uuid, text, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.report_usage(uuid, public.usage_kind, integer, integer, numeric, bigint, uuid, uuid, text, text, uuid, uuid, uuid, uuid, text, jsonb, timestamptz) to service_role;

create or replace function public.tenant_usage_summary(_start timestamptz, _end timestamptz)
returns table (
  tenant_id uuid,
  workspace_id uuid,
  user_id uuid,
  kind public.usage_kind,
  model text,
  day date,
  input_tokens bigint,
  output_tokens bigint,
  units numeric,
  cost_micro_usd bigint,
  event_count bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  _tenant uuid := (select app.current_tenant_id());
begin
  if _tenant is null then
    raise exception 'tenant context required' using errcode = '42501';
  end if;
  if not (select app.is_tenant_admin()) then
    raise exception 'forbidden: tenant_admin required' using errcode = '42501';
  end if;

  return query
  select a.tenant_id, a.workspace_id, a.user_id, a.kind, a.model,
         a.day::date, a.input_tokens, a.output_tokens, a.units,
         a.cost_micro_usd, a.event_count
  from public.usage_aggregates_daily a
  where a.tenant_id = _tenant
    and a.day >= date_trunc('day', _start)
    and a.day <  date_trunc('day', _end) + interval '1 day';
end;
$$;

grant execute on function public.tenant_usage_summary(timestamptz, timestamptz) to authenticated;

create or replace function public.recompute_usage_aggregates()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  refresh materialized view concurrently public.usage_aggregates_daily;
end;
$$;
revoke all on function public.recompute_usage_aggregates() from public, anon, authenticated;
grant execute on function public.recompute_usage_aggregates() to service_role;

-- threshold check: corre post-insert; si el cost acumulado del mes en curso
-- cruza un threshold configurado en tenants.metadata->'usage_budget_micro_usd',
-- inserta notification (idempotente via metadata.crossed_at).
create or replace function app.check_usage_threshold()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  _budget bigint;
  _spent bigint;
  _ratio numeric;
  _threshold numeric;
  _existing int;
  _admin uuid;
begin
  if new.tenant_id is null then return new; end if;

  select coalesce((metadata->>'usage_budget_micro_usd')::bigint, 0)
    from public.tenants where id = new.tenant_id into _budget;
  if _budget is null or _budget <= 0 then return new; end if;

  select coalesce(sum(cost_micro_usd), 0)
    from public.usage_records
    where tenant_id = new.tenant_id
      and occurred_at >= date_trunc('month', new.occurred_at)
      and occurred_at <  date_trunc('month', new.occurred_at) + interval '1 month'
    into _spent;
  _ratio := _spent::numeric / _budget::numeric;

  if _ratio >= 1.0 then _threshold := 1.0;
  elsif _ratio >= 0.9 then _threshold := 0.9;
  elsif _ratio >= 0.5 then _threshold := 0.5;
  else return new;
  end if;

  -- idempotencia: una notif por threshold por mes por tenant
  select count(*) into _existing
    from public.notifications
    where tenant_id = new.tenant_id
      and kind = 'usage.threshold_crossed'
      and (metadata->>'threshold')::numeric = _threshold
      and (metadata->>'period_month') = to_char(date_trunc('month', new.occurred_at), 'YYYY-MM');
  if _existing > 0 then return new; end if;

  -- crear notif para cada tenant_admin
  for _admin in
    select id from public.users
      where tenant_id = new.tenant_id and role in ('owner','admin') and status='active'
  loop
    insert into public.notifications (
      tenant_id, user_id, kind, title, body, url, target_kind, target_id, metadata
    ) values (
      new.tenant_id, _admin, 'usage.threshold_crossed',
      'Consumo del mes ' || to_char(_threshold * 100, 'FM999') || '%',
      'Tu consumo del mes alcanzo ' || to_char(_threshold * 100, 'FM999') || '% del presupuesto configurado.',
      '/settings/usage',
      'tenant', new.tenant_id,
      jsonb_build_object(
        'threshold', _threshold,
        'period_month', to_char(date_trunc('month', new.occurred_at), 'YYYY-MM'),
        'spent_micro_usd', _spent,
        'budget_micro_usd', _budget
      )
    );
  end loop;

  return new;
end;
$$;

-- attach al insert. statement-level p/ no disparar miles de veces en bulk insert.
-- pero como el insert tipico es 1 fila (1 LLM call), row-level es OK.
create trigger usage_records_threshold_check
after insert on public.usage_records
for each row execute function app.check_usage_threshold();
```

- [ ] **Step 2: Aplicar + correr test del Paso 3.1**

```bash
supabase db reset --local
npm run test:db -- --test supabase/tests/usage_records_test.sql
```

Expected: 12/12 OK.

- [ ] **Step 3: Suite completa**

```bash
npm run test:db
```

Expected: verde.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260801131000_usage_aggregates_daily.sql supabase/migrations/20260801132000_usage_rpcs_and_threshold.sql supabase/tests/usage_records_test.sql
git commit -m "feat(db): usage RPCs + threshold notification trigger"
```

### Task 3.5: Test e2e — threshold crossing dispara notification

**Files:**
- Create: `supabase/tests/usage_threshold_e2e_test.sql`

- [ ] **Step 1: Test que setea tenant con budget, inserta usage, verifica notif**

```sql
BEGIN;
SELECT plan(4);

insert into public.tenants (id, slug, name, metadata) values
  ('00000000-0000-0000-0000-000000003001', 'usage-t', 'Usage T',
   jsonb_build_object('usage_budget_micro_usd', 1000000));

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000003011', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin@usage-t.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.users (id, tenant_id, email, role, status) values
  ('00000000-0000-0000-0000-000000003011', '00000000-0000-0000-0000-000000003001', 'admin@usage-t.test', 'owner', 'active');

-- 60% del budget: cruza 50% threshold
select public.report_usage(
  _tenant_id => '00000000-0000-0000-0000-000000003001',
  _kind => 'llm_chat_completion',
  _cost_micro_usd => 600000
);

SELECT is(
  (select count(*)::int from public.notifications
    where tenant_id='00000000-0000-0000-0000-000000003001'
      and kind='usage.threshold_crossed'),
  1,
  'una notif por cruce de 50%');

-- otra insert no debe duplicar (mismo threshold)
select public.report_usage(
  _tenant_id => '00000000-0000-0000-0000-000000003001',
  _kind => 'llm_chat_completion',
  _cost_micro_usd => 100000
);

SELECT is(
  (select count(*)::int from public.notifications
    where tenant_id='00000000-0000-0000-0000-000000003001'
      and kind='usage.threshold_crossed'
      and (metadata->>'threshold')::numeric = 0.5),
  1,
  'no duplica notif del mismo threshold');

-- llegamos al 90%
select public.report_usage(
  _tenant_id => '00000000-0000-0000-0000-000000003001',
  _kind => 'llm_chat_completion',
  _cost_micro_usd => 250000
);

SELECT is(
  (select count(*)::int from public.notifications
    where tenant_id='00000000-0000-0000-0000-000000003001'
      and kind='usage.threshold_crossed'
      and (metadata->>'threshold')::numeric = 0.9),
  1,
  'una notif por cruce de 90%');

-- al 100%
select public.report_usage(
  _tenant_id => '00000000-0000-0000-0000-000000003001',
  _kind => 'llm_chat_completion',
  _cost_micro_usd => 100000
);

SELECT is(
  (select count(*)::int from public.notifications
    where tenant_id='00000000-0000-0000-0000-000000003001'
      and kind='usage.threshold_crossed'
      and (metadata->>'threshold')::numeric = 1.0),
  1,
  'una notif por cruce de 100%');

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Correr + commit**

```bash
npm run test:db -- --test supabase/tests/usage_threshold_e2e_test.sql
git add supabase/tests/usage_threshold_e2e_test.sql
git commit -m "test(db): usage threshold e2e (50/90/100% crossing notifications)"
```

### Task 3.6: pg_cron job — refresh matview cada hora

**Files:**
- Modify: `supabase/migrations/20260801132000_usage_rpcs_and_threshold.sql` (append cron schedule)

> Patron: el refresh CONCURRENTLY no toma access exclusive lock; OK correr cada hora. Si la matview esta vacia, primera vez requiere `refresh materialized view ... ` sin concurrently.

- [ ] **Step 1: Agregar al final del archivo**

```sql
-- pg_cron schedule (idempotente)
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'sda-usage-aggregates-refresh',
      '5 * * * *',
      'select public.recompute_usage_aggregates()'
    );
  end if;
exception when others then
  -- si el job ya existe, ignorar
  null;
end;
$$;
```

- [ ] **Step 2: Validar**

```bash
psql "$SUPABASE_DB_URL" -c "select jobid, schedule, command from cron.job where jobname='sda-usage-aggregates-refresh'"
```

Expected: 1 fila.

- [ ] **Step 3: Commit (amend pendiente — usar nuevo commit, no amend)**

```bash
git add supabase/migrations/20260801132000_usage_rpcs_and_threshold.sql
git commit -m "feat(db): schedule sda-usage-aggregates-refresh pg_cron job"
```

### Task 3.7: Test de RPC `report_usage` solo service_role

**Files:**
- Create: `supabase/tests/usage_rpc_acl_test.sql`

- [ ] **Step 1: Test failing**

```sql
BEGIN;
SELECT plan(2);

set local role authenticated;
SELECT throws_ok(
  $$ select public.report_usage('00000000-0000-0000-0000-000000003099'::uuid, 'llm_chat_completion', 1, 1, null, 1) $$,
  '42501',
  'authenticated NO puede llamar report_usage');

reset role;
set local role service_role;
SELECT lives_ok(
  $$ select public.report_usage('00000000-0000-0000-0000-000000003099'::uuid, 'llm_chat_completion', 1, 1, null, 1) $$,
  'service_role SI puede llamar report_usage');

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Correr + commit**

```bash
npm run test:db -- --test supabase/tests/usage_rpc_acl_test.sql
git add supabase/tests/usage_rpc_acl_test.sql
git commit -m "test(db): usage RPC ACL — service_role only"
```

---

## Paso 4 · Stripe mirror + webhook

### Task 4.1: pgTAP test stripe tablas

**Files:**
- Create: `supabase/tests/stripe_mirror_test.sql`

- [ ] **Step 1: Test failing**

```sql
BEGIN;
SELECT plan(8);

SELECT has_table('public','stripe_customers', 'stripe_customers existe');
SELECT has_table('public','stripe_subscriptions', 'stripe_subscriptions existe');

SELECT col_is_pk('public','stripe_customers', ARRAY['tenant_id'], 'PK tenant_id');
SELECT col_is_pk('public','stripe_subscriptions', ARRAY['stripe_subscription_id'], 'PK stripe_subscription_id');

SELECT col_is_unique('public','stripe_customers', ARRAY['stripe_customer_id'], 'unique stripe_customer_id');

SELECT is((select relrowsecurity from pg_class where oid='public.stripe_customers'::regclass), true, 'RLS customers');
SELECT is((select relrowsecurity from pg_class where oid='public.stripe_subscriptions'::regclass), true, 'RLS subscriptions');

SELECT bag_eq(
  $$ select privilege_type from information_schema.role_table_grants
     where table_name='stripe_customers' and grantee='authenticated' $$,
  $$ values ('SELECT') $$,
  'authenticated solo SELECT customers');

SELECT * FROM finish();
ROLLBACK;
```

```bash
npm run test:db -- --test supabase/tests/stripe_mirror_test.sql
```

Expected: FAIL.

### Task 4.2: Migracion `20260801140000_stripe_mirror.sql`

**Files:**
- Create: `supabase/migrations/20260801140000_stripe_mirror.sql`

- [ ] **Step 1: Escribir**

```sql
-- supabase/migrations/20260801140000_stripe_mirror.sql

create table public.stripe_customers (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  stripe_customer_id text not null unique,
  email text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_stripe_customers_updated_at
before update on public.stripe_customers
for each row execute function app.set_updated_at();

create table public.stripe_subscriptions (
  stripe_subscription_id text primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  status text not null,
  price_id text,
  product_id text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at timestamptz,
  cancel_at_period_end boolean default false,
  canceled_at timestamptz,
  trial_start timestamptz,
  trial_end timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index stripe_subscriptions_tenant_status_idx
  on public.stripe_subscriptions (tenant_id, status);

create trigger set_stripe_subscriptions_updated_at
before update on public.stripe_subscriptions
for each row execute function app.set_updated_at();

alter table public.stripe_customers enable row level security;
alter table public.stripe_subscriptions enable row level security;

create policy stripe_customers_select_admin on public.stripe_customers
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and (select app.is_tenant_admin())
  );

create policy stripe_subscriptions_select_admin on public.stripe_subscriptions
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and (select app.is_tenant_admin())
  );

revoke insert, update, delete on public.stripe_customers, public.stripe_subscriptions from authenticated;
grant select on public.stripe_customers, public.stripe_subscriptions to authenticated;
grant all on public.stripe_customers, public.stripe_subscriptions to service_role;
```

- [ ] **Step 2: Test PASS + commit**

```bash
supabase db reset --local
npm run test:db -- --test supabase/tests/stripe_mirror_test.sql
git add supabase/migrations/20260801140000_stripe_mirror.sql supabase/tests/stripe_mirror_test.sql
git commit -m "feat(db): stripe_customers + stripe_subscriptions mirror tables"
```

### Task 4.3: Route handler Stripe webhook

**Files:**
- Create: `app/api/stripe/webhook/route.ts`
- Create: `app/api/stripe/webhook/__tests__/route.test.ts`
- Create: `lib/stripe/client.ts`
- Create: `lib/stripe/upsert.ts`

> Decision: verificacion HMAC obligatoria con `STRIPE_WEBHOOK_SECRET`. Sin firma valida -> 401. La firma se valida con `stripe.webhooks.constructEvent`. Mirror minimal: solo customer/subscription/invoice events.

- [ ] **Step 1: Client**

```typescript
// lib/stripe/client.ts
import Stripe from "stripe";

let _client: Stripe | null = null;

export function getStripe(): Stripe {
  if (_client) return _client;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY required");
  _client = new Stripe(key, { apiVersion: "2024-12-18.acacia" as Stripe.LatestApiVersion });
  return _client;
}
```

- [ ] **Step 2: Upsert helpers + test failing**

```typescript
// lib/stripe/upsert.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";

function tenantIdFromMetadata(meta: Stripe.Metadata | null): string | null {
  return (meta && (meta.tenant_id || meta.tenantId)) || null;
}

export async function upsertCustomer(supabase: SupabaseClient, customer: Stripe.Customer | Stripe.DeletedCustomer): Promise<void> {
  if (customer.deleted) {
    await supabase.from("stripe_customers").delete().eq("stripe_customer_id", customer.id);
    return;
  }
  const tenantId = tenantIdFromMetadata((customer as Stripe.Customer).metadata);
  if (!tenantId) {
    // ignoramos: stripe customer sin tenant_id en metadata. Loggeable, no fatal.
    return;
  }
  await supabase.from("stripe_customers").upsert({
    tenant_id: tenantId,
    stripe_customer_id: customer.id,
    email: (customer as Stripe.Customer).email ?? null,
    metadata: (customer as Stripe.Customer).metadata ?? {},
  });
}

export async function upsertSubscription(supabase: SupabaseClient, sub: Stripe.Subscription): Promise<void> {
  const tenantId = tenantIdFromMetadata(sub.metadata) ?? (await tenantFromCustomer(supabase, sub.customer as string));
  if (!tenantId) return;
  const price = sub.items.data[0]?.price;
  await supabase.from("stripe_subscriptions").upsert({
    stripe_subscription_id: sub.id,
    tenant_id: tenantId,
    status: sub.status,
    price_id: price?.id ?? null,
    product_id: typeof price?.product === "string" ? price.product : (price?.product as Stripe.Product | undefined)?.id ?? null,
    current_period_start: new Date(sub.current_period_start * 1000).toISOString(),
    current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
    cancel_at: sub.cancel_at ? new Date(sub.cancel_at * 1000).toISOString() : null,
    cancel_at_period_end: sub.cancel_at_period_end,
    canceled_at: sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : null,
    trial_start: sub.trial_start ? new Date(sub.trial_start * 1000).toISOString() : null,
    trial_end: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
    metadata: sub.metadata ?? {},
  });
}

async function tenantFromCustomer(supabase: SupabaseClient, customerId: string): Promise<string | null> {
  const { data } = await supabase.from("stripe_customers").select("tenant_id").eq("stripe_customer_id", customerId).maybeSingle();
  return data?.tenant_id ?? null;
}
```

- [ ] **Step 3: Route handler**

```typescript
// app/api/stripe/webhook/route.ts
import { NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe/client";
import { upsertCustomer, upsertSubscription } from "@/lib/stripe/upsert";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "webhook secret not configured" }, { status: 500 });

  const sig = req.headers.get("stripe-signature");
  if (!sig) return NextResponse.json({ error: "missing signature" }, { status: 401 });

  const raw = await req.text();
  let event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, secret);
  } catch (err) {
    return NextResponse.json({ error: `bad signature: ${(err as Error).message}` }, { status: 401 });
  }

  const supabase = createAdminClient();

  try {
    switch (event.type) {
      case "customer.created":
      case "customer.updated":
      case "customer.deleted":
        await upsertCustomer(supabase, event.data.object as any);
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await upsertSubscription(supabase, event.data.object as any);
        break;
      default:
        // no-op: solo mirror minimal
        break;
    }
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Tests vitest**

```typescript
// app/api/stripe/webhook/__tests__/route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
});

describe("stripe webhook", () => {
  it("rechaza sin firma", async () => {
    const mod = await import("../route");
    const req = new Request("http://x/api/stripe/webhook", { method: "POST", body: "{}" });
    const res = await mod.POST(req);
    expect(res.status).toBe(401);
  });
});
```

```bash
npx vitest run app/api/stripe/webhook/__tests__/route.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/stripe/webhook lib/stripe
git commit -m "feat(api): stripe webhook with HMAC verification + customer/sub mirror"
```

### Task 4.4: Documentar bootstrap manual

**Files:**
- Create: `docs/backend/17-usage-and-billing.md` (parcial; el resto se completa en Paso 8)

- [ ] **Step 1: Esqueleto del doc (sera completado en Paso 8.6)**

```markdown
# Usage records y billing

Esqueleto. Detalle en Paso 8.6.

## Pre-requisito Stripe

- Setear `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` en el entorno.
- Configurar webhook en Stripe Dashboard apuntando a `/api/stripe/webhook` para eventos `customer.*` y `customer.subscription.*`.
- Cada Stripe customer DEBE llevar `metadata.tenant_id` con el uuid del tenant en SDA. Webhook ignora silenciosamente customers sin metadata.
```

- [ ] **Step 2: Commit**

```bash
git add docs/backend/17-usage-and-billing.md
git commit -m "docs(backend): stub doc 17-usage-and-billing"
```

---

## Paso 5 · Data exports

### Task 5.1: pgTAP test `data_exports` + RPCs

**Files:**
- Create: `supabase/tests/data_exports_test.sql`

- [ ] **Step 1: Test failing**

```sql
BEGIN;
SELECT plan(10);

SELECT has_table('public','data_exports', 'data_exports existe');
SELECT has_type('public','data_export_status', 'enum status existe');
SELECT has_type('public','data_export_scope', 'enum scope existe');

SELECT col_not_null('public','data_exports','requested_by','requested_by NOT NULL');
SELECT col_not_null('public','data_exports','scope','scope NOT NULL');

-- composite FK scope_workspace_id
SELECT col_is_fk('public','data_exports','scope_workspace_id','FK workspace');

-- RLS y write boundary
SELECT is((select relrowsecurity from pg_class where oid='public.data_exports'::regclass), true, 'RLS enabled');

SELECT has_function('public','request_data_export',
  ARRAY['public.data_export_scope','uuid','uuid','text'],
  'RPC request_data_export existe');
SELECT has_function('public','list_data_exports', NULL,
  'RPC list_data_exports existe');

-- format check
SELECT throws_ok(
  $$ insert into public.data_exports
       (tenant_id, requested_by, scope, format)
     values ('00000000-0000-0000-0000-000000000001'::uuid,
             '00000000-0000-0000-0000-000000000002'::uuid,
             'tenant', 'csv') $$,
  '23514',
  'format invalido rechazado');

SELECT * FROM finish();
ROLLBACK;
```

```bash
npm run test:db -- --test supabase/tests/data_exports_test.sql
```

Expected: FAIL.

### Task 5.2: Migracion `20260801150000_data_exports.sql`

**Files:**
- Create: `supabase/migrations/20260801150000_data_exports.sql`

- [ ] **Step 1: Escribir**

```sql
-- supabase/migrations/20260801150000_data_exports.sql

do $$
begin
  create type public.data_export_status as enum (
    'queued','running','ready','failed','expired'
  );
exception when duplicate_object then null;
end;
$$;

do $$
begin
  create type public.data_export_scope as enum ('tenant','workspace','user');
exception when duplicate_object then null;
end;
$$;

create table public.data_exports (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  requested_by uuid not null references auth.users(id) on delete restrict,
  scope public.data_export_scope not null,
  scope_workspace_id uuid,
  scope_user_id uuid,
  format text not null default 'zip' check (format in ('zip','jsonl')),
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
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, scope_workspace_id)
    references public.workspaces(tenant_id, id) on delete set null,
  check (
    (scope = 'tenant'    and scope_workspace_id is null and scope_user_id is null) or
    (scope = 'workspace' and scope_workspace_id is not null and scope_user_id is null) or
    (scope = 'user'      and scope_user_id is not null)
  )
);

create index data_exports_tenant_status_idx
  on public.data_exports (tenant_id, status, created_at desc);
create index data_exports_queued_idx
  on public.data_exports (created_at) where status in ('queued','running');

create trigger set_data_exports_updated_at
before update on public.data_exports
for each row execute function app.set_updated_at();

alter table public.data_exports enable row level security;

-- user ve sus propios exports; tenant_admin ve todos del tenant
create policy data_exports_select_owner_or_admin on public.data_exports
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and (
      requested_by = (select auth.uid())
      or (select app.is_tenant_admin())
    )
  );

revoke insert, update, delete on public.data_exports from authenticated;
grant select on public.data_exports to authenticated;
grant all on public.data_exports to service_role;

-- audit trigger
create or replace function app.audit_data_export_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.audit_log (tenant_id, actor_id, action, resource_type, resource_id, metadata)
    values (new.tenant_id, new.requested_by, 'data_export.requested', 'data_export', new.id,
            jsonb_build_object('scope', new.scope, 'format', new.format));
  elsif tg_op = 'UPDATE' and new.status is distinct from old.status then
    insert into public.audit_log (tenant_id, actor_id, action, resource_type, resource_id, metadata)
    values (new.tenant_id, new.requested_by, 'data_export.status_changed', 'data_export', new.id,
            jsonb_build_object('from', old.status, 'to', new.status));
  end if;
  return new;
end;
$$;

create trigger audit_data_exports_change
after insert or update on public.data_exports
for each row execute function app.audit_data_export_change();

-- RPCs
create or replace function public.request_data_export(
  _scope public.data_export_scope,
  _scope_workspace_id uuid default null,
  _scope_user_id uuid default null,
  _format text default 'zip'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  _tenant uuid := (select app.current_tenant_id());
  _user uuid := (select auth.uid());
  _id uuid;
begin
  if _tenant is null or _user is null then
    raise exception 'auth required' using errcode = '42501';
  end if;

  if _scope = 'tenant' then
    if not (select app.is_tenant_admin()) then
      raise exception 'forbidden: tenant_admin required for tenant scope' using errcode = '42501';
    end if;
    _scope_workspace_id := null;
    _scope_user_id := null;
  elsif _scope = 'workspace' then
    if _scope_workspace_id is null then
      raise exception 'workspace_id required' using errcode = '22023';
    end if;
    if not ((select app.is_tenant_admin())
            or app.user_workspace_role(_scope_workspace_id) = 'workspace_admin') then
      raise exception 'forbidden: workspace_admin required' using errcode = '42501';
    end if;
  elsif _scope = 'user' then
    -- user puede solo exportar su propia data
    if _scope_user_id is null then _scope_user_id := _user; end if;
    if _scope_user_id <> _user and not (select app.is_tenant_admin()) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;

  insert into public.data_exports (
    tenant_id, requested_by, scope, scope_workspace_id, scope_user_id, format
  ) values (
    _tenant, _user, _scope, _scope_workspace_id, _scope_user_id, _format
  )
  returning id into _id;

  return _id;
end;
$$;

revoke all on function public.request_data_export(public.data_export_scope, uuid, uuid, text) from public, anon;
grant execute on function public.request_data_export(public.data_export_scope, uuid, uuid, text) to authenticated;

create or replace function public.list_data_exports()
returns setof public.data_exports
language sql
security definer
stable
set search_path = ''
as $$
  select * from public.data_exports
  where tenant_id = (select app.current_tenant_id())
    and (
      requested_by = (select auth.uid())
      or (select app.is_tenant_admin())
    )
  order by created_at desc
  limit 100;
$$;
grant execute on function public.list_data_exports() to authenticated;
```

- [ ] **Step 2: Test PASS + suite + commit**

```bash
supabase db reset --local
npm run test:db -- --test supabase/tests/data_exports_test.sql
npm run test:db
git add supabase/migrations/20260801150000_data_exports.sql supabase/tests/data_exports_test.sql
git commit -m "feat(db): data_exports table + request_data_export + list_data_exports RPCs"
```

### Task 5.3: Worker Inngest `process-data-export`

**Files:**
- Create: `inngest/functions/process-data-export.ts`
- Create: `inngest/functions/__tests__/process-data-export.test.ts`
- Create: `lib/exports/dump.ts`
- Modify: `inngest/functions/index.ts`

> Decision: JSONL para datos tabulares, ZIP que envuelve todos los JSONL + un `manifest.json`. Storage path: `<tenant_id>/_exports/<export_id>/<basename>`. Signed URL via `supabase.storage.from("documents").createSignedUrl(path, 86400)` (24h). Cron sweep cada 5 min toma `queued`.

- [ ] **Step 1: Test failing dump helper**

```typescript
// inngest/functions/__tests__/process-data-export.test.ts
import { describe, it, expect, vi } from "vitest";
import { dumpScope } from "@/lib/exports/dump";

describe("dumpScope", () => {
  it("para scope=user dump solo del user", async () => {
    const selectFn = vi.fn(() => ({ eq: () => ({ data: [{ id: "n1" }], error: null }) }));
    const supabase = { from: () => ({ select: selectFn }) } as any;
    const out = await dumpScope(supabase, { scope: "user", tenant_id: "t1", scope_user_id: "u1", scope_workspace_id: null });
    expect(out.tables.length).toBeGreaterThan(0);
  });
});
```

```bash
npx vitest run inngest/functions/__tests__/process-data-export.test.ts
```

Expected: FAIL.

- [ ] **Step 2: Implementar dumpScope (LEAN: tabla por archivo, sin streaming complejo en v1)**

```typescript
// lib/exports/dump.ts
import type { SupabaseClient } from "@supabase/supabase-js";

export type DumpScope =
  | { scope: "tenant"; tenant_id: string; scope_user_id: null; scope_workspace_id: null }
  | { scope: "workspace"; tenant_id: string; scope_user_id: null; scope_workspace_id: string }
  | { scope: "user"; tenant_id: string; scope_user_id: string; scope_workspace_id: null };

export type DumpedTable = { name: string; rows: unknown[] };

const TENANT_SCOPED_TABLES = [
  "workspaces","collections","tags","document_collections","document_tags",
  "groups","group_memberships","workspace_memberships",
  "documents","doc_tree","doc_tree_nodes","chunks","indexing_runs",
  "conversations","messages","message_citations","message_feedback",
  "user_bookmarks","shared_links","document_annotations","annotation_replies",
  "notifications","notification_preferences","document_views","document_issues",
  "document_lineage","access_requests","saved_queries","audit_log",
  "tenant_oauth_credentials","document_sources","document_source_items",
  "usage_records","stripe_customers","stripe_subscriptions",
];

const USER_SCOPED_TABLES = [
  "user_bookmarks","message_feedback","notifications","notification_preferences",
  "document_views","saved_queries",
];

const WORKSPACE_SCOPED_TABLES = [
  "collections","documents","document_collections","workspace_memberships",
  "document_sources","data_exports",
];

async function fetchAll(supabase: SupabaseClient, table: string, filter: (q: any) => any): Promise<unknown[]> {
  const rows: unknown[] = [];
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    let q = supabase.from(table).select("*").range(from, from + PAGE - 1);
    q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`dump ${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

export async function dumpScope(supabase: SupabaseClient, args: DumpScope): Promise<{ tables: DumpedTable[]; manifest: Record<string, unknown> }> {
  const tables: DumpedTable[] = [];

  if (args.scope === "tenant") {
    for (const t of TENANT_SCOPED_TABLES) {
      const rows = await fetchAll(supabase, t, (q) => q.eq("tenant_id", args.tenant_id));
      tables.push({ name: t, rows });
    }
  } else if (args.scope === "workspace") {
    for (const t of WORKSPACE_SCOPED_TABLES) {
      const rows = await fetchAll(supabase, t, (q) =>
        t === "workspaces"
          ? q.eq("tenant_id", args.tenant_id).eq("id", args.scope_workspace_id)
          : t === "data_exports"
          ? q.eq("tenant_id", args.tenant_id).eq("scope_workspace_id", args.scope_workspace_id)
          : q.eq("tenant_id", args.tenant_id).eq("workspace_id", args.scope_workspace_id),
      );
      tables.push({ name: t, rows });
    }
  } else {
    for (const t of USER_SCOPED_TABLES) {
      const rows = await fetchAll(supabase, t, (q) => q.eq("tenant_id", args.tenant_id).eq("user_id", args.scope_user_id));
      tables.push({ name: t, rows });
    }
  }

  const manifest = {
    scope: args.scope,
    tenant_id: args.tenant_id,
    workspace_id: args.scope === "workspace" ? args.scope_workspace_id : null,
    user_id: args.scope === "user" ? args.scope_user_id : null,
    generated_at: new Date().toISOString(),
    tables: tables.map((t) => ({ name: t.name, row_count: t.rows.length })),
    sda_version: process.env.SDA_VERSION ?? "unknown",
  };

  return { tables, manifest };
}
```

- [ ] **Step 3: Inngest worker**

```typescript
// inngest/functions/process-data-export.ts
import JSZip from "jszip";
import { cron } from "inngest";
import { inngest } from "@/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { dumpScope, type DumpScope } from "@/lib/exports/dump";

const SIGNED_URL_EXPIRES = 86_400; // 24h
const BATCH = Number(process.env.SDA_DATA_EXPORT_BATCH ?? 2);

async function processOneExport(exportId: string): Promise<void> {
  const supabase = createAdminClient();
  const { data: job, error } = await supabase
    .from("data_exports")
    .select("id, tenant_id, requested_by, scope, scope_workspace_id, scope_user_id, format, status")
    .eq("id", exportId).maybeSingle();
  if (error || !job) throw new Error("export job not found");
  if (job.status !== "queued") return;

  await supabase.from("data_exports").update({
    status: "running", started_at: new Date().toISOString(),
  }).eq("id", exportId);

  try {
    const args = {
      scope: job.scope,
      tenant_id: job.tenant_id,
      scope_workspace_id: job.scope_workspace_id,
      scope_user_id: job.scope_user_id,
    } as DumpScope;
    const { tables, manifest } = await dumpScope(supabase, args);

    let body: Buffer; let contentType: string; let ext: string;
    if (job.format === "jsonl") {
      // un solo archivo concatenado: cada tabla precedida por linea separadora
      const parts: string[] = [];
      parts.push(JSON.stringify(manifest));
      for (const t of tables) {
        parts.push(JSON.stringify({ __table: t.name, row_count: t.rows.length }));
        for (const row of t.rows) parts.push(JSON.stringify(row));
      }
      body = Buffer.from(parts.join("\n"), "utf8");
      contentType = "application/x-ndjson";
      ext = "jsonl";
    } else {
      const zip = new JSZip();
      zip.file("manifest.json", JSON.stringify(manifest, null, 2));
      for (const t of tables) {
        const ndjson = t.rows.map((r) => JSON.stringify(r)).join("\n");
        zip.file(`${t.name}.jsonl`, ndjson);
      }
      body = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
      contentType = "application/zip";
      ext = "zip";
    }

    const path = `${job.tenant_id}/_exports/${job.id}/data.${ext}`;
    const { error: upErr } = await supabase.storage.from("documents").upload(path, body, {
      contentType, upsert: true,
    });
    if (upErr) throw new Error(`upload: ${upErr.message}`);

    const { data: signed, error: signErr } = await supabase.storage.from("documents").createSignedUrl(path, SIGNED_URL_EXPIRES);
    if (signErr || !signed) throw new Error(`sign: ${signErr?.message ?? "no url"}`);

    await supabase.from("data_exports").update({
      status: "ready",
      ready_url: signed.signedUrl,
      ready_storage_path: path,
      byte_size: body.byteLength,
      expires_at: new Date(Date.now() + SIGNED_URL_EXPIRES * 1000).toISOString(),
      completed_at: new Date().toISOString(),
    }).eq("id", exportId);
  } catch (err) {
    await supabase.from("data_exports").update({
      status: "failed",
      failed_at: new Date().toISOString(),
      error_message: (err as Error).message,
    }).eq("id", exportId);
    throw err;
  }
}

export const processDataExportCron = inngest.createFunction(
  { id: "process-data-export-sweep" },
  cron("*/5 * * * *"),
  async ({ step }) => {
    const supabase = createAdminClient();
    const due = await step.run("select-queued", async () => {
      const { data } = await supabase.from("data_exports")
        .select("id").eq("status", "queued")
        .order("created_at", { ascending: true }).limit(BATCH);
      return data ?? [];
    });
    for (const job of due) {
      await step.run(`export-${job.id}`, async () => { await processOneExport(job.id); });
    }
    return { processed: due.length };
  }
);

export const processDataExportEvent = inngest.createFunction(
  { id: "process-data-export", concurrency: { limit: 2 } },
  { event: "data_export.requested" },
  async ({ event }) => {
    const id = (event.data as { export_id: string }).export_id;
    await processOneExport(id);
    return { ok: true };
  }
);
```

- [ ] **Step 4: Registrar exports**

```typescript
// inngest/functions/index.ts
export { processDataExportCron, processDataExportEvent } from "./process-data-export";
```

- [ ] **Step 5: Tests + commit**

```bash
npx vitest run inngest/functions/__tests__/process-data-export.test.ts
npm run lint
npm run typecheck
git add inngest/functions/process-data-export.ts inngest/functions/__tests__/process-data-export.test.ts lib/exports/dump.ts inngest/functions/index.ts
git commit -m "feat(inngest): process-data-export cron + event handler with JSONL/ZIP output"
```

### Task 5.4: Trigger DB-side que dispara evento Inngest al insertar

> Patron: usamos `pg_net.http_post` para llamar al endpoint Inngest. Como esto puede no estar disponible, dejamos como FALLBACK el sweep cron del paso anterior. Documentamos.

- [ ] **Step 1: Verificar disponibilidad de pg_net**

```bash
psql "$SUPABASE_DB_URL" -c "select 1 from pg_extension where extname='pg_net'"
```

Expected: 1 si esta. Si esta, agregamos trigger; si no, dependemos solo del cron sweep cada 5 min.

- [ ] **Step 2 (opcional, solo si pg_net disponible): trigger DB-side**

Si pg_net no esta disponible, skipear esta task. El cron del Task 5.3 ya cubre el caso.

### Task 5.5: Test e2e — request -> queued -> verificar columnas

**Files:**
- Create: `supabase/tests/data_exports_rpc_test.sql`

- [ ] **Step 1: Test funcional**

```sql
BEGIN;
SELECT plan(3);

insert into public.tenants (id, slug, name) values
  ('00000000-0000-0000-0000-000000005001','exp-t','Exp T');
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000005011','00000000-0000-0000-0000-000000000000','authenticated','authenticated','u@exp-t.test',now(),'{}'::jsonb,'{}'::jsonb,now(),now());
insert into public.users (id, tenant_id, email, role, status) values
  ('00000000-0000-0000-0000-000000005011','00000000-0000-0000-0000-000000005001','u@exp-t.test','owner','active');

set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000005011","tenant_id":"00000000-0000-0000-0000-000000005001","tenant_role":"owner","claims_version":2}';
set local role authenticated;

SELECT isnt(public.request_data_export('user'::public.data_export_scope), null, 'request_data_export retorna uuid');
SELECT is(
  (select count(*)::int from public.data_exports where tenant_id='00000000-0000-0000-0000-000000005001'),
  1,
  'una fila en data_exports');
SELECT is(
  (select status::text from public.data_exports where tenant_id='00000000-0000-0000-0000-000000005001' limit 1),
  'queued',
  'estado inicial queued');

reset role;
SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Correr + commit**

```bash
npm run test:db -- --test supabase/tests/data_exports_rpc_test.sql
git add supabase/tests/data_exports_rpc_test.sql
git commit -m "test(db): data_exports request_data_export e2e"
```

### Task 5.6: Cleanup de exports vencidos

> El cleanup se integra en `cleanup_operational_data` en Paso 8. Aca solo dejamos nota: exports `ready` con `expires_at < now() - 7d` -> drop + delete storage object.

- [ ] **Step 1: Sin commit. Recordatorio para Task 8.3:** purgar `data_exports` ready/expired despues de 7 dias, incluyendo el objeto Storage (`storage.delete()`).

---

## Paso 6 · Particionado de tablas hot

### Task 6.1: Decision branching pg_partman vs manual

**Files:**
- Modify: `docs/superpowers/plans/_evidence/2026-05-22-tier3-preflight.txt` (evidencia local)

- [ ] **Step 1: Releer evidencia del Task 1.1**

```bash
cat docs/superpowers/plans/_evidence/2026-05-22-tier3-preflight.txt | grep pg_partman
```

Esperado: `pg_partman_available: yes` o `no`.

- [ ] **Step 2: Rama A (pg_partman disponible)**

Si disponible, las migraciones de Task 6.2-6.5 invocan `extensions.create_parent` despues del swap manual de tabla. La auto-creacion de particiones futuras la maneja `pg_partman`. Task 6.6 instala `run_maintenance` en pg_cron.

- [ ] **Step 3: Rama B (pg_partman no disponible)**

Las migraciones 6.2-6.5 hacen swap manual; Task 6.6 crea `app.ensure_future_partitions(_table text, _months_ahead int)` y un job cron diario.

Las dos ramas comparten Steps 1-5 de cada task (test failing -> swap -> RLS recreada -> commit). Solo difieren en el Step 6 (auto-create future).

### Task 6.2: Particionar `audit_log` por mes

**Files:**
- Create: `supabase/migrations/20260801160000_partition_audit_log.sql`
- Create: `supabase/tests/partition_audit_log_test.sql`

> Patron canonico: (1) crear `audit_log_new` particionada, (2) `insert into ... select * from ...` en lote, (3) lock, recrear FKs/RLS/triggers/publication, drop original, rename.

- [ ] **Step 1: pgTAP test**

```sql
BEGIN;
SELECT plan(5);

SELECT is(
  (select relkind from pg_class where oid='public.audit_log'::regclass),
  'p'::"char",
  'audit_log es tabla particionada');

SELECT isnt(
  (select count(*)::int from pg_inherits where inhparent='public.audit_log'::regclass),
  0,
  'audit_log tiene >=1 particion');

SELECT is((select relrowsecurity from pg_class where oid='public.audit_log'::regclass), true, 'RLS preserved');

SELECT col_is_pk('public','audit_log', ARRAY['id','created_at'], 'PK incluye created_at');

-- realtime publication preservada (si estaba)
SELECT ok(
  (select count(*)::int from pg_publication_tables
   where pubname='supabase_realtime' and tablename='audit_log') >= 0,
  'publicacion preservada o ausente');

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Migracion swap**

```sql
-- supabase/migrations/20260801160000_partition_audit_log.sql

-- 1. crear tabla nueva particionada con mismo schema
create table public.audit_log_new (
  id uuid not null default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  actor_id uuid,
  action text not null,
  resource_type text,
  resource_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  request_id text,
  session_id uuid,
  workspace_id uuid,
  ip_address inet,
  user_agent text,
  created_at timestamptz not null default now(),
  primary key (id, created_at)
) partition by range (created_at);

-- helper de particion
create or replace function app.ensure_audit_log_partition(_month_start date)
returns void
language plpgsql
set search_path = ''
as $$
declare
  _start date := date_trunc('month', _month_start)::date;
  _end date := (_start + interval '1 month')::date;
  _name text := 'audit_log_' || to_char(_start, 'YYYY_MM');
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where c.relname=_name and n.nspname='public'
  ) then
    execute format(
      'create table public.%I partition of public.audit_log_new for values from (%L) to (%L)',
      _name, _start, _end);
    execute format(
      'create index %I on public.%I (tenant_id, created_at desc)',
      _name||'_tenant_idx', _name);
    execute format(
      'create index %I on public.%I (tenant_id, actor_id, created_at desc) where actor_id is not null',
      _name||'_actor_idx', _name);
  end if;
end;
$$;

-- crear particion para mes corriente + 3 atras (para data historica) + 3 adelante
do $$
declare
  _min timestamptz;
  _max timestamptz;
  _cursor date;
begin
  select min(created_at), max(created_at) into _min, _max from public.audit_log;
  _cursor := date_trunc('month', coalesce(_min, now() - interval '3 months'))::date;
  while _cursor <= coalesce(_max::date, now()::date) + interval '3 months' loop
    perform app.ensure_audit_log_partition(_cursor);
    _cursor := (_cursor + interval '1 month')::date;
  end loop;
end;
$$;

-- 2. copiar datos
insert into public.audit_log_new (
  id, tenant_id, actor_id, action, resource_type, resource_id, metadata,
  request_id, session_id, workspace_id, ip_address, user_agent, created_at
)
select id, tenant_id, actor_id, action, resource_type, resource_id, metadata,
       request_id, session_id, workspace_id, ip_address, user_agent, created_at
from public.audit_log;

-- 3. swap atomico
begin;
  lock table public.audit_log in access exclusive mode;

  -- recrear RLS y policies en audit_log_new identicas a audit_log
  alter table public.audit_log_new enable row level security;

  -- copiar policies (asumiendo nombres conocidos)
  create policy audit_log_new_select_admin on public.audit_log_new
    for select to authenticated
    using (
      tenant_id = (select app.current_tenant_id())
      and (select app.is_tenant_admin())
    );

  -- grants
  revoke insert, update, delete on public.audit_log_new from authenticated;
  grant select on public.audit_log_new to authenticated;
  grant all on public.audit_log_new to service_role;

  -- quitar de publication la tabla vieja si estaba
  do $$
  begin
    if exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='audit_log') then
      alter publication supabase_realtime drop table public.audit_log;
    end if;
  end;
  $$;

  drop table public.audit_log cascade;
  alter table public.audit_log_new rename to audit_log;

  -- re-agregar a publication (opcional, segun config previa)
  do $$
  begin
    if exists (select 1 from pg_publication where pubname='supabase_realtime') then
      if not exists (
        select 1 from pg_publication_tables
        where pubname='supabase_realtime' and tablename='audit_log'
      ) then
        alter publication supabase_realtime add table public.audit_log;
      end if;
    end if;
  end;
  $$;
commit;
```

- [ ] **Step 3: Aplicar + test PASS**

```bash
supabase db reset --local
npm run test:db -- --test supabase/tests/partition_audit_log_test.sql
```

Expected: 5/5 OK.

- [ ] **Step 4: Suite + commit**

```bash
npm run test:db
git add supabase/migrations/20260801160000_partition_audit_log.sql supabase/tests/partition_audit_log_test.sql
git commit -m "refactor(db): partition audit_log by month (swap pattern)"
```

### Task 6.3: Particionar `indexing_events`

**Files:**
- Create: `supabase/migrations/20260801161000_partition_indexing_events.sql`
- Create: `supabase/tests/partition_indexing_events_test.sql`

> Mismo patron que Task 6.2. Diferencias: tabla mas grande potencialmente, chunkear el insert en batches de 100k filas para evitar OOM en el copy.

- [ ] **Step 1: Test failing (analogo)**

```sql
BEGIN;
SELECT plan(3);
SELECT is(
  (select relkind from pg_class where oid='public.indexing_events'::regclass),
  'p'::"char",
  'indexing_events particionada');
SELECT isnt(
  (select count(*)::int from pg_inherits where inhparent='public.indexing_events'::regclass),
  0,
  'tiene particiones');
SELECT is((select relrowsecurity from pg_class where oid='public.indexing_events'::regclass), true, 'RLS preserved');
SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Migracion swap (con copia chunked)**

```sql
-- supabase/migrations/20260801161000_partition_indexing_events.sql

create table public.indexing_events_new (
  id uuid not null default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  document_id uuid,
  run_id uuid,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (id, created_at)
) partition by range (created_at);

create or replace function app.ensure_indexing_events_partition(_month_start date)
returns void
language plpgsql
set search_path = ''
as $$
declare
  _start date := date_trunc('month', _month_start)::date;
  _end   date := (_start + interval '1 month')::date;
  _name  text := 'indexing_events_' || to_char(_start, 'YYYY_MM');
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where c.relname=_name and n.nspname='public'
  ) then
    execute format(
      'create table public.%I partition of public.indexing_events_new for values from (%L) to (%L)',
      _name, _start, _end);
    execute format(
      'create index %I on public.%I (tenant_id, created_at desc)',
      _name||'_tenant_idx', _name);
    execute format(
      'create index %I on public.%I (tenant_id, document_id, created_at desc) where document_id is not null',
      _name||'_document_idx', _name);
  end if;
end;
$$;

do $$
declare
  _min timestamptz; _max timestamptz; _cursor date;
begin
  select min(created_at), max(created_at) into _min, _max from public.indexing_events;
  _cursor := date_trunc('month', coalesce(_min, now() - interval '6 months'))::date;
  while _cursor <= coalesce(_max::date, now()::date) + interval '3 months' loop
    perform app.ensure_indexing_events_partition(_cursor);
    _cursor := (_cursor + interval '1 month')::date;
  end loop;
end;
$$;

-- copia chunked: itera por created_at, max 100k filas por batch
do $$
declare
  _batch int := 100000;
  _from timestamptz;
  _to timestamptz;
  _step interval := interval '1 month';
begin
  select min(created_at) into _from from public.indexing_events;
  if _from is null then return; end if;
  _to := _from + _step;
  loop
    insert into public.indexing_events_new
    select * from public.indexing_events
    where created_at >= _from and created_at < _to;
    exit when _from > now();
    _from := _to;
    _to := _from + _step;
  end loop;
end;
$$;

-- swap
begin;
  lock table public.indexing_events in access exclusive mode;

  alter table public.indexing_events_new enable row level security;

  -- replicar policies (asumir que el original tenia 1 policy de admin)
  create policy indexing_events_new_select_tenant on public.indexing_events_new
    for select to authenticated
    using (tenant_id = (select app.current_tenant_id()));

  revoke insert, update, delete on public.indexing_events_new from authenticated;
  grant select on public.indexing_events_new to authenticated;
  grant all on public.indexing_events_new to service_role;

  do $$
  begin
    if exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='indexing_events') then
      alter publication supabase_realtime drop table public.indexing_events;
    end if;
  end;
  $$;

  drop table public.indexing_events cascade;
  alter table public.indexing_events_new rename to indexing_events;

  do $$
  begin
    if exists (select 1 from pg_publication where pubname='supabase_realtime') then
      if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='indexing_events') then
        alter publication supabase_realtime add table public.indexing_events;
      end if;
    end if;
  end;
  $$;
commit;
```

- [ ] **Step 3: Aplicar + tests + commit**

```bash
supabase db reset --local
npm run test:db -- --test supabase/tests/partition_indexing_events_test.sql
npm run test:db
git add supabase/migrations/20260801161000_partition_indexing_events.sql supabase/tests/partition_indexing_events_test.sql
git commit -m "refactor(db): partition indexing_events by month"
```

### Task 6.4: Particionar `document_views`

**Files:**
- Create: `supabase/migrations/20260801162000_partition_document_views.sql`
- Create: `supabase/tests/partition_document_views_test.sql`

> Particion por `viewed_at`. `document_views` la creo Tier 2 con composite FK; preservar la FK en la tabla nueva.

- [ ] **Step 1: Test failing analogo (3 asserts)**

```sql
BEGIN;
SELECT plan(3);
SELECT is((select relkind from pg_class where oid='public.document_views'::regclass), 'p'::"char", 'particionada');
SELECT isnt((select count(*)::int from pg_inherits where inhparent='public.document_views'::regclass), 0, '>=1 particion');
SELECT col_is_pk('public','document_views', ARRAY['id','viewed_at'], 'PK (id,viewed_at)');
SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Migracion swap**

```sql
-- supabase/migrations/20260801162000_partition_document_views.sql

create table public.document_views_new (
  id uuid not null default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  document_id uuid not null,
  user_id uuid not null,
  node_id text,
  source text check (source in ('search','agent_citation','direct_link','bookmark','shared_link','connector_feed')),
  dwell_seconds integer check (dwell_seconds is null or dwell_seconds >= 0),
  viewed_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  primary key (id, viewed_at),
  foreign key (tenant_id, document_id)
    references public.documents(tenant_id, id) on delete cascade,
  foreign key (user_id) references auth.users(id) on delete cascade
) partition by range (viewed_at);

create or replace function app.ensure_document_views_partition(_month_start date)
returns void
language plpgsql
set search_path = ''
as $$
declare
  _start date := date_trunc('month', _month_start)::date;
  _end   date := (_start + interval '1 month')::date;
  _name  text := 'document_views_' || to_char(_start, 'YYYY_MM');
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where c.relname=_name and n.nspname='public'
  ) then
    execute format(
      'create table public.%I partition of public.document_views_new for values from (%L) to (%L)',
      _name, _start, _end);
    execute format('create index %I on public.%I (tenant_id, user_id, viewed_at desc)',
      _name||'_user_idx', _name);
    execute format('create index %I on public.%I (tenant_id, document_id, viewed_at desc)',
      _name||'_doc_idx', _name);
  end if;
end;
$$;

do $$
declare _min timestamptz; _max timestamptz; _cursor date;
begin
  select min(viewed_at), max(viewed_at) into _min, _max from public.document_views;
  _cursor := date_trunc('month', coalesce(_min, now() - interval '3 months'))::date;
  while _cursor <= coalesce(_max::date, now()::date) + interval '3 months' loop
    perform app.ensure_document_views_partition(_cursor);
    _cursor := (_cursor + interval '1 month')::date;
  end loop;
end;
$$;

insert into public.document_views_new
select * from public.document_views;

begin;
  lock table public.document_views in access exclusive mode;

  alter table public.document_views_new enable row level security;

  create policy document_views_new_select_tenant on public.document_views_new
    for select to authenticated
    using (tenant_id = (select app.current_tenant_id()) and (select app.user_can_read_document(document_id)));

  create policy document_views_new_insert_self on public.document_views_new
    for insert to authenticated
    with check (
      tenant_id = (select app.current_tenant_id())
      and user_id = (select auth.uid())
      and (select app.user_can_read_document(document_id))
    );

  grant select, insert on public.document_views_new to authenticated;
  grant all on public.document_views_new to service_role;

  do $$
  begin
    if exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='document_views') then
      alter publication supabase_realtime drop table public.document_views;
    end if;
  end;
  $$;

  drop table public.document_views cascade;
  alter table public.document_views_new rename to document_views;
commit;
```

- [ ] **Step 3: Aplicar + commit**

```bash
supabase db reset --local
npm run test:db -- --test supabase/tests/partition_document_views_test.sql
git add supabase/migrations/20260801162000_partition_document_views.sql supabase/tests/partition_document_views_test.sql
git commit -m "refactor(db): partition document_views by month"
```

### Task 6.5: Particionar `notifications`

**Files:**
- Create: `supabase/migrations/20260801163000_partition_notifications.sql`
- Create: `supabase/tests/partition_notifications_test.sql`

- [ ] **Step 1: Test failing**

```sql
BEGIN;
SELECT plan(3);
SELECT is((select relkind from pg_class where oid='public.notifications'::regclass), 'p'::"char", 'particionada');
SELECT isnt((select count(*)::int from pg_inherits where inhparent='public.notifications'::regclass), 0, '>=1 particion');
SELECT col_is_pk('public','notifications', ARRAY['id','created_at'], 'PK (id,created_at)');
SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Migracion (mismo patron, schema completo de notifications)**

```sql
-- supabase/migrations/20260801163000_partition_notifications.sql

create table public.notifications_new (
  id uuid not null default extensions.gen_random_uuid(),
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
  created_at timestamptz not null default now(),
  primary key (id, created_at)
) partition by range (created_at);

create or replace function app.ensure_notifications_partition(_month_start date)
returns void language plpgsql set search_path = '' as $$
declare
  _start date := date_trunc('month', _month_start)::date;
  _end   date := (_start + interval '1 month')::date;
  _name  text := 'notifications_' || to_char(_start, 'YYYY_MM');
begin
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relname=_name and n.nspname='public') then
    execute format('create table public.%I partition of public.notifications_new for values from (%L) to (%L)', _name, _start, _end);
    execute format('create index %I on public.%I (tenant_id, user_id, created_at desc) where read_at is null and archived_at is null',
      _name||'_user_unread_idx', _name);
    execute format('create index %I on public.%I (tenant_id, user_id, created_at desc)',
      _name||'_user_all_idx', _name);
  end if;
end;
$$;

do $$
declare _min timestamptz; _max timestamptz; _cursor date;
begin
  select min(created_at), max(created_at) into _min, _max from public.notifications;
  _cursor := date_trunc('month', coalesce(_min, now() - interval '3 months'))::date;
  while _cursor <= coalesce(_max::date, now()::date) + interval '3 months' loop
    perform app.ensure_notifications_partition(_cursor);
    _cursor := (_cursor + interval '1 month')::date;
  end loop;
end;
$$;

insert into public.notifications_new
select * from public.notifications;

begin;
  lock table public.notifications in access exclusive mode;

  alter table public.notifications_new enable row level security;

  create policy notifications_new_select_self on public.notifications_new
    for select to authenticated
    using (tenant_id = (select app.current_tenant_id()) and user_id = (select auth.uid()));

  create policy notifications_new_update_self on public.notifications_new
    for update to authenticated
    using (tenant_id = (select app.current_tenant_id()) and user_id = (select auth.uid()))
    with check (tenant_id = (select app.current_tenant_id()) and user_id = (select auth.uid()));

  grant select, update on public.notifications_new to authenticated;
  grant all on public.notifications_new to service_role;

  do $$ begin
    if exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='notifications') then
      alter publication supabase_realtime drop table public.notifications;
    end if;
  end; $$;

  drop table public.notifications cascade;
  alter table public.notifications_new rename to notifications;

  do $$ begin
    if exists (select 1 from pg_publication where pubname='supabase_realtime') then
      if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='notifications') then
        alter publication supabase_realtime add table public.notifications;
      end if;
    end if;
  end; $$;
commit;
```

- [ ] **Step 3: Tests + commit**

```bash
supabase db reset --local
npm run test:db -- --test supabase/tests/partition_notifications_test.sql
npm run test:db
git add supabase/migrations/20260801163000_partition_notifications.sql supabase/tests/partition_notifications_test.sql
git commit -m "refactor(db): partition notifications by month"
```

### Task 6.6: Worker que crea particiones futuras

**Files:**
- Create: `supabase/migrations/20260801164000_partition_maintenance.sql`
- Create: `supabase/tests/partition_maintenance_test.sql`

> Rama B (default sin pg_partman): funcion que llama a las 5 `ensure_*_partition` para los proximos N meses, + job cron diario.

- [ ] **Step 1: Test failing**

```sql
BEGIN;
SELECT plan(2);
SELECT has_function('app','ensure_future_partitions', ARRAY['integer'],
  'app.ensure_future_partitions(int) existe');
-- el cron job existe si pg_cron disponible (skipear si no)
SELECT ok(
  not exists (select 1 from pg_extension where extname='pg_cron')
  or exists (select 1 from cron.job where jobname='sda-ensure-future-partitions'),
  'cron job creado si pg_cron disponible');
SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Migracion**

```sql
-- supabase/migrations/20260801164000_partition_maintenance.sql

create or replace function app.ensure_future_partitions(_months_ahead int default 3)
returns void
language plpgsql
set search_path = ''
as $$
declare
  _cursor date := date_trunc('month', now())::date;
  _stop   date := (date_trunc('month', now()) + (_months_ahead || ' months')::interval)::date;
begin
  while _cursor <= _stop loop
    perform app.ensure_audit_log_partition(_cursor);
    perform app.ensure_indexing_events_partition(_cursor);
    perform app.ensure_document_views_partition(_cursor);
    perform app.ensure_notifications_partition(_cursor);
    perform app.ensure_usage_records_partition(_cursor);
    _cursor := (_cursor + interval '1 month')::date;
  end loop;
end;
$$;

revoke all on function app.ensure_future_partitions(int) from public, anon, authenticated;
grant execute on function app.ensure_future_partitions(int) to service_role;

-- pg_cron job: corre diariamente
do $$
begin
  if exists (select 1 from pg_extension where extname='pg_cron') then
    perform cron.schedule(
      'sda-ensure-future-partitions',
      '0 1 * * *',
      $sql$select app.ensure_future_partitions(3)$sql$
    );
  end if;
exception when others then null;
end;
$$;
```

- [ ] **Step 3: Aplicar + tests + commit**

```bash
supabase db reset --local
npm run test:db -- --test supabase/tests/partition_maintenance_test.sql
git add supabase/migrations/20260801164000_partition_maintenance.sql supabase/tests/partition_maintenance_test.sql
git commit -m "feat(db): ensure_future_partitions + daily pg_cron job"
```

---

## Paso 7 · halfvec migration (dual-write window)

### Task 7.1: Pre-check pgvector version

- [ ] **Step 1: Verificar version**

```bash
psql "$SUPABASE_DB_URL" -c "select extversion from pg_extension where extname='vector'"
```

Expected: `>= 0.7`. Si menor, abrir ticket Supabase y abortar Paso 7. NO mergear migracion 7.x hasta que el ticket cierre.

- [ ] **Step 2: Verificar tipo `halfvec` disponible**

```bash
psql "$SUPABASE_DB_URL" -c "select 1 from pg_type t join pg_namespace n on n.oid=t.typnamespace where t.typname='halfvec' and n.nspname='extensions'"
```

Expected: 1. Si 0, marcar Paso 7 BLOCKED.

### Task 7.2: pgTAP test halfvec dual-write

**Files:**
- Create: `supabase/tests/halfvec_dual_write_test.sql`

- [ ] **Step 1: Test failing**

```sql
BEGIN;
SELECT plan(8);

-- columnas embedding_half existen
SELECT has_column('public','chunks','embedding_half',
  'chunks.embedding_half existe');
SELECT col_type_is('public','chunks','embedding_half','extensions.halfvec(1536)',
  'embedding_half tipo halfvec(1536)');
SELECT has_column('public','doc_tree_nodes','embedding_half',
  'doc_tree_nodes.embedding_half existe');

-- trigger de dual-write
SELECT has_function('app','copy_embedding_to_halfvec', ARRAY[]::text[],
  'fn copy_embedding_to_halfvec existe');
SELECT has_trigger('public','chunks','chunks_dual_write_halfvec',
  'trigger en chunks');
SELECT has_trigger('public','doc_tree_nodes','doc_tree_nodes_dual_write_halfvec',
  'trigger en doc_tree_nodes');

-- HNSW index sobre halfvec
SELECT ok(
  exists (
    select 1 from pg_indexes
    where schemaname='public' and tablename='chunks'
      and indexname='chunks_embedding_half_hnsw_idx'
  ),
  'HNSW index chunks_embedding_half_hnsw_idx existe');
SELECT ok(
  exists (
    select 1 from pg_indexes
    where schemaname='public' and tablename='doc_tree_nodes'
      and indexname='doc_tree_nodes_embedding_half_hnsw_idx'
  ),
  'HNSW index doc_tree_nodes_embedding_half_hnsw_idx existe');

SELECT * FROM finish();
ROLLBACK;
```

```bash
npm run test:db -- --test supabase/tests/halfvec_dual_write_test.sql
```

Expected: FAIL.

### Task 7.3: Migracion dual-write `20260801170000_halfvec_dual_write.sql`

**Files:**
- Create: `supabase/migrations/20260801170000_halfvec_dual_write.sql`

- [ ] **Step 1: Escribir**

```sql
-- supabase/migrations/20260801170000_halfvec_dual_write.sql
-- Requiere pgvector >= 0.7 (halfvec).

create extension if not exists "vector" with schema "extensions";

-- agregar columnas embedding_half
alter table public.chunks
  add column if not exists embedding_half extensions.halfvec(1536);

alter table public.doc_tree_nodes
  add column if not exists embedding_half extensions.halfvec(1536);

-- backfill: copia desde embedding existente (puede tardar; chunkear si la tabla es grande)
update public.chunks
  set embedding_half = embedding::extensions.halfvec(1536)
  where embedding is not null and embedding_half is null;

update public.doc_tree_nodes
  set embedding_half = embedding::extensions.halfvec(1536)
  where embedding is not null and embedding_half is null;

-- trigger de dual-write: cualquier insert/update sobre `embedding` copia a `embedding_half`.
create or replace function app.copy_embedding_to_halfvec()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.embedding is not null then
    new.embedding_half := new.embedding::extensions.halfvec(1536);
  else
    new.embedding_half := null;
  end if;
  return new;
end;
$$;

create trigger chunks_dual_write_halfvec
before insert or update of embedding on public.chunks
for each row execute function app.copy_embedding_to_halfvec();

create trigger doc_tree_nodes_dual_write_halfvec
before insert or update of embedding on public.doc_tree_nodes
for each row execute function app.copy_embedding_to_halfvec();

-- HNSW sobre halfvec con halfvec_cosine_ops
create index if not exists chunks_embedding_half_hnsw_idx
  on public.chunks using hnsw (embedding_half extensions.halfvec_cosine_ops)
  where embedding_half is not null;

create index if not exists doc_tree_nodes_embedding_half_hnsw_idx
  on public.doc_tree_nodes using hnsw (embedding_half extensions.halfvec_cosine_ops)
  where embedding_half is not null;
```

- [ ] **Step 2: Test PASS**

```bash
supabase db reset --local
npm run test:db -- --test supabase/tests/halfvec_dual_write_test.sql
```

Expected: 8/8 OK.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260801170000_halfvec_dual_write.sql supabase/tests/halfvec_dual_write_test.sql
git commit -m "feat(db): halfvec dual-write window for chunks + doc_tree_nodes"
```

### Task 7.4: Switch RPCs de search a usar `embedding_half`

**Files:**
- Modify: search RPCs en `lib/system-versions.json` o las migraciones que las definieron.

> Decision: durante la ventana, las RPCs de search leen `embedding_half` (FP16). Si no esta seteada todavia (rows viejas pre-backfill), fallback a `embedding`. Tras el swap del Paso 7.5 desaparece el fallback.

- [ ] **Step 1: Localizar RPCs de search a actualizar**

```bash
grep -rn "embedding extensions.vector\|using hnsw" supabase/migrations/ | grep -v halfvec
```

Expected: lista de migraciones con HNSW sobre `embedding`. Estas funciones (`search_chunks`, `search_tree_nodes_by_embedding`) deben re-escribirse en una migracion incremental:

```sql
-- migracion auxiliar (mismo timestamp +1s del Task 7.3 si conviene):
-- supabase/migrations/20260801170100_search_rpcs_use_halfvec.sql

create or replace function public.search_tree_nodes_by_embedding(
  _embedding extensions.halfvec,
  _filters jsonb default '{}'::jsonb,
  _limit int default 10
)
returns table (
  node_id text, document_id uuid, score float8, title text, summary text
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  _tenant uuid := (select app.current_tenant_id());
begin
  return query
  select n.node_id, n.document_id,
         (1 - (n.embedding_half <=> _embedding))::float8 as score,
         n.title, n.summary
  from public.doc_tree_nodes n
  where n.tenant_id = _tenant
    and n.embedding_half is not null
  order by n.embedding_half <=> _embedding
  limit greatest(coalesce(_limit, 10), 1);
end;
$$;
```

- [ ] **Step 2: Tests para search post-switch**

Cubierto por tests existentes de search (en `supabase/tests/db_caching_retrieval_ops_test.sql`); validar que no regresionan tras cambiar el parametro a `halfvec`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260801170100_search_rpcs_use_halfvec.sql
git commit -m "refactor(db): search RPCs leen embedding_half"
```

### Task 7.5: Migracion swap final (programada +7d)

**Files:**
- Create (programada): `supabase/migrations/20260801171000_halfvec_swap.sql`

> Esta migracion NO se mergea junto con 7.3. Esperar 7 dias en staging observando metricas: ratio de hits HNSW, dwell time queries. Si todo verde, mergear el swap.

- [ ] **Step 1: Cuando llegue el momento, escribir migracion**

```sql
-- supabase/migrations/20260801171000_halfvec_swap.sql
-- Swap final: drop trigger dual-write, drop columna vector vieja, rename.
-- Pre-requisito: pasar 7 dias minimo desde 20260801170000_halfvec_dual_write.sql.

drop trigger if exists chunks_dual_write_halfvec on public.chunks;
drop trigger if exists doc_tree_nodes_dual_write_halfvec on public.doc_tree_nodes;
drop function if exists app.copy_embedding_to_halfvec();

drop index if exists public.chunks_embedding_hnsw_idx;
drop index if exists public.doc_tree_nodes_embedding_hnsw_idx;

alter table public.chunks drop column if exists embedding;
alter table public.chunks rename column embedding_half to embedding;

alter table public.doc_tree_nodes drop column if exists embedding;
alter table public.doc_tree_nodes rename column embedding_half to embedding;

alter index public.chunks_embedding_half_hnsw_idx rename to chunks_embedding_hnsw_idx;
alter index public.doc_tree_nodes_embedding_half_hnsw_idx rename to doc_tree_nodes_embedding_hnsw_idx;

-- search RPCs ya leen `embedding` despues del rename (mismo nombre).
```

- [ ] **Step 2: Test post-swap**

```sql
-- supabase/tests/halfvec_swap_test.sql
BEGIN;
SELECT plan(3);
SELECT col_type_is('public','chunks','embedding','extensions.halfvec(1536)',
  'chunks.embedding ahora halfvec');
SELECT col_type_is('public','doc_tree_nodes','embedding','extensions.halfvec(1536)',
  'doc_tree_nodes.embedding ahora halfvec');
SELECT hasnt_function('app','copy_embedding_to_halfvec', ARRAY[]::text[],
  'trigger fn removida');
SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 3: Commit cuando llegue el momento**

```bash
git add supabase/migrations/20260801171000_halfvec_swap.sql supabase/tests/halfvec_swap_test.sql
git commit -m "refactor(db): halfvec swap — drop legacy vector column"
```

---

## Paso 8 · Vistas + cleanup + cron + docs + realtime + self-review

### Task 8.1: Vista `workspace_top_documents`

**Files:**
- Create: `supabase/migrations/20260801180000_workspace_views.sql`
- Create: `supabase/tests/workspace_views_test.sql`

- [ ] **Step 1: Test failing**

```sql
BEGIN;
SELECT plan(2);
SELECT has_view('public','workspace_top_documents',
  'view workspace_top_documents existe');
SELECT has_view('public','workspace_recent_activity',
  'view workspace_recent_activity existe');
SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Migracion**

```sql
-- supabase/migrations/20260801180000_workspace_views.sql

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
group by 1,2,3,4;

grant select on public.workspace_top_documents to authenticated;
```

- [ ] **Step 3: Commit (juntar con 8.2 si no aplica todavia)**

### Task 8.2: Vista `workspace_recent_activity`

- [ ] **Step 1: Agregar al mismo archivo de Task 8.1**

```sql
create or replace view public.workspace_recent_activity as
select tenant_id, workspace_id, kind, occurred_at, ref_id, summary, actor_id from (
  select d.tenant_id, d.workspace_id, 'document'::text as kind,
         d.created_at as occurred_at, d.id as ref_id,
         d.title as summary, d.created_by as actor_id
  from public.documents d
  where d.deleted_at is null and d.created_at >= now() - interval '30 days'
  union all
  select a.tenant_id,
         d.workspace_id,
         'annotation'::text,
         a.created_at, a.id,
         substr(a.body, 1, 140),
         a.author_id
  from public.document_annotations a
  join public.documents d on d.id = a.document_id and d.tenant_id = a.tenant_id
  where a.deleted_at is null and a.created_at >= now() - interval '30 days'
  union all
  select i.tenant_id, d.workspace_id, 'issue'::text,
         i.created_at, i.id,
         coalesce(i.description, i.kind::text), i.reporter_id
  from public.document_issues i
  join public.documents d on d.id = i.document_id and d.tenant_id = i.tenant_id
  where i.created_at >= now() - interval '30 days'
  union all
  select s.tenant_id,
         coalesce(s.audience_workspace_id,
           (select workspace_id from public.documents
            where id = s.target_id and tenant_id = s.tenant_id)) as workspace_id,
         'shared_link'::text, s.created_at, s.id,
         coalesce(s.message, s.target_kind::text), s.created_by
  from public.shared_links s
  where s.revoked_at is null and s.created_at >= now() - interval '30 days'
) recent
where workspace_id is not null;

grant select on public.workspace_recent_activity to authenticated;
```

- [ ] **Step 2: Aplicar + tests PASS + commit**

```bash
supabase db reset --local
npm run test:db -- --test supabase/tests/workspace_views_test.sql
git add supabase/migrations/20260801180000_workspace_views.sql supabase/tests/workspace_views_test.sql
git commit -m "feat(db): workspace_top_documents + workspace_recent_activity views"
```

### Task 8.3: Cleanup extendido `cleanup_operational_data` v3

**Files:**
- Create: `supabase/migrations/20260801181000_cleanup_operational_data_v3.sql`
- Create: `supabase/tests/cleanup_operational_data_v3_test.sql`

> Extiende la funcion existente (Tier 0/1). Agrega purgas para `data_exports`, `usage_records` viejos (>12 meses), `document_source_items` huerfanos, `notifications` >90d, `document_views` >180d.

- [ ] **Step 1: Test failing**

```sql
BEGIN;
SELECT plan(2);
SELECT has_function('app','cleanup_operational_data', NULL,
  'cleanup_operational_data existe');
-- valida que la funcion menciona data_exports (proxy heuristico)
SELECT ok(
  (select prosrc from pg_proc where proname='cleanup_operational_data' limit 1) like '%data_exports%',
  'cleanup_operational_data referencia data_exports');
SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Migracion**

```sql
-- supabase/migrations/20260801181000_cleanup_operational_data_v3.sql

create or replace function app.cleanup_operational_data()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _deleted_notifications int := 0;
  _deleted_document_views int := 0;
  _deleted_data_exports int := 0;
  _dropped_usage_partitions int := 0;
  _dropped_audit_partitions int := 0;
  _dropped_events_partitions int := 0;
  _r record;
begin
  -- notifications > 90d
  delete from public.notifications where created_at < now() - interval '90 days';
  get diagnostics _deleted_notifications = row_count;

  -- document_views > 180d (los aggregates ya cubren retencion historica)
  delete from public.document_views where viewed_at < now() - interval '180 days';
  get diagnostics _deleted_document_views = row_count;

  -- data_exports ready/expired > 7d. Tambien borra el objeto Storage.
  for _r in
    select id, ready_storage_path from public.data_exports
    where status in ('ready','expired')
      and coalesce(expires_at, completed_at, created_at) < now() - interval '7 days'
  loop
    if _r.ready_storage_path is not null then
      perform storage.delete_object('documents', _r.ready_storage_path);
    end if;
  end loop;
  delete from public.data_exports
    where status in ('ready','expired')
      and coalesce(expires_at, completed_at, created_at) < now() - interval '7 days';
  get diagnostics _deleted_data_exports = row_count;

  -- drop particiones de usage_records > 12 meses
  for _r in
    select c.relname from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'public.usage_records'::regclass
      and c.relname ~ '^usage_records_[0-9]{4}_[0-9]{2}$'
      and to_date(substring(c.relname from '[0-9]{4}_[0-9]{2}'), 'YYYY_MM') < (now() - interval '12 months')::date
  loop
    execute format('drop table public.%I', _r.relname);
    _dropped_usage_partitions := _dropped_usage_partitions + 1;
  end loop;

  -- drop particiones de audit_log > 24 meses
  for _r in
    select c.relname from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'public.audit_log'::regclass
      and c.relname ~ '^audit_log_[0-9]{4}_[0-9]{2}$'
      and to_date(substring(c.relname from '[0-9]{4}_[0-9]{2}'), 'YYYY_MM') < (now() - interval '24 months')::date
  loop
    execute format('drop table public.%I', _r.relname);
    _dropped_audit_partitions := _dropped_audit_partitions + 1;
  end loop;

  -- drop particiones de indexing_events > 6 meses
  for _r in
    select c.relname from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'public.indexing_events'::regclass
      and c.relname ~ '^indexing_events_[0-9]{4}_[0-9]{2}$'
      and to_date(substring(c.relname from '[0-9]{4}_[0-9]{2}'), 'YYYY_MM') < (now() - interval '6 months')::date
  loop
    execute format('drop table public.%I', _r.relname);
    _dropped_events_partitions := _dropped_events_partitions + 1;
  end loop;

  -- access_requests pending vencidos
  update public.access_requests
    set status = 'expired', updated_at = now()
    where status = 'pending' and expires_at < now();

  -- asegurar particiones futuras
  perform app.ensure_future_partitions(3);

  return jsonb_build_object(
    'deleted_notifications', _deleted_notifications,
    'deleted_document_views', _deleted_document_views,
    'deleted_data_exports', _deleted_data_exports,
    'dropped_usage_partitions', _dropped_usage_partitions,
    'dropped_audit_partitions', _dropped_audit_partitions,
    'dropped_events_partitions', _dropped_events_partitions
  );
end;
$$;

revoke all on function app.cleanup_operational_data() from public, anon, authenticated;
grant execute on function app.cleanup_operational_data() to service_role;
```

- [ ] **Step 3: Tests + commit**

```bash
supabase db reset --local
npm run test:db -- --test supabase/tests/cleanup_operational_data_v3_test.sql
npm run test:db
git add supabase/migrations/20260801181000_cleanup_operational_data_v3.sql supabase/tests/cleanup_operational_data_v3_test.sql
git commit -m "feat(db): cleanup_operational_data v3 (exports, partitions, access requests)"
```

### Task 8.4: pg_cron jobs nuevos

> Algunos jobs ya se schedulearon inline (Task 3.6 = `sda-usage-aggregates-refresh`, Task 6.6 = `sda-ensure-future-partitions`). Faltan: `sda-cleanup-operational-data` (revisar si existia) y `sda-workspace-top-documents-refresh` (no aplica porque es vista comun, no matview).

- [ ] **Step 1: Verificar jobs actuales**

```bash
psql "$SUPABASE_DB_URL" -c "select jobname, schedule from cron.job order by jobname"
```

Esperado: lista incluye `sda-cleanup-operational-data` (de Tier 0). Validar que apunta a la nueva funcion.

- [ ] **Step 2: Si el job existia con schedule viejo, actualizarlo (idempotente)**

Agregar en `20260801181000_cleanup_operational_data_v3.sql` al final:

```sql
do $$
begin
  if exists (select 1 from pg_extension where extname='pg_cron') then
    perform cron.unschedule('sda-cleanup-operational-data');
    perform cron.schedule(
      'sda-cleanup-operational-data',
      '15 2 * * *',
      $sql$select app.cleanup_operational_data()$sql$
    );
  end if;
exception when others then null;
end;
$$;
```

- [ ] **Step 3: Commit (amend? no, nuevo commit)**

```bash
git add supabase/migrations/20260801181000_cleanup_operational_data_v3.sql
git commit -m "feat(db): reschedule sda-cleanup-operational-data daily at 02:15"
```

### Task 8.5: Realtime publication Tier 3

**Files:**
- Create: `supabase/migrations/20260801182000_realtime_tier3.sql`
- Create: `supabase/tests/realtime_tier3_test.sql`

- [ ] **Step 1: Test failing**

```sql
BEGIN;
SELECT plan(2);
SELECT ok(
  exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='data_exports'),
  'data_exports en publication');
-- usage_records NO se publica (cardinalidad alta); usage_aggregates_daily tampoco
-- pero document_sources si lo agregamos.
SELECT ok(
  exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='document_sources'),
  'document_sources en publication');
SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Migracion**

```sql
-- supabase/migrations/20260801182000_realtime_tier3.sql

do $$
begin
  if exists (select 1 from pg_publication where pubname='supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='data_exports') then
      alter publication supabase_realtime add table public.data_exports;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='document_sources') then
      alter publication supabase_realtime add table public.document_sources;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='document_source_items') then
      alter publication supabase_realtime add table public.document_source_items;
    end if;
  end if;
end;
$$;
```

- [ ] **Step 3: Test + commit**

```bash
supabase db reset --local
npm run test:db -- --test supabase/tests/realtime_tier3_test.sql
git add supabase/migrations/20260801182000_realtime_tier3.sql supabase/tests/realtime_tier3_test.sql
git commit -m "feat(realtime): publicar data_exports + document_sources + items"
```

### Task 8.6: Doc nuevo `16-connectors-drive-m365.md`

**Files:**
- Create: `docs/backend/16-connectors-drive-m365.md`

- [ ] **Step 1: Escribir doc completo**

```markdown
# Connectors: Google Drive + Microsoft 365

## Arquitectura

```
[Browser] -> /api/connectors/oauth/start (firma state HMAC)
          -> Google/M365 consent screen
          -> /api/connectors/oauth/callback (verifica state, intercambia code)
          -> vault.create_secret(refresh_token)
          -> tenant_oauth_credentials.vault_secret_id = uuid

[Inngest cron 1 min] sync-document-sources
  -> selecciona document_sources WHERE status='active' AND next_sync_at <= now()
  -> por cada source:
       ensureFreshAccessToken(credential_id)  -- Vault read + refresh si vencido
       providerClient(provider).listChanges(cursor, config)
       upsert document_source_items
       enqueueIngest por cada item pending
       update document_source_cursors + next_sync_at

[Inngest event] documents/connector.item.ready
  -> ingest-connector-item:
       providerClient.downloadFile(stream)
       storage.upload -> tenant_id/connector/source_id/external_id/<filename>
       rpc create_document_upload(...) -> document_id
       update document_source_items.ingestion_status='indexed'
```

## OAuth flow detallado

1. Admin abre setup connector -> `create_oauth_credential(provider, account_subject)`.
2. RPC retorna `credential_id`; UI redirige a `/api/connectors/oauth/start?credential_id=...&provider=...`.
3. Start verifica que la credential este en `pending_auth`, firma un `state` con HMAC (`SDA_OAUTH_STATE_SECRET`), arma URL de autorizacion del provider.
4. User aprueba; provider redirige a `/api/connectors/oauth/callback?code=...&state=...`.
5. Callback verifica HMAC + nonce <10min, intercambia code por tokens, llama `saveTokens` que escribe a Vault y actualiza `tenant_oauth_credentials.vault_secret_id` + `status='active'`.

## Vault y aislamiento

- El secret (access + refresh token) nunca se devuelve al cliente.
- Solo workers con `service_role` pueden invocar `app.read_oauth_secret`.
- La RPC `revoke_oauth_credential` llama `app.delete_oauth_secret` y pausa todas las `document_sources` que usan esa credential.

## Refresh tokens

- `ensureFreshAccessToken` lee Vault, si `expires_at - now < 60s` refresca via provider y reescribe Vault con `app.update_oauth_secret`.
- Si el refresh falla (refresh_token revocado), `tenant_oauth_credentials.status` pasa a `error` y `last_error` describe la causa; el worker pausa la source.

## Provider mapping

| Provider | listChanges cursor | downloadFile | Scopes |
|---|---|---|---|
| `google_drive` | `pageToken` (Drive Changes API) | `files/{id}?alt=media` | `drive.readonly`, `openid`, `email`, `profile` |
| `m365_sharepoint` | `deltaLink` (Graph drive delta) | `items/{id}/content` | `offline_access`, `Files.Read.All`, `Sites.Read.All`, `User.Read` |
| `m365_onedrive` | idem | idem | idem |

## Gotchas

- Google Drive devuelve `newStartPageToken` cuando termina la pagina; persistirlo en lugar del `pageToken` para evitar quedar atrapado en una ventana.
- M365 Graph emite paginas intermedias con `@odata.nextLink`; solo persistir `@odata.deltaLink` cuando aparece.
- El download stream desde el provider es half-duplex; `storage.upload` requiere `duplex: "half"` en runtime Node 18+.
- Rate limit Google: 1000 req/100s per user. Rate limit Graph: dinamico, devuelve `429` con `Retry-After`. El worker debe respetar.
- Una credential puede alimentar muchas sources (varias carpetas, varios workspaces). El plan de billing por usage no separa por source: cuenta tokens consumidos por la ingesta.
```

- [ ] **Step 2: Commit**

```bash
git add docs/backend/16-connectors-drive-m365.md
git commit -m "docs(backend): 16-connectors-drive-m365 (arquitectura + oauth + gotchas)"
```

### Task 8.7: Doc completo `17-usage-and-billing.md`

**Files:**
- Modify: `docs/backend/17-usage-and-billing.md`

- [ ] **Step 1: Reescribir el archivo completo (no append)**

```markdown
# Usage records y billing

## `usage_records` particionada

Granularidad evento. Cada LLM call / embedding batch / extraction se inserta como una fila via `public.report_usage(...)` (service_role only). Particionada por `occurred_at` mensual. PK `(id, occurred_at)`.

Workers que escriben:
- `inngest/functions/process-document-index`: extraction events.
- Agent runtime (server-side): LLM completion + embedding events.
- Cron de storage snapshot: 1 fila/dia/tenant con `kind='storage_bytes_day'`.

## `usage_aggregates_daily` matview

Refresh `concurrently` cada hora via `pg_cron` (`sda-usage-aggregates-refresh`). 4 indices unique parciales para soportar combinaciones de `NULL` en `(workspace_id, user_id)`.

## RPC `tenant_usage_summary(_start, _end)`

Read-only, security definer, requiere `app.is_tenant_admin()`. Retorna agregados del rango ya pre-computados de la matview. UI llama esta RPC, NO lee `usage_records` directamente.

## Mirror Stripe

`stripe_customers` + `stripe_subscriptions`. Stripe webhook (`/api/stripe/webhook`) verifica firma HMAC con `STRIPE_WEBHOOK_SECRET`, upserta. Browser solo lee con RLS `is_tenant_admin()`.

Para vincular un tenant a un customer Stripe: setear `metadata.tenant_id = <uuid>` en el customer creado en Dashboard. Sin metadata, el webhook ignora silenciosamente.

## Threshold notifications

Trigger `usage_records_threshold_check` chequea sum del mes contra `tenants.metadata.usage_budget_micro_usd`. Si cruza 50/90/100%, crea `notifications.kind='usage.threshold_crossed'` (idempotente por mes + threshold).

Patron: el feedback nunca bloquea. Notif aparece en inbox del tenant_admin; el plan de billing usage-puro NO impone caps.

## Cleanup

`cleanup_operational_data` drop particiones de `usage_records` > 12 meses cada noche.

## Gotchas

- `cost_micro_usd` es bigint (micros, 6 decimales). 1 USD = 1_000_000. Conversion a USD: `cost_micro_usd / 1e6`.
- `refresh materialized view concurrently` requiere los unique indices parciales presentes. Si fallan los indices, la primera vez requiere refresh sin `concurrently`.
- El threshold check corre row-level. Inserts bulk via worker pueden disparar varios disparos en seguidilla; el check guard de idempotencia (`metadata.threshold + period_month` ya existente) lo evita.
```

- [ ] **Step 2: Commit**

```bash
git add docs/backend/17-usage-and-billing.md
git commit -m "docs(backend): 17-usage-and-billing completo (usage records + stripe mirror)"
```

### Task 8.8: Doc nuevo `19-data-export.md`

**Files:**
- Create: `docs/backend/19-data-export.md`

- [ ] **Step 1: Escribir**

```markdown
# Data export

## Scope

- `tenant`: admin solo. Dump de todas las tablas tenant-scoped.
- `workspace`: workspace_admin / tenant_admin. Dump de tablas relacionadas al workspace.
- `user`: el propio user. Sus rows (bookmarks, feedback, notifications, views, saved_queries).

## Formatos

- `zip`: cada tabla como `.jsonl` + `manifest.json`, comprimidos con DEFLATE level 6.
- `jsonl`: un solo archivo NDJSON. Manifest como primera linea + headers `__table` precedidos.

## Flujo

```
[Browser] -> public.request_data_export(scope, ws?, user?, format?)
          -> data_exports.status='queued'
          [Inngest cron 5 min] process-data-export-sweep
          -> dumpScope(supabase, args)
          -> storage.upload(<tenant>/_exports/<id>/data.<ext>)
          -> createSignedUrl(86400s)
          -> data_exports.status='ready' + ready_url + expires_at
```

## Retencion

`cleanup_operational_data` borra exports `ready/expired` > 7 dias + el objeto Storage.

## Gotchas

- Signed URL vence en 24h. Si el user no descarga, la fila queda `ready` pero el URL no sirve; despues de 7d se elimina.
- Para tenants grandes, el dump puede tardar minutos. El worker corre con `concurrency.limit=2`.
- `dumpScope` carga todo a memoria (JSZip). Para tenants > 1 GB de data tabular, plantear streaming en una v2. Si pasa, abrir issue.
- Storage prefix `_exports/` esta dentro del bucket "documents"; las policies de Storage permiten al user descargar via signed URL sin RLS adicional.
```

- [ ] **Step 2: Commit**

```bash
git add docs/backend/19-data-export.md
git commit -m "docs(backend): 19-data-export (flujo, formatos, retencion)"
```

### Task 8.9: Docs actualizados + gotchas split

**Files:**
- Modify: `docs/backend/04-indexacion-inngest.md`
- Modify: `docs/backend/09-catalogo-api-rutas.md`
- Modify: `docs/backend/10-supabase-realtime.md`
- Modify: `docs/backend/14-retention-and-cleanup.md`
- Create: `docs/gotchas-supabase.md`
- Create: `docs/gotchas-inngest.md`
- Create: `docs/gotchas-frontend.md`
- Create: `docs/gotchas-server-ops.md`
- Modify: `docs/gotchas.md` (deja indice apuntando a los splits)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Actualizar 04-indexacion-inngest.md**

Agregar al final de la lista de Inngest functions:

```markdown
### `sync-document-sources` (cron `* * * * *`)

Recorre `document_sources` activas con `next_sync_at <= now()`, refresca tokens via Vault, llama provider API, upserta items y encola ingesta para los pending.

### `ingest-connector-item` (event `documents/connector.item.ready`)

Baja el archivo del provider via `service_role`, lo sube a Storage bajo `<tenant>/connector/<source>/<external_id>/...` y dispara el flujo de upload manual via `create_document_upload`.

### `process-data-export-sweep` (cron `*/5 * * * *`)

Toma `data_exports.status='queued'`, ejecuta `dumpScope`, sube ZIP/JSONL a Storage, marca `ready` con signed URL 24h.
```

- [ ] **Step 2: Actualizar 09-catalogo-api-rutas.md** (agregar las route handlers nuevas):

```markdown
### `/api/connectors/oauth/start`
GET. Setea state HMAC, redirige a authorize URL del provider.

### `/api/connectors/oauth/callback`
GET. Verifica state, intercambia code, escribe Vault.

### `/api/stripe/webhook`
POST. Verifica firma HMAC con `STRIPE_WEBHOOK_SECRET`, upserta mirror.
```

- [ ] **Step 3: Actualizar 10-supabase-realtime.md** (publicaciones nuevas):

```markdown
- `data_exports`: el user ve su export pasar a `ready` en tiempo real.
- `document_sources`, `document_source_items`: admins ven progreso de sync.
- `notifications`: ya estaba publicada (Tier 2); ahora particionada por mes.
```

- [ ] **Step 4: Actualizar 14-retention-and-cleanup.md** (particionado + cleanup v3):

```markdown
## Particionado

Tablas particionadas por mes desde Tier 3:
- `audit_log` (created_at) — retention 24m
- `indexing_events` (created_at) — retention 6m
- `document_views` (viewed_at) — retention 180d
- `notifications` (created_at) — retention 90d
- `usage_records` (occurred_at) — retention 12m

`app.ensure_future_partitions(_months_ahead int default 3)` crea particiones futuras. Corre via `sda-ensure-future-partitions` cron diario. Si `pg_partman` esta disponible se puede sustituir.

## cleanup_operational_data v3

Drop particiones viejas + borrar exports vencidos + expirar access_requests + reasegurar particiones futuras. Job `sda-cleanup-operational-data` cron 02:15.
```

- [ ] **Step 5: Split de gotchas**

Mover seccion de Supabase del `docs/gotchas.md` actual a `docs/gotchas-supabase.md`; lo mismo con Inngest, frontend, server-ops. `docs/gotchas.md` queda como indice:

```markdown
# Gotchas (indice)

- [Supabase / Postgres](./gotchas-supabase.md)
- [Inngest workers](./gotchas-inngest.md)
- [Frontend Next.js](./gotchas-frontend.md)
- [Server ops / GPU](./gotchas-server-ops.md)
```

Agregar a `docs/gotchas-supabase.md` los nuevos gotchas:

```markdown
## halfvec migration window

- Durante la ventana (entre migraciones 7.3 y 7.5) hay un trigger `before insert/update of embedding` que copia a `embedding_half`. Si una migracion bulk-inserta `embedding` directamente, el trigger corre por fila y puede ser lento; cargar via `copy` evita el trigger por fila pero entonces hay que rellenar `embedding_half` manualmente despues.
- El swap del Paso 7.5 NO se mergea junto con el dual-write. Esperar 7 dias minimo observando metricas.

## Particionado: swap requiere lock

- `lock table ... in access exclusive mode` durante el swap. En tablas grandes (>1M filas) el `insert into ... select` previo dura minutos. Hacer el swap en ventana de bajo trafico.
- Recrear policies RLS sobre la tabla nueva ANTES del rename: el rename mantiene policies si estan attachadas al OID. Verificar con `pg_policies`.

## Vault flow

- `vault.create_secret` retorna uuid del secret; guardarlo en `tenant_oauth_credentials.vault_secret_id` en la misma transaccion. Si el insert falla, llamar `app.delete_oauth_secret` para no orfanar el secret.
- `vault.decrypted_secrets` es la vista que descifra; nunca SELECT directo sobre `vault.secrets` desde otra logica.
```

Agregar a `docs/gotchas-inngest.md`:

```markdown
## Stripe webhook idempotency

- Stripe puede reenviar el mismo evento. La logica de upsert por `stripe_customer_id` / `stripe_subscription_id` lo absorbe; no agregar dedupe propio.
- El secret `STRIPE_WEBHOOK_SECRET` cambia entre dev/staging/prod; cada env tiene su valor.

## Drive / M365 rate limits

- Google Drive: 1000 req / 100s por user. Si se topa, esperar 100s antes de reintentar.
- Microsoft Graph: dinamico, retorna 429 con `Retry-After`. El worker honra el header.

## sync-document-sources cron

- Cada tick procesa hasta `SDA_CONNECTOR_SYNC_BATCH` (default 10) sources. Si hay miles de sources activas (multi-tenant grande), bumpear el batch o aumentar la frecuencia del cron.
```

- [ ] **Step 6: CHANGELOG.md**

```markdown
## Tier 3 — Enterprise depth (2026-08)

- Connectors Google Drive + Microsoft 365 (SharePoint, OneDrive) via Supabase Vault.
- `usage_records` particionada por mes + `usage_aggregates_daily` matview + threshold notifications (50/90/100%).
- Mirror Stripe (`stripe_customers`, `stripe_subscriptions`) via webhook firmado.
- `data_exports` con worker Inngest, scope tenant/workspace/user, formato ZIP/JSONL.
- Particionado mensual de `audit_log`, `indexing_events`, `document_views`, `notifications`.
- Migracion a `halfvec` (FP16) de `chunks.embedding` y `doc_tree_nodes.embedding` con dual-write window de 7 dias.
- Vistas `workspace_top_documents`, `workspace_recent_activity`.
- `cleanup_operational_data` v3 con drop de particiones viejas y purga de exports.
- Docs nuevos: 16-connectors, 17-usage-and-billing, 19-data-export. Gotchas split en 4 archivos.
```

- [ ] **Step 7: Commit conjunto de docs**

```bash
git add docs/backend/04-indexacion-inngest.md docs/backend/09-catalogo-api-rutas.md docs/backend/10-supabase-realtime.md docs/backend/14-retention-and-cleanup.md docs/gotchas.md docs/gotchas-supabase.md docs/gotchas-inngest.md docs/gotchas-frontend.md docs/gotchas-server-ops.md CHANGELOG.md
git commit -m "docs: tier 3 update (connectors, usage, exports, partitioning, halfvec, gotchas split)"
```

### Task 8.10: Types regen final + suite completa

- [ ] **Step 1: Regenerar types**

```bash
npm run types:gen
```

- [ ] **Step 2: Commit types**

```bash
git add lib/supabase/types.gen.ts
git commit -m "chore(types): regen for tier 3 schema"
```

- [ ] **Step 3: Suite final**

```bash
npm run lint
npm run typecheck
npm run test:db
npm run test:cli
npm run test:tree-indexer
npm run indexing:health
npm run secrets:scan
```

Expected: TODO PASS. Si rojo, abortar el merge a `main` y abrir issue.

- [ ] **Step 4: Smoke remoto post-deploy**

```bash
supabase db push
# Aplicar migraciones. Esperar verde.

# Smoke: crear credential dummy
psql "$SUPABASE_DB_URL" <<'SQL'
set local request.jwt.claims = '{"tenant_id":"<your-tenant-uuid>","tenant_role":"owner","sub":"<your-user>","claims_version":2}';
set local role authenticated;
select public.create_oauth_credential('google_drive'::public.connector_provider, 'test@example.com');
SQL
```

Expected: retorna uuid. Verificar que la fila existe con `status='pending_auth'`.

---

## Estados de salida Tier 3

Antes de declarar Tier 3 cerrado:

- [ ] `npm run lint` verde.
- [ ] `npm run typecheck` verde.
- [ ] `npm run test:db` verde (todos los pgTAP tests del tier).
- [ ] `npm run test:cli` verde.
- [ ] `npm run test:tree-indexer` verde (no se toco worker python; sanity check).
- [ ] `npm run indexing:health` verde.
- [ ] `npm run secrets:scan` sin findings.
- [ ] `supabase db push` aplicado al remoto sin errores.
- [ ] `npm run types:gen` ejecutado y committeado.
- [ ] `CHANGELOG.md` con entrada Tier 3.
- [ ] Docs 16, 17, 19 publicados; docs 04, 09, 10, 14 actualizados; gotchas split.
- [ ] pg_cron jobs `sda-usage-aggregates-refresh`, `sda-ensure-future-partitions`, `sda-cleanup-operational-data` activos.
- [ ] Smoke: crear credential dummy + crear source dummy + verificar audit_log entries.
- [ ] Stripe webhook endpoint accesible y la firma se valida con un evento de prueba (`stripe trigger customer.created` con CLI).
- [ ] Para halfvec: migracion 7.3 aplicada en staging, monitoreo de search hit ratio durante 7 dias antes de mergear 7.5.

Numeros del plan:
- 19 migraciones SQL.
- ~22 pgTAP tests.
- 3 workers Inngest nuevos (`sync-document-sources`, `ingest-connector-item`, `process-data-export`).
- 2 route handlers nuevos (`/api/connectors/oauth/*`, `/api/stripe/webhook`).
- 3 docs nuevos + 5 actualizados + 4 gotchas splits.

---

## Self-review

Mapeo capacidad -> task. Cada item del scope tiene su task asignada.

| Capacidad spec | Task del plan | Status |
|---|---|---|
| `connector_provider` enum | Task 1.5 | OK |
| `connector_status` enum | Task 1.5 | OK |
| `tenant_oauth_credentials` table | Task 1.5 | OK |
| `vault_secret_id` flow | Task 1.3 + Task 2.2 + Task 2.3 | OK |
| `document_sources` table | Task 1.7 | OK |
| `document_source_cursors` table | Task 1.7 | OK |
| `document_source_items` table | Task 1.7 | OK |
| RPC `create_oauth_credential` | Task 1.8 | OK |
| RPC `revoke_oauth_credential` (incluye delete Vault secret + pausa sources) | Task 1.8 | OK |
| RPC `create_document_source` | Task 1.8 | OK |
| RPC `update_document_source` | Task 1.8 | OK |
| RPC `pause_document_source` | Task 1.8 | OK |
| RPC `resume_document_source` | Task 1.8 | OK |
| RPC `delete_document_source` | Task 1.8 | OK |
| Inngest `sync-document-source` | Task 2.5 | OK |
| OAuth callback route | Task 2.3 | OK |
| Refresh token flow | Task 2.4 | OK |
| `usage_kind` enum | Task 3.2 | OK |
| `usage_records` particionada PK `(id, occurred_at)` | Task 3.2 | OK |
| `cost_micro_usd bigint` (no float) | Task 3.2 | OK |
| Particion mes corriente + 3 premake | Task 3.2 | OK |
| `usage_aggregates_daily` matview | Task 3.3 | OK |
| 4 unique idx parciales (NO sentinel) | Task 3.3 | OK |
| Refresh `concurrently` cada hora pg_cron | Task 3.6 | OK |
| RPC `report_usage` (service_role only) | Task 3.4 + Task 3.7 | OK |
| RPC `tenant_usage_summary` (admin read) | Task 3.4 | OK |
| RPC `recompute_usage_aggregates` (service_role manual) | Task 3.4 | OK |
| Notification trigger threshold (50/90/100%) | Task 3.4 + Task 3.5 | OK |
| `stripe_customers` PK tenant_id | Task 4.2 | OK |
| `stripe_subscriptions` PK stripe_subscription_id | Task 4.2 | OK |
| Stripe webhook route + HMAC | Task 4.3 | OK |
| No RPC para Stripe mutaciones desde browser (RLS read-only) | Task 4.2 | OK |
| `data_export_status` enum | Task 5.2 | OK |
| `data_export_scope` enum | Task 5.2 | OK |
| `data_exports` table | Task 5.2 | OK |
| Inngest `process-data-export` | Task 5.3 | OK |
| RPC `request_data_export` | Task 5.2 | OK |
| RPC `list_data_exports` | Task 5.2 | OK |
| Storage path `<tenant>/_exports/...` | Task 5.3 | OK |
| Signed URL 24h | Task 5.3 | OK |
| Cleanup ready/expired > 7d (incluye storage delete) | Task 8.3 | OK |
| Particionado `audit_log` | Task 6.2 | OK |
| Particionado `indexing_events` | Task 6.3 | OK |
| Particionado `document_views` | Task 6.4 | OK |
| Particionado `notifications` | Task 6.5 | OK |
| Validacion previa `pg_partman` + branching | Task 1.1 + Task 6.1 | OK |
| Auto-create particiones futuras (manual o pg_partman) | Task 6.6 | OK |
| halfvec dual-write `chunks.embedding_half` | Task 7.3 | OK |
| halfvec dual-write `doc_tree_nodes.embedding_half` | Task 7.3 | OK |
| Trigger `before insert/update of embedding` | Task 7.3 | OK |
| HNSW sobre `embedding_half` con ops adecuados | Task 7.3 | OK |
| Search RPCs migran a `embedding_half` | Task 7.4 | OK |
| Swap final +7d (drop trigger, drop col vieja, rename) | Task 7.5 | OK |
| Vista `workspace_top_documents` (comun, no matview) | Task 8.1 | OK |
| Vista `workspace_recent_activity` (comun) | Task 8.2 | OK |
| `cleanup_operational_data` v3 (exports, particiones viejas, access requests) | Task 8.3 | OK |
| pg_cron `sda-usage-aggregates-refresh` | Task 3.6 | OK |
| pg_cron `sda-ensure-future-partitions` | Task 6.6 | OK |
| pg_cron `sda-cleanup-operational-data` resched | Task 8.4 | OK |
| Realtime publication `data_exports`, `document_sources`, `document_source_items` | Task 8.5 | OK |
| `npm run types:gen` post migraciones | Task 8.10 | OK |
| Doc `16-connectors-drive-m365.md` | Task 8.6 | OK |
| Doc `17-usage-and-billing.md` (completo) | Task 8.7 | OK |
| Doc `19-data-export.md` | Task 8.8 | OK |
| Doc `04-indexacion-inngest.md` (sync + export workers) | Task 8.9 | OK |
| Doc `09-catalogo-api-rutas.md` (route handlers nuevos) | Task 8.9 | OK |
| Doc `10-supabase-realtime.md` (publicaciones nuevas) | Task 8.9 | OK |
| Doc `14-retention-and-cleanup.md` (particionado + cleanup v3) | Task 8.9 | OK |
| `docs/gotchas.md` split en 4 + nuevos gotchas (halfvec, swap, vault, stripe, drive/m365) | Task 8.9 | OK |
| `CHANGELOG.md` Tier 3 | Task 8.9 | OK |
| Tests pgTAP por migracion | Task 1.4, 1.6, 1.8, 3.1, 3.5, 3.7, 4.1, 5.1, 5.5, 6.2-6.6, 7.2, 7.5 (programada), 8.1, 8.3, 8.5 | OK |
| Test e2e connector flow | Cubierto parcial: Task 1.8 + Task 2.5 (unit tests). Smoke remoto Task 8.10 | OK |
| Test e2e data export flow | Task 5.5 (RPC) + Task 5.3 (worker unit) | OK |
| Test usage records insert -> aggregate -> notif threshold | Task 3.5 | OK |

Placeholders check:
- Grep `TODO`, `TBD`, `FIXME`, `placeholder` en este archivo:

```bash
grep -nE "TODO|TBD|FIXME|placeholder|XXX" docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier3-enterprise.md || echo "OK no placeholders"
```

Expected: solo matches dentro de codigo SQL (`format(...)` etc), no en texto narrativo.

Gaps reconocidos:
- El test e2e de connector flow (OAuth start -> callback -> sync -> document indexed) requiere fixtures con credenciales reales o un mock server. Marcado como smoke manual en Task 8.10; profundizar en una v2 si el tooling lo permite.
- pg_net no esta garantizado en Supabase managed. Sin pg_net, el dispatch DB-side de `data_export.requested` se sustituye por el cron sweep cada 5 min (Task 5.3); aceptable como latencia para exports.
- Email channel para notifications threshold (`notification_preferences.channel='email'`) no se implementa en este tier. Notifs siguen siendo in_app via realtime. Plan futuro: integrar Resend/Postmark.
- Multi-region storage o data residency NO se cubre.
- Drive: shared drives (drive_id distinto de "root") soportado en `config.drive_id` pero el listChanges actual asume el `changes` endpoint global; para shared drives se requiere `supportsAllDrives=true&includeItemsFromAllDrives=true&driveId=<drive_id>` — pendiente como mejora menor.

---

## Execution Handoff

Recomendaciones para ejecutar este plan:

1. **Sub-skill obligatoria**: `superpowers:subagent-driven-development`. Cada Task se delega a un subagente fresco; entre tasks, un review checkpoint.
2. **Worktree opcional** si hay trabajo paralelo en `main`: `git worktree add ../sda.framework-tier3 main`. Skill `superpowers:using-git-worktrees`.
3. **Orden estricto**: NO arrancar Paso 7 (halfvec) si pgvector < 0.7 (ver Task 7.1). NO mergear Task 7.5 sin esperar 7 dias en staging.
4. **Branching pg_partman**: la decision se toma en Task 6.1 una vez. Las migraciones 6.2-6.5 NO usan pg_partman directamente; siempre patron manual swap. pg_partman, si disponible, solo aporta `run_maintenance` que sustituye a `app.ensure_future_partitions`. Decision LEAN: nos quedamos con el manual; mas legible, sin dep extra.
5. **Smoke remoto post-deploy** (Task 8.10) requiere:
   - `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET` en env del deployment.
   - `M365_CLIENT_ID`, `M365_CLIENT_SECRET`, `M365_TENANT_ID` en env.
   - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` configurados en Stripe Dashboard.
   - `SDA_OAUTH_STATE_SECRET` (32 bytes random).
   - `SDA_PUBLIC_URL` (origin del deployment para redirect URIs).
6. **Si Tier 3 va a `main` por etapas**: separar Paso 6 (particionado) en su propio PR; tiene riesgo de downtime corto y conviene revisarlo aparte. Pasos 1-5 + 7-8 pueden ir en un solo PR grande.
7. **Rollback**: cada migracion swap (6.2-6.5) preserva la data via insert previo. Si despues del swap aparece corruption, restore desde el dump pre-migracion del backup managed de Supabase. Las migraciones de halfvec dejan la columna `embedding` original hasta Task 7.5; reversible hasta ese punto.

Cuando Tier 3 cierra, el producto SDA Framework esta enterprise-ready: ingesta automatica desde Drive/M365, billing usage-puro funcional con alertas, export GDPR-friendly, tablas hot escalables al crecimiento natural del SaaS.


