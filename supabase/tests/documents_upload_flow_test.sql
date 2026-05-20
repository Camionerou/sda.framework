BEGIN;
SELECT plan(12);

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

SELECT ok(
  not has_function_privilege(
    'anon',
    'public.create_document_upload(text, text, bigint, text, jsonb, text)',
    'execute'
  ),
  'Anon clients cannot create document uploads'
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

create temporary table created_document on commit drop as
select *
from public.create_document_upload(
  'Quarterly Report Final.PDF',
  'application/pdf',
  1234,
  'Quarterly Report',
  '{"source":"pgtap"}'::jsonb,
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
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
  'Quarterly Report Final Copy.PDF',
  'application/pdf',
  2048,
  'Quarterly Report Copy',
  '{"source":"pgtap"}'::jsonb,
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
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
    'No Tenant.pdf',
    'application/pdf',
    1,
    null,
    '{}'::jsonb
  );
exception
  when others then
    insert into test_errors (label, message)
    values ('missing_tenant_claim', sqlerrm);
end;
$$;

SELECT is(
  (select message from test_errors where label = 'missing_tenant_claim'),
  'Tenant claim is required',
  'Document upload requires tenant claims'
);

SELECT * FROM finish();
ROLLBACK;
