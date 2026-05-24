-- 034 — JWT hook v2.
-- Extiende app.custom_access_token_hook para:
-- 1. Leer user_metadata.active_workspace_id (lo setea el cliente via
--    supabase.auth.updateUser({ data: { active_workspace_id } })).
-- 2. Validar que el user es miembro del workspace (directo o via group).
-- 3. Inyectar active_workspace_id + active_workspace_role como HINTS para UI.
-- 4. Bumpear claims_version a 2.
-- Invariante: el claim es solo hint UI. RLS siempre re-verifica via helpers.

create or replace function app.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  claims jsonb;
  app_metadata jsonb;
  user_metadata jsonb;
  tenant_profile record;
  event_user_id uuid;
  requested_workspace uuid;
  resolved_workspace uuid;
  resolved_role public.workspace_role;
begin
  event_user_id := nullif(event ->> 'user_id', '')::uuid;
  claims := coalesce(event -> 'claims', '{}'::jsonb);
  app_metadata := coalesce(claims -> 'app_metadata', '{}'::jsonb);
  user_metadata := coalesce(claims -> 'user_metadata', '{}'::jsonb);

  select
    u.tenant_id,
    u.role::text as tenant_role,
    u.status as user_status,
    t.slug as tenant_slug,
    t.status::text as tenant_status
  into tenant_profile
  from public.users u
  join public.tenants t on t.id = u.tenant_id
  where u.id = event_user_id
  limit 1;

  if tenant_profile.tenant_id is null
    or tenant_profile.user_status <> 'active'
    or tenant_profile.tenant_status <> 'active'
  then
    claims := claims
      - 'tenant_id' - 'tenant_role' - 'tenant_slug' - 'tenant_status'
      - 'user_status' - 'claims_version'
      - 'active_workspace_id' - 'active_workspace_role';
    app_metadata := app_metadata
      - 'tenant_id' - 'tenant_role' - 'tenant_slug' - 'tenant_status'
      - 'user_status' - 'claims_version'
      - 'active_workspace_id' - 'active_workspace_role';
    claims := jsonb_set(claims, '{app_metadata}', app_metadata, true);
    return jsonb_set(event, '{claims}', claims, true);
  end if;

  claims := jsonb_set(claims, '{tenant_id}',     to_jsonb(tenant_profile.tenant_id::text), true);
  claims := jsonb_set(claims, '{tenant_role}',   to_jsonb(tenant_profile.tenant_role), true);
  claims := jsonb_set(claims, '{tenant_slug}',   to_jsonb(tenant_profile.tenant_slug), true);
  claims := jsonb_set(claims, '{tenant_status}', to_jsonb(tenant_profile.tenant_status), true);
  claims := jsonb_set(claims, '{user_status}',   to_jsonb(tenant_profile.user_status), true);
  claims := jsonb_set(claims, '{claims_version}', '2'::jsonb, true);

  app_metadata := jsonb_set(app_metadata, '{tenant_id}',     to_jsonb(tenant_profile.tenant_id::text), true);
  app_metadata := jsonb_set(app_metadata, '{tenant_role}',   to_jsonb(tenant_profile.tenant_role), true);
  app_metadata := jsonb_set(app_metadata, '{tenant_slug}',   to_jsonb(tenant_profile.tenant_slug), true);
  app_metadata := jsonb_set(app_metadata, '{tenant_status}', to_jsonb(tenant_profile.tenant_status), true);
  app_metadata := jsonb_set(app_metadata, '{user_status}',   to_jsonb(tenant_profile.user_status), true);
  app_metadata := jsonb_set(app_metadata, '{claims_version}', '2'::jsonb, true);

  -- Validar active_workspace_id solicitado por el cliente
  requested_workspace := nullif(user_metadata ->> 'active_workspace_id', '')::uuid;

  if requested_workspace is not null then
    -- Resolver via JOIN directo a memberships (sin pasar por helpers que dependen
    -- de auth.uid()/auth.jwt() — el hook corre como supabase_auth_admin).
    -- Nota: el outer SELECT usa public.workspaces (alias wm) para validar que el
    -- workspace existe + tenant + no soft-deleted; la subquery escalar resuelve
    -- el rol efectivo (direct OR via group), con UNION ALL para combinar ambas
    -- rutas y ORDER BY role desc para tomar el rol mas alto.
    select wm.id,
           (
             select wm2.role
             from (
               select wm3.role
               from public.workspace_memberships wm3
               where wm3.tenant_id = tenant_profile.tenant_id
                 and wm3.workspace_id = wm.id
                 and wm3.principal_kind = 'user'
                 and wm3.principal_id = event_user_id
               union all
               select wm3.role
               from public.workspace_memberships wm3
               join public.group_memberships gm
                 on gm.group_id = wm3.principal_id
                and gm.user_id = event_user_id
               where wm3.tenant_id = tenant_profile.tenant_id
                 and wm3.workspace_id = wm.id
                 and wm3.principal_kind = 'group'
             ) wm2
             order by wm2.role desc
             limit 1
           )
    into resolved_workspace, resolved_role
    from public.workspaces wm
    where wm.id = requested_workspace
      and wm.tenant_id = tenant_profile.tenant_id
      and wm.deleted_at is null
      and exists (
        select 1
        from public.workspace_memberships wm4
        where wm4.tenant_id = tenant_profile.tenant_id
          and wm4.workspace_id = requested_workspace
          and (
            (wm4.principal_kind = 'user' and wm4.principal_id = event_user_id)
            or (
              wm4.principal_kind = 'group'
              and exists (
                select 1 from public.group_memberships gm5
                where gm5.group_id = wm4.principal_id
                  and gm5.user_id = event_user_id
              )
            )
          )
      )
    limit 1;
  end if;

  if resolved_workspace is not null then
    claims := jsonb_set(claims, '{active_workspace_id}',
      to_jsonb(resolved_workspace::text), true);
    claims := jsonb_set(claims, '{active_workspace_role}',
      to_jsonb(resolved_role::text), true);
    app_metadata := jsonb_set(app_metadata, '{active_workspace_id}',
      to_jsonb(resolved_workspace::text), true);
    app_metadata := jsonb_set(app_metadata, '{active_workspace_role}',
      to_jsonb(resolved_role::text), true);
  else
    claims := claims - 'active_workspace_id' - 'active_workspace_role';
    app_metadata := app_metadata - 'active_workspace_id' - 'active_workspace_role';
  end if;

  claims := jsonb_set(claims, '{app_metadata}', app_metadata, true);
  return jsonb_set(event, '{claims}', claims, true);

exception
  when invalid_text_representation then
    return jsonb_build_object(
      'error',
      jsonb_build_object(
        'http_code', 400,
        'message', 'Invalid auth event user_id or active_workspace_id'
      )
    );
end;
$$;

-- Grants se preservan del hook v1 (supabase_auth_admin tiene EXECUTE). No
-- hace falta re-otorgar.

-- Acceso de lectura para que el hook pueda consultar las nuevas tablas
grant select (id, tenant_id, slug, deleted_at) on public.workspaces
  to supabase_auth_admin;
grant select (workspace_id, tenant_id, principal_kind, principal_id, role)
  on public.workspace_memberships to supabase_auth_admin;
grant select (group_id, user_id, tenant_id)
  on public.group_memberships to supabase_auth_admin;

create policy workspaces_select_auth_admin on public.workspaces
  for select to supabase_auth_admin using (true);
create policy workspace_memberships_select_auth_admin on public.workspace_memberships
  for select to supabase_auth_admin using (true);
create policy group_memberships_select_auth_admin on public.group_memberships
  for select to supabase_auth_admin using (true);
