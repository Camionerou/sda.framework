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
  requested_never_expires boolean;
  requester_tenant_role text;
  effective_expires_at timestamptz;
begin
  normalized_email := lower(trim(_email))::extensions.citext;
  target_tenant_id := coalesce(_tenant_id, (select app.current_tenant_id()));
  is_service_role := coalesce(auth.jwt() ->> 'role', '') = 'service_role'
    or current_user = 'service_role';
  requested_never_expires := coalesce(_metadata, '{}'::jsonb) ->> 'never_expires' = 'true';
  requester_tenant_role := app.current_tenant_role();
  effective_expires_at := case
    when requested_never_expires then null
    when _expires_at is not null then _expires_at
    when _role = 'owner' then null
    when not is_service_role and requester_tenant_role = 'owner' then null
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
      'never_expires',
      effective_expires_at is null,
      'requested_never_expires',
      requested_never_expires,
      'requester_tenant_role',
      requester_tenant_role,
      'role',
      _role
    )
  );

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

grant execute on function public.create_tenant_invite(
  text,
  public.tenant_role,
  uuid,
  timestamptz,
  jsonb
) to authenticated, service_role;

revoke execute on function public.create_tenant_invite(
  text,
  public.tenant_role,
  uuid,
  timestamptz,
  jsonb
) from anon, public;
