-- 032 — collections, document_collections, tags, document_tags.
-- Policies finales usando helpers app.* llegan en 033/035.

create type public.collection_visibility as enum (
  'workspace_private',
  'tenant_public'
);

create table public.collections (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  workspace_id uuid not null,
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9_-]*$'),
  name text not null,
  description text,
  visibility public.collection_visibility not null default 'workspace_private',
  icon text,
  color text,
  metadata jsonb not null default '{}'::jsonb,
  deleted_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (workspace_id, slug),
  foreign key (tenant_id, workspace_id)
    references public.workspaces(tenant_id, id) on delete cascade
);

create index collections_workspace_idx
  on public.collections (tenant_id, workspace_id);
create index collections_visibility_idx
  on public.collections (tenant_id, visibility)
  where visibility = 'tenant_public' and deleted_at is null;
create index collections_tenant_alive_idx
  on public.collections (tenant_id) where deleted_at is null;

create trigger set_collections_updated_at
before update on public.collections
for each row execute function app.set_updated_at();

create table public.document_collections (
  tenant_id uuid not null,
  document_id uuid not null,
  collection_id uuid not null,
  added_by uuid references auth.users(id) on delete set null,
  added_at timestamptz not null default now(),
  primary key (document_id, collection_id),
  foreign key (tenant_id, document_id)
    references public.documents(tenant_id, id) on delete cascade,
  foreign key (tenant_id, collection_id)
    references public.collections(tenant_id, id) on delete cascade
);

create index document_collections_collection_idx
  on public.document_collections (tenant_id, collection_id);
create index document_collections_tenant_doc_idx
  on public.document_collections (tenant_id, document_id);

create table public.tags (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  key text not null check (key ~ '^[a-z0-9][a-z0-9_-]*$'),
  label text not null,
  color text,
  description text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, key)
);

create index tags_tenant_idx on public.tags (tenant_id);

create trigger set_tags_updated_at
before update on public.tags
for each row execute function app.set_updated_at();

create table public.document_tags (
  tenant_id uuid not null,
  document_id uuid not null,
  tag_id uuid not null,
  added_by uuid references auth.users(id) on delete set null,
  added_at timestamptz not null default now(),
  primary key (document_id, tag_id),
  foreign key (tenant_id, document_id)
    references public.documents(tenant_id, id) on delete cascade,
  foreign key (tenant_id, tag_id)
    references public.tags(tenant_id, id) on delete cascade
);

create index document_tags_tag_idx
  on public.document_tags (tenant_id, tag_id);
create index document_tags_tenant_doc_idx
  on public.document_tags (tenant_id, document_id);

-- RLS baseline. Policies "visibility effectiva" usando helpers app.* en 033/035.
alter table public.collections enable row level security;
alter table public.document_collections enable row level security;
alter table public.tags enable row level security;
alter table public.document_tags enable row level security;

create policy collections_select_tenant on public.collections
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and deleted_at is null
  );

create policy document_collections_select_tenant on public.document_collections
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
  );

create policy tags_select_tenant on public.tags
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
  );

create policy document_tags_select_tenant on public.document_tags
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
  );

-- Write boundary
revoke insert, update, delete on public.collections from authenticated;
revoke insert, update, delete on public.document_collections from authenticated;
revoke insert, update, delete on public.tags from authenticated;
revoke insert, update, delete on public.document_tags from authenticated;
