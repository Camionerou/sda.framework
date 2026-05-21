BEGIN;
SELECT plan(12);

insert into public.tenants (id, slug, name)
values
  ('00000000-0000-0000-0000-000000001501', 'db-cache-alpha', 'DB Cache Alpha'),
  ('00000000-0000-0000-0000-000000001502', 'db-cache-beta', 'DB Cache Beta');

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
    '00000000-0000-0000-0000-000000001511',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'owner@db-cache-alpha.test',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000001512',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'member@db-cache-beta.test',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

insert into public.users (id, tenant_id, email, display_name, role, status)
values
  (
    '00000000-0000-0000-0000-000000001511',
    '00000000-0000-0000-0000-000000001501',
    'owner@db-cache-alpha.test',
    'DB Cache Alpha Owner',
    'owner',
    'active'
  ),
  (
    '00000000-0000-0000-0000-000000001512',
    '00000000-0000-0000-0000-000000001502',
    'member@db-cache-beta.test',
    'DB Cache Beta Member',
    'member',
    'active'
  );

insert into public.documents (id, tenant_id, created_by, filename, r2_key, status, uploaded_at)
values (
  '00000000-0000-0000-0000-000000001521',
  '00000000-0000-0000-0000-000000001501',
  '00000000-0000-0000-0000-000000001511',
  'alpha-cache.pdf',
  '00000000-0000-0000-0000-000000001501/00000000-0000-0000-0000-000000001521/alpha-cache.pdf',
  'indexed',
  now()
);

insert into public.doc_tree_nodes (
  id,
  tenant_id,
  document_id,
  node_id,
  node_path,
  node_type,
  title,
  page_start,
  page_end,
  routing_summary,
  metadata
)
values
  (
    '00000000-0000-0000-0000-000000001531',
    '00000000-0000-0000-0000-000000001501',
    '00000000-0000-0000-0000-000000001521',
    '0000',
    'n0000'::extensions.ltree,
    'root',
    'Root',
    1,
    2,
    'Root routing summary',
    '{"document_type":"contract"}'::jsonb
  ),
  (
    '00000000-0000-0000-0000-000000001532',
    '00000000-0000-0000-0000-000000001501',
    '00000000-0000-0000-0000-000000001521',
    '0001',
    'n0000.n0001'::extensions.ltree,
    'leaf',
    'Child',
    2,
    2,
    'Child routing summary',
    '{"document_type":"contract"}'::jsonb
  );

update public.doc_tree_nodes
set parent_id = '00000000-0000-0000-0000-000000001531'
where id = '00000000-0000-0000-0000-000000001532';

insert into public.tenant_invites (
  tenant_id,
  email,
  role,
  token_hash,
  status,
  expires_at,
  created_at,
  updated_at
)
values (
  '00000000-0000-0000-0000-000000001501',
  'old-revoked@db-cache-alpha.test',
  'member',
  repeat('a', 64),
  'revoked',
  now() - interval '99 days',
  now() - interval '100 days',
  now() - interval '100 days'
);

insert into public.indexing_runs (id, tenant_id, document_id, status, stage, created_at, updated_at)
values (
  '00000000-0000-0000-0000-000000001541',
  '00000000-0000-0000-0000-000000001501',
  '00000000-0000-0000-0000-000000001521',
  'completed',
  'indexed',
  now() - interval '7 months',
  now() - interval '7 months'
);

insert into public.indexing_events (
  tenant_id,
  document_id,
  run_id,
  event_type,
  stage,
  message,
  created_at
)
values (
  '00000000-0000-0000-0000-000000001501',
  '00000000-0000-0000-0000-000000001521',
  '00000000-0000-0000-0000-000000001541',
  'indexing.test.old',
  'indexed',
  'old event',
  now() - interval '7 months'
);

insert into public.audit_log (tenant_id, action, resource_type, created_at)
values (
  '00000000-0000-0000-0000-000000001501',
  'test.old',
  'test',
  now() - interval '3 years'
);

SELECT ok(
  exists (select 1 from pg_extension where extname = 'ltree'),
  'ltree extension is enabled'
);

SELECT ok(
  to_regclass('public.doc_tree_nodes') is not null,
  'doc_tree_nodes table exists'
);

SELECT ok(
  to_regclass('public.doc_tree_nodes_path_idx') is not null,
  'doc_tree_nodes path index exists'
);

SELECT ok(
  not has_table_privilege(
    'authenticated',
    'public.doc_tree_nodes',
    'insert'
  ),
  'Authenticated clients cannot insert doc_tree_nodes directly'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.refresh_indexing_health_snapshot()',
    'execute'
  ),
  'Service role can refresh indexing health snapshot'
);

SELECT ok(
  not has_function_privilege(
    'authenticated',
    'public.refresh_indexing_health_snapshot()',
    'execute'
  ),
  'Authenticated clients cannot refresh indexing health snapshot'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.cleanup_operational_data(interval, interval, interval)',
    'execute'
  ),
  'Service role can execute operational cleanup'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',
    '00000000-0000-0000-0000-000000001511',
    'email',
    'owner@db-cache-alpha.test',
    'role',
    'authenticated',
    'tenant_id',
    '00000000-0000-0000-0000-000000001501',
    'tenant_role',
    'owner'
  )::text,
  true
);

set local role authenticated;

SELECT is(
  (select count(*)::integer from public.doc_tree_nodes),
  2,
  'Tenant can read its doc_tree_nodes'
);

reset role;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',
    '00000000-0000-0000-0000-000000001512',
    'email',
    'member@db-cache-beta.test',
    'role',
    'authenticated',
    'tenant_id',
    '00000000-0000-0000-0000-000000001502',
    'tenant_role',
    'member'
  )::text,
  true
);

set local role authenticated;

SELECT is(
  (select count(*)::integer from public.doc_tree_nodes),
  0,
  'Tenant cannot read another tenant doc_tree_nodes'
);

reset role;

create temporary table cleanup_result on commit drop as
select public.cleanup_operational_data() as result;

SELECT is(
  (select (result ->> 'revoked_invites_deleted')::integer from cleanup_result),
  1,
  'Cleanup deletes old revoked invites'
);

SELECT is(
  (select (result ->> 'indexing_events_deleted')::integer from cleanup_result),
  1,
  'Cleanup deletes old indexing events'
);

SELECT ok(
  exists (
    select 1
    from public.refresh_indexing_health_snapshot()
    where data ? 'counts'
  ),
  'Health snapshot refresh returns counts'
);

SELECT * FROM finish();
ROLLBACK;
