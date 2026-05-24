-- Audit triggers Tier 1 (Migracion 041)

create or replace function app.audit_collection_visibility_change()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if old.visibility is distinct from new.visibility then
    insert into public.audit_log (tenant_id, actor_id, action, resource_type, resource_id, metadata)
    values (new.tenant_id, auth.uid(), 'collection.visibility_changed',
            'collection', new.id,
            jsonb_build_object('from', old.visibility, 'to', new.visibility,
                               'workspace_id', new.workspace_id));
  end if;
  return new;
end;
$$;

drop trigger if exists audit_collection_visibility_change on public.collections;
create trigger audit_collection_visibility_change
after update of visibility on public.collections
for each row execute function app.audit_collection_visibility_change();

create or replace function app.audit_workspace_membership_change()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.audit_log (tenant_id, actor_id, action, resource_type, resource_id, metadata)
    values (new.tenant_id, auth.uid(), 'workspace.membership_inserted',
            'workspace_membership', new.workspace_id,
            jsonb_build_object('principal_kind', new.principal_kind,
                               'principal_id', new.principal_id,
                               'role', new.role));
  elsif tg_op = 'UPDATE' and old.role is distinct from new.role then
    insert into public.audit_log (tenant_id, actor_id, action, resource_type, resource_id, metadata)
    values (new.tenant_id, auth.uid(), 'workspace.membership_role_changed',
            'workspace_membership', new.workspace_id,
            jsonb_build_object('principal_kind', new.principal_kind,
                               'principal_id', new.principal_id,
                               'from_role', old.role, 'to_role', new.role));
  elsif tg_op = 'DELETE' then
    insert into public.audit_log (tenant_id, actor_id, action, resource_type, resource_id, metadata)
    values (old.tenant_id, auth.uid(), 'workspace.membership_deleted',
            'workspace_membership', old.workspace_id,
            jsonb_build_object('principal_kind', old.principal_kind,
                               'principal_id', old.principal_id,
                               'role', old.role));
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists audit_workspace_membership_change on public.workspace_memberships;
create trigger audit_workspace_membership_change
after insert or update or delete on public.workspace_memberships
for each row execute function app.audit_workspace_membership_change();

-- realtime publication: agregar tablas nuevas que la UI consume live
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and tablename = 'workspaces') then
      execute 'alter publication supabase_realtime add table public.workspaces';
    end if;
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and tablename = 'collections') then
      execute 'alter publication supabase_realtime add table public.collections';
    end if;
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and tablename = 'document_collections') then
      execute 'alter publication supabase_realtime add table public.document_collections';
    end if;
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and tablename = 'document_tags') then
      execute 'alter publication supabase_realtime add table public.document_tags';
    end if;
  end if;
end;
$$;
