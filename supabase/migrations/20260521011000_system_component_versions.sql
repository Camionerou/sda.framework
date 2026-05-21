create table if not exists public.system_component_versions (
  component text primary key check (component ~ '^[a-z][a-z0-9_]*$'),
  version text not null check (version ~ '^[0-9]+[.][0-9]+[.][0-9]+([-.+][0-9A-Za-z][0-9A-Za-z.-]*)?$'),
  description text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_system_component_versions_updated_at on public.system_component_versions;

create trigger set_system_component_versions_updated_at
before update on public.system_component_versions
for each row execute function app.set_updated_at();

alter table public.system_component_versions enable row level security;

create policy system_component_versions_select_authenticated
on public.system_component_versions
for select
to authenticated
using (true);

grant select on public.system_component_versions to authenticated;
grant all on public.system_component_versions to service_role;
revoke insert, update, delete on public.system_component_versions from anon, authenticated, public;

insert into public.system_component_versions (component, version, description, metadata)
values
  ('app', '0.1.1', 'Next.js application shell and API routes.', '{}'::jsonb),
  ('chat_agent', '0.0.0', 'Conversational retrieval agent; not implemented yet.', '{}'::jsonb),
  ('compute_gateway_extraction', '0.1.1', 'Compute Gateway MinerU extraction contract.', '{}'::jsonb),
  ('embedding_pipeline', '0.0.0', 'Hierarchical embeddings; pending implementation.', '{}'::jsonb),
  ('extraction_pipeline', '0.1.1', 'MinerU extraction persistence pipeline.', '{}'::jsonb),
  ('indexing_pipeline', '0.1.1', 'End-to-end document indexing pipeline.', '{}'::jsonb),
  ('inngest_indexing_workflow', '0.1.1', 'Inngest orchestration for document indexing.', '{}'::jsonb),
  ('tree_indexer_python', '0.1.1', 'FastAPI Python PageIndex-style tree indexer.', '{}'::jsonb),
  ('tree_indexer_typescript', '0.1.1', 'Legacy TypeScript PageIndex-style tree indexer.', '{}'::jsonb),
  ('tree_prompt', '0.1.1', 'Tree builder prompts and prompt contract.', '{}'::jsonb)
on conflict (component) do update
set
  description = excluded.description,
  metadata = excluded.metadata,
  updated_at = now(),
  version = excluded.version;

alter table public.documents
  add column if not exists indexing_pipeline_version text,
  add column if not exists extraction_pipeline_version text,
  add column if not exists tree_indexer_version text,
  add column if not exists embedding_pipeline_version text;

alter table public.indexing_runs
  add column if not exists indexing_pipeline_version text not null default '0.1.1',
  add column if not exists extraction_pipeline_version text not null default '0.1.1',
  add column if not exists tree_indexer_version text not null default '0.1.1',
  add column if not exists embedding_pipeline_version text not null default '0.0.0';

alter table public.document_extractions
  add column if not exists indexing_pipeline_version text not null default '0.1.1',
  add column if not exists extraction_pipeline_version text not null default '0.1.1';

alter table public.doc_tree
  add column if not exists indexing_pipeline_version text,
  add column if not exists tree_indexer_version text,
  add column if not exists tree_prompt_version text;

alter table public.chunks
  add column if not exists indexing_pipeline_version text,
  add column if not exists tree_indexer_version text,
  add column if not exists embedding_pipeline_version text;

update public.indexing_runs
set
  embedding_pipeline_version = '0.0.0',
  extraction_pipeline_version = '0.1.0',
  indexing_pipeline_version = '0.1.0',
  tree_indexer_version = '0.1.0';

update public.document_extractions
set
  extraction_pipeline_version = '0.1.0',
  indexing_pipeline_version = '0.1.0';

update public.doc_tree
set
  indexing_pipeline_version = coalesce(nullif(indexing_pipeline_version, ''), '0.1.0'),
  tree_indexer_version = coalesce(
    nullif(tree_indexer_version, ''),
    nullif(regexp_replace(coalesce(version, ''), '^.*-v([0-9]+[.][0-9]+[.][0-9]+.*)$', '\1'), ''),
    '0.1.0'
  ),
  tree_prompt_version = coalesce(nullif(tree_prompt_version, ''), '0.1.0');

update public.documents d
set
  embedding_pipeline_version = coalesce(nullif(d.embedding_pipeline_version, ''), '0.0.0'),
  extraction_pipeline_version = coalesce(nullif(d.extraction_pipeline_version, ''), '0.1.0'),
  indexing_pipeline_version = coalesce(nullif(d.indexing_pipeline_version, ''), '0.1.0'),
  tree_indexer_version = coalesce(nullif(d.tree_indexer_version, ''), dt.tree_indexer_version, '0.1.0')
from public.doc_tree dt
where dt.document_id = d.id
  and dt.tenant_id = d.tenant_id;

update public.documents
set
  embedding_pipeline_version = coalesce(nullif(embedding_pipeline_version, ''), '0.0.0'),
  extraction_pipeline_version = coalesce(nullif(extraction_pipeline_version, ''), '0.1.0'),
  indexing_pipeline_version = coalesce(nullif(indexing_pipeline_version, ''), '0.1.0'),
  tree_indexer_version = coalesce(nullif(tree_indexer_version, ''), '0.1.0')
where status = 'indexed';

update public.chunks c
set
  embedding_pipeline_version = coalesce(nullif(c.embedding_pipeline_version, ''), '0.0.0'),
  indexing_pipeline_version = coalesce(nullif(c.indexing_pipeline_version, ''), dt.indexing_pipeline_version, '0.1.0'),
  tree_indexer_version = coalesce(nullif(c.tree_indexer_version, ''), dt.tree_indexer_version, '0.1.0')
from public.doc_tree dt
where dt.document_id = c.document_id
  and dt.tenant_id = c.tenant_id;

create index if not exists documents_tenant_indexing_pipeline_version_idx
  on public.documents (tenant_id, indexing_pipeline_version)
  where indexing_pipeline_version is not null;

create index if not exists documents_tenant_tree_indexer_version_idx
  on public.documents (tenant_id, tree_indexer_version)
  where tree_indexer_version is not null;

create index if not exists indexing_runs_tenant_pipeline_versions_idx
  on public.indexing_runs (
    tenant_id,
    indexing_pipeline_version,
    extraction_pipeline_version,
    tree_indexer_version
  );

create index if not exists doc_tree_tenant_tree_indexer_version_idx
  on public.doc_tree (tenant_id, tree_indexer_version)
  where tree_indexer_version is not null;

create index if not exists chunks_tenant_tree_indexer_version_idx
  on public.chunks (tenant_id, tree_indexer_version)
  where tree_indexer_version is not null;

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
    '0.0.0',
    '0.1.1',
    '0.1.1',
    jsonb_build_object(
      'requested_by', current_user_id,
      'source', 'app',
      'versions', jsonb_build_object(
        'embedding_pipeline_version', '0.0.0',
        'extraction_pipeline_version', '0.1.1',
        'indexing_pipeline_version', '0.1.1',
        'tree_indexer_version', '0.1.1'
      )
    ) || coalesce(_metadata, '{}'::jsonb),
    0,
    'queued',
    'queued',
    current_tenant_id,
    document_record.id,
    '0.1.1'
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
      'versions', jsonb_build_object(
        'embedding_pipeline_version', '0.0.0',
        'extraction_pipeline_version', '0.1.1',
        'indexing_pipeline_version', '0.1.1',
        'tree_indexer_version', '0.1.1'
      )
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
      'versions', jsonb_build_object(
        'embedding_pipeline_version', '0.0.0',
        'extraction_pipeline_version', '0.1.1',
        'indexing_pipeline_version', '0.1.1',
        'tree_indexer_version', '0.1.1'
      )
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
