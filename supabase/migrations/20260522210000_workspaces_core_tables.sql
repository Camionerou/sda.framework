-- 030.a — workspaces + workspace_memberships
-- Tablas base de la jerarquia tenant -> workspace. Sin RLS aun (030.d).

create type public.workspace_status as enum ('active', 'archived');

-- IMPORTANTE: el orden de declaracion del enum define el orden de comparacion.
-- declarado de menor a mayor para que `order by role desc limit 1` resuelva
-- al rol mas alto naturalmente cuando un user es miembro directo y via grupo
-- a la vez. Postgres no tiene `max(enum)`, este patron lo reemplaza.
create type public.workspace_role as enum (
  'workspace_viewer',
  'workspace_editor',
  'workspace_admin'
);

create type public.principal_kind as enum ('user', 'group');

create table public.workspaces (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9_-]*$'),
  name text not null,
  description text,
  status public.workspace_status not null default 'active',
  settings jsonb not null default '{}'::jsonb,
  archived_at timestamptz,
  deleted_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, slug)
);

create index workspaces_tenant_status_idx
  on public.workspaces (tenant_id, status);
create index workspaces_tenant_alive_idx
  on public.workspaces (tenant_id) where deleted_at is null;

create trigger set_workspaces_updated_at
before update on public.workspaces
for each row execute function app.set_updated_at();

create table public.workspace_memberships (
  workspace_id uuid not null,
  tenant_id uuid not null,
  principal_kind public.principal_kind not null,
  principal_id uuid not null,
  role public.workspace_role not null default 'workspace_viewer',
  added_at timestamptz not null default now(),
  added_by uuid references auth.users(id) on delete set null,
  primary key (workspace_id, principal_kind, principal_id),
  foreign key (tenant_id, workspace_id)
    references public.workspaces(tenant_id, id) on delete cascade
);

create index workspace_memberships_principal_idx
  on public.workspace_memberships (tenant_id, principal_kind, principal_id);
create index workspace_memberships_role_idx
  on public.workspace_memberships (tenant_id, workspace_id, role);
