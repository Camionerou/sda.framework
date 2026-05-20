create index if not exists documents_tenant_checksum_uploaded_idx
  on public.documents (tenant_id, checksum_sha256)
  where checksum_sha256 is not null
    and uploaded_at is not null
    and status <> 'archived';

drop function if exists public.create_document_upload(text, text, bigint, text, jsonb);

create or replace function public.create_document_upload(
  _filename text,
  _mime_type text default 'application/pdf',
  _byte_size bigint default null,
  _title text default null,
  _metadata jsonb default '{}'::jsonb,
  _checksum_sha256 text default null
)
returns table (
  document_id uuid,
  tenant_id uuid,
  r2_bucket text,
  r2_key text,
  filename text,
  status public.document_status,
  checksum_sha256 text,
  deduped boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_tenant_id uuid;
  current_user_id uuid;
  existing_document public.documents%rowtype;
  new_document_id uuid;
  normalized_checksum text;
  safe_filename text;
begin
  current_tenant_id := app.current_tenant_id();
  current_user_id := auth.uid();
  normalized_checksum := nullif(lower(trim(_checksum_sha256)), '');

  if current_user_id is null then
    raise exception 'Authentication required';
  end if;

  if current_tenant_id is null then
    raise exception 'Tenant claim is required';
  end if;

  if nullif(trim(_filename), '') is null then
    raise exception 'Document filename is required';
  end if;

  if _byte_size is not null and _byte_size < 0 then
    raise exception 'Document byte_size must be positive';
  end if;

  if normalized_checksum is not null and normalized_checksum !~ '^[a-f0-9]{64}$' then
    raise exception 'Document checksum_sha256 is invalid';
  end if;

  if normalized_checksum is not null then
    select d.*
    into existing_document
    from public.documents d
    where d.tenant_id = current_tenant_id
      and d.checksum_sha256 = normalized_checksum
      and d.uploaded_at is not null
      and d.status <> 'archived'
    order by d.created_at desc
    limit 1;

    if existing_document.id is not null then
      insert into public.audit_log (tenant_id, actor_id, action, resource_type, resource_id, metadata)
      values (
        current_tenant_id,
        current_user_id,
        'document.upload_deduped',
        'document',
        existing_document.id,
        jsonb_build_object(
          'filename',
          trim(_filename),
          'checksum_sha256',
          normalized_checksum
        )
      );

      document_id := existing_document.id;
      tenant_id := existing_document.tenant_id;
      r2_bucket := existing_document.r2_bucket;
      r2_key := existing_document.r2_key;
      filename := existing_document.filename;
      status := existing_document.status;
      checksum_sha256 := existing_document.checksum_sha256;
      deduped := true;
      return next;
      return;
    end if;
  end if;

  new_document_id := extensions.gen_random_uuid();
  safe_filename := app.safe_storage_filename(_filename);

  insert into public.documents (
    id,
    tenant_id,
    created_by,
    title,
    filename,
    mime_type,
    byte_size,
    checksum_sha256,
    r2_bucket,
    r2_key,
    status,
    metadata
  )
  values (
    new_document_id,
    current_tenant_id,
    current_user_id,
    nullif(trim(_title), ''),
    trim(_filename),
    coalesce(nullif(trim(_mime_type), ''), 'application/octet-stream'),
    _byte_size,
    normalized_checksum,
    'documents',
    current_tenant_id::text || '/' || new_document_id::text || '/' || safe_filename,
    'uploading',
    coalesce(_metadata, '{}'::jsonb)
  )
  returning
    documents.id,
    documents.tenant_id,
    documents.r2_bucket,
    documents.r2_key,
    documents.filename,
    documents.status,
    documents.checksum_sha256
  into
    document_id,
    tenant_id,
    r2_bucket,
    r2_key,
    filename,
    status,
    checksum_sha256;

  deduped := false;

  insert into public.audit_log (tenant_id, actor_id, action, resource_type, resource_id, metadata)
  values (
    current_tenant_id,
    current_user_id,
    'document.upload_created',
    'document',
    new_document_id,
    jsonb_build_object(
      'checksum_sha256',
      normalized_checksum,
      'filename',
      trim(_filename),
      'mime_type',
      _mime_type
    )
  );

  return next;
end;
$$;

drop function if exists public.mark_document_uploaded(uuid, bigint);

create or replace function public.mark_document_uploaded(
  _document_id uuid,
  _byte_size bigint default null,
  _checksum_sha256 text default null
)
returns table (
  document_id uuid,
  status public.document_status,
  uploaded_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_tenant_id uuid;
  normalized_checksum text;
  updated_record record;
begin
  current_tenant_id := app.current_tenant_id();
  normalized_checksum := nullif(lower(trim(_checksum_sha256)), '');

  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if current_tenant_id is null then
    raise exception 'Tenant claim is required';
  end if;

  if _byte_size is not null and _byte_size < 0 then
    raise exception 'Document byte_size must be positive';
  end if;

  if normalized_checksum is not null and normalized_checksum !~ '^[a-f0-9]{64}$' then
    raise exception 'Document checksum_sha256 is invalid';
  end if;

  update public.documents d
  set
    status = 'uploaded',
    byte_size = coalesce(_byte_size, d.byte_size),
    checksum_sha256 = coalesce(normalized_checksum, d.checksum_sha256),
    uploaded_at = now(),
    status_reason = null
  where d.id = _document_id
    and d.tenant_id = current_tenant_id
  returning d.id, d.status, d.uploaded_at
  into updated_record;

  if updated_record.id is null then
    raise exception 'Document not found';
  end if;

  insert into public.audit_log (tenant_id, actor_id, action, resource_type, resource_id, metadata)
  values (
    current_tenant_id,
    auth.uid(),
    'document.uploaded',
    'document',
    _document_id,
    jsonb_build_object(
      'byte_size',
      _byte_size,
      'checksum_sha256',
      normalized_checksum
    )
  );

  document_id := updated_record.id;
  status := updated_record.status;
  uploaded_at := updated_record.uploaded_at;

  return next;
end;
$$;

grant execute on function public.create_document_upload(text, text, bigint, text, jsonb, text)
  to authenticated;
grant execute on function public.mark_document_uploaded(uuid, bigint, text)
  to authenticated;

revoke execute on function public.create_document_upload(text, text, bigint, text, jsonb, text)
  from anon, public;
revoke execute on function public.mark_document_uploaded(uuid, bigint, text)
  from anon, public;
