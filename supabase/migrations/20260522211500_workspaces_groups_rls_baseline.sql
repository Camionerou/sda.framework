-- 030.d — RLS baseline para workspaces, workspace_memberships, groups, group_memberships.
-- Helpers especializados (user_belongs_to_workspace, user_workspace_role) llegan
-- en migracion 033. Aca aplicamos policy basica por tenant; las policies finales
-- las reemplaza la 033 cuando los helpers existen.

alter table public.workspaces enable row level security;
alter table public.workspace_memberships enable row level security;
alter table public.groups enable row level security;
alter table public.group_memberships enable row level security;

create policy workspaces_select_tenant on public.workspaces
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and deleted_at is null
  );

create policy workspace_memberships_select_tenant on public.workspace_memberships
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
  );

create policy groups_select_tenant on public.groups
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and deleted_at is null
  );

create policy group_memberships_select_tenant on public.group_memberships
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
  );

-- write boundary: nada de insert/update/delete por usuarios autenticados.
-- todo escribe via RPCs security definer (migracion de RPCs).
revoke insert, update, delete on public.workspaces from authenticated;
revoke insert, update, delete on public.workspace_memberships from authenticated;
revoke insert, update, delete on public.groups from authenticated;
revoke insert, update, delete on public.group_memberships from authenticated;
