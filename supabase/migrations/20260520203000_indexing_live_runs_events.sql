create table public.indexing_runs (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  document_id uuid not null,
  status text not null default 'queued' check (
    status in ('queued', 'running', 'completed', 'failed', 'canceled')
  ),
  stage text not null default 'queued' check (
    stage in (
      'queued',
      'extracting',
      'structuring',
      'verifying_tree',
      'refining_tree',
      'summarizing',
      'embedding',
      'persisting',
      'indexed',
      'failed',
      'canceled'
    )
  ),
  progress integer not null default 0 check (progress between 0 and 100),
  attempt integer not null default 1 check (attempt > 0),
  inngest_run_id text,
  compute_job_id text,
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, document_id)
    references public.documents(tenant_id, id)
    on delete cascade
);

create table public.indexing_events (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  document_id uuid not null,
  run_id uuid not null references public.indexing_runs(id) on delete cascade,
  event_type text not null check (event_type ~ '^[a-z0-9_.-]+$'),
  stage text not null,
  severity text not null default 'info' check (severity in ('debug', 'info', 'warning', 'error')),
  message text not null,
  progress integer check (progress is null or progress between 0 and 100),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, document_id)
    references public.documents(tenant_id, id)
    on delete cascade
);

create unique index indexing_runs_one_active_per_document_idx
  on public.indexing_runs (tenant_id, document_id)
  where status in ('queued', 'running');

create index indexing_runs_tenant_document_created_idx
  on public.indexing_runs (tenant_id, document_id, created_at desc);

create index indexing_runs_tenant_status_created_idx
  on public.indexing_runs (tenant_id, status, created_at desc);

create index indexing_events_run_created_idx
  on public.indexing_events (run_id, created_at asc);

create index indexing_events_tenant_document_created_idx
  on public.indexing_events (tenant_id, document_id, created_at desc);

create trigger set_indexing_runs_updated_at
before update on public.indexing_runs
for each row execute function app.set_updated_at();

alter table public.indexing_runs enable row level security;
alter table public.indexing_events enable row level security;

create policy indexing_runs_select_tenant on public.indexing_runs
  for select to authenticated
  using (tenant_id = (select app.current_tenant_id()));

create policy indexing_events_select_tenant on public.indexing_events
  for select to authenticated
  using (tenant_id = (select app.current_tenant_id()));

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

grant select on public.indexing_runs, public.indexing_events to authenticated;
grant all on public.indexing_runs, public.indexing_events to service_role;
grant execute on function public.request_document_indexing(uuid, jsonb) to authenticated;

revoke insert, update, delete on public.indexing_runs, public.indexing_events from authenticated;
revoke execute on function public.request_document_indexing(uuid, jsonb) from anon, public;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'indexing_runs'
    ) then
      execute 'alter publication supabase_realtime add table public.indexing_runs';
    end if;

    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'indexing_events'
    ) then
      execute 'alter publication supabase_realtime add table public.indexing_events';
    end if;
  end if;
end;
$$;
