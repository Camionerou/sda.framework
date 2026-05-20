create or replace function public.request_document_indexing(
  _document_id uuid,
  _metadata jsonb default '{}'::jsonb
)
returns table (
  run_id uuid,
  document_id uuid,
  status text,
  stage text,
  progress integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_tenant_id uuid;
  current_user_id uuid;
  document_record public.documents%rowtype;
  active_run public.indexing_runs%rowtype;
  new_run_id uuid;
begin
  current_tenant_id := app.current_tenant_id();
  current_user_id := auth.uid();

  if current_user_id is null then
    raise exception 'Authentication required';
  end if;

  if current_tenant_id is null then
    raise exception 'Tenant claim is required';
  end if;

  select d.*
  into document_record
  from public.documents d
  where d.id = _document_id
    and d.tenant_id = current_tenant_id
  for update;

  if document_record.id is null then
    raise exception 'Document not found';
  end if;

  if document_record.uploaded_at is null then
    raise exception 'Document upload is not complete';
  end if;

  if nullif(document_record.r2_bucket, '') is null or nullif(document_record.r2_key, '') is null then
    raise exception 'Document storage reference is incomplete';
  end if;

  if document_record.status not in ('uploaded', 'queued', 'failed', 'indexed') then
    raise exception 'Document is not ready for indexing';
  end if;

  select r.*
  into active_run
  from public.indexing_runs r
  where r.document_id = document_record.id
    and r.tenant_id = current_tenant_id
    and r.status in ('queued', 'running')
  order by r.created_at desc
  limit 1;

  if active_run.id is not null then
    run_id := active_run.id;
    document_id := active_run.document_id;
    status := active_run.status;
    stage := active_run.stage;
    progress := active_run.progress;
    return next;
    return;
  end if;

  insert into public.indexing_runs (
    tenant_id,
    document_id,
    status,
    stage,
    progress,
    metadata
  )
  values (
    current_tenant_id,
    document_record.id,
    'queued',
    'queued',
    0,
    jsonb_build_object(
      'requested_by', current_user_id,
      'source', 'app'
    ) || coalesce(_metadata, '{}'::jsonb)
  )
  returning id into new_run_id;

  insert into public.indexing_events (
    tenant_id,
    document_id,
    run_id,
    event_type,
    stage,
    severity,
    message,
    progress,
    metadata
  )
  values (
    current_tenant_id,
    document_record.id,
    new_run_id,
    'indexing.run.queued',
    'queued',
    'info',
    'Documento en cola para indexacion',
    0,
    jsonb_build_object('requested_by', current_user_id)
  );

  update public.documents d
  set
    status = 'queued',
    status_reason = 'Indexacion en cola'
  where d.id = document_record.id
    and d.tenant_id = current_tenant_id;

  insert into public.audit_log (tenant_id, actor_id, action, resource_type, resource_id, metadata)
  values (
    current_tenant_id,
    current_user_id,
    'document.indexing_requested',
    'document',
    document_record.id,
    jsonb_build_object('run_id', new_run_id)
  );

  run_id := new_run_id;
  document_id := document_record.id;
  status := 'queued';
  stage := 'queued';
  progress := 0;
  return next;
end;
$$;
