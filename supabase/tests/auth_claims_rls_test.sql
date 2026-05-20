BEGIN;
SELECT plan(11);

insert into public.tenants (id, slug, name)
values
  ('00000000-0000-0000-0000-000000000101', 'tenant-alpha', 'Tenant Alpha'),
  ('00000000-0000-0000-0000-000000000102', 'tenant-beta', 'Tenant Beta');

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
    '00000000-0000-0000-0000-000000000201',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'admin@tenant-alpha.test',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000202',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'member@tenant-beta.test',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000203',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'disabled@tenant-alpha.test',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

insert into public.users (id, tenant_id, email, display_name, role, status)
values
  (
    '00000000-0000-0000-0000-000000000201',
    '00000000-0000-0000-0000-000000000101',
    'admin@tenant-alpha.test',
    'Tenant Alpha Admin',
    'admin',
    'active'
  ),
  (
    '00000000-0000-0000-0000-000000000202',
    '00000000-0000-0000-0000-000000000102',
    'member@tenant-beta.test',
    'Tenant Beta Member',
    'member',
    'active'
  ),
  (
    '00000000-0000-0000-0000-000000000203',
    '00000000-0000-0000-0000-000000000101',
    'disabled@tenant-alpha.test',
    'Disabled Alpha User',
    'member',
    'disabled'
  );

insert into public.documents (id, tenant_id, created_by, filename, r2_key, status)
values
  (
    '00000000-0000-0000-0000-000000000301',
    '00000000-0000-0000-0000-000000000101',
    '00000000-0000-0000-0000-000000000201',
    'alpha.pdf',
    'tenants/00000000-0000-0000-0000-000000000101/alpha.pdf',
    'uploaded'
  ),
  (
    '00000000-0000-0000-0000-000000000302',
    '00000000-0000-0000-0000-000000000102',
    '00000000-0000-0000-0000-000000000202',
    'beta.pdf',
    'tenants/00000000-0000-0000-0000-000000000102/beta.pdf',
    'uploaded'
  );

SELECT ok(
  has_function_privilege(
    'supabase_auth_admin',
    'app.custom_access_token_hook(jsonb)',
    'execute'
  ),
  'Supabase Auth can execute the custom access token hook'
);

SELECT ok(
  not has_function_privilege(
    'authenticated',
    'app.custom_access_token_hook(jsonb)',
    'execute'
  ),
  'Authenticated users cannot execute the custom access token hook directly'
);

SELECT ok(
  has_column_privilege(
    'supabase_auth_admin',
    'public.users',
    'tenant_id',
    'select'
  ),
  'Supabase Auth has minimal read access to user tenant_id'
);

SELECT is(
  app.custom_access_token_hook(
    jsonb_build_object(
      'user_id',
      '00000000-0000-0000-0000-000000000201',
      'claims',
      jsonb_build_object(
        'sub',
        '00000000-0000-0000-0000-000000000201',
        'role',
        'authenticated',
        'app_metadata',
        '{}'::jsonb
      )
    )
  ) #>> '{claims,tenant_id}',
  '00000000-0000-0000-0000-000000000101',
  'Hook adds tenant_id for an active tenant user'
);

SELECT is(
  app.custom_access_token_hook(
    jsonb_build_object(
      'user_id',
      '00000000-0000-0000-0000-000000000201',
      'claims',
      jsonb_build_object(
        'sub',
        '00000000-0000-0000-0000-000000000201',
        'role',
        'authenticated',
        'app_metadata',
        '{}'::jsonb
      )
    )
  ) #>> '{claims,tenant_role}',
  'admin',
  'Hook adds tenant_role for an active tenant user'
);

SELECT is(
  app.custom_access_token_hook(
    jsonb_build_object(
      'user_id',
      '00000000-0000-0000-0000-000000000201',
      'claims',
      jsonb_build_object(
        'sub',
        '00000000-0000-0000-0000-000000000201',
        'role',
        'authenticated',
        'app_metadata',
        '{}'::jsonb
      )
    )
  ) #>> '{claims,app_metadata,tenant_id}',
  '00000000-0000-0000-0000-000000000101',
  'Hook mirrors tenant_id into app_metadata for SDK compatibility'
);

SELECT ok(
  (
    app.custom_access_token_hook(
      jsonb_build_object(
        'user_id',
        '00000000-0000-0000-0000-000000000203',
        'claims',
        jsonb_build_object(
          'sub',
          '00000000-0000-0000-0000-000000000203',
          'role',
          'authenticated',
          'tenant_id',
          'stale',
          'tenant_role',
          'member',
          'app_metadata',
          '{"tenant_id":"stale","tenant_role":"member"}'::jsonb
        )
      )
    ) #>> '{claims,tenant_id}'
  ) is null,
  'Hook strips tenant claims for disabled tenant users'
);

SELECT is(
  app.custom_access_token_hook(
    '{"user_id":"not-a-uuid","claims":{}}'::jsonb
  ) #>> '{error,http_code}',
  '400',
  'Hook returns a structured error for invalid user ids'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',
    '00000000-0000-0000-0000-000000000201',
    'role',
    'authenticated',
    'tenant_id',
    '00000000-0000-0000-0000-000000000101',
    'tenant_role',
    'admin'
  )::text,
  true
);

set local role authenticated;

SELECT is(
  (select count(*)::integer from public.tenants),
  1,
  'RLS exposes only the current tenant'
);

SELECT is(
  (select count(*)::integer from public.documents),
  1,
  'RLS exposes only documents for the current tenant'
);

SELECT is(
  (select filename from public.documents),
  'alpha.pdf',
  'RLS hides cross-tenant document rows'
);

SELECT * FROM finish();
ROLLBACK;
