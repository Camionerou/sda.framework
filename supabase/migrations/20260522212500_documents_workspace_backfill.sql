-- 031.b — backfill: workspace Default por tenant + memberships + documents.workspace_id.
-- Idempotente. Se invoca al final de la migracion. La funcion publica queda
-- disponible para re-correrla en staging si hace falta.

create or replace function public.tier1_backfill_default_workspaces()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  tenant_record record;
  ws_id uuid;
  created_workspaces integer := 0;
  ensured_workspaces integer := 0;
  added_members integer := 0;
  updated_documents integer := 0;
  inserted_members integer;
  affected_docs integer;
begin
  for tenant_record in
    select id from public.tenants
    where status = 'active'
    order by created_at asc
  loop
    -- Crear workspace Default si no existe (idempotente via unique tenant_id+slug)
    insert into public.workspaces
      (tenant_id, slug, name, description, status, settings)
    values (
      tenant_record.id,
      'default',
      'Default',
      'Workspace por defecto creado durante la migracion 031.b (Tier 1).',
      'active',
      jsonb_build_object('source', 'tier1_backfill', 'auto_created', true)
    )
    on conflict (tenant_id, slug) do nothing;

    select id into ws_id
    from public.workspaces
    where tenant_id = tenant_record.id and slug = 'default'
    limit 1;

    if ws_id is null then
      raise exception 'tier1 backfill: workspace Default no se pudo asegurar para tenant %', tenant_record.id;
    end if;

    if found then
      ensured_workspaces := ensured_workspaces + 1;
    end if;

    -- Agregar todos los users active como miembros con rol mapeado.
    -- On conflict do nothing -> idempotente.
    with mapped as (
      select
        ws_id as workspace_id,
        tenant_record.id as tenant_id,
        'user'::public.principal_kind as principal_kind,
        u.id as principal_id,
        case u.role
          when 'owner'  then 'workspace_admin'::public.workspace_role
          when 'admin'  then 'workspace_admin'::public.workspace_role
          when 'member' then 'workspace_editor'::public.workspace_role
          when 'viewer' then 'workspace_viewer'::public.workspace_role
        end as role
      from public.users u
      where u.tenant_id = tenant_record.id
        and u.status = 'active'
    ),
    ins as (
      insert into public.workspace_memberships
        (workspace_id, tenant_id, principal_kind, principal_id, role)
      select workspace_id, tenant_id, principal_kind, principal_id, role
      from mapped
      where role is not null
      on conflict (workspace_id, principal_kind, principal_id) do nothing
      returning 1
    )
    select count(*)::integer into inserted_members from ins;

    added_members := added_members + coalesce(inserted_members, 0);

    -- Asignar workspace_id a documentos del tenant que aun no lo tengan
    update public.documents
       set workspace_id = ws_id
     where tenant_id = tenant_record.id
       and workspace_id is null;
    get diagnostics affected_docs = row_count;

    updated_documents := updated_documents + coalesce(affected_docs, 0);

    if not exists (
      select 1 from public.workspaces
      where tenant_id = tenant_record.id and slug = 'default'
        and settings ->> 'source' = 'tier1_backfill'
    ) then
      ensured_workspaces := ensured_workspaces;
    else
      created_workspaces := created_workspaces + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'created_or_ensured_workspaces', created_workspaces,
    'added_members', added_members,
    'updated_documents', updated_documents
  );
end;
$$;

revoke all on function public.tier1_backfill_default_workspaces()
  from anon, authenticated, public;
grant execute on function public.tier1_backfill_default_workspaces()
  to service_role;

-- Ejecutar el backfill ahora.
do $$
declare result jsonb;
begin
  result := public.tier1_backfill_default_workspaces();
  raise notice 'tier1 backfill result: %', result;
end;
$$;

-- Trigger para que cuando se cree un tenant nuevo, automaticamente exista
-- el workspace Default. Garantiza que ningun tenant quede sin workspace.
create or replace function app.ensure_default_workspace_for_tenant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.workspaces
    (tenant_id, slug, name, description, status, settings)
  values (
    new.id,
    'default',
    'Default',
    'Workspace por defecto creado en alta de tenant.',
    'active',
    jsonb_build_object('source', 'tenant_created', 'auto_created', true)
  )
  on conflict (tenant_id, slug) do nothing;

  return new;
end;
$$;

drop trigger if exists ensure_default_workspace_for_tenant on public.tenants;
create trigger ensure_default_workspace_for_tenant
after insert on public.tenants
for each row execute function app.ensure_default_workspace_for_tenant();
