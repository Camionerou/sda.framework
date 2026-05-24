begin;
select plan(15);

-- ---------------------------------------------------------------------------
-- Setup minimal: tenant + owner + member.
-- 'aaaa..' es tenant owner (admin), 'bbbb..' es member (no admin).
-- Se siguen patrones existentes para auth.users (instance_id/aud/role
-- requeridos por la tabla en local).
-- ---------------------------------------------------------------------------
insert into public.tenants (id, slug, name) values
  ('11111111-1111-1111-1111-111111111111'::uuid, 'ws-rpc', 'WS RPC Tenant');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'owner@ws-rpc.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid,
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'member@ws-rpc.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.users (id, tenant_id, email, role, status) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '11111111-1111-1111-1111-111111111111', 'owner@ws-rpc.test', 'owner', 'active'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   '11111111-1111-1111-1111-111111111111', 'member@ws-rpc.test', 'member', 'active');

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

select throws_ok(
  $$ select public.create_workspace('Legal', 'legal'); $$,
  'P0001',
  'Only tenant admins can create workspaces',
  'member no puede crear workspaces (regex match sobre mensaje admin)'
);

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

-- La policy workspaces_select_member oculta rows con deleted_at is not null,
-- asi que volvemos a postgres para verificar el soft-delete sin pasar por RLS.
reset role;

select isnt(
  (select deleted_at from public.workspaces where slug = 'finanzas'),
  null,
  'workspace soft-deleted (deleted_at no null)');

select * from finish();
rollback;
