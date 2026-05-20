insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'documents',
  'documents',
  false,
  52428800,
  array[
    'application/pdf',
    'text/plain',
    'text/markdown',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword'
  ]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

grant insert, update on public.documents to authenticated;

create policy documents_storage_select_tenant on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = (select app.current_tenant_id())::text
  );

create policy documents_storage_insert_tenant on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = (select app.current_tenant_id())::text
  );

create policy documents_storage_update_tenant on storage.objects
  for update to authenticated
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = (select app.current_tenant_id())::text
  )
  with check (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = (select app.current_tenant_id())::text
  );

create policy documents_storage_delete_admin on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = (select app.current_tenant_id())::text
    and (select app.is_tenant_admin())
  );

create or replace function app.safe_storage_filename(_filename text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select coalesce(
    nullif(
      regexp_replace(
        regexp_replace(lower(trim(_filename)), '[^a-z0-9._-]+', '-', 'g'),
        '(^-+|-+$)',
        '',
        'g'
      ),
      ''
    ),
    'document'
  );
$$;

create or replace function public.create_document_upload(
  _filename text,
  _mime_type text default 'application/pdf',
  _byte_size bigint default null,
  _title text default null,
  _metadata jsonb default '{}'::jsonb
)
returns table (
  document_id uuid,
  tenant_id uuid,
  r2_bucket text,
  r2_key text,
  filename text,
  status public.document_status
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_tenant_id uuid;
  current_user_id uuid;
  new_document_id uuid;
  safe_filename text;
begin
  current_tenant_id := app.current_tenant_id();
  current_user_id := auth.uid();

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
    documents.status
  into
    document_id,
    tenant_id,
    r2_bucket,
    r2_key,
    filename,
    status;

  insert into public.audit_log (tenant_id, actor_id, action, resource_type, resource_id, metadata)
  values (
    current_tenant_id,
    current_user_id,
    'document.upload_created',
    'document',
    new_document_id,
    jsonb_build_object('filename', trim(_filename), 'mime_type', _mime_type)
  );

  return next;
end;
$$;

create or replace function public.mark_document_uploaded(
  _document_id uuid,
  _byte_size bigint default null
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
  updated_record record;
begin
  current_tenant_id := app.current_tenant_id();

  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if current_tenant_id is null then
    raise exception 'Tenant claim is required';
  end if;

  if _byte_size is not null and _byte_size < 0 then
    raise exception 'Document byte_size must be positive';
  end if;

  update public.documents d
  set
    status = 'uploaded',
    byte_size = coalesce(_byte_size, d.byte_size),
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
    jsonb_build_object('byte_size', _byte_size)
  );

  document_id := updated_record.id;
  status := updated_record.status;
  uploaded_at := updated_record.uploaded_at;

  return next;
end;
$$;

grant execute on function public.create_document_upload(text, text, bigint, text, jsonb)
  to authenticated;
grant execute on function public.mark_document_uploaded(uuid, bigint)
  to authenticated;

revoke execute on function public.create_document_upload(text, text, bigint, text, jsonb)
  from anon, public;
revoke execute on function public.mark_document_uploaded(uuid, bigint)
  from anon, public;
grant execute on function app.safe_storage_filename(text)
  to authenticated, service_role;
revoke execute on function app.safe_storage_filename(text)
  from anon, public;
