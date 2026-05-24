-- Documents RPCs extendidas (Tier 1 040)
-- 1. Mutacion de create_document_upload para aceptar workspace_id + collection_id
-- 2. archive_document / restore_document / move_document / bulk_update_documents

-- drop placeholder de Paso 11
drop function if exists public.archive_document(uuid, jsonb);
drop function if exists public.restore_document(uuid);
-- drop create_document_upload anterior (signature con checksum, sin workspace)
drop function if exists public.create_document_upload(text, text, bigint, text, jsonb, text);

create or replace function public.create_document_upload(
  _filename text,
  _workspace_id uuid,
  _mime_type text default 'application/pdf',
  _byte_size bigint default null,
  _title text default null,
  _metadata jsonb default '{}'::jsonb,
  _checksum_sha256 text default null,
  _collection_id uuid default null,
  _request_context jsonb default '{}'::jsonb
)
returns table (
  document_id uuid,
  tenant_id uuid,
  r2_bucket text,
  r2_key text,
  filename text,
  status public.document_status,
  checksum_sha256 text,
  deduped boolean,
  workspace_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid := app.current_tenant_id();
  current_user_id uuid := auth.uid();
  existing_document public.documents%rowtype;
  new_document_id uuid;
  normalized_checksum text;
  safe_filename text;
  ws_role public.workspace_role;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  if current_tenant_id is null then raise exception 'Tenant claim required'; end if;
  if nullif(trim(_filename), '') is null then raise exception 'Filename required'; end if;
  if _byte_size is not null and _byte_size < 0 then raise exception 'byte_size must be >= 0'; end if;

  -- verificar que el user tiene edit en el workspace destino
  ws_role := app.user_workspace_role(_workspace_id);
  if not (select app.is_tenant_admin())
     and ws_role not in ('workspace_admin', 'workspace_editor') then
    raise exception 'User cannot upload to this workspace';
  end if;

  normalized_checksum := nullif(lower(trim(_checksum_sha256)), '');
  if normalized_checksum is not null and normalized_checksum !~ '^[a-f0-9]{64}$' then
    raise exception 'checksum_sha256 invalid';
  end if;

  -- dedupe por checksum dentro del tenant
  if normalized_checksum is not null then
    select * into existing_document
    from public.documents d
    where d.tenant_id = current_tenant_id
      and d.checksum_sha256 = normalized_checksum
      and d.uploaded_at is not null
      and d.deleted_at is null
      and d.status <> 'archived'
    order by d.created_at desc
    limit 1;
    if existing_document.id is not null then
      perform app.audit_with_context(
        'document.upload_deduped', 'document', existing_document.id,
        jsonb_build_object('filename', trim(_filename), 'checksum', normalized_checksum),
        _request_context);
      document_id := existing_document.id;
      tenant_id := existing_document.tenant_id;
      r2_bucket := existing_document.r2_bucket;
      r2_key := existing_document.r2_key;
      filename := existing_document.filename;
      status := existing_document.status;
      checksum_sha256 := existing_document.checksum_sha256;
      workspace_id := existing_document.workspace_id;
      deduped := true;
      return next;
      return;
    end if;
  end if;

  new_document_id := extensions.gen_random_uuid();
  safe_filename := app.safe_storage_filename(_filename);

  insert into public.documents (
    id, tenant_id, workspace_id, created_by, title, filename, mime_type,
    byte_size, checksum_sha256, r2_bucket, r2_key, status, metadata
  ) values (
    new_document_id, current_tenant_id, _workspace_id, current_user_id,
    nullif(trim(_title), ''), trim(_filename),
    coalesce(nullif(trim(_mime_type), ''), 'application/octet-stream'),
    _byte_size, normalized_checksum, 'documents',
    current_tenant_id::text || '/' || new_document_id::text || '/' || safe_filename,
    'uploading', coalesce(_metadata, '{}'::jsonb)
  );

  if _collection_id is not null then
    insert into public.document_collections (tenant_id, document_id, collection_id, added_by)
    values (current_tenant_id, new_document_id, _collection_id, current_user_id);
  end if;

  perform app.audit_with_context(
    'document.upload_created', 'document', new_document_id,
    jsonb_build_object('filename', trim(_filename), 'workspace_id', _workspace_id,
                       'collection_id', _collection_id),
    _request_context);

  document_id := new_document_id;
  tenant_id := current_tenant_id;
  r2_bucket := 'documents';
  r2_key := current_tenant_id::text || '/' || new_document_id::text || '/' || safe_filename;
  filename := trim(_filename);
  status := 'uploading';
  checksum_sha256 := normalized_checksum;
  workspace_id := _workspace_id;
  deduped := false;
  return next;
end;
$$;

create or replace function public.archive_document(
  _document_id uuid,
  _request_context jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not (select app.user_can_edit_document(_document_id)) then
    raise exception 'No edit permission';
  end if;
  update public.documents
  set deleted_at = now(), deleted_by = auth.uid(), updated_at = now()
  where id = _document_id;
  perform app.audit_with_context(
    'document.archived', 'document', _document_id,
    '{}'::jsonb, _request_context);
end;
$$;

create or replace function public.restore_document(
  _document_id uuid,
  _request_context jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  -- restore solo via tenant admin (decision conservadora)
  if not (select app.is_tenant_admin()) then
    raise exception 'Only tenant admins can restore documents';
  end if;
  update public.documents
  set deleted_at = null, deleted_by = null, updated_at = now()
  where id = _document_id and tenant_id = (select app.current_tenant_id());
  perform app.audit_with_context(
    'document.restored', 'document', _document_id,
    '{}'::jsonb, _request_context);
end;
$$;

create or replace function public.move_document(
  _document_id uuid,
  _to_workspace_id uuid,
  _collection_ids uuid[] default null,
  _request_context jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  ws_role public.workspace_role;
begin
  if not (select app.user_can_edit_document(_document_id)) then
    raise exception 'No edit permission on source';
  end if;
  ws_role := app.user_workspace_role(_to_workspace_id);
  if not (select app.is_tenant_admin())
     and ws_role not in ('workspace_admin', 'workspace_editor') then
    raise exception 'No edit permission on destination workspace';
  end if;

  update public.documents
  set workspace_id = _to_workspace_id, updated_at = now()
  where id = _document_id and tenant_id = (select app.current_tenant_id());

  -- reemplazar collections si se pasa lista
  if _collection_ids is not null then
    delete from public.document_collections where document_id = _document_id;
    if array_length(_collection_ids, 1) > 0 then
      insert into public.document_collections (tenant_id, document_id, collection_id, added_by)
      select (select app.current_tenant_id()), _document_id, cid, auth.uid()
      from unnest(_collection_ids) as cid;
    end if;
  end if;

  perform app.audit_with_context(
    'document.moved', 'document', _document_id,
    jsonb_build_object('to_workspace_id', _to_workspace_id, 'collection_ids', _collection_ids),
    _request_context);
end;
$$;

create or replace function public.bulk_update_documents(
  _document_ids uuid[],
  _patch jsonb,
  _request_context jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  updated_count integer := 0;
  current_tenant_id uuid := app.current_tenant_id();
begin
  -- patch admite: title, metadata, status_reason. workspace_id se cambia via move_document.
  with allowed as (
    select id from public.documents d
    where d.id = any(_document_ids)
      and d.tenant_id = current_tenant_id
      and (select app.user_can_edit_document(d.id))
  )
  update public.documents d
  set title = coalesce(_patch->>'title', title),
      metadata = coalesce(_patch->'metadata', metadata),
      status_reason = coalesce(_patch->>'status_reason', status_reason),
      updated_at = now()
  from allowed
  where d.id = allowed.id;
  get diagnostics updated_count = row_count;

  perform app.audit_with_context(
    'document.bulk_updated', 'document', null,
    jsonb_build_object('ids', _document_ids, 'patch', _patch, 'count', updated_count),
    _request_context);
  return jsonb_build_object('updated', updated_count);
end;
$$;

revoke execute on function public.create_document_upload(text, uuid, text, bigint, text, jsonb, text, uuid, jsonb) from anon, public;
grant execute on function public.create_document_upload(text, uuid, text, bigint, text, jsonb, text, uuid, jsonb) to authenticated;
revoke execute on function public.archive_document(uuid, jsonb) from anon, public;
grant execute on function public.archive_document(uuid, jsonb) to authenticated;
revoke execute on function public.restore_document(uuid, jsonb) from anon, public;
grant execute on function public.restore_document(uuid, jsonb) to authenticated;
revoke execute on function public.move_document(uuid, uuid, uuid[], jsonb) from anon, public;
grant execute on function public.move_document(uuid, uuid, uuid[], jsonb) to authenticated;
revoke execute on function public.bulk_update_documents(uuid[], jsonb, jsonb) from anon, public;
grant execute on function public.bulk_update_documents(uuid[], jsonb, jsonb) to authenticated;
