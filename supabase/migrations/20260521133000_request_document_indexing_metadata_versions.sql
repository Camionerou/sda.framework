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
  active_run public.indexing_runs%rowtype;
  app_version text;
  compute_gateway_extraction_version text;
  current_tenant_id uuid;
  current_user_id uuid;
  document_record public.documents%rowtype;
  embedding_pipeline_version text;
  extraction_pipeline_version text;
  indexing_pipeline_version text;
  inngest_indexing_workflow_version text;
  incoming_versions jsonb;
  new_run_id uuid;
  tree_indexer_runtime_version text;
  tree_indexer_version text;
  tree_prompt_version text;
  version_metadata jsonb;
begin
  current_tenant_id := app.current_tenant_id();
  current_user_id := auth.uid();

  if current_user_id is null then
    raise exception 'Authentication required';
  end if;

  if current_tenant_id is null then
    raise exception 'Tenant claim is required';
  end if;

  incoming_versions := coalesce(_metadata -> 'versions', '{}'::jsonb);
  app_version := coalesce(incoming_versions ->> 'app_version', incoming_versions ->> 'app', '0.0.0');
  compute_gateway_extraction_version := coalesce(
    incoming_versions ->> 'compute_gateway_extraction_version',
    incoming_versions ->> 'compute_gateway_extraction',
    '0.0.0'
  );
  embedding_pipeline_version := coalesce(
    incoming_versions ->> 'embedding_pipeline_version',
    incoming_versions ->> 'embedding_pipeline',
    '0.0.0'
  );
  extraction_pipeline_version := coalesce(
    incoming_versions ->> 'extraction_pipeline_version',
    incoming_versions ->> 'extraction_pipeline',
    '0.0.0'
  );
  indexing_pipeline_version := coalesce(
    incoming_versions ->> 'indexing_pipeline_version',
    incoming_versions ->> 'indexing_pipeline',
    '0.0.0'
  );
  inngest_indexing_workflow_version := coalesce(
    incoming_versions ->> 'inngest_indexing_workflow_version',
    incoming_versions ->> 'inngest_indexing_workflow',
    '0.0.0'
  );
  tree_indexer_version := coalesce(
    incoming_versions ->> 'tree_indexer_version',
    incoming_versions ->> 'tree_indexer_python',
    '0.0.0'
  );
  tree_indexer_runtime_version := coalesce(
    incoming_versions ->> 'tree_indexer_runtime_version',
    'sda-pageindex-python-langgraph-v' || tree_indexer_version
  );
  tree_prompt_version := coalesce(
    incoming_versions ->> 'tree_prompt_version',
    incoming_versions ->> 'tree_prompt',
    '0.0.0'
  );

  version_metadata := jsonb_build_object(
    'app_version', app_version,
    'compute_gateway_extraction_version', compute_gateway_extraction_version,
    'embedding_pipeline_version', embedding_pipeline_version,
    'extraction_pipeline_version', extraction_pipeline_version,
    'indexing_pipeline_version', indexing_pipeline_version,
    'inngest_indexing_workflow_version', inngest_indexing_workflow_version,
    'tree_indexer_runtime_version', tree_indexer_runtime_version,
    'tree_indexer_version', tree_indexer_version,
    'tree_prompt_version', tree_prompt_version
  );

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
    embedding_pipeline_version,
    extraction_pipeline_version,
    indexing_pipeline_version,
    metadata,
    progress,
    stage,
    status,
    tenant_id,
    document_id,
    tree_indexer_version
  )
  values (
    embedding_pipeline_version,
    extraction_pipeline_version,
    indexing_pipeline_version,
    jsonb_build_object(
      'requested_by', current_user_id,
      'source', coalesce(_metadata ->> 'source', 'app'),
      'versions', version_metadata
    ) || coalesce(_metadata, '{}'::jsonb),
    0,
    'queued',
    'queued',
    current_tenant_id,
    document_record.id,
    tree_indexer_version
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
    jsonb_build_object(
      'requested_by', current_user_id,
      'versions', version_metadata
    )
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
    jsonb_build_object(
      'run_id', new_run_id,
      'versions', version_metadata
    )
  );

  run_id := new_run_id;
  document_id := document_record.id;
  status := 'queued';
  stage := 'queued';
  progress := 0;
  return next;
end;
$$;
