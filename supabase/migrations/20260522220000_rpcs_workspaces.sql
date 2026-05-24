-- RPCs Workspaces (Tier 1 037)
--
-- Ocho funciones SECURITY DEFINER que implementan el ciclo de vida de
-- workspaces y memberships, mas set_active_workspace para cambiar el
-- workspace activo del JWT siguiente. Todas usan app.audit_with_context
-- para registrar la accion en audit_log con _request_context.

create or replace function public.create_workspace(
  _name text,
  _slug text default null,
  _description text default null,
  _settings jsonb default '{}'::jsonb,
  _request_context jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
  current_user_id uuid := auth.uid();
  derived_slug text;
  new_id uuid := extensions.gen_random_uuid();
begin
  if current_user_id is null then
    raise exception 'Authentication required';
  end if;
  if current_tenant_id is null then
    raise exception 'Tenant claim is required';
  end if;
  if not (select app.is_tenant_admin()) then
    raise exception 'Only tenant admins can create workspaces';
  end if;
  if nullif(trim(_name), '') is null then
    raise exception 'Workspace name is required';
  end if;

  derived_slug := coalesce(
    nullif(lower(regexp_replace(_slug, '[^a-zA-Z0-9_-]+', '-', 'g')), ''),
    regexp_replace(lower(_name), '[^a-z0-9_-]+', '-', 'g')
  );

  insert into public.workspaces (
    id, tenant_id, slug, name, description, settings, created_by
  ) values (
    new_id, current_tenant_id, derived_slug, _name, _description,
    coalesce(_settings, '{}'::jsonb), current_user_id
  );

  -- el creador queda como workspace_admin
  insert into public.workspace_memberships (
    workspace_id, tenant_id, principal_kind, principal_id, role, added_by
  ) values (
    new_id, current_tenant_id, 'user', current_user_id, 'workspace_admin', current_user_id
  );

  perform app.audit_with_context(
    'workspace.created', 'workspace', new_id,
    jsonb_build_object('name', _name, 'slug', derived_slug),
    _request_context
  );

  return new_id;
end;
$$;

create or replace function public.update_workspace(
  _workspace_id uuid,
  _patch jsonb,
  _request_context jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
  ws_role public.workspace_role;
begin
  if current_tenant_id is null then
    raise exception 'Tenant claim is required';
  end if;
  ws_role := app.user_workspace_role(_workspace_id);
  if not (select app.is_tenant_admin()) and ws_role is distinct from 'workspace_admin' then
    raise exception 'Only workspace admins can update workspace';
  end if;

  update public.workspaces
  set
    name = coalesce(_patch->>'name', name),
    description = coalesce(_patch->>'description', description),
    settings = coalesce(_patch->'settings', settings),
    updated_at = now()
  where id = _workspace_id
    and tenant_id = current_tenant_id;

  perform app.audit_with_context(
    'workspace.updated', 'workspace', _workspace_id,
    jsonb_build_object('patch', _patch),
    _request_context
  );
end;
$$;

create or replace function public.archive_workspace(
  _workspace_id uuid,
  _request_context jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
begin
  if not (select app.is_tenant_admin())
     and app.user_workspace_role(_workspace_id) is distinct from 'workspace_admin' then
    raise exception 'Only admins can archive workspace';
  end if;

  update public.workspaces
  set status = 'archived', archived_at = now(), updated_at = now()
  where id = _workspace_id and tenant_id = current_tenant_id;

  perform app.audit_with_context(
    'workspace.archived', 'workspace', _workspace_id,
    '{}'::jsonb, _request_context
  );
end;
$$;

create or replace function public.delete_workspace(
  _workspace_id uuid,
  _request_context jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
begin
  if not (select app.is_tenant_admin()) then
    raise exception 'Only tenant admins can delete workspace';
  end if;

  update public.workspaces
  set deleted_at = now(), updated_at = now()
  where id = _workspace_id and tenant_id = current_tenant_id;

  perform app.audit_with_context(
    'workspace.deleted', 'workspace', _workspace_id,
    '{}'::jsonb, _request_context
  );
end;
$$;

create or replace function public.add_workspace_member(
  _workspace_id uuid,
  _principal_kind public.principal_kind,
  _principal_id uuid,
  _role public.workspace_role default 'workspace_viewer',
  _request_context jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
begin
  if not (select app.is_tenant_admin())
     and app.user_workspace_role(_workspace_id) is distinct from 'workspace_admin' then
    raise exception 'Only workspace admins can add members';
  end if;

  insert into public.workspace_memberships (
    workspace_id, tenant_id, principal_kind, principal_id, role, added_by
  ) values (
    _workspace_id, current_tenant_id, _principal_kind, _principal_id, _role, auth.uid()
  )
  on conflict (workspace_id, principal_kind, principal_id) do update
    set role = excluded.role;

  perform app.audit_with_context(
    'workspace.member_added', 'workspace_membership', _workspace_id,
    jsonb_build_object('principal_kind', _principal_kind, 'principal_id', _principal_id, 'role', _role),
    _request_context
  );
end;
$$;

create or replace function public.remove_workspace_member(
  _workspace_id uuid,
  _principal_kind public.principal_kind,
  _principal_id uuid,
  _request_context jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
begin
  if not (select app.is_tenant_admin())
     and app.user_workspace_role(_workspace_id) is distinct from 'workspace_admin' then
    raise exception 'Only workspace admins can remove members';
  end if;

  delete from public.workspace_memberships
  where workspace_id = _workspace_id
    and tenant_id = current_tenant_id
    and principal_kind = _principal_kind
    and principal_id = _principal_id;

  perform app.audit_with_context(
    'workspace.member_removed', 'workspace_membership', _workspace_id,
    jsonb_build_object('principal_kind', _principal_kind, 'principal_id', _principal_id),
    _request_context
  );
end;
$$;

create or replace function public.change_workspace_member_role(
  _workspace_id uuid,
  _principal_kind public.principal_kind,
  _principal_id uuid,
  _role public.workspace_role,
  _request_context jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
begin
  if not (select app.is_tenant_admin())
     and app.user_workspace_role(_workspace_id) is distinct from 'workspace_admin' then
    raise exception 'Only workspace admins can change member role';
  end if;

  update public.workspace_memberships
  set role = _role
  where workspace_id = _workspace_id
    and tenant_id = current_tenant_id
    and principal_kind = _principal_kind
    and principal_id = _principal_id;

  perform app.audit_with_context(
    'workspace.member_role_changed', 'workspace_membership', _workspace_id,
    jsonb_build_object('principal_kind', _principal_kind, 'principal_id', _principal_id, 'role', _role),
    _request_context
  );
end;
$$;

create or replace function public.set_active_workspace(_workspace_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then
    raise exception 'Authentication required';
  end if;
  if not (select app.user_belongs_to_workspace(_workspace_id))
     and not (select app.is_tenant_admin()) then
    raise exception 'User does not belong to workspace';
  end if;

  -- Actualizar user_metadata. La proxima emision del JWT (via supabase auth
  -- refresh) tomara el nuevo active_workspace_id desde el hook.
  update auth.users
  set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb)
                            || jsonb_build_object('active_workspace_id', _workspace_id::text)
  where id = current_user_id;
end;
$$;

revoke execute on function public.create_workspace(text, text, text, jsonb, jsonb) from anon, public;
grant execute on function public.create_workspace(text, text, text, jsonb, jsonb) to authenticated;
revoke execute on function public.update_workspace(uuid, jsonb, jsonb) from anon, public;
grant execute on function public.update_workspace(uuid, jsonb, jsonb) to authenticated;
revoke execute on function public.archive_workspace(uuid, jsonb) from anon, public;
grant execute on function public.archive_workspace(uuid, jsonb) to authenticated;
revoke execute on function public.delete_workspace(uuid, jsonb) from anon, public;
grant execute on function public.delete_workspace(uuid, jsonb) to authenticated;
revoke execute on function public.add_workspace_member(uuid, public.principal_kind, uuid, public.workspace_role, jsonb) from anon, public;
grant execute on function public.add_workspace_member(uuid, public.principal_kind, uuid, public.workspace_role, jsonb) to authenticated;
revoke execute on function public.remove_workspace_member(uuid, public.principal_kind, uuid, jsonb) from anon, public;
grant execute on function public.remove_workspace_member(uuid, public.principal_kind, uuid, jsonb) to authenticated;
revoke execute on function public.change_workspace_member_role(uuid, public.principal_kind, uuid, public.workspace_role, jsonb) from anon, public;
grant execute on function public.change_workspace_member_role(uuid, public.principal_kind, uuid, public.workspace_role, jsonb) to authenticated;
revoke execute on function public.set_active_workspace(uuid) from anon, public;
grant execute on function public.set_active_workspace(uuid) to authenticated;
