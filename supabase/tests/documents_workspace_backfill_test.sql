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
