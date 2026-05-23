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
