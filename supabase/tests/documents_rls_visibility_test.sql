begin;
select plan(12);

-- ---------------------------------------------------------------------------
-- Setup: 2 tenants con workspace propio, 1 user miembro por tenant,
-- 1 documento por tenant ya indexado.
-- ---------------------------------------------------------------------------
insert into public.tenants (id, slug, name) values
  ('11111111-1111-1111-1111-111111111111'::uuid, 'rls-a', 'Tenant A'),
  ('22222222-2222-2222-2222-222222222222'::uuid, 'rls-b', 'Tenant B');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'alice@rls-a.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid,
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'bob@rls-b.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.users (id, tenant_id, email, role, status) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '11111111-1111-1111-1111-111111111111', 'alice@rls-a.test', 'member', 'active'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   '22222222-2222-2222-2222-222222222222', 'bob@rls-b.test',   'member', 'active');

insert into public.workspaces (id, tenant_id, slug, name) values
  ('aaaa1111-0000-0000-0000-000000000000'::uuid,
   '11111111-1111-1111-1111-111111111111', 'ws-a', 'Workspace A'),
  ('bbbb2222-0000-0000-0000-000000000000'::uuid,
   '22222222-2222-2222-2222-222222222222', 'ws-b', 'Workspace B');

insert into public.workspace_memberships
  (workspace_id, tenant_id, principal_kind, principal_id, role) values
  ('aaaa1111-0000-0000-0000-000000000000',
   '11111111-1111-1111-1111-111111111111',
   'user', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'workspace_editor'),
  ('bbbb2222-0000-0000-0000-000000000000',
   '22222222-2222-2222-2222-222222222222',
   'user', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'workspace_editor');

insert into public.documents
  (id, tenant_id, workspace_id, created_by, filename, r2_key, status, uploaded_at)
values
  ('d0000001-0000-0000-0000-000000000001'::uuid,
   '11111111-1111-1111-1111-111111111111',
   'aaaa1111-0000-0000-0000-000000000000',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'a.pdf',
   '11111111-1111-1111-1111-111111111111/d0000001-0000-0000-0000-000000000001/a.pdf',
   'indexed', now()),
  ('d0000002-0000-0000-0000-000000000002'::uuid,
   '22222222-2222-2222-2222-222222222222',
   'bbbb2222-0000-0000-0000-000000000000',
   'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   'b.pdf',
   '22222222-2222-2222-2222-222222222222/d0000002-0000-0000-0000-000000000002/b.pdf',
   'indexed', now());

-- ---------------------------------------------------------------------------
-- Caso 1: alice en su tenant ve su documento; no ve el del otro tenant.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'role', 'authenticated',
  'tenant_id', '11111111-1111-1111-1111-111111111111',
  'tenant_role', 'member',
  'active_workspace_id', 'aaaa1111-0000-0000-0000-000000000000'
)::text, true);

select is(
  (select count(*) from public.documents
    where id = 'd0000001-0000-0000-0000-000000000001'),
  1::bigint,
  'Alice ve su documento en su workspace home');

select is(
  (select count(*) from public.documents
    where id = 'd0000002-0000-0000-0000-000000000002'),
  0::bigint,
  'Alice NO ve documento de Tenant B (RLS por tenant_id bloquea)');

-- ---------------------------------------------------------------------------
-- Caso 2: bob en Tenant B ve su documento.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'role', 'authenticated',
  'tenant_id', '22222222-2222-2222-2222-222222222222',
  'tenant_role', 'member',
  'active_workspace_id', 'bbbb2222-0000-0000-0000-000000000000'
)::text, true);

select is(
  (select count(*) from public.documents
    where id = 'd0000002-0000-0000-0000-000000000002'),
  1::bigint,
  'Bob ve documento en su workspace home');

-- ---------------------------------------------------------------------------
-- Caso 3: documento soft-deleted no aparece (filtramos deleted_at).
-- ---------------------------------------------------------------------------
reset role;
update public.documents
  set deleted_at = now(),
      deleted_by = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  where id = 'd0000002-0000-0000-0000-000000000002';

set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'role', 'authenticated',
  'tenant_id', '22222222-2222-2222-2222-222222222222',
  'tenant_role', 'member',
  'active_workspace_id', 'bbbb2222-0000-0000-0000-000000000000'
)::text, true);

select is(
  (select count(*) from public.documents
    where id = 'd0000002-0000-0000-0000-000000000002'),
  0::bigint,
  'Documento soft-deleted no aparece via SELECT');

-- ---------------------------------------------------------------------------
-- Caso 4: collection tenant_public da acceso cross-workspace dentro del tenant.
-- ---------------------------------------------------------------------------
reset role;
insert into public.collections
  (id, tenant_id, workspace_id, slug, name, visibility) values
  ('c0000001-0000-0000-0000-000000000001'::uuid,
   '11111111-1111-1111-1111-111111111111',
   'aaaa1111-0000-0000-0000-000000000000',
   'public-pol', 'Politicas publicas', 'tenant_public');

-- carlos: segundo user en Tenant A, sin membership al workspace A
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid,
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'carlos@rls-a.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
insert into public.users (id, tenant_id, email, role, status) values
  ('cccccccc-cccc-cccc-cccc-cccccccccccc',
   '11111111-1111-1111-1111-111111111111', 'carlos@rls-a.test', 'member', 'active');

set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  'role', 'authenticated',
  'tenant_id', '11111111-1111-1111-1111-111111111111',
  'tenant_role', 'member',
  'active_workspace_id', null
)::text, true);

select is(
  (select count(*) from public.documents
    where id = 'd0000001-0000-0000-0000-000000000001'),
  0::bigint,
  'Carlos NO ve doc de workspace A donde no es miembro');

reset role;
insert into public.document_collections
  (tenant_id, document_id, collection_id) values
  ('11111111-1111-1111-1111-111111111111',
   'd0000001-0000-0000-0000-000000000001',
   'c0000001-0000-0000-0000-000000000001');

set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  'role', 'authenticated',
  'tenant_id', '11111111-1111-1111-1111-111111111111',
  'tenant_role', 'member',
  'active_workspace_id', null
)::text, true);

select is(
  (select count(*) from public.documents
    where id = 'd0000001-0000-0000-0000-000000000001'),
  1::bigint,
  'Carlos AHORA ve doc via collection tenant_public');

-- ---------------------------------------------------------------------------
-- Caso 5: cambiar visibility a workspace_private revierte el acceso.
-- ---------------------------------------------------------------------------
reset role;
update public.collections
  set visibility = 'workspace_private'
  where id = 'c0000001-0000-0000-0000-000000000001';

set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  'role', 'authenticated',
  'tenant_id', '11111111-1111-1111-1111-111111111111',
  'tenant_role', 'member',
  'active_workspace_id', null
)::text, true);

select is(
  (select count(*) from public.documents
    where id = 'd0000001-0000-0000-0000-000000000001'),
  0::bigint,
  'Carlos pierde acceso al revertir collection a workspace_private');

-- ---------------------------------------------------------------------------
-- Caso 6: tenant admin ve todo dentro de su tenant, sin membership ni collection.
-- ---------------------------------------------------------------------------
reset role;
update public.users
  set role = 'admin'
  where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  'role', 'authenticated',
  'tenant_id', '11111111-1111-1111-1111-111111111111',
  'tenant_role', 'admin',
  'active_workspace_id', null
)::text, true);

select is(
  (select count(*) from public.documents
    where id = 'd0000001-0000-0000-0000-000000000001'),
  1::bigint,
  'Tenant admin ve doc independiente de workspace membership');

-- ---------------------------------------------------------------------------
-- Boundary cruzado: admin de Tenant A no ve recursos de Tenant B.
-- Cubrimos workspaces, collections, groups, tags (policies tenant_id baseline).
-- ---------------------------------------------------------------------------
reset role;
insert into public.groups (id, tenant_id, key, name) values
  ('99999999-0000-0000-0000-000000000001'::uuid,
   '22222222-2222-2222-2222-222222222222', 'b-team', 'Team B');

insert into public.collections
  (id, tenant_id, workspace_id, slug, name, visibility) values
  ('99999999-0000-0000-0000-000000000002'::uuid,
   '22222222-2222-2222-2222-222222222222',
   'bbbb2222-0000-0000-0000-000000000000',
   'team-b-coll', 'Coleccion B', 'workspace_private');

insert into public.tags (id, tenant_id, key, label) values
  ('99999999-0000-0000-0000-000000000003'::uuid,
   '22222222-2222-2222-2222-222222222222', 'b-tag', 'Tag B');

set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  'role', 'authenticated',
  'tenant_id', '11111111-1111-1111-1111-111111111111',
  'tenant_role', 'admin',
  'active_workspace_id', null
)::text, true);

select is(
  (select count(*) from public.workspaces
    where tenant_id = '22222222-2222-2222-2222-222222222222'),
  0::bigint,
  'admin de Tenant A NO ve workspaces de Tenant B');

select is(
  (select count(*) from public.collections
    where tenant_id = '22222222-2222-2222-2222-222222222222'),
  0::bigint,
  'admin de Tenant A NO ve collections de Tenant B');

select is(
  (select count(*) from public.groups
    where tenant_id = '22222222-2222-2222-2222-222222222222'),
  0::bigint,
  'admin de Tenant A NO ve groups de Tenant B');

select is(
  (select count(*) from public.tags
    where tenant_id = '22222222-2222-2222-2222-222222222222'),
  0::bigint,
  'admin de Tenant A NO ve tags de Tenant B');

select * from finish();
rollback;
