create schema if not exists app;

create extension if not exists "citext" with schema "extensions";
create extension if not exists "vector" with schema "extensions";

create type public.tenant_status as enum ('active', 'suspended', 'archived');
create type public.tenant_role as enum ('owner', 'admin', 'member', 'viewer');
create type public.document_status as enum (
  'uploading',
  'uploaded',
  'queued',
  'parsing',
  'structuring',
  'embedding',
  'indexed',
  'failed',
  'archived'
);
create type public.message_role as enum ('system', 'user', 'assistant', 'tool');

create or replace function app.current_tenant_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(
    coalesce(
      auth.jwt() ->> 'tenant_id',
      auth.jwt() #>> '{app_metadata,tenant_id}',
      auth.jwt() #>> '{user_metadata,tenant_id}'
    ),
    ''
  )::uuid;
$$;

create or replace function app.current_tenant_role()
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(
    nullif(auth.jwt() ->> 'tenant_role', ''),
    nullif(auth.jwt() #>> '{app_metadata,tenant_role}', ''),
    nullif(auth.jwt() #>> '{app_metadata,role}', ''),
    nullif(auth.jwt() #>> '{user_metadata,tenant_role}', ''),
    'member'
  );
$$;

create or replace function app.is_tenant_admin()
returns boolean
language sql
stable
set search_path = ''
as $$
  select app.current_tenant_role() in ('owner', 'admin');
$$;

create or replace function app.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.tenants (
  id uuid primary key default extensions.gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9_-]*$'),
  name text not null,
  status public.tenant_status not null default 'active',
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.roles (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_]*$'),
  name text not null,
  permissions jsonb not null default '{}'::jsonb,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, key)
);

create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  email extensions.citext not null,
  display_name text,
  avatar_url text,
  role public.tenant_role not null default 'member',
  status text not null default 'active' check (status in ('active', 'invited', 'disabled')),
  metadata jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, email)
);

create table public.documents (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  title text,
  filename text not null,
  mime_type text not null default 'application/pdf',
  byte_size bigint check (byte_size is null or byte_size >= 0),
  checksum_sha256 text check (checksum_sha256 is null or checksum_sha256 ~ '^[a-f0-9]{64}$'),
  r2_bucket text not null default 'documents',
  r2_key text not null,
  status public.document_status not null default 'uploading',
  status_reason text,
  acl jsonb not null default '{"visibility":"tenant"}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  uploaded_at timestamptz,
  indexed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, r2_key)
);

create table public.doc_tree (
  document_id uuid primary key,
  tenant_id uuid not null,
  tree jsonb not null default '{}'::jsonb,
  summary text,
  model text,
  version text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, document_id)
    references public.documents(tenant_id, id)
    on delete cascade
);

create table public.chunks (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  document_id uuid not null,
  node_id text,
  node_path text[] not null default '{}'::text[],
  chunk_index integer not null check (chunk_index >= 0),
  page_start integer check (page_start is null or page_start > 0),
  page_end integer check (page_end is null or page_end >= page_start),
  content text not null,
  summary text,
  token_count integer check (token_count is null or token_count >= 0),
  embedding extensions.vector(1536),
  embedding_model text,
  metadata jsonb not null default '{}'::jsonb,
  content_tsv tsvector generated always as (
    pg_catalog.to_tsvector('simple'::regconfig, content)
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, document_id)
    references public.documents(tenant_id, id)
    on delete cascade,
  unique (tenant_id, document_id, chunk_index)
);

create table public.conversations (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  metadata jsonb not null default '{}'::jsonb,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create table public.messages (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  conversation_id uuid not null,
  role public.message_role not null,
  content text not null default '',
  tool_name text,
  tool_call_id text,
  model text,
  token_counts jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, conversation_id)
    references public.conversations(tenant_id, id)
    on delete cascade
);

create table public.langgraph_checkpoints (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  thread_id text not null,
  checkpoint_ns text not null default '',
  checkpoint_id text not null,
  parent_checkpoint_id text,
  conversation_id uuid,
  checkpoint jsonb not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, thread_id, checkpoint_ns, checkpoint_id),
  foreign key (tenant_id, conversation_id)
    references public.conversations(tenant_id, id)
    on delete set null
);

create table public.audit_log (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete set null,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  resource_type text,
  resource_id uuid,
  request_id text,
  ip_address inet,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function app.create_default_roles()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.roles (tenant_id, key, name, permissions, is_system)
  values
    (new.id, 'owner', 'Owner', '{"admin":true}'::jsonb, true),
    (new.id, 'admin', 'Admin', '{"admin":true}'::jsonb, true),
    (new.id, 'member', 'Member', '{}'::jsonb, true),
    (new.id, 'viewer', 'Viewer', '{"read_only":true}'::jsonb, true);

  return new;
end;
$$;

create or replace function app.can_access_conversation(_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.conversations c
    where c.id = _conversation_id
      and c.tenant_id = (select app.current_tenant_id())
      and (
        c.user_id = (select auth.uid())
        or (select app.is_tenant_admin())
      )
  );
$$;

create trigger set_tenants_updated_at
before update on public.tenants
for each row execute function app.set_updated_at();

create trigger create_default_roles
after insert on public.tenants
for each row execute function app.create_default_roles();

create trigger set_roles_updated_at
before update on public.roles
for each row execute function app.set_updated_at();

create trigger set_users_updated_at
before update on public.users
for each row execute function app.set_updated_at();

create trigger set_documents_updated_at
before update on public.documents
for each row execute function app.set_updated_at();

create trigger set_doc_tree_updated_at
before update on public.doc_tree
for each row execute function app.set_updated_at();

create trigger set_chunks_updated_at
before update on public.chunks
for each row execute function app.set_updated_at();

create trigger set_conversations_updated_at
before update on public.conversations
for each row execute function app.set_updated_at();

create trigger set_langgraph_checkpoints_updated_at
before update on public.langgraph_checkpoints
for each row execute function app.set_updated_at();

create index roles_tenant_id_idx on public.roles (tenant_id);
create index users_tenant_id_idx on public.users (tenant_id);
create index users_tenant_role_idx on public.users (tenant_id, role);
create index documents_tenant_status_created_idx on public.documents (tenant_id, status, created_at desc);
create index documents_created_by_idx on public.documents (created_by);
create index documents_metadata_gin_idx on public.documents using gin (metadata jsonb_path_ops);
create index documents_acl_gin_idx on public.documents using gin (acl jsonb_path_ops);
create index doc_tree_tenant_id_idx on public.doc_tree (tenant_id);
create index doc_tree_tree_gin_idx on public.doc_tree using gin (tree jsonb_path_ops);
create index chunks_tenant_document_idx on public.chunks (tenant_id, document_id);
create index chunks_tenant_node_idx on public.chunks (tenant_id, document_id, node_id);
create index chunks_content_tsv_idx on public.chunks using gin (content_tsv);
create index chunks_metadata_gin_idx on public.chunks using gin (metadata jsonb_path_ops);
create index chunks_embedding_hnsw_idx
  on public.chunks
  using hnsw (embedding extensions.vector_cosine_ops)
  where embedding is not null;
create index conversations_tenant_user_updated_idx on public.conversations (tenant_id, user_id, updated_at desc);
create index messages_tenant_conversation_created_idx on public.messages (tenant_id, conversation_id, created_at);
create index langgraph_checkpoints_thread_idx on public.langgraph_checkpoints (tenant_id, thread_id, checkpoint_ns, created_at desc);
create index audit_log_tenant_created_idx on public.audit_log (tenant_id, created_at desc);
create index audit_log_actor_created_idx on public.audit_log (actor_id, created_at desc);
create index audit_log_resource_idx on public.audit_log (tenant_id, resource_type, resource_id);

alter table public.tenants enable row level security;
alter table public.roles enable row level security;
alter table public.users enable row level security;
alter table public.documents enable row level security;
alter table public.doc_tree enable row level security;
alter table public.chunks enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.langgraph_checkpoints enable row level security;
alter table public.audit_log enable row level security;

create policy tenants_select_own on public.tenants
  for select to authenticated
  using (id = (select app.current_tenant_id()));

create policy tenants_update_admin on public.tenants
  for update to authenticated
  using (id = (select app.current_tenant_id()) and (select app.is_tenant_admin()))
  with check (id = (select app.current_tenant_id()) and (select app.is_tenant_admin()));

create policy roles_select_tenant on public.roles
  for select to authenticated
  using (tenant_id = (select app.current_tenant_id()));

create policy roles_write_admin on public.roles
  for all to authenticated
  using (tenant_id = (select app.current_tenant_id()) and (select app.is_tenant_admin()))
  with check (tenant_id = (select app.current_tenant_id()) and (select app.is_tenant_admin()));

create policy users_select_tenant on public.users
  for select to authenticated
  using (tenant_id = (select app.current_tenant_id()));

create policy users_write_admin on public.users
  for all to authenticated
  using (tenant_id = (select app.current_tenant_id()) and (select app.is_tenant_admin()))
  with check (tenant_id = (select app.current_tenant_id()) and (select app.is_tenant_admin()));

create policy documents_select_tenant on public.documents
  for select to authenticated
  using (tenant_id = (select app.current_tenant_id()));

create policy documents_insert_tenant on public.documents
  for insert to authenticated
  with check (
    tenant_id = (select app.current_tenant_id())
    and created_by = (select auth.uid())
  );

create policy documents_update_tenant on public.documents
  for update to authenticated
  using (tenant_id = (select app.current_tenant_id()))
  with check (tenant_id = (select app.current_tenant_id()));

create policy doc_tree_select_tenant on public.doc_tree
  for select to authenticated
  using (tenant_id = (select app.current_tenant_id()));

create policy chunks_select_tenant on public.chunks
  for select to authenticated
  using (tenant_id = (select app.current_tenant_id()));

create policy conversations_select_own_or_admin on public.conversations
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and (
      user_id = (select auth.uid())
      or (select app.is_tenant_admin())
    )
  );

create policy conversations_insert_own on public.conversations
  for insert to authenticated
  with check (
    tenant_id = (select app.current_tenant_id())
    and user_id = (select auth.uid())
  );

create policy conversations_update_own_or_admin on public.conversations
  for update to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and (
      user_id = (select auth.uid())
      or (select app.is_tenant_admin())
    )
  )
  with check (
    tenant_id = (select app.current_tenant_id())
    and (
      user_id = (select auth.uid())
      or (select app.is_tenant_admin())
    )
  );

create policy conversations_delete_admin on public.conversations
  for delete to authenticated
  using (tenant_id = (select app.current_tenant_id()) and (select app.is_tenant_admin()));

create policy messages_select_conversation on public.messages
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and (select app.can_access_conversation(conversation_id))
  );

create policy messages_insert_conversation on public.messages
  for insert to authenticated
  with check (
    tenant_id = (select app.current_tenant_id())
    and (select app.can_access_conversation(conversation_id))
  );

create policy messages_update_conversation on public.messages
  for update to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and (select app.can_access_conversation(conversation_id))
  )
  with check (
    tenant_id = (select app.current_tenant_id())
    and (select app.can_access_conversation(conversation_id))
  );

create policy langgraph_checkpoints_tenant_access on public.langgraph_checkpoints
  for all to authenticated
  using (tenant_id = (select app.current_tenant_id()))
  with check (tenant_id = (select app.current_tenant_id()));

create policy audit_log_select_admin on public.audit_log
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and (select app.is_tenant_admin())
  );

create policy audit_log_insert_tenant on public.audit_log
  for insert to authenticated
  with check (
    tenant_id = (select app.current_tenant_id())
    and (
      actor_id = (select auth.uid())
      or actor_id is null
    )
  );

revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all tables in schema public from authenticated;
revoke all on all sequences in schema public from authenticated;

grant usage on schema app to authenticated, service_role;
grant execute on all functions in schema app to authenticated, service_role;

grant usage on schema public to authenticated, service_role;
grant select on
  public.tenants,
  public.roles,
  public.users,
  public.documents,
  public.doc_tree,
  public.chunks,
  public.conversations,
  public.messages,
  public.langgraph_checkpoints,
  public.audit_log
to authenticated;

grant insert, update, delete on public.conversations to authenticated;
grant insert, update on public.messages to authenticated;
grant insert, update, delete on public.langgraph_checkpoints to authenticated;
grant insert on public.audit_log to authenticated;

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public grant select on tables to authenticated;
alter default privileges for role postgres in schema public grant all on tables to service_role;
alter default privileges for role postgres in schema public grant all on sequences to service_role;
