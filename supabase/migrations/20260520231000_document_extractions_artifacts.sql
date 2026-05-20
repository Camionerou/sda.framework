do $$
begin
  create type public.document_extraction_status as enum (
    'queued',
    'running',
    'succeeded',
    'failed',
    'reused',
    'canceled'
  );
exception
  when duplicate_object then null;
end;
$$;

create unique index if not exists indexing_runs_tenant_id_id_idx
  on public.indexing_runs (tenant_id, id);

create table public.document_extractions (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  document_id uuid not null,
  run_id uuid,
  parser text not null check (parser ~ '^[a-z0-9_.-]+$'),
  parser_version text not null check (length(parser_version) between 1 and 80),
  parser_backend text not null default 'pipeline' check (parser_backend ~ '^[a-z0-9_.-]+$'),
  source_checksum_sha256 text check (
    source_checksum_sha256 is null or source_checksum_sha256 ~ '^[a-f0-9]{64}$'
  ),
  source_r2_key text not null,
  input_byte_size bigint check (input_byte_size is null or input_byte_size >= 0),
  status public.document_extraction_status not null default 'queued',
  artifact_bucket text not null default 'documents',
  artifact_prefix text not null check (artifact_prefix <> '' and artifact_prefix !~ '^/'),
  manifest jsonb not null default '{}'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, document_id)
    references public.documents(tenant_id, id)
    on delete cascade,
  foreign key (tenant_id, run_id)
    references public.indexing_runs(tenant_id, id)
    on delete set null
);

create unique index document_extractions_tenant_document_id_idx
  on public.document_extractions (tenant_id, document_id, id);

create index document_extractions_tenant_document_created_idx
  on public.document_extractions (tenant_id, document_id, created_at desc);

create index document_extractions_tenant_status_created_idx
  on public.document_extractions (tenant_id, status, created_at desc);

create unique index document_extractions_one_active_per_document_parser_idx
  on public.document_extractions (tenant_id, document_id, parser, parser_version, parser_backend)
  where status in ('queued', 'running');

create unique index document_extractions_success_cache_idx
  on public.document_extractions (
    tenant_id,
    parser,
    parser_version,
    parser_backend,
    source_checksum_sha256
  )
  where status = 'succeeded' and source_checksum_sha256 is not null;

create table public.document_extraction_artifacts (
  id uuid primary key default extensions.gen_random_uuid(),
  extraction_id uuid not null,
  tenant_id uuid not null,
  document_id uuid not null,
  artifact_type text not null check (artifact_type ~ '^[a-z0-9_.-]+$'),
  storage_bucket text not null default 'documents',
  storage_path text not null check (storage_path <> '' and storage_path !~ '^/'),
  content_type text,
  byte_size bigint check (byte_size is null or byte_size >= 0),
  checksum_sha256 text check (checksum_sha256 is null or checksum_sha256 ~ '^[a-f0-9]{64}$'),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, document_id, extraction_id)
    references public.document_extractions(tenant_id, document_id, id)
    on delete cascade
);

create unique index document_extraction_artifacts_extraction_path_idx
  on public.document_extraction_artifacts (extraction_id, storage_bucket, storage_path);

create index document_extraction_artifacts_tenant_document_type_idx
  on public.document_extraction_artifacts (tenant_id, document_id, artifact_type);

create trigger set_document_extractions_updated_at
before update on public.document_extractions
for each row execute function app.set_updated_at();

alter table public.document_extractions enable row level security;
alter table public.document_extraction_artifacts enable row level security;

create policy document_extractions_select_tenant on public.document_extractions
  for select
  using (tenant_id = (select app.current_tenant_id()));

create policy document_extraction_artifacts_select_tenant on public.document_extraction_artifacts
  for select
  using (tenant_id = (select app.current_tenant_id()));

grant select on public.document_extractions, public.document_extraction_artifacts to authenticated;
grant all on public.document_extractions, public.document_extraction_artifacts to service_role;

revoke insert, update, delete on public.document_extractions, public.document_extraction_artifacts
  from authenticated;

do $$
begin
  if exists (
    select 1
    from pg_publication
    where pubname = 'supabase_realtime'
  ) then
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'document_extractions'
    ) then
      execute 'alter publication supabase_realtime add table public.document_extractions';
    end if;

    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'document_extraction_artifacts'
    ) then
      execute 'alter publication supabase_realtime add table public.document_extraction_artifacts';
    end if;
  end if;
end;
$$;
