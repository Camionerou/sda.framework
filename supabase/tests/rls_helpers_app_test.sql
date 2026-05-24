BEGIN;
SELECT plan(21);

-- Helpers existen
SELECT has_function('app', 'current_workspace_id', ARRAY[]::text[],
  'app.current_workspace_id() exists');
SELECT has_function('app', 'user_belongs_to_workspace', ARRAY['uuid'],
  'app.user_belongs_to_workspace(uuid) exists');
SELECT has_function('app', 'user_workspace_role', ARRAY['uuid'],
  'app.user_workspace_role(uuid) exists');
SELECT has_function('app', 'user_can_read_document', ARRAY['uuid'],
  'app.user_can_read_document(uuid) exists');
SELECT has_function('app', 'user_can_edit_document', ARRAY['uuid'],
  'app.user_can_edit_document(uuid) exists');
SELECT has_function('app', 'audit_with_context', ARRAY['text','text','uuid','jsonb','jsonb'],
  'app.audit_with_context(text,text,uuid,jsonb,jsonb) exists');

-- Setup: tenant + 3 users (admin, editor, outsider), 1 workspace, 1 group, 1 doc
insert into public.tenants (id, slug, name)
values ('00000000-0000-0000-0000-000000003601', 'helpers-tenant', 'Helpers Tenant');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000003611',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'admin@h.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000003612',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'editor@h.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000003613',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'outsider@h.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.users (id, tenant_id, email, role, status) values
  ('00000000-0000-0000-0000-000000003611',
   '00000000-0000-0000-0000-000000003601', 'admin@h.test', 'admin', 'active'),
  ('00000000-0000-0000-0000-000000003612',
   '00000000-0000-0000-0000-000000003601', 'editor@h.test', 'member', 'active'),
  ('00000000-0000-0000-0000-000000003613',
   '00000000-0000-0000-0000-000000003601', 'outsider@h.test', 'member', 'active');

insert into public.workspaces (id, tenant_id, slug, name)
values ('00000000-0000-0000-0000-000000003621',
  '00000000-0000-0000-0000-000000003601', 'engineering', 'Engineering');

insert into public.groups (id, tenant_id, key, name)
values ('00000000-0000-0000-0000-000000003631',
  '00000000-0000-0000-0000-000000003601', 'eng-team', 'Engineering Team');

insert into public.group_memberships (group_id, user_id, tenant_id)
values ('00000000-0000-0000-0000-000000003631',
  '00000000-0000-0000-0000-000000003612',
  '00000000-0000-0000-0000-000000003601');

insert into public.workspace_memberships
  (workspace_id, tenant_id, principal_kind, principal_id, role)
values
  ('00000000-0000-0000-0000-000000003621',
   '00000000-0000-0000-0000-000000003601',
   'group', '00000000-0000-0000-0000-000000003631',
   'workspace_editor');

insert into public.workspace_memberships
  (workspace_id, tenant_id, principal_kind, principal_id, role)
values
  ('00000000-0000-0000-0000-000000003621',
   '00000000-0000-0000-0000-000000003601',
   'user', '00000000-0000-0000-0000-000000003612',
   'workspace_viewer');

insert into public.documents
  (id, tenant_id, workspace_id, created_by, filename, r2_key, status, uploaded_at)
values
  ('00000000-0000-0000-0000-000000003641',
   '00000000-0000-0000-0000-000000003601',
   '00000000-0000-0000-0000-000000003621',
   '00000000-0000-0000-0000-000000003612',
   'eng.pdf',
   '00000000-0000-0000-0000-000000003601/00000000-0000-0000-0000-000000003641/eng.pdf',
   'uploaded', now());

-- JWT como editor con active_workspace_id
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '00000000-0000-0000-0000-000000003612',
    'role', 'authenticated',
    'tenant_id', '00000000-0000-0000-0000-000000003601',
    'tenant_role', 'member',
    'active_workspace_id', '00000000-0000-0000-0000-000000003621'
  )::text, true
);
set local role authenticated;

SELECT is(
  app.current_workspace_id(),
  '00000000-0000-0000-0000-000000003621'::uuid,
  'current_workspace_id reads JWT claim'
);

SELECT ok(
  app.user_belongs_to_workspace('00000000-0000-0000-0000-000000003621'::uuid),
  'editor belongs to workspace (via group)'
);

SELECT is(
  app.user_workspace_role('00000000-0000-0000-0000-000000003621'::uuid)::text,
  'workspace_editor',
  'editor effective role is workspace_editor (max of direct viewer and group editor)'
);

SELECT ok(
  app.user_can_read_document('00000000-0000-0000-0000-000000003641'::uuid),
  'editor can read document in their workspace'
);

SELECT ok(
  app.user_can_edit_document('00000000-0000-0000-0000-000000003641'::uuid),
  'editor can edit document in their workspace'
);

reset role;
select set_config('request.jwt.claims', null, true);

-- JWT como outsider
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '00000000-0000-0000-0000-000000003613',
    'role', 'authenticated',
    'tenant_id', '00000000-0000-0000-0000-000000003601',
    'tenant_role', 'member'
  )::text, true
);
set local role authenticated;

SELECT ok(
  not app.user_belongs_to_workspace('00000000-0000-0000-0000-000000003621'::uuid),
  'outsider does not belong to workspace'
);

SELECT ok(
  not app.user_can_read_document('00000000-0000-0000-0000-000000003641'::uuid),
  'outsider cannot read document in workspace they do not belong to'
);

SELECT ok(
  not app.user_can_edit_document('00000000-0000-0000-0000-000000003641'::uuid),
  'outsider cannot edit document'
);

reset role;
select set_config('request.jwt.claims', null, true);

-- JWT como admin
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '00000000-0000-0000-0000-000000003611',
    'role', 'authenticated',
    'tenant_id', '00000000-0000-0000-0000-000000003601',
    'tenant_role', 'admin'
  )::text, true
);
set local role authenticated;

SELECT ok(
  app.user_can_read_document('00000000-0000-0000-0000-000000003641'::uuid),
  'tenant admin bypasses workspace membership (read)'
);
SELECT ok(
  app.user_can_edit_document('00000000-0000-0000-0000-000000003641'::uuid),
  'tenant admin bypasses workspace membership (edit)'
);

reset role;
select set_config('request.jwt.claims', null, true);

-- tenant_public collection visibility
insert into public.collections
  (id, tenant_id, workspace_id, slug, name, visibility)
values
  ('00000000-0000-0000-0000-000000003651',
   '00000000-0000-0000-0000-000000003601',
   '00000000-0000-0000-0000-000000003621',
   'shared', 'Shared', 'tenant_public');

insert into public.document_collections (tenant_id, document_id, collection_id)
values ('00000000-0000-0000-0000-000000003601',
  '00000000-0000-0000-0000-000000003641',
  '00000000-0000-0000-0000-000000003651');

reset role;
select set_config('request.jwt.claims', null, true);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '00000000-0000-0000-0000-000000003613',
    'role', 'authenticated',
    'tenant_id', '00000000-0000-0000-0000-000000003601',
    'tenant_role', 'member'
  )::text, true
);
set local role authenticated;

SELECT ok(
  app.user_can_read_document('00000000-0000-0000-0000-000000003641'::uuid),
  'outsider can read document via tenant_public collection'
);
SELECT ok(
  not app.user_can_edit_document('00000000-0000-0000-0000-000000003641'::uuid),
  'tenant_public read does NOT grant edit to outsider'
);

reset role;

-- audit_with_context
SELECT lives_ok(
  $$ select app.audit_with_context(
       'document.test',
       'document',
       '00000000-0000-0000-0000-000000003641'::uuid,
       jsonb_build_object('extra', 'payload'),
       jsonb_build_object(
         'request_id', 'req-123',
         'session_id', '00000000-0000-0000-0000-0000000099aa',
         'ip', '10.0.0.1',
         'user_agent', 'test-agent',
         'workspace_id', '00000000-0000-0000-0000-000000003621'
       )
     ) $$,
  'audit_with_context inserts a row'
);

SELECT is(
  (select metadata ->> 'request_id' from public.audit_log
     where action = 'document.test'
     order by created_at desc limit 1),
  'req-123',
  'audit_with_context persists request_id in metadata'
);

SELECT is(
  (select request_id from public.audit_log
     where action = 'document.test'
     order by created_at desc limit 1),
  'req-123',
  'audit_with_context populates audit_log.request_id column'
);

SELECT * FROM finish();
ROLLBACK;
