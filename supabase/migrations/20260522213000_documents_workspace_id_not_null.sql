-- 031.c — set not null + validar FK + indices definitivos.
-- Pre-requisito: 031.b corrio y todos los documents tienen workspace_id.

-- Validar primero, falla con error claro si quedan NULL
do $$
declare missing integer;
begin
  select count(*) into missing
  from public.documents
  where workspace_id is null;

  if missing > 0 then
    raise exception 'tier1 031.c: % documents quedan sin workspace_id; correr tier1_backfill_default_workspaces() antes de aplicar esta migracion', missing;
  end if;
end;
$$;

alter table public.documents
  alter column workspace_id set not null;

-- Validar la FK que se declaro `not valid` en 031.a
alter table public.documents
  validate constraint documents_workspace_fk;

-- Indice hot-path definitivo
create index if not exists documents_workspace_status_idx
  on public.documents (tenant_id, workspace_id, status, created_at desc)
  where deleted_at is null;

-- Indice para queries de papelera/recovery
create index if not exists documents_deleted_at_idx
  on public.documents (tenant_id, deleted_at)
  where deleted_at is not null;

-- Limpieza de indices intermedios (los que sirvieron al backfill)
drop index if exists public.documents_tenant_workspace_partial_idx;
drop index if exists public.documents_workspace_id_null_idx;

-- Parche minimo a create_document_upload para resolver workspace_id automaticamente
-- al workspace 'default' del tenant. El parametro explicito _workspace_id se agrega
-- en Paso 16 (RPCs). Mantenemos la firma actual para no romper callers existentes.
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
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid;
  current_user_id uuid;
  existing_document public.documents%rowtype;
  new_document_id uuid;
  normalized_checksum text;
  safe_filename text;
  resolved_workspace_id uuid;
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

  select w.id into resolved_workspace_id
  from public.workspaces w
  where w.tenant_id = current_tenant_id
    and w.slug = 'default'
  limit 1;

  if resolved_workspace_id is null then
    raise exception 'create_document_upload: tenant % no tiene workspace default; correr tier1_backfill_default_workspaces()', current_tenant_id;
  end if;

  new_document_id := extensions.gen_random_uuid();
  safe_filename := app.safe_storage_filename(_filename);

  insert into public.documents (
    id,
    tenant_id,
    workspace_id,
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
    resolved_workspace_id,
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

-- Mantener boundary write-only (definido en 20260521120000): la funcion es
-- security definer y restringida a authenticated (anon/public sin execute).
revoke execute on function public.create_document_upload(text, text, bigint, text, jsonb, text)
  from anon, public;
grant execute on function public.create_document_upload(text, text, bigint, text, jsonb, text)
  to authenticated;
