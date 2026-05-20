create or replace function public.mark_document_upload_failed(
  _document_id uuid,
  _reason text default 'Upload failed'
)
returns table (
  document_id uuid,
  status public.document_status,
  status_reason text
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_tenant_id uuid;
  normalized_reason text;
  updated_record record;
begin
  current_tenant_id := app.current_tenant_id();
  normalized_reason := coalesce(nullif(trim(_reason), ''), 'Upload failed');

  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if current_tenant_id is null then
    raise exception 'Tenant claim is required';
  end if;

  update public.documents d
  set
    status = 'failed',
    status_reason = left(normalized_reason, 500)
  where d.id = _document_id
    and d.tenant_id = current_tenant_id
    and d.status = 'uploading'
    and d.uploaded_at is null
  returning d.id, d.status, d.status_reason
  into updated_record;

  if updated_record.id is null then
    raise exception 'Document upload not found or cannot be marked failed';
  end if;

  insert into public.audit_log (tenant_id, actor_id, action, resource_type, resource_id, metadata)
  values (
    current_tenant_id,
    auth.uid(),
    'document.upload_failed',
    'document',
    _document_id,
    jsonb_build_object('reason', left(normalized_reason, 500))
  );

  document_id := updated_record.id;
  status := updated_record.status;
  status_reason := updated_record.status_reason;

  return next;
end;
$$;

grant execute on function public.mark_document_upload_failed(uuid, text)
  to authenticated;

revoke execute on function public.mark_document_upload_failed(uuid, text)
  from anon, public;
