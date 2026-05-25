---
title: Ingest + Index — Foundation spec
date: 2026-05-24
status: draft (pending user review)
author: Enzo Saldivia (with Claude Opus 4.7)
supersedes: —
related: 2026-05-24-wipe-restart-design.md
follow-ups:
  - Retrieval (tree-traversal + hybrid + citation) — siguiente spec
  - Auth + multi-tenancy + RLS
  - Product UI
  - Public API + MCP server
---

# Ingest + Index — Foundation spec

## Executive summary

**Objetivo:** construir la primera pieza del producto sda.framework — el sistema de ingestión e indexación de documentos. La base de retrieval, tipo-extracción y todo lo que venga después.

**Approach:** implementación propia inspirada en **PageIndex** (vectorless, reasoning-based RAG por hierarchical tree index, Vectify AI, MIT) con 25 mejoras encima — 10 arquitecturales originales + 15 derivadas de investigación.

**Stack final:**

- **Supabase** orquesta y almacena: tablas + `pgmq` + `pg_cron` + `pg_net` + triggers + Realtime + Vault + `pgvector` + LangGraph PostgresSaver para checkpoints.
- **srv-ia-01** ejecuta el cómputo en Python: FastAPI + LangGraph workflows + MinerU (PDF parsing) + DeepSeek V4 Pro/Flash API (LLM) + OpenRouter Gemini Embedding 2 (embeddings) + Kuzu embedded (graph DB).
- **Inngest está fuera del stack** — reemplazado por orquestación Supabase-native.
- **No multi-tenancy** todavía — desarrollado en modo single-tenant, multi-tenant viene en spec aparte.
- **No retrieval** en este spec — sólo ingest + index. Retrieval es spec siguiente.

**Plan de entrega:** 4 olas en 6-8 semanas:

| Ola | Duración | Entrega |
|---|---|---|
| 0 — Foundation | 1 semana | Markdown end-to-end + sistema de settings + base operativa |
| 1 — PDF + costo | 1.5 semanas | PDFs grandes por centavos, cache, contextual chunking, tiered models |
| 2 — Producción | 1 semana | DLQ, backpressure, OTel+Langfuse, dashboard, runbooks |
| 3 — Capacidades | 3-4 semanas | Question-prediction, typed extraction, entities+Kuzu, multi-modal, embeddings, incremental re-indexing |

**Configurabilidad universal:** todas las decisiones tunables (modelos, prompts, timeouts, thresholds, schemas, feature flags) están en un sistema `app_settings` con scope cascade (global < doc_type < collection < document), hot-reload sin restart, audit en `app_settings_history`, admin UI. **Cero magic numbers en código.**

---

## Sección 1 — Arquitectura general

### Topología

```
┌─────────────────────────────────────────────────────────────────┐
│  SUPABASE  (control plane — orquesta, almacena, observa)        │
│                                                                 │
│  Storage Bucket: docs/                                          │
│      │                                                          │
│      ▼ (storage webhook)                                        │
│  documents (tabla)              ◄─── tree_nodes (tabla)         │
│      │                                                          │
│  pgmq.q_extract_structure ──────► pg_cron tick (10s)            │
│  pgmq.q_summarize_node    ──────►   │                           │
│  pgmq.q_finalize          ──────►   │                           │
│  (Wave 3) q_extract_entities      │                           │
│  (Wave 3) q_predict_questions     │                           │
│  (Wave 3) q_embed_node            │                           │
│                                     ▼                           │
│                          pg_net.http_post(srv-ia-01/...)        │
│                                                                 │
│  Realtime: changes on documents / tree_nodes                    │
│  Vault: deepseek_api_key, srv_ia_01_secret, openrouter_api_key  │
│  LangGraph checkpoints: schema `langgraph_checkpoints`          │
│  app_settings: registry de tunables con scope cascade           │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTPS (JSON, Bearer auth)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  srv-ia-01  (data plane — ejecuta el algoritmo)                 │
│                                                                 │
│  FastAPI service (uvicorn)                                      │
│  ├── POST /index/structure   → LangGraph: TOC→extract→repair    │
│  ├── POST /index/summarize   → LangGraph: load→summarize        │
│  ├── POST /index/finalize    → LangGraph: validate→mark_ready   │
│  ├── POST /index/embed       → LangGraph: embed (Wave 3)        │
│  ├── POST /index/extract_entities    (Wave 3)                   │
│  ├── POST /index/predict_questions   (Wave 3)                   │
│  ├── POST /index/extract_typed       (Wave 3)                   │
│  ├── POST /diff/reindex              (Wave 3)                   │
│  ├── POST /graph/query                (Wave 3, Cypher → Kuzu)   │
│  ├── POST /graph/rebuild              (Wave 3)                   │
│  ├── GET  /admin/dlq + POST /admin/dlq/replay/:id   (Wave 2)    │
│  └── GET  /health                                               │
│                                                                 │
│  Módulos Python (sin monolitos, ~300 líneas máx por archivo):   │
│  ├── api/                 (FastAPI routers, uno por endpoint)   │
│  ├── workflows/           (LangGraph StateGraph definitions)    │
│  ├── pipeline/parser/     (MinerU + markdown reader + heur.)    │
│  ├── pipeline/structure/  (TOC detector, extractor, repair)     │
│  ├── pipeline/splitter/   (large-node recursive split)          │
│  ├── pipeline/summarizer/ (LLM per nodo + contextual chunking)  │
│  ├── pipeline/validator/  (title-appearance, accuracy score)    │
│  ├── pipeline/tree/       (bottom-up build, format)             │
│  ├── pipeline/entities/   (extraction + normalization) Wave 3   │
│  ├── pipeline/questions/  (question prediction) Wave 3          │
│  ├── pipeline/typed/      (schema-driven extraction) Wave 3     │
│  ├── pipeline/diff/       (incremental re-indexing) Wave 3      │
│  ├── pipeline/graph/      (Kuzu writer + query) Wave 3          │
│  ├── llm/                 (DeepSeek + OpenRouter clients)       │
│  ├── embeddings/          (Gemini Embedding 2) Wave 3           │
│  ├── prompts/             (jinja2 templates, también en DB)     │
│  ├── db/                  (supabase-py write helpers)           │
│  ├── settings/            (registry + client + listener)        │
│  └── observability/       (OTel + Langfuse + metrics) Wave 2    │
│                                                                 │
│  Deps existentes: MinerU, vllm (vllm no usado en V1)            │
│  Deps nuevas: langgraph, langgraph-checkpoint-postgres,         │
│               langchain-core, openai (cliente compat),          │
│               fastapi, uvicorn, supabase, asyncpg, pydantic,    │
│               pymupdf, jinja2, tenacity, kuzu (Wave 3)          │
└─────────────────────────────────────────────────────────────────┘
```

### Flujo end-to-end (camino feliz)

1. **Usuario sube PDF/MD** a `Storage/docs/{uuid}.{pdf,md}`.
2. **Storage webhook** dispara trigger SQL `on_storage_doc_uploaded` que:
   - INSERT en `documents` con `status='pending'`, `source_path`, `sha256` (computado).
   - `pgmq.send('q_extract_structure', {document_id, idempotency_key})`.
3. **`pg_cron` tick (10s)** drena `q_extract_structure` y por cada mensaje:
   - Chequea backpressure (`rate_limits.deepseek`).
   - `pg_net.http_post('https://srv-ia-01/index/structure', body=jsonb, headers={Authorization: Bearer ...})`.
   - Marca el mensaje "in-flight" con visibility timeout 10 min.
4. **srv-ia-01 `/index/structure`** (10-90s típico):
   - Carga el archivo desde Storage vía signed URL.
   - Ejecuta LangGraph `structure_workflow`: parse → heuristic_check → [fast-path | full path con TOC detect → extract → validate → repair → split-large] → build_tree → persist_nodes.
   - Escribe filas en `tree_nodes` con `summary=NULL, status='pending_summary'`.
   - UPDATE `documents.status='summarizing'`.
   - Retorna 200 con `{node_count, total_pages, path_used}`.
5. **Trigger `on_tree_node_inserted`** encola un job `q_summarize_node` por cada nodo nuevo.
6. **`pg_cron` tick** drena `q_summarize_node` (batch de N, rate-limit DeepSeek mediante) → `pg_net.http_post('https://srv-ia-01/index/summarize', body={node_id})`.
7. **srv-ia-01 `/index/summarize`** (~3-8s):
   - Carga `tree_nodes.text`.
   - LangGraph `summarize_workflow`: load → build_contextual_prefix → select_model → check_backpressure → call_deepseek → validate → persist → record_metrics.
   - UPDATE `tree_nodes` set `summary=..., status='ready'`.
8. **Trigger `on_tree_node_ready`** (AFTER UPDATE) usa advisory lock; si TODAS las filas del doc tienen `status='ready'`, encola `q_finalize`.
9. **srv-ia-01 `/index/finalize`**:
   - LangGraph `finalize_workflow`: verify_all_ready → generate_doc_description (opcional) → compute_quality_metrics → mark_ready → publish_realtime.
10. **Realtime** publica cambios de `documents` y `tree_nodes` → cualquier consumidor subscrito ve progreso en vivo.

### 25 mejoras sobre PageIndex vanilla

**Originales (10):**

| # | Mejora |
|---|---|
| 1 | State machine LangGraph (vs Python imperativo) |
| 2 | Estado persistido en Postgres en cada paso (vs in-memory) |
| 3 | Fan-out vía pgmq (vs `asyncio.gather` monolítico) |
| 4 | Idempotency keys por job (`unique` en DB) |
| 5 | MinerU como smart parser (skip TOC dance para PDFs limpios) |
| 6 | Caching por `sha256` (mismo PDF = 0 trabajo) |
| 7 | Streaming progress vía Realtime (vs polling) |
| 8 | Modelo por fase configurable (V4 Pro vs Flash) |
| 9 | Métricas de calidad observables |
| 10 | Módulos Python decompuestos (sin monolitos) |

**Nuevas (15, organizadas por tema):**

| # | Mejora | Wave |
|---|---|---|
| 1 | Contextual chunking estilo Anthropic (49-67% boost retrieval) | 1 |
| 2 | Question-prediction per nodo | 3a |
| 3 | Schema-driven typed extraction (Pydantic) | 3b |
| 4 | Prompt cache maximization de DeepSeek (~90% ahorro) | 1 |
| 5 | MinerU fast-path con heurísticas explícitas | 1 |
| 6 | Tiered models por fase (V4 Pro hard reasoning, Flash summaries) | 1 |
| 7 | Incremental re-indexing por diff de nodos (~99% ahorro en updates) | 3f |
| 8 | Dead-letter queue + endpoint admin de replay | 2 |
| 9 | Backpressure a DeepSeek con semáforo en Postgres | 2 |
| 10 | OpenTelemetry tracing end-to-end + Langfuse | 2 |
| 11 | Materialized views + tablero de calidad | 2 |
| 12 | Realtime progress streaming concretado | 2 |
| 13 | Entity & relation extraction por nodo (Kuzu embedded) | 3c |
| 14 | Multi-modal node enrichment (tablas + imágenes) | 3d |
| 15 | Hybrid vector signal opt-in (Gemini Embedding 2 vía OpenRouter) | 3e |

---

## Sección 2 — Schema de Supabase

### Tablas core

**Nota sobre dedup por sha256:** dos uploads del mismo PDF desde paths distintos se deduplican porque la unique constraint es sobre el contenido, no sobre el path. El indexer detecta el duplicate al computar el sha256 real del blob (ver trigger `on_storage_doc_uploaded` más abajo) y marca el row provisorio como `status='duplicate'` apuntando al doc original — preservando el audit trail del segundo upload sin re-procesar el contenido.

```sql
-- documents: el documento raíz, con dedup por sha256
create table documents (
  id            uuid primary key default gen_random_uuid(),
  sha256        text not null,
  source_path   text not null,
  source_type   text not null check (source_type in ('pdf','markdown')),
  doc_type      text,                              -- 'contract','paper','manual' (nullable, Wave 3 typed extraction)
  status        text not null default 'pending'
                check (status in ('pending','parsing','summarizing','finalizing','ready','failed','duplicate')),
  page_count    integer,
  node_count    integer,
  path_used     text check (path_used in ('fast','full')),
  doc_description text,
  total_cost_cents numeric(10,4),
  trace_id      text,                              -- OTel root span
  error_message text,
  created_at    timestamptz not null default now(),
  finalized_at  timestamptz,
  unique (sha256)
);
create index on documents (status) where status != 'ready';
create index on documents (sha256);

-- tree_nodes: los nodos del árbol jerárquico
create table tree_nodes (
  id              uuid primary key default gen_random_uuid(),
  document_id     uuid not null references documents(id) on delete cascade,
  parent_id       uuid references tree_nodes(id) on delete cascade,
  node_id_str     text not null,                    -- "n_1_3_2" estilo PageIndex
  structure_code  text not null,                    -- "1.3.2"
  depth           smallint not null,
  title           text not null,
  start_index     integer not null,                 -- página (PDF) o línea (MD)
  end_index       integer not null,
  node_type       text not null default 'section'
                  check (node_type in ('section','table','image','code')),  -- Wave 3 multi-modal
  text            text,
  text_contextualized text,                          -- Wave 1 contextual chunking
  summary         text,
  summary_model   text,
  appear_start    boolean,
  content_hash    text,                              -- Wave 3 incremental re-indexing
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

-- indexing_jobs: log de jobs (audit, replay, idempotency)
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

-- llm_calls: auditoría y costos
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

-- quality_metrics: scores de validación y degradación
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

-- rate_limits: semáforo de backpressure
create table rate_limits (
  provider        text primary key,                 -- 'deepseek', 'openrouter'
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
```

### Tablas Wave 3 (en schema desde el inicio para evitar migraciones futuras)

```sql
-- Question prediction
create table node_questions (
  id         uuid primary key default gen_random_uuid(),
  node_id    uuid not null references tree_nodes(id) on delete cascade,
  question   text not null,
  created_at timestamptz not null default now()
);
create index on node_questions (node_id);

-- Entities + relations (graph overlay, source-of-truth en Postgres)
create table node_entities (
  id              uuid primary key default gen_random_uuid(),
  node_id         uuid not null references tree_nodes(id) on delete cascade,
  entity_type     text not null,                    -- 'person','org','date','money','citation'
  entity_value    text not null,                    -- raw
  normalized_value text,                            -- canonical
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

-- Schema-driven typed extraction
create table node_typed_fields (
  id           uuid primary key default gen_random_uuid(),
  document_id  uuid not null references documents(id) on delete cascade,
  node_id      uuid references tree_nodes(id) on delete cascade,
  schema_name  text not null,
  field_path   text not null,                       -- 'parties.0.name', 'termination.notice_days'
  field_value  jsonb not null,
  created_at   timestamptz not null default now()
);
create index on node_typed_fields (document_id, schema_name);

-- Embeddings (Gemini Embedding 2, 768 dims default)
create extension if not exists vector;

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
```

### Sistema de settings (configurabilidad universal — Wave 0)

```sql
create table app_settings (
  id            uuid primary key default gen_random_uuid(),
  key           text not null,
  scope_type    text not null default 'global'
                check (scope_type in ('global','doc_type','collection','document')),
  scope_value   text,
  value         jsonb not null,
  value_type    text not null
                check (value_type in (
                  'string','number','boolean','object','array',
                  'duration_ms','prompt_template','model_id','json_schema','enum'
                )),
  description   text,
  default_value jsonb not null,
  validation_schema jsonb,
  is_secret     boolean not null default false,
  is_locked     boolean not null default false,
  deprecated_at timestamptz,
  updated_at    timestamptz not null default now(),
  updated_by    text,
  unique (key, scope_type, scope_value)
);
create index on app_settings (key) where deprecated_at is null;
create index on app_settings (scope_type, scope_value);

create table app_settings_history (
  id          uuid primary key default gen_random_uuid(),
  setting_id  uuid not null references app_settings(id) on delete cascade,
  prev_value  jsonb,
  new_value   jsonb not null,
  changed_at  timestamptz not null default now(),
  changed_by  text not null,
  reason      text
);

create function on_setting_changed() returns trigger language plpgsql as $$
begin
  insert into app_settings_history (setting_id, prev_value, new_value, changed_by, reason)
    values (new.id, old.value, new.value, coalesce(new.updated_by, 'system'), 'auto');
  perform pg_notify('settings_changed', json_build_object(
    'key', new.key, 'scope_type', new.scope_type, 'scope_value', new.scope_value
  )::text);
  return new;
end $$;
create trigger trg_setting_changed after update on app_settings
  for each row execute function on_setting_changed();
```

### pgmq queues

```sql
-- Wave 0
select pgmq.create('q_extract_structure');
select pgmq.create('q_summarize_node');
select pgmq.create('q_finalize');

-- Wave 2 — DLQs
select pgmq.create('q_extract_structure_dlq');
select pgmq.create('q_summarize_node_dlq');
select pgmq.create('q_finalize_dlq');

-- Wave 3
select pgmq.create('q_extract_entities');
select pgmq.create('q_predict_questions');
select pgmq.create('q_extract_typed_fields');
select pgmq.create('q_embed_node');
```

### Triggers core

```sql
-- 1. Storage upload → INSERT documents + enqueue extract
--
-- IMPORTANTE: Supabase Storage NO expone el sha256 del contenido en metadata.
-- El eTag es MD5 o ID interno, no sirve para dedup determinístico.
-- Estrategia: el trigger usa un placeholder hash provisorio (sha256 del storage_path),
-- y el indexer (en /index/structure) computa el sha256 REAL al cargar el blob y
-- hace UPDATE del documents row. La unique constraint en sha256 se chequea AHÍ:
-- si ya existe doc con ese hash real, el indexer marca el row provisorio como
-- 'duplicate' y aborta sin trabajo.
create function on_storage_doc_uploaded() returns trigger language plpgsql security definer as $$
declare
  doc_sha_provisional text;
  doc_type text;
begin
  if new.bucket_id != 'docs' then return new; end if;
  doc_type := case
    when new.name like '%.pdf' then 'pdf'
    when new.name like '%.md' then 'markdown'
    else null
  end;
  if doc_type is null then return new; end if;
  -- Hash provisorio basado en storage path; indexer lo reemplaza con sha256 real
  doc_sha_provisional := 'provisional:' || encode(digest(new.name, 'sha256'), 'hex');
  insert into documents (sha256, source_path, source_type, trace_id)
    values (doc_sha_provisional, new.name, doc_type, gen_random_uuid()::text)
    on conflict (sha256) do nothing;
  return new;
end $$;
create trigger trg_storage_doc_uploaded after insert on storage.objects
  for each row execute function on_storage_doc_uploaded();

-- En el indexer, después de cargar el blob:
--   real_sha = sha256(blob_bytes)
--   UPDATE documents SET sha256 = real_sha WHERE id = $1 AND sha256 LIKE 'provisional:%'
--   Si UPDATE viola unique (otro doc con mismo real_sha ya existe):
--     UPDATE documents SET status='duplicate', error_message='Same content as <other_id>' WHERE id = $1
--     ABORT.

-- 2. Document inserted → enqueue extract_structure
create function on_document_inserted() returns trigger language plpgsql security definer as $$
begin
  perform pgmq.send('q_extract_structure',
    jsonb_build_object(
      'document_id', new.id,
      'idempotency_key', 'extract:' || new.sha256,
      'trace_id', new.trace_id
    ));
  insert into indexing_jobs (msg_id, queue_name, document_id, job_type, payload, idempotency_key)
    values (currval('pgmq.q_extract_structure_msg_id_seq'), 'q_extract_structure',
            new.id, 'extract_structure',
            jsonb_build_object('document_id', new.id),
            'extract:' || new.sha256)
    on conflict (idempotency_key) do nothing;
  return new;
end $$;
create trigger trg_document_inserted after insert on documents
  for each row execute function on_document_inserted();

-- 3. Tree node inserted → enqueue summarize
create function on_tree_node_inserted() returns trigger language plpgsql security definer as $$
begin
  perform pgmq.send('q_summarize_node',
    jsonb_build_object(
      'node_id', new.id, 'document_id', new.document_id,
      'idempotency_key', 'sum:' || new.document_id || ':' || new.node_id_str
    ));
  return new;
end $$;
create trigger trg_tree_node_inserted after insert on tree_nodes
  for each row execute function on_tree_node_inserted();

-- 4. Todos los summaries ready → enqueue finalize (advisory lock)
create function on_tree_node_ready() returns trigger language plpgsql security definer as $$
declare
  pending_count int;
begin
  if new.status = 'ready' and (old.status is null or old.status != 'ready') then
    perform pg_advisory_xact_lock(hashtext(new.document_id::text));
    select count(*) into pending_count
      from tree_nodes
     where document_id = new.document_id and status != 'ready';
    if pending_count = 0 then
      perform pgmq.send('q_finalize',
        jsonb_build_object(
          'document_id', new.document_id,
          'idempotency_key', 'final:' || new.document_id
        ));
    end if;
  end if;
  return new;
end $$;
create trigger trg_tree_node_ready after update on tree_nodes
  for each row execute function on_tree_node_ready();
```

### pg_cron jobs

```sql
-- Helper que envuelve net.http_post para drenar una queue pgmq y disparar HTTP a srv-ia-01.
-- Implementación: pop N mensajes de la queue, por cada uno chequear backpressure,
-- llamar net.http_post (async), marcar in_flight en indexing_jobs.
create function dispatch_pgmq_to_srv_ia(
  p_queue_name text,
  p_endpoint_path text,
  p_max_messages int
) returns int language plpgsql security definer as $$
declare
  msg record;
  count_dispatched int := 0;
  srv_url text := current_setting('app.srv_ia_01_url');  -- ej 'https://srv-ia-01.internal'
  bearer text;
begin
  if p_max_messages <= 0 then return 0; end if;
  select decrypted_secret into bearer from vault.decrypted_secrets where name = 'srv_ia_01_secret';
  for msg in
    select * from pgmq.read(p_queue_name, 600, p_max_messages)  -- vt=600s visibility
  loop
    perform net.http_post(
      url := srv_url || p_endpoint_path,
      body := msg.message,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || bearer
      ),
      timeout_milliseconds := 120000
    );
    update indexing_jobs set status = 'in_flight', attempts = attempts + 1
      where msg_id = msg.msg_id;
    perform increment_rate_limit('deepseek');
    count_dispatched := count_dispatched + 1;
  end loop;
  return count_dispatched;
end $$;

-- Tick que drena las colas (cada 10s) — respetando backpressure
select cron.schedule('drain-queues', '*/10 * * * * *', $$
  with capacity_deepseek as (
    select greatest(0, max_concurrent - in_flight) as slots
      from rate_limits where provider='deepseek'
  )
  select dispatch_pgmq_to_srv_ia('q_extract_structure', '/index/structure',
                                  (select slots from capacity_deepseek));
  -- Repetir el SELECT por cada queue activa (q_summarize_node, q_finalize, etc.)
$$);

-- GC de LangGraph checkpoints viejos
select cron.schedule('gc-checkpoints', '0 3 * * *', $$
  delete from langgraph_checkpoints.checkpoints
   where ts < now() - interval '7 days';
$$);

-- Refresh de materialized views (Wave 2)
select cron.schedule('refresh-quality-mvs', '*/15 * * * *', $$
  refresh materialized view concurrently mv_indexing_quality_daily;
  refresh materialized view concurrently mv_llm_costs_daily;
  refresh materialized view concurrently mv_cache_hit_ratio;
$$);
```

### Materialized views (Wave 2)

```sql
create materialized view mv_llm_costs_daily as
  select date_trunc('day', created_at) as day,
         model,
         count(*) as calls,
         sum(prompt_tokens) as in_tokens,
         sum(completion_tokens) as out_tokens,
         sum(cached_tokens) as cached_tokens,
         round(sum(cached_tokens)::numeric / nullif(sum(prompt_tokens),0), 4) as cache_hit_ratio,
         sum(cost_cents) as cost_cents
    from llm_calls
   group by 1, 2;
create unique index on mv_llm_costs_daily (day, model);

create materialized view mv_indexing_quality_daily as
  select date_trunc('day', recorded_at) as day,
         phase,
         metric_name,
         avg(metric_value) as avg_val,
         percentile_cont(0.5) within group (order by metric_value) as p50,
         percentile_cont(0.95) within group (order by metric_value) as p95
    from quality_metrics
   group by 1, 2, 3;
create unique index on mv_indexing_quality_daily (day, phase, metric_name);

create materialized view mv_cache_hit_ratio as
  select date_trunc('hour', created_at) as hour,
         model,
         phase,
         round(sum(cached_tokens)::numeric / nullif(sum(prompt_tokens),0), 4) as ratio
    from llm_calls
   group by 1, 2, 3;
create unique index on mv_cache_hit_ratio (hour, model, phase);
```

---

## Sección 3 — Workflows LangGraph + endpoints FastAPI + prompts

### 3.1 Endpoints FastAPI

Cada endpoint autenticado con bearer token (Vault `srv_ia_01_secret`). Idempotency-Key como header. Respuestas estructuradas.

| Endpoint | Wave | Payload in | Payload out | Workflow |
|---|---|---|---|---|
| `POST /index/structure` | 0 | `{document_id, source_path, source_type, trace_id}` | `{node_count, total_pages, took_ms, path_used}` | `structure_workflow` |
| `POST /index/summarize` | 0 | `{node_id, document_id}` | `{summary, model, tokens_in, tokens_out, cached_tokens, took_ms}` | `summarize_workflow` |
| `POST /index/finalize` | 0 | `{document_id}` | `{status, node_count, total_cost_cents}` | `finalize_workflow` |
| `POST /index/embed` | 3 | `{node_id, embedding_type, modality}` | `{embedding_dim, took_ms}` | `embed_workflow` |
| `POST /index/extract_entities` | 3 | `{node_id}` | `{entities_count, relations_count}` | `entities_workflow` |
| `POST /index/predict_questions` | 3 | `{node_id}` | `{questions_count}` | `questions_workflow` |
| `POST /index/extract_typed` | 3 | `{document_id, schema_name}` | `{fields_count}` | `typed_workflow` |
| `POST /diff/reindex` | 3 | `{prev_document_id, new_document_id}` | `{nodes_kept, nodes_reused, nodes_rebuilt}` | `reindex_diff_workflow` |
| `POST /graph/query` | 3 | `{cypher, params}` | `{rows, took_ms}` | — (Kuzu direct) |
| `POST /graph/rebuild` | 3 | `{}` admin | `{nodes_synced, rels_synced, took_ms}` | — |
| `POST /graph/checkpoint` | 3 | `{}` admin | `{file_size_mb, took_ms}` | — |
| `GET /admin/dlq` | 2 | — | `[{queue, msg_id, reason, ...}]` | — |
| `POST /admin/dlq/replay/:id` | 2 | — | `{requeued: true}` | — |
| `GET /admin/metrics/summary` | 2 | — | `{cache_hit, cost_per_doc, accuracy_avg, dlq_depth}` | — |
| `GET /health` | 0 | — | `{db, deepseek, openrouter, version}` | — |

### 3.2 `structure_workflow` (LangGraph)

```python
from typing import TypedDict, Annotated, Literal
import operator
from langgraph.graph import StateGraph, START, END
from langgraph.types import Send

class StructureState(TypedDict):
    document_id: str
    source_path: str
    source_type: Literal['pdf', 'markdown']
    trace_id: str
    parsed: dict | None
    heuristic_path: Literal['fast', 'full'] | None
    toc_pages: list[int]
    toc_json: list[dict] | None
    nodes_flat: Annotated[list[dict], operator.add]
    nodes_persisted: bool
    accuracy_score: float | None
    repair_attempts: int

def build_structure_graph():
    g = StateGraph(StructureState)
    g.add_node("parse_document", parse_document)
    g.add_node("heuristic_check", heuristic_check)
    g.add_node("fast_path_extract", fast_path_extract)
    g.add_node("detect_toc", detect_toc)
    g.add_node("extract_toc_json", extract_toc_json)
    g.add_node("index_extraction", index_extraction)
    g.add_node("validate_structure", validate_structure)
    g.add_node("repair_structure", repair_structure)
    g.add_node("split_large_nodes", split_large_nodes)
    g.add_node("build_tree", build_tree)
    g.add_node("persist_nodes", persist_nodes)

    g.add_edge(START, "parse_document")
    g.add_edge("parse_document", "heuristic_check")
    g.add_conditional_edges("heuristic_check", route_by_heuristic, {
        "fast": "fast_path_extract",
        "full": "detect_toc",
    })
    g.add_edge("fast_path_extract", "build_tree")
    g.add_edge("detect_toc", "extract_toc_json")
    g.add_edge("extract_toc_json", "index_extraction")
    g.add_edge("index_extraction", "validate_structure")
    g.add_conditional_edges("validate_structure", route_by_accuracy, {
        "ok": "split_large_nodes",
        "repair": "repair_structure",
        "fail": END,
    })
    g.add_edge("repair_structure", "validate_structure")
    g.add_edge("split_large_nodes", "build_tree")
    g.add_edge("build_tree", "persist_nodes")
    g.add_edge("persist_nodes", END)
    return g.compile(checkpointer=postgres_checkpointer)

def route_by_heuristic(state: StructureState) -> str:
    """Wave 1 — Mejora #5 (fast-path heuristics)."""
    p = state["parsed"]
    cfg = settings.resolve_sync('parser.fast_path.*', doc_type=state.get('doc_type'))
    if not cfg['enabled']:
        return "full"
    return "fast" if (
        p["heading_density"] >= cfg['min_heading_density']
        and p["toc_extracted_by_mineru"]
        and p["ocr_confidence"] >= cfg['min_ocr_confidence']
        and (cfg['allow_complex_tables'] or not p["has_complex_tables"])
        and (cfg['allow_multi_column']  or not p["has_multi_column_layout"])
    ) else "full"
```

### 3.3 `summarize_workflow` (LangGraph)

```python
class SummarizeState(TypedDict):
    node_id: str
    document_id: str
    node_text: str | None
    contextual_prefix: str | None     # Wave 1 mejora #1
    selected_model: str | None        # Wave 1 mejora #6
    summary: str | None
    tokens_in: int
    tokens_out: int
    cached_tokens: int
    cost_cents: float
    should_wait: bool

def build_summarize_graph():
    g = StateGraph(SummarizeState)
    g.add_node("load_node_text", load_node_text)
    g.add_node("build_contextual_prefix", build_contextual_prefix)
    g.add_node("select_model", select_model)
    g.add_node("check_backpressure", check_backpressure)
    g.add_node("call_deepseek", call_deepseek)
    g.add_node("validate_output", validate_output)
    g.add_node("persist_summary", persist_summary)
    g.add_node("record_metrics", record_metrics)

    g.add_edge(START, "load_node_text")
    g.add_edge("load_node_text", "build_contextual_prefix")
    g.add_edge("build_contextual_prefix", "select_model")
    g.add_edge("select_model", "check_backpressure")
    g.add_conditional_edges("check_backpressure", lambda s:
        "wait" if s["should_wait"] else "call", {
        "wait": END,
        "call": "call_deepseek",
    })
    g.add_edge("call_deepseek", "validate_output")
    g.add_edge("validate_output", "persist_summary")
    g.add_edge("persist_summary", "record_metrics")
    g.add_edge("record_metrics", END)
    return g.compile(checkpointer=postgres_checkpointer)
```

**Fan-out crítico:** se hace en pgmq (un mensaje por nodo, trigger AFTER INSERT), no en LangGraph. Cada call HTTP a srv-ia-01 procesa UN solo nodo. pgmq + pg_cron paralelizan a nivel de cluster.

### 3.4 Diseño cache-friendly de prompts (Mejora #4)

Estructura **prefijo-estable / sufijo-variable** para maximizar prompt cache de DeepSeek.

`prompts/_base.j2`:

```jinja
{# === STABLE PREFIX (cacheable) === #}
You are SDA-Indexer, a document indexing assistant.

Task: {{ task_name }}
Output format: {{ output_format }}

Document context:
- Title: {{ doc.title }}
- Type: {{ doc.doc_type or 'unknown' }}
- Description: {{ doc.description or 'not yet generated' }}
- Total pages: {{ doc.page_count }}
- Source: {{ doc.source_type }}

Rules (strict):
{% for rule in rules %}
- {{ rule }}
{% endfor %}

{# === VARIABLE SUFFIX (no cacheable) === #}

Input:
{{ input_content }}
```

`prompts/summarize.j2`:

```jinja
{% extends "_base.j2" %}
{% block task_name %}summarize_node{% endblock %}
{% block output_format %}
A 2-4 sentence summary in {{ language }}, focused on what content this section
contains so that a downstream agent can decide whether to read it for a given
query. Do not include filler ("This section discusses..."); start with the topic.
{% endblock %}
{% block rules %}
- Be concrete: name entities, dates, amounts when present.
- Do not hallucinate content beyond what the input contains.
- If the input is a table or figure caption, describe what the table shows, not how it looks.
- Stay within {{ max_chars }} characters unless content is unusually dense.
{% endblock %}
{% block input_content %}
[Section context: {{ ancestor_path }}]
[Pages {{ node.start_index }}–{{ node.end_index }}]
{{ node.text }}
{% endblock %}
```

`ancestor_path` materializa la **mejora #1 (contextual chunking)**: breadcrumb completo del nodo dentro del documento, dando al LLM contexto explícito de ubicación.

### 3.5 Organización de módulos Python

```
srv-ia-01:/opt/sda-indexer/
├── pyproject.toml                  # uv-managed
├── Dockerfile
├── docker-compose.yml
├── src/sda_indexer/
│   ├── api/                        # FastAPI routers
│   ├── workflows/                  # LangGraph StateGraphs
│   ├── pipeline/
│   │   ├── parser/                 # mineru, markdown_regex, heuristics
│   │   ├── structure/              # toc_detector, transformer, extractor, validator, repair
│   │   ├── splitter/
│   │   ├── summarizer/             # contextual_prefix, summarize
│   │   ├── tree/                   # builder, formatter
│   │   ├── entities/               # Wave 3
│   │   ├── questions/              # Wave 3
│   │   ├── typed/                  # Wave 3
│   │   ├── diff/                   # Wave 3
│   │   └── graph/                  # Wave 3 (Kuzu writer/query)
│   ├── llm/                        # client, router, cache_design, backpressure, retry
│   ├── embeddings/                 # Wave 3
│   ├── prompts/                    # _base.j2 + un .j2 por tarea
│   ├── db/                         # client, documents, tree_nodes, jobs, ...
│   ├── settings/                   # registry, client, listener, sync
│   ├── observability/              # otel, langfuse, metrics
│   ├── settings.py
│   └── main.py                     # FastAPI + lifespan
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
└── scripts/
```

**Regla:** ningún archivo `.py` supera ~300 líneas. Tests 1:1 con módulos. Funciones LangGraph delegan TODA la lógica a `pipeline/*` (wrappers de 5-15 líneas).

---

## Sección 4 — Plan de implementación por olas

### Wave 0 — Foundation (5-7 días)

**Goal:** loop end-to-end con markdown + sistema de settings funcionando.

**Deliverables:**

Supabase migraciones:
- `001_extensions.sql` — pgmq, pg_cron, pg_net, vault, pgcrypto, vector
- `002_tables_core.sql` — documents, tree_nodes, indexing_jobs, llm_calls, quality_metrics, rate_limits
- `003_tables_wave3.sql` — node_questions, node_entities, node_relations, node_typed_fields, node_embeddings (vacías, schema ready)
- `004_app_settings.sql` — app_settings + history + trigger
- `005_queues.sql` — pgmq queues Wave 0 (extract_structure, summarize_node, finalize)
- `006_triggers.sql` — on_storage_doc_uploaded, on_document_inserted, on_tree_node_inserted, on_tree_node_ready
- `007_cron.sql` — drain-queues every 10s, gc-checkpoints daily
- `008_storage_bucket.sql` — bucket 'docs' private

Vault:
- `deepseek_api_key`, `srv_ia_01_secret`

srv-ia-01 v0.1:
- `pyproject.toml` + `Dockerfile` + `docker-compose.yml`
- `src/sda_indexer/main.py` (FastAPI + lifespan + auth middleware)
- Endpoints: `/index/structure`, `/index/summarize`, `/index/finalize`, `/health`
- Workflows: `structure.py` (MD only path), `summarize.py`, `finalize.py`
- Pipeline: `parser/markdown_regex.py`, `structure/*` (stubs PDF), `summarizer/`, `tree/`
- LLM: `llm/client.py` (OpenAI-compatible SDK → DeepSeek)
- DB: `db/client.py` (supabase-py + asyncpg pool), `db/documents.py`, `db/tree_nodes.py`
- Settings: `settings/registry.py` (~30 settings iniciales), `settings/client.py` (cache + pg_notify listener), boot sync
- Tests: unit + integration con Supabase local

**Criterios de done:**

| # | Criterio |
|---|---|
| D-0.1 | Subir `tests/fixtures/tiny.md` (3 secciones) → en <30s aparece doc `ready` con 3+ tree_nodes con summaries |
| D-0.2 | Idempotencia: subir mismo .md 2 veces → única fila en documents |
| D-0.3 | Resiliencia: kill srv-ia-01 mid-summarize → pgmq reentrega y completa |
| D-0.4 | LangGraph checkpoints visibles en `langgraph_checkpoints.checkpoints` |
| D-0.5 | `pytest` verde, coverage >80% en `pipeline/` |
| D-0.6 | Cambiar setting `llm.model.summarize` vía SQL → próxima call usa el nuevo modelo sin restart |

**Mejoras incorporadas:** originales 1, 2, 3, 4, 10 + sistema de settings (cross-cutting).

### Wave 1 — PDF + costo (8-10 días)

**Goal:** PDFs reales (hasta 500 páginas) indexados en minutos por centavos.

**Deliverables:**

Supabase migraciones:
- `009_pdf_columns.sql` — documents.page_count, tree_nodes.text_contextualized, summary_model, appear_start, path_used

srv-ia-01 v0.2:
- `pipeline/parser/pdf_mineru.py` — wrapper MinerU
- `pipeline/parser/heuristics.py` — fast-path detection (Mejora #5)
- `pipeline/structure/{toc_detector,toc_transformer,index_extractor,validator,repair}.py` completos
- `pipeline/splitter/large_node.py` — recursive
- `pipeline/summarizer/contextual_prefix.py` — Mejora #1
- `llm/router.py` — tiered model selection (Mejora #6)
- `llm/cache_design.py` — prefix-stable helpers (Mejora #4)
- `prompts/*` — todos reescritos siguiendo `_base.j2`
- Workflows: `structure.py` con conditional edges fast/full

Settings expansion: ~20 settings nuevas (pageindex.*, parser.fast_path.*, summarize.contextual_chunking.*).

**Criterios de done:**

| # | Criterio |
|---|---|
| D-1.1 | PDF 50 páginas → indexado <2 min, costo <$0.05 |
| D-1.2 | PDF "lindo" (manual con TOC) → `path_used='fast'`, <30 calls DeepSeek |
| D-1.3 | PDF "feo" (scan sin TOC) → `path_used='full'`, accuracy_score >0.7 |
| D-1.4 | `mv_cache_hit_ratio` >0.75 para fase `summarize` post 5 docs |
| D-1.5 | `mv_llm_costs_daily` muestra V4 Pro en TOC/structure, V4 Flash en summaries |
| D-1.6 | `tree_nodes.text_contextualized` no null; summaries empiezan con tema |
| D-1.7 | PDF 300 páginas → indexado <10 min, costo <$0.50 |

**Mejoras incorporadas:** originales 5, 6, 8 + nuevas 1, 4, 5, 6.

### Wave 2 — Producción (5-7 días)

**Goal:** sistema operable, métricas visibles, fallas replayables.

**Deliverables:**

Supabase migraciones:
- `010_dlqs.sql` — pgmq DLQs
- `011_matviews.sql` — mv_llm_costs_daily, mv_indexing_quality_daily, mv_cache_hit_ratio

srv-ia-01 v0.3:
- `api/admin.py` — `/admin/dlq`, `/admin/dlq/replay/:id`, `/admin/metrics/summary`
- `llm/backpressure.py` — semaphore (Mejora #9)
- `observability/otel.py` — OTel boot con OTLP exporter (Mejora #10)
- `observability/langfuse.py` — CallbackHandler
- `observability/metrics.py` — quality_metrics writer
- `db/jobs.py` — DLQ inspection helpers

Infrastructure:
- `docker-compose.observability.yml` — Langfuse self-hosted en srv-ia-01
- Supabase Realtime publication en documents + tree_nodes

Next.js (sda.framework):
- `app/admin/quality/page.tsx` — tablero (Supabase JS + chart.js)
- `app/admin/dlq/page.tsx` — lista + replay
- `app/admin/settings/page.tsx` — settings tree + editor + history

Runbooks (`docs/runbooks/`):
- `01-doc-atascado.md`
- `02-dlq-replay.md`
- `03-cache-hit-ratio-bajo.md`
- `04-pipeline-lento.md`
- `05-kuzu-recovery.md` (placeholder, completo en Wave 3c)

**Criterios de done:**

| # | Criterio |
|---|---|
| D-2.1 | Forzar 5 fallas en summarize → mensaje en DLQ, listable en `/admin/dlq` |
| D-2.2 | `POST /admin/dlq/replay/:id` → procesa |
| D-2.3 | 100 docs en paralelo → max 50 inflight a DeepSeek, 0 errores 429 |
| D-2.4 | Trace navegable en Langfuse desde upload hasta `documents.status='ready'` |
| D-2.5 | `/admin/quality` muestra datos reales actualizándose cada 15 min |
| D-2.6 | Subscribirse a canal `doc:<id>` → eventos en vivo |
| D-2.7 | Runbook utilizable por tercero |
| D-2.8 | Admin UI permite editar settings con hot-reload comprobado |

**Mejoras incorporadas:** originales 7, 9 + nuevas 8, 9, 10, 11, 12.

### Wave 3 — Capacidades (3-4 semanas, 6 sub-olas paralelizables)

**Sub-olas:**

| Sub-ola | Esfuerzo | Mejora | Done criterion |
|---|---|---|---|
| 3a Q-prediction | 3d | #2 | Cada nodo nuevo tiene ≥3 preguntas en `node_questions` <30s post-summary |
| 3b Typed extraction | 5d | #3 | PDF doc_type='contract' → `node_typed_fields` poblado; SQL query estructurada funciona |
| 3c Entities + Kuzu | 7d | #13 | 10 contratos con "Acme Corp" → Cypher devuelve 10 docs; `/graph/rebuild` works |
| 3d Multi-modal | 5d | #14 | PDF con tabla → tree_node `node_type='table'` con summary y JSON estructurado |
| 3e Embeddings Gemini | 5d | #15 | doc con `hybrid_mode=true` → embeddings 768d en `node_embeddings`; top-k <50ms |
| 3f Incremental re-index | 7d | #7 | contract_v2 cambia 2 nodos → re-procesa 2, costo <5% del original |

**3c — Detalle Kuzu:**

```cypher
CREATE NODE TABLE Document(id UUID, sha256 STRING, doc_type STRING, title STRING, PRIMARY KEY (id));
CREATE NODE TABLE TreeNode(id UUID, document_id UUID, depth INT16, title STRING, PRIMARY KEY (id));
CREATE NODE TABLE Entity(id UUID, entity_type STRING, entity_value STRING, normalized_value STRING, PRIMARY KEY (id));
CREATE REL TABLE BelongsTo(FROM TreeNode TO Document);
CREATE REL TABLE MentionedIn(FROM Entity TO TreeNode, confidence DOUBLE);
CREATE REL TABLE Relates(FROM Entity TO Entity, predicate STRING, node_id UUID, confidence DOUBLE);
```

Estrategia: write-through Postgres + Kuzu en el mismo handler. Postgres source-of-truth, Kuzu read-side projection. Recovery: `rm graph.kz && POST /graph/rebuild`.

**Trigger objetivo upgrade path Kuzu → Neo4j:** archivo `.kz` >5GB o p95 multi-hop >1s.

### Gate Wave 2 → Wave 3

Antes de avanzar:

- 50+ docs reales procesados sin intervención manual
- Cache hit ratio promedio >75%
- Latency p95 indexado <5 min para PDFs <100 páginas
- Costo medio <$0.10 por doc <100 páginas
- 0 mensajes en DLQs sin atender >24h

Si falla algún criterio → no Wave 3, primero estabilizamos.

---

## Sección 5 — Error handling, observabilidad, operaciones

### 5.1 Modelo de fallos

| Capa | Falla | Detección | Respuesta |
|---|---|---|---|
| Storage | Webhook no dispara | Doc no aparece | Admin `POST /admin/reingest/:storage_path` |
| Trigger SQL | Excepción | Log Postgres | Bloque EXCEPTION logea, no propaga |
| pg_net | Timeout / red caída | `net._http_response.error_msg` | pgmq visibility timeout reentrega |
| srv-ia-01 down | Connection refused | pg_net error | Retries automáticos; alerta >5min |
| LangGraph node | Excepción Python | Checkpoint preservado | Retry desde último nodo OK |
| LLM timeout | DeepSeek >120s | TimeoutException | tenacity backoff exponencial 3 tries |
| LLM 429 | Rate limit | RateLimitError | Backpressure increment, pausa drain |
| LLM 5xx | Server error | Response code | 3 retries; después DLQ |
| LLM output inválido | Parse fail | Validation node | 2 retries prompt estricto; después DLQ |
| Kuzu write conflict | Exception | Catch | 3 retries; Postgres SOT, log to quality_metrics |
| Postgres unique violation | INSERT colisión | UniqueViolation | Log INFO ("idempotency"), continuar |
| Pool exhausted | Timeout | Health check | Pool tuning; alerta sostenido |
| Disco lleno | OSError | Health check | Alerta 80%, rotación logs |
| MinerU OOM | Process killed (137) | exit code | Retry con --max-pages reducido |

### 5.2 Estrategia multi-capa de retries

```
CAPA 4 — DLQ (humano: minutos+)
   ↑
CAPA 3 — pgmq visibility timeout (red/proceso: 60-600s)
   ↑
CAPA 2 — LangGraph checkpoints (workflow: dentro de 1 invocación)
   ↑
CAPA 1 — tenacity (red/5xx: 1-8s)
```

### 5.3 Contrato de idempotencia

| Recurso | Clave unique | Comportamiento |
|---|---|---|
| `documents` | `sha256` | ON CONFLICT DO NOTHING |
| `indexing_jobs` | `idempotency_key` | duplicado → falla, primero procede |
| `tree_nodes` | `(document_id, node_id_str)` | re-process idempotente |
| Summary writes | UPDATE WHERE id | pisa, no duplica |
| `node_entities` | `(node_id, entity_type, normalized_value)` | re-extract idempotente |
| `node_relations` | `(node_id, src, predicate, dst)` | idempotente |
| `node_embeddings` | `(node_id, embedding_type, model)` | re-embed pisa |
| Kuzu writes | Cypher MERGE | idempotente por diseño |
| LangGraph checkpoints | `(thread_id, ts)` | PostgresSaver idempotente |

### 5.4 Observabilidad

**Logs:** structured JSON en stdout. Campos: timestamp, level, service, trace_id, span_id, document_id, node_id, phase, model, event, message. Output → Loki o stdout, retención 30d.

**Traces (OpenTelemetry → Langfuse):**

```
[ROOT] indexing.document
├── [SPAN] storage.webhook.received
├── [SPAN] pgmq.enqueue
├── [SPAN] pgcron.tick.dispatch
├── [SPAN] http.pg_net.call
├── [SPAN] workflow.structure.execute
│   ├── [SPAN] node.parse_document
│   ├── [SPAN] node.heuristic_check
│   ├── [SPAN] node.detect_toc
│   │   └── [SPAN] llm.call (attrs: model, tokens, cost, latency)
│   └── ...
├── [SPAN] pgmq.batch.summarize
│   └── [SPAN] workflow.summarize (× N parallel)
└── [SPAN] workflow.finalize
```

**Métricas:** `llm_calls`, `quality_metrics` tables → mat-views → `/admin/quality` dashboard.

**Realtime:** canales `doc:{document_id}` y `system:health`.

### 5.5 Alertas (umbrales iniciales)

| Alerta | Umbral | Severidad |
|---|---|---|
| DLQ no atendido | count >0 por >24h | medium |
| Cache hit ratio caída | >10% w-o-w | low |
| Costo por doc anómalo | >2x mediana 7d | medium |
| Accuracy validation | avg <0.7 por >24h | high |
| Disco srv-ia-01 | >80% | high |
| Backpressure saturado | max >10 min | medium |
| Queue depth | pgmq >1000 por >15min | medium |
| LangGraph checkpoint table | >5GB | low |
| Kuzu file size | >5GB | low (trigger re-eval) |
| Health check fail | 3 consecutivos | critical |

Implementación inicial: Edge Function `cron-alerts` cada 5min → Slack webhook.

### 5.6 Runbooks (`docs/runbooks/`)

| # | Runbook | Cuándo |
|---|---|---|
| 01 | doc-atascado | status quedó >30min en parsing/summarizing |
| 02 | dlq-replay | mensaje en DLQ |
| 03 | cache-hit-ratio-bajo | ratio cayó significativamente |
| 04 | pipeline-lento | p95 latency degradó |
| 05 | kuzu-recovery | .kz corrupto / perdido |
| 06 | deepseek-key-rotation | rotar key sin downtime |
| 07 | srv-ia-01-restart | restart limpio + drain |
| 08 | langgraph-schema-migration | agregar campo a State sin romper threads |
| 09 | backup-restore | Supabase PITR + Storage + Kuzu .kz |
| 10 | bootstrap-from-scratch | DR completo |

Runbooks 01-05 son **must-have al final de Wave 2** (cubren los incidentes operativos más probables del sistema base). Runbooks 06-10 se escriben **on-demand** cuando el escenario aparece o cuando una sub-ola los necesita (ej: 05 kuzu-recovery se completa con Wave 3c, 09 backup-restore al final de Wave 3, 10 bootstrap-from-scratch cuando haya equipo).

---

## Sección 5.5 — Configurabilidad universal

### Principio

**Dos clases:**
- **Estructura (code-time):** topología workflow, módulos, schema DB, endpoints. Cambia con deploy.
- **Tunables (runtime-config):** modelos, prompts, timeouts, thresholds, schemas, feature flags. **Cambia sin deploy.**

**Cero magic numbers en código.** Cualquier número/string/threshold/flag tunable → setting.

### Scope cascade

`global < doc_type < collection < document`

Resolución: el más específico que exista. Si ninguno, default del registry.

### Definición del registro

```python
# src/sda_indexer/settings/types.py
from dataclasses import dataclass
from typing import Literal, Any

ValueType = Literal[
    'string','number','boolean','object','array',
    'duration_ms','prompt_template','model_id','json_schema','enum'
]
Scope = Literal['global','doc_type','collection','document']

@dataclass(frozen=True)
class SettingDef:
    key: str
    value_type: ValueType
    default: Any
    description: str
    scopes: list[Scope]
    validation: dict | None = None     # JSON Schema
    is_secret: bool = False
```

### Registry de settings (sample, ~80-100 settings al final de Wave 3)

**Nota sobre placeholders:** las descripciones marcadas `'...'` se completan al implementar cada setting (una línea humana explicando uso y trade-offs). Los schemas tipados marcados `{...}` se definen como Pydantic models en `pipeline/typed/schemas/*.py` y se serializan a JSON Schema al cargar al registro. Estos placeholders son intencionales — el spec captura ESTRUCTURA, no el contenido literal de cada descripción.

```python
SETTINGS: list[SettingDef] = [
    # LLM model selection (Mejora #6)
    SettingDef('llm.model.toc_detect',     'model_id', 'deepseek/deepseek-v4-pro', '...', scopes=['global','doc_type']),
    SettingDef('llm.model.structure',      'model_id', 'deepseek/deepseek-v4-pro', '...', scopes=['global','doc_type']),
    SettingDef('llm.model.validate',       'model_id', 'deepseek/deepseek-v4-pro', '...', scopes=['global','doc_type']),
    SettingDef('llm.model.summarize',      'model_id', 'deepseek/deepseek-v4-flash', '...', scopes=['global','doc_type','collection','document']),
    SettingDef('llm.model.doc_description','model_id', 'deepseek/deepseek-v4-pro', '...', scopes=['global','doc_type']),
    SettingDef('llm.model.entities',       'model_id', 'deepseek/deepseek-v4-pro', '...', scopes=['global','doc_type','collection']),
    SettingDef('llm.model.questions',      'model_id', 'deepseek/deepseek-v4-flash', '...', scopes=['global','doc_type','collection']),
    SettingDef('llm.model.embedding',      'model_id', 'openrouter/google/gemini-embedding-2-preview', '...', scopes=['global','collection']),

    # Rate limits y backpressure (Mejora #9)
    SettingDef('llm.max_concurrent.deepseek',   'number', 50,  '...', scopes=['global']),
    SettingDef('llm.max_concurrent.openrouter', 'number', 10,  '...', scopes=['global']),
    SettingDef('llm.rpm_limit.deepseek',        'number', 600, '...', scopes=['global']),

    # Retries y timeouts
    SettingDef('llm.timeout_ms.summarize',  'duration_ms', 30000,  '...', scopes=['global']),
    SettingDef('llm.timeout_ms.structure',  'duration_ms', 120000, '...', scopes=['global']),
    SettingDef('llm.retry.max_attempts',    'number', 3, '...', scopes=['global']),
    SettingDef('llm.retry.backoff_base_ms', 'number', 1000, '...', scopes=['global']),
    SettingDef('llm.retry.backoff_max_ms',  'number', 8000, '...', scopes=['global']),

    # pgmq y pg_cron
    SettingDef('pgmq.visibility_timeout.q_extract_structure', 'duration_ms', 600000, '...', scopes=['global']),
    SettingDef('pgmq.visibility_timeout.q_summarize_node',    'duration_ms', 120000, '...', scopes=['global']),
    SettingDef('pgmq.visibility_timeout.q_finalize',          'duration_ms', 60000,  '...', scopes=['global']),
    SettingDef('pgmq.max_retries_before_dlq.q_summarize_node','number', 5, '...', scopes=['global']),
    SettingDef('pgcron.drain_interval_seconds', 'number', 10, '...', scopes=['global']),

    # PageIndex thresholds (originales del config.yaml)
    SettingDef('pageindex.toc_check_page_num',     'number', 20, '...', scopes=['global','doc_type']),
    SettingDef('pageindex.max_page_num_each_node', 'number', 10, '...', scopes=['global','doc_type']),
    SettingDef('pageindex.max_token_num_each_node','number', 20000, '...', scopes=['global','doc_type']),
    SettingDef('pageindex.if_add_doc_description', 'boolean', True, '...', scopes=['global','doc_type','collection']),
    SettingDef('pageindex.if_add_node_text',       'boolean', False, '...', scopes=['global','doc_type']),
    SettingDef('pageindex.validation_min_accuracy','number', 0.6, '...', scopes=['global','doc_type']),
    SettingDef('pageindex.max_repair_attempts',    'number', 3, '...', scopes=['global']),

    # Fast-path heuristics (Mejora #5)
    SettingDef('parser.fast_path.enabled',                'boolean', True,  '...', scopes=['global','doc_type']),
    SettingDef('parser.fast_path.min_heading_density',    'number', 0.33,   '...', scopes=['global','doc_type']),
    SettingDef('parser.fast_path.require_toc_extracted',  'boolean', True,  '...', scopes=['global','doc_type']),
    SettingDef('parser.fast_path.min_ocr_confidence',     'number', 0.95,   '...', scopes=['global','doc_type']),
    SettingDef('parser.fast_path.allow_complex_tables',   'boolean', False, '...', scopes=['global','doc_type']),
    SettingDef('parser.fast_path.allow_multi_column',     'boolean', False, '...', scopes=['global','doc_type']),

    # Contextual chunking (Mejora #1)
    SettingDef('summarize.contextual_chunking.enabled',         'boolean', True, '...', scopes=['global','collection']),
    SettingDef('summarize.contextual_chunking.ancestor_depth',  'number',  3,    '...', scopes=['global','collection']),
    SettingDef('summarize.max_summary_chars',                   'number',  280,  '...', scopes=['global','doc_type']),

    # Embeddings (Mejora #15)
    SettingDef('embedding.dimensions',          'number',  768,  '...', scopes=['global','collection']),
    SettingDef('embedding.types_enabled',       'array',   ['content','summary'], '...', scopes=['global','collection']),

    # Feature flags
    SettingDef('feature.embeddings_enabled',           'boolean', False, '...', scopes=['global','collection']),
    SettingDef('feature.entity_extraction_enabled',    'boolean', False, '...', scopes=['global','collection']),
    SettingDef('feature.question_prediction_enabled',  'boolean', False, '...', scopes=['global','collection']),
    SettingDef('feature.typed_extraction_enabled',     'boolean', False, '...', scopes=['global','collection','doc_type']),
    SettingDef('feature.multimodal_enabled',           'boolean', False, '...', scopes=['global','collection']),
    SettingDef('feature.incremental_reindex_enabled',  'boolean', False, '...', scopes=['global','collection']),

    # Cache & TTL
    SettingDef('langgraph.checkpoint_ttl_days', 'number', 7, '...', scopes=['global']),
    SettingDef('matview.refresh_interval_minutes','number', 15, '...', scopes=['global']),

    # Alertas (Mejora #11)
    SettingDef('alerts.dlq_no_attention_hours',     'number', 24, '...', scopes=['global']),
    SettingDef('alerts.cache_hit_drop_threshold',   'number', 0.10, '...', scopes=['global']),
    SettingDef('alerts.cost_per_doc_anomaly_x',     'number', 2.0, '...', scopes=['global']),
    SettingDef('alerts.accuracy_min_threshold',     'number', 0.7, '...', scopes=['global']),
    SettingDef('alerts.slack_webhook_url',          'string', '', '...', scopes=['global'], is_secret=True),

    # Prompts (templates Jinja2 cargados de prompts/*.j2 al boot)
    SettingDef('prompt.template.toc_detect',     'prompt_template', '<from prompts/toc_detect.j2>', '...', scopes=['global','doc_type']),
    SettingDef('prompt.template.summarize',      'prompt_template', '<from prompts/summarize.j2>', '...', scopes=['global','doc_type','collection']),
    SettingDef('prompt.template.validate_toc',   'prompt_template', '<from prompts/validate_toc.j2>', '...', scopes=['global','doc_type']),
    # ... ~15 más

    # Schemas tipados (Wave 3 #3)
    SettingDef('typed_schema.contract', 'json_schema', {...}, '...', scopes=['global']),
    SettingDef('typed_schema.paper',    'json_schema', {...}, '...', scopes=['global']),
    SettingDef('typed_schema.invoice',  'json_schema', {...}, '...', scopes=['global']),
]
```

### Cliente Python (cache + hot-reload vía pg_notify)

```python
# CTE que resuelve scope cascade en una sola query
CASCADE_SQL = """
with candidates as (
  select value, case scope_type
    when 'document'   then 4
    when 'collection' then 3
    when 'doc_type'   then 2
    when 'global'     then 1
  end as priority
  from app_settings
  where deprecated_at is null and key = $1
    and (
      (scope_type='document'   and scope_value=$4) or
      (scope_type='collection' and scope_value=$3) or
      (scope_type='doc_type'   and scope_value=$2) or
      (scope_type='global')
    )
)
select value from candidates order by priority desc limit 1
"""

class SettingsClient:
    def __init__(self, db_pool, registry):
        self._cache = {}
        self._pool = db_pool
        self._registry = {s.key: s for s in registry}
        self._listener_task = asyncio.create_task(self._listen_for_changes())

    async def resolve(self, key, *, doc_type=None, collection_id=None, document_id=None):
        ctx = (key, doc_type, collection_id, document_id)
        if ctx in self._cache:
            return self._cache[ctx]
        row = await self._pool.fetchrow(CASCADE_SQL, key, doc_type, collection_id, document_id)
        value = row['value'] if row else self._registry[key].default
        self._cache[ctx] = value
        return value

    async def _listen_for_changes(self):
        async with self._pool.acquire() as conn:
            await conn.add_listener('settings_changed', self._on_change)
            await asyncio.Event().wait()

    def _on_change(self, conn, pid, channel, payload):
        evt = json.loads(payload)
        self._cache = {k: v for k, v in self._cache.items() if k[0] != evt['key']}
```

### Boot-time sync

Al inicio del FastAPI lifespan, el registry se sincroniza a DB: nuevas settings se insertan con default, settings removidas del registry quedan `deprecated_at` (visibles pero no usadas).

### Qué NO es configurable

| Cosa | Por qué |
|---|---|
| Conexión Supabase | Secret deploy |
| Topología LangGraph | Código |
| Schema DB | Migración |
| Módulos Python | Código |
| Protocolo pgmq→pg_net→FastAPI | Arquitectural |
| Lista de pgmq queues | Estructural (migración) |
| Registry mismo (qué settings existen) | Código |

---

## Sección 6 — Out of scope, suposiciones, riesgos, rollback

### 6.1 Out of scope

| No se construye | Cuándo se aborda |
|---|---|
| Retrieval (query side) | Spec siguiente |
| Multi-tenancy / RLS / auth | Spec aparte |
| UI usuario final | Spec product UI |
| MCP server endpoint | Spec aparte |
| API pública REST | Spec aparte |
| Purge GDPR / hard delete | Spec compliance |
| Multi-idioma | Spec i18n |
| Multi-environment | Cuando haya equipo |
| CI/CD deploy pipeline | Cuando duela |
| Failover multi-provider LLM | Cuando haya incidente real |
| Document cancellation | Si surge necesidad |
| Webhooks salientes | Spec integraciones |
| Anti-abuse | Con auth |

### 6.2 Suposiciones

| Suposición | Riesgo si falla | Verificación |
|---|---|---|
| Supabase Pro soporta pg_net, pg_cron, pgmq, vault, vector | Plan upgrade | Verificar antes Wave 0 |
| DeepSeek V4 Pro/Flash estables 2026-2027 | Re-elegir modelo | Pinear versión |
| OpenRouter Gemini Embedding 2 prod-ready | Fallback Gemini Embedding 001 | Monitor |
| MinerU 2 confiable en corpus real | Más LLM calls | Benchmark 20 PDFs antes Wave 1 |
| LangGraph AsyncPostgresSaver funciona en Supabase | Cambiar checkpointer | Smoke test Wave 0 |
| pg_net `timeout_milliseconds` respetado | Timeouts inconsistentes | Test con endpoint slow |
| srv-ia-01 tiene recursos suficientes | Escalar hardware | Inventario antes Wave 0 |
| DeepSeek cache funciona con prefijos jinja2 | Costos 100x previstos | Medir primer día Wave 1 |
| Kuzu estable pre-1.0 | Migrar a Neo4j | Pinear versión |
| Supabase Realtime aguanta cientos subscribers | Polling fallback | Load test Wave 2 |

### 6.3 Decisiones abiertas (resolver en implementación)

- Logging backend: stdout JSON al inicio; Loki/Cloud Logging cuando duela.
- Image storage multi-modal: separate Storage objects con refs en `tree_nodes.metadata`.
- DOWN migrations: cada `00X_*.sql` con su `00X_*_rollback.sql`.
- Supabase Branching: usable para testear migraciones; no obligatorio.
- Versionado de prompts: `app_settings_history` lo cubre.
- Concurrency Kuzu writes: `asyncio.Lock` global single-writer.
- Detección automática de `doc_type`: Wave 3 opcional con LLM clasificador.

### 6.4 Riesgos conocidos no mitigados

| Riesgo | Prob | Impacto | Por qué aceptamos |
|---|---|---|---|
| DeepSeek levanta precios May 2027 | alta | mod | Estructura permite swap |
| DeepSeek outage horas | media | alto | Backpressure+DLQ; vs +complejidad failover |
| MinerU falla en ciertos PDFs | media | mod | Fallback OCR genérico runbook |
| Kuzu corrupción bajo carga | baja | alto | Rebuild minutos |
| pg_net cae bajo carga (200 req/s) | media a alta carga | crítico | Si pasa: split queues / Inngest |
| LangGraph 2.x rompe State | media | medio | Pinneada; migración manual |
| Costos OTel/Langfuse > LLM | baja | medio | Sampling 10% si pasa |

### 6.5 Roadmap de specs siguientes

```
Spec 1 (este) Ingest+Index
       ↓
Spec 2 Retrieval (tree+hybrid+citation)  ← desbloquea producto
       ↓
Spec 3 Auth+multi-tenancy+RLS
       ↓
   ┌───┴───┐
   ↓       ↓
Spec 4a UI  Spec 4b API+MCP
       ↓
Spec 5 Compliance
       ↓
Spec 6 i18n
       ↓
Spec 7 Multi-provider LLM failover
```

### 6.6 Plan de rollback

| Nivel | Operación | Tiempo |
|---|---|---|
| Rollback setting | Editar admin UI o UPDATE app_settings | segundos |
| Rollback prompt | Igual / restore desde app_settings_history | segundos |
| Rollback srv-ia-01 | `docker compose up -d sda-indexer:vN-1` | 30s |
| Rollback migración | Correr `00X_*_rollback.sql` | minutos |
| Rollback Wave entera | Migraciones DOWN + redeploy anterior + disable flags | <1h |
| Bootstrap from scratch (DR) | Runbook `10` | 2-4h |

### 6.7 Métricas de éxito del spec

A los 8 semanas:

| Métrica | Target |
|---|---|
| Documentos procesados sin intervención manual | >95% |
| Cost per doc <100 páginas | <$0.10 mediana |
| Latency p95 indexado | <5 min para docs <100 páginas |
| Cache hit ratio promedio | >75% post-Wave 1 |
| Re-ingest mismo PDF | $0, <1s |
| Tiempo respuesta "cambiar prompt" | <5 min hasta primer use |
| Recovery from DLQ → producción | <15 min casos típicos |
| Pérdida de datos en crash test | 0% |

---

## Apéndice — Sources de la investigación

### PageIndex
- [PageIndex repo (VectifyAI, MIT)](https://github.com/VectifyAI/PageIndex)
- [PageIndex.ai blog intro](https://pageindex.ai/blog/pageindex-intro)
- [PageIndex DeepWiki (algoritmo deep-dive)](https://deepwiki.com/VectifyAI/PageIndex)
- [PageIndex RAG vs Traditional RAG (Medium 2026)](https://medium.com/@shubhamnv2/pageindex-rag-vs-traditional-rag-i-tested-both-heres-what-actually-works-in-2026-5a990726a80f)
- [GraphRAG vs PageIndex (Medium 2026)](https://medium.com/@umesh382.kushwaha/graphrag-vs-pageindex-when-knowledge-graphs-beat-vector-search-and-when-they-dont-25b10fad5fcb)
- [RAG vs GraphRAG systematic evaluation (arXiv 2502.11371)](https://arxiv.org/html/2502.11371v3)

### Anthropic Contextual Retrieval
- [Anthropic Contextual Retrieval cookbook](https://platform.claude.com/cookbook/capabilities-contextual-embeddings-guide)
- [Contextual chunking — Unstructured blog](https://unstructured.io/blog/contextual-chunking-in-unstructured-platform-boost-your-rag-retrieval-accuracy)

### LangGraph
- [LangGraph Postgres checkpointer](https://github.com/langchain-ai/langgraph/blob/main/libs/checkpoint-postgres/README.md)
- [LangGraph Send API (map-reduce)](https://github.com/langchain-ai/langgraph/blob/main/langgraph/libs/langgraph/langgraph/types.py)
- [LangGraph production checkpointing (Sparkco)](https://sparkco.ai/blog/mastering-langgraph-checkpointing-best-practices-for-2025)
- [LangGraph Postgres deploy 2026 (RapidClaw)](https://rapidclaw.dev/blog/deploy-langgraph-production-tutorial-2026)

### DeepSeek
- [DeepSeek V4 Pro pricing & cache (DevTk.AI 2026)](https://devtk.ai/en/blog/deepseek-api-pricing-guide-2026/)
- [DeepSeek JSON mode docs](https://api-docs.deepseek.com/guides/json_mode)
- [DeepSeek API official pricing](https://api-docs.deepseek.com/quick_start/pricing)

### Gemini Embedding 2 / OpenRouter
- [Gemini Embedding 2 Preview on OpenRouter](https://openrouter.ai/google/gemini-embedding-2-preview)
- [OpenRouter embedding models](https://openrouter.ai/collections/embedding-models)
- [Matryoshka Representation Learning (MindStudio)](https://www.mindstudio.ai/blog/matryoshka-representation-learning-gemini-embedding-2)
- [Gemini Embedding 2 specs (Medium)](https://medium.com/@tentenco/gemini-embedding-2-googles-first-natively-multimodal-embedding-model-specs-benchmarks-45dbcf80f4e9)

### MinerU
- [MinerU 2 repo (opendatalab)](https://github.com/opendatalab/mineru)
- [MinerU output format reference](https://opendatalab.github.io/MinerU/reference/output_files/)

### Supabase
- [Supabase Queues blog](https://supabase.com/blog/supabase-queues)
- [Supabase pgmq docs](https://supabase.com/docs/guides/queues/pgmq)
- [Build queue worker (Supabase Cron+Queue+EdgeFn)](https://dev.to/suciptoid/build-queue-worker-using-supabase-cron-queue-and-edge-function-19di)

### Graph DB para GraphRAG
- [Kuzu — embedded graph DB con Cypher](https://kuzudb.com/)
- [Apache AGE no en Supabase managed (gdotv)](https://gdotv.com/blog/running-apache-age-docker-cloud/)
- [Postgres CTE vs AGE vs Neo4j (Trendyol Tech)](https://medium.com/trendyol-tech/migrating-graph-operations-to-apache-age-from-writes-to-reads-3b8334628e1c)
- [Personal knowledge graph con solo PostgreSQL (DEV)](https://dev.to/micelclaw/4o-building-a-personal-knowledge-graph-with-just-postgresql-no-neo4j-needed-22b2)

### Document versioning
- [LiveVectorLake — versioned KB (arXiv 2601.05270)](https://arxiv.org/pdf/2601.05270)
- [Build RAG pipeline (Databricks)](https://docs.databricks.com/aws/en/generative-ai/tutorials/ai-cookbook/quality-data-pipeline-rag)
