BEGIN;
SELECT plan(15);

insert into public.tenants (id, slug, name)
values
  ('00000000-0000-0000-0000-000000001701', 'security-alpha', 'Security Alpha'),
  ('00000000-0000-0000-0000-000000001702', 'security-beta', 'Security Beta');

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
    '00000000-0000-0000-0000-000000001711',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'owner@security-alpha.test',
    now(),
    '{"provider":"google","providers":["google"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000001712',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'member@security-beta.test',
    now(),
    '{"provider":"google","providers":["google"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

insert into public.users (id, tenant_id, email, display_name, role, status)
values
  (
    '00000000-0000-0000-0000-000000001711',
    '00000000-0000-0000-0000-000000001701',
    'owner@security-alpha.test',
    'Security Alpha Owner',
    'owner',
    'active'
  ),
  (
    '00000000-0000-0000-0000-000000001712',
    '00000000-0000-0000-0000-000000001702',
    'member@security-beta.test',
    'Security Beta Member',
    'member',
    'active'
  );

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',
    '00000000-0000-0000-0000-000000001711',
    'role',
    'authenticated',
    'tenant_id',
    '00000000-0000-0000-0000-000000001701'
  )::text,
  true
);

set local role authenticated;

SELECT ok(
  app.current_tenant_role() is null,
  'Missing tenant_role claim fails closed'
);

SELECT ok(
  not app.is_tenant_admin(),
  'Missing tenant_role claim is not treated as admin'
);

reset role;

SELECT is(
  app.safe_storage_filename('..'),
  'document',
  'Storage filename sanitizer rejects dot-only names'
);

SELECT is(
  app.safe_storage_filename('.Env File.PDF'),
  'env-file.pdf',
  'Storage filename sanitizer strips leading dots'
);

SELECT ok(
  app.is_valid_document_storage_path(
    '00000000-0000-0000-0000-000000001701',
    '00000000-0000-0000-0000-000000001721',
    '00000000-0000-0000-0000-000000001701/00000000-0000-0000-0000-000000001721/report.pdf'
  ),
  'Document storage path helper accepts canonical tenant/document paths'
);

SELECT ok(
  not app.is_safe_documents_storage_name(
    '00000000-0000-0000-0000-000000001701/../00000000-0000-0000-0000-000000001702/evil.pdf'
  ),
  'Storage path helper rejects dot traversal segments'
);

SELECT ok(
  not app.is_valid_document_storage_path(
    '00000000-0000-0000-0000-000000001701',
    '00000000-0000-0000-0000-000000001721',
    '00000000-0000-0000-0000-000000001701/00000000-0000-0000-0000-000000001721/..'
  ),
  'Document storage path helper rejects traversal filenames'
);

SELECT throws_ok(
  $$
    insert into public.documents (
      id,
      tenant_id,
      workspace_id,
      created_by,
      filename,
      r2_key,
      status
    )
    values (
      '00000000-0000-0000-0000-000000001721',
      '00000000-0000-0000-0000-000000001701',
      (select id from public.workspaces where tenant_id = '00000000-0000-0000-0000-000000001701' and slug = 'default'),
      '00000000-0000-0000-0000-000000001711',
      'evil.pdf',
      '00000000-0000-0000-0000-000000001701/../00000000-0000-0000-0000-000000001702/evil.pdf',
      'uploaded'
    )
  $$,
  '23514',
  null,
  'Documents constraint rejects unsafe storage paths'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',
    '00000000-0000-0000-0000-000000001711',
    'email',
    'owner@security-alpha.test',
    'role',
    'authenticated',
    'tenant_id',
    '00000000-0000-0000-0000-000000001701',
    'tenant_role',
    'owner'
  )::text,
  true
);

set local role authenticated;

create temporary table delete_allowed_upload on commit drop as
select *
from public.create_document_upload(
  'Delete Me.pdf',
  'application/pdf',
  10,
  null,
  '{}'::jsonb,
  null
);

delete from public.documents
where id = (select document_id from delete_allowed_upload);

SELECT is(
  (
    select count(*)::integer
    from public.documents
    where id = (select document_id from delete_allowed_upload)
  ),
  0,
  'Owner can delete own uploading document'
);

create temporary table delete_blocked_upload on commit drop as
select *
from public.create_document_upload(
  'Keep Uploaded.pdf',
  'application/pdf',
  10,
  null,
  '{}'::jsonb,
  null
);

create temporary table marked_delete_blocked_upload on commit drop as
select *
from public.mark_document_uploaded(
  (select document_id from delete_blocked_upload),
  10,
  null
);

delete from public.documents
where id = (select document_id from delete_blocked_upload);

SELECT is(
  (
    select count(*)::integer
    from public.documents
    where id = (select document_id from delete_blocked_upload)
  ),
  1,
  'Owner cannot delete uploaded document'
);

SELECT throws_ok(
  $$
    insert into storage.objects (bucket_id, name, owner, metadata)
    values (
      'documents',
      '00000000-0000-0000-0000-000000001701/../00000000-0000-0000-0000-000000001702/evil.pdf',
      auth.uid(),
      '{}'::jsonb
    )
  $$,
  '42501',
  null,
  'Storage RLS rejects traversal object names'
);

reset role;

update public.documents
set status = 'indexed'
where id = (select document_id from delete_blocked_upload);

SELECT ok(
  exists (
    select 1
    from public.audit_log
    where action = 'document.indexed'
      and resource_id = (select document_id from delete_blocked_upload)
  ),
  'Document indexed status change is audited'
);

insert into public.indexing_runs (
  id,
  tenant_id,
  document_id,
  status,
  stage,
  progress,
  metadata
)
values (
  '00000000-0000-0000-0000-000000001731',
  '00000000-0000-0000-0000-000000001701',
  (select document_id from delete_blocked_upload),
  'queued',
  'queued',
  0,
  '{"requested_by":"00000000-0000-0000-0000-000000001711"}'::jsonb
);

update public.indexing_runs
set
  error_message = 'boom',
  stage = 'failed',
  status = 'failed'
where id = '00000000-0000-0000-0000-000000001731';

SELECT ok(
  exists (
    select 1
    from public.audit_log
    where action = 'indexing_run.failed'
      and resource_id = '00000000-0000-0000-0000-000000001731'
  ),
  'Indexing terminal failure is audited'
);

update public.users
set role = 'admin'
where id = '00000000-0000-0000-0000-000000001712';

SELECT ok(
  exists (
    select 1
    from public.audit_log
    where action = 'user.role_changed'
      and resource_id = '00000000-0000-0000-0000-000000001712'
  ),
  'User role changes are audited'
);

insert into public.tenant_invites (
  id,
  tenant_id,
  email,
  role,
  token_hash,
  invited_by,
  expires_at
)
values (
  '00000000-0000-0000-0000-000000001741',
  '00000000-0000-0000-0000-000000001701',
  'invitee@security-alpha.test',
  'member',
  repeat('a', 64),
  '00000000-0000-0000-0000-000000001711',
  now() + interval '1 day'
);

update public.tenant_invites
set status = 'revoked'
where id = '00000000-0000-0000-0000-000000001741';

SELECT ok(
  exists (
    select 1
    from public.audit_log
    where action = 'tenant_invite.status_changed'
      and resource_id = '00000000-0000-0000-0000-000000001741'
  ),
  'Tenant invite status changes are audited'
);

SELECT * FROM finish();
ROLLBACK;
