-- RPCs Groups (Tier 1 038)
--
-- Cinco funciones SECURITY DEFINER para el ciclo de vida de groups y
-- group_memberships a nivel tenant: create / update / archive (soft-delete)
-- y add/remove member. Todas usan app.audit_with_context para registrar
-- la accion en audit_log con _request_context.
--
-- Reglas:
--  - Solo tenant admin (owner/admin) puede operar.
--  - create_group lower-casea el key.
--  - add_group_member valida que el _user_id pertenezca al mismo tenant
--    (FK composite ya lo hace pero damos error mas claro) y UPSERT con
--    ON CONFLICT DO NOTHING.
--  - archive_group es soft-delete (deleted_at = now()).

create or replace function public.create_group(
  _key text,
  _name text,
  _description text default null,
  _metadata jsonb default '{}'::jsonb,
  _request_context jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
  new_id uuid := extensions.gen_random_uuid();
begin
  if not (select app.is_tenant_admin()) then
    raise exception 'Only tenant admins can create groups';
  end if;
  if nullif(trim(_key), '') is null or nullif(trim(_name), '') is null then
    raise exception 'Group key and name required';
  end if;
  insert into public.groups (id, tenant_id, key, name, description, metadata, created_by)
  values (new_id, current_tenant_id, lower(_key), _name, _description,
          coalesce(_metadata, '{}'::jsonb), auth.uid());
  perform app.audit_with_context(
    'group.created', 'group', new_id,
    jsonb_build_object('key', _key, 'name', _name), _request_context);
  return new_id;
end;
$$;

create or replace function public.update_group(
  _group_id uuid,
  _patch jsonb,
  _request_context jsonb default '{}'::jsonb
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select app.is_tenant_admin()) then
    raise exception 'Only admins can update groups';
  end if;
  update public.groups
  set name = coalesce(_patch->>'name', name),
      description = coalesce(_patch->>'description', description),
      metadata = coalesce(_patch->'metadata', metadata),
      updated_at = now()
  where id = _group_id and tenant_id = (select app.current_tenant_id());
  perform app.audit_with_context(
    'group.updated', 'group', _group_id,
    jsonb_build_object('patch', _patch), _request_context);
end;
$$;

create or replace function public.archive_group(
  _group_id uuid,
  _request_context jsonb default '{}'::jsonb
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select app.is_tenant_admin()) then
    raise exception 'Only admins can archive groups';
  end if;
  update public.groups
  set deleted_at = now(), updated_at = now()
  where id = _group_id and tenant_id = (select app.current_tenant_id());
  perform app.audit_with_context(
    'group.archived', 'group', _group_id, '{}'::jsonb, _request_context);
end;
$$;

create or replace function public.add_group_member(
  _group_id uuid,
  _user_id uuid,
  _request_context jsonb default '{}'::jsonb
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
begin
  if not (select app.is_tenant_admin()) then
    raise exception 'Only admins can add group members';
  end if;
  -- verificar que el user pertenece al mismo tenant
  if not exists (
    select 1 from public.users u
    where u.id = _user_id and u.tenant_id = current_tenant_id
  ) then
    raise exception 'User does not belong to this tenant';
  end if;
  insert into public.group_memberships (group_id, user_id, tenant_id, added_by)
  values (_group_id, _user_id, current_tenant_id, auth.uid())
  on conflict (group_id, user_id) do nothing;
  perform app.audit_with_context(
    'group.member_added', 'group_membership', _group_id,
    jsonb_build_object('user_id', _user_id), _request_context);
end;
$$;

create or replace function public.remove_group_member(
  _group_id uuid,
  _user_id uuid,
  _request_context jsonb default '{}'::jsonb
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select app.is_tenant_admin()) then
    raise exception 'Only admins can remove group members';
  end if;
  delete from public.group_memberships
  where group_id = _group_id and user_id = _user_id
    and tenant_id = (select app.current_tenant_id());
  perform app.audit_with_context(
    'group.member_removed', 'group_membership', _group_id,
    jsonb_build_object('user_id', _user_id), _request_context);
end;
$$;

revoke execute on function public.create_group(text, text, text, jsonb, jsonb) from anon, public;
grant execute on function public.create_group(text, text, text, jsonb, jsonb) to authenticated;
revoke execute on function public.update_group(uuid, jsonb, jsonb) from anon, public;
grant execute on function public.update_group(uuid, jsonb, jsonb) to authenticated;
revoke execute on function public.archive_group(uuid, jsonb) from anon, public;
grant execute on function public.archive_group(uuid, jsonb) to authenticated;
revoke execute on function public.add_group_member(uuid, uuid, jsonb) from anon, public;
grant execute on function public.add_group_member(uuid, uuid, jsonb) to authenticated;
revoke execute on function public.remove_group_member(uuid, uuid, jsonb) from anon, public;
grant execute on function public.remove_group_member(uuid, uuid, jsonb) to authenticated;
