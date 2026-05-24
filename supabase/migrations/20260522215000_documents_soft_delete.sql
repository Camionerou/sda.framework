-- soft-delete pattern para documents (Tier 1 035)
-- Nota: deleted_at/deleted_by ya existen desde 031.a; documents_deleted_at_idx desde 031.c.
-- Esta migracion completa el pattern agregando tags.deleted_at, RPCs placeholder
-- y extendiendo cleanup_operational_data con retention de soft-deletes.

alter table public.documents
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references auth.users(id) on delete set null;

create index if not exists documents_deleted_at_idx
  on public.documents (tenant_id, deleted_at)
  where deleted_at is not null;

-- tags necesita deleted_at agregada (collections/groups/workspaces ya la tienen)
alter table public.tags
  add column if not exists deleted_at timestamptz;

-- placeholders para RPCs que se implementan en Paso 16 (signatures para que
-- el test de Paso 11.1 las encuentre).
create or replace function public.archive_document(
  _document_id uuid,
  _request_context jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'archive_document not implemented yet (Paso 16)';
end;
$$;

create or replace function public.restore_document(_document_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'restore_document not implemented yet (Paso 16)';
end;
$$;

revoke execute on function public.archive_document(uuid, jsonb) from anon, public;
revoke execute on function public.restore_document(uuid) from anon, public;
grant execute on function public.archive_document(uuid, jsonb) to authenticated;
grant execute on function public.restore_document(uuid) to authenticated;

-- extender cleanup_operational_data con retention de soft-deletes.
-- DROP first porque agregar parametro cambia la signatura.
drop function if exists public.cleanup_operational_data(interval, interval, interval);

create or replace function public.cleanup_operational_data(
  _revoked_invites_retention interval default '90 days'::interval,
  _indexing_events_retention interval default '6 months'::interval,
  _audit_log_retention interval default '2 years'::interval,
  _soft_delete_retention interval default '30 days'::interval
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  revoked_invites_deleted integer := 0;
  indexing_events_deleted integer := 0;
  audit_log_deleted integer := 0;
  documents_hard_deleted integer := 0;
  workspaces_hard_deleted integer := 0;
  collections_hard_deleted integer := 0;
  groups_hard_deleted integer := 0;
  tags_hard_deleted integer := 0;
begin
  delete from public.tenant_invites
  where status = 'revoked'
    and updated_at < now() - _revoked_invites_retention;
  get diagnostics revoked_invites_deleted = row_count;

  delete from public.indexing_events
  where created_at < now() - _indexing_events_retention;
  get diagnostics indexing_events_deleted = row_count;

  delete from public.audit_log
  where created_at < now() - _audit_log_retention;
  get diagnostics audit_log_deleted = row_count;

  delete from public.documents
  where deleted_at is not null
    and deleted_at < now() - _soft_delete_retention;
  get diagnostics documents_hard_deleted = row_count;

  delete from public.workspaces
  where deleted_at is not null
    and deleted_at < now() - _soft_delete_retention;
  get diagnostics workspaces_hard_deleted = row_count;

  delete from public.collections
  where deleted_at is not null
    and deleted_at < now() - _soft_delete_retention;
  get diagnostics collections_hard_deleted = row_count;

  delete from public.groups
  where deleted_at is not null
    and deleted_at < now() - _soft_delete_retention;
  get diagnostics groups_hard_deleted = row_count;

  delete from public.tags
  where deleted_at is not null
    and deleted_at < now() - _soft_delete_retention;
  get diagnostics tags_hard_deleted = row_count;

  return jsonb_build_object(
    'audit_log_deleted', audit_log_deleted,
    'indexing_events_deleted', indexing_events_deleted,
    'revoked_invites_deleted', revoked_invites_deleted,
    'documents_hard_deleted', documents_hard_deleted,
    'workspaces_hard_deleted', workspaces_hard_deleted,
    'collections_hard_deleted', collections_hard_deleted,
    'groups_hard_deleted', groups_hard_deleted,
    'tags_hard_deleted', tags_hard_deleted
  );
end;
$$;

revoke all on function public.cleanup_operational_data(interval, interval, interval, interval)
  from anon, authenticated, public;
grant execute on function public.cleanup_operational_data(interval, interval, interval, interval)
  to service_role;
