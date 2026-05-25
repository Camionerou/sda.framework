-- Wave 1: enum tipado para DLQ failure reasons
-- Spec §4.1.2. Postgres no permite quitar valores de un enum,
-- entonces reservar generosamente upfront.

do $$ begin
  create type indexing_failure_reason as enum (
    'download_failed',
    'mineru_oom',
    'mineru_timeout',
    'sha256_mismatch',
    'disk_full',
    'expired_signed_url',
    'structure_invalid',
    'structure_unreparable',
    'llm_error',
    'llm_timeout',
    'unknown'
  );
exception when duplicate_object then null;
end $$;

alter table indexing_jobs
  add column if not exists failure_reason indexing_failure_reason,
  add column if not exists failure_detail text;

comment on column indexing_jobs.failure_reason is 'Wave 1: enum tipado, evita parsing de strings en Wave 2 dashboards';
comment on column indexing_jobs.failure_detail is 'Wave 1: mensaje libre para debugging (stack trace, raw error)';
