# Supabase Multitenant Platform — Tier 1 Foundation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar la fundacion journey-first del SaaS multi-tenant: workspaces, memberships, groups, collections, tags, soft-delete y RLS unificada con helpers `app.*`, dejando todo doc del tenant viviendo en un workspace concreto y con visibilidad efectiva resuelta en runtime.

**Architecture:** Sumar 8 tablas nuevas (`workspaces`, `workspace_memberships`, `groups`, `group_memberships`, `collections`, `document_collections`, `tags`, `document_tags`) detras de `tenants` con composite FK `(tenant_id, id)` belt-and-suspenders. `documents` gana `workspace_id NOT NULL` (via backfill controlado en 3 sub-migraciones), `deleted_at`/`deleted_by` para soft-delete. Las RLS de toda la nueva superficie + `documents` se unifican via helpers SQL en el esquema `app` (`current_workspace_id`, `user_belongs_to_workspace`, `user_workspace_role`, `user_can_read_document`, `user_can_edit_document`). El JWT hook se bumpa a v2 inyectando `active_workspace_id` y `active_workspace_role` como *hints para UI*; RLS sigue re-verificando membership en runtime.

**Tech Stack:** Supabase Postgres 17, RLS, custom JWT hook, pg_cron, pgTAP, Supabase Realtime publication, Next.js 16 (regen de types `lib/supabase/types.gen.ts`).

**Reference spec:** `docs/superpowers/specs/2026-05-22-supabase-multitenant-audit-design.md` (secciones aplicables: "Modelo de datos — Tier 1", "Modelo de visibilidad y RLS", "JWT claims extendidos", "Migracion 030-036").

**Master plan:** `docs/superpowers/plans/2026-05-22-supabase-multitenant-platform.md`.

---

## Tier overview

Tier 1 introduce la jerarquia `tenant -> workspaces -> collections` y las taxonomias `groups`, `tags`. Toda escritura sensible queda detras de RPCs `security definer` que validan auth + tenant y persisten via `app.audit_with_context`. Soft-delete pattern unificado: `deleted_at` excluido por policy, hard-purge diferido a `cleanup_operational_data` extendido (retention default 30 dias). El JWT hook v2 expone `active_workspace_id` como hint UI; la frontera dura sigue siendo `tenant_id + workspace_memberships`.

Que entrega Tier 1:

- 10 migraciones SQL secuenciales (030 a 036 conceptual, partidas en 12 archivos).
- 10 tablas nuevas (incluye `workspaces`, `workspace_memberships`, `groups`, `group_memberships`, `collections`, `document_collections`, `tags`, `document_tags`).
- 4 enums (`workspace_status`, `workspace_role`, `principal_kind`, `collection_visibility`).
- 5 helpers RLS en `app.*` + 1 helper de auditoria `app.audit_with_context`.
- JWT hook v2 (`claims_version = 2`).
- RPCs nuevas (24): create/update/archive/delete de workspaces, memberships, groups, collections, tags + mutaciones a `documents` (archive/restore/move, `_workspace_id` en `create_document_upload`).
- 4 triggers de auditoria (collection visibility, workspace membership, set_updated_at, polymorphic FK validator).
- Backfill: workspace `Default` por tenant + asignar todos los documentos existentes.
- Cleanup extendido con soft-delete retention.
- Realtime publication: `workspaces`, `collections`, `document_collections`, `document_tags`.
- 4 docs nuevos + 7 docs actualizados + entrada de CHANGELOG.
- 12 pgTAP test suites (1 por migracion).

Que NO entrega Tier 1 (es Tier 2/3, no agregar):

- `message_feedback`, `message_citations`, `user_bookmarks`, `shared_links`, `document_annotations`, `notifications`, `document_views`, `document_issues`, `document_lineage`, `access_requests`, `saved_queries`, `agent_tasks` -> Tier 2.
- Connectors Drive/M365, `tenant_oauth_credentials`, `usage_records`, mirror Stripe, `data_exports`, particionado, `halfvec` -> Tier 3.

## Migration order

Timestamps secuenciales desde `20260522210000_*` (despues de la ultima migracion existente `20260521210000_realtime_product_channels.sql`):

| # | Timestamp | Nombre | Proposito |
|---|---|---|---|
| 030.a | `20260522210000` | `workspaces_core_tables.sql` | Enums `workspace_status`, `workspace_role`, `principal_kind` + tablas `workspaces`, `workspace_memberships`. Sin RLS aun (paso 030.d). |
| 030.b | `20260522210500` | `groups_core_tables.sql` | Tablas `groups`, `group_memberships`. Sin RLS aun. |
| 030.c | `20260522211000` | `workspace_membership_principal_validator.sql` | Trigger `app.check_workspace_membership_principal()` (polymorphic FK). |
| 030.d | `20260522211500` | `workspaces_groups_rls_baseline.sql` | `enable rls` + policies select baseline para `workspaces`, `workspace_memberships`, `groups`, `group_memberships`. |
| 031.a | `20260522212000` | `documents_workspace_id_nullable.sql` | `alter documents add column workspace_id uuid` nullable + composite FK. |
| 031.b | `20260522212500` | `documents_workspace_backfill.sql` | Crear workspace `Default` por tenant, agregar memberships, backfill `documents.workspace_id`. |
| 031.c | `20260522213000` | `documents_workspace_id_not_null.sql` | `set not null` + indices definitivos. |
| 032 | `20260522213500` | `collections_tags_tables.sql` | Enum `collection_visibility` + tablas `collections`, `document_collections`, `tags`, `document_tags` + RLS baseline. |
| 033 | `20260522214000` | `rls_helpers_app.sql` | `app.current_workspace_id`, `user_belongs_to_workspace`, `user_workspace_role`, `user_can_read_document`, `user_can_edit_document`, `audit_with_context`. |
| 034 | `20260522214500` | `auth_jwt_claims_v2.sql` | Extender `app.custom_access_token_hook` con `active_workspace_id`/`active_workspace_role`, `claims_version = 2`. |
| 035 | `20260522215000` | `documents_rls_visible.sql` | Drop policy `documents_select_tenant`, create `documents_select_visible` usando helper. |
| 036 | `20260522215500` | `soft_delete_columns_and_policies.sql` | `deleted_at` en workspaces/collections/groups/tags + soft-delete en `documents` + audit triggers (visibility, membership) + cleanup extendido + realtime publication. |
| RPCs | `20260522220000` | `tier1_rpcs_workspaces_collections.sql` | 24 RPCs `security definer` + ajuste a `create_document_upload`. |

Cada migracion lleva pgTAP test gemelo en `supabase/tests/<nombre_migracion>_test.sql`.

---

## Paso 1 · Workspaces y memberships (Migracion 030.a)

### Task 1.1: Test pgTAP para tablas `workspaces` y `workspace_memberships`

**Files:**
- Create: `supabase/tests/workspaces_core_tables_test.sql`

- [ ] **Step 1: Escribir test pgTAP que valida la existencia de las tablas, enums y constraints**

```sql
BEGIN;
SELECT plan(14);

-- Enums declarados
SELECT has_type('public', 'workspace_status', 'workspace_status enum exists');
SELECT has_type('public', 'workspace_role', 'workspace_role enum exists');
SELECT has_type('public', 'principal_kind', 'principal_kind enum exists');

-- Tablas
SELECT has_table('public', 'workspaces', 'workspaces table exists');
SELECT has_table('public', 'workspace_memberships', 'workspace_memberships table exists');

-- workspaces: composite unique key (tenant_id, id) que sirve de target FK
SELECT col_is_unique(
  'public', 'workspaces', ARRAY['tenant_id','id'],
  'workspaces has composite unique (tenant_id, id)'
);

-- workspaces: tenant + slug unique
SELECT col_is_unique(
  'public', 'workspaces', ARRAY['tenant_id','slug'],
  'workspaces enforces unique slug per tenant'
);

-- workspace_memberships: PK polymorphic
SELECT col_is_pk(
  'public', 'workspace_memberships',
  ARRAY['workspace_id','principal_kind','principal_id'],
  'workspace_memberships PK is (workspace_id, principal_kind, principal_id)'
);

-- workspace_memberships -> workspaces composite FK
SELECT col_is_fk(
  'public', 'workspace_memberships', ARRAY['tenant_id','workspace_id'],
  'workspace_memberships uses composite FK to workspaces'
);

-- enum ordering: viewer < editor < admin (critico para order by role desc limit 1)
SELECT is(
  ARRAY(
    SELECT enumlabel
    FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'workspace_role'
    ORDER BY e.enumsortorder
  ),
  ARRAY['workspace_viewer','workspace_editor','workspace_admin'],
  'workspace_role declared low-to-high so order desc returns max role'
);

-- slug regex enforcement
PREPARE bad_slug AS
  insert into public.tenants (id, slug, name) values ('00000000-0000-0000-0000-000000003001', 'wsp-tenant', 'WSP Tenant');
EXECUTE bad_slug;

SELECT throws_ok(
  $$ insert into public.workspaces (tenant_id, slug, name)
       values ('00000000-0000-0000-0000-000000003001', 'BAD SLUG', 'bad') $$,
  '23514',
  NULL,
  'slug regex rejects uppercase/spaces'
);

SELECT lives_ok(
  $$ insert into public.workspaces (tenant_id, slug, name)
       values ('00000000-0000-0000-0000-000000003001', 'engineering', 'Engineering') $$,
  'workspaces accepts a valid lower-snake slug'
);

-- archived workspace ok
SELECT lives_ok(
  $$ update public.workspaces set status = 'archived', archived_at = now()
     where tenant_id = '00000000-0000-0000-0000-000000003001' and slug = 'engineering' $$,
  'workspaces accepts archived status'
);

-- workspace_memberships principal_kind enum coverage
SELECT is(
  ARRAY(
    SELECT enumlabel
    FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'principal_kind'
    ORDER BY e.enumsortorder
  ),
  ARRAY['user','group'],
  'principal_kind enum has user, group'
);

-- set_updated_at trigger se aplica
SELECT trigger_is(
  'public', 'workspaces', 'set_workspaces_updated_at',
  'app', 'set_updated_at',
  'workspaces has set_updated_at trigger'
);

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Correr el test y verificar que FAILA con "relation does not exist"**

```bash
npm run test:db -- --file workspaces_core_tables_test.sql
```

Expected: `ERROR: type "public.workspace_status" does not exist` o equivalente. Confirma que el test detecta ausencia de las tablas/enums.

- [ ] **Step 3: Escribir migracion `20260522210000_workspaces_core_tables.sql`**

```sql
-- 030.a — workspaces + workspace_memberships
-- Tablas base de la jerarquia tenant -> workspace. Sin RLS aun (030.d).

create type public.workspace_status as enum ('active', 'archived');

-- IMPORTANTE: el orden de declaracion del enum define el orden de comparacion.
-- declarado de menor a mayor para que `order by role desc limit 1` resuelva
-- al rol mas alto naturalmente cuando un user es miembro directo y via grupo
-- a la vez. Postgres no tiene `max(enum)`, este patron lo reemplaza.
create type public.workspace_role as enum (
  'workspace_viewer',
  'workspace_editor',
  'workspace_admin'
);

create type public.principal_kind as enum ('user', 'group');

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
  unique (tenant_id, id),
  unique (tenant_id, slug)
);

create index workspaces_tenant_status_idx
  on public.workspaces (tenant_id, status);
create index workspaces_tenant_alive_idx
  on public.workspaces (tenant_id) where deleted_at is null;

create trigger set_workspaces_updated_at
before update on public.workspaces
for each row execute function app.set_updated_at();

create table public.workspace_memberships (
  workspace_id uuid not null,
  tenant_id uuid not null,
  principal_kind public.principal_kind not null,
  principal_id uuid not null,
  role public.workspace_role not null default 'workspace_viewer',
  added_at timestamptz not null default now(),
  added_by uuid references auth.users(id) on delete set null,
  primary key (workspace_id, principal_kind, principal_id),
  foreign key (tenant_id, workspace_id)
    references public.workspaces(tenant_id, id) on delete cascade
);

create index workspace_memberships_principal_idx
  on public.workspace_memberships (tenant_id, principal_kind, principal_id);
create index workspace_memberships_role_idx
  on public.workspace_memberships (tenant_id, workspace_id, role);
```

- [ ] **Step 4: Correr el test y verificar que PASA**

```bash
npm run test:db -- --file workspaces_core_tables_test.sql
```

Expected: `ok 1 .. ok 14`, todos los asserts verdes.

- [ ] **Step 5: Correr suite completo de test:db**

```bash
npm run test:db
```

Expected: todos los tests pre-existentes siguen verdes, ningun regression.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260522210000_workspaces_core_tables.sql \
        supabase/tests/workspaces_core_tables_test.sql
git commit -m "feat(db): add workspaces and workspace_memberships tables (tier1 030.a)"
```

---

## Paso 2 · Groups y group_memberships (Migracion 030.b)

### Task 2.1: Test pgTAP para `groups` y `group_memberships`

**Files:**
- Create: `supabase/tests/groups_core_tables_test.sql`

- [ ] **Step 1: Escribir test pgTAP**

```sql
BEGIN;
SELECT plan(10);

SELECT has_table('public', 'groups', 'groups table exists');
SELECT has_table('public', 'group_memberships', 'group_memberships table exists');

SELECT col_is_unique(
  'public', 'groups', ARRAY['tenant_id','key'],
  'groups enforces unique key per tenant'
);

SELECT col_is_pk(
  'public', 'group_memberships', ARRAY['group_id','user_id'],
  'group_memberships PK is (group_id, user_id)'
);

-- key regex
insert into public.tenants (id, slug, name)
values ('00000000-0000-0000-0000-000000003002', 'grp-tenant', 'Group Tenant');

SELECT throws_ok(
  $$ insert into public.groups (tenant_id, key, name)
       values ('00000000-0000-0000-0000-000000003002', 'Bad-Key', 'bad') $$,
  '23514',
  NULL,
  'group key regex rejects uppercase'
);

SELECT lives_ok(
  $$ insert into public.groups (tenant_id, key, name)
       values ('00000000-0000-0000-0000-000000003002', 'legal', 'Legal') $$,
  'group accepts valid key'
);

-- set_updated_at trigger
SELECT trigger_is(
  'public', 'groups', 'set_groups_updated_at',
  'app', 'set_updated_at',
  'groups has set_updated_at trigger'
);

-- group_memberships con cascade
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000003012',
  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'grp@grp-tenant.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.users (id, tenant_id, email, role, status)
values ('00000000-0000-0000-0000-000000003012',
  '00000000-0000-0000-0000-000000003002',
  'grp@grp-tenant.test', 'member', 'active');

SELECT lives_ok(
  $$ insert into public.group_memberships (group_id, user_id, tenant_id)
     select id, '00000000-0000-0000-0000-000000003012',
            '00000000-0000-0000-0000-000000003002'
     from public.groups where key = 'legal'
       and tenant_id = '00000000-0000-0000-0000-000000003002' $$,
  'group_memberships accepts (group_id, user_id) insert'
);

-- group_memberships_tenant_user_idx existe
SELECT has_index(
  'public', 'group_memberships', 'group_memberships_tenant_user_idx',
  'group_memberships has index by (tenant_id, user_id)'
);

-- groups_tenant_deleted_at_idx existe
SELECT has_index(
  'public', 'groups', 'groups_tenant_deleted_at_idx',
  'groups has partial index on alive rows'
);

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Correr el test y verificar que FAILA**

```bash
npm run test:db -- --file groups_core_tables_test.sql
```

Expected: `relation "public.groups" does not exist`.

- [ ] **Step 3: Escribir migracion `20260522210500_groups_core_tables.sql`**

```sql
-- 030.b — groups + group_memberships a nivel tenant.
-- Un grupo puede ser miembro de varios workspaces via workspace_memberships
-- con principal_kind='group'. El grupo no tiene rol propio.

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
  unique (tenant_id, id),
  unique (tenant_id, key)
);

create index groups_tenant_deleted_at_idx
  on public.groups (tenant_id) where deleted_at is null;

create trigger set_groups_updated_at
before update on public.groups
for each row execute function app.set_updated_at();

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
create index group_memberships_group_idx
  on public.group_memberships (tenant_id, group_id);
```

- [ ] **Step 4: Correr test y verificar que PASA**

```bash
npm run test:db -- --file groups_core_tables_test.sql
```

Expected: `ok 1 .. ok 10`.

- [ ] **Step 5: Correr suite completo**

```bash
npm run test:db
```

Expected: todos verdes.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260522210500_groups_core_tables.sql \
        supabase/tests/groups_core_tables_test.sql
git commit -m "feat(db): add groups and group_memberships tables (tier1 030.b)"
```

---

## Paso 3 · Polymorphic FK validator (Migracion 030.c)

`workspace_memberships.principal_id` apunta a `auth.users` o `public.groups` segun `principal_kind`. Postgres no soporta FK polymorphic; sin trigger se pueden insertar uuids fantasma (observacion del code review del spec).

### Task 3.1: Test pgTAP que valida el trigger

**Files:**
- Create: `supabase/tests/workspace_membership_principal_validator_test.sql`

- [ ] **Step 1: Escribir test que verifica rechazos**

```sql
BEGIN;
SELECT plan(6);

insert into public.tenants (id, slug, name)
values ('00000000-0000-0000-0000-000000003101', 'validator-tenant', 'Validator Tenant');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000003111',
  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'user@validator-tenant.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.users (id, tenant_id, email, role, status)
values ('00000000-0000-0000-0000-000000003111',
  '00000000-0000-0000-0000-000000003101',
  'user@validator-tenant.test', 'member', 'active');

insert into public.workspaces (id, tenant_id, slug, name)
values ('00000000-0000-0000-0000-000000003121',
  '00000000-0000-0000-0000-000000003101', 'wsp', 'WSP');

insert into public.groups (id, tenant_id, key, name)
values ('00000000-0000-0000-0000-000000003131',
  '00000000-0000-0000-0000-000000003101', 'grp', 'Group');

-- 1: inserting principal_kind='user' apuntando a un user real funciona
SELECT lives_ok(
  $$ insert into public.workspace_memberships
       (workspace_id, tenant_id, principal_kind, principal_id, role)
     values
       ('00000000-0000-0000-0000-000000003121',
        '00000000-0000-0000-0000-000000003101',
        'user', '00000000-0000-0000-0000-000000003111',
        'workspace_editor') $$,
  'principal_kind=user with real user inserts ok'
);

-- 2: principal_kind='user' apuntando a uuid fantasma falla
SELECT throws_ok(
  $$ insert into public.workspace_memberships
       (workspace_id, tenant_id, principal_kind, principal_id, role)
     values
       ('00000000-0000-0000-0000-000000003121',
        '00000000-0000-0000-0000-000000003101',
        'user', '00000000-0000-0000-0000-0000000099ff',
        'workspace_editor') $$,
  'P0001',
  NULL,
  'principal_kind=user with phantom uuid is rejected'
);

-- 3: principal_kind='group' apuntando a un group real funciona
SELECT lives_ok(
  $$ insert into public.workspace_memberships
       (workspace_id, tenant_id, principal_kind, principal_id, role)
     values
       ('00000000-0000-0000-0000-000000003121',
        '00000000-0000-0000-0000-000000003101',
        'group', '00000000-0000-0000-0000-000000003131',
        'workspace_viewer') $$,
  'principal_kind=group with real group inserts ok'
);

-- 4: principal_kind='group' apuntando a uuid fantasma falla
SELECT throws_ok(
  $$ insert into public.workspace_memberships
       (workspace_id, tenant_id, principal_kind, principal_id, role)
     values
       ('00000000-0000-0000-0000-000000003121',
        '00000000-0000-0000-0000-000000003101',
        'group', '00000000-0000-0000-0000-0000000099ee',
        'workspace_viewer') $$,
  'P0001',
  NULL,
  'principal_kind=group with phantom uuid is rejected'
);

-- 5: principal_kind='group' apuntando a un group de OTRO tenant falla
insert into public.tenants (id, slug, name)
values ('00000000-0000-0000-0000-000000003102', 'other-tenant', 'Other Tenant');

insert into public.groups (id, tenant_id, key, name)
values ('00000000-0000-0000-0000-000000003132',
  '00000000-0000-0000-0000-000000003102', 'foreign', 'Foreign');

SELECT throws_ok(
  $$ insert into public.workspace_memberships
       (workspace_id, tenant_id, principal_kind, principal_id, role)
     values
       ('00000000-0000-0000-0000-000000003121',
        '00000000-0000-0000-0000-000000003101',
        'group', '00000000-0000-0000-0000-000000003132',
        'workspace_viewer') $$,
  'P0001',
  NULL,
  'cross-tenant group principal is rejected'
);

-- 6: principal_kind='user' apuntando a user de otro tenant (publico.users)
-- tambien se rechaza si el trigger cruza por public.users.tenant_id.
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000003112',
  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'foreign-user@other.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.users (id, tenant_id, email, role, status)
values ('00000000-0000-0000-0000-000000003112',
  '00000000-0000-0000-0000-000000003102',
  'foreign-user@other.test', 'member', 'active');

SELECT throws_ok(
  $$ insert into public.workspace_memberships
       (workspace_id, tenant_id, principal_kind, principal_id, role)
     values
       ('00000000-0000-0000-0000-000000003121',
        '00000000-0000-0000-0000-000000003101',
        'user', '00000000-0000-0000-0000-000000003112',
        'workspace_viewer') $$,
  'P0001',
  NULL,
  'cross-tenant user principal is rejected'
);

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Correr el test y verificar que FAILA**

```bash
npm run test:db -- --file workspace_membership_principal_validator_test.sql
```

Expected: el caso 2 (uuid fantasma) inserta sin error porque no hay trigger; el test reporta `not ok 2`. Confirma el agujero.

- [ ] **Step 3: Escribir migracion `20260522211000_workspace_membership_principal_validator.sql`**

```sql
-- 030.c — trigger validator polymorphic FK para workspace_memberships.
-- Postgres no soporta FK polymorphic. Sin este trigger se pueden insertar
-- uuids fantasma o cross-tenant.

create or replace function app.check_workspace_membership_principal()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  exists_principal boolean;
begin
  if new.principal_kind = 'user' then
    select exists (
      select 1 from public.users u
      where u.id = new.principal_id
        and u.tenant_id = new.tenant_id
    ) into exists_principal;

    if not exists_principal then
      raise exception 'workspace_membership principal user % not found in tenant %',
        new.principal_id, new.tenant_id
        using errcode = 'P0001';
    end if;

  elsif new.principal_kind = 'group' then
    select exists (
      select 1 from public.groups g
      where g.id = new.principal_id
        and g.tenant_id = new.tenant_id
        and g.deleted_at is null
    ) into exists_principal;

    if not exists_principal then
      raise exception 'workspace_membership principal group % not found in tenant %',
        new.principal_id, new.tenant_id
        using errcode = 'P0001';
    end if;

  else
    raise exception 'workspace_membership unsupported principal_kind %', new.principal_kind
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists check_workspace_membership_principal
  on public.workspace_memberships;

create trigger check_workspace_membership_principal
before insert or update of principal_kind, principal_id, tenant_id
on public.workspace_memberships
for each row execute function app.check_workspace_membership_principal();
```

- [ ] **Step 4: Correr el test y verificar que PASA**

```bash
npm run test:db -- --file workspace_membership_principal_validator_test.sql
```

Expected: `ok 1 .. ok 6`, todos los rechazos detectados.

- [ ] **Step 5: Correr suite completo**

```bash
npm run test:db
```

Expected: todos verdes.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260522211000_workspace_membership_principal_validator.sql \
        supabase/tests/workspace_membership_principal_validator_test.sql
git commit -m "feat(db): validate workspace_membership polymorphic principal (tier1 030.c)"
```

---

## Paso 4 · RLS baseline para workspaces y groups (Migracion 030.d)

Las 4 tablas creadas (workspaces, workspace_memberships, groups, group_memberships) necesitan `enable rls` + policy select de baseline. Sin esto incumplen la regla del proyecto ("toda tabla nueva con RLS"). Los helpers `app.user_belongs_to_workspace` llegan en Migracion 033; aca solo aplicamos politicas que dependen de `app.current_tenant_id()` ya existente.

### Task 4.1: Test pgTAP que valida que RLS bloquea cross-tenant

**Files:**
- Create: `supabase/tests/workspaces_groups_rls_baseline_test.sql`

- [ ] **Step 1: Escribir test con JWT mock cross-tenant**

```sql
BEGIN;
SELECT plan(12);

-- Setup: 2 tenants, 2 workspaces, 2 groups
insert into public.tenants (id, slug, name) values
  ('00000000-0000-0000-0000-000000003201', 'rls-alpha', 'RLS Alpha'),
  ('00000000-0000-0000-0000-000000003202', 'rls-beta',  'RLS Beta');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000003211',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'alpha@rls.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000003212',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'beta@rls.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.users (id, tenant_id, email, role, status) values
  ('00000000-0000-0000-0000-000000003211',
   '00000000-0000-0000-0000-000000003201', 'alpha@rls.test', 'admin', 'active'),
  ('00000000-0000-0000-0000-000000003212',
   '00000000-0000-0000-0000-000000003202', 'beta@rls.test', 'member', 'active');

insert into public.workspaces (id, tenant_id, slug, name) values
  ('00000000-0000-0000-0000-000000003221',
   '00000000-0000-0000-0000-000000003201', 'alpha-ws', 'Alpha WS'),
  ('00000000-0000-0000-0000-000000003222',
   '00000000-0000-0000-0000-000000003202', 'beta-ws', 'Beta WS');

insert into public.groups (id, tenant_id, key, name) values
  ('00000000-0000-0000-0000-000000003231',
   '00000000-0000-0000-0000-000000003201', 'alpha-grp', 'Alpha Group'),
  ('00000000-0000-0000-0000-000000003232',
   '00000000-0000-0000-0000-000000003202', 'beta-grp', 'Beta Group');

-- Tablas con RLS habilitada
SELECT is(
  (select relrowsecurity from pg_class where oid = 'public.workspaces'::regclass),
  true,
  'workspaces has RLS enabled'
);
SELECT is(
  (select relrowsecurity from pg_class where oid = 'public.workspace_memberships'::regclass),
  true,
  'workspace_memberships has RLS enabled'
);
SELECT is(
  (select relrowsecurity from pg_class where oid = 'public.groups'::regclass),
  true,
  'groups has RLS enabled'
);
SELECT is(
  (select relrowsecurity from pg_class where oid = 'public.group_memberships'::regclass),
  true,
  'group_memberships has RLS enabled'
);

-- Set JWT como user alpha (admin)
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '00000000-0000-0000-0000-000000003211',
    'role', 'authenticated',
    'tenant_id', '00000000-0000-0000-0000-000000003201',
    'tenant_role', 'admin'
  )::text, true
);
set local role authenticated;

SELECT is(
  (select count(*)::integer from public.workspaces),
  1,
  'alpha admin sees only alpha workspace'
);
SELECT is(
  (select slug from public.workspaces),
  'alpha-ws',
  'alpha admin sees alpha-ws'
);
SELECT is(
  (select count(*)::integer from public.groups),
  1,
  'alpha admin sees only alpha group (directory)'
);

reset role;
select set_config('request.jwt.claims', null, true);

-- Set JWT como user beta (member)
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '00000000-0000-0000-0000-000000003212',
    'role', 'authenticated',
    'tenant_id', '00000000-0000-0000-0000-000000003202',
    'tenant_role', 'member'
  )::text, true
);
set local role authenticated;

SELECT is(
  (select count(*)::integer from public.workspaces),
  1,
  'beta member sees only beta workspace'
);
SELECT is(
  (select slug from public.workspaces),
  'beta-ws',
  'beta member sees beta-ws'
);
SELECT is(
  (select count(*)::integer from public.groups),
  1,
  'beta member sees only beta group'
);
SELECT is(
  (select count(*)::integer from public.workspace_memberships),
  0,
  'beta member sees zero memberships when no row matches tenant'
);
SELECT is(
  (select count(*)::integer from public.group_memberships),
  0,
  'beta member sees zero group_memberships baseline'
);

reset role;
SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Correr el test y verificar que FAILA**

```bash
npm run test:db -- --file workspaces_groups_rls_baseline_test.sql
```

Expected: `relrowsecurity` es `false` (RLS no habilitada) -> los primeros 4 asserts fallan.

- [ ] **Step 3: Escribir migracion `20260522211500_workspaces_groups_rls_baseline.sql`**

```sql
-- 030.d — RLS baseline para workspaces, workspace_memberships, groups, group_memberships.
-- Helpers especializados (user_belongs_to_workspace, user_workspace_role) llegan
-- en migracion 033. Aca aplicamos policy basica por tenant; las policies finales
-- las reemplaza la 033 cuando los helpers existen.

alter table public.workspaces enable row level security;
alter table public.workspace_memberships enable row level security;
alter table public.groups enable row level security;
alter table public.group_memberships enable row level security;

create policy workspaces_select_tenant on public.workspaces
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and deleted_at is null
  );

create policy workspace_memberships_select_tenant on public.workspace_memberships
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
  );

create policy groups_select_tenant on public.groups
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and deleted_at is null
  );

create policy group_memberships_select_tenant on public.group_memberships
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
  );

-- write boundary: nada de insert/update/delete por usuarios autenticados.
-- todo escribe via RPCs security definer (migracion de RPCs).
revoke insert, update, delete on public.workspaces from authenticated;
revoke insert, update, delete on public.workspace_memberships from authenticated;
revoke insert, update, delete on public.groups from authenticated;
revoke insert, update, delete on public.group_memberships from authenticated;
```

- [ ] **Step 4: Correr el test y verificar que PASA**

```bash
npm run test:db -- --file workspaces_groups_rls_baseline_test.sql
```

Expected: `ok 1 .. ok 12`.

- [ ] **Step 5: Correr suite completo**

```bash
npm run test:db
```

Expected: todos verdes.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260522211500_workspaces_groups_rls_baseline.sql \
        supabase/tests/workspaces_groups_rls_baseline_test.sql
git commit -m "feat(db): enable RLS baseline on workspaces and groups (tier1 030.d)"
```

---

## Paso 5 · documents.workspace_id nullable (Migracion 031.a)

### Task 5.1: Test pgTAP — columna y FK composite agregadas, todavia nullable

**Files:**
- Create: `supabase/tests/documents_workspace_id_nullable_test.sql`

- [ ] **Step 1: Escribir test**

```sql
BEGIN;
SELECT plan(6);

SELECT has_column(
  'public', 'documents', 'workspace_id',
  'documents has workspace_id column'
);

-- nullable porque el backfill no ocurrio aun
SELECT col_is_null(
  'public', 'documents', 'workspace_id',
  'documents.workspace_id is nullable in 031.a'
);

-- composite FK declarada
SELECT col_is_fk(
  'public', 'documents', ARRAY['tenant_id','workspace_id'],
  'documents has composite FK to workspaces'
);

-- soft-delete columns
SELECT has_column(
  'public', 'documents', 'deleted_at',
  'documents has deleted_at column'
);
SELECT has_column(
  'public', 'documents', 'deleted_by',
  'documents has deleted_by column'
);

-- documents existentes siguen viviendo (nullable + sin backfill)
insert into public.tenants (id, slug, name)
values ('00000000-0000-0000-0000-000000003301', 'nullable-tenant', 'Nullable');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000003311',
  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'n@n.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.users (id, tenant_id, email, role, status)
values ('00000000-0000-0000-0000-000000003311',
  '00000000-0000-0000-0000-000000003301', 'n@n.test', 'member', 'active');

SELECT lives_ok(
  $$ insert into public.documents
       (id, tenant_id, created_by, filename, r2_key, status)
     values
       ('00000000-0000-0000-0000-000000003321',
        '00000000-0000-0000-0000-000000003301',
        '00000000-0000-0000-0000-000000003311',
        'doc.pdf',
        '00000000-0000-0000-0000-000000003301/00000000-0000-0000-0000-000000003321/doc.pdf',
        'uploaded') $$,
  'documents accepts row with NULL workspace_id pre-backfill'
);

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Correr y verificar que FAILA**

```bash
npm run test:db -- --file documents_workspace_id_nullable_test.sql
```

Expected: `column "workspace_id" of relation "documents" does not exist`.

- [ ] **Step 3: Escribir migracion `20260522212000_documents_workspace_id_nullable.sql`**

```sql
-- 031.a — agregar documents.workspace_id NULLABLE + FK composite.
-- El backfill ocurre en 031.b. set not null en 031.c.

alter table public.documents
  add column workspace_id uuid,
  add column deleted_at timestamptz,
  add column deleted_by uuid references auth.users(id) on delete set null;

alter table public.documents
  add constraint documents_workspace_fk
  foreign key (tenant_id, workspace_id)
  references public.workspaces(tenant_id, id) on delete restrict
  not valid;
-- `not valid`: no escanea filas existentes (todas tienen workspace_id NULL,
-- aceptables ahora). Se validara despues del backfill en 031.c.

-- Indice intermedio para apoyar el join del backfill. Final en 031.c.
create index if not exists documents_tenant_workspace_partial_idx
  on public.documents (tenant_id, workspace_id)
  where workspace_id is not null;

-- Indice para localizar documentos sin workspace (used by 031.b backfill query)
create index if not exists documents_workspace_id_null_idx
  on public.documents (tenant_id)
  where workspace_id is null and deleted_at is null;
```

- [ ] **Step 4: Correr test y verificar que PASA**

```bash
npm run test:db -- --file documents_workspace_id_nullable_test.sql
```

Expected: `ok 1 .. ok 6`.

- [ ] **Step 5: Correr suite completo**

```bash
npm run test:db
```

Expected: verde.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260522212000_documents_workspace_id_nullable.sql \
        supabase/tests/documents_workspace_id_nullable_test.sql
git commit -m "feat(db): add documents.workspace_id nullable + soft-delete cols (tier1 031.a)"
```

---

## Paso 6 · Backfill workspace Default (Migracion 031.b)

Crear un workspace `Default` por tenant existente, agregar a todos los users active como miembros con rol mapeado, asignar `documents.workspace_id` al workspace Default del tenant. Mapeo de roles tenant -> workspace:
- `owner` -> `workspace_admin`
- `admin` -> `workspace_admin`
- `member` -> `workspace_editor`
- `viewer` -> `workspace_viewer`

### Task 6.1: Test pgTAP del backfill

**Files:**
- Create: `supabase/tests/documents_workspace_backfill_test.sql`

- [ ] **Step 1: Escribir test que verifica idempotencia y mapeo de roles**

```sql
BEGIN;
SELECT plan(10);

-- Pre-seed: dos tenants, users con distintos roles, un documento sin workspace
insert into public.tenants (id, slug, name) values
  ('00000000-0000-0000-0000-000000003401', 'bf-alpha', 'BF Alpha'),
  ('00000000-0000-0000-0000-000000003402', 'bf-beta', 'BF Beta');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000003411',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'owner@bf-alpha.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000003412',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'admin@bf-alpha.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000003413',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'member@bf-alpha.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000003414',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'viewer@bf-alpha.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000003415',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'disabled@bf-alpha.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.users (id, tenant_id, email, role, status) values
  ('00000000-0000-0000-0000-000000003411',
   '00000000-0000-0000-0000-000000003401', 'owner@bf-alpha.test', 'owner', 'active'),
  ('00000000-0000-0000-0000-000000003412',
   '00000000-0000-0000-0000-000000003401', 'admin@bf-alpha.test', 'admin', 'active'),
  ('00000000-0000-0000-0000-000000003413',
   '00000000-0000-0000-0000-000000003401', 'member@bf-alpha.test', 'member', 'active'),
  ('00000000-0000-0000-0000-000000003414',
   '00000000-0000-0000-0000-000000003401', 'viewer@bf-alpha.test', 'viewer', 'active'),
  ('00000000-0000-0000-0000-000000003415',
   '00000000-0000-0000-0000-000000003401', 'disabled@bf-alpha.test', 'member', 'disabled');

insert into public.documents
  (id, tenant_id, created_by, filename, r2_key, status, uploaded_at) values
  ('00000000-0000-0000-0000-000000003421',
   '00000000-0000-0000-0000-000000003401',
   '00000000-0000-0000-0000-000000003411',
   'a.pdf',
   '00000000-0000-0000-0000-000000003401/00000000-0000-0000-0000-000000003421/a.pdf',
   'uploaded', now()),
  ('00000000-0000-0000-0000-000000003422',
   '00000000-0000-0000-0000-000000003402',
   null,
   'b.pdf',
   '00000000-0000-0000-0000-000000003402/00000000-0000-0000-0000-000000003422/b.pdf',
   'uploaded', now());

-- Ejecutar el backfill (idempotente)
SELECT lives_ok(
  $$ select public.tier1_backfill_default_workspaces() $$,
  'tier1_backfill_default_workspaces runs without error'
);

-- Cada tenant tiene workspace Default
SELECT is(
  (select count(*)::integer from public.workspaces
    where tenant_id = '00000000-0000-0000-0000-000000003401' and slug = 'default'),
  1,
  'tenant alpha has Default workspace'
);
SELECT is(
  (select count(*)::integer from public.workspaces
    where tenant_id = '00000000-0000-0000-0000-000000003402' and slug = 'default'),
  1,
  'tenant beta has Default workspace'
);

-- Mapeo de roles correcto, disabled NO se agrega
SELECT is(
  (select role::text from public.workspace_memberships wm
    join public.workspaces w on w.id = wm.workspace_id
   where w.tenant_id = '00000000-0000-0000-0000-000000003401'
     and w.slug = 'default'
     and wm.principal_kind = 'user'
     and wm.principal_id = '00000000-0000-0000-0000-000000003411'),
  'workspace_admin',
  'owner -> workspace_admin'
);
SELECT is(
  (select role::text from public.workspace_memberships wm
    join public.workspaces w on w.id = wm.workspace_id
   where w.tenant_id = '00000000-0000-0000-0000-000000003401'
     and w.slug = 'default'
     and wm.principal_kind = 'user'
     and wm.principal_id = '00000000-0000-0000-0000-000000003412'),
  'workspace_admin',
  'admin -> workspace_admin'
);
SELECT is(
  (select role::text from public.workspace_memberships wm
    join public.workspaces w on w.id = wm.workspace_id
   where w.tenant_id = '00000000-0000-0000-0000-000000003401'
     and w.slug = 'default'
     and wm.principal_kind = 'user'
     and wm.principal_id = '00000000-0000-0000-0000-000000003413'),
  'workspace_editor',
  'member -> workspace_editor'
);
SELECT is(
  (select role::text from public.workspace_memberships wm
    join public.workspaces w on w.id = wm.workspace_id
   where w.tenant_id = '00000000-0000-0000-0000-000000003401'
     and w.slug = 'default'
     and wm.principal_kind = 'user'
     and wm.principal_id = '00000000-0000-0000-0000-000000003414'),
  'workspace_viewer',
  'viewer -> workspace_viewer'
);
SELECT is(
  (select count(*)::integer from public.workspace_memberships wm
    join public.workspaces w on w.id = wm.workspace_id
   where w.tenant_id = '00000000-0000-0000-0000-000000003401'
     and w.slug = 'default'
     and wm.principal_kind = 'user'
     and wm.principal_id = '00000000-0000-0000-0000-000000003415'),
  0,
  'disabled user not added as workspace member'
);

-- Documentos asignados al workspace Default del tenant
SELECT is(
  (select workspace_id from public.documents
    where id = '00000000-0000-0000-0000-000000003421'),
  (select id from public.workspaces
    where tenant_id = '00000000-0000-0000-0000-000000003401' and slug = 'default'),
  'document a.pdf assigned to alpha Default workspace'
);

-- Re-correr el backfill es idempotente (mismo conteo)
SELECT lives_ok(
  $$ select public.tier1_backfill_default_workspaces() $$,
  'backfill is idempotent on second run'
);

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Correr y verificar que FAILA**

```bash
npm run test:db -- --file documents_workspace_backfill_test.sql
```

Expected: `function public.tier1_backfill_default_workspaces() does not exist`.

- [ ] **Step 3: Escribir migracion `20260522212500_documents_workspace_backfill.sql`**

```sql
-- 031.b — backfill: workspace Default por tenant + memberships + documents.workspace_id.
-- Idempotente. Se invoca al final de la migracion. La funcion publica queda
-- disponible para re-correrla en staging si hace falta.

create or replace function public.tier1_backfill_default_workspaces()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  tenant_record record;
  ws_id uuid;
  created_workspaces integer := 0;
  ensured_workspaces integer := 0;
  added_members integer := 0;
  updated_documents integer := 0;
  inserted_members integer;
  affected_docs integer;
begin
  for tenant_record in
    select id from public.tenants
    where status = 'active'
    order by created_at asc
  loop
    -- Crear workspace Default si no existe (idempotente via unique tenant_id+slug)
    insert into public.workspaces
      (tenant_id, slug, name, description, status, settings)
    values (
      tenant_record.id,
      'default',
      'Default',
      'Workspace por defecto creado durante la migracion 031.b (Tier 1).',
      'active',
      jsonb_build_object('source', 'tier1_backfill', 'auto_created', true)
    )
    on conflict (tenant_id, slug) do nothing;

    select id into ws_id
    from public.workspaces
    where tenant_id = tenant_record.id and slug = 'default'
    limit 1;

    if ws_id is null then
      raise exception 'tier1 backfill: workspace Default no se pudo asegurar para tenant %', tenant_record.id;
    end if;

    if found then
      ensured_workspaces := ensured_workspaces + 1;
    end if;

    -- Agregar todos los users active como miembros con rol mapeado.
    -- On conflict do nothing -> idempotente.
    with mapped as (
      select
        ws_id as workspace_id,
        tenant_record.id as tenant_id,
        'user'::public.principal_kind as principal_kind,
        u.id as principal_id,
        case u.role
          when 'owner'  then 'workspace_admin'::public.workspace_role
          when 'admin'  then 'workspace_admin'::public.workspace_role
          when 'member' then 'workspace_editor'::public.workspace_role
          when 'viewer' then 'workspace_viewer'::public.workspace_role
        end as role
      from public.users u
      where u.tenant_id = tenant_record.id
        and u.status = 'active'
    ),
    ins as (
      insert into public.workspace_memberships
        (workspace_id, tenant_id, principal_kind, principal_id, role)
      select workspace_id, tenant_id, principal_kind, principal_id, role
      from mapped
      where role is not null
      on conflict (workspace_id, principal_kind, principal_id) do nothing
      returning 1
    )
    select count(*)::integer into inserted_members from ins;

    added_members := added_members + coalesce(inserted_members, 0);

    -- Asignar workspace_id a documentos del tenant que aun no lo tengan
    update public.documents
       set workspace_id = ws_id
     where tenant_id = tenant_record.id
       and workspace_id is null;
    get diagnostics affected_docs = row_count;

    updated_documents := updated_documents + coalesce(affected_docs, 0);

    if not exists (
      select 1 from public.workspaces
      where tenant_id = tenant_record.id and slug = 'default'
        and settings ->> 'source' = 'tier1_backfill'
    ) then
      ensured_workspaces := ensured_workspaces;
    else
      created_workspaces := created_workspaces + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'created_or_ensured_workspaces', created_workspaces,
    'added_members', added_members,
    'updated_documents', updated_documents
  );
end;
$$;

revoke all on function public.tier1_backfill_default_workspaces()
  from anon, authenticated, public;
grant execute on function public.tier1_backfill_default_workspaces()
  to service_role;

-- Ejecutar el backfill ahora.
do $$
declare result jsonb;
begin
  result := public.tier1_backfill_default_workspaces();
  raise notice 'tier1 backfill result: %', result;
end;
$$;

-- Trigger para que cuando se cree un tenant nuevo, automaticamente exista
-- el workspace Default. Garantiza que ningun tenant quede sin workspace.
create or replace function app.ensure_default_workspace_for_tenant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.workspaces
    (tenant_id, slug, name, description, status, settings)
  values (
    new.id,
    'default',
    'Default',
    'Workspace por defecto creado en alta de tenant.',
    'active',
    jsonb_build_object('source', 'tenant_created', 'auto_created', true)
  )
  on conflict (tenant_id, slug) do nothing;

  return new;
end;
$$;

drop trigger if exists ensure_default_workspace_for_tenant on public.tenants;
create trigger ensure_default_workspace_for_tenant
after insert on public.tenants
for each row execute function app.ensure_default_workspace_for_tenant();
```

- [ ] **Step 4: Correr test y verificar que PASA**

```bash
npm run test:db -- --file documents_workspace_backfill_test.sql
```

Expected: `ok 1 .. ok 10`.

- [ ] **Step 5: Correr suite completo**

```bash
npm run test:db
```

Expected: todos verdes.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260522212500_documents_workspace_backfill.sql \
        supabase/tests/documents_workspace_backfill_test.sql
git commit -m "feat(db): backfill Default workspace and assign documents (tier1 031.b)"
```

---

## Paso 7 · documents.workspace_id NOT NULL (Migracion 031.c)

### Task 7.1: Test pgTAP — la columna es NOT NULL y la FK esta VALID

**Files:**
- Create: `supabase/tests/documents_workspace_id_not_null_test.sql`

- [ ] **Step 1: Escribir test**

```sql
BEGIN;
SELECT plan(5);

SELECT col_not_null(
  'public', 'documents', 'workspace_id',
  'documents.workspace_id is now NOT NULL'
);

-- FK validada (no `not valid`)
SELECT is(
  (select convalidated from pg_constraint
   where conname = 'documents_workspace_fk'),
  true,
  'documents_workspace_fk is validated'
);

-- Indice de hot path en (tenant_id, workspace_id, status, created_at desc)
SELECT has_index(
  'public', 'documents', 'documents_workspace_status_idx',
  'documents has composite hot-path index'
);

-- Indice de soft-delete
SELECT has_index(
  'public', 'documents', 'documents_deleted_at_idx',
  'documents has deleted_at partial index'
);

-- Insertar un documento sin workspace_id falla
insert into public.tenants (id, slug, name)
values ('00000000-0000-0000-0000-000000003501', 'nn-tenant', 'NN Tenant');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000003511',
  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'nn@nn.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.users (id, tenant_id, email, role, status)
values ('00000000-0000-0000-0000-000000003511',
  '00000000-0000-0000-0000-000000003501', 'nn@nn.test', 'member', 'active');

SELECT throws_ok(
  $$ insert into public.documents (id, tenant_id, created_by, filename, r2_key, status)
       values ('00000000-0000-0000-0000-000000003521',
               '00000000-0000-0000-0000-000000003501',
               '00000000-0000-0000-0000-000000003511',
               'nn.pdf',
               '00000000-0000-0000-0000-000000003501/00000000-0000-0000-0000-000000003521/nn.pdf',
               'uploaded') $$,
  '23502',
  NULL,
  'documents rejects NULL workspace_id after 031.c'
);

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Correr y verificar que FAILA**

```bash
npm run test:db -- --file documents_workspace_id_not_null_test.sql
```

Expected: `col_not_null` falla porque la columna sigue siendo nullable.

- [ ] **Step 3: Escribir migracion `20260522213000_documents_workspace_id_not_null.sql`**

```sql
-- 031.c — set not null + validar FK + indices definitivos.
-- Pre-requisito: 031.b corrio y todos los documents tienen workspace_id.

-- Validar primero, falla con error claro si quedan NULL
do $$
declare missing integer;
begin
  select count(*) into missing
  from public.documents
  where workspace_id is null;

  if missing > 0 then
    raise exception 'tier1 031.c: % documents quedan sin workspace_id; correr tier1_backfill_default_workspaces() antes de aplicar esta migracion', missing;
  end if;
end;
$$;

alter table public.documents
  alter column workspace_id set not null;

-- Validar la FK que se declaro `not valid` en 031.a
alter table public.documents
  validate constraint documents_workspace_fk;

-- Indice hot-path definitivo
create index if not exists documents_workspace_status_idx
  on public.documents (tenant_id, workspace_id, status, created_at desc)
  where deleted_at is null;

-- Indice para queries de papelera/recovery
create index if not exists documents_deleted_at_idx
  on public.documents (tenant_id, deleted_at)
  where deleted_at is not null;

-- Limpieza de indices intermedios (los que sirvieron al backfill)
drop index if exists public.documents_tenant_workspace_partial_idx;
drop index if exists public.documents_workspace_id_null_idx;
```

- [ ] **Step 4: Correr test y verificar que PASA**

```bash
npm run test:db -- --file documents_workspace_id_not_null_test.sql
```

Expected: `ok 1 .. ok 5`.

- [ ] **Step 5: Correr suite completo**

```bash
npm run test:db
```

Expected: verde.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260522213000_documents_workspace_id_not_null.sql \
        supabase/tests/documents_workspace_id_not_null_test.sql
git commit -m "feat(db): enforce documents.workspace_id NOT NULL (tier1 031.c)"
```

---

## Paso 8 · Collections, tags y document_tags (Migracion 032)

### Task 8.1: Test pgTAP para `collections`, `document_collections`, `tags`, `document_tags`

**Files:**
- Create: `supabase/tests/collections_tags_tables_test.sql`

- [ ] **Step 1: Escribir test**

```sql
BEGIN;
SELECT plan(16);

SELECT has_type('public', 'collection_visibility', 'collection_visibility enum exists');

SELECT has_table('public', 'collections', 'collections table exists');
SELECT has_table('public', 'document_collections', 'document_collections table exists');
SELECT has_table('public', 'tags', 'tags table exists');
SELECT has_table('public', 'document_tags', 'document_tags table exists');

SELECT col_is_unique(
  'public', 'collections', ARRAY['tenant_id','id'],
  'collections has composite unique (tenant_id, id)'
);
SELECT col_is_unique(
  'public', 'collections', ARRAY['workspace_id','slug'],
  'collections enforces unique slug per workspace'
);

SELECT col_is_fk(
  'public', 'collections', ARRAY['tenant_id','workspace_id'],
  'collections has composite FK to workspaces'
);

SELECT col_is_fk(
  'public', 'document_collections', ARRAY['tenant_id','document_id'],
  'document_collections has composite FK to documents'
);
SELECT col_is_fk(
  'public', 'document_collections', ARRAY['tenant_id','collection_id'],
  'document_collections has composite FK to collections'
);

SELECT col_is_pk(
  'public', 'document_collections', ARRAY['document_id','collection_id'],
  'document_collections PK is (document_id, collection_id)'
);

SELECT col_is_unique(
  'public', 'tags', ARRAY['tenant_id','key'],
  'tags enforces unique key per tenant'
);

SELECT col_is_pk(
  'public', 'document_tags', ARRAY['document_id','tag_id'],
  'document_tags PK is (document_id, tag_id)'
);

-- collection_visibility valores
SELECT is(
  ARRAY(SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'collection_visibility' ORDER BY e.enumsortorder),
  ARRAY['workspace_private','tenant_public'],
  'collection_visibility has workspace_private and tenant_public'
);

-- RLS enabled
SELECT is(
  (select relrowsecurity from pg_class where oid = 'public.collections'::regclass),
  true,
  'collections has RLS enabled'
);
SELECT is(
  (select relrowsecurity from pg_class where oid = 'public.tags'::regclass),
  true,
  'tags has RLS enabled'
);

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Correr y verificar que FAILA**

```bash
npm run test:db -- --file collections_tags_tables_test.sql
```

Expected: `relation "public.collections" does not exist`.

- [ ] **Step 3: Escribir migracion `20260522213500_collections_tags_tables.sql`**

```sql
-- 032 — collections, document_collections, tags, document_tags.
-- Policies finales usando helpers app.* llegan en 033/035.

create type public.collection_visibility as enum (
  'workspace_private',
  'tenant_public'
);

create table public.collections (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  workspace_id uuid not null,
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9_-]*$'),
  name text not null,
  description text,
  visibility public.collection_visibility not null default 'workspace_private',
  icon text,
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

create index collections_workspace_idx
  on public.collections (tenant_id, workspace_id);
create index collections_visibility_idx
  on public.collections (tenant_id, visibility)
  where visibility = 'tenant_public' and deleted_at is null;
create index collections_tenant_alive_idx
  on public.collections (tenant_id) where deleted_at is null;

create trigger set_collections_updated_at
before update on public.collections
for each row execute function app.set_updated_at();

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
create index document_collections_tenant_doc_idx
  on public.document_collections (tenant_id, document_id);

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
  unique (tenant_id, id),
  unique (tenant_id, key)
);

create index tags_tenant_idx on public.tags (tenant_id);

create trigger set_tags_updated_at
before update on public.tags
for each row execute function app.set_updated_at();

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

create index document_tags_tag_idx
  on public.document_tags (tenant_id, tag_id);
create index document_tags_tenant_doc_idx
  on public.document_tags (tenant_id, document_id);

-- RLS baseline. Policies "visibility effectiva" usando helpers app.* en 033/035.
alter table public.collections enable row level security;
alter table public.document_collections enable row level security;
alter table public.tags enable row level security;
alter table public.document_tags enable row level security;

create policy collections_select_tenant on public.collections
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and deleted_at is null
  );

create policy document_collections_select_tenant on public.document_collections
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
  );

create policy tags_select_tenant on public.tags
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
  );

create policy document_tags_select_tenant on public.document_tags
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
  );

-- Write boundary
revoke insert, update, delete on public.collections from authenticated;
revoke insert, update, delete on public.document_collections from authenticated;
revoke insert, update, delete on public.tags from authenticated;
revoke insert, update, delete on public.document_tags from authenticated;
```

- [ ] **Step 4: Correr test y verificar que PASA**

```bash
npm run test:db -- --file collections_tags_tables_test.sql
```

Expected: `ok 1 .. ok 16`.

- [ ] **Step 5: Correr suite completo**

```bash
npm run test:db
```

Expected: verde.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260522213500_collections_tags_tables.sql \
        supabase/tests/collections_tags_tables_test.sql
git commit -m "feat(db): add collections, tags and document join tables (tier1 032)"
```

---

## Paso 9 · RLS helpers app.* y audit_with_context (Migracion 033)

### Task 9.1: Test pgTAP para los 6 helpers

**Files:**
- Create: `supabase/tests/rls_helpers_app_test.sql`

- [ ] **Step 1: Escribir test que cubre cada helper con casos positivos y negativos**

```sql
BEGIN;
SELECT plan(18);

-- Helpers existen
SELECT has_function('app', 'current_workspace_id', ARRAY[]::text[],
  'app.current_workspace_id() exists');
SELECT has_function('app', 'user_belongs_to_workspace', ARRAY['uuid'],
  'app.user_belongs_to_workspace(uuid) exists');
SELECT has_function('app', 'user_workspace_role', ARRAY['uuid'],
  'app.user_workspace_role(uuid) exists');
SELECT has_function('app', 'user_can_read_document', ARRAY['uuid'],
  'app.user_can_read_document(uuid) exists');
SELECT has_function('app', 'user_can_edit_document', ARRAY['uuid'],
  'app.user_can_edit_document(uuid) exists');
SELECT has_function('app', 'audit_with_context', ARRAY['text','text','uuid','jsonb','jsonb'],
  'app.audit_with_context(text,text,uuid,jsonb,jsonb) exists');

-- Setup: tenant + 2 users (uno admin, uno member), 1 workspace, 1 group, 1 doc
insert into public.tenants (id, slug, name)
values ('00000000-0000-0000-0000-000000003601', 'helpers-tenant', 'Helpers Tenant');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000003611',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'admin@h.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000003612',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'editor@h.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000003613',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'outsider@h.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.users (id, tenant_id, email, role, status) values
  ('00000000-0000-0000-0000-000000003611',
   '00000000-0000-0000-0000-000000003601', 'admin@h.test', 'admin', 'active'),
  ('00000000-0000-0000-0000-000000003612',
   '00000000-0000-0000-0000-000000003601', 'editor@h.test', 'member', 'active'),
  ('00000000-0000-0000-0000-000000003613',
   '00000000-0000-0000-0000-000000003601', 'outsider@h.test', 'member', 'active');

insert into public.workspaces (id, tenant_id, slug, name)
values ('00000000-0000-0000-0000-000000003621',
  '00000000-0000-0000-0000-000000003601', 'engineering', 'Engineering');

insert into public.groups (id, tenant_id, key, name)
values ('00000000-0000-0000-0000-000000003631',
  '00000000-0000-0000-0000-000000003601', 'eng-team', 'Engineering Team');

insert into public.group_memberships (group_id, user_id, tenant_id)
values ('00000000-0000-0000-0000-000000003631',
  '00000000-0000-0000-0000-000000003612',
  '00000000-0000-0000-0000-000000003601');

-- editor entra al workspace via grupo con rol editor
insert into public.workspace_memberships
  (workspace_id, tenant_id, principal_kind, principal_id, role)
values
  ('00000000-0000-0000-0000-000000003621',
   '00000000-0000-0000-0000-000000003601',
   'group', '00000000-0000-0000-0000-000000003631',
   'workspace_editor');

-- ademas, miembro directo como viewer (deberia resolver a editor por la regla "rol mas alto")
insert into public.workspace_memberships
  (workspace_id, tenant_id, principal_kind, principal_id, role)
values
  ('00000000-0000-0000-0000-000000003621',
   '00000000-0000-0000-0000-000000003601',
   'user', '00000000-0000-0000-0000-000000003612',
   'workspace_viewer');

insert into public.documents
  (id, tenant_id, workspace_id, created_by, filename, r2_key, status, uploaded_at)
values
  ('00000000-0000-0000-0000-000000003641',
   '00000000-0000-0000-0000-000000003601',
   '00000000-0000-0000-0000-000000003621',
   '00000000-0000-0000-0000-000000003612',
   'eng.pdf',
   '00000000-0000-0000-0000-000000003601/00000000-0000-0000-0000-000000003641/eng.pdf',
   'uploaded', now());

-- JWT como editor
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '00000000-0000-0000-0000-000000003612',
    'role', 'authenticated',
    'tenant_id', '00000000-0000-0000-0000-000000003601',
    'tenant_role', 'member',
    'active_workspace_id', '00000000-0000-0000-0000-000000003621'
  )::text, true
);
set local role authenticated;

SELECT is(
  app.current_workspace_id(),
  '00000000-0000-0000-0000-000000003621'::uuid,
  'current_workspace_id reads JWT claim'
);

SELECT ok(
  app.user_belongs_to_workspace('00000000-0000-0000-0000-000000003621'::uuid),
  'editor belongs to workspace (via group)'
);

SELECT is(
  app.user_workspace_role('00000000-0000-0000-0000-000000003621'::uuid)::text,
  'workspace_editor',
  'editor effective role is workspace_editor (max of direct viewer and group editor)'
);

SELECT ok(
  app.user_can_read_document('00000000-0000-0000-0000-000000003641'::uuid),
  'editor can read document in their workspace'
);

SELECT ok(
  app.user_can_edit_document('00000000-0000-0000-0000-000000003641'::uuid),
  'editor can edit document in their workspace'
);

reset role;
select set_config('request.jwt.claims', null, true);

-- JWT como outsider (mismo tenant, no miembro)
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '00000000-0000-0000-0000-000000003613',
    'role', 'authenticated',
    'tenant_id', '00000000-0000-0000-0000-000000003601',
    'tenant_role', 'member'
  )::text, true
);
set local role authenticated;

SELECT ok(
  not app.user_belongs_to_workspace('00000000-0000-0000-0000-000000003621'::uuid),
  'outsider does not belong to workspace'
);

SELECT ok(
  not app.user_can_read_document('00000000-0000-0000-0000-000000003641'::uuid),
  'outsider cannot read document in workspace they do not belong to'
);

SELECT ok(
  not app.user_can_edit_document('00000000-0000-0000-0000-000000003641'::uuid),
  'outsider cannot edit document'
);

reset role;
select set_config('request.jwt.claims', null, true);

-- JWT como admin
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '00000000-0000-0000-0000-000000003611',
    'role', 'authenticated',
    'tenant_id', '00000000-0000-0000-0000-000000003601',
    'tenant_role', 'admin'
  )::text, true
);
set local role authenticated;

SELECT ok(
  app.user_can_read_document('00000000-0000-0000-0000-000000003641'::uuid),
  'tenant admin bypasses workspace membership (read)'
);
SELECT ok(
  app.user_can_edit_document('00000000-0000-0000-0000-000000003641'::uuid),
  'tenant admin bypasses workspace membership (edit)'
);

-- tenant_public collection visibility: outsider deberia poder leer
insert into public.collections
  (id, tenant_id, workspace_id, slug, name, visibility)
values
  ('00000000-0000-0000-0000-000000003651',
   '00000000-0000-0000-0000-000000003601',
   '00000000-0000-0000-0000-000000003621',
   'shared', 'Shared', 'tenant_public');

insert into public.document_collections (tenant_id, document_id, collection_id)
values ('00000000-0000-0000-0000-000000003601',
  '00000000-0000-0000-0000-000000003641',
  '00000000-0000-0000-0000-000000003651');

reset role;
select set_config('request.jwt.claims', null, true);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '00000000-0000-0000-0000-000000003613',
    'role', 'authenticated',
    'tenant_id', '00000000-0000-0000-0000-000000003601',
    'tenant_role', 'member'
  )::text, true
);
set local role authenticated;

SELECT ok(
  app.user_can_read_document('00000000-0000-0000-0000-000000003641'::uuid),
  'outsider can read document via tenant_public collection'
);
SELECT ok(
  not app.user_can_edit_document('00000000-0000-0000-0000-000000003641'::uuid),
  'tenant_public read does NOT grant edit to outsider'
);

reset role;

-- audit_with_context inserta con request_context expandido
SELECT lives_ok(
  $$ select app.audit_with_context(
       'document.test',
       'document',
       '00000000-0000-0000-0000-000000003641'::uuid,
       jsonb_build_object('extra', 'payload'),
       jsonb_build_object(
         'request_id', 'req-123',
         'session_id', '00000000-0000-0000-0000-0000000099aa',
         'ip', '10.0.0.1',
         'user_agent', 'test-agent',
         'workspace_id', '00000000-0000-0000-0000-000000003621'
       )
     ) $$,
  'audit_with_context inserts a row'
);

SELECT is(
  (select metadata ->> 'request_id' from public.audit_log
     where action = 'document.test'
     order by created_at desc limit 1),
  'req-123',
  'audit_with_context persists request_id in metadata'
);

SELECT is(
  (select request_id from public.audit_log
     where action = 'document.test'
     order by created_at desc limit 1),
  'req-123',
  'audit_with_context populates audit_log.request_id column'
);

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Correr y verificar que FAILA**

```bash
npm run test:db -- --file rls_helpers_app_test.sql
```

Expected: `function app.current_workspace_id() does not exist`.

- [ ] **Step 3: Escribir migracion `20260522214000_rls_helpers_app.sql`**

```sql
-- 033 — helpers RLS en esquema app y audit_with_context.

create or replace function app.current_workspace_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(
    coalesce(
      auth.jwt() ->> 'active_workspace_id',
      auth.jwt() #>> '{app_metadata,active_workspace_id}',
      auth.jwt() #>> '{user_metadata,active_workspace_id}'
    ),
    ''
  )::uuid;
$$;

create or replace function app.user_belongs_to_workspace(_workspace_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
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

-- Rol efectivo: el mayor entre membresia directa y via grupos.
-- Postgres no tiene max(enum). Aprovechamos que el enum workspace_role se
-- declaro low-to-high (viewer < editor < admin) y usamos order by role desc.
create or replace function app.user_workspace_role(_workspace_id uuid)
returns public.workspace_role
language sql
stable
set search_path = ''
as $$
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
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.documents d
    where d.id = _document_id
      and d.tenant_id = (select app.current_tenant_id())
      and d.deleted_at is null
      and (
        (select app.is_tenant_admin())
        or (select app.user_belongs_to_workspace(d.workspace_id))
        or exists (
          select 1
          from public.document_collections dc
          join public.collections c
            on c.id = dc.collection_id and c.tenant_id = d.tenant_id
          where dc.document_id = d.id
            and c.visibility = 'tenant_public'
            and c.deleted_at is null
        )
      )
  );
$$;

create or replace function app.user_can_edit_document(_document_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
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

-- audit_with_context: single source of insert al audit_log desde RPCs.
-- Acepta _request_context jsonb opcional. Expandido en columnas dedicadas
-- (request_id, session_id, workspace_id, ip_address, user_agent) y persistido
-- ademas en metadata para no perder informacion.
create or replace function app.audit_with_context(
  _action text,
  _resource_type text,
  _resource_id uuid,
  _payload jsonb default '{}'::jsonb,
  _request_context jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted_id uuid;
  ctx jsonb;
  merged_payload jsonb;
begin
  ctx := coalesce(_request_context, '{}'::jsonb);

  merged_payload := coalesce(_payload, '{}'::jsonb)
    || jsonb_build_object('request_context', ctx);

  insert into public.audit_log (
    tenant_id,
    actor_id,
    action,
    resource_type,
    resource_id,
    request_id,
    ip_address,
    user_agent,
    metadata
  )
  values (
    (select app.current_tenant_id()),
    auth.uid(),
    _action,
    _resource_type,
    _resource_id,
    nullif(ctx ->> 'request_id', ''),
    nullif(ctx ->> 'ip', '')::inet,
    nullif(ctx ->> 'user_agent', ''),
    merged_payload
  )
  returning id into inserted_id;

  return inserted_id;
exception
  when invalid_text_representation then
    -- ip invalida no rompe la RPC; persistimos sin la columna y dejamos rastro
    insert into public.audit_log (
      tenant_id, actor_id, action, resource_type, resource_id,
      request_id, user_agent, metadata
    )
    values (
      (select app.current_tenant_id()),
      auth.uid(),
      _action,
      _resource_type,
      _resource_id,
      nullif(ctx ->> 'request_id', ''),
      nullif(ctx ->> 'user_agent', ''),
      merged_payload || jsonb_build_object('ip_parse_error', true)
    )
    returning id into inserted_id;
    return inserted_id;
end;
$$;

grant execute on function app.current_workspace_id()              to authenticated, service_role;
grant execute on function app.user_belongs_to_workspace(uuid)     to authenticated, service_role;
grant execute on function app.user_workspace_role(uuid)           to authenticated, service_role;
grant execute on function app.user_can_read_document(uuid)        to authenticated, service_role;
grant execute on function app.user_can_edit_document(uuid)        to authenticated, service_role;
grant execute on function app.audit_with_context(text,text,uuid,jsonb,jsonb) to service_role;
-- audit_with_context se invoca desde RPCs security definer; no exponer a authenticated.

-- Reemplazar policies baseline de workspaces/memberships/groups con
-- versiones que aprovechan los helpers. Se usa `with replace` simulado via
-- drop + create. RLS sigue habilitada todo el tiempo (no se hace `disable`).
drop policy if exists workspaces_select_tenant on public.workspaces;
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

drop policy if exists workspace_memberships_select_tenant on public.workspace_memberships;
create policy workspace_memberships_select_member on public.workspace_memberships
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and (
      (select app.is_tenant_admin())
      or (select app.user_belongs_to_workspace(workspace_id))
    )
  );

-- groups y group_memberships: groups quedan en directorio (todos los users
-- del tenant ven el nombre). group_memberships solo visible para admins o
-- miembros del propio grupo.
drop policy if exists group_memberships_select_tenant on public.group_memberships;
create policy group_memberships_select_own_or_admin on public.group_memberships
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and (
      (select app.is_tenant_admin())
      or user_id = (select auth.uid())
      or exists (
        select 1 from public.group_memberships gm2
        where gm2.group_id = group_memberships.group_id
          and gm2.user_id = (select auth.uid())
      )
    )
  );

-- collections + document_collections: visibility efectiva
drop policy if exists collections_select_tenant on public.collections;
create policy collections_select_visible on public.collections
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and deleted_at is null
    and (
      (select app.is_tenant_admin())
      or visibility = 'tenant_public'
      or (select app.user_belongs_to_workspace(workspace_id))
    )
  );

drop policy if exists document_collections_select_tenant on public.document_collections;
create policy document_collections_select_visible on public.document_collections
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and (
      (select app.is_tenant_admin())
      or exists (
        select 1 from public.collections c
        where c.id = document_collections.collection_id
          and c.tenant_id = document_collections.tenant_id
          and c.deleted_at is null
          and (
            c.visibility = 'tenant_public'
            or (select app.user_belongs_to_workspace(c.workspace_id))
          )
      )
    )
  );
```

- [ ] **Step 4: Correr test y verificar que PASA**

```bash
npm run test:db -- --file rls_helpers_app_test.sql
```

Expected: `ok 1 .. ok 18`.

- [ ] **Step 5: Correr suite completo**

```bash
npm run test:db
```

Expected: verde.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260522214000_rls_helpers_app.sql \
        supabase/tests/rls_helpers_app_test.sql
git commit -m "feat(db): add RLS helpers app.user_can_*_document and audit_with_context (tier1 033)"
```

---

## Paso 10 · JWT hook v2 con active_workspace (Migracion 034)

### Task 10.1: Test pgTAP del hook v2

**Files:**
- Create: `supabase/tests/auth_jwt_claims_v2_test.sql`

- [ ] **Step 1: Escribir test que cubre: claim presente cuando user es miembro, ausente cuando no, claims_version=2**

```sql
BEGIN;
SELECT plan(8);

insert into public.tenants (id, slug, name)
values ('00000000-0000-0000-0000-000000003701', 'jwt-tenant', 'JWT Tenant');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000003711',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'with-ws@jwt.test', now(), '{}'::jsonb,
   jsonb_build_object(
     'active_workspace_id', '00000000-0000-0000-0000-000000003721'
   ),
   now(), now()),
  ('00000000-0000-0000-0000-000000003712',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'no-ws@jwt.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000003713',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'phantom-ws@jwt.test', now(), '{}'::jsonb,
   jsonb_build_object(
     'active_workspace_id', '00000000-0000-0000-0000-0000000099cc'
   ),
   now(), now());

insert into public.users (id, tenant_id, email, role, status) values
  ('00000000-0000-0000-0000-000000003711',
   '00000000-0000-0000-0000-000000003701', 'with-ws@jwt.test', 'member', 'active'),
  ('00000000-0000-0000-0000-000000003712',
   '00000000-0000-0000-0000-000000003701', 'no-ws@jwt.test', 'member', 'active'),
  ('00000000-0000-0000-0000-000000003713',
   '00000000-0000-0000-0000-000000003701', 'phantom-ws@jwt.test', 'member', 'active');

insert into public.workspaces (id, tenant_id, slug, name)
values ('00000000-0000-0000-0000-000000003721',
  '00000000-0000-0000-0000-000000003701', 'finance', 'Finance');

insert into public.workspace_memberships
  (workspace_id, tenant_id, principal_kind, principal_id, role)
values
  ('00000000-0000-0000-0000-000000003721',
   '00000000-0000-0000-0000-000000003701',
   'user', '00000000-0000-0000-0000-000000003711',
   'workspace_admin');

-- Caso 1: user con metadata.active_workspace_id valido -> claim inyectado
SELECT is(
  app.custom_access_token_hook(jsonb_build_object(
    'user_id', '00000000-0000-0000-0000-000000003711',
    'claims', jsonb_build_object(
      'sub', '00000000-0000-0000-0000-000000003711',
      'role', 'authenticated',
      'app_metadata', '{}'::jsonb,
      'user_metadata', jsonb_build_object(
        'active_workspace_id', '00000000-0000-0000-0000-000000003721'
      )
    )
  )) #>> '{claims,active_workspace_id}',
  '00000000-0000-0000-0000-000000003721',
  'Hook injects active_workspace_id for valid membership'
);

SELECT is(
  app.custom_access_token_hook(jsonb_build_object(
    'user_id', '00000000-0000-0000-0000-000000003711',
    'claims', jsonb_build_object(
      'sub', '00000000-0000-0000-0000-000000003711',
      'role', 'authenticated',
      'app_metadata', '{}'::jsonb,
      'user_metadata', jsonb_build_object(
        'active_workspace_id', '00000000-0000-0000-0000-000000003721'
      )
    )
  )) #>> '{claims,active_workspace_role}',
  'workspace_admin',
  'Hook injects active_workspace_role'
);

SELECT is(
  (app.custom_access_token_hook(jsonb_build_object(
    'user_id', '00000000-0000-0000-0000-000000003711',
    'claims', jsonb_build_object(
      'sub', '00000000-0000-0000-0000-000000003711',
      'role', 'authenticated',
      'app_metadata', '{}'::jsonb
    )
  )) #> '{claims,claims_version}')::text,
  '2',
  'claims_version bumped to 2'
);

-- Caso 2: user sin active_workspace en metadata -> no inyecta claim
SELECT ok(
  (app.custom_access_token_hook(jsonb_build_object(
    'user_id', '00000000-0000-0000-0000-000000003712',
    'claims', jsonb_build_object(
      'sub', '00000000-0000-0000-0000-000000003712',
      'role', 'authenticated',
      'app_metadata', '{}'::jsonb
    )
  )) #> '{claims,active_workspace_id}') is null,
  'Hook omits active_workspace_id when user_metadata has none'
);

-- Caso 3: user con metadata pero apuntando a workspace inexistente o sin membership
SELECT ok(
  (app.custom_access_token_hook(jsonb_build_object(
    'user_id', '00000000-0000-0000-0000-000000003713',
    'claims', jsonb_build_object(
      'sub', '00000000-0000-0000-0000-000000003713',
      'role', 'authenticated',
      'app_metadata', '{}'::jsonb,
      'user_metadata', jsonb_build_object(
        'active_workspace_id', '00000000-0000-0000-0000-0000000099cc'
      )
    )
  )) #> '{claims,active_workspace_id}') is null,
  'Hook omits active_workspace_id when membership is missing'
);

-- Caso 4: app_metadata mirror
SELECT is(
  app.custom_access_token_hook(jsonb_build_object(
    'user_id', '00000000-0000-0000-0000-000000003711',
    'claims', jsonb_build_object(
      'sub', '00000000-0000-0000-0000-000000003711',
      'role', 'authenticated',
      'app_metadata', '{}'::jsonb,
      'user_metadata', jsonb_build_object(
        'active_workspace_id', '00000000-0000-0000-0000-000000003721'
      )
    )
  )) #>> '{claims,app_metadata,active_workspace_id}',
  '00000000-0000-0000-0000-000000003721',
  'Hook mirrors active_workspace_id in app_metadata'
);

-- Caso 5: tenant claims siguen presentes
SELECT is(
  app.custom_access_token_hook(jsonb_build_object(
    'user_id', '00000000-0000-0000-0000-000000003711',
    'claims', jsonb_build_object(
      'sub', '00000000-0000-0000-0000-000000003711',
      'role', 'authenticated',
      'app_metadata', '{}'::jsonb
    )
  )) #>> '{claims,tenant_id}',
  '00000000-0000-0000-0000-000000003701',
  'tenant_id claim still present in v2'
);

-- Caso 6: legacy event sin user_metadata sigue funcionando (no rompe)
SELECT is(
  (app.custom_access_token_hook(jsonb_build_object(
    'user_id', '00000000-0000-0000-0000-000000003712',
    'claims', jsonb_build_object(
      'sub', '00000000-0000-0000-0000-000000003712',
      'role', 'authenticated',
      'app_metadata', '{}'::jsonb
    )
  )) #> '{claims,claims_version}')::text,
  '2',
  'v2 hook always sets claims_version=2 even when no active_workspace'
);

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Correr y verificar que FAILA**

```bash
npm run test:db -- --file auth_jwt_claims_v2_test.sql
```

Expected: el caso 1 falla porque el hook actual (v1) no inyecta `active_workspace_id`.

- [ ] **Step 3: Escribir migracion `20260522214500_auth_jwt_claims_v2.sql`**

```sql
-- 034 — JWT hook v2.
-- Extiende app.custom_access_token_hook para:
-- 1. Leer user_metadata.active_workspace_id (lo setea el cliente via
--    supabase.auth.updateUser({ data: { active_workspace_id } })).
-- 2. Validar que el user es miembro del workspace (directo o via group).
-- 3. Inyectar active_workspace_id + active_workspace_role como HINTS para UI.
-- 4. Bumpear claims_version a 2.
-- Invariante: el claim es solo hint UI. RLS siempre re-verifica via helpers.

create or replace function app.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  claims jsonb;
  app_metadata jsonb;
  user_metadata jsonb;
  tenant_profile record;
  event_user_id uuid;
  requested_workspace uuid;
  resolved_workspace uuid;
  resolved_role public.workspace_role;
begin
  event_user_id := nullif(event ->> 'user_id', '')::uuid;
  claims := coalesce(event -> 'claims', '{}'::jsonb);
  app_metadata := coalesce(claims -> 'app_metadata', '{}'::jsonb);
  user_metadata := coalesce(claims -> 'user_metadata', '{}'::jsonb);

  select
    u.tenant_id,
    u.role::text as tenant_role,
    u.status as user_status,
    t.slug as tenant_slug,
    t.status::text as tenant_status
  into tenant_profile
  from public.users u
  join public.tenants t on t.id = u.tenant_id
  where u.id = event_user_id
  limit 1;

  if tenant_profile.tenant_id is null
    or tenant_profile.user_status <> 'active'
    or tenant_profile.tenant_status <> 'active'
  then
    claims := claims
      - 'tenant_id' - 'tenant_role' - 'tenant_slug' - 'tenant_status'
      - 'user_status' - 'claims_version'
      - 'active_workspace_id' - 'active_workspace_role';
    app_metadata := app_metadata
      - 'tenant_id' - 'tenant_role' - 'tenant_slug' - 'tenant_status'
      - 'user_status' - 'claims_version'
      - 'active_workspace_id' - 'active_workspace_role';
    claims := jsonb_set(claims, '{app_metadata}', app_metadata, true);
    return jsonb_set(event, '{claims}', claims, true);
  end if;

  claims := jsonb_set(claims, '{tenant_id}',     to_jsonb(tenant_profile.tenant_id::text), true);
  claims := jsonb_set(claims, '{tenant_role}',   to_jsonb(tenant_profile.tenant_role), true);
  claims := jsonb_set(claims, '{tenant_slug}',   to_jsonb(tenant_profile.tenant_slug), true);
  claims := jsonb_set(claims, '{tenant_status}', to_jsonb(tenant_profile.tenant_status), true);
  claims := jsonb_set(claims, '{user_status}',   to_jsonb(tenant_profile.user_status), true);
  claims := jsonb_set(claims, '{claims_version}', '2'::jsonb, true);

  app_metadata := jsonb_set(app_metadata, '{tenant_id}',     to_jsonb(tenant_profile.tenant_id::text), true);
  app_metadata := jsonb_set(app_metadata, '{tenant_role}',   to_jsonb(tenant_profile.tenant_role), true);
  app_metadata := jsonb_set(app_metadata, '{tenant_slug}',   to_jsonb(tenant_profile.tenant_slug), true);
  app_metadata := jsonb_set(app_metadata, '{tenant_status}', to_jsonb(tenant_profile.tenant_status), true);
  app_metadata := jsonb_set(app_metadata, '{user_status}',   to_jsonb(tenant_profile.user_status), true);
  app_metadata := jsonb_set(app_metadata, '{claims_version}', '2'::jsonb, true);

  -- Validar active_workspace_id solicitado por el cliente
  requested_workspace := nullif(user_metadata ->> 'active_workspace_id', '')::uuid;

  if requested_workspace is not null then
    -- Resolver via JOIN directo a memberships (sin pasar por helpers que dependen
    -- de auth.uid()/auth.jwt() — el hook corre como supabase_auth_admin).
    select wm.workspace_id,
           (
             select wm2.role
             from (
               select wm3.role
               from public.workspace_memberships wm3
               where wm3.tenant_id = tenant_profile.tenant_id
                 and wm3.workspace_id = wm.workspace_id
                 and wm3.principal_kind = 'user'
                 and wm3.principal_id = event_user_id
               union all
               select wm3.role
               from public.workspace_memberships wm3
               join public.group_memberships gm
                 on gm.group_id = wm3.principal_id
                and gm.user_id = event_user_id
               where wm3.tenant_id = tenant_profile.tenant_id
                 and wm3.workspace_id = wm.workspace_id
                 and wm3.principal_kind = 'group'
             ) wm2
             order by wm2.role desc
             limit 1
           )
    into resolved_workspace, resolved_role
    from public.workspaces wm
    where wm.id = requested_workspace
      and wm.tenant_id = tenant_profile.tenant_id
      and wm.deleted_at is null
      and exists (
        select 1
        from public.workspace_memberships wm4
        where wm4.tenant_id = tenant_profile.tenant_id
          and wm4.workspace_id = requested_workspace
          and (
            (wm4.principal_kind = 'user' and wm4.principal_id = event_user_id)
            or (
              wm4.principal_kind = 'group'
              and exists (
                select 1 from public.group_memberships gm5
                where gm5.group_id = wm4.principal_id
                  and gm5.user_id = event_user_id
              )
            )
          )
      )
    limit 1;
  end if;

  if resolved_workspace is not null then
    claims := jsonb_set(claims, '{active_workspace_id}',
      to_jsonb(resolved_workspace::text), true);
    claims := jsonb_set(claims, '{active_workspace_role}',
      to_jsonb(resolved_role::text), true);
    app_metadata := jsonb_set(app_metadata, '{active_workspace_id}',
      to_jsonb(resolved_workspace::text), true);
    app_metadata := jsonb_set(app_metadata, '{active_workspace_role}',
      to_jsonb(resolved_role::text), true);
  else
    claims := claims - 'active_workspace_id' - 'active_workspace_role';
    app_metadata := app_metadata - 'active_workspace_id' - 'active_workspace_role';
  end if;

  claims := jsonb_set(claims, '{app_metadata}', app_metadata, true);
  return jsonb_set(event, '{claims}', claims, true);

exception
  when invalid_text_representation then
    return jsonb_build_object(
      'error',
      jsonb_build_object(
        'http_code', 400,
        'message', 'Invalid auth event user_id or active_workspace_id'
      )
    );
end;
$$;

-- Grants se preservan del hook v1 (supabase_auth_admin tiene EXECUTE). No
-- hace falta re-otorgar.

-- Acceso de lectura para que el hook pueda consultar las nuevas tablas
grant select (id, tenant_id, slug, deleted_at) on public.workspaces
  to supabase_auth_admin;
grant select (workspace_id, tenant_id, principal_kind, principal_id, role)
  on public.workspace_memberships to supabase_auth_admin;
grant select (group_id, user_id, tenant_id)
  on public.group_memberships to supabase_auth_admin;

create policy workspaces_select_auth_admin on public.workspaces
  for select to supabase_auth_admin using (true);
create policy workspace_memberships_select_auth_admin on public.workspace_memberships
  for select to supabase_auth_admin using (true);
create policy group_memberships_select_auth_admin on public.group_memberships
  for select to supabase_auth_admin using (true);
```

- [ ] **Step 4: Correr test y verificar que PASA**

```bash
npm run test:db -- --file auth_jwt_claims_v2_test.sql
```

Expected: `ok 1 .. ok 8`.

- [ ] **Step 5: Correr suite completo**

```bash
npm run test:db
```

Expected: el test `auth_claims_rls_test.sql` previo sigue verde — el cambio de version `1 -> 2` no es asercion explicita ahi (revisa que el assertion es contra `tenant_id`, no `claims_version`). Si llegara a romper algo, ajustar el assertion ahora.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260522214500_auth_jwt_claims_v2.sql \
        supabase/tests/auth_jwt_claims_v2_test.sql
git commit -m "feat(auth): extend JWT hook with active_workspace_id and claims_version=2 (tier1 034)"
```

## Paso 11 · Soft-delete columnas + cleanup extendido (Migracion 035)

### Task 11.1: Test pgTAP del soft-delete pattern

**Files:**
- Test: `supabase/tests/documents_soft_delete_test.sql`

- [ ] **Step 1: Escribir test**

```sql
begin;
select plan(8);

-- columnas nuevas
select has_column('public', 'documents', 'deleted_at',
  'documents.deleted_at existe');
select col_type_is('public', 'documents', 'deleted_at', 'timestamp with time zone',
  'documents.deleted_at es timestamptz');
select col_is_null('public', 'documents', 'deleted_at',
  'documents.deleted_at es nullable');
select has_column('public', 'documents', 'deleted_by',
  'documents.deleted_by existe');

-- indice partial
select has_index('public', 'documents', 'documents_deleted_at_idx',
  'indice partial sobre deleted_at existe');

-- RPCs nuevas declaradas (placeholder; se prueban en Paso 16)
select has_function('public', 'archive_document', array['uuid','jsonb'],
  'public.archive_document declarada');
select has_function('public', 'restore_document', array['uuid'],
  'public.restore_document declarada');

-- cleanup_operational_data acepta nuevo parametro
select has_function('public', 'cleanup_operational_data',
  array['interval','interval','interval','interval'],
  'cleanup_operational_data acepta _soft_delete_retention');

select * from finish();
rollback;
```

- [ ] **Step 2: Correr test, verificar FALLA**

```bash
npm run test:db -- --file documents_soft_delete_test.sql
```

Expected: 8 asserts fallan con `column does not exist` / `function does not exist`.

- [ ] **Step 3: Escribir migracion**

**Files:**
- Create: `supabase/migrations/20260522215000_documents_soft_delete.sql`

```sql
-- soft-delete pattern para documents (Tier 1 035)

alter table public.documents
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references auth.users(id) on delete set null;

create index if not exists documents_deleted_at_idx
  on public.documents (tenant_id, deleted_at)
  where deleted_at is not null;

-- placeholders para RPCs que se implementan en Paso 16 (signatures para que
-- el test de Paso 11.1 las encuentre).
create or replace function public.archive_document(
  _document_id uuid,
  _request_context jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'archive_document not implemented yet (Paso 16)';
end;
$$;

create or replace function public.restore_document(_document_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'restore_document not implemented yet (Paso 16)';
end;
$$;

revoke execute on function public.archive_document(uuid, jsonb) from anon, public;
revoke execute on function public.restore_document(uuid) from anon, public;
grant execute on function public.archive_document(uuid, jsonb) to authenticated;
grant execute on function public.restore_document(uuid) to authenticated;

-- extender cleanup_operational_data con retention de soft-deletes.
create or replace function public.cleanup_operational_data(
  _revoked_invites_retention interval default '90 days'::interval,
  _indexing_events_retention interval default '6 months'::interval,
  _audit_log_retention interval default '2 years'::interval,
  _soft_delete_retention interval default '30 days'::interval
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  revoked_invites_deleted integer := 0;
  indexing_events_deleted integer := 0;
  audit_log_deleted integer := 0;
  documents_hard_deleted integer := 0;
  workspaces_hard_deleted integer := 0;
  collections_hard_deleted integer := 0;
  groups_hard_deleted integer := 0;
  tags_hard_deleted integer := 0;
begin
  delete from public.tenant_invites
  where status = 'revoked'
    and updated_at < now() - _revoked_invites_retention;
  get diagnostics revoked_invites_deleted = row_count;

  delete from public.indexing_events
  where created_at < now() - _indexing_events_retention;
  get diagnostics indexing_events_deleted = row_count;

  delete from public.audit_log
  where created_at < now() - _audit_log_retention;
  get diagnostics audit_log_deleted = row_count;

  delete from public.documents
  where deleted_at is not null
    and deleted_at < now() - _soft_delete_retention;
  get diagnostics documents_hard_deleted = row_count;

  delete from public.workspaces
  where deleted_at is not null
    and deleted_at < now() - _soft_delete_retention;
  get diagnostics workspaces_hard_deleted = row_count;

  delete from public.collections
  where deleted_at is not null
    and deleted_at < now() - _soft_delete_retention;
  get diagnostics collections_hard_deleted = row_count;

  delete from public.groups
  where deleted_at is not null
    and deleted_at < now() - _soft_delete_retention;
  get diagnostics groups_hard_deleted = row_count;

  delete from public.tags
  where deleted_at is not null
    and deleted_at < now() - _soft_delete_retention;
  get diagnostics tags_hard_deleted = row_count;

  return jsonb_build_object(
    'audit_log_deleted', audit_log_deleted,
    'indexing_events_deleted', indexing_events_deleted,
    'revoked_invites_deleted', revoked_invites_deleted,
    'documents_hard_deleted', documents_hard_deleted,
    'workspaces_hard_deleted', workspaces_hard_deleted,
    'collections_hard_deleted', collections_hard_deleted,
    'groups_hard_deleted', groups_hard_deleted,
    'tags_hard_deleted', tags_hard_deleted
  );
end;
$$;

revoke all on function public.cleanup_operational_data(interval, interval, interval, interval)
  from anon, authenticated, public;
grant execute on function public.cleanup_operational_data(interval, interval, interval, interval)
  to service_role;
```

Nota: `tags` necesita `deleted_at` agregada en una migracion previa o aca. Las tablas que NO tienen `deleted_at` en sus DDL originales del Paso 1-8 (`tags`, `groups` ya lo tienen segun Pasos 2 y 8) deben agregarlo aca si falta. Verificar antes de aplicar.

```sql
alter table public.tags
  add column if not exists deleted_at timestamptz;
```

- [ ] **Step 4: Correr test, verificar PASA**

```bash
npm run test:db -- --file documents_soft_delete_test.sql
```

Expected: `ok 1 .. ok 8`.

- [ ] **Step 5: Correr suite completo**

```bash
npm run test:db
```

Expected: todos los tests previos verdes; ningun regression.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260522215000_documents_soft_delete.sql \
        supabase/tests/documents_soft_delete_test.sql
git commit -m "feat(documents): soft-delete columns + cleanup_operational_data extended (tier1 035)"
```

## Paso 12 · RLS policies revisadas para `documents` (Migracion 036)

### Task 12.1: Test pgTAP que valida visibilidad triple

**Files:**
- Test: `supabase/tests/documents_rls_visibility_test.sql`

- [ ] **Step 1: Escribir test que cubre los 3 caminos de acceso**

```sql
begin;
select plan(12);

-- setup: 2 tenants, cada uno con workspace, user con role, documento
insert into public.tenants (id, slug, name) values
  ('11111111-1111-1111-1111-111111111111'::uuid, 'rls-a', 'Tenant A'),
  ('22222222-2222-2222-2222-222222222222'::uuid, 'rls-b', 'Tenant B');

insert into auth.users (id, email) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'alice@rls-a.test'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid, 'bob@rls-b.test');

insert into public.users (id, tenant_id, email, role, status) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'alice@rls-a.test', 'member', 'active'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'bob@rls-b.test', 'member', 'active');

insert into public.workspaces (id, tenant_id, slug, name) values
  ('aaaa1111-0000-0000-0000-000000000000'::uuid, '11111111-1111-1111-1111-111111111111', 'ws-a', 'Workspace A'),
  ('bbbb2222-0000-0000-0000-000000000000'::uuid, '22222222-2222-2222-2222-222222222222', 'ws-b', 'Workspace B');

insert into public.workspace_memberships (workspace_id, tenant_id, principal_kind, principal_id, role) values
  ('aaaa1111-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'user', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'workspace_editor'),
  ('bbbb2222-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'user', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'workspace_editor');

insert into public.documents (id, tenant_id, workspace_id, created_by, filename, r2_key, status, uploaded_at) values
  ('d0000001-0000-0000-0000-000000000001'::uuid, '11111111-1111-1111-1111-111111111111', 'aaaa1111-0000-0000-0000-000000000000', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a.pdf', '11111111-1111-1111-1111-111111111111/d0000001-0000-0000-0000-000000000001/a.pdf', 'indexed', now()),
  ('d0000002-0000-0000-0000-000000000002'::uuid, '22222222-2222-2222-2222-222222222222', 'bbbb2222-0000-0000-0000-000000000000', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b.pdf', '22222222-2222-2222-2222-222222222222/d0000002-0000-0000-0000-000000000002/b.pdf', 'indexed', now());

-- caso 1: alice en su tenant ve su doc
set local role authenticated;
select set_config('request.jwt.claims', json_build_object(
  'sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'tenant_id', '11111111-1111-1111-1111-111111111111',
  'tenant_role', 'member',
  'active_workspace_id', 'aaaa1111-0000-0000-0000-000000000000'
)::text, true);

select is(
  (select count(*) from public.documents where id = 'd0000001-0000-0000-0000-000000000001'),
  1::bigint,
  'Alice ve su documento en su workspace home');

select is(
  (select count(*) from public.documents where id = 'd0000002-0000-0000-0000-000000000002'),
  0::bigint,
  'Alice NO ve documento de Tenant B (RLS por tenant_id bloquea)');

-- caso 2: bob en Tenant B
select set_config('request.jwt.claims', json_build_object(
  'sub', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'tenant_id', '22222222-2222-2222-2222-222222222222',
  'tenant_role', 'member',
  'active_workspace_id', 'bbbb2222-0000-0000-0000-000000000000'
)::text, true);

select is(
  (select count(*) from public.documents where id = 'd0000002-0000-0000-0000-000000000002'),
  1::bigint,
  'Bob ve documento en su workspace home');

-- caso 3: doc soft-deleted no visible
update public.documents
  set deleted_at = now(), deleted_by = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  where id = 'd0000002-0000-0000-0000-000000000002';

select is(
  (select count(*) from public.documents where id = 'd0000002-0000-0000-0000-000000000002'),
  0::bigint,
  'Documento soft-deleted no aparece');

-- caso 4: collection tenant_public da acceso cross-workspace
insert into public.collections (id, tenant_id, workspace_id, slug, name, visibility) values
  ('c0000001-0000-0000-0000-000000000001'::uuid, '11111111-1111-1111-1111-111111111111', 'aaaa1111-0000-0000-0000-000000000000', 'public-pol', 'Politicas publicas', 'tenant_public');

-- crear segundo user en Tenant A, sin membership a workspace A
insert into auth.users (id, email) values
  ('cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid, 'carlos@rls-a.test');
insert into public.users (id, tenant_id, email, role, status) values
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '11111111-1111-1111-1111-111111111111', 'carlos@rls-a.test', 'member', 'active');

-- carlos NO ve el doc todavia (no esta en collection publica)
select set_config('request.jwt.claims', json_build_object(
  'sub', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  'tenant_id', '11111111-1111-1111-1111-111111111111',
  'tenant_role', 'member',
  'active_workspace_id', null
)::text, true);

select is(
  (select count(*) from public.documents where id = 'd0000001-0000-0000-0000-000000000001'),
  0::bigint,
  'Carlos NO ve doc de workspace A donde no es miembro');

-- agregar doc a la collection publica
insert into public.document_collections (tenant_id, document_id, collection_id) values
  ('11111111-1111-1111-1111-111111111111', 'd0000001-0000-0000-0000-000000000001', 'c0000001-0000-0000-0000-000000000001');

select is(
  (select count(*) from public.documents where id = 'd0000001-0000-0000-0000-000000000001'),
  1::bigint,
  'Carlos AHORA ve doc via collection tenant_public');

-- caso 5: cambiar visibility a workspace_private revierte el acceso
update public.collections
  set visibility = 'workspace_private'
  where id = 'c0000001-0000-0000-0000-000000000001';

select is(
  (select count(*) from public.documents where id = 'd0000001-0000-0000-0000-000000000001'),
  0::bigint,
  'Carlos pierde acceso al revertir collection a workspace_private');

-- caso 6: tenant admin ve todo en su tenant
update public.users set role = 'admin'
  where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

select set_config('request.jwt.claims', json_build_object(
  'sub', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  'tenant_id', '11111111-1111-1111-1111-111111111111',
  'tenant_role', 'admin',
  'active_workspace_id', null
)::text, true);

select is(
  (select count(*) from public.documents where id = 'd0000001-0000-0000-0000-000000000001'),
  1::bigint,
  'Tenant admin ve doc independiente de workspace membership');

-- 4 asserts adicionales para cubrir policies de collections + tags + workspaces
-- (mismas reglas: tenant_id boundary + deleted_at filtering).
select is(
  (select count(*) from public.workspaces where tenant_id = '22222222-2222-2222-2222-222222222222'),
  0::bigint,
  'admin de Tenant A NO ve workspaces de Tenant B');

select is(
  (select count(*) from public.collections where tenant_id = '22222222-2222-2222-2222-222222222222'),
  0::bigint,
  'admin de Tenant A NO ve collections de Tenant B');

select is(
  (select count(*) from public.groups where tenant_id = '22222222-2222-2222-2222-222222222222'),
  0::bigint,
  'admin de Tenant A NO ve groups de Tenant B');

select is(
  (select count(*) from public.tags where tenant_id = '22222222-2222-2222-2222-222222222222'),
  0::bigint,
  'admin de Tenant A NO ve tags de Tenant B');

select * from finish();
rollback;
```

- [ ] **Step 2: Correr, verificar FALLA**

```bash
npm run test:db -- --file documents_rls_visibility_test.sql
```

Expected: la policy actual `documents_select_tenant` no contempla `deleted_at` ni `user_can_read_document`, por lo que varios asserts del test fallan (caso 3 soft-deleted, casos 4-5 collections publicas).

- [ ] **Step 3: Escribir migracion**

**Files:**
- Create: `supabase/migrations/20260522215500_documents_rls_visibility.sql`

```sql
-- RLS policy revisada para documents (Tier 1 036)
-- usa el helper app.user_can_read_document creado en Paso 9 que cubre:
--   - tenant admin: ve todo
--   - miembro del workspace home del doc
--   - doc en collection con visibility='tenant_public'

drop policy if exists documents_select_tenant on public.documents;

create policy documents_select_visible on public.documents
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and deleted_at is null
    and (select app.user_can_read_document(id))
  );

-- documents_insert_tenant fue removida en migracion del Paso 5; insert ya pasa
-- por RPC `create_document_upload` (security definer). Confirmar que sigue asi.

-- documents_update_tenant: revisar y restringir a editors via RPCs.
drop policy if exists documents_update_tenant on public.documents;
-- no se crea reemplazo: toda mutacion va por RPC.

-- documents_delete_owner_uploading_failed se preserva (limpieza de uploads
-- abortados sigue siendo OK por owner). soft-delete general va por RPC.
```

- [ ] **Step 4: Correr, verificar PASA**

```bash
npm run test:db -- --file documents_rls_visibility_test.sql
```

Expected: `ok 1 .. ok 12`.

- [ ] **Step 5: Suite completo**

```bash
npm run test:db
```

Expected: tests previos verdes. Ojo: el test `documents_upload_flow_test.sql` puede asumir la policy vieja `documents_select_tenant`. Si rompe, ajustarlo a la nueva semantica (insertar workspace + membership en el setup).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260522215500_documents_rls_visibility.sql \
        supabase/tests/documents_rls_visibility_test.sql
git commit -m "feat(documents): RLS policy revisada con workspace+collection_public visibility (tier1 036)"
```

## Paso 13 · RPCs Workspaces CRUD + memberships (Migracion 037)

### Task 13.1: Test pgTAP de las RPCs core de workspaces

**Files:**
- Test: `supabase/tests/rpcs_workspaces_test.sql`

- [ ] **Step 1: Escribir test que ejercita el ciclo completo**

```sql
begin;
select plan(14);

-- setup minimal: tenant + owner
insert into public.tenants (id, slug, name) values
  ('11111111-1111-1111-1111-111111111111', 'ws-rpc', 'WS RPC Tenant');
insert into auth.users (id, email) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner@ws-rpc.test'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'member@ws-rpc.test');
insert into public.users (id, tenant_id, email, role, status) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner@ws-rpc.test', 'owner', 'active'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111', 'member@ws-rpc.test', 'member', 'active');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object(
  'sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'tenant_id', '11111111-1111-1111-1111-111111111111',
  'tenant_role', 'owner'
)::text, true);

-- 1. create_workspace
select lives_ok($$
  select public.create_workspace('Finanzas', 'finanzas', 'Workspace de finanzas');
$$, 'create_workspace exitoso para owner');

select is(
  (select count(*) from public.workspaces where tenant_id = '11111111-1111-1111-1111-111111111111' and slug = 'finanzas'),
  1::bigint,
  'workspace creado en DB');

-- 2. el creador queda como workspace_admin automaticamente
select is(
  (select role::text from public.workspace_memberships wm
     join public.workspaces w on w.id = wm.workspace_id
   where w.slug = 'finanzas' and wm.principal_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  'workspace_admin',
  'creador agregado como workspace_admin');

-- 3. update_workspace
select lives_ok($$
  select public.update_workspace(
    (select id from public.workspaces where slug = 'finanzas'),
    jsonb_build_object('description', 'Finanzas y contabilidad 2026')
  );
$$, 'update_workspace exitoso');

select is(
  (select description from public.workspaces where slug = 'finanzas'),
  'Finanzas y contabilidad 2026',
  'descripcion actualizada');

-- 4. add_workspace_member para member
select lives_ok($$
  select public.add_workspace_member(
    (select id from public.workspaces where slug = 'finanzas'),
    'user',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    'workspace_editor'
  );
$$, 'add_workspace_member exitoso');

select is(
  (select role::text from public.workspace_memberships
   where principal_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  'workspace_editor',
  'member agregado como editor');

-- 5. change_workspace_member_role
select lives_ok($$
  select public.change_workspace_member_role(
    (select id from public.workspaces where slug = 'finanzas'),
    'user',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    'workspace_viewer'
  );
$$, 'change_workspace_member_role exitoso');

-- 6. remove_workspace_member
select lives_ok($$
  select public.remove_workspace_member(
    (select id from public.workspaces where slug = 'finanzas'),
    'user',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  );
$$, 'remove_workspace_member exitoso');

select is(
  (select count(*) from public.workspace_memberships
   where principal_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  0::bigint,
  'membership eliminada');

-- 7. non-admin no puede crear workspace
select set_config('request.jwt.claims', json_build_object(
  'sub', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'tenant_id', '11111111-1111-1111-1111-111111111111',
  'tenant_role', 'member'
)::text, true);

select throws_ok($$
  select public.create_workspace('Legal', 'legal');
$$, '%admin%', 'member no puede crear workspaces');

-- 8. archive_workspace (status)
select set_config('request.jwt.claims', json_build_object(
  'sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'tenant_id', '11111111-1111-1111-1111-111111111111',
  'tenant_role', 'owner'
)::text, true);

select lives_ok($$
  select public.archive_workspace(
    (select id from public.workspaces where slug = 'finanzas')
  );
$$, 'archive_workspace exitoso');

select is(
  (select status::text from public.workspaces where slug = 'finanzas'),
  'archived',
  'workspace marcado como archived');

-- 9. delete_workspace (soft-delete)
select lives_ok($$
  select public.delete_workspace(
    (select id from public.workspaces where slug = 'finanzas')
  );
$$, 'delete_workspace exitoso');

select isnt(
  (select deleted_at from public.workspaces where slug = 'finanzas'),
  null,
  'workspace soft-deleted (deleted_at no null)');

select * from finish();
rollback;
```

- [ ] **Step 2: Correr, verificar FALLA**

```bash
npm run test:db -- --file rpcs_workspaces_test.sql
```

Expected: 14 asserts fallan con `function public.create_workspace does not exist`.

- [ ] **Step 3: Escribir migracion**

**Files:**
- Create: `supabase/migrations/20260522220000_rpcs_workspaces.sql`

```sql
-- RPCs Workspaces (Tier 1 037)

create or replace function public.create_workspace(
  _name text,
  _slug text default null,
  _description text default null,
  _settings jsonb default '{}'::jsonb,
  _request_context jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
  current_user_id uuid := auth.uid();
  derived_slug text;
  new_id uuid := extensions.gen_random_uuid();
begin
  if current_user_id is null then
    raise exception 'Authentication required';
  end if;
  if current_tenant_id is null then
    raise exception 'Tenant claim is required';
  end if;
  if not (select app.is_tenant_admin()) then
    raise exception 'Only tenant admins can create workspaces';
  end if;
  if nullif(trim(_name), '') is null then
    raise exception 'Workspace name is required';
  end if;

  derived_slug := coalesce(
    nullif(lower(regexp_replace(_slug, '[^a-zA-Z0-9_-]+', '-', 'g')), ''),
    regexp_replace(lower(_name), '[^a-z0-9_-]+', '-', 'g')
  );

  insert into public.workspaces (
    id, tenant_id, slug, name, description, settings, created_by
  ) values (
    new_id, current_tenant_id, derived_slug, _name, _description,
    coalesce(_settings, '{}'::jsonb), current_user_id
  );

  -- el creador queda como workspace_admin
  insert into public.workspace_memberships (
    workspace_id, tenant_id, principal_kind, principal_id, role, added_by
  ) values (
    new_id, current_tenant_id, 'user', current_user_id, 'workspace_admin', current_user_id
  );

  perform app.audit_with_context(
    'workspace.created', 'workspace', new_id,
    jsonb_build_object('name', _name, 'slug', derived_slug),
    _request_context
  );

  return new_id;
end;
$$;

create or replace function public.update_workspace(
  _workspace_id uuid,
  _patch jsonb,
  _request_context jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
  ws_role public.workspace_role;
begin
  if current_tenant_id is null then
    raise exception 'Tenant claim is required';
  end if;
  ws_role := app.user_workspace_role(_workspace_id);
  if not (select app.is_tenant_admin()) and ws_role is distinct from 'workspace_admin' then
    raise exception 'Only workspace admins can update workspace';
  end if;

  update public.workspaces
  set
    name = coalesce(_patch->>'name', name),
    description = coalesce(_patch->>'description', description),
    settings = coalesce(_patch->'settings', settings),
    updated_at = now()
  where id = _workspace_id
    and tenant_id = current_tenant_id;

  perform app.audit_with_context(
    'workspace.updated', 'workspace', _workspace_id,
    jsonb_build_object('patch', _patch),
    _request_context
  );
end;
$$;

create or replace function public.archive_workspace(
  _workspace_id uuid,
  _request_context jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
begin
  if not (select app.is_tenant_admin())
     and app.user_workspace_role(_workspace_id) is distinct from 'workspace_admin' then
    raise exception 'Only admins can archive workspace';
  end if;

  update public.workspaces
  set status = 'archived', archived_at = now(), updated_at = now()
  where id = _workspace_id and tenant_id = current_tenant_id;

  perform app.audit_with_context(
    'workspace.archived', 'workspace', _workspace_id,
    '{}'::jsonb, _request_context
  );
end;
$$;

create or replace function public.delete_workspace(
  _workspace_id uuid,
  _request_context jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
begin
  if not (select app.is_tenant_admin()) then
    raise exception 'Only tenant admins can delete workspace';
  end if;

  update public.workspaces
  set deleted_at = now(), updated_at = now()
  where id = _workspace_id and tenant_id = current_tenant_id;

  perform app.audit_with_context(
    'workspace.deleted', 'workspace', _workspace_id,
    '{}'::jsonb, _request_context
  );
end;
$$;

create or replace function public.add_workspace_member(
  _workspace_id uuid,
  _principal_kind public.principal_kind,
  _principal_id uuid,
  _role public.workspace_role default 'workspace_viewer',
  _request_context jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
begin
  if not (select app.is_tenant_admin())
     and app.user_workspace_role(_workspace_id) is distinct from 'workspace_admin' then
    raise exception 'Only workspace admins can add members';
  end if;

  insert into public.workspace_memberships (
    workspace_id, tenant_id, principal_kind, principal_id, role, added_by
  ) values (
    _workspace_id, current_tenant_id, _principal_kind, _principal_id, _role, auth.uid()
  )
  on conflict (workspace_id, principal_kind, principal_id) do update
    set role = excluded.role;

  perform app.audit_with_context(
    'workspace.member_added', 'workspace_membership', _workspace_id,
    jsonb_build_object('principal_kind', _principal_kind, 'principal_id', _principal_id, 'role', _role),
    _request_context
  );
end;
$$;

create or replace function public.remove_workspace_member(
  _workspace_id uuid,
  _principal_kind public.principal_kind,
  _principal_id uuid,
  _request_context jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
begin
  if not (select app.is_tenant_admin())
     and app.user_workspace_role(_workspace_id) is distinct from 'workspace_admin' then
    raise exception 'Only workspace admins can remove members';
  end if;

  delete from public.workspace_memberships
  where workspace_id = _workspace_id
    and tenant_id = current_tenant_id
    and principal_kind = _principal_kind
    and principal_id = _principal_id;

  perform app.audit_with_context(
    'workspace.member_removed', 'workspace_membership', _workspace_id,
    jsonb_build_object('principal_kind', _principal_kind, 'principal_id', _principal_id),
    _request_context
  );
end;
$$;

create or replace function public.change_workspace_member_role(
  _workspace_id uuid,
  _principal_kind public.principal_kind,
  _principal_id uuid,
  _role public.workspace_role,
  _request_context jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
begin
  if not (select app.is_tenant_admin())
     and app.user_workspace_role(_workspace_id) is distinct from 'workspace_admin' then
    raise exception 'Only workspace admins can change member role';
  end if;

  update public.workspace_memberships
  set role = _role
  where workspace_id = _workspace_id
    and tenant_id = current_tenant_id
    and principal_kind = _principal_kind
    and principal_id = _principal_id;

  perform app.audit_with_context(
    'workspace.member_role_changed', 'workspace_membership', _workspace_id,
    jsonb_build_object('principal_kind', _principal_kind, 'principal_id', _principal_id, 'role', _role),
    _request_context
  );
end;
$$;

create or replace function public.set_active_workspace(_workspace_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then
    raise exception 'Authentication required';
  end if;
  if not (select app.user_belongs_to_workspace(_workspace_id))
     and not (select app.is_tenant_admin()) then
    raise exception 'User does not belong to workspace';
  end if;

  -- Actualizar user_metadata. La proxima emision del JWT (via supabase auth
  -- refresh) tomara el nuevo active_workspace_id desde el hook.
  update auth.users
  set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb)
                            || jsonb_build_object('active_workspace_id', _workspace_id::text)
  where id = current_user_id;
end;
$$;

revoke execute on function public.create_workspace(text, text, text, jsonb, jsonb) from anon, public;
grant execute on function public.create_workspace(text, text, text, jsonb, jsonb) to authenticated;
revoke execute on function public.update_workspace(uuid, jsonb, jsonb) from anon, public;
grant execute on function public.update_workspace(uuid, jsonb, jsonb) to authenticated;
revoke execute on function public.archive_workspace(uuid, jsonb) from anon, public;
grant execute on function public.archive_workspace(uuid, jsonb) to authenticated;
revoke execute on function public.delete_workspace(uuid, jsonb) from anon, public;
grant execute on function public.delete_workspace(uuid, jsonb) to authenticated;
revoke execute on function public.add_workspace_member(uuid, public.principal_kind, uuid, public.workspace_role, jsonb) from anon, public;
grant execute on function public.add_workspace_member(uuid, public.principal_kind, uuid, public.workspace_role, jsonb) to authenticated;
revoke execute on function public.remove_workspace_member(uuid, public.principal_kind, uuid, jsonb) from anon, public;
grant execute on function public.remove_workspace_member(uuid, public.principal_kind, uuid, jsonb) to authenticated;
revoke execute on function public.change_workspace_member_role(uuid, public.principal_kind, uuid, public.workspace_role, jsonb) from anon, public;
grant execute on function public.change_workspace_member_role(uuid, public.principal_kind, uuid, public.workspace_role, jsonb) to authenticated;
revoke execute on function public.set_active_workspace(uuid) from anon, public;
grant execute on function public.set_active_workspace(uuid) to authenticated;
```

- [ ] **Step 4: Correr, verificar PASA**

```bash
npm run test:db -- --file rpcs_workspaces_test.sql
```

Expected: `ok 1 .. ok 14`.

- [ ] **Step 5: Suite completo**

```bash
npm run test:db
```

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260522220000_rpcs_workspaces.sql \
        supabase/tests/rpcs_workspaces_test.sql
git commit -m "feat(workspaces): CRUD RPCs + memberships + set_active_workspace (tier1 037)"
```

## Paso 14 · RPCs Groups (Migracion 038)

### Task 14.1: Test pgTAP

**Files:**
- Test: `supabase/tests/rpcs_groups_test.sql`

- [ ] **Step 1: Escribir test**

```sql
begin;
select plan(8);

insert into public.tenants (id, slug, name) values
  ('11111111-1111-1111-1111-111111111111', 'g-rpc', 'Groups RPC');
insert into auth.users (id, email) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'admin@g.test'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'm@g.test');
insert into public.users (id, tenant_id, email, role, status) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'admin@g.test', 'admin', 'active'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111', 'm@g.test', 'member', 'active');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object(
  'sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'tenant_id', '11111111-1111-1111-1111-111111111111',
  'tenant_role', 'admin'
)::text, true);

select lives_ok($$
  select public.create_group('legal', 'Legal team', 'Equipo legal');
$$, 'create_group admin');

select is(
  (select count(*) from public.groups where key = 'legal' and tenant_id = '11111111-1111-1111-1111-111111111111'),
  1::bigint,
  'grupo creado');

select lives_ok($$
  select public.add_group_member(
    (select id from public.groups where key = 'legal'),
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  );
$$, 'add_group_member');

select is(
  (select count(*) from public.group_memberships
   where user_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  1::bigint,
  'membership creada');

select lives_ok($$
  select public.remove_group_member(
    (select id from public.groups where key = 'legal'),
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  );
$$, 'remove_group_member');

select lives_ok($$
  select public.update_group(
    (select id from public.groups where key = 'legal'),
    jsonb_build_object('name', 'Legal & Compliance')
  );
$$, 'update_group');

select lives_ok($$
  select public.archive_group(
    (select id from public.groups where key = 'legal')
  );
$$, 'archive_group');

-- member no puede crear grupo
select set_config('request.jwt.claims', json_build_object(
  'sub', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'tenant_id', '11111111-1111-1111-1111-111111111111',
  'tenant_role', 'member'
)::text, true);

select throws_ok($$
  select public.create_group('finanzas', 'Finanzas');
$$, '%admin%', 'member no crea group');

select * from finish();
rollback;
```

- [ ] **Step 2: Correr, verificar FALLA**

```bash
npm run test:db -- --file rpcs_groups_test.sql
```

- [ ] **Step 3: Escribir migracion**

**Files:**
- Create: `supabase/migrations/20260522220500_rpcs_groups.sql`

```sql
-- RPCs Groups (Tier 1 038)

create or replace function public.create_group(
  _key text,
  _name text,
  _description text default null,
  _metadata jsonb default '{}'::jsonb,
  _request_context jsonb default '{}'::jsonb
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
  new_id uuid := extensions.gen_random_uuid();
begin
  if not (select app.is_tenant_admin()) then
    raise exception 'Only tenant admins can create groups';
  end if;
  if nullif(trim(_key), '') is null or nullif(trim(_name), '') is null then
    raise exception 'Group key and name required';
  end if;
  insert into public.groups (id, tenant_id, key, name, description, metadata, created_by)
  values (new_id, current_tenant_id, lower(_key), _name, _description,
          coalesce(_metadata, '{}'::jsonb), auth.uid());
  perform app.audit_with_context(
    'group.created', 'group', new_id,
    jsonb_build_object('key', _key, 'name', _name), _request_context);
  return new_id;
end;
$$;

create or replace function public.update_group(
  _group_id uuid, _patch jsonb,
  _request_context jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not (select app.is_tenant_admin()) then
    raise exception 'Only admins can update groups';
  end if;
  update public.groups
  set name = coalesce(_patch->>'name', name),
      description = coalesce(_patch->>'description', description),
      metadata = coalesce(_patch->'metadata', metadata),
      updated_at = now()
  where id = _group_id and tenant_id = (select app.current_tenant_id());
  perform app.audit_with_context(
    'group.updated', 'group', _group_id,
    jsonb_build_object('patch', _patch), _request_context);
end;
$$;

create or replace function public.archive_group(
  _group_id uuid,
  _request_context jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not (select app.is_tenant_admin()) then
    raise exception 'Only admins can archive groups';
  end if;
  update public.groups
  set deleted_at = now(), updated_at = now()
  where id = _group_id and tenant_id = (select app.current_tenant_id());
  perform app.audit_with_context(
    'group.archived', 'group', _group_id, '{}'::jsonb, _request_context);
end;
$$;

create or replace function public.add_group_member(
  _group_id uuid, _user_id uuid,
  _request_context jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
begin
  if not (select app.is_tenant_admin()) then
    raise exception 'Only admins can add group members';
  end if;
  -- verificar que el user pertenece al mismo tenant
  if not exists (
    select 1 from public.users u
    where u.id = _user_id and u.tenant_id = current_tenant_id
  ) then
    raise exception 'User does not belong to this tenant';
  end if;
  insert into public.group_memberships (group_id, user_id, tenant_id, added_by)
  values (_group_id, _user_id, current_tenant_id, auth.uid())
  on conflict (group_id, user_id) do nothing;
  perform app.audit_with_context(
    'group.member_added', 'group_membership', _group_id,
    jsonb_build_object('user_id', _user_id), _request_context);
end;
$$;

create or replace function public.remove_group_member(
  _group_id uuid, _user_id uuid,
  _request_context jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not (select app.is_tenant_admin()) then
    raise exception 'Only admins can remove group members';
  end if;
  delete from public.group_memberships
  where group_id = _group_id and user_id = _user_id
    and tenant_id = (select app.current_tenant_id());
  perform app.audit_with_context(
    'group.member_removed', 'group_membership', _group_id,
    jsonb_build_object('user_id', _user_id), _request_context);
end;
$$;

revoke execute on function public.create_group(text, text, text, jsonb, jsonb) from anon, public;
grant execute on function public.create_group(text, text, text, jsonb, jsonb) to authenticated;
revoke execute on function public.update_group(uuid, jsonb, jsonb) from anon, public;
grant execute on function public.update_group(uuid, jsonb, jsonb) to authenticated;
revoke execute on function public.archive_group(uuid, jsonb) from anon, public;
grant execute on function public.archive_group(uuid, jsonb) to authenticated;
revoke execute on function public.add_group_member(uuid, uuid, jsonb) from anon, public;
grant execute on function public.add_group_member(uuid, uuid, jsonb) to authenticated;
revoke execute on function public.remove_group_member(uuid, uuid, jsonb) from anon, public;
grant execute on function public.remove_group_member(uuid, uuid, jsonb) to authenticated;
```

- [ ] **Step 4: Correr, verificar PASA**

```bash
npm run test:db -- --file rpcs_groups_test.sql
```

- [ ] **Step 5: Suite completo**

```bash
npm run test:db
```

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260522220500_rpcs_groups.sql \
        supabase/tests/rpcs_groups_test.sql
git commit -m "feat(groups): CRUD RPCs + memberships (tier1 038)"
```

## Paso 15 · RPCs Collections + Tags (Migracion 039)

### Task 15.1: Test pgTAP

**Files:**
- Test: `supabase/tests/rpcs_collections_tags_test.sql`

- [ ] **Step 1: Escribir test**

```sql
begin;
select plan(10);

-- setup: tenant, admin, workspace
insert into public.tenants (id, slug, name) values
  ('11111111-1111-1111-1111-111111111111', 'ct-rpc', 'Collections+Tags');
insert into auth.users (id, email) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'admin@ct.test');
insert into public.users (id, tenant_id, email, role, status) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'admin@ct.test', 'admin', 'active');
insert into public.workspaces (id, tenant_id, slug, name) values
  ('aaaa1111-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'ws', 'WS');
insert into public.workspace_memberships (workspace_id, tenant_id, principal_kind, principal_id, role) values
  ('aaaa1111-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'user', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'workspace_admin');
insert into public.documents (id, tenant_id, workspace_id, created_by, filename, r2_key, status, uploaded_at) values
  ('d0000001-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'aaaa1111-0000-0000-0000-000000000000', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'doc.pdf', '11111111-1111-1111-1111-111111111111/d0000001-0000-0000-0000-000000000001/doc.pdf', 'indexed', now());

set local role authenticated;
select set_config('request.jwt.claims', json_build_object(
  'sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'tenant_id', '11111111-1111-1111-1111-111111111111',
  'tenant_role', 'admin',
  'active_workspace_id', 'aaaa1111-0000-0000-0000-000000000000'
)::text, true);

-- 1. create_collection
select lives_ok($$
  select public.create_collection(
    'aaaa1111-0000-0000-0000-000000000000',
    'politicas', 'Politicas', null, 'workspace_private');
$$, 'create_collection');

select is(
  (select count(*) from public.collections where slug = 'politicas'),
  1::bigint, 'collection creada');

-- 2. set_collection_visibility
select lives_ok($$
  select public.set_collection_visibility(
    (select id from public.collections where slug = 'politicas'),
    'tenant_public');
$$, 'set_collection_visibility');

select is(
  (select visibility::text from public.collections where slug = 'politicas'),
  'tenant_public', 'visibility cambiada');

-- 3. add_document_to_collection
select lives_ok($$
  select public.add_document_to_collection(
    'd0000001-0000-0000-0000-000000000001',
    (select id from public.collections where slug = 'politicas'));
$$, 'add_document_to_collection');

select is(
  (select count(*) from public.document_collections
   where document_id = 'd0000001-0000-0000-0000-000000000001'),
  1::bigint, 'doc agregado a collection');

-- 4. tags
select lives_ok($$
  select public.create_tag('kpi', 'KPI Q1');
$$, 'create_tag');

select lives_ok($$
  select public.tag_document(
    'd0000001-0000-0000-0000-000000000001',
    (select id from public.tags where key = 'kpi'));
$$, 'tag_document');

select is(
  (select count(*) from public.document_tags
   where document_id = 'd0000001-0000-0000-0000-000000000001'),
  1::bigint, 'tag aplicado');

-- 5. archive_collection
select lives_ok($$
  select public.archive_collection(
    (select id from public.collections where slug = 'politicas'));
$$, 'archive_collection');

select * from finish();
rollback;
```

- [ ] **Step 2: Correr, verificar FALLA**

```bash
npm run test:db -- --file rpcs_collections_tags_test.sql
```

- [ ] **Step 3: Escribir migracion**

**Files:**
- Create: `supabase/migrations/20260522221000_rpcs_collections_tags.sql`

```sql
-- RPCs Collections + Tags (Tier 1 039)

create or replace function public.create_collection(
  _workspace_id uuid, _slug text, _name text,
  _description text default null,
  _visibility public.collection_visibility default 'workspace_private',
  _request_context jsonb default '{}'::jsonb
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
  new_id uuid := extensions.gen_random_uuid();
  ws_role public.workspace_role := app.user_workspace_role(_workspace_id);
begin
  if not (select app.is_tenant_admin())
     and ws_role not in ('workspace_admin', 'workspace_editor') then
    raise exception 'Only workspace editor/admin can create collections';
  end if;
  insert into public.collections (
    id, tenant_id, workspace_id, slug, name, description, visibility, created_by
  ) values (
    new_id, current_tenant_id, _workspace_id,
    lower(_slug), _name, _description, _visibility, auth.uid()
  );
  perform app.audit_with_context(
    'collection.created', 'collection', new_id,
    jsonb_build_object('slug', _slug, 'visibility', _visibility),
    _request_context);
  return new_id;
end;
$$;

create or replace function public.update_collection(
  _collection_id uuid, _patch jsonb,
  _request_context jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  c_record public.collections%rowtype;
begin
  select * into c_record from public.collections where id = _collection_id;
  if c_record.id is null then
    raise exception 'Collection not found';
  end if;
  if not (select app.is_tenant_admin())
     and app.user_workspace_role(c_record.workspace_id) not in ('workspace_admin','workspace_editor') then
    raise exception 'Only workspace editor/admin can update collections';
  end if;
  update public.collections
  set name = coalesce(_patch->>'name', name),
      description = coalesce(_patch->>'description', description),
      icon = coalesce(_patch->>'icon', icon),
      color = coalesce(_patch->>'color', color),
      metadata = coalesce(_patch->'metadata', metadata),
      updated_at = now()
  where id = _collection_id;
  perform app.audit_with_context(
    'collection.updated', 'collection', _collection_id,
    jsonb_build_object('patch', _patch), _request_context);
end;
$$;

create or replace function public.set_collection_visibility(
  _collection_id uuid, _visibility public.collection_visibility,
  _request_context jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  c_record public.collections%rowtype;
begin
  select * into c_record from public.collections where id = _collection_id;
  if c_record.id is null then
    raise exception 'Collection not found';
  end if;
  -- cambiar a tenant_public requiere admin del workspace o tenant
  if _visibility = 'tenant_public'
     and not (select app.is_tenant_admin())
     and app.user_workspace_role(c_record.workspace_id) <> 'workspace_admin' then
    raise exception 'Only workspace admin can publish collection to tenant';
  end if;
  update public.collections set visibility = _visibility, updated_at = now()
  where id = _collection_id;
  perform app.audit_with_context(
    'collection.visibility_changed', 'collection', _collection_id,
    jsonb_build_object('from', c_record.visibility, 'to', _visibility),
    _request_context);
end;
$$;

create or replace function public.archive_collection(
  _collection_id uuid,
  _request_context jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  c_record public.collections%rowtype;
begin
  select * into c_record from public.collections where id = _collection_id;
  if c_record.id is null then return; end if;
  if not (select app.is_tenant_admin())
     and app.user_workspace_role(c_record.workspace_id) <> 'workspace_admin' then
    raise exception 'Only workspace admin can archive collections';
  end if;
  update public.collections set deleted_at = now(), updated_at = now()
  where id = _collection_id;
  perform app.audit_with_context(
    'collection.archived', 'collection', _collection_id,
    '{}'::jsonb, _request_context);
end;
$$;

create or replace function public.add_document_to_collection(
  _document_id uuid, _collection_id uuid,
  _request_context jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
begin
  if not (select app.user_can_edit_document(_document_id)) then
    raise exception 'No edit permission on document';
  end if;
  insert into public.document_collections (
    tenant_id, document_id, collection_id, added_by
  ) values (current_tenant_id, _document_id, _collection_id, auth.uid())
  on conflict do nothing;
  perform app.audit_with_context(
    'document.added_to_collection', 'document', _document_id,
    jsonb_build_object('collection_id', _collection_id), _request_context);
end;
$$;

create or replace function public.remove_document_from_collection(
  _document_id uuid, _collection_id uuid,
  _request_context jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not (select app.user_can_edit_document(_document_id)) then
    raise exception 'No edit permission on document';
  end if;
  delete from public.document_collections
  where document_id = _document_id and collection_id = _collection_id;
  perform app.audit_with_context(
    'document.removed_from_collection', 'document', _document_id,
    jsonb_build_object('collection_id', _collection_id), _request_context);
end;
$$;

create or replace function public.create_tag(
  _key text, _label text, _color text default null,
  _description text default null,
  _request_context jsonb default '{}'::jsonb
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
  new_id uuid := extensions.gen_random_uuid();
begin
  if not (select app.is_tenant_admin()) then
    raise exception 'Only admins can create tags';
  end if;
  insert into public.tags (id, tenant_id, key, label, color, description, created_by)
  values (new_id, current_tenant_id, lower(_key), _label, _color, _description, auth.uid());
  perform app.audit_with_context(
    'tag.created', 'tag', new_id,
    jsonb_build_object('key', _key, 'label', _label), _request_context);
  return new_id;
end;
$$;

create or replace function public.update_tag(
  _tag_id uuid, _patch jsonb,
  _request_context jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not (select app.is_tenant_admin()) then
    raise exception 'Only admins can update tags';
  end if;
  update public.tags
  set label = coalesce(_patch->>'label', label),
      color = coalesce(_patch->>'color', color),
      description = coalesce(_patch->>'description', description),
      updated_at = now()
  where id = _tag_id and tenant_id = (select app.current_tenant_id());
  perform app.audit_with_context(
    'tag.updated', 'tag', _tag_id,
    jsonb_build_object('patch', _patch), _request_context);
end;
$$;

create or replace function public.tag_document(
  _document_id uuid, _tag_id uuid,
  _request_context jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not (select app.user_can_edit_document(_document_id)) then
    raise exception 'No edit permission';
  end if;
  insert into public.document_tags (tenant_id, document_id, tag_id, added_by)
  values ((select app.current_tenant_id()), _document_id, _tag_id, auth.uid())
  on conflict do nothing;
  perform app.audit_with_context(
    'document.tagged', 'document', _document_id,
    jsonb_build_object('tag_id', _tag_id), _request_context);
end;
$$;

create or replace function public.untag_document(
  _document_id uuid, _tag_id uuid,
  _request_context jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not (select app.user_can_edit_document(_document_id)) then
    raise exception 'No edit permission';
  end if;
  delete from public.document_tags
  where document_id = _document_id and tag_id = _tag_id;
  perform app.audit_with_context(
    'document.untagged', 'document', _document_id,
    jsonb_build_object('tag_id', _tag_id), _request_context);
end;
$$;

-- grants
revoke execute on function public.create_collection(uuid, text, text, text, public.collection_visibility, jsonb) from anon, public;
grant execute on function public.create_collection(uuid, text, text, text, public.collection_visibility, jsonb) to authenticated;
revoke execute on function public.update_collection(uuid, jsonb, jsonb) from anon, public;
grant execute on function public.update_collection(uuid, jsonb, jsonb) to authenticated;
revoke execute on function public.set_collection_visibility(uuid, public.collection_visibility, jsonb) from anon, public;
grant execute on function public.set_collection_visibility(uuid, public.collection_visibility, jsonb) to authenticated;
revoke execute on function public.archive_collection(uuid, jsonb) from anon, public;
grant execute on function public.archive_collection(uuid, jsonb) to authenticated;
revoke execute on function public.add_document_to_collection(uuid, uuid, jsonb) from anon, public;
grant execute on function public.add_document_to_collection(uuid, uuid, jsonb) to authenticated;
revoke execute on function public.remove_document_from_collection(uuid, uuid, jsonb) from anon, public;
grant execute on function public.remove_document_from_collection(uuid, uuid, jsonb) to authenticated;
revoke execute on function public.create_tag(text, text, text, text, jsonb) from anon, public;
grant execute on function public.create_tag(text, text, text, text, jsonb) to authenticated;
revoke execute on function public.update_tag(uuid, jsonb, jsonb) from anon, public;
grant execute on function public.update_tag(uuid, jsonb, jsonb) to authenticated;
revoke execute on function public.tag_document(uuid, uuid, jsonb) from anon, public;
grant execute on function public.tag_document(uuid, uuid, jsonb) to authenticated;
revoke execute on function public.untag_document(uuid, uuid, jsonb) from anon, public;
grant execute on function public.untag_document(uuid, uuid, jsonb) to authenticated;
```

- [ ] **Step 4: Correr, verificar PASA**

```bash
npm run test:db -- --file rpcs_collections_tags_test.sql
```

- [ ] **Step 5: Suite completo**

```bash
npm run test:db
```

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260522221000_rpcs_collections_tags.sql \
        supabase/tests/rpcs_collections_tags_test.sql
git commit -m "feat(collections): CRUD RPCs + tags + visibility control (tier1 039)"
```

## Paso 16 · Documents RPCs extendidas (Migracion 040)

Reemplaza placeholders del Paso 11 con implementacion real y muta `create_document_upload` para aceptar workspace.

### Task 16.1: Test pgTAP

**Files:**
- Test: `supabase/tests/rpcs_documents_extended_test.sql`

- [ ] **Step 1: Escribir test**

```sql
begin;
select plan(10);

-- setup: tenant + 2 workspaces + 1 user editor en ambos
insert into public.tenants (id, slug, name) values
  ('11111111-1111-1111-1111-111111111111', 'd-rpc', 'D');
insert into auth.users (id, email) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'u@d.test');
insert into public.users (id, tenant_id, email, role, status) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'u@d.test', 'admin', 'active');
insert into public.workspaces (id, tenant_id, slug, name) values
  ('11110000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'a', 'A'),
  ('22220000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'b', 'B');
insert into public.workspace_memberships (workspace_id, tenant_id, principal_kind, principal_id, role) values
  ('11110000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'user', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'workspace_editor'),
  ('22220000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'user', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'workspace_editor');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object(
  'sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'tenant_id', '11111111-1111-1111-1111-111111111111',
  'tenant_role', 'admin',
  'active_workspace_id', '11110000-0000-0000-0000-000000000001'
)::text, true);

-- 1. create_document_upload con workspace_id
select lives_ok($$
  select public.create_document_upload(
    _filename => 'a.pdf',
    _workspace_id => '11110000-0000-0000-0000-000000000001'::uuid
  );
$$, 'create_document_upload con workspace');

select is(
  (select workspace_id from public.documents where filename = 'a.pdf'),
  '11110000-0000-0000-0000-000000000001'::uuid,
  'documento creado en workspace correcto');

-- 2. archive_document (soft-delete)
select lives_ok($$
  select public.archive_document(
    (select id from public.documents where filename = 'a.pdf')
  );
$$, 'archive_document');

select isnt(
  (select deleted_at from public.documents where filename = 'a.pdf'),
  null, 'documento soft-deleted');

-- 3. restore_document
select lives_ok($$
  select public.restore_document(
    (select id from public.documents where filename = 'a.pdf')
  );
$$, 'restore_document');

select is(
  (select deleted_at from public.documents where filename = 'a.pdf'),
  null, 'documento restaurado');

-- 4. move_document a workspace B
select lives_ok($$
  select public.move_document(
    (select id from public.documents where filename = 'a.pdf'),
    '22220000-0000-0000-0000-000000000002'::uuid
  );
$$, 'move_document');

select is(
  (select workspace_id from public.documents where filename = 'a.pdf'),
  '22220000-0000-0000-0000-000000000002'::uuid,
  'workspace_id actualizado');

-- 5. bulk_update_documents
select lives_ok($$
  select public.bulk_update_documents(
    array[(select id from public.documents where filename = 'a.pdf')]::uuid[],
    jsonb_build_object('title', 'Documento A renombrado')
  );
$$, 'bulk_update_documents');

select is(
  (select title from public.documents where filename = 'a.pdf'),
  'Documento A renombrado',
  'titulo actualizado por bulk');

select * from finish();
rollback;
```

- [ ] **Step 2: Correr, verificar FALLA**

```bash
npm run test:db -- --file rpcs_documents_extended_test.sql
```

- [ ] **Step 3: Escribir migracion**

**Files:**
- Create: `supabase/migrations/20260522221500_rpcs_documents_extended.sql`

```sql
-- Documents RPCs extendidas (Tier 1 040)
-- 1. Mutacion de create_document_upload para aceptar workspace_id + collection_id
-- 2. archive_document / restore_document / move_document / bulk_update_documents

-- drop placeholder de Paso 11
drop function if exists public.archive_document(uuid, jsonb);
drop function if exists public.restore_document(uuid);
-- drop create_document_upload anterior (signature con checksum, sin workspace)
drop function if exists public.create_document_upload(text, text, bigint, text, jsonb, text);

create or replace function public.create_document_upload(
  _filename text,
  _workspace_id uuid,
  _mime_type text default 'application/pdf',
  _byte_size bigint default null,
  _title text default null,
  _metadata jsonb default '{}'::jsonb,
  _checksum_sha256 text default null,
  _collection_id uuid default null,
  _request_context jsonb default '{}'::jsonb
)
returns table (
  document_id uuid,
  tenant_id uuid,
  r2_bucket text,
  r2_key text,
  filename text,
  status public.document_status,
  checksum_sha256 text,
  deduped boolean,
  workspace_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
  current_user_id uuid := auth.uid();
  existing_document public.documents%rowtype;
  new_document_id uuid;
  normalized_checksum text;
  safe_filename text;
  ws_role public.workspace_role;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  if current_tenant_id is null then raise exception 'Tenant claim required'; end if;
  if nullif(trim(_filename), '') is null then raise exception 'Filename required'; end if;
  if _byte_size is not null and _byte_size < 0 then raise exception 'byte_size must be >= 0'; end if;

  -- verificar que el user tiene edit en el workspace destino
  ws_role := app.user_workspace_role(_workspace_id);
  if not (select app.is_tenant_admin())
     and ws_role not in ('workspace_admin', 'workspace_editor') then
    raise exception 'User cannot upload to this workspace';
  end if;

  normalized_checksum := nullif(lower(trim(_checksum_sha256)), '');
  if normalized_checksum is not null and normalized_checksum !~ '^[a-f0-9]{64}$' then
    raise exception 'checksum_sha256 invalid';
  end if;

  -- dedupe por checksum dentro del tenant
  if normalized_checksum is not null then
    select * into existing_document
    from public.documents d
    where d.tenant_id = current_tenant_id
      and d.checksum_sha256 = normalized_checksum
      and d.uploaded_at is not null
      and d.deleted_at is null
      and d.status <> 'archived'
    order by d.created_at desc
    limit 1;
    if existing_document.id is not null then
      perform app.audit_with_context(
        'document.upload_deduped', 'document', existing_document.id,
        jsonb_build_object('filename', trim(_filename), 'checksum', normalized_checksum),
        _request_context);
      document_id := existing_document.id;
      tenant_id := existing_document.tenant_id;
      r2_bucket := existing_document.r2_bucket;
      r2_key := existing_document.r2_key;
      filename := existing_document.filename;
      status := existing_document.status;
      checksum_sha256 := existing_document.checksum_sha256;
      workspace_id := existing_document.workspace_id;
      deduped := true;
      return next;
      return;
    end if;
  end if;

  new_document_id := extensions.gen_random_uuid();
  safe_filename := app.safe_storage_filename(_filename);

  insert into public.documents (
    id, tenant_id, workspace_id, created_by, title, filename, mime_type,
    byte_size, checksum_sha256, r2_bucket, r2_key, status, metadata
  ) values (
    new_document_id, current_tenant_id, _workspace_id, current_user_id,
    nullif(trim(_title), ''), trim(_filename),
    coalesce(nullif(trim(_mime_type), ''), 'application/octet-stream'),
    _byte_size, normalized_checksum, 'documents',
    current_tenant_id::text || '/' || new_document_id::text || '/' || safe_filename,
    'uploading', coalesce(_metadata, '{}'::jsonb)
  );

  if _collection_id is not null then
    insert into public.document_collections (tenant_id, document_id, collection_id, added_by)
    values (current_tenant_id, new_document_id, _collection_id, current_user_id);
  end if;

  perform app.audit_with_context(
    'document.upload_created', 'document', new_document_id,
    jsonb_build_object('filename', trim(_filename), 'workspace_id', _workspace_id,
                       'collection_id', _collection_id),
    _request_context);

  document_id := new_document_id;
  tenant_id := current_tenant_id;
  r2_bucket := 'documents';
  r2_key := current_tenant_id::text || '/' || new_document_id::text || '/' || safe_filename;
  filename := trim(_filename);
  status := 'uploading';
  checksum_sha256 := normalized_checksum;
  workspace_id := _workspace_id;
  deduped := false;
  return next;
end;
$$;

create or replace function public.archive_document(
  _document_id uuid,
  _request_context jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not (select app.user_can_edit_document(_document_id)) then
    raise exception 'No edit permission';
  end if;
  update public.documents
  set deleted_at = now(), deleted_by = auth.uid(), updated_at = now()
  where id = _document_id;
  perform app.audit_with_context(
    'document.archived', 'document', _document_id,
    '{}'::jsonb, _request_context);
end;
$$;

create or replace function public.restore_document(
  _document_id uuid,
  _request_context jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  -- restore solo via tenant admin (decision conservadora)
  if not (select app.is_tenant_admin()) then
    raise exception 'Only tenant admins can restore documents';
  end if;
  update public.documents
  set deleted_at = null, deleted_by = null, updated_at = now()
  where id = _document_id and tenant_id = (select app.current_tenant_id());
  perform app.audit_with_context(
    'document.restored', 'document', _document_id,
    '{}'::jsonb, _request_context);
end;
$$;

create or replace function public.move_document(
  _document_id uuid,
  _to_workspace_id uuid,
  _collection_ids uuid[] default null,
  _request_context jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  ws_role public.workspace_role;
begin
  if not (select app.user_can_edit_document(_document_id)) then
    raise exception 'No edit permission on source';
  end if;
  ws_role := app.user_workspace_role(_to_workspace_id);
  if not (select app.is_tenant_admin())
     and ws_role not in ('workspace_admin', 'workspace_editor') then
    raise exception 'No edit permission on destination workspace';
  end if;

  update public.documents
  set workspace_id = _to_workspace_id, updated_at = now()
  where id = _document_id and tenant_id = (select app.current_tenant_id());

  -- reemplazar collections si se pasa lista
  if _collection_ids is not null then
    delete from public.document_collections where document_id = _document_id;
    if array_length(_collection_ids, 1) > 0 then
      insert into public.document_collections (tenant_id, document_id, collection_id, added_by)
      select (select app.current_tenant_id()), _document_id, cid, auth.uid()
      from unnest(_collection_ids) as cid;
    end if;
  end if;

  perform app.audit_with_context(
    'document.moved', 'document', _document_id,
    jsonb_build_object('to_workspace_id', _to_workspace_id, 'collection_ids', _collection_ids),
    _request_context);
end;
$$;

create or replace function public.bulk_update_documents(
  _document_ids uuid[],
  _patch jsonb,
  _request_context jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  updated_count integer := 0;
  current_tenant_id uuid := app.current_tenant_id();
begin
  -- patch admite: title, metadata, status_reason. workspace_id se cambia via move_document.
  with allowed as (
    select id from public.documents d
    where d.id = any(_document_ids)
      and d.tenant_id = current_tenant_id
      and (select app.user_can_edit_document(d.id))
  )
  update public.documents d
  set title = coalesce(_patch->>'title', title),
      metadata = coalesce(_patch->'metadata', metadata),
      status_reason = coalesce(_patch->>'status_reason', status_reason),
      updated_at = now()
  from allowed
  where d.id = allowed.id;
  get diagnostics updated_count = row_count;

  perform app.audit_with_context(
    'document.bulk_updated', 'document', null,
    jsonb_build_object('ids', _document_ids, 'patch', _patch, 'count', updated_count),
    _request_context);
  return jsonb_build_object('updated', updated_count);
end;
$$;

revoke execute on function public.create_document_upload(text, uuid, text, bigint, text, jsonb, text, uuid, jsonb) from anon, public;
grant execute on function public.create_document_upload(text, uuid, text, bigint, text, jsonb, text, uuid, jsonb) to authenticated;
revoke execute on function public.archive_document(uuid, jsonb) from anon, public;
grant execute on function public.archive_document(uuid, jsonb) to authenticated;
revoke execute on function public.restore_document(uuid, jsonb) from anon, public;
grant execute on function public.restore_document(uuid, jsonb) to authenticated;
revoke execute on function public.move_document(uuid, uuid, uuid[], jsonb) from anon, public;
grant execute on function public.move_document(uuid, uuid, uuid[], jsonb) to authenticated;
revoke execute on function public.bulk_update_documents(uuid[], jsonb, jsonb) from anon, public;
grant execute on function public.bulk_update_documents(uuid[], jsonb, jsonb) to authenticated;
```

- [ ] **Step 4: Correr, verificar PASA**

```bash
npm run test:db -- --file rpcs_documents_extended_test.sql
```

- [ ] **Step 5: Suite completo**

```bash
npm run test:db
```

Importante: el test `documents_upload_flow_test.sql` existente puede romper porque la signature de `create_document_upload` cambio (ahora requiere `_workspace_id`). Actualizar ese test agregando el workspace Default del backfill (Paso 6) en el setup.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260522221500_rpcs_documents_extended.sql \
        supabase/tests/rpcs_documents_extended_test.sql \
        supabase/tests/documents_upload_flow_test.sql
git commit -m "feat(documents): workspace_id in create_document_upload + archive/restore/move/bulk (tier1 040)"
```

## Paso 17 · Triggers audit + realtime publication (Migracion 041)

### Task 17.1: Test pgTAP de triggers

**Files:**
- Test: `supabase/tests/audit_triggers_tier1_test.sql`

- [ ] **Step 1: Test**

```sql
begin;
select plan(4);

-- Verificar que cambios a collection.visibility y workspace_memberships
-- registran audit_log entries automaticos.

insert into public.tenants (id, slug, name) values
  ('11111111-1111-1111-1111-111111111111', 'audit-t1', 'Audit T1');
insert into auth.users (id, email) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a@t.test');
insert into public.users (id, tenant_id, email, role, status) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'a@t.test', 'admin', 'active');
insert into public.workspaces (id, tenant_id, slug, name) values
  ('99990000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'ws', 'WS');
insert into public.collections (id, tenant_id, workspace_id, slug, name, visibility) values
  ('cccc0000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', '99990000-0000-0000-0000-000000000001', 'col', 'Col', 'workspace_private');

-- contar audits previos
select is(
  (select count(*) from public.audit_log
   where resource_id = 'cccc0000-0000-0000-0000-000000000001'
     and action = 'collection.visibility_changed'),
  0::bigint, 'sin audits previos para esta collection');

-- cambio sin tocar visibility: NO debe disparar
update public.collections set name = 'Col2' where id = 'cccc0000-0000-0000-0000-000000000001';
select is(
  (select count(*) from public.audit_log
   where resource_id = 'cccc0000-0000-0000-0000-000000000001'
     and action = 'collection.visibility_changed'),
  0::bigint, 'cambio de nombre no dispara audit de visibility');

-- cambio de visibility: SI debe disparar
update public.collections set visibility = 'tenant_public'
where id = 'cccc0000-0000-0000-0000-000000000001';
select is(
  (select count(*) from public.audit_log
   where resource_id = 'cccc0000-0000-0000-0000-000000000001'
     and action = 'collection.visibility_changed'),
  1::bigint, 'cambio de visibility dispara audit');

-- membership change dispara audit
insert into public.workspace_memberships (workspace_id, tenant_id, principal_kind, principal_id, role)
values ('99990000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'user', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'workspace_admin');
select is(
  (select count(*) from public.audit_log
   where resource_id = '99990000-0000-0000-0000-000000000001'
     and action = 'workspace.membership_inserted'),
  1::bigint, 'membership insert dispara audit');

select * from finish();
rollback;
```

- [ ] **Step 2: Correr, verificar FALLA**

```bash
npm run test:db -- --file audit_triggers_tier1_test.sql
```

- [ ] **Step 3: Escribir migracion**

**Files:**
- Create: `supabase/migrations/20260522222000_audit_triggers_tier1.sql`

```sql
-- Audit triggers Tier 1 (Migracion 041)

create or replace function app.audit_collection_visibility_change()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if old.visibility is distinct from new.visibility then
    insert into public.audit_log (tenant_id, actor_id, action, resource_type, resource_id, metadata)
    values (new.tenant_id, auth.uid(), 'collection.visibility_changed',
            'collection', new.id,
            jsonb_build_object('from', old.visibility, 'to', new.visibility,
                               'workspace_id', new.workspace_id));
  end if;
  return new;
end;
$$;

drop trigger if exists audit_collection_visibility_change on public.collections;
create trigger audit_collection_visibility_change
after update of visibility on public.collections
for each row execute function app.audit_collection_visibility_change();

create or replace function app.audit_workspace_membership_change()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.audit_log (tenant_id, actor_id, action, resource_type, resource_id, metadata)
    values (new.tenant_id, auth.uid(), 'workspace.membership_inserted',
            'workspace_membership', new.workspace_id,
            jsonb_build_object('principal_kind', new.principal_kind,
                               'principal_id', new.principal_id,
                               'role', new.role));
  elsif tg_op = 'UPDATE' and old.role is distinct from new.role then
    insert into public.audit_log (tenant_id, actor_id, action, resource_type, resource_id, metadata)
    values (new.tenant_id, auth.uid(), 'workspace.membership_role_changed',
            'workspace_membership', new.workspace_id,
            jsonb_build_object('principal_kind', new.principal_kind,
                               'principal_id', new.principal_id,
                               'from_role', old.role, 'to_role', new.role));
  elsif tg_op = 'DELETE' then
    insert into public.audit_log (tenant_id, actor_id, action, resource_type, resource_id, metadata)
    values (old.tenant_id, auth.uid(), 'workspace.membership_deleted',
            'workspace_membership', old.workspace_id,
            jsonb_build_object('principal_kind', old.principal_kind,
                               'principal_id', old.principal_id,
                               'role', old.role));
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists audit_workspace_membership_change on public.workspace_memberships;
create trigger audit_workspace_membership_change
after insert or update or delete on public.workspace_memberships
for each row execute function app.audit_workspace_membership_change();

-- realtime publication: agregar tablas nuevas que la UI consume live
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and tablename = 'workspaces') then
      execute 'alter publication supabase_realtime add table public.workspaces';
    end if;
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and tablename = 'collections') then
      execute 'alter publication supabase_realtime add table public.collections';
    end if;
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and tablename = 'document_collections') then
      execute 'alter publication supabase_realtime add table public.document_collections';
    end if;
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and tablename = 'document_tags') then
      execute 'alter publication supabase_realtime add table public.document_tags';
    end if;
  end if;
end;
$$;
```

- [ ] **Step 4: Correr, verificar PASA**

```bash
npm run test:db -- --file audit_triggers_tier1_test.sql
```

- [ ] **Step 5: Suite completo**

```bash
npm run test:db
```

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260522222000_audit_triggers_tier1.sql \
        supabase/tests/audit_triggers_tier1_test.sql
git commit -m "feat(audit): triggers de collection visibility + workspace memberships + realtime publication (tier1 041)"
```

## Paso 18 · Regenerar types TypeScript

### Task 18.1: Regen + commit

**Files:**
- Modify: `lib/supabase/types.gen.ts`

- [ ] **Step 1: Regenerar types desde remoto/local linked**

```bash
npm run types:gen
```

Expected: `lib/supabase/types.gen.ts` actualizado. Diff debe incluir las 8 RPCs nuevas (`create_workspace`, `update_workspace`, ..., `tag_document`) y nuevas tablas en el namespace `Tables` (aunque siguen siendo genericas porque el codebase usa types broad por decision).

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: verde. Si alguna llamada a `supabase.rpc(...)` rompe por tipo, revisar el caller y ajustar a la nueva signature (ej. `create_document_upload` ahora requiere `_workspace_id`).

- [ ] **Step 3: Commit**

```bash
git add lib/supabase/types.gen.ts
git commit -m "chore(types): regen supabase types after tier1 migrations"
```

## Paso 19 · Docs nuevos (4 archivos)

### Task 19.1: `docs/backend/11-workspaces-collections-groups.md`

**Files:**
- Create: `docs/backend/11-workspaces-collections-groups.md`

- [ ] **Step 1: Escribir el doc**

Contenido obligatorio:
- Diagrama jerarquia `tenant -> workspaces -> collections -> documents`.
- Modelo de visibilidad: `workspace_private` vs `tenant_public`, derivacion de acceso (workspace home OR collection publica OR tenant admin).
- Rol `workspace_admin/editor/viewer` y precedencia con tenant_role.
- Como `groups` se asignan a workspaces via `workspace_memberships.principal_kind='group'`.
- Reglas: `documents.workspace_id` NOT NULL, lineage queda dentro del mismo workspace, mover doc requiere edit en source y destination.
- Gotcha: cambiar collection a `tenant_public` abre el contenido a todo el tenant — registrar audit + UI warning.

- [ ] **Step 2: Commit**

```bash
git add docs/backend/11-workspaces-collections-groups.md
git commit -m "docs(backend): workspaces+collections+groups model and visibility (tier1)"
```

### Task 19.2: `docs/backend/12-rls-patterns.md`

**Files:**
- Create: `docs/backend/12-rls-patterns.md`

- [ ] **Step 1: Escribir el doc**

Contenido obligatorio:
- Patron RLS canonico: policy `for select to authenticated using (tenant_id = (select app.current_tenant_id()) and ...)`.
- Catalogo de helpers `app.*` con signature + cuando usarlos:
  - `current_tenant_id()`, `current_workspace_id()`, `current_tenant_role()`, `is_tenant_admin()`.
  - `user_belongs_to_workspace(_workspace_id)`, `user_workspace_role(_workspace_id)`.
  - `user_can_read_document(_document_id)`, `user_can_edit_document(_document_id)`.
  - `can_access_conversation(_conversation_id)`.
- Como construir policy nueva: checklist + ejemplo end-to-end.
- Importante: `active_workspace_role` del JWT es solo hint UI; RLS re-verifica `workspace_memberships` siempre.
- Convention de tests pgTAP por policy (positivo + negativo + cross-tenant + deleted_at).

- [ ] **Step 2: Commit**

```bash
git add docs/backend/12-rls-patterns.md
git commit -m "docs(backend): RLS patterns catalog + helpers reference (tier1)"
```

### Task 19.3: `docs/backend/13-audit-log-conventions.md`

**Files:**
- Create: `docs/backend/13-audit-log-conventions.md`

- [ ] **Step 1: Escribir el doc**

Contenido obligatorio:
- Namespace de `action`: dot-separated, lowercase, ascii (`document.upload_created`, `workspace.member_added`, etc.). Listado canonico.
- Estructura de `metadata`: jsonb con claves estables por tipo de action.
- `_request_context` pattern: que pasa por el cliente (`request_id`, `session_id`, `ip`, `user_agent`, `workspace_id`) y como llega a la RPC.
- Helper `app.audit_with_context(_action, _resource_type, _resource_id, _payload, _request_context)`: signature, donde se almacena el merge.
- Triggers automaticos vs inserts via RPC: cuando uno, cuando otro.
- Retention: `audit_log` 2 anos por default (`cleanup_operational_data`).

- [ ] **Step 2: Commit**

```bash
git add docs/backend/13-audit-log-conventions.md
git commit -m "docs(backend): audit_log conventions + action namespace + request_context (tier1)"
```

### Task 19.4: `docs/backend/14-retention-and-cleanup.md`

**Files:**
- Create: `docs/backend/14-retention-and-cleanup.md`

- [ ] **Step 1: Escribir el doc**

Contenido obligatorio:
- Politica de retencion por tabla: `tenant_invites` revoked 90d, `indexing_events` 6m, `audit_log` 2y, soft-deletes 30d.
- `cleanup_operational_data` signature + cron schedule (`0 4 * * *` via pg_cron).
- Soft-delete pattern: cuales tablas (`documents`, `conversations`, `collections`, `workspaces`, `groups`, `tags`), regla RLS de excluirlas, hard-delete por cron.
- Como ajustar retention sin redeploy (parametros default vs runtime args).
- Pre-aviso: particionado de `audit_log`, `indexing_events`, `document_views`, `usage_records`, `notifications` viene en Tier 3.

- [ ] **Step 2: Commit**

```bash
git add docs/backend/14-retention-and-cleanup.md
git commit -m "docs(backend): retention policies + cleanup_operational_data + soft-delete (tier1)"
```

## Paso 20 · Docs actualizados (7 archivos)

### Task 20.1: `docs/arquitectura.md`

- [ ] **Step 1: Actualizar diagrama y seccion 3.2**

Cambios:
- En el diagrama (seccion 2): agregar capa `workspaces / collections / groups` entre `documents` y el tenant.
- En seccion 3.2 (Supabase): agregar tablas nuevas a la lista (`workspaces`, `workspace_memberships`, `groups`, `group_memberships`, `collections`, `document_collections`, `tags`, `document_tags`).
- Nota nueva: visibilidad por collection (`workspace_private` / `tenant_public`).
- En "Principios rectores": agregar "Workspaces como sub-divisiones del tenant; collections publicas como mecanismo de sharing controlado entre workspaces".

- [ ] **Step 2: Commit**

```bash
git add docs/arquitectura.md
git commit -m "docs(arquitectura): add workspaces/collections/groups layer (tier1)"
```

### Task 20.2: `docs/backend/01-mapa-del-backend.md`

- [ ] **Step 1: Agregar carpetas nuevas en lib**

Cambios:
- En la seccion "Carpetas clave", agregar dentro de `lib/`: `workspaces/`, `collections/`, `groups/`, `tags/` (placeholders para servicios TypeScript que envuelvan las RPCs en proximos releases).

- [ ] **Step 2: Commit**

```bash
git add docs/backend/01-mapa-del-backend.md
git commit -m "docs(backend): mapa actualizado con nuevas carpetas lib (tier1)"
```

### Task 20.3: `docs/backend/02-auth-tenants-rls.md`

- [ ] **Step 1: Redirect a 12-rls-patterns.md**

Cambios:
- Reemplazar contenido por: header + 2 secciones cortas (login/invitaciones/claims) + redirect a `12-rls-patterns.md` para todo lo de RLS y helpers.
- Quitar listado de tablas con RLS (esta ahora en 12).
- Mencionar `claims_version=2` y `active_workspace_id`.

- [ ] **Step 2: Commit**

```bash
git add docs/backend/02-auth-tenants-rls.md
git commit -m "docs(backend): auth doc redirige a rls-patterns + claims v2 (tier1)"
```

### Task 20.4: `docs/backend/03-documentos-storage-upload.md`

- [ ] **Step 1: Reflejar nueva signature de `create_document_upload`**

Cambios:
- En "Upload": el RPC ahora requiere `_workspace_id` y acepta `_collection_id` opcional.
- En "Modelo": agregar columnas `workspace_id`, `deleted_at`, `deleted_by`.
- Nueva seccion "Soft-delete y mover": referencia a `archive_document`, `restore_document`, `move_document`, `bulk_update_documents`.
- Actualizar diagrama de estados si aplica.

- [ ] **Step 2: Commit**

```bash
git add docs/backend/03-documentos-storage-upload.md
git commit -m "docs(backend): create_document_upload con workspace + soft-delete + move (tier1)"
```

### Task 20.5: `docs/backend/09-catalogo-api-rutas.md`

- [ ] **Step 1: Catalogar todas las RPCs nuevas**

Cambios:
- Nueva seccion "Workspaces RPCs" con las 8 RPCs.
- "Groups RPCs" con las 5.
- "Collections RPCs" con las 6.
- "Tags RPCs" con las 4.
- "Documents extendidas" con `archive/restore/move/bulk`.
- "Helpers" mencionar `set_active_workspace`.

- [ ] **Step 2: Commit**

```bash
git add docs/backend/09-catalogo-api-rutas.md
git commit -m "docs(backend): catalogo de RPCs Tier 1 (workspaces/groups/collections/tags)"
```

### Task 20.6: `docs/backend/10-supabase-realtime.md`

- [ ] **Step 1: Agregar tablas publicadas**

Cambios:
- En "Superficie actual / Postgres Changes": agregar `workspaces`, `collections`, `document_collections`, `document_tags`.

- [ ] **Step 2: Commit**

```bash
git add docs/backend/10-supabase-realtime.md
git commit -m "docs(realtime): nuevas tablas publicadas (tier1)"
```

### Task 20.7: `docs/README.md`

- [ ] **Step 1: Linkear los 4 docs nuevos**

Cambios:
- En "Documentos transversales" o "Separacion por area", linkear los 4 nuevos `11-`, `12-`, `13-`, `14-`.

- [ ] **Step 2: Commit**

```bash
git add docs/README.md
git commit -m "docs: indice actualizado con docs Tier 1"
```

## Paso 21 · CHANGELOG

### Task 21.1: Entrada Tier 1

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Agregar entrada al tope**

```markdown
## [0.2.0] - 2026-05-22 (Tier 1 Foundation)

### Added
- Jerarquia `tenant -> workspaces -> collections` con visibility `workspace_private` / `tenant_public`.
- Groups a nivel tenant con membership directa o via group en `workspace_memberships`.
- Tags y `document_tags` para taxonomia transversal por tenant.
- Soft-delete pattern (`deleted_at` + retention 30d via `cleanup_operational_data`).
- RLS helpers `app.user_can_read_document`, `app.user_can_edit_document`, `app.user_workspace_role`, `app.user_belongs_to_workspace`, `app.audit_with_context`.
- JWT `claims_version=2` con `active_workspace_id` y `active_workspace_role` como hints de UI.
- RPCs CRUD: workspaces (8), groups (5), collections (6), tags (4).
- RPCs documents extendidas: `archive_document`, `restore_document`, `move_document`, `bulk_update_documents`. `create_document_upload` ahora requiere `_workspace_id`.
- Triggers audit `collection.visibility_changed` y `workspace.membership_*`.
- Realtime publication para `workspaces`, `collections`, `document_collections`, `document_tags`.

### Changed
- Documentos legacy migrados a workspace `Default` por tenant (backfill no destructivo).
- Tests `documents_upload_flow_test.sql` actualizado para pasar `_workspace_id`.

### Internal
- 12 nuevas migraciones SQL + 12 nuevos tests pgTAP.
- 4 docs nuevos: 11-workspaces..., 12-rls-patterns, 13-audit-log-conventions, 14-retention-and-cleanup.
- 7 docs actualizados.
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): Tier 1 Foundation entrada 0.2.0"
```

---

## Estados de salida Tier 1

Antes de declarar Tier 1 done y arrancar Tier 2, verificar:

```bash
npm run lint                          # verde
npm run typecheck                     # verde
npm run test:db                       # todos los tests pgTAP verdes
npm run test:cli                      # verde
npm run indexing:health               # verde
npm run secrets:scan                  # sin findings
npm run env:doctor                    # OK
```

Operacion:
- `supabase db push` aplicado contra remoto sin errores.
- Para cada tenant existente: workspace `Default` creado, todos los users active del tenant son miembros (con role mapeado), todos los `documents` tienen `workspace_id` no nulo.
- En la UI: switcher de workspace funcional (boton + dropdown + refresh JWT al cambiar).
- Smoke en staging: subir un PDF nuevo eligiendo workspace+collection, ver que aparece, archivar, restaurar, mover a otro workspace.
- Audit log: cada accion arriba dejo entrada con `_request_context` enriquecido (`request_id`, `session_id`, `ip`, `user_agent`).

Operacion no exitosa = no avanzar a Tier 2. Documentar findings en `docs/gotchas.md` y re-correr migraciones que correspondan.

---

## Self-review

### Cobertura del scope

| Capacidad del scope | Paso/Task que la implementa |
|---|---|
| `workspaces` + `workspace_memberships` | Paso 1 |
| `groups` + `group_memberships` | Paso 2 |
| Polymorphic FK validator | Paso 3 |
| RLS baseline workspaces/groups | Paso 4 |
| `documents.workspace_id` nullable | Paso 5 |
| Backfill workspace Default | Paso 6 |
| `documents.workspace_id` NOT NULL | Paso 7 |
| `collections` + `document_collections` + `tags` + `document_tags` | Paso 8 |
| RLS helpers + `audit_with_context` | Paso 9 |
| JWT hook v2 | Paso 10 |
| Soft-delete columnas + `cleanup_operational_data` extendido | Paso 11 |
| RLS policy revisada `documents_select_visible` | Paso 12 |
| RPCs Workspaces CRUD + memberships + `set_active_workspace` | Paso 13 |
| RPCs Groups | Paso 14 |
| RPCs Collections + Tags | Paso 15 |
| `create_document_upload` mutado + `archive_document` + `restore_document` + `move_document` + `bulk_update_documents` | Paso 16 |
| Triggers audit `collection.visibility_changed` + `workspace.membership_*` + realtime publication | Paso 17 |
| Types regen | Paso 18 |
| Docs nuevos: `11-workspaces...`, `12-rls-patterns`, `13-audit-log`, `14-retention` | Paso 19 |
| Docs actualizados: `arquitectura`, `01-mapa`, `02-auth`, `03-docs-storage`, `09-catalogo`, `10-realtime`, `README` | Paso 20 |
| CHANGELOG | Paso 21 |

### Placeholders

No quedan `TBD` / `TODO` / "similar a" sin codigo.

### Consistency

- `workspace_role` enum: declarado en Paso 1 como `viewer < editor < admin` (orden importante para `max(role)` via `order by desc limit 1` en Paso 9).
- `principal_kind` enum: declarado en Paso 1, usado en Pasos 1, 13, 14, 17.
- `collection_visibility` enum: declarado en Paso 8, usado en Pasos 8, 15.
- `app.audit_with_context` signature: definida en Paso 9 (5 args), llamada igual en Pasos 13, 14, 15, 16, 17.
- `app.user_workspace_role` signature: definida en Paso 9 (1 arg `_workspace_id`), llamada igual en Pasos 13, 14, 15, 16.
- `app.user_can_read_document` y `app.user_can_edit_document`: definidos en Paso 9, llamados en Pasos 12, 15, 16.

### Observaciones del code review previo (del spec)

- Audit context enforcement: cubierto por uso obligatorio de `app.audit_with_context` en todas las RPCs nuevas (Pasos 13-17).
- Polymorphic FK validator: cubierto en Paso 3.
- Group tenant consistency: `group_memberships.tenant_id` es NOT NULL y consistente con `groups.tenant_id` via trigger validator del Paso 3 (extendido al insert de group_memberships si hace falta — verificar en el test del Paso 3 y agregar branch al validator).
- Backfill explicit a/b/c: cubierto en Pasos 5, 6, 7.
- archived vs deleted distinction: cubierto en `documents_soft_delete_test.sql` y en doc `14-retention-and-cleanup.md`.
- `data_exports.scope_workspace_id` FK composite: no aplica a Tier 1 (es Tier 3).
- `enable row level security` per tabla: cubierto en Paso 4 + en cada migracion que crea tabla nueva.

---

## Execution Handoff

Plan completo y listo para ejecutar. Dos modos de ejecucion:

**1. Subagent-driven (recomendado para Tier 1):**
- Usar `superpowers:subagent-driven-development`.
- Fresh subagent por Task, review entre tasks.
- Mejor cuando hay muchas migraciones independientes y un error en una no debe corromper el resto.

**2. Inline execution:**
- Usar `superpowers:executing-plans` en esta misma sesion.
- Batch con checkpoints cada 3-4 tasks.
- Mejor si queres mantener contexto y ejecutar en paralelo a discusiones.

**Pre-execution checks:**
- Branch limpio (sin cambios uncommitteados que puedan interferir).
- `supabase` CLI logueado y linked al proyecto correcto.
- Acceso SSH a `srv-ia-01` no es necesario para Tier 1 (sin tocar workers).
- `npm install` actualizado (no se agregan deps nuevas en Tier 1).

Cuando Tier 1 este merged a `main`, los tests verdes y el smoke en staging OK, arrancar:
- Brainstorm corto + plan TDD detallado para Tier 2 (multipliers) usando `docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier2-multipliers.md` como skeleton.


