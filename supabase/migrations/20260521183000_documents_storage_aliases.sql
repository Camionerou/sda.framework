alter table public.documents
  add column if not exists storage_bucket text generated always as (r2_bucket) stored,
  add column if not exists storage_path text generated always as (r2_key) stored;

comment on column public.documents.storage_bucket is
  'Canonical storage bucket alias. Generated from legacy r2_bucket during migration.';

comment on column public.documents.storage_path is
  'Canonical storage object path alias. Generated from legacy r2_key during migration.';

create index if not exists documents_tenant_storage_path_idx
  on public.documents (tenant_id, storage_path);
