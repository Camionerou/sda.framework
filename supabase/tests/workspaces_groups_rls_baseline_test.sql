BEGIN;
SELECT plan(14);

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

-- Beta (member) necesita membership explicita para que las nuevas policies
-- (workspaces_select_member / workspace_memberships_select_member /
-- group_memberships_select_own_or_admin) la dejen ver beta-ws y group_memberships.
-- El trigger ensure_default_workspace_for_tenant solo crea el workspace; no
-- agrega memberships. Agregamos beta a beta-ws y al Default de beta tenant.
insert into public.workspace_memberships
  (workspace_id, tenant_id, principal_kind, principal_id, role)
values
  ('00000000-0000-0000-0000-000000003222',
   '00000000-0000-0000-0000-000000003202',
   'user', '00000000-0000-0000-0000-000000003212',
   'workspace_editor');

insert into public.workspace_memberships
  (workspace_id, tenant_id, principal_kind, principal_id, role)
select w.id, w.tenant_id, 'user', '00000000-0000-0000-0000-000000003212',
  'workspace_editor'
from public.workspaces w
where w.tenant_id = '00000000-0000-0000-0000-000000003202'
  and w.slug = 'default';

insert into public.group_memberships (group_id, user_id, tenant_id)
values ('00000000-0000-0000-0000-000000003232',
  '00000000-0000-0000-0000-000000003212',
  '00000000-0000-0000-0000-000000003202');

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

-- Tras 031.b: cada tenant tiene auto-creado un workspace Default
-- via trigger ensure_default_workspace_for_tenant. RLS sigue acotando por tenant.
SELECT is(
  (select count(*)::integer from public.workspaces),
  2,
  'alpha admin sees only alpha workspaces (default + alpha-ws)'
);
SELECT is(
  (select count(*)::integer from public.workspaces where slug = 'alpha-ws'),
  1,
  'alpha admin sees alpha-ws'
);
SELECT is(
  (select count(*)::integer from public.workspaces where slug = 'default'),
  1,
  'alpha admin sees auto-created Default workspace'
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
  2,
  'beta member sees only beta workspaces (default + beta-ws)'
);
SELECT is(
  (select count(*)::integer from public.workspaces where slug = 'beta-ws'),
  1,
  'beta member sees beta-ws'
);
SELECT is(
  (select count(*)::integer from public.workspaces where slug = 'default'),
  1,
  'beta member sees auto-created Default workspace'
);
SELECT is(
  (select count(*)::integer from public.groups),
  1,
  'beta member sees only beta group'
);
SELECT is(
  (select count(*)::integer from public.workspace_memberships),
  2,
  'beta member sees own memberships (beta-ws + default)'
);
SELECT is(
  (select count(*)::integer from public.group_memberships),
  1,
  'beta member sees own group_memberships row (beta in beta-grp)'
);

reset role;
SELECT * FROM finish();
ROLLBACK;
