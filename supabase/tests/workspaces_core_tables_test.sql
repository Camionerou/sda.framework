BEGIN;
SELECT plan(15);

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
    SELECT enumlabel::text
    FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'workspace_role'
    ORDER BY e.enumsortorder
  ),
  ARRAY['workspace_viewer','workspace_editor','workspace_admin']::text[],
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
    SELECT enumlabel::text
    FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'principal_kind'
    ORDER BY e.enumsortorder
  ),
  ARRAY['user','group']::text[],
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
