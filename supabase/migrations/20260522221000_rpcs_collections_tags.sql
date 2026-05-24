-- RPCs Collections + Tags (Tier 1 039)
--
-- Diez funciones SECURITY DEFINER que cubren el ciclo de vida de collections
-- y tags en la capa tenant + workspace:
--
--  Collections (6):
--    1. create_collection            -- tenant admin O workspace editor/admin
--    2. update_collection            -- tenant admin O workspace editor/admin
--    3. set_collection_visibility    -- 'tenant_public' requiere workspace_admin
--    4. archive_collection           -- soft-delete (deleted_at)
--    5. add_document_to_collection   -- valida user_can_edit_document
--    6. remove_document_from_collection
--
--  Tags (4):
--    7. create_tag                   -- solo tenant admin
--    8. update_tag                   -- solo tenant admin
--    9. tag_document                 -- valida user_can_edit_document
--   10. untag_document
--
-- Todas auditan via app.audit_with_context(_request_context).

create or replace function public.create_collection(
  _workspace_id uuid, _slug text, _name text,
  _description text default null,
  _visibility public.collection_visibility default 'workspace_private',
  _request_context jsonb default '{}'::jsonb
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
  new_id uuid := extensions.gen_random_uuid();
  ws_role public.workspace_role := app.user_workspace_role(_workspace_id);
begin
  if not (select app.is_tenant_admin())
     and ws_role not in ('workspace_admin', 'workspace_editor') then
    raise exception 'Only workspace editor/admin can create collections';
  end if;
  insert into public.collections (
    id, tenant_id, workspace_id, slug, name, description, visibility, created_by
  ) values (
    new_id, current_tenant_id, _workspace_id,
    lower(_slug), _name, _description, _visibility, auth.uid()
  );
  perform app.audit_with_context(
    'collection.created', 'collection', new_id,
    jsonb_build_object('slug', _slug, 'visibility', _visibility),
    _request_context);
  return new_id;
end;
$$;

create or replace function public.update_collection(
  _collection_id uuid, _patch jsonb,
  _request_context jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  c_record public.collections%rowtype;
begin
  select * into c_record from public.collections where id = _collection_id;
  if c_record.id is null then
    raise exception 'Collection not found';
  end if;
  if not (select app.is_tenant_admin())
     and app.user_workspace_role(c_record.workspace_id) not in ('workspace_admin','workspace_editor') then
    raise exception 'Only workspace editor/admin can update collections';
  end if;
  update public.collections
  set name = coalesce(_patch->>'name', name),
      description = coalesce(_patch->>'description', description),
      icon = coalesce(_patch->>'icon', icon),
      color = coalesce(_patch->>'color', color),
      metadata = coalesce(_patch->'metadata', metadata),
      updated_at = now()
  where id = _collection_id;
  perform app.audit_with_context(
    'collection.updated', 'collection', _collection_id,
    jsonb_build_object('patch', _patch), _request_context);
end;
$$;

create or replace function public.set_collection_visibility(
  _collection_id uuid, _visibility public.collection_visibility,
  _request_context jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  c_record public.collections%rowtype;
begin
  select * into c_record from public.collections where id = _collection_id;
  if c_record.id is null then
    raise exception 'Collection not found';
  end if;
  -- cambiar a tenant_public requiere admin del workspace o tenant
  if _visibility = 'tenant_public'
     and not (select app.is_tenant_admin())
     and app.user_workspace_role(c_record.workspace_id) <> 'workspace_admin' then
    raise exception 'Only workspace admin can publish collection to tenant';
  end if;
  update public.collections set visibility = _visibility, updated_at = now()
  where id = _collection_id;
  perform app.audit_with_context(
    'collection.visibility_changed', 'collection', _collection_id,
    jsonb_build_object('from', c_record.visibility, 'to', _visibility),
    _request_context);
end;
$$;

create or replace function public.archive_collection(
  _collection_id uuid,
  _request_context jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  c_record public.collections%rowtype;
begin
  select * into c_record from public.collections where id = _collection_id;
  if c_record.id is null then return; end if;
  if not (select app.is_tenant_admin())
     and app.user_workspace_role(c_record.workspace_id) <> 'workspace_admin' then
    raise exception 'Only workspace admin can archive collections';
  end if;
  update public.collections set deleted_at = now(), updated_at = now()
  where id = _collection_id;
  perform app.audit_with_context(
    'collection.archived', 'collection', _collection_id,
    '{}'::jsonb, _request_context);
end;
$$;

create or replace function public.add_document_to_collection(
  _document_id uuid, _collection_id uuid,
  _request_context jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
begin
  if not (select app.user_can_edit_document(_document_id)) then
    raise exception 'No edit permission on document';
  end if;
  insert into public.document_collections (
    tenant_id, document_id, collection_id, added_by
  ) values (current_tenant_id, _document_id, _collection_id, auth.uid())
  on conflict do nothing;
  perform app.audit_with_context(
    'document.added_to_collection', 'document', _document_id,
    jsonb_build_object('collection_id', _collection_id), _request_context);
end;
$$;

create or replace function public.remove_document_from_collection(
  _document_id uuid, _collection_id uuid,
  _request_context jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not (select app.user_can_edit_document(_document_id)) then
    raise exception 'No edit permission on document';
  end if;
  delete from public.document_collections
  where document_id = _document_id and collection_id = _collection_id;
  perform app.audit_with_context(
    'document.removed_from_collection', 'document', _document_id,
    jsonb_build_object('collection_id', _collection_id), _request_context);
end;
$$;

create or replace function public.create_tag(
  _key text, _label text, _color text default null,
  _description text default null,
  _request_context jsonb default '{}'::jsonb
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
  new_id uuid := extensions.gen_random_uuid();
begin
  if not (select app.is_tenant_admin()) then
    raise exception 'Only admins can create tags';
  end if;
  insert into public.tags (id, tenant_id, key, label, color, description, created_by)
  values (new_id, current_tenant_id, lower(_key), _label, _color, _description, auth.uid());
  perform app.audit_with_context(
    'tag.created', 'tag', new_id,
    jsonb_build_object('key', _key, 'label', _label), _request_context);
  return new_id;
end;
$$;

create or replace function public.update_tag(
  _tag_id uuid, _patch jsonb,
  _request_context jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not (select app.is_tenant_admin()) then
    raise exception 'Only admins can update tags';
  end if;
  update public.tags
  set label = coalesce(_patch->>'label', label),
      color = coalesce(_patch->>'color', color),
      description = coalesce(_patch->>'description', description),
      updated_at = now()
  where id = _tag_id and tenant_id = (select app.current_tenant_id());
  perform app.audit_with_context(
    'tag.updated', 'tag', _tag_id,
    jsonb_build_object('patch', _patch), _request_context);
end;
$$;

create or replace function public.tag_document(
  _document_id uuid, _tag_id uuid,
  _request_context jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not (select app.user_can_edit_document(_document_id)) then
    raise exception 'No edit permission';
  end if;
  insert into public.document_tags (tenant_id, document_id, tag_id, added_by)
  values ((select app.current_tenant_id()), _document_id, _tag_id, auth.uid())
  on conflict do nothing;
  perform app.audit_with_context(
    'document.tagged', 'document', _document_id,
    jsonb_build_object('tag_id', _tag_id), _request_context);
end;
$$;

create or replace function public.untag_document(
  _document_id uuid, _tag_id uuid,
  _request_context jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not (select app.user_can_edit_document(_document_id)) then
    raise exception 'No edit permission';
  end if;
  delete from public.document_tags
  where document_id = _document_id and tag_id = _tag_id;
  perform app.audit_with_context(
    'document.untagged', 'document', _document_id,
    jsonb_build_object('tag_id', _tag_id), _request_context);
end;
$$;

-- grants
revoke execute on function public.create_collection(uuid, text, text, text, public.collection_visibility, jsonb) from anon, public;
grant execute on function public.create_collection(uuid, text, text, text, public.collection_visibility, jsonb) to authenticated;
revoke execute on function public.update_collection(uuid, jsonb, jsonb) from anon, public;
grant execute on function public.update_collection(uuid, jsonb, jsonb) to authenticated;
revoke execute on function public.set_collection_visibility(uuid, public.collection_visibility, jsonb) from anon, public;
grant execute on function public.set_collection_visibility(uuid, public.collection_visibility, jsonb) to authenticated;
revoke execute on function public.archive_collection(uuid, jsonb) from anon, public;
grant execute on function public.archive_collection(uuid, jsonb) to authenticated;
revoke execute on function public.add_document_to_collection(uuid, uuid, jsonb) from anon, public;
grant execute on function public.add_document_to_collection(uuid, uuid, jsonb) to authenticated;
revoke execute on function public.remove_document_from_collection(uuid, uuid, jsonb) from anon, public;
grant execute on function public.remove_document_from_collection(uuid, uuid, jsonb) to authenticated;
revoke execute on function public.create_tag(text, text, text, text, jsonb) from anon, public;
grant execute on function public.create_tag(text, text, text, text, jsonb) to authenticated;
revoke execute on function public.update_tag(uuid, jsonb, jsonb) from anon, public;
grant execute on function public.update_tag(uuid, jsonb, jsonb) to authenticated;
revoke execute on function public.tag_document(uuid, uuid, jsonb) from anon, public;
grant execute on function public.tag_document(uuid, uuid, jsonb) to authenticated;
revoke execute on function public.untag_document(uuid, uuid, jsonb) from anon, public;
grant execute on function public.untag_document(uuid, uuid, jsonb) to authenticated;
