BEGIN;
SELECT plan(8);

insert into public.tenants (id, slug, name)
values ('00000000-0000-0000-0000-000000003701', 'jwt-tenant', 'JWT Tenant');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000003711',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'with-ws@jwt.test', now(), '{}'::jsonb,
   jsonb_build_object(
     'active_workspace_id', '00000000-0000-0000-0000-000000003721'
   ),
   now(), now()),
  ('00000000-0000-0000-0000-000000003712',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'no-ws@jwt.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000003713',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'phantom-ws@jwt.test', now(), '{}'::jsonb,
   jsonb_build_object(
     'active_workspace_id', '00000000-0000-0000-0000-0000000099cc'
   ),
   now(), now());

insert into public.users (id, tenant_id, email, role, status) values
  ('00000000-0000-0000-0000-000000003711',
   '00000000-0000-0000-0000-000000003701', 'with-ws@jwt.test', 'member', 'active'),
  ('00000000-0000-0000-0000-000000003712',
   '00000000-0000-0000-0000-000000003701', 'no-ws@jwt.test', 'member', 'active'),
  ('00000000-0000-0000-0000-000000003713',
   '00000000-0000-0000-0000-000000003701', 'phantom-ws@jwt.test', 'member', 'active');

insert into public.workspaces (id, tenant_id, slug, name)
values ('00000000-0000-0000-0000-000000003721',
  '00000000-0000-0000-0000-000000003701', 'finance', 'Finance');

insert into public.workspace_memberships
  (workspace_id, tenant_id, principal_kind, principal_id, role)
values
  ('00000000-0000-0000-0000-000000003721',
   '00000000-0000-0000-0000-000000003701',
   'user', '00000000-0000-0000-0000-000000003711',
   'workspace_admin');

-- Caso 1: user con metadata.active_workspace_id valido -> claim inyectado
SELECT is(
  app.custom_access_token_hook(jsonb_build_object(
    'user_id', '00000000-0000-0000-0000-000000003711',
    'claims', jsonb_build_object(
      'sub', '00000000-0000-0000-0000-000000003711',
      'role', 'authenticated',
      'app_metadata', '{}'::jsonb,
      'user_metadata', jsonb_build_object(
        'active_workspace_id', '00000000-0000-0000-0000-000000003721'
      )
    )
  )) #>> '{claims,active_workspace_id}',
  '00000000-0000-0000-0000-000000003721',
  'Hook injects active_workspace_id for valid membership'
);

SELECT is(
  app.custom_access_token_hook(jsonb_build_object(
    'user_id', '00000000-0000-0000-0000-000000003711',
    'claims', jsonb_build_object(
      'sub', '00000000-0000-0000-0000-000000003711',
      'role', 'authenticated',
      'app_metadata', '{}'::jsonb,
      'user_metadata', jsonb_build_object(
        'active_workspace_id', '00000000-0000-0000-0000-000000003721'
      )
    )
  )) #>> '{claims,active_workspace_role}',
  'workspace_admin',
  'Hook injects active_workspace_role'
);

SELECT is(
  (app.custom_access_token_hook(jsonb_build_object(
    'user_id', '00000000-0000-0000-0000-000000003711',
    'claims', jsonb_build_object(
      'sub', '00000000-0000-0000-0000-000000003711',
      'role', 'authenticated',
      'app_metadata', '{}'::jsonb
    )
  )) #> '{claims,claims_version}')::text,
  '2',
  'claims_version bumped to 2'
);

-- Caso 2: user sin active_workspace en metadata -> no inyecta claim
SELECT ok(
  (app.custom_access_token_hook(jsonb_build_object(
    'user_id', '00000000-0000-0000-0000-000000003712',
    'claims', jsonb_build_object(
      'sub', '00000000-0000-0000-0000-000000003712',
      'role', 'authenticated',
      'app_metadata', '{}'::jsonb
    )
  )) #> '{claims,active_workspace_id}') is null,
  'Hook omits active_workspace_id when user_metadata has none'
);

-- Caso 3: user con metadata pero apuntando a workspace inexistente o sin membership
SELECT ok(
  (app.custom_access_token_hook(jsonb_build_object(
    'user_id', '00000000-0000-0000-0000-000000003713',
    'claims', jsonb_build_object(
      'sub', '00000000-0000-0000-0000-000000003713',
      'role', 'authenticated',
      'app_metadata', '{}'::jsonb,
      'user_metadata', jsonb_build_object(
        'active_workspace_id', '00000000-0000-0000-0000-0000000099cc'
      )
    )
  )) #> '{claims,active_workspace_id}') is null,
  'Hook omits active_workspace_id when membership is missing'
);

-- Caso 4: app_metadata mirror
SELECT is(
  app.custom_access_token_hook(jsonb_build_object(
    'user_id', '00000000-0000-0000-0000-000000003711',
    'claims', jsonb_build_object(
      'sub', '00000000-0000-0000-0000-000000003711',
      'role', 'authenticated',
      'app_metadata', '{}'::jsonb,
      'user_metadata', jsonb_build_object(
        'active_workspace_id', '00000000-0000-0000-0000-000000003721'
      )
    )
  )) #>> '{claims,app_metadata,active_workspace_id}',
  '00000000-0000-0000-0000-000000003721',
  'Hook mirrors active_workspace_id in app_metadata'
);

-- Caso 5: tenant claims siguen presentes
SELECT is(
  app.custom_access_token_hook(jsonb_build_object(
    'user_id', '00000000-0000-0000-0000-000000003711',
    'claims', jsonb_build_object(
      'sub', '00000000-0000-0000-0000-000000003711',
      'role', 'authenticated',
      'app_metadata', '{}'::jsonb
    )
  )) #>> '{claims,tenant_id}',
  '00000000-0000-0000-0000-000000003701',
  'tenant_id claim still present in v2'
);

-- Caso 6: legacy event sin user_metadata sigue funcionando (no rompe)
SELECT is(
  (app.custom_access_token_hook(jsonb_build_object(
    'user_id', '00000000-0000-0000-0000-000000003712',
    'claims', jsonb_build_object(
      'sub', '00000000-0000-0000-0000-000000003712',
      'role', 'authenticated',
      'app_metadata', '{}'::jsonb
    )
  )) #> '{claims,claims_version}')::text,
  '2',
  'v2 hook always sets claims_version=2 even when no active_workspace'
);

SELECT * FROM finish();
ROLLBACK;
