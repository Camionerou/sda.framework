drop index if exists public.document_extractions_one_active_per_document_parser_idx;
drop index if exists public.document_extractions_success_cache_idx;

create unique index document_extractions_one_active_per_document_parser_idx
  on public.document_extractions (
    tenant_id,
    document_id,
    parser,
    parser_version,
    parser_backend,
    extraction_pipeline_version
  )
  where status in ('queued', 'running');

create unique index document_extractions_success_cache_idx
  on public.document_extractions (
    tenant_id,
    parser,
    parser_version,
    parser_backend,
    extraction_pipeline_version,
    source_checksum_sha256
  )
  where status = 'succeeded' and source_checksum_sha256 is not null;

insert into public.system_component_versions (component, version, description, metadata)
values
  ('extraction_pipeline', '0.1.2', 'MinerU extraction persistence pipeline.', '{}'::jsonb)
on conflict (component) do update
set
  description = excluded.description,
  metadata = excluded.metadata,
  updated_at = now(),
  version = excluded.version;
