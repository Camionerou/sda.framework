-- 033 — helpers RLS en esquema app y audit_with_context.

create or replace function app.current_workspace_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(
    coalesce(
      auth.jwt() ->> 'active_workspace_id',
      auth.jwt() #>> '{app_metadata,active_workspace_id}',
      auth.jwt() #>> '{user_metadata,active_workspace_id}'
    ),
    ''
  )::uuid;
$$;

-- security definer: las policies de workspace_memberships y group_memberships
-- invocan este helper; sin definer se generaria recursion infinita al evaluar
-- la propia RLS sobre las tablas que el helper consulta.
create or replace function app.user_belongs_to_workspace(_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_memberships wm
    where wm.tenant_id = (select app.current_tenant_id())
      and wm.workspace_id = _workspace_id
      and (
        (wm.principal_kind = 'user' and wm.principal_id = (select auth.uid()))
        or (
          wm.principal_kind = 'group'
          and exists (
            select 1 from public.group_memberships gm
            where gm.group_id = wm.principal_id
              and gm.user_id = (select auth.uid())
          )
        )
      )
  );
$$;

-- Rol efectivo: el mayor entre membresia directa y via grupos.
-- Postgres no tiene max(enum). Aprovechamos que el enum workspace_role se
-- declaro low-to-high (viewer < editor < admin) y usamos order by role desc.
create or replace function app.user_workspace_role(_workspace_id uuid)
returns public.workspace_role
language sql
stable
security definer
set search_path = ''
as $$
  select role
  from (
    select wm.role
    from public.workspace_memberships wm
    where wm.tenant_id = (select app.current_tenant_id())
      and wm.workspace_id = _workspace_id
      and wm.principal_kind = 'user'
      and wm.principal_id = (select auth.uid())
    union all
    select wm.role
    from public.workspace_memberships wm
    join public.group_memberships gm on gm.group_id = wm.principal_id
    where wm.tenant_id = (select app.current_tenant_id())
      and wm.workspace_id = _workspace_id
      and wm.principal_kind = 'group'
      and gm.user_id = (select auth.uid())
  ) role_resolution
  order by role desc
  limit 1;
$$;

create or replace function app.user_can_read_document(_document_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.documents d
    where d.id = _document_id
      and d.tenant_id = (select app.current_tenant_id())
      and d.deleted_at is null
      and (
        (select app.is_tenant_admin())
        or (select app.user_belongs_to_workspace(d.workspace_id))
        or exists (
          select 1
          from public.document_collections dc
          join public.collections c
            on c.id = dc.collection_id and c.tenant_id = d.tenant_id
          where dc.document_id = d.id
            and c.visibility = 'tenant_public'
            and c.deleted_at is null
        )
      )
  );
$$;

create or replace function app.user_can_edit_document(_document_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.documents d
    where d.id = _document_id
      and d.tenant_id = (select app.current_tenant_id())
      and d.deleted_at is null
      and (
        (select app.is_tenant_admin())
        or app.user_workspace_role(d.workspace_id)
             in ('workspace_editor','workspace_admin')
      )
  );
$$;

-- audit_with_context: single source of insert al audit_log desde RPCs.
-- Acepta _request_context jsonb opcional. Expandido en columnas dedicadas
-- (request_id, session_id, workspace_id, ip_address, user_agent) y persistido
-- ademas en metadata para no perder informacion.
create or replace function app.audit_with_context(
  _action text,
  _resource_type text,
  _resource_id uuid,
  _payload jsonb default '{}'::jsonb,
  _request_context jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted_id uuid;
  ctx jsonb;
  merged_payload jsonb;
begin
  ctx := coalesce(_request_context, '{}'::jsonb);

  -- Merge: payload + request_context flatten (request_id, session_id, ip,
  -- user_agent, workspace_id, ...) + nested 'request_context' para no perder
  -- el bag original. Asi metadata->>'request_id' funciona en queries simples.
  merged_payload := coalesce(_payload, '{}'::jsonb)
    || ctx
    || jsonb_build_object('request_context', ctx);

  insert into public.audit_log (
    tenant_id,
    actor_id,
    action,
    resource_type,
    resource_id,
    request_id,
    ip_address,
    user_agent,
    metadata
  )
  values (
    (select app.current_tenant_id()),
    auth.uid(),
    _action,
    _resource_type,
    _resource_id,
    nullif(ctx ->> 'request_id', ''),
    nullif(ctx ->> 'ip', '')::inet,
    nullif(ctx ->> 'user_agent', ''),
    merged_payload
  )
  returning id into inserted_id;

  return inserted_id;
exception
  when invalid_text_representation then
    -- ip invalida no rompe la RPC; persistimos sin la columna y dejamos rastro
    insert into public.audit_log (
      tenant_id, actor_id, action, resource_type, resource_id,
      request_id, user_agent, metadata
    )
    values (
      (select app.current_tenant_id()),
      auth.uid(),
      _action,
      _resource_type,
      _resource_id,
      nullif(ctx ->> 'request_id', ''),
      nullif(ctx ->> 'user_agent', ''),
      merged_payload || jsonb_build_object('ip_parse_error', true)
    )
    returning id into inserted_id;
    return inserted_id;
end;
$$;

grant execute on function app.current_workspace_id()              to authenticated, service_role;
grant execute on function app.user_belongs_to_workspace(uuid)     to authenticated, service_role;
grant execute on function app.user_workspace_role(uuid)           to authenticated, service_role;
grant execute on function app.user_can_read_document(uuid)        to authenticated, service_role;
grant execute on function app.user_can_edit_document(uuid)        to authenticated, service_role;
grant execute on function app.audit_with_context(text,text,uuid,jsonb,jsonb) to service_role;
-- audit_with_context se invoca desde RPCs security definer; no exponer a authenticated.

-- Reemplazar policies baseline de workspaces/memberships/groups con
-- versiones que aprovechan los helpers. Se usa `with replace` simulado via
-- drop + create. RLS sigue habilitada todo el tiempo (no se hace `disable`).
drop policy if exists workspaces_select_tenant on public.workspaces;
create policy workspaces_select_member on public.workspaces
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and deleted_at is null
    and (
      (select app.is_tenant_admin())
      or (select app.user_belongs_to_workspace(id))
    )
  );

drop policy if exists workspace_memberships_select_tenant on public.workspace_memberships;
create policy workspace_memberships_select_member on public.workspace_memberships
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and (
      (select app.is_tenant_admin())
      or (select app.user_belongs_to_workspace(workspace_id))
    )
  );

-- Helper interno: se invoca desde la policy de group_memberships y necesita
-- security definer para no caer en recursion infinita (la policy consulta
-- group_memberships, lo cual reevaluaria la propia policy).
create or replace function app.user_shares_group(_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.group_memberships gm
    where gm.group_id = _group_id
      and gm.user_id = (select auth.uid())
  );
$$;
grant execute on function app.user_shares_group(uuid) to authenticated, service_role;

-- groups y group_memberships: groups quedan en directorio (todos los users
-- del tenant ven el nombre). group_memberships solo visible para admins o
-- miembros del propio grupo.
drop policy if exists group_memberships_select_tenant on public.group_memberships;
create policy group_memberships_select_own_or_admin on public.group_memberships
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and (
      (select app.is_tenant_admin())
      or user_id = (select auth.uid())
      or (select app.user_shares_group(group_id))
    )
  );

-- collections + document_collections: visibility efectiva
drop policy if exists collections_select_tenant on public.collections;
create policy collections_select_visible on public.collections
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and deleted_at is null
    and (
      (select app.is_tenant_admin())
      or visibility = 'tenant_public'
      or (select app.user_belongs_to_workspace(workspace_id))
    )
  );

drop policy if exists document_collections_select_tenant on public.document_collections;
create policy document_collections_select_visible on public.document_collections
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and (
      (select app.is_tenant_admin())
      or exists (
        select 1 from public.collections c
        where c.id = document_collections.collection_id
          and c.tenant_id = document_collections.tenant_id
          and c.deleted_at is null
          and (
            c.visibility = 'tenant_public'
            or (select app.user_belongs_to_workspace(c.workspace_id))
          )
      )
    )
  );
