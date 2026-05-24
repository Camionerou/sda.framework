begin;
select plan(10);

-- ---------------------------------------------------------------------------
-- Setup: tenant + admin + workspace + workspace_membership + document.
-- auth.users requiere los campos completos (instance_id, aud, role, ...) en
-- entorno local Supabase. Sigue patron de rpcs_groups_test.sql.
-- ---------------------------------------------------------------------------
insert into public.tenants (id, slug, name) values
  ('11111111-1111-1111-1111-111111111111'::uuid, 'ct-rpc', 'Collections+Tags');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'admin@ct.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.users (id, tenant_id, email, role, status) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '11111111-1111-1111-1111-111111111111', 'admin@ct.test', 'admin', 'active');

insert into public.workspaces (id, tenant_id, slug, name) values
  ('aaaa1111-0000-0000-0000-000000000000',
   '11111111-1111-1111-1111-111111111111', 'ws', 'WS');

insert into public.workspace_memberships
  (workspace_id, tenant_id, principal_kind, principal_id, role) values
  ('aaaa1111-0000-0000-0000-000000000000',
   '11111111-1111-1111-1111-111111111111',
   'user', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'workspace_admin');

insert into public.documents
  (id, tenant_id, workspace_id, created_by, filename, r2_key, status, uploaded_at)
  values
  ('d0000001-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111',
   'aaaa1111-0000-0000-0000-000000000000',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'doc.pdf',
   '11111111-1111-1111-1111-111111111111/d0000001-0000-0000-0000-000000000001/doc.pdf',
   'indexed', now());

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
