-- Wave 0: tablas core del pipeline (documents, tree_nodes, jobs, llm_calls, etc.)
-- Spec ref: §2 Schema de Supabase

create table documents (
  id            uuid primary key default gen_random_uuid(),
  sha256        text not null,
  source_path   text not null,
  source_type   text not null check (source_type in ('pdf','markdown')),
  doc_type      text,
  status        text not null default 'pending'
                check (status in ('pending','parsing','summarizing','finalizing','ready','failed','duplicate')),
  page_count    integer,
  node_count    integer,
  path_used     text check (path_used in ('fast','full')),
  doc_description text,
  total_cost_cents numeric(10,4),
  trace_id      text,
  error_message text,
  created_at    timestamptz not null default now(),
  finalized_at  timestamptz,
  unique (sha256)
);
create index on documents (status) where status != 'ready';
create index on documents (sha256);

create table tree_nodes (
  id              uuid primary key default gen_random_uuid(),
  document_id     uuid not null references documents(id) on delete cascade,
  parent_id       uuid references tree_nodes(id) on delete cascade,
  node_id_str     text not null,
  structure_code  text not null,
  depth           smallint not null,
  title           text not null,
  start_index     integer not null,
  end_index       integer not null,
  node_type       text not null default 'section'
                  check (node_type in ('section','table','image','code')),
  text            text,
  text_contextualized text,
  summary         text,
  summary_model   text,
  appear_start    boolean,
  content_hash    text,
  status          text not null default 'pending_summary'
                  check (status in ('pending_summary','summarizing','ready','failed')),
  retry_count     smallint not null default 0,
  created_at      timestamptz not null default now(),
  summarized_at   timestamptz,
  unique (document_id, node_id_str)
);
create index on tree_nodes (document_id, status);
create index on tree_nodes (parent_id);
create index on tree_nodes (document_id, structure_code);

create table indexing_jobs (
  job_id        uuid primary key default gen_random_uuid(),
  msg_id        bigint not null,
  queue_name    text not null,
  document_id   uuid references documents(id) on delete set null,
  node_id       uuid references tree_nodes(id) on delete set null,
  job_type      text not null,
  payload       jsonb not null,
  status        text not null default 'enqueued'
                check (status in ('enqueued','in_flight','succeeded','failed','dead')),
  attempts      smallint not null default 0,
  idempotency_key text not null,
  last_error    text,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz,
  unique (idempotency_key)
);
create index on indexing_jobs (status, queue_name);
create index on indexing_jobs (document_id);

create table llm_calls (
  id                uuid primary key default gen_random_uuid(),
  document_id       uuid references documents(id) on delete set null,
  node_id           uuid references tree_nodes(id) on delete set null,
  phase             text not null,
  model             text not null,
  prompt_tokens     integer not null,
  completion_tokens integer not null,
  cached_tokens     integer not null default 0,
  cost_cents        numeric(10,6) not null,
  latency_ms        integer not null,
  success           boolean not null,
  error_class       text,
  trace_id          text,
  created_at        timestamptz not null default now()
);
create index on llm_calls (document_id);
create index on llm_calls (created_at);

create table quality_metrics (
  id           uuid primary key default gen_random_uuid(),
  document_id  uuid references documents(id) on delete cascade,
  phase        text not null,
  metric_name  text not null,
  metric_value numeric not null,
  details      jsonb,
  recorded_at  timestamptz not null default now()
);
create index on quality_metrics (recorded_at);
create index on quality_metrics (document_id, phase);

create table rate_limits (
  provider        text primary key,
  in_flight       integer not null default 0,
  max_concurrent  integer not null,
  rpm_limit       integer,
  rpm_window_start timestamptz not null default now(),
  rpm_count       integer not null default 0,
  updated_at      timestamptz not null default now()
);
insert into rate_limits (provider, max_concurrent, rpm_limit) values
  ('deepseek',   50,  600),
  ('openrouter', 10,  300);
