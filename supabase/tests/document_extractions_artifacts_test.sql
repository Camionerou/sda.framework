BEGIN;
SELECT plan(10);

insert into public.tenants (id, slug, name)
values
  ('00000000-0000-0000-0000-000000001001', 'extract-alpha', 'Extract Alpha'),
  ('00000000-0000-0000-0000-000000001002', 'extract-beta', 'Extract Beta');

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
    '00000000-0000-0000-0000-000000001101',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'owner@extract-alpha.test',
    now(),
    '{"provider":"google","providers":["google"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000001102',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'member@extract-beta.test',
    now(),
    '{"provider":"google","providers":["google"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

insert into public.users (id, tenant_id, email, display_name, role, status)
values
  (
    '00000000-0000-0000-0000-000000001101',
    '00000000-0000-0000-0000-000000001001',
    'owner@extract-alpha.test',
    'Extract Alpha Owner',
    'owner',
    'active'
  ),
  (
    '00000000-0000-0000-0000-000000001102',
    '00000000-0000-0000-0000-000000001002',
    'member@extract-beta.test',
    'Extract Beta Member',
    'member',
    'active'
  );

insert into public.documents (
  id,
  tenant_id,
  created_by,
  filename,
  r2_key,
  status,
  checksum_sha256,
  uploaded_at
)
values
  (
    '00000000-0000-0000-0000-000000001201',
    '00000000-0000-0000-0000-000000001001',
    '00000000-0000-0000-0000-000000001101',
    'alpha-a.pdf',
    '00000000-0000-0000-0000-000000001001/00000000-0000-0000-0000-000000001201/alpha-a.pdf',
    'uploaded',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    now()
  ),
  (
    '00000000-0000-0000-0000-000000001202',
    '00000000-0000-0000-0000-000000001001',
    '00000000-0000-0000-0000-000000001101',
    'alpha-b.pdf',
    '00000000-0000-0000-0000-000000001001/00000000-0000-0000-0000-000000001202/alpha-b.pdf',
    'uploaded',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    now()
  ),
  (
    '00000000-0000-0000-0000-000000001203',
    '00000000-0000-0000-0000-000000001002',
    '00000000-0000-0000-0000-000000001102',
    'beta.pdf',
    '00000000-0000-0000-0000-000000001002/00000000-0000-0000-0000-000000001203/beta.pdf',
    'uploaded',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    now()
  );

insert into public.indexing_runs (id, tenant_id, document_id, status, stage)
values
  (
    '00000000-0000-0000-0000-000000001301',
    '00000000-0000-0000-0000-000000001001',
    '00000000-0000-0000-0000-000000001201',
    'running',
    'extracting'
  );

insert into public.document_extractions (
  id,
  tenant_id,
  document_id,
  run_id,
  parser,
  parser_version,
  parser_backend,
  source_checksum_sha256,
  source_r2_key,
  status,
  artifact_prefix,
  manifest,
  completed_at
)
values
  (
    '00000000-0000-0000-0000-000000001401',
    '00000000-0000-0000-0000-000000001001',
    '00000000-0000-0000-0000-000000001201',
    '00000000-0000-0000-0000-000000001301',
    'mineru',
    '3.1.15',
    'pipeline',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '00000000-0000-0000-0000-000000001001/00000000-0000-0000-0000-000000001201/alpha-a.pdf',
    'succeeded',
    '00000000-0000-0000-0000-000000001001/00000000-0000-0000-0000-000000001201/extractions/mineru/3.1.15/00000000-0000-0000-0000-000000001401',
    '{"pages":12}'::jsonb,
    now()
  ),
  (
    '00000000-0000-0000-0000-000000001402',
    '00000000-0000-0000-0000-000000001002',
    '00000000-0000-0000-0000-000000001203',
    null,
    'mineru',
    '3.1.15',
    'pipeline',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    '00000000-0000-0000-0000-000000001002/00000000-0000-0000-0000-000000001203/beta.pdf',
    'succeeded',
    '00000000-0000-0000-0000-000000001002/00000000-0000-0000-0000-000000001203/extractions/mineru/3.1.15/00000000-0000-0000-0000-000000001402',
    '{}'::jsonb,
    now()
  );

insert into public.document_extraction_artifacts (
  extraction_id,
  tenant_id,
  document_id,
  artifact_type,
  storage_path,
  content_type,
  byte_size,
  checksum_sha256
)
values (
  '00000000-0000-0000-0000-000000001401',
  '00000000-0000-0000-0000-000000001001',
  '00000000-0000-0000-0000-000000001201',
  'markdown',
  '00000000-0000-0000-0000-000000001001/00000000-0000-0000-0000-000000001201/extractions/mineru/3.1.15/00000000-0000-0000-0000-000000001401/document.md',
  'text/markdown',
  123,
  'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
);

SELECT ok(
  not has_table_privilege(
    'authenticated',
    'public.document_extractions',
    'insert'
  ),
  'Authenticated clients cannot insert document extractions directly'
);

SELECT ok(
  not has_table_privilege(
    'authenticated',
    'public.document_extraction_artifacts',
    'insert'
  ),
  'Authenticated clients cannot insert extraction artifacts directly'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',
    '00000000-0000-0000-0000-000000001101',
    'email',
    'owner@extract-alpha.test',
    'role',
    'authenticated',
    'tenant_id',
    '00000000-0000-0000-0000-000000001001',
    'tenant_role',
    'owner'
  )::text,
  true
);

set local role authenticated;

SELECT is(
  (
    select count(*)::integer
    from public.document_extractions
  ),
  1,
  'Tenant sees only its document extractions'
);

SELECT is(
  (
    select manifest->>'pages'
    from public.document_extractions
    where id = '00000000-0000-0000-0000-000000001401'
  ),
  '12',
  'Tenant can read extraction manifest'
);

SELECT is(
  (
    select count(*)::integer
    from public.document_extraction_artifacts
  ),
  1,
  'Tenant sees only its extraction artifacts'
);

reset role;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',
    '00000000-0000-0000-0000-000000001102',
    'email',
    'member@extract-beta.test',
    'role',
    'authenticated',
    'tenant_id',
    '00000000-0000-0000-0000-000000001002',
    'tenant_role',
    'member'
  )::text,
  true
);

set local role authenticated;

SELECT is(
  (
    select count(*)::integer
    from public.document_extractions
    where document_id = '00000000-0000-0000-0000-000000001201'
  ),
  0,
  'Tenant cannot read another tenant extraction'
);

SELECT is(
  (
    select count(*)::integer
    from public.document_extraction_artifacts
    where document_id = '00000000-0000-0000-0000-000000001201'
  ),
  0,
  'Tenant cannot read another tenant extraction artifact'
);

reset role;

SELECT throws_ok(
  $$
    insert into public.document_extractions (
      tenant_id,
      document_id,
      parser,
      parser_version,
      parser_backend,
      source_checksum_sha256,
      source_r2_key,
      status,
      artifact_prefix
    )
    values (
      '00000000-0000-0000-0000-000000001001',
      '00000000-0000-0000-0000-000000001202',
      'mineru',
      '3.1.15',
      'pipeline',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '00000000-0000-0000-0000-000000001001/00000000-0000-0000-0000-000000001202/alpha-b.pdf',
      'succeeded',
      '00000000-0000-0000-0000-000000001001/00000000-0000-0000-0000-000000001202/extractions/mineru/3.1.15/duplicate'
    )
  $$,
  '23505',
  null,
  'Successful extraction cache is unique by tenant, parser version, backend, and checksum'
);

SELECT lives_ok(
  $$
    insert into public.document_extractions (
      tenant_id,
      document_id,
      parser,
      parser_version,
      parser_backend,
      source_checksum_sha256,
      source_r2_key,
      status,
      artifact_prefix,
      manifest
    )
    values (
      '00000000-0000-0000-0000-000000001001',
      '00000000-0000-0000-0000-000000001202',
      'mineru',
      '3.1.15',
      'pipeline',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '00000000-0000-0000-0000-000000001001/00000000-0000-0000-0000-000000001202/alpha-b.pdf',
      'reused',
      '00000000-0000-0000-0000-000000001001/00000000-0000-0000-0000-000000001201/extractions/mineru/3.1.15/00000000-0000-0000-0000-000000001401',
      '{"reused_from":"00000000-0000-0000-0000-000000001401"}'::jsonb
    )
  $$,
  'Duplicate documents can link to an existing successful extraction as reused'
);

SELECT is(
  (
    select count(*)::integer
    from public.document_extractions
    where status = 'reused'
  ),
  1,
  'Reused extraction record is persisted'
);

SELECT * FROM finish();
ROLLBACK;
