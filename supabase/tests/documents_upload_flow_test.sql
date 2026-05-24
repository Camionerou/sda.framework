BEGIN;
SELECT plan(20);

insert into public.tenants (id, slug, name)
values
  ('00000000-0000-0000-0000-000000000701', 'docs-alpha', 'Docs Alpha'),
  ('00000000-0000-0000-0000-000000000702', 'docs-beta', 'Docs Beta');

insert into auth.users (
  id,
  instance_id,
  aud,
  role,
  email,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000801',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'owner@docs-alpha.test',
    now(),
    '{"provider":"google","providers":["google"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000802',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'member@docs-beta.test',
    now(),
    '{"provider":"google","providers":["google"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

insert into public.users (id, tenant_id, email, display_name, role, status)
values
  (
    '00000000-0000-0000-0000-000000000801',
    '00000000-0000-0000-0000-000000000701',
    'owner@docs-alpha.test',
    'Docs Alpha Owner',
    'owner',
    'active'
  ),
  (
    '00000000-0000-0000-0000-000000000802',
    '00000000-0000-0000-0000-000000000702',
    'member@docs-beta.test',
    'Docs Beta Member',
    'member',
    'active'
  );

create temporary table test_errors (
  label text primary key,
  message text not null
) on commit drop;

grant all on test_errors to authenticated;

SELECT ok(
  exists (
    select 1
    from storage.buckets
    where id = 'documents'
      and public = false
  ),
  'Private documents storage bucket exists'
);

SELECT is(
  (
    select file_size_limit
    from storage.buckets
    where id = 'documents'
  ),
  5368709120::bigint,
  'Documents storage bucket allows files up to 5 GiB'
);

SELECT ok(
  (
    select allowed_mime_types @> array[
      'application/pdf',
      'application/json',
      'image/jpeg',
      'text/markdown'
    ]
    from storage.buckets
    where id = 'documents'
  ),
  'Documents storage bucket allows original PDFs and extraction artifacts'
);

SELECT ok(
  not has_function_privilege(
    'anon',
    'public.create_document_upload(text, uuid, text, bigint, text, jsonb, text, uuid, jsonb)',
    'execute'
  ),
  'Anon clients cannot create document uploads'
);

SELECT ok(
  not has_function_privilege(
    'anon',
    'public.mark_document_upload_failed(uuid, text)',
    'execute'
  ),
  'Anon clients cannot mark document uploads failed'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',
    '00000000-0000-0000-0000-000000000801',
    'email',
    'owner@docs-alpha.test',
    'role',
    'authenticated',
    'tenant_id',
    '00000000-0000-0000-0000-000000000701',
    'tenant_role',
    'owner'
  )::text,
  true
);

set local role authenticated;

SELECT throws_ok(
  $$
    insert into public.documents (
      tenant_id,
      created_by,
      filename,
      mime_type,
      r2_bucket,
      r2_key,
      status
    )
    values (
      '00000000-0000-0000-0000-000000000701',
      '00000000-0000-0000-0000-000000000801',
      'Direct Insert.pdf',
      'application/pdf',
      'documents',
      '00000000-0000-0000-0000-000000000701/direct-insert.pdf',
      'uploaded'
    )
  $$,
  '42501',
  null,
  'Authenticated clients cannot insert documents directly'
);

create temporary table created_document on commit drop as
select *
from public.create_document_upload(
  _filename => 'Quarterly Report Final.PDF',
  _workspace_id => (
    select id from public.workspaces
    where tenant_id = '00000000-0000-0000-0000-000000000701'
      and slug = 'default'
  ),
  _mime_type => 'application/pdf',
  _byte_size => 1234,
  _title => 'Quarterly Report',
  _metadata => '{"source":"pgtap"}'::jsonb,
  _checksum_sha256 => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
);

SELECT is(
  (select status::text from created_document),
  'uploading',
  'Creating document upload starts in uploading status'
);

SELECT ok(
  not (select deduped from created_document),
  'First upload creation is not deduped'
);

SELECT ok(
  (
    select r2_key ~ ('^00000000-0000-0000-0000-000000000701/' || document_id::text || '/quarterly-report-final.pdf$')
    from created_document
  ),
  'Document storage key is tenant-scoped and filename-safe'
);

SELECT is(
  (
    select concat_ws(':', d.storage_bucket, d.storage_path)
    from public.documents d
    join created_document cd on cd.document_id = d.id
  ),
  (
    select concat_ws(':', r2_bucket, r2_key)
    from created_document
  ),
  'Canonical storage aliases mirror legacy r2 columns'
);

SELECT throws_ok(
  $$
    update public.documents
    set status = 'indexed'
    where id = (select document_id from created_document)
  $$,
  '42501',
  null,
  'Authenticated clients cannot update documents directly'
);

insert into storage.objects (bucket_id, name, owner, metadata)
select r2_bucket, r2_key, auth.uid(), '{"size":1234}'::jsonb
from created_document;

SELECT is(
  (
    select count(*)::integer
    from storage.objects so
    join created_document cd on cd.r2_key = so.name
    where so.bucket_id = 'documents'
  ),
  1,
  'Authenticated tenant user can upload to own tenant storage prefix'
);

create temporary table marked_document on commit drop as
select *
from public.mark_document_uploaded(
  (select document_id from created_document),
  2048,
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
);

SELECT is(
  (select status::text from marked_document),
  'uploaded',
  'Marking uploaded updates document status'
);

SELECT is(
  (
    select concat_ws(':', d.status::text, d.byte_size::text, (d.uploaded_at is not null)::text, d.checksum_sha256)
    from public.documents d
    join created_document cd on cd.document_id = d.id
  ),
  'uploaded:2048:true:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'Document row stores uploaded status, byte_size, timestamp, and checksum'
);

create temporary table duplicate_document on commit drop as
select *
from public.create_document_upload(
  _filename => 'Quarterly Report Final Copy.PDF',
  _workspace_id => (
    select id from public.workspaces
    where tenant_id = '00000000-0000-0000-0000-000000000701'
      and slug = 'default'
  ),
  _mime_type => 'application/pdf',
  _byte_size => 2048,
  _title => 'Quarterly Report Copy',
  _metadata => '{"source":"pgtap"}'::jsonb,
  _checksum_sha256 => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
);

SELECT is(
  (select document_id from duplicate_document),
  (select document_id from created_document),
  'Duplicate checksum returns existing uploaded document'
);

SELECT ok(
  (select deduped from duplicate_document),
  'Duplicate checksum is marked as deduped'
);

create temporary table failed_upload on commit drop as
select *
from public.create_document_upload(
  _filename => 'Broken Upload.PDF',
  _workspace_id => (
    select id from public.workspaces
    where tenant_id = '00000000-0000-0000-0000-000000000701'
      and slug = 'default'
  ),
  _mime_type => 'application/pdf',
  _byte_size => 2048,
  _title => 'Broken Upload',
  _metadata => '{"source":"pgtap"}'::jsonb,
  _checksum_sha256 => 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
);

create temporary table marked_failed_upload on commit drop as
select *
from public.mark_document_upload_failed(
  (select document_id from failed_upload),
  'Storage rejected the upload'
);

SELECT is(
  (select status::text from marked_failed_upload),
  'failed',
  'Uploading document can be marked failed'
);

SELECT is(
  (
    select status_reason
    from public.documents d
    join failed_upload fu on fu.document_id = d.id
  ),
  'Storage rejected the upload',
  'Failed upload stores a visible status reason'
);

reset role;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',
    '00000000-0000-0000-0000-000000000802',
    'email',
    'member@docs-beta.test',
    'role',
    'authenticated',
    'tenant_id',
    '00000000-0000-0000-0000-000000000702',
    'tenant_role',
    'member'
  )::text,
  true
);

set local role authenticated;

do $$
begin
  perform *
  from public.mark_document_uploaded(
    (select document_id from created_document),
    4096
  );
exception
  when others then
    insert into test_errors (label, message)
    values ('cross_tenant_mark_uploaded', sqlerrm);
end;
$$;

SELECT is(
  (select message from test_errors where label = 'cross_tenant_mark_uploaded'),
  'Document not found',
  'Tenant users cannot mark documents from another tenant uploaded'
);

reset role;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',
    '00000000-0000-0000-0000-000000000801',
    'email',
    'owner@docs-alpha.test',
    'role',
    'authenticated'
  )::text,
  true
);

set local role authenticated;

do $$
begin
  perform *
  from public.create_document_upload(
    _filename => 'No Tenant.pdf',
    _workspace_id => '00000000-0000-0000-0000-000000000000'::uuid,
    _mime_type => 'application/pdf',
    _byte_size => 1,
    _metadata => '{}'::jsonb
  );
exception
  when others then
    insert into test_errors (label, message)
    values ('missing_tenant_claim', sqlerrm);
end;
$$;

SELECT is(
  (select message from test_errors where label = 'missing_tenant_claim'),
  'Tenant claim required',
  'Document upload requires tenant claims'
);

SELECT * FROM finish();
ROLLBACK;
