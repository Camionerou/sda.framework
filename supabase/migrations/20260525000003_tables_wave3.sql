-- Wave 0: schema de Wave 3 desde el inicio para evitar migraciones futuras
-- Spec ref: §2 Tablas Wave 3

-- vector extension lives in `public` (local) or `extensions` (Supabase hosted).
-- Include both in search_path so vector(N) type resolves in either env.
set search_path = public, extensions;

create table node_questions (
  id         uuid primary key default gen_random_uuid(),
  node_id    uuid not null references tree_nodes(id) on delete cascade,
  question   text not null,
  created_at timestamptz not null default now()
);
create index on node_questions (node_id);

create table node_entities (
  id              uuid primary key default gen_random_uuid(),
  node_id         uuid not null references tree_nodes(id) on delete cascade,
  entity_type     text not null,
  entity_value    text not null,
  normalized_value text,
  confidence      numeric(3,2),
  created_at      timestamptz not null default now(),
  unique (node_id, entity_type, normalized_value)
);
create index on node_entities (normalized_value, entity_type);

create table node_relations (
  id           uuid primary key default gen_random_uuid(),
  node_id      uuid not null references tree_nodes(id) on delete cascade,
  src_entity   uuid not null references node_entities(id) on delete cascade,
  predicate    text not null,
  dst_entity   uuid not null references node_entities(id) on delete cascade,
  confidence   numeric(3,2),
  created_at   timestamptz not null default now(),
  unique (node_id, src_entity, predicate, dst_entity)
);

create table node_typed_fields (
  id           uuid primary key default gen_random_uuid(),
  document_id  uuid not null references documents(id) on delete cascade,
  node_id      uuid references tree_nodes(id) on delete cascade,
  schema_name  text not null,
  field_path   text not null,
  field_value  jsonb not null,
  created_at   timestamptz not null default now()
);
create index on node_typed_fields (document_id, schema_name);

create table node_embeddings (
  id            uuid primary key default gen_random_uuid(),
  node_id       uuid not null references tree_nodes(id) on delete cascade,
  embedding_type text not null
                 check (embedding_type in ('content','summary','image','table_image')),
  modality      text not null
                 check (modality in ('text','image','audio','pdf')),
  model         text not null default 'google/gemini-embedding-2-preview',
  dimensions    smallint not null default 768,
  embedding     vector(768) not null,
  created_at    timestamptz not null default now(),
  unique (node_id, embedding_type, model)
);
create index idx_node_embeddings_hnsw
  on node_embeddings using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);
