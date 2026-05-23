-- 030.b — groups + group_memberships a nivel tenant.
-- Un grupo puede ser miembro de varios workspaces via workspace_memberships
-- con principal_kind='group'. El grupo no tiene rol propio.

create table public.groups (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_-]*$'),
  name text not null,
  description text,
  metadata jsonb not null default '{}'::jsonb,
  deleted_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, key)
);

create index groups_tenant_deleted_at_idx
  on public.groups (tenant_id) where deleted_at is null;

create trigger set_groups_updated_at
before update on public.groups
for each row execute function app.set_updated_at();

create table public.group_memberships (
  group_id uuid not null,
  user_id uuid not null,
  tenant_id uuid not null,
  added_by uuid references auth.users(id) on delete set null,
  added_at timestamptz not null default now(),
  primary key (group_id, user_id),
  foreign key (tenant_id, group_id)
    references public.groups(tenant_id, id) on delete cascade,
  foreign key (tenant_id, user_id)
    references public.users(tenant_id, id) on delete cascade
);

create index group_memberships_tenant_user_idx
  on public.group_memberships (tenant_id, user_id);
create index group_memberships_group_idx
  on public.group_memberships (tenant_id, group_id);
