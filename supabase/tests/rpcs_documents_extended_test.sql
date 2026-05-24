begin;
select plan(10);

-- ---------------------------------------------------------------------------
-- Setup: tenant + admin + 2 workspaces + user editor en ambos.
-- auth.users requiere los campos completos (instance_id, aud, role, ...) en
-- entorno local Supabase. Sigue patron de rpcs_collections_tags_test.sql.
-- ---------------------------------------------------------------------------
insert into public.tenants (id, slug, name) values
  ('11111111-1111-1111-1111-111111111111', 'd-rpc', 'D');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'u@d.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

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

-- 2. archive_document (soft-delete). Capturamos el id antes porque tras
-- archive el documento desaparece del SELECT (RLS filtra deleted_at).
create temporary table doc_id on commit drop as
  select id from public.documents where filename = 'a.pdf';

select lives_ok($$
  select public.archive_document((select id from doc_id));
$$, 'archive_document');

-- bypass RLS para validar el soft-delete (la policy filtra deleted_at).
reset role;
select isnt(
  (select deleted_at from public.documents where id = (select id from doc_id)),
  null, 'documento soft-deleted');
set local role authenticated;

-- 3. restore_document
select lives_ok($$
  select public.restore_document((select id from doc_id));
$$, 'restore_document');

select is(
  (select deleted_at from public.documents where id = (select id from doc_id)),
  null, 'documento restaurado');

-- 4. move_document a workspace B
select lives_ok($$
  select public.move_document(
    (select id from doc_id),
    '22220000-0000-0000-0000-000000000002'::uuid
  );
$$, 'move_document');

select is(
  (select workspace_id from public.documents where id = (select id from doc_id)),
  '22220000-0000-0000-0000-000000000002'::uuid,
  'workspace_id actualizado');

-- 5. bulk_update_documents
select lives_ok($$
  select public.bulk_update_documents(
    array[(select id from doc_id)]::uuid[],
    jsonb_build_object('title', 'Documento A renombrado')
  );
$$, 'bulk_update_documents');

select is(
  (select title from public.documents where id = (select id from doc_id)),
  'Documento A renombrado',
  'titulo actualizado por bulk');

select * from finish();
rollback;
