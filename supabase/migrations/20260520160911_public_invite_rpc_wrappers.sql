create or replace function public.create_tenant_invite(
  _email text,
  _role public.tenant_role default 'member',
  _tenant_id uuid default null,
  _expires_at timestamptz default (now() + interval '7 days'),
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

create or replace function public.accept_tenant_invite(_invite_token text)
returns table (
  tenant_id uuid,
  tenant_role public.tenant_role,
  user_id uuid,
  email extensions.citext
)
language sql
security invoker
set search_path = ''
as $$
  select *
  from app.accept_tenant_invite(_invite_token);
$$;

create or replace function public.revoke_tenant_invite(_invite_id uuid)
returns void
language sql
security invoker
set search_path = ''
as $$
  select app.revoke_tenant_invite(_invite_id);
$$;

grant execute on function public.create_tenant_invite(
  text,
  public.tenant_role,
  uuid,
  timestamptz,
  jsonb
) to authenticated, service_role;
grant execute on function public.accept_tenant_invite(text) to authenticated;
grant execute on function public.revoke_tenant_invite(uuid) to authenticated, service_role;

revoke execute on function public.create_tenant_invite(
  text,
  public.tenant_role,
  uuid,
  timestamptz,
  jsonb
) from anon, public;
revoke execute on function public.accept_tenant_invite(text) from anon, public;
revoke execute on function public.revoke_tenant_invite(uuid) from anon, public;
