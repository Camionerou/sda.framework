BEGIN;
SELECT plan(13);

insert into public.tenants (id, slug, name)
values ('00000000-0000-0000-0000-000000002001', 'realtime-alpha', 'Realtime Alpha');

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
values (
  '00000000-0000-0000-0000-000000002011',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'owner@realtime-alpha.test',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
);

insert into public.users (id, tenant_id, email, display_name, role, status)
values (
  '00000000-0000-0000-0000-000000002011',
  '00000000-0000-0000-0000-000000002001',
  'owner@realtime-alpha.test',
  'Realtime Alpha Owner',
  'owner',
  'active'
);

insert into public.documents (id, tenant_id, created_by, filename, r2_key, status, uploaded_at)
values (
  '00000000-0000-0000-0000-000000002021',
  '00000000-0000-0000-0000-000000002001',
  '00000000-0000-0000-0000-000000002011',
  'alpha-live.pdf',
  '00000000-0000-0000-0000-000000002001/00000000-0000-0000-0000-000000002021/alpha-live.pdf',
  'uploaded',
  now()
);

SELECT ok(
  exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'documents'
  ),
  'documents is published for realtime'
);

SELECT ok(
  exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'indexing_runs'
  ),
  'indexing_runs is published for realtime'
);

SELECT ok(
  exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'indexing_events'
  ),
  'indexing_events is published for realtime'
);

SELECT ok(
  exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'document_extractions'
  ),
  'document_extractions is published for realtime'
);

SELECT ok(
  exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'document_extraction_artifacts'
  ),
  'document_extraction_artifacts is published for realtime'
);

SELECT ok(
  exists (
    select 1
    from pg_policies
    where schemaname = 'realtime'
      and tablename = 'messages'
      and policyname = 'realtime_private_topic_select'
  ),
  'private realtime select policy exists'
);

SELECT ok(
  exists (
    select 1
    from pg_policies
    where schemaname = 'realtime'
      and tablename = 'messages'
      and policyname = 'realtime_private_topic_insert'
  ),
  'private realtime insert policy exists'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',
    '00000000-0000-0000-0000-000000002011',
    'email',
    'owner@realtime-alpha.test',
    'role',
    'authenticated',
    'tenant_id',
    '00000000-0000-0000-0000-000000002001',
    'tenant_role',
    'owner'
  )::text,
  true
);

set local role authenticated;

SELECT ok(
  app.is_allowed_realtime_topic('tenant:00000000-0000-0000-0000-000000002001:notifications'),
  'tenant member can join own tenant notifications topic'
);

SELECT ok(
  not app.is_allowed_realtime_topic('tenant:00000000-0000-0000-0000-000000002999:notifications'),
  'tenant member cannot join another tenant notifications topic'
);

SELECT ok(
  app.is_allowed_realtime_topic('document:00000000-0000-0000-0000-000000002021:presence'),
  'tenant member can join own document presence topic'
);

SELECT ok(
  app.is_allowed_realtime_topic('document:00000000-0000-0000-0000-000000002021:indexing'),
  'tenant member can join own document indexing broadcast topic'
);

SELECT ok(
  not app.is_allowed_realtime_topic('document:not-a-uuid:presence'),
  'malformed document topics fail closed'
);

reset role;

SELECT ok(
  exists (
    select 1
    from pg_trigger
    where tgname in (
      'broadcast_documents_realtime_change',
      'broadcast_indexing_runs_realtime_change',
      'broadcast_indexing_events_realtime_insert'
    )
    having count(*) = 3
  ),
  'database broadcast triggers are installed'
);

SELECT * FROM finish();
ROLLBACK;
