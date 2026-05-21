create or replace function app.current_tenant_role()
returns text
language sql
stable
set search_path = ''
as $$
  select nullif(
    coalesce(
      nullif(auth.jwt() ->> 'tenant_role', ''),
      nullif(auth.jwt() #>> '{app_metadata,tenant_role}', ''),
      nullif(auth.jwt() #>> '{app_metadata,role}', ''),
      nullif(auth.jwt() #>> '{user_metadata,tenant_role}', '')
    ),
    ''
  );
$$;

create or replace function app.is_tenant_admin()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(app.current_tenant_role() in ('owner', 'admin'), false);
$$;

create or replace function app.safe_storage_filename(_filename text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  with normalized as (
    select regexp_replace(
      regexp_replace(lower(trim(_filename)), '[^a-z0-9._-]+', '-', 'g'),
      '(^[._-]+|[._-]+$)',
      '',
      'g'
    ) as value
  ),
  bounded as (
    select regexp_replace(left(value, 240), '[._-]+$', '', 'g') as value
    from normalized
  )
  select coalesce(nullif(value, ''), 'document')
  from bounded;
$$;

create or replace function app.is_safe_documents_storage_name(_path text)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select _path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(/[A-Za-z0-9][A-Za-z0-9._-]{0,240})+$'
    and _path !~ '(^|/)[.]{1,2}(/|$)'
    and _path !~ '//';
$$;

create or replace function app.is_valid_document_storage_path(
  _tenant_id uuid,
  _document_id uuid,
  _path text
)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select app.is_safe_documents_storage_name(_path)
    and _path ~ (
      '^'
      || _tenant_id::text
      || '/'
      || _document_id::text
      || '/[A-Za-z0-9][A-Za-z0-9._-]{0,240}$'
    );
$$;

alter table public.documents
  drop constraint if exists documents_storage_path_safe_check;

alter table public.documents
  add constraint documents_storage_path_safe_check
  check (
    r2_bucket <> 'documents'
    or app.is_valid_document_storage_path(tenant_id, id, r2_key)
  )
  not valid;

grant execute on function app.current_tenant_role() to authenticated, service_role;
grant execute on function app.is_tenant_admin() to authenticated, service_role;
grant execute on function app.safe_storage_filename(text) to authenticated, service_role;
grant execute on function app.is_safe_documents_storage_name(text) to authenticated, service_role;
grant execute on function app.is_valid_document_storage_path(uuid, uuid, text)
  to authenticated, service_role;

drop policy if exists documents_delete_owner_uploading_failed on public.documents;

create policy documents_delete_owner_uploading_failed on public.documents
  for delete to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and created_by = (select auth.uid())
    and status in ('failed', 'uploading')
  );

grant delete on public.documents to authenticated;

drop policy if exists documents_storage_select_tenant on storage.objects;
drop policy if exists documents_storage_insert_tenant on storage.objects;
drop policy if exists documents_storage_update_tenant on storage.objects;
drop policy if exists documents_storage_delete_admin on storage.objects;

create policy documents_storage_select_tenant on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and app.is_safe_documents_storage_name(name)
    and (storage.foldername(name))[1] = (select app.current_tenant_id())::text
  );

create policy documents_storage_insert_tenant on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'documents'
    and app.is_safe_documents_storage_name(name)
    and (storage.foldername(name))[1] = (select app.current_tenant_id())::text
  );

create policy documents_storage_update_tenant on storage.objects
  for update to authenticated
  using (
    bucket_id = 'documents'
    and app.is_safe_documents_storage_name(name)
    and (storage.foldername(name))[1] = (select app.current_tenant_id())::text
  )
  with check (
    bucket_id = 'documents'
    and app.is_safe_documents_storage_name(name)
    and (storage.foldername(name))[1] = (select app.current_tenant_id())::text
  );

create policy documents_storage_delete_admin on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'documents'
    and app.is_safe_documents_storage_name(name)
    and (storage.foldername(name))[1] = (select app.current_tenant_id())::text
    and (select app.is_tenant_admin())
  );

create or replace function app.audit_documents_status_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status is distinct from new.status
    and new.status in ('indexed', 'failed', 'archived')
  then
    insert into public.audit_log (
      tenant_id,
      actor_id,
      action,
      resource_type,
      resource_id,
      metadata
    )
    values (
      new.tenant_id,
      auth.uid(),
      'document.' || new.status::text,
      'document',
      new.id,
      jsonb_build_object(
        'from_status', old.status,
        'status_reason', new.status_reason,
        'to_status', new.status
      )
    );
  end if;

  return new;
end;
$$;

drop trigger if exists audit_documents_status_change on public.documents;

create trigger audit_documents_status_change
after update of status on public.documents
for each row execute function app.audit_documents_status_change();

create or replace function app.audit_indexing_run_status_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  requested_by text;
begin
  if old.status is not distinct from new.status
    or new.status not in ('completed', 'failed', 'canceled')
  then
    return new;
  end if;

  requested_by := new.metadata ->> 'requested_by';

  if requested_by ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    actor_id := requested_by::uuid;
  else
    actor_id := auth.uid();
  end if;

  if actor_id is not null
    and not exists (select 1 from auth.users u where u.id = actor_id)
  then
    actor_id := null;
  end if;

  insert into public.audit_log (
    tenant_id,
    actor_id,
    action,
    resource_type,
    resource_id,
    metadata
  )
  values (
    new.tenant_id,
    actor_id,
    'indexing_run.' || new.status,
    'indexing_run',
    new.id,
    jsonb_build_object(
      'document_id', new.document_id,
      'error_message', new.error_message,
      'from_status', old.status,
      'stage', new.stage,
      'to_status', new.status
    )
  );

  return new;
end;
$$;

drop trigger if exists audit_indexing_run_status_change on public.indexing_runs;

create trigger audit_indexing_run_status_change
after update of status on public.indexing_runs
for each row execute function app.audit_indexing_run_status_change();

create or replace function app.audit_user_role_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role is distinct from new.role then
    insert into public.audit_log (
      tenant_id,
      actor_id,
      action,
      resource_type,
      resource_id,
      metadata
    )
    values (
      new.tenant_id,
      auth.uid(),
      'user.role_changed',
      'user',
      new.id,
      jsonb_build_object(
        'from_role', old.role,
        'to_role', new.role
      )
    );
  end if;

  return new;
end;
$$;

drop trigger if exists audit_user_role_change on public.users;

create trigger audit_user_role_change
after update of role on public.users
for each row execute function app.audit_user_role_change();

create or replace function app.audit_tenant_invite_status_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status is distinct from new.status then
    insert into public.audit_log (
      tenant_id,
      actor_id,
      action,
      resource_type,
      resource_id,
      metadata
    )
    values (
      new.tenant_id,
      auth.uid(),
      'tenant_invite.status_changed',
      'tenant_invite',
      new.id,
      jsonb_build_object(
        'email', new.email,
        'from_status', old.status,
        'role', new.role,
        'to_status', new.status
      )
    );
  end if;

  return new;
end;
$$;

drop trigger if exists audit_tenant_invite_status_change on public.tenant_invites;

create trigger audit_tenant_invite_status_change
after update of status on public.tenant_invites
for each row execute function app.audit_tenant_invite_status_change();

revoke execute on function app.audit_documents_status_change() from public, anon, authenticated;
revoke execute on function app.audit_indexing_run_status_change() from public, anon, authenticated;
revoke execute on function app.audit_user_role_change() from public, anon, authenticated;
revoke execute on function app.audit_tenant_invite_status_change() from public, anon, authenticated;
