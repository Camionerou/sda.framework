alter table public.tenant_invites
  alter column expires_at drop not null;

alter table public.tenant_invites
  drop constraint if exists tenant_invites_expires_at_check;

alter table public.tenant_invites
  add constraint tenant_invites_expires_at_future_or_null_check
  check (expires_at is null or expires_at > created_at);

create or replace function app.create_tenant_invite(
  _email text,
  _role public.tenant_role default 'member',
  _tenant_id uuid default null,
  _expires_at timestamptz default null,
  _metadata jsonb default '{}'::jsonb
)
returns table (
  invite_id uuid,
  tenant_id uuid,
  email extensions.citext,
  role public.tenant_role,
  invite_token text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_tenant_id uuid;
  normalized_email extensions.citext;
  token text;
  is_service_role boolean;
  effective_expires_at timestamptz;
begin
  normalized_email := lower(trim(_email))::extensions.citext;
  target_tenant_id := coalesce(_tenant_id, (select app.current_tenant_id()));
  is_service_role := coalesce(auth.jwt() ->> 'role', '') = 'service_role'
    or current_user = 'service_role';
  effective_expires_at := case
    when _expires_at is not null then _expires_at
    when _role = 'owner' then null
    else now() + interval '7 days'
  end;

  if target_tenant_id is null then
    raise exception 'Missing tenant_id for invite';
  end if;

  if normalized_email is null or normalized_email::text !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Invalid invite email';
  end if;

  if effective_expires_at is not null and effective_expires_at <= now() then
    raise exception 'Invite expiration must be in the future';
  end if;

  if not is_service_role then
    if target_tenant_id <> (select app.current_tenant_id()) then
      raise exception 'Cannot invite users into another tenant';
    end if;

    if not (select app.is_tenant_admin()) then
      raise exception 'Only tenant admins can create invites';
    end if;

    if _role = 'owner' then
      raise exception 'Only service role can create owner invites';
    end if;
  end if;

  if not exists (
    select 1
    from public.tenants t
    where t.id = target_tenant_id
      and t.status = 'active'
  ) then
    raise exception 'Cannot invite users into an inactive tenant';
  end if;

  token := app.generate_invite_token();

  insert into public.tenant_invites (
    tenant_id,
    email,
    role,
    token_hash,
    invited_by,
    expires_at,
    metadata
  )
  values (
    target_tenant_id,
    normalized_email,
    _role,
    app.hash_invite_token(token),
    auth.uid(),
    effective_expires_at,
    coalesce(_metadata, '{}'::jsonb)
  )
  returning
    id,
    tenant_invites.tenant_id,
    tenant_invites.email,
    tenant_invites.role,
    token,
    tenant_invites.expires_at
  into
    invite_id,
    tenant_id,
    email,
    role,
    invite_token,
    expires_at;

  insert into public.audit_log (tenant_id, actor_id, action, resource_type, resource_id, metadata)
  values (
    target_tenant_id,
    auth.uid(),
    'tenant_invite.created',
    'tenant_invite',
    invite_id,
    jsonb_build_object(
      'email',
      normalized_email,
      'expires_at',
      effective_expires_at,
      'role',
      _role
    )
  );

  return next;
end;
$$;

create or replace function app.accept_tenant_invite(_invite_token text)
returns table (
  tenant_id uuid,
  tenant_role public.tenant_role,
  user_id uuid,
  email extensions.citext
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  invite_record public.tenant_invites%rowtype;
  existing_user record;
  current_user_id uuid;
  current_email extensions.citext;
  display_name text;
  avatar_url text;
begin
  current_user_id := auth.uid();
  current_email := lower(trim(coalesce(auth.jwt() ->> 'email', '')))::extensions.citext;
  display_name := nullif(
    coalesce(
      auth.jwt() ->> 'name',
      auth.jwt() ->> 'full_name',
      auth.jwt() #>> '{user_metadata,name}',
      auth.jwt() #>> '{user_metadata,full_name}'
    ),
    ''
  );
  avatar_url := nullif(
    coalesce(
      auth.jwt() ->> 'avatar_url',
      auth.jwt() ->> 'picture',
      auth.jwt() #>> '{user_metadata,avatar_url}',
      auth.jwt() #>> '{user_metadata,picture}'
    ),
    ''
  );

  if current_user_id is null then
    raise exception 'Authentication required';
  end if;

  if current_email is null or current_email::text = '' then
    raise exception 'Authenticated user email is required';
  end if;

  if nullif(trim(_invite_token), '') is null then
    raise exception 'Invite token is required';
  end if;

  select *
  into invite_record
  from public.tenant_invites ti
  where ti.token_hash = app.hash_invite_token(trim(_invite_token))
  for update;

  if invite_record.id is null then
    raise exception 'Invite not found';
  end if;

  if invite_record.status <> 'pending' then
    raise exception 'Invite is not pending';
  end if;

  if invite_record.expires_at is not null and invite_record.expires_at <= now() then
    raise exception 'Invite has expired';
  end if;

  if invite_record.email <> current_email then
    raise exception 'Invite email does not match authenticated user';
  end if;

  if not exists (
    select 1
    from public.tenants t
    where t.id = invite_record.tenant_id
      and t.status = 'active'
  ) then
    raise exception 'Invite tenant is not active';
  end if;

  select u.id, u.tenant_id, u.status
  into existing_user
  from public.users u
  where u.id = current_user_id
  for update;

  if existing_user.id is not null and existing_user.tenant_id <> invite_record.tenant_id then
    raise exception 'Authenticated user already belongs to another tenant';
  end if;

  if existing_user.id is null then
    insert into public.users (
      id,
      tenant_id,
      email,
      display_name,
      avatar_url,
      role,
      status,
      metadata
    )
    values (
      current_user_id,
      invite_record.tenant_id,
      current_email,
      display_name,
      avatar_url,
      invite_record.role,
      'active',
      jsonb_build_object('accepted_invite_id', invite_record.id)
    );
  else
    update public.users u
    set
      email = current_email,
      display_name = coalesce(u.display_name, display_name),
      avatar_url = coalesce(u.avatar_url, avatar_url),
      role = invite_record.role,
      status = 'active',
      metadata = u.metadata || jsonb_build_object('accepted_invite_id', invite_record.id),
      updated_at = now()
    where u.id = current_user_id;
  end if;

  update public.tenant_invites ti
  set
    status = 'accepted',
    accepted_by = current_user_id,
    accepted_at = now()
  where ti.id = invite_record.id;

  insert into public.audit_log (tenant_id, actor_id, action, resource_type, resource_id, metadata)
  values (
    invite_record.tenant_id,
    current_user_id,
    'tenant_invite.accepted',
    'tenant_invite',
    invite_record.id,
    jsonb_build_object('email', current_email, 'role', invite_record.role)
  );

  tenant_id := invite_record.tenant_id;
  tenant_role := invite_record.role;
  user_id := current_user_id;
  email := current_email;

  return next;
end;
$$;

create or replace function public.create_tenant_invite(
  _email text,
  _role public.tenant_role default 'member',
  _tenant_id uuid default null,
  _expires_at timestamptz default null,
  _metadata jsonb default '{}'::jsonb
)
returns table (
  invite_id uuid,
  tenant_id uuid,
  email extensions.citext,
  role public.tenant_role,
  invite_token text,
  expires_at timestamptz
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from app.create_tenant_invite(_email, _role, _tenant_id, _expires_at, _metadata);
$$;
