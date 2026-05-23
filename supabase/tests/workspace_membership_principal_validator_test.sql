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

-- 6: principal_kind='user' apuntando a user de otro tenant tambien se rechaza
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
