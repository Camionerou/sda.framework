BEGIN;
SELECT plan(10);

insert into public.tenants (id, slug, name)
values
  ('00000000-0000-0000-0000-000000000901', 'index-alpha', 'Index Alpha'),
  ('00000000-0000-0000-0000-000000000902', 'index-beta', 'Index Beta');

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
    '00000000-0000-0000-0000-000000000911',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'owner@index-alpha.test',
    now(),
    '{"provider":"google","providers":["google"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000912',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'member@index-beta.test',
    now(),
    '{"provider":"google","providers":["google"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

insert into public.users (id, tenant_id, email, display_name, role, status)
values
  (
    '00000000-0000-0000-0000-000000000911',
    '00000000-0000-0000-0000-000000000901',
    'owner@index-alpha.test',
    'Index Alpha Owner',
    'owner',
    'active'
  ),
  (
    '00000000-0000-0000-0000-000000000912',
    '00000000-0000-0000-0000-000000000902',
    'member@index-beta.test',
    'Index Beta Member',
    'member',
    'active'
  );

insert into public.documents (id, tenant_id, created_by, filename, r2_key, status, uploaded_at)
values
  (
    '00000000-0000-0000-0000-000000000921',
    '00000000-0000-0000-0000-000000000901',
    '00000000-0000-0000-0000-000000000911',
    'alpha-index.pdf',
    '00000000-0000-0000-0000-000000000901/00000000-0000-0000-0000-000000000921/alpha-index.pdf',
    'uploaded',
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000922',
    '00000000-0000-0000-0000-000000000902',
    '00000000-0000-0000-0000-000000000912',
    'beta-index.pdf',
    '00000000-0000-0000-0000-000000000902/00000000-0000-0000-0000-000000000922/beta-index.pdf',
    'uploaded',
    now()
  );

create temporary table test_errors (
  label text primary key,
  message text not null
) on commit drop;

grant all on test_errors to authenticated;

SELECT ok(
  not has_function_privilege(
    'anon',
    'public.request_document_indexing(uuid, jsonb)',
    'execute'
  ),
  'Anon clients cannot request indexing'
);

SELECT ok(
  not has_table_privilege(
    'authenticated',
    'public.indexing_runs',
    'insert'
  ),
  'Authenticated clients cannot insert indexing runs directly'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',
    '00000000-0000-0000-0000-000000000911',
    'email',
    'owner@index-alpha.test',
    'role',
    'authenticated',
    'tenant_id',
    '00000000-0000-0000-0000-000000000901',
    'tenant_role',
    'owner'
  )::text,
  true
);

set local role authenticated;

create temporary table first_run on commit drop as
select *
from public.request_document_indexing(
  '00000000-0000-0000-0000-000000000921',
  '{"source":"pgtap"}'::jsonb
);

SELECT is(
  (select concat_ws(':', status, stage, progress::text) from first_run),
  'queued:queued:0',
  'Requesting indexing returns a queued run'
);

SELECT is(
  (
    select d.status::text
    from public.documents d
    where d.id = '00000000-0000-0000-0000-000000000921'
  ),
  'queued',
  'Requesting indexing updates document status'
);

SELECT is(
  (
    select count(*)::integer
    from public.indexing_events ie
    join first_run fr on fr.run_id = ie.run_id
    where ie.event_type = 'indexing.run.queued'
  ),
  1,
  'Requesting indexing writes an initial event'
);

create temporary table second_run on commit drop as
select *
from public.request_document_indexing(
  '00000000-0000-0000-0000-000000000921',
  '{"source":"pgtap-second"}'::jsonb
);

SELECT is(
  (select run_id from second_run),
  (select run_id from first_run),
  'A duplicate request returns the active run'
);

SELECT is(
  (
    select count(*)::integer
    from public.indexing_runs
    where document_id = '00000000-0000-0000-0000-000000000921'
  ),
  1,
  'A duplicate request does not create another active run'
);

reset role;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',
    '00000000-0000-0000-0000-000000000912',
    'email',
    'member@index-beta.test',
    'role',
    'authenticated',
    'tenant_id',
    '00000000-0000-0000-0000-000000000902',
    'tenant_role',
    'member'
  )::text,
  true
);

set local role authenticated;

SELECT is(
  (
    select count(*)::integer
    from public.indexing_runs
    where document_id = '00000000-0000-0000-0000-000000000921'
  ),
  0,
  'Tenant users cannot read another tenant indexing runs'
);

do $$
begin
  perform *
  from public.request_document_indexing(
    '00000000-0000-0000-0000-000000000921',
    '{}'::jsonb
  );
exception
  when others then
    insert into test_errors (label, message)
    values ('cross_tenant_request', sqlerrm);
end;
$$;

SELECT is(
  (select message from test_errors where label = 'cross_tenant_request'),
  'Document not found',
  'Tenant users cannot request indexing for another tenant document'
);

reset role;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',
    '00000000-0000-0000-0000-000000000911',
    'email',
    'owner@index-alpha.test',
    'role',
    'authenticated',
    'tenant_role',
    'owner'
  )::text,
  true
);

set local role authenticated;

do $$
begin
  perform *
  from public.request_document_indexing(
    '00000000-0000-0000-0000-000000000921',
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
  'Indexing request requires tenant claims'
);

SELECT * FROM finish();
ROLLBACK;
