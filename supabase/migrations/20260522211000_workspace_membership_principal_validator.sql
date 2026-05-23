-- 030.c — trigger validator polymorphic FK para workspace_memberships.
-- Postgres no soporta FK polymorphic. Sin este trigger se pueden insertar
-- uuids fantasma o cross-tenant.

create or replace function app.check_workspace_membership_principal()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  exists_principal boolean;
begin
  if new.principal_kind = 'user' then
    select exists (
      select 1 from public.users u
      where u.id = new.principal_id
        and u.tenant_id = new.tenant_id
    ) into exists_principal;

    if not exists_principal then
      raise exception 'workspace_membership principal user % not found in tenant %',
        new.principal_id, new.tenant_id
        using errcode = 'P0001';
    end if;

  elsif new.principal_kind = 'group' then
    select exists (
      select 1 from public.groups g
      where g.id = new.principal_id
        and g.tenant_id = new.tenant_id
        and g.deleted_at is null
    ) into exists_principal;

    if not exists_principal then
      raise exception 'workspace_membership principal group % not found in tenant %',
        new.principal_id, new.tenant_id
        using errcode = 'P0001';
    end if;

  else
    raise exception 'workspace_membership unsupported principal_kind %', new.principal_kind
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists check_workspace_membership_principal
  on public.workspace_memberships;

create trigger check_workspace_membership_principal
before insert or update of principal_kind, principal_id, tenant_id
on public.workspace_memberships
for each row execute function app.check_workspace_membership_principal();
