create or replace function app.is_allowed_realtime_topic(_topic text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select case
    when (select app.current_tenant_id()) is null then false
    when _topic = 'tenant:' || (select app.current_tenant_id())::text || ':notifications' then true
    when _topic ~ '^document:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(presence|indexing)$' then exists (
      select 1
      from public.documents d
      where d.id = split_part(_topic, ':', 2)::uuid
        and d.tenant_id = (select app.current_tenant_id())
    )
    else false
  end;
$$;

revoke all on function app.is_allowed_realtime_topic(text) from anon, public;
grant execute on function app.is_allowed_realtime_topic(text) to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'documents'
    ) then
      execute 'alter publication supabase_realtime add table public.documents';
    end if;
  end if;
end;
$$;

do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute 'alter table realtime.messages enable row level security';
    execute 'grant select, insert on realtime.messages to authenticated';

    execute 'drop policy if exists realtime_private_topic_select on realtime.messages';
    execute 'drop policy if exists realtime_private_topic_insert on realtime.messages';

    execute $policy$
      create policy realtime_private_topic_select on realtime.messages
        for select to authenticated
        using (
          extension in ('broadcast', 'presence')
          and app.is_allowed_realtime_topic((select realtime.topic()))
        )
    $policy$;

    execute $policy$
      create policy realtime_private_topic_insert on realtime.messages
        for insert to authenticated
        with check (
          extension in ('broadcast', 'presence')
          and app.is_allowed_realtime_topic((select realtime.topic()))
        )
    $policy$;
  end if;
end;
$$;

create or replace function app.broadcast_document_realtime_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  row_record public.documents%rowtype;
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then
    return null;
  end if;

  row_record := new;

  perform realtime.send(
    jsonb_build_object(
      'document_id', row_record.id,
      'status', row_record.status,
      'status_reason', row_record.status_reason,
      'updated_at', row_record.updated_at
    ),
    'document_changed',
    'tenant:' || row_record.tenant_id::text || ':notifications',
    true
  );

  return null;
end;
$$;

create or replace function app.broadcast_indexing_run_realtime_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then
    return null;
  end if;

  if tg_op = 'UPDATE'
    and new.status is not distinct from old.status
    and new.stage is not distinct from old.stage
    and new.progress is not distinct from old.progress
    and new.error_message is not distinct from old.error_message
  then
    return null;
  end if;

  perform realtime.send(
    jsonb_build_object(
      'run_id', new.id,
      'document_id', new.document_id,
      'status', new.status,
      'stage', new.stage,
      'progress', new.progress,
      'updated_at', new.updated_at
    ),
    'run_changed',
    'document:' || new.document_id::text || ':indexing',
    true
  );

  return null;
end;
$$;

create or replace function app.broadcast_indexing_event_realtime_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then
    return null;
  end if;

  perform realtime.send(
    jsonb_build_object(
      'event_id', new.id,
      'run_id', new.run_id,
      'document_id', new.document_id,
      'event_type', new.event_type,
      'stage', new.stage,
      'severity', new.severity,
      'progress', new.progress,
      'created_at', new.created_at
    ),
    'event_inserted',
    'document:' || new.document_id::text || ':indexing',
    true
  );

  return null;
end;
$$;

drop trigger if exists broadcast_documents_realtime_change on public.documents;
create trigger broadcast_documents_realtime_change
after insert or update of status, status_reason, title, filename, uploaded_at, indexed_at on public.documents
for each row execute function app.broadcast_document_realtime_change();

drop trigger if exists broadcast_indexing_runs_realtime_change on public.indexing_runs;
create trigger broadcast_indexing_runs_realtime_change
after insert or update of status, stage, progress, error_message on public.indexing_runs
for each row execute function app.broadcast_indexing_run_realtime_change();

drop trigger if exists broadcast_indexing_events_realtime_insert on public.indexing_events;
create trigger broadcast_indexing_events_realtime_insert
after insert on public.indexing_events
for each row execute function app.broadcast_indexing_event_realtime_insert();
