begin;
select plan(8);

-- ---------------------------------------------------------------------------
-- Setup: tenant + admin + member.
-- Sigue el patron de rpcs_workspaces_test.sql para auth.users (campos
-- requeridos en local: instance_id/aud/role/email_confirmed_at/...).
-- ---------------------------------------------------------------------------
insert into public.tenants (id, slug, name) values
  ('11111111-1111-1111-1111-111111111111'::uuid, 'g-rpc', 'Groups RPC');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'admin@g.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid,
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'm@g.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.users (id, tenant_id, email, role, status) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '11111111-1111-1111-1111-111111111111', 'admin@g.test', 'admin', 'active'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   '11111111-1111-1111-1111-111111111111', 'm@g.test', 'member', 'active');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object(
  'sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'tenant_id', '11111111-1111-1111-1111-111111111111',
  'tenant_role', 'admin'
)::text, true);

-- 1. create_group por admin
select lives_ok($$
  select public.create_group('legal', 'Legal team', 'Equipo legal');
$$, 'create_group admin');

-- 2. grupo persistido
select is(
  (select count(*) from public.groups
   where key = 'legal'
     and tenant_id = '11111111-1111-1111-1111-111111111111'),
  1::bigint,
  'grupo creado');

-- 3. add_group_member
select lives_ok($$
  select public.add_group_member(
    (select id from public.groups where key = 'legal'),
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  );
$$, 'add_group_member');

-- 4. membership persistida
select is(
  (select count(*) from public.group_memberships
   where user_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  1::bigint,
  'membership creada');

-- 5. remove_group_member
select lives_ok($$
  select public.remove_group_member(
    (select id from public.groups where key = 'legal'),
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  );
$$, 'remove_group_member');

-- 6. update_group
select lives_ok($$
  select public.update_group(
    (select id from public.groups where key = 'legal'),
    jsonb_build_object('name', 'Legal & Compliance')
  );
$$, 'update_group');

-- 7. archive_group
select lives_ok($$
  select public.archive_group(
    (select id from public.groups where key = 'legal')
  );
$$, 'archive_group');

-- 8. member no puede crear group (throws_ok 4-args con SQLSTATE)
select set_config('request.jwt.claims', json_build_object(
  'sub', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'tenant_id', '11111111-1111-1111-1111-111111111111',
  'tenant_role', 'member'
)::text, true);

select throws_ok(
  $$ select public.create_group('finanzas', 'Finanzas'); $$,
  'P0001',
  'Only tenant admins can create groups',
  'member no crea group'
);

select * from finish();
rollback;
