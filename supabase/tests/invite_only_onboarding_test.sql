BEGIN;
SELECT plan(22);

insert into public.tenants (id, slug, name)
values
  ('00000000-0000-0000-0000-000000000501', 'invite-alpha', 'Invite Alpha'),
  ('00000000-0000-0000-0000-000000000502', 'invite-beta', 'Invite Beta');

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
    '00000000-0000-0000-0000-000000000601',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'admin@invite-alpha.test',
    now(),
    '{"provider":"google","providers":["google"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000602',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'member@invite-alpha.test',
    now(),
    '{"provider":"google","providers":["google"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000603',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'invitee@invite-alpha.test',
    now(),
    '{"provider":"google","providers":["google"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000604',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'wrong@invite-alpha.test',
    now(),
    '{"provider":"google","providers":["google"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000605',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'owner-no-exp@invite-alpha.test',
    now(),
    '{"provider":"google","providers":["google"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

insert into public.users (id, tenant_id, email, display_name, role, status)
values
  (
    '00000000-0000-0000-0000-000000000601',
    '00000000-0000-0000-0000-000000000501',
    'admin@invite-alpha.test',
    'Invite Alpha Admin',
    'admin',
    'active'
  ),
  (
    '00000000-0000-0000-0000-000000000602',
    '00000000-0000-0000-0000-000000000501',
    'member@invite-alpha.test',
    'Invite Alpha Member',
    'member',
    'active'
  );

create temporary table test_errors (
  label text primary key,
  message text not null
) on commit drop;

grant all on test_errors to authenticated;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',
    '00000000-0000-0000-0000-000000000601',
    'email',
    'admin@invite-alpha.test',
    'role',
    'authenticated',
    'tenant_id',
    '00000000-0000-0000-0000-000000000501',
    'tenant_role',
    'admin'
  )::text,
  true
);

set local role authenticated;

create temporary table created_invite on commit drop as
select *
from public.create_tenant_invite(
  'Invitee@Invite-Alpha.Test',
  'member',
  null,
  now() + interval '1 day',
  '{"source":"pgtap"}'::jsonb
);

SELECT ok(
  (select length(invite_token) >= 32 from created_invite),
  'Admin invite creation returns a one-time token'
);

SELECT is(
  (
    select count(*)::integer
    from public.tenant_invites ti
    join created_invite ci on ci.invite_id = ti.id
    where ti.status = 'pending'
      and ti.email = 'invitee@invite-alpha.test'
  ),
  1,
  'Invite is stored as pending for normalized email'
);

reset role;

SELECT ok(
  (
    select length(ti.token_hash) = 64
      and ti.token_hash <> ci.invite_token
    from public.tenant_invites ti
    join created_invite ci on ci.invite_id = ti.id
  ),
  'Invite stores only a SHA-256 token hash'
);

SELECT ok(
  not has_column_privilege(
    'authenticated',
    'public.tenant_invites',
    'token_hash',
    'select'
  ),
  'Authenticated API clients cannot select invite token_hash'
);

SELECT ok(
  not has_function_privilege('anon', 'public.accept_tenant_invite(text)', 'execute'),
  'Anon clients cannot execute the public invite accept RPC'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',
    '00000000-0000-0000-0000-000000000601',
    'email',
    'admin@invite-alpha.test',
    'role',
    'authenticated',
    'tenant_id',
    '00000000-0000-0000-0000-000000000501',
    'tenant_role',
    'admin'
  )::text,
  true
);

set local role authenticated;

SELECT is(
  (select count(*)::integer from public.tenant_invites),
  1,
  'Tenant admin can list own tenant invites'
);

reset role;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',
    '00000000-0000-0000-0000-000000000602',
    'email',
    'member@invite-alpha.test',
    'role',
    'authenticated',
    'tenant_id',
    '00000000-0000-0000-0000-000000000501',
    'tenant_role',
    'member'
  )::text,
  true
);

set local role authenticated;

do $$
begin
  perform *
  from public.create_tenant_invite(
    'blocked@invite-alpha.test',
    'member',
    null,
    now() + interval '1 day',
    '{}'::jsonb
  );
exception
  when others then
    insert into test_errors (label, message)
    values ('member_create_invite', sqlerrm);
end;
$$;

SELECT is(
  (select message from test_errors where label = 'member_create_invite'),
  'Only tenant admins can create invites',
  'Non-admin tenant members cannot create invites'
);

reset role;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',
    '00000000-0000-0000-0000-000000000601',
    'email',
    'admin@invite-alpha.test',
    'role',
    'authenticated',
    'tenant_id',
    '00000000-0000-0000-0000-000000000501',
    'tenant_role',
    'admin'
  )::text,
  true
);

set local role authenticated;

create temporary table wrong_email_invite on commit drop as
select *
from public.create_tenant_invite(
  'invitee-wrong@invite-alpha.test',
  'member',
  null,
  now() + interval '1 day',
  '{}'::jsonb
);

reset role;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',
    '00000000-0000-0000-0000-000000000604',
    'email',
    'wrong@invite-alpha.test',
    'role',
    'authenticated',
    'name',
    'Wrong User'
  )::text,
  true
);

set local role authenticated;

do $$
begin
  perform *
  from public.accept_tenant_invite((select invite_token from wrong_email_invite));
exception
  when others then
    insert into test_errors (label, message)
    values ('wrong_email_accept', sqlerrm);
end;
$$;

SELECT is(
  (select message from test_errors where label = 'wrong_email_accept'),
  'Invite email does not match authenticated user',
  'Invite token cannot be accepted by another Google email'
);

reset role;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',
    '00000000-0000-0000-0000-000000000603',
    'email',
    'invitee@invite-alpha.test',
    'role',
    'authenticated',
    'name',
    'Invitee User',
    'picture',
    'https://example.test/avatar.png'
  )::text,
  true
);

set local role authenticated;

create temporary table accepted_invite on commit drop as
select *
from public.accept_tenant_invite((select invite_token from created_invite));

SELECT is(
  (select tenant_id::text from accepted_invite),
  '00000000-0000-0000-0000-000000000501',
  'Accepting invite returns tenant_id'
);

SELECT is(
  (select tenant_role::text from accepted_invite),
  'member',
  'Accepting invite returns tenant role'
);

reset role;

SELECT is(
  (
    select concat_ws(':', tenant_id::text, role::text, status)
    from public.users
    where id = '00000000-0000-0000-0000-000000000603'
  ),
  '00000000-0000-0000-0000-000000000501:member:active',
  'Accepting invite creates an active tenant user profile'
);

SELECT is(
  (
    select concat_ws(':', status::text, accepted_by::text)
    from public.tenant_invites ti
    join created_invite ci on ci.invite_id = ti.id
  ),
  'accepted:00000000-0000-0000-0000-000000000603',
  'Accepted invite is marked accepted by the authenticated user'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',
    '00000000-0000-0000-0000-000000000603',
    'email',
    'invitee@invite-alpha.test',
    'role',
    'authenticated',
    'name',
    'Invitee User',
    'picture',
    'https://example.test/avatar.png'
  )::text,
  true
);

set local role authenticated;

do $$
begin
  perform *
  from public.accept_tenant_invite((select invite_token from created_invite));
exception
  when others then
    insert into test_errors (label, message)
    values ('reuse_invite', sqlerrm);
end;
$$;

SELECT is(
  (select message from test_errors where label = 'reuse_invite'),
  'Invite is not pending',
  'Accepted invite tokens cannot be reused'
);

reset role;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',
    '00000000-0000-0000-0000-000000000603',
    'email',
    'invitee@invite-alpha.test',
    'role',
    'authenticated',
    'tenant_id',
    '00000000-0000-0000-0000-000000000501',
    'tenant_role',
    'member'
  )::text,
  true
);

set local role authenticated;

SELECT is(
  (select count(*)::integer from public.tenant_invites),
  0,
  'Non-admin accepted users cannot list tenant invites'
);

SELECT is(
  (select count(*)::integer from public.tenants),
  1,
  'Accepted users with refreshed claims can see their tenant'
);

reset role;

SELECT is(
  app.custom_access_token_hook(
    jsonb_build_object(
      'user_id',
      '00000000-0000-0000-0000-000000000603',
      'claims',
      jsonb_build_object(
        'sub',
        '00000000-0000-0000-0000-000000000603',
        'email',
        'invitee@invite-alpha.test',
        'role',
        'authenticated',
        'app_metadata',
        '{}'::jsonb
      )
    )
  ) #>> '{claims,tenant_id}',
  '00000000-0000-0000-0000-000000000501',
  'Custom access token hook adds tenant_id after invite acceptance'
);

SELECT is(
  app.custom_access_token_hook(
    jsonb_build_object(
      'user_id',
      '00000000-0000-0000-0000-000000000603',
      'claims',
      jsonb_build_object(
        'sub',
        '00000000-0000-0000-0000-000000000603',
        'email',
        'invitee@invite-alpha.test',
        'role',
        'authenticated',
        'app_metadata',
        '{}'::jsonb
      )
    )
  ) #>> '{claims,tenant_role}',
  'member',
  'Custom access token hook adds tenant_role after invite acceptance'
);

reset role;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',
    '00000000-0000-0000-0000-000000000601',
    'email',
    'admin@invite-alpha.test',
    'role',
    'service_role'
  )::text,
  true
);

set local role service_role;

create temporary table owner_no_exp_invite on commit drop as
select *
from public.create_tenant_invite(
  'owner-no-exp@invite-alpha.test',
  'owner',
  '00000000-0000-0000-0000-000000000501'
);

grant select on owner_no_exp_invite to authenticated;

SELECT ok(
  (select expires_at is null from owner_no_exp_invite),
  'Owner invites default to no expiration'
);

reset role;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',
    '00000000-0000-0000-0000-000000000605',
    'email',
    'owner-no-exp@invite-alpha.test',
    'role',
    'authenticated',
    'name',
    'Owner No Expiration'
  )::text,
  true
);

set local role authenticated;

create temporary table accepted_owner_no_exp_invite on commit drop as
select *
from public.accept_tenant_invite((select invite_token from owner_no_exp_invite));

SELECT is(
  (select tenant_role::text from accepted_owner_no_exp_invite),
  'owner',
  'Non-expiring owner invite can be accepted'
);

reset role;

SELECT is(
  (
    select concat_ws(':', role::text, status)
    from public.users
    where id = '00000000-0000-0000-0000-000000000605'
  ),
  'owner:active',
  'Accepted non-expiring owner invite creates active owner profile'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',
    '00000000-0000-0000-0000-000000000601',
    'email',
    'admin@invite-alpha.test',
    'role',
    'authenticated',
    'tenant_id',
    '00000000-0000-0000-0000-000000000501',
    'tenant_role',
    'admin'
  )::text,
  true
);

set local role authenticated;

create temporary table revoked_invite on commit drop as
select *
from public.create_tenant_invite(
  'revoke-me@invite-alpha.test',
  'viewer',
  null,
  now() + interval '1 day',
  '{}'::jsonb
);

select public.revoke_tenant_invite((select invite_id from revoked_invite));

SELECT is(
  (
    select status::text
    from public.tenant_invites ti
    join revoked_invite ri on ri.invite_id = ti.id
  ),
  'revoked',
  'Tenant admins can revoke pending invites'
);

reset role;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',
    '00000000-0000-0000-0000-000000000602',
    'email',
    'member@invite-alpha.test',
    'role',
    'authenticated',
    'tenant_id',
    '00000000-0000-0000-0000-000000000501',
    'tenant_role',
    'member'
  )::text,
  true
);

set local role authenticated;

do $$
begin
  perform public.revoke_tenant_invite((select invite_id from wrong_email_invite));
exception
  when others then
    insert into test_errors (label, message)
    values ('member_revoke_invite', sqlerrm);
end;
$$;

SELECT is(
  (select message from test_errors where label = 'member_revoke_invite'),
  'Only tenant admins can revoke invites',
  'Non-admin members cannot revoke invites'
);

SELECT * FROM finish();
ROLLBACK;
