# Ingest+Index Wave 0 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir el loop end-to-end de ingestión + indexación de markdown con sistema de settings hot-reloadable, base operativa para Waves 1-3.

**Architecture:** Supabase orquesta (pgmq + pg_cron + pg_net + triggers + Realtime + Vault), srv-ia-01 ejecuta workflows en Python (FastAPI + LangGraph + DeepSeek). Sin multi-tenancy, sin PDF support (Wave 1), sin observability avanzada (Wave 2).

**Tech Stack:** Python 3.12, FastAPI, LangGraph 1.x + AsyncPostgresSaver, supabase-py + asyncpg, OpenAI SDK (apuntando a DeepSeek), pydantic-settings, pytest + pytest-asyncio, uv, Docker. Supabase managed Postgres con pgmq/pg_cron/pg_net/vault/vector.

**Spec base:** [`docs/superpowers/specs/2026-05-24-ingest-index-design.md`](../specs/2026-05-24-ingest-index-design.md)

**Criterios de done de la Wave (del spec §4 Wave 0):**

| # | Criterio |
|---|---|
| D-0.1 | Subir `tests/fixtures/tiny.md` → en <30s aparece doc `ready` con 3+ tree_nodes con summaries |
| D-0.2 | Idempotencia: subir mismo .md 2 veces → única fila en documents |
| D-0.3 | Resiliencia: kill srv-ia-01 mid-summarize → pgmq reentrega y completa |
| D-0.4 | LangGraph checkpoints visibles en `langgraph_checkpoints.checkpoints` |
| D-0.5 | `pytest` verde, coverage >80% en `pipeline/` |
| D-0.6 | Cambiar setting `llm.model.summarize` vía SQL → próxima call usa el nuevo modelo sin restart |

---

## File Structure

```
sda.framework/                              # root del repo
├── supabase/migrations/
│   ├── 20260525000001_extensions.sql       # Task 2
│   ├── 20260525000002_tables_core.sql      # Task 3
│   ├── 20260525000003_tables_wave3.sql     # Task 4
│   ├── 20260525000004_app_settings.sql     # Task 5
│   ├── 20260525000005_queues.sql           # Task 6
│   ├── 20260525000006_triggers.sql         # Task 7
│   ├── 20260525000007_cron.sql             # Task 8
│   └── 20260525000008_storage_bucket.sql   # Task 9
└── services/sda-indexer/                   # Task 1: nuevo paquete Python
    ├── pyproject.toml                      # Task 1
    ├── .python-version                     # Task 1
    ├── Dockerfile                          # Task 10
    ├── docker-compose.yml                  # Task 10
    ├── README.md                           # Task 1
    ├── src/sda_indexer/
    │   ├── __init__.py                     # Task 1
    │   ├── main.py                         # Task 35 (FastAPI app)
    │   ├── config.py                       # Task 11 (pydantic-settings)
    │   ├── api/
    │   │   ├── __init__.py
    │   │   ├── auth.py                     # Task 30
    │   │   ├── health.py                   # Task 31
    │   │   ├── structure.py                # Task 32
    │   │   ├── summarize.py                # Task 33
    │   │   └── finalize.py                 # Task 34
    │   ├── workflows/
    │   │   ├── __init__.py
    │   │   ├── structure.py                # Task 28 (MD only)
    │   │   ├── summarize.py                # Task 27
    │   │   └── finalize.py                 # Task 29
    │   ├── pipeline/
    │   │   ├── __init__.py
    │   │   ├── parser/markdown_regex.py    # Task 24
    │   │   ├── summarizer/summarize.py     # Task 25
    │   │   └── tree/builder.py             # Task 23
    │   ├── llm/
    │   │   ├── client.py                   # Task 21
    │   │   └── retry.py                    # Task 22
    │   ├── db/
    │   │   ├── client.py                   # Task 18
    │   │   ├── documents.py                # Task 19
    │   │   └── tree_nodes.py               # Task 20
    │   ├── settings/
    │   │   ├── types.py                    # Task 12
    │   │   ├── registry.py                 # Task 13
    │   │   ├── client.py                   # Task 14
    │   │   └── sync.py                     # Task 15
    │   └── prompts/
    │       ├── _base.j2                    # Task 26
    │       └── summarize.j2                # Task 26
    └── tests/
        ├── conftest.py                     # Task 1
        ├── unit/
        │   ├── test_tree_builder.py        # Task 23
        │   ├── test_markdown_regex.py      # Task 24
        │   ├── test_settings_client.py     # Task 16
        │   ├── test_llm_retry.py           # Task 22
        │   └── test_summarizer.py          # Task 25
        ├── integration/
        │   ├── test_workflow_summarize.py  # Task 27
        │   ├── test_workflow_structure_md.py # Task 28
        │   └── test_end_to_end.py          # Task 36
        └── fixtures/
            ├── tiny.md                     # Task 1
            └── nested.md                   # Task 1
```

---

## Phase A — Repo skeleton + Supabase migrations (Tasks 1-9)

### Task 1: Setup Python project skeleton

**Files:**
- Create: `services/sda-indexer/pyproject.toml`
- Create: `services/sda-indexer/.python-version`
- Create: `services/sda-indexer/README.md`
- Create: `services/sda-indexer/src/sda_indexer/__init__.py`
- Create: `services/sda-indexer/tests/conftest.py`
- Create: `services/sda-indexer/tests/fixtures/tiny.md`
- Create: `services/sda-indexer/tests/fixtures/nested.md`
- Create: `services/sda-indexer/.gitignore`

- [ ] **Step 1: Create directory + base files**

Run from repo root:
```bash
mkdir -p services/sda-indexer/src/sda_indexer/{api,workflows,pipeline/{parser,summarizer,tree},llm,db,settings,prompts}
mkdir -p services/sda-indexer/tests/{unit,integration,fixtures}
cd services/sda-indexer
touch src/sda_indexer/__init__.py
touch src/sda_indexer/{api,workflows,pipeline,pipeline/parser,pipeline/summarizer,pipeline/tree,llm,db,settings}/__init__.py
touch tests/__init__.py tests/{unit,integration}/__init__.py
echo "3.12" > .python-version
```

- [ ] **Step 2: Write pyproject.toml**

Create `services/sda-indexer/pyproject.toml`:
```toml
[project]
name = "sda-indexer"
version = "0.1.0"
description = "SDA framework ingest+index service"
requires-python = ">=3.12"
dependencies = [
    "fastapi>=0.115.0",
    "uvicorn[standard]>=0.32.0",
    "langgraph>=1.0.0",
    "langgraph-checkpoint-postgres>=2.0.0",
    "openai>=1.50.0",
    "supabase>=2.8.0",
    "asyncpg>=0.30.0",
    "pydantic>=2.9.0",
    "pydantic-settings>=2.5.0",
    "jinja2>=3.1.4",
    "tenacity>=9.0.0",
    "python-dotenv>=1.0.0",
    "structlog>=24.4.0",
]

[dependency-groups]
dev = [
    "pytest>=8.3.0",
    "pytest-asyncio>=0.24.0",
    "pytest-cov>=5.0.0",
    "httpx>=0.27.0",
    "ruff>=0.7.0",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/sda_indexer"]

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
addopts = "-v --tb=short"

[tool.coverage.run]
source = ["src/sda_indexer/pipeline", "src/sda_indexer/settings"]

[tool.ruff]
line-length = 100
target-version = "py312"
```

- [ ] **Step 3: Write .gitignore**

Create `services/sda-indexer/.gitignore`:
```
__pycache__/
*.py[cod]
.venv/
.pytest_cache/
.coverage
htmlcov/
*.egg-info/
dist/
build/
.env
.env.local
```

- [ ] **Step 4: Write README.md**

Create `services/sda-indexer/README.md`:
```markdown
# sda-indexer

Python service for sda.framework ingest+index pipeline. Spec: [`docs/superpowers/specs/2026-05-24-ingest-index-design.md`](../../docs/superpowers/specs/2026-05-24-ingest-index-design.md).

## Setup

```bash
cd services/sda-indexer
uv sync
cp .env.example .env  # editar con keys reales
uv run pytest
```

## Run locally

```bash
docker compose up
```

## Architecture

Ver spec. Topología control-plane (Supabase) / data-plane (este servicio).
```

- [ ] **Step 5: Write conftest.py**

Create `services/sda-indexer/tests/conftest.py`:
```python
import asyncio
import os
import pytest


@pytest.fixture(scope="session")
def event_loop():
    """Single event loop for the whole test session."""
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture
def tiny_md_path(tmp_path):
    """Path to a small fixture markdown file."""
    return os.path.join(os.path.dirname(__file__), "fixtures", "tiny.md")


@pytest.fixture
def nested_md_path():
    return os.path.join(os.path.dirname(__file__), "fixtures", "nested.md")
```

- [ ] **Step 6: Write fixtures**

Create `services/sda-indexer/tests/fixtures/tiny.md`:
```markdown
# Documento de prueba

Este es un documento muy chico para validar el pipeline.

## Sección uno

Contenido de la primera sección con algún texto suficientemente
descriptivo para que el summarizer tenga algo que resumir.

## Sección dos

Más contenido en otra sección. La idea es que cada heading se vuelva
un tree_node con su summary.
```

Create `services/sda-indexer/tests/fixtures/nested.md`:
```markdown
# Manual técnico

Documento de prueba con jerarquía profunda.

## Capítulo 1: Introducción

Texto introductorio.

### 1.1 Contexto

Contexto del manual y motivación.

### 1.2 Audiencia

A quién está dirigido este manual.

## Capítulo 2: Instalación

Pasos para instalar.

### 2.1 Requisitos

Hardware y software previos.

### 2.2 Pasos

Comandos a correr en orden.
```

- [ ] **Step 7: Setup uv y verify build**

Run:
```bash
cd services/sda-indexer
uv sync
uv run python -c "import sda_indexer; print('OK')"
```
Expected: prints `OK`, no errors.

- [ ] **Step 8: Commit**

```bash
git add services/sda-indexer/
git commit -m "feat(indexer): bootstrap Python service skeleton

Crea services/sda-indexer/ con pyproject.toml, structure modular,
fixtures de tests, conftest. Setup uv-managed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Migration 001 — Extensions

**Files:**
- Create: `supabase/migrations/20260525000001_extensions.sql`

- [ ] **Step 1: Write migration**

Create `supabase/migrations/20260525000001_extensions.sql`:
```sql
-- Wave 0: habilitar extensiones requeridas por el pipeline
-- Spec ref: §2 Schema de Supabase

create extension if not exists pgcrypto;                -- digest() para sha256
create extension if not exists pgmq;                    -- message queues
create extension if not exists pg_cron;                 -- scheduled jobs
create extension if not exists pg_net with schema extensions;  -- async HTTP from SQL
create extension if not exists vault;                   -- secret storage
create extension if not exists vector;                  -- embeddings (Wave 3, pero schema ready)
```

- [ ] **Step 2: Apply migration locally**

Run:
```bash
cd /Users/enzo/sda.framework/sda.framework
supabase db push
```
Expected: "Applying migration 20260525000001_extensions.sql..." sin error.

- [ ] **Step 3: Verify extensions installed**

Run:
```bash
supabase db remote query "select extname from pg_extension where extname in ('pgmq','pg_cron','pg_net','vault','vector','pgcrypto') order by extname;"
```
Expected output: 6 rows, una por extensión.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260525000001_extensions.sql
git commit -m "feat(db): wave 0 migration — enable required extensions

pgmq, pg_cron, pg_net, vault, vector, pgcrypto. Spec §2.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Migration 002 — Tablas core

**Files:**
- Create: `supabase/migrations/20260525000002_tables_core.sql`

- [ ] **Step 1: Write migration**

Create `supabase/migrations/20260525000002_tables_core.sql`. Contenido completo del spec §2 "Tablas core":

```sql
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
```

- [ ] **Step 2: Apply + verify**

```bash
supabase db push
supabase db remote query "select tablename from pg_tables where schemaname='public' and tablename in ('documents','tree_nodes','indexing_jobs','llm_calls','quality_metrics','rate_limits') order by tablename;"
```
Expected: 6 rows.

- [ ] **Step 3: Verify dedup constraint**

```bash
supabase db remote query "insert into documents (sha256, source_path, source_type) values ('test-sha', 'foo.md', 'markdown'); insert into documents (sha256, source_path, source_type) values ('test-sha', 'bar.md', 'markdown') on conflict (sha256) do nothing returning id;"
```
Expected: primer INSERT crea fila, segundo no devuelve rows (ON CONFLICT DO NOTHING). Cleanup:
```bash
supabase db remote query "delete from documents where sha256='test-sha';"
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260525000002_tables_core.sql
git commit -m "feat(db): wave 0 migration — core tables

documents, tree_nodes, indexing_jobs, llm_calls, quality_metrics, rate_limits.
Spec §2.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Migration 003 — Tablas Wave 3 (vacías, schema ready)

**Files:**
- Create: `supabase/migrations/20260525000003_tables_wave3.sql`

- [ ] **Step 1: Write migration**

Create `supabase/migrations/20260525000003_tables_wave3.sql`:
```sql
-- Wave 0: schema de Wave 3 desde el inicio para evitar migraciones futuras
-- Spec ref: §2 Tablas Wave 3

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
```

- [ ] **Step 2: Apply + verify**

```bash
supabase db push
supabase db remote query "select tablename from pg_tables where schemaname='public' and tablename like 'node_%' order by tablename;"
```
Expected: 5 rows (node_embeddings, node_entities, node_questions, node_relations, node_typed_fields).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260525000003_tables_wave3.sql
git commit -m "feat(db): wave 0 migration — wave 3 tables ready (empty)

node_questions, node_entities, node_relations, node_typed_fields,
node_embeddings con HNSW index. Vacías en Wave 0, se llenan en Wave 3.
Crearlas ahora evita migraciones de datos futuras.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Migration 004 — Sistema de app_settings

**Files:**
- Create: `supabase/migrations/20260525000004_app_settings.sql`

- [ ] **Step 1: Write migration**

Create `supabase/migrations/20260525000004_app_settings.sql`:
```sql
-- Wave 0: sistema de configurabilidad universal
-- Spec ref: §5.5 Configurabilidad universal

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
create index on app_settings_history (setting_id);

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

- [ ] **Step 2: Apply + verify trigger fires pg_notify**

```bash
supabase db push
supabase db remote query "
  insert into app_settings (key, value, value_type, default_value)
    values ('test.key', '\"v1\"'::jsonb, 'string', '\"v0\"'::jsonb);
  update app_settings set value = '\"v2\"'::jsonb where key = 'test.key';
  select count(*) from app_settings_history where setting_id in
    (select id from app_settings where key='test.key');
  delete from app_settings where key='test.key';
"
```
Expected: count is 1 (history row creada por trigger).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260525000004_app_settings.sql
git commit -m "feat(db): wave 0 migration — app_settings system

app_settings + app_settings_history + trigger con pg_notify para hot-reload.
Base del sistema de configurabilidad universal. Spec §5.5.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Migration 005 — pgmq queues

**Files:**
- Create: `supabase/migrations/20260525000005_queues.sql`

- [ ] **Step 1: Write migration**

Create `supabase/migrations/20260525000005_queues.sql`:
```sql
-- Wave 0: pgmq queues activas
-- Spec ref: §2 pgmq queues

select pgmq.create('q_extract_structure');
select pgmq.create('q_summarize_node');
select pgmq.create('q_finalize');
```

- [ ] **Step 2: Apply + verify**

```bash
supabase db push
supabase db remote query "select queue_name from pgmq.list_queues() order by queue_name;"
```
Expected: 3 rows.

- [ ] **Step 3: Smoke test send/read**

```bash
supabase db remote query "
  select pgmq.send('q_summarize_node', '{\"test\":true}'::jsonb);
  select msg_id, message from pgmq.read('q_summarize_node', 30, 1);
"
```
Expected: ambas calls retornan rows; segundo muestra el mensaje.

Cleanup:
```bash
supabase db remote query "select pgmq.purge_queue('q_summarize_node');"
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260525000005_queues.sql
git commit -m "feat(db): wave 0 migration — pgmq queues activas

q_extract_structure, q_summarize_node, q_finalize. Spec §2.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Migration 006 — Triggers core

**Files:**
- Create: `supabase/migrations/20260525000006_triggers.sql`

- [ ] **Step 1: Write migration**

Create `supabase/migrations/20260525000006_triggers.sql` (atención: la versión del spec corregida en self-review):
```sql
-- Wave 0: triggers del pipeline (storage upload, document insert,
-- tree_node insert, tree_node ready). Spec §2 Triggers core (con fix de self-review).

-- 1. Storage upload → INSERT documents (con hash provisorio)
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
  doc_sha_provisional := 'provisional:' || encode(digest(new.name, 'sha256'), 'hex');
  insert into documents (sha256, source_path, source_type, trace_id)
    values (doc_sha_provisional, new.name, doc_type, gen_random_uuid()::text)
    on conflict (sha256) do nothing;
  return new;
end $$;
create trigger trg_storage_doc_uploaded after insert on storage.objects
  for each row execute function on_storage_doc_uploaded();

-- 2. Document insertado → enqueue extract_structure + audit en indexing_jobs
create function on_document_inserted() returns trigger language plpgsql security definer as $$
declare
  v_msg_id bigint;
begin
  v_msg_id := pgmq.send('q_extract_structure',
    jsonb_build_object(
      'document_id', new.id,
      'idempotency_key', 'extract:' || new.sha256,
      'trace_id', new.trace_id
    ));
  insert into indexing_jobs (msg_id, queue_name, document_id, job_type, payload, idempotency_key)
    values (v_msg_id, 'q_extract_structure',
            new.id, 'extract_structure',
            jsonb_build_object('document_id', new.id),
            'extract:' || new.sha256)
    on conflict (idempotency_key) do nothing;
  return new;
end $$;
create trigger trg_document_inserted after insert on documents
  for each row execute function on_document_inserted();

-- 3. Tree node creado → enqueue summarize
create function on_tree_node_inserted() returns trigger language plpgsql security definer as $$
begin
  perform pgmq.send('q_summarize_node',
    jsonb_build_object(
      'node_id', new.id,
      'document_id', new.document_id,
      'idempotency_key', 'sum:' || new.document_id || ':' || new.node_id_str
    ));
  return new;
end $$;
create trigger trg_tree_node_inserted after insert on tree_nodes
  for each row execute function on_tree_node_inserted();

-- 4. Tree node ready → check si todos listos → enqueue finalize (advisory lock)
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

- [ ] **Step 2: Apply + verify triggers exist**

```bash
supabase db push
supabase db remote query "select trigger_name from information_schema.triggers where trigger_name like 'trg_%' order by trigger_name;"
```
Expected: 4 triggers (trg_document_inserted, trg_storage_doc_uploaded, trg_tree_node_inserted, trg_tree_node_ready).

- [ ] **Step 3: Test trigger 2 (document inserted enqueues)**

```bash
supabase db remote query "
  insert into documents (sha256, source_path, source_type)
    values ('test-trigger-2', 'test.md', 'markdown');
  select count(*) from indexing_jobs
    where idempotency_key = 'extract:test-trigger-2';
  -- cleanup
  delete from documents where sha256 = 'test-trigger-2';
  select pgmq.purge_queue('q_extract_structure');
"
```
Expected: count = 1.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260525000006_triggers.sql
git commit -m "feat(db): wave 0 migration — triggers core del pipeline

storage upload, document insert, tree_node insert/ready. Advisory lock
en on_tree_node_ready evita race condition en enqueue de finalize.
Spec §2 con fix de self-review (provisional sha256).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Migration 007 — pg_cron jobs + dispatch helper

**Files:**
- Create: `supabase/migrations/20260525000007_cron.sql`

- [ ] **Step 1: Write migration**

Create `supabase/migrations/20260525000007_cron.sql`:
```sql
-- Wave 0: pg_cron jobs + dispatcher helper para drenar pgmq → srv-ia-01
-- Spec ref: §2 pg_cron jobs (con dispatch_pgmq_to_srv_ia agregado en self-review)

-- Setting de la URL de srv-ia-01 (configurable, no hardcoded)
-- En production se override con: alter system set app.srv_ia_01_url='https://srv-ia-01.internal';
alter database postgres set app.srv_ia_01_url = 'http://host.docker.internal:8000';

-- Helper para incrementar rate limit counter
create function increment_rate_limit(p_provider text) returns void language plpgsql as $$
begin
  update rate_limits
     set in_flight = in_flight + 1,
         updated_at = now()
   where provider = p_provider;
end $$;

create function decrement_rate_limit(p_provider text) returns void language plpgsql as $$
begin
  update rate_limits
     set in_flight = greatest(0, in_flight - 1),
         updated_at = now()
   where provider = p_provider;
end $$;

-- Dispatcher: drena queue y dispara HTTP a srv-ia-01
create function dispatch_pgmq_to_srv_ia(
  p_queue_name text,
  p_endpoint_path text,
  p_max_messages int
) returns int language plpgsql security definer as $$
declare
  msg record;
  count_dispatched int := 0;
  srv_url text := current_setting('app.srv_ia_01_url');
  bearer text;
begin
  if p_max_messages <= 0 then return 0; end if;
  select decrypted_secret into bearer from vault.decrypted_secrets where name = 'srv_ia_01_secret';
  if bearer is null then
    raise notice 'srv_ia_01_secret not found in Vault, skipping dispatch';
    return 0;
  end if;
  for msg in
    select * from pgmq.read(p_queue_name, 600, p_max_messages)
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

-- Tick cada 10s — drena las 3 queues activas respetando backpressure
select cron.schedule('drain-queues-10s', '*/10 * * * * *', $$
  with capacity as (
    select greatest(0, max_concurrent - in_flight) as slots
      from rate_limits where provider='deepseek'
  )
  select
    dispatch_pgmq_to_srv_ia('q_extract_structure', '/index/structure', least((select slots from capacity), 5)),
    dispatch_pgmq_to_srv_ia('q_summarize_node',    '/index/summarize', least((select slots from capacity), 20)),
    dispatch_pgmq_to_srv_ia('q_finalize',          '/index/finalize',  least((select slots from capacity), 5));
$$);

-- GC de LangGraph checkpoints viejos (default 7 días, configurable después)
select cron.schedule('gc-langgraph-checkpoints', '0 3 * * *', $$
  delete from langgraph_checkpoints.checkpoints
   where ts < now() - interval '7 days';
$$);
```

- [ ] **Step 2: Apply + verify cron jobs**

```bash
supabase db push
supabase db remote query "select jobname from cron.job order by jobname;"
```
Expected: 2 rows (drain-queues-10s, gc-langgraph-checkpoints).

- [ ] **Step 3: Test dispatcher (sin Vault todavía, debe skipear gracefully)**

```bash
supabase db remote query "select dispatch_pgmq_to_srv_ia('q_summarize_node', '/index/summarize', 1);"
```
Expected: returns 0 (sin Vault secret), notice "srv_ia_01_secret not found in Vault, skipping dispatch".

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260525000007_cron.sql
git commit -m "feat(db): wave 0 migration — pg_cron jobs + dispatch helper

dispatch_pgmq_to_srv_ia drena pgmq y llama srv-ia-01 vía pg_net con
backpressure. drain-queues-10s tickea cada 10s. GC de LangGraph
checkpoints daily a las 3am. Spec §2.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Migration 008 — Storage bucket

**Files:**
- Create: `supabase/migrations/20260525000008_storage_bucket.sql`

- [ ] **Step 1: Write migration**

Create `supabase/migrations/20260525000008_storage_bucket.sql`:
```sql
-- Wave 0: bucket 'docs' private + RLS abierta (sin multi-tenancy en Wave 0)
-- Spec ref: §4 Wave 0 deliverables

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'docs',
  'docs',
  false,
  524288000,  -- 500MB max
  array['application/pdf', 'text/markdown', 'text/plain']
)
on conflict (id) do nothing;

-- En Wave 0 sin auth: permitir todo a service_role (admin uploads).
-- RLS proper se agrega con spec multi-tenancy.
create policy "service_role full access to docs bucket"
  on storage.objects for all
  to service_role
  using (bucket_id = 'docs')
  with check (bucket_id = 'docs');
```

- [ ] **Step 2: Apply + verify**

```bash
supabase db push
supabase db remote query "select id, name, public from storage.buckets where id='docs';"
```
Expected: 1 row, public=false.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260525000008_storage_bucket.sql
git commit -m "feat(db): wave 0 migration — storage bucket 'docs'

Bucket private para PDFs/markdown, 500MB límite. RLS abierta a
service_role en Wave 0 (multi-tenancy en spec aparte). Spec §4.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase B — Docker + config (Tasks 10-11)

### Task 10: Dockerfile + docker-compose

**Files:**
- Create: `services/sda-indexer/Dockerfile`
- Create: `services/sda-indexer/docker-compose.yml`
- Create: `services/sda-indexer/.dockerignore`

- [ ] **Step 1: Write Dockerfile**

Create `services/sda-indexer/Dockerfile`:
```dockerfile
FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.5.0 /uv /uvx /bin/

WORKDIR /app

# Cachear dependencies
COPY pyproject.toml uv.lock* ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project --no-dev

# Copy source
COPY src ./src
COPY README.md ./

# Final install (instala el paquete local)
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

EXPOSE 8000

CMD ["uv", "run", "uvicorn", "sda_indexer.main:app", \
     "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
```

- [ ] **Step 2: Write docker-compose.yml**

Create `services/sda-indexer/docker-compose.yml`:
```yaml
services:
  sda-indexer:
    build:
      context: .
      dockerfile: Dockerfile
    image: sda-indexer:dev
    container_name: sda-indexer
    ports:
      - "8000:8000"
    environment:
      - SDA_ENV=local
      - SDA_SUPABASE_URL=${SDA_SUPABASE_URL}
      - SDA_SUPABASE_SERVICE_KEY=${SDA_SUPABASE_SERVICE_KEY}
      - SDA_DEEPSEEK_API_KEY=${SDA_DEEPSEEK_API_KEY}
      - SDA_SRV_IA_01_SECRET=${SDA_SRV_IA_01_SECRET}
      - SDA_DB_DSN=${SDA_DB_DSN}
      - SDA_LOG_LEVEL=INFO
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:8000/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
```

- [ ] **Step 3: Write .dockerignore**

Create `services/sda-indexer/.dockerignore`:
```
.venv/
__pycache__/
*.pyc
.pytest_cache/
.coverage
htmlcov/
tests/
*.md
.env
.env.local
.git/
.github/
```

- [ ] **Step 4: Smoke test build**

```bash
cd services/sda-indexer
docker build -t sda-indexer:test .
```
Expected: build succeeds, no errors.

- [ ] **Step 5: Commit**

```bash
git add services/sda-indexer/{Dockerfile,docker-compose.yml,.dockerignore}
git commit -m "feat(indexer): Dockerfile + docker-compose

Build con uv 0.5, slim base. Healthcheck en /health. Env vars
con prefix SDA_ para namespacing claro.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: config.py (pydantic-settings)

**Files:**
- Create: `services/sda-indexer/src/sda_indexer/config.py`
- Create: `services/sda-indexer/.env.example`
- Test: `services/sda-indexer/tests/unit/test_config.py`

- [ ] **Step 1: Write failing test**

Create `services/sda-indexer/tests/unit/test_config.py`:
```python
import os
import pytest
from sda_indexer.config import Settings


def test_settings_reads_env(monkeypatch):
    monkeypatch.setenv("SDA_SUPABASE_URL", "https://test.supabase.co")
    monkeypatch.setenv("SDA_SUPABASE_SERVICE_KEY", "test-key")
    monkeypatch.setenv("SDA_DEEPSEEK_API_KEY", "ds-test")
    monkeypatch.setenv("SDA_SRV_IA_01_SECRET", "bearer-test")
    monkeypatch.setenv("SDA_DB_DSN", "postgresql://test/db")
    s = Settings()
    assert s.supabase_url == "https://test.supabase.co"
    assert s.deepseek_api_key.get_secret_value() == "ds-test"
    assert s.env == "local"  # default


def test_settings_missing_required_fails():
    # Sin envs, debe fallar al construir
    for k in ["SDA_SUPABASE_URL","SDA_SUPABASE_SERVICE_KEY",
              "SDA_DEEPSEEK_API_KEY","SDA_SRV_IA_01_SECRET","SDA_DB_DSN"]:
        os.environ.pop(k, None)
    with pytest.raises(Exception):
        Settings()
```

- [ ] **Step 2: Run test, expect fail**

```bash
cd services/sda-indexer
uv run pytest tests/unit/test_config.py -v
```
Expected: ImportError or ModuleNotFoundError on `sda_indexer.config`.

- [ ] **Step 3: Write config.py**

Create `services/sda-indexer/src/sda_indexer/config.py`:
```python
"""Pydantic-settings — lee env vars con prefijo SDA_. No es el sistema
de runtime config (que vive en DB) — esto es bootstrap-only:
URLs, keys, credenciales que el servicio necesita para arrancar."""

from typing import Literal
from pydantic import SecretStr, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="SDA_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Environment ---
    env: Literal["local", "staging", "production"] = "local"
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"

    # --- Supabase ---
    supabase_url: str = Field(..., description="https://<project>.supabase.co")
    supabase_service_key: SecretStr = Field(..., description="service_role key (server-side)")
    db_dsn: SecretStr = Field(..., description="postgresql://... con service_role credentials")

    # --- DeepSeek ---
    deepseek_api_key: SecretStr = Field(..., description="API key DeepSeek")
    deepseek_base_url: str = "https://api.deepseek.com/v1"

    # --- Bearer entre Supabase pg_net y srv-ia-01 ---
    srv_ia_01_secret: SecretStr = Field(..., description="Bearer token compartido")

    # --- Pool DB ---
    db_pool_min_size: int = 2
    db_pool_max_size: int = 20

    # --- Server ---
    host: str = "0.0.0.0"
    port: int = 8000
```

- [ ] **Step 4: Write .env.example**

Create `services/sda-indexer/.env.example`:
```
SDA_ENV=local
SDA_LOG_LEVEL=DEBUG

SDA_SUPABASE_URL=https://anfawvxfepowsudlffnl.supabase.co
SDA_SUPABASE_SERVICE_KEY=eyJ...
SDA_DB_DSN=postgresql://postgres:PASS@db.anfawvxfepowsudlffnl.supabase.co:5432/postgres

SDA_DEEPSEEK_API_KEY=sk-...
SDA_DEEPSEEK_BASE_URL=https://api.deepseek.com/v1

SDA_SRV_IA_01_SECRET=generate-with-openssl-rand-hex-32
```

- [ ] **Step 5: Run tests, expect pass**

```bash
uv run pytest tests/unit/test_config.py -v
```
Expected: 2 passed.

- [ ] **Step 6: Commit**

```bash
git add src/sda_indexer/config.py .env.example tests/unit/test_config.py
git commit -m "feat(indexer): config.py — pydantic-settings desde env

Lee SDA_* vars con SecretStr para keys. Distinto del sistema de
runtime config (que vive en DB); esto es bootstrap-only.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase C — Settings runtime system (Tasks 12-17)

### Task 12: settings/types.py — SettingDef dataclass

**Files:**
- Create: `services/sda-indexer/src/sda_indexer/settings/types.py`
- Test: `services/sda-indexer/tests/unit/test_settings_types.py`

- [ ] **Step 1: Write failing test**

Create `services/sda-indexer/tests/unit/test_settings_types.py`:
```python
import pytest
from sda_indexer.settings.types import SettingDef


def test_setting_def_frozen():
    s = SettingDef(
        key="llm.model.summarize",
        value_type="model_id",
        default="deepseek/deepseek-v4-flash",
        description="test",
        scopes=["global"],
    )
    assert s.key == "llm.model.summarize"
    assert s.default == "deepseek/deepseek-v4-flash"
    with pytest.raises(Exception):
        s.key = "other"  # frozen


def test_setting_def_with_validation():
    s = SettingDef(
        key="pgmq.visibility_timeout",
        value_type="duration_ms",
        default=60000,
        description="",
        scopes=["global"],
        validation={"type": "integer", "minimum": 1000},
    )
    assert s.validation == {"type": "integer", "minimum": 1000}


def test_setting_def_secret():
    s = SettingDef(
        key="alerts.slack_webhook_url",
        value_type="string",
        default="",
        description="",
        scopes=["global"],
        is_secret=True,
    )
    assert s.is_secret is True
```

- [ ] **Step 2: Run, expect ImportError**

```bash
uv run pytest tests/unit/test_settings_types.py -v
```

- [ ] **Step 3: Write types.py**

Create `services/sda-indexer/src/sda_indexer/settings/types.py`:
```python
"""Tipos del sistema de configurabilidad universal. Spec §5.5."""

from dataclasses import dataclass
from typing import Literal, Any

ValueType = Literal[
    "string", "number", "boolean", "object", "array",
    "duration_ms", "prompt_template", "model_id", "json_schema", "enum",
]
Scope = Literal["global", "doc_type", "collection", "document"]


@dataclass(frozen=True)
class SettingDef:
    """Definición de una setting en el registry de código.

    El value que termina en DB puede sobreescribirse en runtime; el `default`
    de acá es la fuente de verdad para qué valor "viene de fábrica".
    """
    key: str
    value_type: ValueType
    default: Any
    description: str
    scopes: list[Scope]
    validation: dict | None = None     # JSON Schema
    is_secret: bool = False
```

- [ ] **Step 4: Run tests, expect pass**

```bash
uv run pytest tests/unit/test_settings_types.py -v
```
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/sda_indexer/settings/types.py tests/unit/test_settings_types.py
git commit -m "feat(indexer): settings/types — SettingDef dataclass frozen

Tipo base del registry. ValueType y Scope literales para type safety.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: settings/registry.py — registry inicial Wave 0

**Files:**
- Create: `services/sda-indexer/src/sda_indexer/settings/registry.py`
- Test: `services/sda-indexer/tests/unit/test_settings_registry.py`

- [ ] **Step 1: Write failing test**

Create `services/sda-indexer/tests/unit/test_settings_registry.py`:
```python
from sda_indexer.settings.registry import SETTINGS


def test_registry_has_wave0_keys():
    keys = {s.key for s in SETTINGS}
    # Sample of must-have Wave 0 keys
    assert "llm.model.summarize" in keys
    assert "llm.max_concurrent.deepseek" in keys
    assert "pgmq.visibility_timeout.q_summarize_node" in keys
    assert "summarize.max_summary_chars" in keys


def test_registry_keys_unique():
    keys = [s.key for s in SETTINGS]
    assert len(keys) == len(set(keys)), "duplicated keys in registry"


def test_registry_all_have_global_scope():
    # Wave 0 invariant: cada setting debe tener al menos 'global'
    for s in SETTINGS:
        assert "global" in s.scopes, f"{s.key} missing 'global' scope"


def test_registry_secrets_marked():
    secret_keys = {s.key for s in SETTINGS if s.is_secret}
    # En Wave 0 no hay secrets en registry (Vault es para arranque, no app_settings)
    assert secret_keys == set() or "alerts.slack_webhook_url" in secret_keys
```

- [ ] **Step 2: Run, expect ImportError**

- [ ] **Step 3: Write registry.py**

Create `services/sda-indexer/src/sda_indexer/settings/registry.py`:
```python
"""Registry de settings runtime — Wave 0.

Wave 0 incluye ~30 settings de las ~80-100 totales que tendremos al final
de Wave 3. Cada Wave agrega settings nuevas; las viejas no se quitan,
sólo se marcan deprecated_at en DB cuando se eliminan del código.
"""

from .types import SettingDef


SETTINGS: list[SettingDef] = [
    # --- LLM model selection (Mejora #6, escala completa en Wave 1) ---
    SettingDef("llm.model.summarize", "model_id", "deepseek/deepseek-chat",
               "Modelo LLM para summary de nodos. Wave 0 usa deepseek-chat; "
               "Wave 1 cambia a deepseek-v4-flash con tiered routing.",
               scopes=["global", "doc_type", "collection", "document"]),

    # --- Rate limits ---
    SettingDef("llm.max_concurrent.deepseek", "number", 50,
               "Calls concurrentes máximas a DeepSeek antes de backpressure.",
               scopes=["global"]),

    # --- Retries y timeouts ---
    SettingDef("llm.timeout_ms.summarize", "duration_ms", 30000,
               "Timeout para llamadas LLM de summary individual.",
               scopes=["global"]),
    SettingDef("llm.timeout_ms.structure", "duration_ms", 120000,
               "Timeout para llamadas LLM de extracción de estructura.",
               scopes=["global"]),
    SettingDef("llm.retry.max_attempts", "number", 3,
               "Reintentos de tenacity antes de fallar.",
               scopes=["global"]),
    SettingDef("llm.retry.backoff_base_ms", "number", 1000,
               "Backoff base exponencial para tenacity.",
               scopes=["global"]),
    SettingDef("llm.retry.backoff_max_ms", "number", 8000,
               "Backoff máximo para tenacity.",
               scopes=["global"]),

    # --- pgmq ---
    SettingDef("pgmq.visibility_timeout.q_extract_structure", "duration_ms", 600000,
               "Visibility timeout para extract_structure (10 min).",
               scopes=["global"]),
    SettingDef("pgmq.visibility_timeout.q_summarize_node", "duration_ms", 120000,
               "Visibility timeout para summarize_node (2 min).",
               scopes=["global"]),
    SettingDef("pgmq.visibility_timeout.q_finalize", "duration_ms", 60000,
               "Visibility timeout para finalize (1 min).",
               scopes=["global"]),
    SettingDef("pgmq.max_retries_before_dlq.q_summarize_node", "number", 5,
               "Reintentos antes de DLQ (Wave 2). Wave 0 sólo registra el valor.",
               scopes=["global"]),

    # --- Summarize behavior ---
    SettingDef("summarize.max_summary_chars", "number", 280,
               "Largo máximo del summary por nodo.",
               scopes=["global", "doc_type"]),
    SettingDef("summarize.language", "enum", "es",
               "Idioma del summary generado. Wave 1 expande con i18n.",
               scopes=["global", "doc_type", "collection", "document"],
               validation={"enum": ["es", "en", "auto"]}),

    # --- LangGraph ---
    SettingDef("langgraph.checkpoint_ttl_days", "number", 7,
               "Retención de checkpoints antes de GC.",
               scopes=["global"]),

    # --- Feature flags (Wave 0 todas en false) ---
    SettingDef("feature.embeddings_enabled", "boolean", False,
               "Activar pipeline de embeddings (Wave 3).",
               scopes=["global", "collection"]),
    SettingDef("feature.entity_extraction_enabled", "boolean", False,
               "Activar extracción de entidades (Wave 3).",
               scopes=["global", "collection"]),
    SettingDef("feature.question_prediction_enabled", "boolean", False,
               "Activar question-prediction (Wave 3).",
               scopes=["global", "collection"]),
    SettingDef("feature.typed_extraction_enabled", "boolean", False,
               "Activar typed extraction (Wave 3).",
               scopes=["global", "collection", "doc_type"]),
    SettingDef("feature.multimodal_enabled", "boolean", False,
               "Activar multi-modal (Wave 3).",
               scopes=["global", "collection"]),
    SettingDef("feature.incremental_reindex_enabled", "boolean", False,
               "Activar incremental re-indexing (Wave 3).",
               scopes=["global", "collection"]),

    # --- Prompts (los .j2 cargados en boot — bootstrapping en Task 26) ---
    SettingDef("prompt.template.summarize", "prompt_template",
               "<bootstrapped-from-prompts/summarize.j2>",
               "Template Jinja2 para summarize_node. Se popula al boot.",
               scopes=["global", "doc_type", "collection"]),
]


REGISTRY_BY_KEY: dict[str, SettingDef] = {s.key: s for s in SETTINGS}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
uv run pytest tests/unit/test_settings_registry.py -v
```

- [ ] **Step 5: Commit**

```bash
git add src/sda_indexer/settings/registry.py tests/unit/test_settings_registry.py
git commit -m "feat(indexer): settings/registry — ~20 settings Wave 0

LLM, rate limits, pgmq timeouts, summarize behavior, feature flags
(all off), prompt template placeholder. REGISTRY_BY_KEY como índice
rápido por key.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: settings/client.py — SettingsClient con cache + hot-reload

**Files:**
- Create: `services/sda-indexer/src/sda_indexer/settings/client.py`
- Test: `services/sda-indexer/tests/unit/test_settings_client.py`

- [ ] **Step 1: Write failing test (con asyncpg mock)**

Create `services/sda-indexer/tests/unit/test_settings_client.py`:
```python
import asyncio
import json
import pytest
from unittest.mock import AsyncMock, MagicMock
from sda_indexer.settings.client import SettingsClient, CASCADE_SQL
from sda_indexer.settings.types import SettingDef


@pytest.fixture
def registry():
    return [
        SettingDef("test.k", "string", "default-val", "", ["global"]),
    ]


@pytest.fixture
def mock_pool():
    p = MagicMock()
    p.acquire = MagicMock()
    p.fetchrow = AsyncMock(return_value=None)
    return p


@pytest.mark.asyncio
async def test_resolve_falls_back_to_default(mock_pool, registry):
    client = SettingsClient(mock_pool, registry, start_listener=False)
    val = await client.resolve("test.k")
    assert val == "default-val"


@pytest.mark.asyncio
async def test_resolve_returns_db_value(mock_pool, registry):
    mock_pool.fetchrow = AsyncMock(return_value={"value": "db-val"})
    client = SettingsClient(mock_pool, registry, start_listener=False)
    val = await client.resolve("test.k")
    assert val == "db-val"


@pytest.mark.asyncio
async def test_resolve_cached(mock_pool, registry):
    mock_pool.fetchrow = AsyncMock(return_value={"value": "db-val"})
    client = SettingsClient(mock_pool, registry, start_listener=False)
    await client.resolve("test.k")
    await client.resolve("test.k")
    assert mock_pool.fetchrow.call_count == 1  # cached on 2nd


@pytest.mark.asyncio
async def test_on_change_invalidates_cache(mock_pool, registry):
    mock_pool.fetchrow = AsyncMock(return_value={"value": "v1"})
    client = SettingsClient(mock_pool, registry, start_listener=False)
    await client.resolve("test.k")  # cache populated
    payload = json.dumps({"key": "test.k", "scope_type": "global", "scope_value": None})
    client._on_change(None, 0, "settings_changed", payload)
    mock_pool.fetchrow = AsyncMock(return_value={"value": "v2"})
    val = await client.resolve("test.k")
    assert val == "v2"


def test_cascade_sql_includes_priority():
    assert "priority" in CASCADE_SQL
    assert "document" in CASCADE_SQL
```

- [ ] **Step 2: Run, expect ImportError**

- [ ] **Step 3: Write client.py**

Create `services/sda-indexer/src/sda_indexer/settings/client.py`:
```python
"""SettingsClient — resolve con scope cascade, cache + hot-reload via pg_notify.
Spec §5.5.4."""

import asyncio
import json
import structlog
from typing import Any
from .types import SettingDef

log = structlog.get_logger()


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
    """Cliente para resolver settings con scope cascade.

    - Cache in-memory por (key, doc_type, collection_id, document_id)
    - Listener pg_notify invalida cache cuando una setting cambia en DB
    - Si no hay valor en DB, devuelve el default del registry
    """

    def __init__(self, db_pool, registry: list[SettingDef], *, start_listener: bool = True):
        self._pool = db_pool
        self._registry = {s.key: s for s in registry}
        self._cache: dict[tuple, Any] = {}
        self._listener_task: asyncio.Task | None = None
        if start_listener:
            self._listener_task = asyncio.create_task(self._listen_for_changes())

    async def resolve(
        self,
        key: str,
        *,
        doc_type: str | None = None,
        collection_id: str | None = None,
        document_id: str | None = None,
    ) -> Any:
        ctx = (key, doc_type, collection_id, document_id)
        if ctx in self._cache:
            return self._cache[ctx]
        row = await self._pool.fetchrow(
            CASCADE_SQL, key, doc_type, collection_id, document_id
        )
        if row is not None:
            value = row["value"]
        elif key in self._registry:
            value = self._registry[key].default
        else:
            raise KeyError(f"Unknown setting key: {key}")
        self._cache[ctx] = value
        return value

    async def _listen_for_changes(self) -> None:
        try:
            async with self._pool.acquire() as conn:
                await conn.add_listener("settings_changed", self._on_change)
                log.info("settings.listener.started")
                await asyncio.Event().wait()
        except Exception as e:
            log.error("settings.listener.error", error=str(e))

    def _on_change(self, conn, pid, channel: str, payload: str) -> None:
        try:
            evt = json.loads(payload)
            key = evt.get("key")
            invalidated = sum(1 for k in self._cache if k[0] == key)
            self._cache = {k: v for k, v in self._cache.items() if k[0] != key}
            log.info("settings.invalidated", key=key, count=invalidated)
        except Exception as e:
            log.error("settings.on_change.error", error=str(e), payload=payload)

    async def close(self) -> None:
        if self._listener_task:
            self._listener_task.cancel()
            try:
                await self._listener_task
            except asyncio.CancelledError:
                pass
```

- [ ] **Step 4: Run tests**

```bash
uv run pytest tests/unit/test_settings_client.py -v
```
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/sda_indexer/settings/client.py tests/unit/test_settings_client.py
git commit -m "feat(indexer): settings/client — resolve con scope cascade + hot-reload

SettingsClient con cache in-memory, pg_notify listener invalida.
CASCADE_SQL como CTE para resolución en una sola query.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: settings/sync.py — boot-time sync registry → DB

**Files:**
- Create: `services/sda-indexer/src/sda_indexer/settings/sync.py`
- Test: `services/sda-indexer/tests/integration/test_settings_sync.py`

- [ ] **Step 1: Write integration test (requiere Supabase local)**

Create `services/sda-indexer/tests/integration/test_settings_sync.py`:
```python
"""Test integration — requiere Supabase local corriendo + migraciones aplicadas.

Usage:
  supabase start  # en otra terminal
  uv run pytest tests/integration/test_settings_sync.py -v
"""
import os
import pytest
import asyncpg
from sda_indexer.settings.sync import sync_registry_to_db
from sda_indexer.settings.types import SettingDef


pytestmark = pytest.mark.asyncio


@pytest.fixture
async def pool():
    dsn = os.getenv("SDA_DB_DSN", "postgresql://postgres:postgres@localhost:54322/postgres")
    p = await asyncpg.create_pool(dsn, min_size=1, max_size=2)
    yield p
    await p.close()


@pytest.fixture
async def clean_settings(pool):
    async with pool.acquire() as conn:
        await conn.execute("delete from app_settings where key like 'sync-test.%';")
    yield
    async with pool.acquire() as conn:
        await conn.execute("delete from app_settings where key like 'sync-test.%';")


async def test_sync_inserts_missing(pool, clean_settings):
    reg = [SettingDef("sync-test.k1", "string", "v1", "test", ["global"])]
    await sync_registry_to_db(pool, reg)
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "select value, default_value from app_settings where key='sync-test.k1';"
        )
    assert row["value"] == "v1"
    assert row["default_value"] == "v1"


async def test_sync_marks_removed_as_deprecated(pool, clean_settings):
    reg_v1 = [
        SettingDef("sync-test.keep", "string", "k", "test", ["global"]),
        SettingDef("sync-test.remove", "string", "r", "test", ["global"]),
    ]
    await sync_registry_to_db(pool, reg_v1)
    reg_v2 = [SettingDef("sync-test.keep", "string", "k", "test", ["global"])]
    await sync_registry_to_db(pool, reg_v2)
    async with pool.acquire() as conn:
        removed = await conn.fetchrow(
            "select deprecated_at from app_settings where key='sync-test.remove';"
        )
        kept = await conn.fetchrow(
            "select deprecated_at from app_settings where key='sync-test.keep';"
        )
    assert removed["deprecated_at"] is not None
    assert kept["deprecated_at"] is None
```

- [ ] **Step 2: Run, expect ImportError**

```bash
uv run pytest tests/integration/test_settings_sync.py -v
```

- [ ] **Step 3: Write sync.py**

Create `services/sda-indexer/src/sda_indexer/settings/sync.py`:
```python
"""Boot-time sync del registry de código → tabla app_settings.

- Settings nuevas se insertan con default + deprecated_at=null.
- Settings que existen mantienen su `value` actual (no se piso), pero
  actualizan description/default_value/validation_schema desde el registry.
- Settings que ya no están en el registry se marcan deprecated_at=now()
  pero NO se borran (audit trail).
"""

import json
import structlog
from .types import SettingDef

log = structlog.get_logger()

UPSERT_SQL = """
insert into app_settings (
    key, scope_type, scope_value, value, value_type,
    description, default_value, validation_schema, is_secret, deprecated_at
) values ($1, 'global', null, $2::jsonb, $3, $4, $2::jsonb, $5::jsonb, $6, null)
on conflict (key, scope_type, scope_value)
do update set
    deprecated_at = null,
    description = excluded.description,
    default_value = excluded.default_value,
    validation_schema = excluded.validation_schema
"""

DEPRECATE_SQL = """
update app_settings
   set deprecated_at = now()
 where key != all($1::text[])
   and deprecated_at is null
"""


async def sync_registry_to_db(pool, registry: list[SettingDef]) -> dict:
    """Sincroniza registry → app_settings. Idempotente. Devuelve contadores."""
    inserted_or_updated = 0
    async with pool.acquire() as conn:
        async with conn.transaction():
            for s in registry:
                await conn.execute(
                    UPSERT_SQL,
                    s.key,
                    json.dumps(s.default),
                    s.value_type,
                    s.description,
                    json.dumps(s.validation) if s.validation else None,
                    s.is_secret,
                )
                inserted_or_updated += 1
            result = await conn.execute(
                DEPRECATE_SQL, [s.key for s in registry]
            )
            # result es "UPDATE N"
            deprecated_count = int(result.split()[-1]) if result.startswith("UPDATE") else 0

    log.info("settings.sync.complete",
             upserted=inserted_or_updated, deprecated=deprecated_count)
    return {"upserted": inserted_or_updated, "deprecated": deprecated_count}
```

- [ ] **Step 4: Apply migrations to Supabase local, run integration test**

```bash
# en otra terminal:
cd /Users/enzo/sda.framework/sda.framework
supabase start
supabase db push

# en services/sda-indexer:
SDA_DB_DSN="postgresql://postgres:postgres@localhost:54322/postgres" \
  uv run pytest tests/integration/test_settings_sync.py -v
```
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/sda_indexer/settings/sync.py tests/integration/test_settings_sync.py
git commit -m "feat(indexer): settings/sync — registry → app_settings al boot

Upsert idempotente con preservación del value runtime. Marca como
deprecated_at las settings removidas del código sin borrarlas.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase D — DB layer (Tasks 16-18)

### Task 16: db/client.py — asyncpg pool + supabase-py wrapper

**Files:**
- Create: `services/sda-indexer/src/sda_indexer/db/client.py`
- Test: `services/sda-indexer/tests/integration/test_db_client.py`

- [ ] **Step 1: Write failing integration test**

Create `services/sda-indexer/tests/integration/test_db_client.py`:
```python
import os
import pytest
from sda_indexer.db.client import DB


pytestmark = pytest.mark.asyncio


@pytest.fixture
async def db():
    dsn = os.getenv("SDA_DB_DSN", "postgresql://postgres:postgres@localhost:54322/postgres")
    d = DB(dsn=dsn, min_size=1, max_size=2)
    await d.start()
    yield d
    await d.close()


async def test_pool_executes(db):
    async with db.pool.acquire() as conn:
        row = await conn.fetchrow("select 1 as n")
    assert row["n"] == 1


async def test_health_check(db):
    ok = await db.health()
    assert ok is True
```

- [ ] **Step 2: Run, expect ImportError**

- [ ] **Step 3: Write client.py**

Create `services/sda-indexer/src/sda_indexer/db/client.py`:
```python
"""DB client — asyncpg pool. Métodos thin para queries del producto."""

import asyncpg
import structlog

log = structlog.get_logger()


class DB:
    def __init__(self, dsn: str, *, min_size: int = 2, max_size: int = 20):
        self._dsn = dsn
        self._min_size = min_size
        self._max_size = max_size
        self.pool: asyncpg.Pool | None = None

    async def start(self) -> None:
        self.pool = await asyncpg.create_pool(
            self._dsn,
            min_size=self._min_size,
            max_size=self._max_size,
            command_timeout=60,
        )
        log.info("db.pool.started", min=self._min_size, max=self._max_size)

    async def close(self) -> None:
        if self.pool:
            await self.pool.close()
            log.info("db.pool.closed")

    async def health(self) -> bool:
        try:
            async with self.pool.acquire() as conn:
                await conn.fetchval("select 1")
            return True
        except Exception as e:
            log.error("db.health.fail", error=str(e))
            return False
```

- [ ] **Step 4: Run, expect pass**

```bash
SDA_DB_DSN="postgresql://postgres:postgres@localhost:54322/postgres" \
  uv run pytest tests/integration/test_db_client.py -v
```

- [ ] **Step 5: Commit**

```bash
git add src/sda_indexer/db/client.py tests/integration/test_db_client.py
git commit -m "feat(indexer): db/client — asyncpg pool + health

Wrapper thin sobre asyncpg.create_pool con start/close/health.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 17: db/documents.py — CRUD documents

**Files:**
- Create: `services/sda-indexer/src/sda_indexer/db/documents.py`
- Test: `services/sda-indexer/tests/integration/test_db_documents.py`

- [ ] **Step 1: Write failing test**

Create `services/sda-indexer/tests/integration/test_db_documents.py`:
```python
import os
import hashlib
import pytest
from sda_indexer.db.client import DB
from sda_indexer.db.documents import (
    get_document, update_sha256_post_load, mark_failed, mark_ready_meta,
)

pytestmark = pytest.mark.asyncio


@pytest.fixture
async def db():
    dsn = os.getenv("SDA_DB_DSN", "postgresql://postgres:postgres@localhost:54322/postgres")
    d = DB(dsn=dsn)
    await d.start()
    yield d
    async with d.pool.acquire() as conn:
        await conn.execute("delete from documents where source_path like 'docs/test-%';")
    await d.close()


async def test_get_document_returns_row(db):
    async with db.pool.acquire() as conn:
        doc_id = await conn.fetchval(
            "insert into documents (sha256, source_path, source_type) "
            "values ($1, $2, $3) returning id",
            "test-sha-1", "docs/test-1.md", "markdown",
        )
    row = await get_document(db.pool, doc_id)
    assert row["sha256"] == "test-sha-1"


async def test_update_sha256_post_load_succeeds(db):
    real_sha = hashlib.sha256(b"hello").hexdigest()
    async with db.pool.acquire() as conn:
        doc_id = await conn.fetchval(
            "insert into documents (sha256, source_path, source_type) "
            "values ($1, $2, $3) returning id",
            "provisional:abc", "docs/test-2.md", "markdown",
        )
    result = await update_sha256_post_load(db.pool, doc_id, real_sha)
    assert result == "updated"


async def test_update_sha256_post_load_detects_duplicate(db):
    real_sha = hashlib.sha256(b"world").hexdigest()
    async with db.pool.acquire() as conn:
        await conn.execute(
            "insert into documents (sha256, source_path, source_type) "
            "values ($1, $2, $3)",
            real_sha, "docs/test-3-original.md", "markdown",
        )
        dup_id = await conn.fetchval(
            "insert into documents (sha256, source_path, source_type) "
            "values ($1, $2, $3) returning id",
            "provisional:xyz", "docs/test-3-duplicate.md", "markdown",
        )
    result = await update_sha256_post_load(db.pool, dup_id, real_sha)
    assert result == "duplicate"
    async with db.pool.acquire() as conn:
        status = await conn.fetchval("select status from documents where id=$1", dup_id)
    assert status == "duplicate"
```

- [ ] **Step 2: Run, expect ImportError**

- [ ] **Step 3: Write documents.py**

Create `services/sda-indexer/src/sda_indexer/db/documents.py`:
```python
"""CRUD del documento — wrappers sobre las queries comunes."""

import structlog
from typing import Literal

log = structlog.get_logger()


async def get_document(pool, document_id: str) -> dict | None:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "select * from documents where id = $1", document_id
        )
    return dict(row) if row else None


async def update_sha256_post_load(
    pool, document_id: str, real_sha256: str
) -> Literal["updated", "duplicate"]:
    """Reemplaza el sha256 provisorio con el real.

    Si otra fila ya tiene ese sha256 (es un duplicado de contenido), marca
    esta fila como 'duplicate' y retorna 'duplicate'. Si no, hace UPDATE
    y retorna 'updated'.
    """
    async with pool.acquire() as conn:
        try:
            await conn.execute(
                "update documents set sha256 = $1, status = 'parsing' "
                "where id = $2 and sha256 like 'provisional:%'",
                real_sha256, document_id,
            )
            return "updated"
        except Exception as e:
            if "documents_sha256_key" in str(e):
                await conn.execute(
                    "update documents set status='duplicate', "
                    "error_message='Same content as existing document' "
                    "where id = $1",
                    document_id,
                )
                log.info("documents.duplicate_detected", document_id=document_id)
                return "duplicate"
            raise


async def mark_failed(pool, document_id: str, error: str) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            "update documents set status='failed', error_message=$1 where id=$2",
            error, document_id,
        )


async def mark_ready_meta(pool, document_id: str, *, node_count: int, page_count: int | None,
                          path_used: str, doc_description: str | None,
                          total_cost_cents: float) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            """update documents set
                status='ready',
                node_count=$1,
                page_count=$2,
                path_used=$3,
                doc_description=$4,
                total_cost_cents=$5,
                finalized_at=now()
               where id=$6""",
            node_count, page_count, path_used, doc_description, total_cost_cents, document_id,
        )
```

- [ ] **Step 4: Run tests, expect pass**

```bash
uv run pytest tests/integration/test_db_documents.py -v
```

- [ ] **Step 5: Commit**

```bash
git add src/sda_indexer/db/documents.py tests/integration/test_db_documents.py
git commit -m "feat(indexer): db/documents — CRUD helpers

get_document, update_sha256_post_load (con detección de duplicate),
mark_failed, mark_ready_meta.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 18: db/tree_nodes.py — bulk insert + status updates

**Files:**
- Create: `services/sda-indexer/src/sda_indexer/db/tree_nodes.py`
- Test: `services/sda-indexer/tests/integration/test_db_tree_nodes.py`

- [ ] **Step 1: Write failing test**

Create `services/sda-indexer/tests/integration/test_db_tree_nodes.py`:
```python
import os
import pytest
from sda_indexer.db.client import DB
from sda_indexer.db.tree_nodes import bulk_insert, get_node, set_summary

pytestmark = pytest.mark.asyncio


@pytest.fixture
async def db():
    dsn = os.getenv("SDA_DB_DSN", "postgresql://postgres:postgres@localhost:54322/postgres")
    d = DB(dsn=dsn)
    await d.start()
    yield d
    async with d.pool.acquire() as conn:
        await conn.execute("delete from documents where source_path like 'docs/test-tn-%';")
    await d.close()


@pytest.fixture
async def doc_id(db):
    async with db.pool.acquire() as conn:
        return await conn.fetchval(
            "insert into documents (sha256, source_path, source_type) "
            "values ('test-tn-sha', 'docs/test-tn-1.md', 'markdown') returning id"
        )


async def test_bulk_insert_creates_nodes(db, doc_id):
    nodes = [
        {"node_id_str": "n_1", "structure_code": "1", "depth": 1,
         "title": "Cap 1", "start_index": 1, "end_index": 5, "text": "hola"},
        {"node_id_str": "n_2", "structure_code": "2", "depth": 1,
         "title": "Cap 2", "start_index": 6, "end_index": 10, "text": "mundo"},
    ]
    ids = await bulk_insert(db.pool, doc_id, nodes)
    assert len(ids) == 2


async def test_set_summary_marks_ready(db, doc_id):
    nodes = [{"node_id_str": "n_3", "structure_code": "3", "depth": 1,
              "title": "X", "start_index": 1, "end_index": 1, "text": "t"}]
    ids = await bulk_insert(db.pool, doc_id, nodes)
    await set_summary(db.pool, ids[0], summary="resumen", model="deepseek-chat")
    n = await get_node(db.pool, ids[0])
    assert n["status"] == "ready"
    assert n["summary"] == "resumen"
```

- [ ] **Step 2: Run, expect ImportError**

- [ ] **Step 3: Write tree_nodes.py**

Create `services/sda-indexer/src/sda_indexer/db/tree_nodes.py`:
```python
"""CRUD tree_nodes — bulk insert atómico + UPDATE de summary individual."""

import structlog

log = structlog.get_logger()


async def bulk_insert(pool, document_id: str, nodes: list[dict]) -> list[str]:
    """Inserta N tree_nodes en una transacción. Devuelve los UUIDs creados, en orden.

    Cada node dict debe tener: node_id_str, structure_code, depth, title,
    start_index, end_index. Opcionales: parent_id (UUID o None), text, node_type.
    """
    if not nodes:
        return []
    inserted_ids: list[str] = []
    async with pool.acquire() as conn:
        async with conn.transaction():
            for n in nodes:
                new_id = await conn.fetchval(
                    """insert into tree_nodes (
                        document_id, parent_id, node_id_str, structure_code,
                        depth, title, start_index, end_index, node_type, text
                       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                       returning id""",
                    document_id,
                    n.get("parent_id"),
                    n["node_id_str"],
                    n["structure_code"],
                    n["depth"],
                    n["title"],
                    n["start_index"],
                    n["end_index"],
                    n.get("node_type", "section"),
                    n.get("text"),
                )
                inserted_ids.append(str(new_id))
    log.info("tree_nodes.bulk_insert", count=len(inserted_ids), doc=document_id)
    return inserted_ids


async def get_node(pool, node_id: str) -> dict | None:
    async with pool.acquire() as conn:
        row = await conn.fetchrow("select * from tree_nodes where id=$1", node_id)
    return dict(row) if row else None


async def set_summary(pool, node_id: str, *, summary: str, model: str,
                      text_contextualized: str | None = None) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            """update tree_nodes set
                summary = $1,
                summary_model = $2,
                text_contextualized = coalesce($3, text_contextualized),
                status = 'ready',
                summarized_at = now()
              where id = $4""",
            summary, model, text_contextualized, node_id,
        )


async def mark_summarizing(pool, node_id: str) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            "update tree_nodes set status='summarizing', retry_count=retry_count+1 where id=$1",
            node_id,
        )


async def mark_failed(pool, node_id: str, error: str) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            "update tree_nodes set status='failed' where id=$1",
            node_id,
        )
        log.warning("tree_nodes.failed", node_id=node_id, error=error)
```

- [ ] **Step 4: Run tests, expect pass**

```bash
uv run pytest tests/integration/test_db_tree_nodes.py -v
```

- [ ] **Step 5: Commit**

```bash
git add src/sda_indexer/db/tree_nodes.py tests/integration/test_db_tree_nodes.py
git commit -m "feat(indexer): db/tree_nodes — bulk insert + summary updates

bulk_insert atómico (importante: triggers on insert disparan pgmq por
cada fila), set_summary, mark_summarizing/failed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase E — LLM client (Tasks 19-20)

### Task 19: llm/client.py — OpenAI-compatible client

**Files:**
- Create: `services/sda-indexer/src/sda_indexer/llm/client.py`
- Test: `services/sda-indexer/tests/unit/test_llm_client.py`

- [ ] **Step 1: Write failing test (con mock)**

Create `services/sda-indexer/tests/unit/test_llm_client.py`:
```python
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from sda_indexer.llm.client import LLMClient, LLMResult


@pytest.mark.asyncio
async def test_complete_returns_result():
    fake_completion = MagicMock()
    fake_completion.choices = [MagicMock(message=MagicMock(content="el resumen"))]
    fake_completion.usage = MagicMock(
        prompt_tokens=100, completion_tokens=20,
        prompt_tokens_details=MagicMock(cached_tokens=80),
    )
    fake_completion.model = "deepseek-chat"

    fake_client = MagicMock()
    fake_client.chat.completions.create = AsyncMock(return_value=fake_completion)

    with patch("sda_indexer.llm.client.AsyncOpenAI", return_value=fake_client):
        client = LLMClient(api_key="test", base_url="https://api.deepseek.com/v1")
        result = await client.complete(
            model="deepseek-chat",
            system="you are a summarizer",
            user="text to summarize",
        )

    assert isinstance(result, LLMResult)
    assert result.text == "el resumen"
    assert result.tokens_in == 100
    assert result.tokens_out == 20
    assert result.cached_tokens == 80
    assert result.model == "deepseek-chat"


@pytest.mark.asyncio
async def test_complete_handles_missing_cached_tokens():
    fake_completion = MagicMock()
    fake_completion.choices = [MagicMock(message=MagicMock(content="x"))]
    fake_completion.usage = MagicMock(
        prompt_tokens=10, completion_tokens=2,
        prompt_tokens_details=None,  # provider sin cache info
    )
    fake_completion.model = "m"
    fake_client = MagicMock()
    fake_client.chat.completions.create = AsyncMock(return_value=fake_completion)
    with patch("sda_indexer.llm.client.AsyncOpenAI", return_value=fake_client):
        client = LLMClient(api_key="t", base_url="https://x")
        result = await client.complete(model="m", system="s", user="u")
    assert result.cached_tokens == 0
```

- [ ] **Step 2: Run, expect ImportError**

- [ ] **Step 3: Write client.py**

Create `services/sda-indexer/src/sda_indexer/llm/client.py`:
```python
"""LLM client OpenAI-compatible. Funciona con DeepSeek y OpenRouter."""

from dataclasses import dataclass
from openai import AsyncOpenAI
import structlog

log = structlog.get_logger()


@dataclass(frozen=True)
class LLMResult:
    text: str
    tokens_in: int
    tokens_out: int
    cached_tokens: int
    model: str


class LLMClient:
    def __init__(self, api_key: str, base_url: str):
        self._client = AsyncOpenAI(api_key=api_key, base_url=base_url)

    async def complete(
        self, *,
        model: str,
        system: str,
        user: str,
        temperature: float = 0.2,
        max_tokens: int | None = None,
        response_format: dict | None = None,
    ) -> LLMResult:
        kwargs = {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": temperature,
        }
        if max_tokens is not None:
            kwargs["max_tokens"] = max_tokens
        if response_format is not None:
            kwargs["response_format"] = response_format

        log.debug("llm.call.start", model=model, system_len=len(system), user_len=len(user))
        resp = await self._client.chat.completions.create(**kwargs)
        usage = resp.usage
        cached = 0
        details = getattr(usage, "prompt_tokens_details", None)
        if details is not None:
            cached = getattr(details, "cached_tokens", 0) or 0
        return LLMResult(
            text=resp.choices[0].message.content,
            tokens_in=usage.prompt_tokens,
            tokens_out=usage.completion_tokens,
            cached_tokens=cached,
            model=resp.model,
        )
```

- [ ] **Step 4: Run tests, expect pass**

```bash
uv run pytest tests/unit/test_llm_client.py -v
```

- [ ] **Step 5: Commit**

```bash
git add src/sda_indexer/llm/client.py tests/unit/test_llm_client.py
git commit -m "feat(indexer): llm/client — OpenAI-compat client

LLMClient con AsyncOpenAI (DeepSeek/OpenRouter ambos compat).
LLMResult expone tokens incluyendo cached para tracking de hit ratio.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 20: llm/retry.py — tenacity wrapper

**Files:**
- Create: `services/sda-indexer/src/sda_indexer/llm/retry.py`
- Test: `services/sda-indexer/tests/unit/test_llm_retry.py`

- [ ] **Step 1: Write failing test**

Create `services/sda-indexer/tests/unit/test_llm_retry.py`:
```python
import pytest
from unittest.mock import AsyncMock
from sda_indexer.llm.retry import with_llm_retry


@pytest.mark.asyncio
async def test_succeeds_first_try():
    fn = AsyncMock(return_value="ok")
    wrapped = with_llm_retry(fn, max_attempts=3, base_ms=1, max_ms=10)
    result = await wrapped("arg")
    assert result == "ok"
    assert fn.call_count == 1


@pytest.mark.asyncio
async def test_retries_on_transient():
    from openai import APIError
    fn = AsyncMock(side_effect=[
        APIError("transient", request=None, body=None),
        APIError("transient", request=None, body=None),
        "ok",
    ])
    wrapped = with_llm_retry(fn, max_attempts=3, base_ms=1, max_ms=10)
    result = await wrapped()
    assert result == "ok"
    assert fn.call_count == 3


@pytest.mark.asyncio
async def test_gives_up_after_max():
    from openai import APIError
    fn = AsyncMock(side_effect=APIError("persistent", request=None, body=None))
    wrapped = with_llm_retry(fn, max_attempts=2, base_ms=1, max_ms=10)
    with pytest.raises(APIError):
        await wrapped()
    assert fn.call_count == 2
```

- [ ] **Step 2: Run, expect ImportError**

- [ ] **Step 3: Write retry.py**

Create `services/sda-indexer/src/sda_indexer/llm/retry.py`:
```python
"""Retry wrapper basado en tenacity. Backoff exponencial con jitter."""

from typing import Callable, TypeVar, Awaitable
from tenacity import (
    AsyncRetrying, stop_after_attempt, wait_exponential_jitter,
    retry_if_exception_type, before_sleep_log,
)
import structlog
import logging
from openai import APIError, APITimeoutError, RateLimitError, APIConnectionError

log = structlog.get_logger()
_stdlib_log = logging.getLogger("sda_indexer.llm.retry")

T = TypeVar("T")

RETRY_EXCEPTIONS = (APIError, APITimeoutError, RateLimitError, APIConnectionError)


def with_llm_retry(
    fn: Callable[..., Awaitable[T]],
    *,
    max_attempts: int = 3,
    base_ms: int = 1000,
    max_ms: int = 8000,
) -> Callable[..., Awaitable[T]]:
    """Devuelve una versión retryable de fn (async). Reintenta sólo en errores
    transients de OpenAI SDK; deja propagar todo lo demás."""
    async def wrapped(*args, **kwargs):
        async for attempt in AsyncRetrying(
            stop=stop_after_attempt(max_attempts),
            wait=wait_exponential_jitter(initial=base_ms / 1000.0, max=max_ms / 1000.0),
            retry=retry_if_exception_type(RETRY_EXCEPTIONS),
            before_sleep=before_sleep_log(_stdlib_log, logging.WARNING),
            reraise=True,
        ):
            with attempt:
                return await fn(*args, **kwargs)
    return wrapped
```

- [ ] **Step 4: Run tests, expect pass**

```bash
uv run pytest tests/unit/test_llm_retry.py -v
```

- [ ] **Step 5: Commit**

```bash
git add src/sda_indexer/llm/retry.py tests/unit/test_llm_retry.py
git commit -m "feat(indexer): llm/retry — tenacity wrapper para transients

with_llm_retry envuelve cualquier async fn con backoff exponencial+jitter.
Sólo reintenta en errores transients del OpenAI SDK; otros se propagan.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase F — Pipeline modules (Tasks 21-23)

### Task 21: pipeline/tree/builder.py — stack-based tree builder

**Files:**
- Create: `services/sda-indexer/src/sda_indexer/pipeline/tree/builder.py`
- Test: `services/sda-indexer/tests/unit/test_tree_builder.py`

- [ ] **Step 1: Write failing tests**

Create `services/sda-indexer/tests/unit/test_tree_builder.py`:
```python
from sda_indexer.pipeline.tree.builder import build_tree, FlatHeader, TreeNode


def test_flat_to_tree_simple():
    flat = [
        FlatHeader(level=1, title="A", start_line=1, text="ta"),
        FlatHeader(level=1, title="B", start_line=10, text="tb"),
    ]
    nodes = build_tree(flat, total_lines=20)
    assert len(nodes) == 2
    assert nodes[0].node_id_str == "n_1"
    assert nodes[0].structure_code == "1"
    assert nodes[0].depth == 1
    assert nodes[0].end_index == 9   # one before next header
    assert nodes[1].end_index == 20  # EOF


def test_flat_to_tree_nested():
    flat = [
        FlatHeader(level=1, title="Cap 1", start_line=1, text=""),
        FlatHeader(level=2, title="1.1",   start_line=5, text=""),
        FlatHeader(level=2, title="1.2",   start_line=10, text=""),
        FlatHeader(level=1, title="Cap 2", start_line=20, text=""),
    ]
    roots = build_tree(flat, total_lines=30)
    assert len(roots) == 2
    cap1 = roots[0]
    assert cap1.structure_code == "1"
    assert len(cap1.children) == 2
    assert cap1.children[0].structure_code == "1.1"
    assert cap1.children[1].structure_code == "1.2"
    assert cap1.children[0].node_id_str == "n_1_1"


def test_skip_levels_handled():
    # Salto de nivel (h1 → h3) — el h3 se promueve a hijo directo del h1
    flat = [
        FlatHeader(level=1, title="A", start_line=1, text=""),
        FlatHeader(level=3, title="A.x.y", start_line=5, text=""),
    ]
    roots = build_tree(flat, total_lines=10)
    assert len(roots) == 1
    assert len(roots[0].children) == 1
    assert roots[0].children[0].title == "A.x.y"


def test_flatten_iter():
    flat = [
        FlatHeader(level=1, title="A", start_line=1, text=""),
        FlatHeader(level=2, title="A.1", start_line=5, text=""),
    ]
    roots = build_tree(flat, total_lines=10)
    from sda_indexer.pipeline.tree.builder import flatten
    all_nodes = list(flatten(roots))
    assert len(all_nodes) == 2
    assert {n.structure_code for n in all_nodes} == {"1", "1.1"}
```

- [ ] **Step 2: Run, expect ImportError**

- [ ] **Step 3: Write builder.py**

Create `services/sda-indexer/src/sda_indexer/pipeline/tree/__init__.py` (empty).

Create `services/sda-indexer/src/sda_indexer/pipeline/tree/builder.py`:
```python
"""Tree builder — convierte una lista plana de headers en árbol jerárquico.

Stack-based, respeta saltos de nivel (h1 → h3 promueve h3 a hijo de h1
en vez de fallar). Cada nodo recibe structure_code ("1.2.3") y node_id_str
("n_1_2_3"). end_index se infiere del próximo sibling o EOF.
"""

from dataclasses import dataclass, field
from typing import Iterator


@dataclass(frozen=True)
class FlatHeader:
    level: int
    title: str
    start_line: int
    text: str


@dataclass
class TreeNode:
    node_id_str: str
    structure_code: str
    depth: int
    title: str
    start_index: int
    end_index: int = 0
    text: str = ""
    children: list["TreeNode"] = field(default_factory=list)
    parent: "TreeNode | None" = None


def build_tree(headers: list[FlatHeader], *, total_lines: int) -> list[TreeNode]:
    """Construye el árbol. Devuelve nodos raíz (sin padre)."""
    roots: list[TreeNode] = []
    stack: list[TreeNode] = []                      # ancestros vivos
    sibling_counter: dict[int, int] = {}            # depth → count for structure_code

    for h in headers:
        # pop ancestros con depth >= h.level
        while stack and stack[-1].depth >= h.level:
            popped = stack.pop()
            # reset counters de descendientes del popped
            for d in list(sibling_counter):
                if d > popped.depth:
                    del sibling_counter[d]

        parent = stack[-1] if stack else None
        depth = h.level
        sibling_counter[depth] = sibling_counter.get(depth, 0) + 1
        # structure_code: cadena de contadores desde root al actual
        codes = []
        cur = parent
        chain = []
        while cur:
            chain.append(cur)
            cur = cur.parent
        for ancestor in reversed(chain):
            codes.append(ancestor.structure_code.split(".")[-1])
        codes.append(str(sibling_counter[depth]))
        structure_code = ".".join(codes)
        node_id_str = "n_" + "_".join(codes)

        node = TreeNode(
            node_id_str=node_id_str,
            structure_code=structure_code,
            depth=depth,
            title=h.title,
            start_index=h.start_line,
            text=h.text,
            parent=parent,
        )
        if parent is None:
            roots.append(node)
        else:
            parent.children.append(node)
        stack.append(node)

    # segundo pase: set end_index = start del próximo header al mismo o menor depth, o EOF
    all_in_order = list(flatten(roots))
    for i, n in enumerate(all_in_order):
        # buscar el próximo nodo en orden con depth <= n.depth (mismo o ancestro level)
        next_start = total_lines + 1
        for j in range(i + 1, len(all_in_order)):
            if all_in_order[j].depth <= n.depth:
                next_start = all_in_order[j].start_index
                break
        n.end_index = next_start - 1 if next_start <= total_lines else total_lines
    return roots


def flatten(nodes: list[TreeNode]) -> Iterator[TreeNode]:
    """Recorre el árbol en pre-orden, yielding cada nodo."""
    for n in nodes:
        yield n
        yield from flatten(n.children)
```

- [ ] **Step 4: Run tests, expect pass**

```bash
uv run pytest tests/unit/test_tree_builder.py -v
```

- [ ] **Step 5: Commit**

```bash
git add src/sda_indexer/pipeline/tree/ tests/unit/test_tree_builder.py
git commit -m "feat(indexer): pipeline/tree/builder — stack-based tree

FlatHeader → TreeNode hierarchy. Maneja level skips (h1→h3 promueve).
structure_code y node_id_str derivados de la cadena de ancestros.
end_index del próximo header al mismo o menor depth, o EOF.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 22: pipeline/parser/markdown_regex.py

**Files:**
- Create: `services/sda-indexer/src/sda_indexer/pipeline/parser/markdown_regex.py`
- Test: `services/sda-indexer/tests/unit/test_markdown_regex.py`

- [ ] **Step 1: Write failing tests**

Create `services/sda-indexer/tests/unit/test_markdown_regex.py`:
```python
from sda_indexer.pipeline.parser.markdown_regex import parse_markdown_to_headers


def test_parses_simple_headers():
    md = """# Título

texto bajo título.

## Subsección

más texto.
"""
    headers = parse_markdown_to_headers(md)
    assert len(headers) == 2
    assert headers[0].level == 1
    assert headers[0].title == "Título"
    assert "texto bajo título" in headers[0].text
    assert headers[1].level == 2
    assert headers[1].title == "Subsección"


def test_skips_code_blocks():
    md = """# Real

```python
# fake header inside code block
def foo(): pass
```

más texto.

## Subsección real
"""
    headers = parse_markdown_to_headers(md)
    titles = [h.title for h in headers]
    assert "Real" in titles
    assert "Subsección real" in titles
    assert all("fake header" not in t for t in titles)


def test_records_start_line():
    md = "line0\n# h1\nbody\n## h2\n"
    headers = parse_markdown_to_headers(md)
    assert headers[0].start_line == 2
    assert headers[1].start_line == 4


def test_empty_markdown_yields_nothing():
    assert parse_markdown_to_headers("") == []
    assert parse_markdown_to_headers("just paragraph") == []
```

- [ ] **Step 2: Run, expect ImportError**

- [ ] **Step 3: Write markdown_regex.py**

Create `services/sda-indexer/src/sda_indexer/pipeline/parser/__init__.py` (empty).

Create `services/sda-indexer/src/sda_indexer/pipeline/parser/markdown_regex.py`:
```python
"""Markdown parser — regex sobre líneas, skipea code blocks delimitados por ```.
Output: lista FlatHeader que el tree_builder convierte en árbol."""

import re
from ..tree.builder import FlatHeader

HEADER_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")


def parse_markdown_to_headers(content: str) -> list[FlatHeader]:
    """Extrae headers + texto siguiente hasta el próximo header.

    Skipea bloques de código delimitados por ``` (no entra a sus contenidos).
    Líneas y start_line son 1-indexed.
    """
    lines = content.splitlines()
    in_code_block = False
    matches: list[tuple[int, int, str]] = []   # (line_idx, level, title)
    for i, line in enumerate(lines):
        if line.startswith("```"):
            in_code_block = not in_code_block
            continue
        if in_code_block:
            continue
        m = HEADER_RE.match(line)
        if m:
            level = len(m.group(1))
            title = m.group(2).strip()
            matches.append((i, level, title))

    headers: list[FlatHeader] = []
    for j, (line_idx, level, title) in enumerate(matches):
        text_start = line_idx + 1
        text_end = matches[j + 1][0] if j + 1 < len(matches) else len(lines)
        text = "\n".join(lines[text_start:text_end]).strip()
        headers.append(FlatHeader(
            level=level,
            title=title,
            start_line=line_idx + 1,        # 1-indexed
            text=text,
        ))
    return headers
```

- [ ] **Step 4: Run tests, expect pass**

```bash
uv run pytest tests/unit/test_markdown_regex.py -v
```

- [ ] **Step 5: Commit**

```bash
git add src/sda_indexer/pipeline/parser/ tests/unit/test_markdown_regex.py
git commit -m "feat(indexer): pipeline/parser/markdown_regex

Regex-based parser. Skipea code blocks. Cada FlatHeader trae level,
title, start_line (1-indexed), y el text entre este header y el próximo.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 23: pipeline/summarizer/summarize.py — pure function

**Files:**
- Create: `services/sda-indexer/src/sda_indexer/pipeline/summarizer/summarize.py`
- Test: `services/sda-indexer/tests/unit/test_summarizer.py`

- [ ] **Step 1: Write failing tests**

Create `services/sda-indexer/tests/unit/test_summarizer.py`:
```python
import pytest
from unittest.mock import AsyncMock
from sda_indexer.pipeline.summarizer.summarize import summarize_node
from sda_indexer.llm.client import LLMResult


@pytest.mark.asyncio
async def test_summarize_returns_summary():
    llm = AsyncMock()
    llm.complete = AsyncMock(return_value=LLMResult(
        text="Resumen breve.", tokens_in=100, tokens_out=10,
        cached_tokens=80, model="deepseek-chat",
    ))
    result = await summarize_node(
        llm=llm,
        model="deepseek-chat",
        node_text="texto del nodo",
        ancestor_path="Doc > Cap 1",
        doc_title="Doc",
        doc_type="generic",
        page_count=10,
        max_summary_chars=280,
        language="es",
        prompt_template="""You are SDA. Task: {{ task_name }}
Context: {{ doc.title }} ({{ doc.doc_type }}, {{ doc.page_count }} pages)
Path: {{ ancestor_path }}
Max chars: {{ max_chars }}
Lang: {{ language }}
Input:
{{ node_text }}""",
    )
    assert result.summary == "Resumen breve."
    assert result.tokens_in == 100
    assert result.cached_tokens == 80
    # Verificar que el prompt llegó renderizado
    call = llm.complete.call_args
    assert "Doc" in call.kwargs["user"]
    assert "Cap 1" in call.kwargs["user"]
    assert "texto del nodo" in call.kwargs["user"]
```

- [ ] **Step 2: Run, expect ImportError**

- [ ] **Step 3: Write summarize.py**

Create `services/sda-indexer/src/sda_indexer/pipeline/summarizer/__init__.py` (empty).

Create `services/sda-indexer/src/sda_indexer/pipeline/summarizer/summarize.py`:
```python
"""Summarize node — render prompt + LLM call. Pure function (sin DB)."""

from dataclasses import dataclass
from jinja2 import Template
from ...llm.client import LLMClient


@dataclass(frozen=True)
class SummaryResult:
    summary: str
    tokens_in: int
    tokens_out: int
    cached_tokens: int
    model: str
    rendered_user_prompt: str    # útil para audit / debugging


SYSTEM_PROMPT = (
    "You are SDA-Indexer, a document indexing assistant. "
    "Your only job is to write short, factual summaries of document sections "
    "for downstream retrieval. Never invent content not in the input."
)


async def summarize_node(
    *,
    llm: LLMClient,
    model: str,
    node_text: str,
    ancestor_path: str,
    doc_title: str,
    doc_type: str,
    page_count: int | None,
    max_summary_chars: int,
    language: str,
    prompt_template: str,
) -> SummaryResult:
    """Renderiza el prompt con jinja2 y llama al LLM. Devuelve summary + métricas."""
    template = Template(prompt_template)
    rendered = template.render(
        task_name="summarize_node",
        doc={"title": doc_title, "doc_type": doc_type, "page_count": page_count or "n/a"},
        ancestor_path=ancestor_path,
        max_chars=max_summary_chars,
        language=language,
        node_text=node_text,
    )
    result = await llm.complete(
        model=model,
        system=SYSTEM_PROMPT,
        user=rendered,
        temperature=0.2,
        max_tokens=max(64, max_summary_chars // 2),
    )
    return SummaryResult(
        summary=result.text.strip(),
        tokens_in=result.tokens_in,
        tokens_out=result.tokens_out,
        cached_tokens=result.cached_tokens,
        model=result.model,
        rendered_user_prompt=rendered,
    )
```

- [ ] **Step 4: Run tests, expect pass**

```bash
uv run pytest tests/unit/test_summarizer.py -v
```

- [ ] **Step 5: Commit**

```bash
git add src/sda_indexer/pipeline/summarizer/ tests/unit/test_summarizer.py
git commit -m "feat(indexer): pipeline/summarizer/summarize — pure function

Renderiza prompt jinja2 + llama LLM. Sin DB ni IO. Devuelve summary
y métricas. SYSTEM_PROMPT constante, prompt user es el template.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase G — Prompts (Task 24)

### Task 24: prompts/_base.j2 + summarize.j2 + bootstrap loader

**Files:**
- Create: `services/sda-indexer/src/sda_indexer/prompts/_base.j2`
- Create: `services/sda-indexer/src/sda_indexer/prompts/summarize.j2`
- Create: `services/sda-indexer/src/sda_indexer/prompts/__init__.py`
- Create: `services/sda-indexer/src/sda_indexer/prompts/loader.py`
- Test: `services/sda-indexer/tests/unit/test_prompts_loader.py`

- [ ] **Step 1: Write failing test**

Create `services/sda-indexer/tests/unit/test_prompts_loader.py`:
```python
from sda_indexer.prompts.loader import load_prompt_files, render


def test_load_files_returns_summarize():
    prompts = load_prompt_files()
    assert "summarize" in prompts
    assert "{{ node_text }}" in prompts["summarize"] or "node_text" in prompts["summarize"]


def test_render_includes_context():
    prompts = load_prompt_files()
    rendered = render(prompts["summarize"], {
        "task_name": "summarize_node",
        "doc": {"title": "Doc", "doc_type": "manual", "page_count": 10},
        "ancestor_path": "Doc > Cap 1",
        "max_chars": 280,
        "language": "es",
        "node_text": "hola mundo",
    })
    assert "Doc" in rendered
    assert "hola mundo" in rendered
```

- [ ] **Step 2: Run, expect ImportError**

- [ ] **Step 3: Write prompt files**

Create `services/sda-indexer/src/sda_indexer/prompts/_base.j2`:
```jinja
{# === STABLE PREFIX (cacheable por DeepSeek) === #}
Task: {{ task_name }}

Document context:
- Title: {{ doc.title }}
- Type: {{ doc.doc_type or 'unknown' }}
- Total pages: {{ doc.page_count }}

Rules (strict):
{% block rules %}
- Default rules.
{% endblock %}

Output format:
{% block output_format %}
Plain text.
{% endblock %}

{# === VARIABLE SUFFIX (no cacheable) === #}

Input:
{% block input_content %}
{{ input_content }}
{% endblock %}
```

Create `services/sda-indexer/src/sda_indexer/prompts/summarize.j2`:
```jinja
{% extends "_base.j2" %}

{% block rules %}
- Be concrete: name entities, dates, amounts when present.
- Do not hallucinate content beyond what the input contains.
- Stay within {{ max_chars }} characters unless content is unusually dense.
- Respond in {{ language }}.
- Start with the topic; do not begin with "This section discusses...".
{% endblock %}

{% block output_format %}
A 2-4 sentence summary, focused on what content this section contains so that a downstream agent can decide whether to read it for a given query.
{% endblock %}

{% block input_content %}
[Section context: {{ ancestor_path }}]
{{ node_text }}
{% endblock %}
```

- [ ] **Step 4: Write loader.py**

Create `services/sda-indexer/src/sda_indexer/prompts/loader.py`:
```python
"""Carga los templates .j2 del filesystem al boot. Después de Wave 0, los
templates viven también en app_settings con scope override; el FS sirve
como fuente fallback cuando la setting no existe en DB."""

from pathlib import Path
from jinja2 import Environment, FileSystemLoader, select_autoescape

PROMPTS_DIR = Path(__file__).parent

_env = Environment(
    loader=FileSystemLoader(str(PROMPTS_DIR)),
    autoescape=select_autoescape([]),
    trim_blocks=True,
    lstrip_blocks=True,
)


def load_prompt_files() -> dict[str, str]:
    """Devuelve {nombre: source} de cada .j2 (sin extension)."""
    out: dict[str, str] = {}
    for path in PROMPTS_DIR.glob("*.j2"):
        if path.name.startswith("_"):
            continue   # _base.j2 no es un prompt independiente
        # render with extends => obtenemos source ya resuelto
        template = _env.get_template(path.name)
        source = path.read_text(encoding="utf-8")
        out[path.stem] = source
    return out


def render(template_source: str, context: dict) -> str:
    """Renderiza un template source (string) con el contexto provisto.

    Acepta `{% extends "_base.j2" %}` — usa el environment con FileSystemLoader
    así extends se resuelve.
    """
    template = _env.from_string(template_source)
    return template.render(**context)
```

- [ ] **Step 5: Run tests, expect pass**

```bash
uv run pytest tests/unit/test_prompts_loader.py -v
```

- [ ] **Step 6: Commit**

```bash
git add src/sda_indexer/prompts/ tests/unit/test_prompts_loader.py
git commit -m "feat(indexer): prompts — _base.j2 + summarize.j2 + loader

Templates jinja2 con structure prefijo-estable/sufijo-variable.
loader.load_prompt_files() escanea FS al boot; render() acepta source
y resuelve extends via FileSystemLoader.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase H — Workflows LangGraph (Tasks 25-27)

### Task 25: workflows/summarize.py — LangGraph para summarize un nodo

**Files:**
- Create: `services/sda-indexer/src/sda_indexer/workflows/summarize.py`
- Test: `services/sda-indexer/tests/integration/test_workflow_summarize.py`

- [ ] **Step 1: Write failing integration test**

Create `services/sda-indexer/tests/integration/test_workflow_summarize.py`:
```python
import os
import pytest
from unittest.mock import AsyncMock, patch
from sda_indexer.db.client import DB
from sda_indexer.settings.client import SettingsClient
from sda_indexer.settings.registry import SETTINGS
from sda_indexer.workflows.summarize import build_graph, run_summarize
from sda_indexer.llm.client import LLMResult

pytestmark = pytest.mark.asyncio


@pytest.fixture
async def db():
    dsn = os.getenv("SDA_DB_DSN", "postgresql://postgres:postgres@localhost:54322/postgres")
    d = DB(dsn=dsn)
    await d.start()
    yield d
    async with d.pool.acquire() as conn:
        await conn.execute("delete from documents where source_path like 'docs/test-wf-%';")
    await d.close()


@pytest.fixture
async def settings_client(db):
    sc = SettingsClient(db.pool, SETTINGS, start_listener=False)
    yield sc
    await sc.close()


async def test_summarize_workflow_updates_node(db, settings_client):
    async with db.pool.acquire() as conn:
        doc_id = await conn.fetchval(
            "insert into documents (sha256, source_path, source_type, doc_description) "
            "values ('test-wf-1','docs/test-wf-1.md','markdown','desc test') returning id"
        )
        node_id = await conn.fetchval(
            "insert into tree_nodes (document_id, node_id_str, structure_code, depth, "
            "title, start_index, end_index, text) "
            "values ($1, 'n_1', '1', 1, 'Cap 1', 1, 10, 'Texto del nodo a resumir') "
            "returning id",
            doc_id,
        )

    fake_llm = AsyncMock()
    fake_llm.complete = AsyncMock(return_value=LLMResult(
        text="Resumen del cap 1.",
        tokens_in=50, tokens_out=8, cached_tokens=40,
        model="deepseek-chat",
    ))
    graph = build_graph(db=db, settings=settings_client, llm=fake_llm)
    final = await run_summarize(graph, node_id=str(node_id), document_id=str(doc_id))

    assert final["summary"] == "Resumen del cap 1."
    async with db.pool.acquire() as conn:
        row = await conn.fetchrow("select status, summary from tree_nodes where id=$1", node_id)
    assert row["status"] == "ready"
    assert row["summary"] == "Resumen del cap 1."
```

- [ ] **Step 2: Run, expect ImportError**

- [ ] **Step 3: Write summarize workflow**

Create `services/sda-indexer/src/sda_indexer/workflows/__init__.py` (empty).

Create `services/sda-indexer/src/sda_indexer/workflows/summarize.py`:
```python
"""LangGraph workflow para summarize un nodo. Spec §3.3."""

from typing import TypedDict
import structlog
from langgraph.graph import StateGraph, START, END
from ..db.client import DB
from ..db import tree_nodes, documents
from ..settings.client import SettingsClient
from ..llm.client import LLMClient
from ..llm.retry import with_llm_retry
from ..pipeline.summarizer.summarize import summarize_node, SummaryResult
from ..prompts.loader import load_prompt_files

log = structlog.get_logger()


class State(TypedDict, total=False):
    node_id: str
    document_id: str
    node_text: str
    ancestor_path: str
    doc_title: str
    doc_type: str
    page_count: int | None
    selected_model: str
    max_chars: int
    language: str
    summary: str
    tokens_in: int
    tokens_out: int
    cached_tokens: int


def build_graph(db: DB, settings: SettingsClient, llm: LLMClient, prompts: dict | None = None):
    prompts = prompts or load_prompt_files()

    async def load_node_text(s: State) -> dict:
        n = await tree_nodes.get_node(db.pool, s["node_id"])
        d = await documents.get_document(db.pool, s["document_id"])
        # ancestor_path: chain de titles de root → node
        async with db.pool.acquire() as conn:
            ancestors = await conn.fetch(
                """with recursive chain as (
                     select id, parent_id, title from tree_nodes where id=$1
                     union all
                     select t.id, t.parent_id, t.title from tree_nodes t
                       join chain c on t.id = c.parent_id
                   ) select title from chain""",
                s["node_id"],
            )
        path_titles = list(reversed([r["title"] for r in ancestors]))
        ancestor_path = " > ".join([d["source_path"]] + path_titles[:-1]) if path_titles else d["source_path"]
        return {
            "node_text": n["text"] or "",
            "ancestor_path": ancestor_path,
            "doc_title": d["source_path"],
            "doc_type": d["doc_type"] or "generic",
            "page_count": d["page_count"],
        }

    async def select_model(s: State) -> dict:
        model = await settings.resolve("llm.model.summarize",
                                       doc_type=s.get("doc_type"),
                                       document_id=s["document_id"])
        max_chars = await settings.resolve("summarize.max_summary_chars",
                                            doc_type=s.get("doc_type"))
        language = await settings.resolve("summarize.language",
                                           document_id=s["document_id"])
        return {"selected_model": model, "max_chars": max_chars, "language": language}

    async def call_llm(s: State) -> dict:
        await tree_nodes.mark_summarizing(db.pool, s["node_id"])
        template = await settings.resolve("prompt.template.summarize",
                                            doc_type=s.get("doc_type"))
        if template.startswith("<bootstrapped"):
            template = prompts["summarize"]
        retryable = with_llm_retry(summarize_node, max_attempts=3)
        result: SummaryResult = await retryable(
            llm=llm,
            model=s["selected_model"],
            node_text=s["node_text"],
            ancestor_path=s["ancestor_path"],
            doc_title=s["doc_title"],
            doc_type=s["doc_type"],
            page_count=s["page_count"],
            max_summary_chars=s["max_chars"],
            language=s["language"],
            prompt_template=template,
        )
        return {
            "summary": result.summary,
            "tokens_in": result.tokens_in,
            "tokens_out": result.tokens_out,
            "cached_tokens": result.cached_tokens,
        }

    async def persist(s: State) -> dict:
        await tree_nodes.set_summary(
            db.pool, s["node_id"],
            summary=s["summary"],
            model=s["selected_model"],
        )
        log.info("summarize.persisted",
                 node_id=s["node_id"], tokens_in=s["tokens_in"],
                 cached=s["cached_tokens"])
        return {}

    g = StateGraph(State)
    g.add_node("load_node_text", load_node_text)
    g.add_node("select_model", select_model)
    g.add_node("call_llm", call_llm)
    g.add_node("persist", persist)
    g.add_edge(START, "load_node_text")
    g.add_edge("load_node_text", "select_model")
    g.add_edge("select_model", "call_llm")
    g.add_edge("call_llm", "persist")
    g.add_edge("persist", END)
    return g.compile()


async def run_summarize(graph, *, node_id: str, document_id: str) -> dict:
    return await graph.ainvoke({"node_id": node_id, "document_id": document_id})
```

- [ ] **Step 4: Run, expect pass**

```bash
uv run pytest tests/integration/test_workflow_summarize.py -v
```

- [ ] **Step 5: Commit**

```bash
git add src/sda_indexer/workflows/summarize.py tests/integration/test_workflow_summarize.py
git commit -m "feat(indexer): workflows/summarize — LangGraph para 1 nodo

load_node_text → select_model → call_llm → persist. Model + max_chars
+ language vienen de settings con scope cascade. Spec §3.3.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 26: workflows/structure.py — LangGraph para extract structure (MD only en Wave 0)

**Files:**
- Create: `services/sda-indexer/src/sda_indexer/workflows/structure.py`
- Test: `services/sda-indexer/tests/integration/test_workflow_structure_md.py`

- [ ] **Step 1: Write failing test**

Create `services/sda-indexer/tests/integration/test_workflow_structure_md.py`:
```python
import os
import hashlib
import pytest
from supabase import create_client
from sda_indexer.db.client import DB
from sda_indexer.workflows.structure import build_graph, run_structure

pytestmark = pytest.mark.asyncio


@pytest.fixture
async def db():
    dsn = os.getenv("SDA_DB_DSN", "postgresql://postgres:postgres@localhost:54322/postgres")
    d = DB(dsn=dsn)
    await d.start()
    yield d
    async with d.pool.acquire() as conn:
        await conn.execute("delete from documents where source_path like 'docs/test-st-%';")
    await d.close()


@pytest.fixture
def supabase():
    url = os.getenv("SDA_SUPABASE_URL", "http://127.0.0.1:54321")
    key = os.getenv("SDA_SUPABASE_SERVICE_KEY", "")
    return create_client(url, key)


@pytest.fixture
async def doc_with_provisional_sha(db, supabase, tmp_path):
    # Sube un MD chico a Storage local + INSERT documents con provisional
    md_content = "# Cap 1\n\nTexto uno.\n\n## 1.1 Sub\n\nTexto sub.\n\n## 1.2 Otro\n\nMás texto.\n"
    md_path = "docs/test-st-1.md"
    file_path = tmp_path / "tmp.md"
    file_path.write_bytes(md_content.encode())
    supabase.storage.from_("docs").upload(md_path, str(file_path), {"upsert": "true"})
    async with db.pool.acquire() as conn:
        doc_id = await conn.fetchval(
            "insert into documents (sha256, source_path, source_type) "
            "values ($1, $2, 'markdown') returning id",
            "provisional:test-st-1", md_path,
        )
    yield {"doc_id": str(doc_id), "md_content": md_content, "path": md_path}


async def test_structure_md_creates_nodes(db, supabase, doc_with_provisional_sha):
    graph = build_graph(db=db, supabase=supabase)
    result = await run_structure(graph, document_id=doc_with_provisional_sha["doc_id"])
    assert result["node_count"] >= 3
    async with db.pool.acquire() as conn:
        rows = await conn.fetch(
            "select node_id_str, structure_code, depth, title from tree_nodes "
            "where document_id=$1 order by structure_code",
            doc_with_provisional_sha["doc_id"],
        )
    titles = [r["title"] for r in rows]
    assert "Cap 1" in titles
    assert "1.1 Sub" in titles
```

- [ ] **Step 2: Run, expect ImportError**

- [ ] **Step 3: Write structure workflow**

Create `services/sda-indexer/src/sda_indexer/workflows/structure.py`:
```python
"""LangGraph workflow para extract_structure. Wave 0: solo MD path.
Wave 1 agrega PDF via MinerU + TOC dance."""

import hashlib
from typing import TypedDict
import structlog
from langgraph.graph import StateGraph, START, END
from ..db.client import DB
from ..db import documents, tree_nodes
from ..pipeline.parser.markdown_regex import parse_markdown_to_headers
from ..pipeline.tree.builder import build_tree, flatten

log = structlog.get_logger()


class State(TypedDict, total=False):
    document_id: str
    source_path: str
    source_type: str
    raw_bytes: bytes
    real_sha256: str
    md_content: str
    node_count: int
    aborted: bool


def build_graph(db: DB, supabase):

    async def load_from_storage(s: State) -> dict:
        doc = await documents.get_document(db.pool, s["document_id"])
        # Descarga el blob desde Storage
        resp = supabase.storage.from_("docs").download(doc["source_path"])
        raw = resp if isinstance(resp, bytes) else resp.read()
        real_sha = hashlib.sha256(raw).hexdigest()
        return {
            "raw_bytes": raw,
            "source_path": doc["source_path"],
            "source_type": doc["source_type"],
            "real_sha256": real_sha,
        }

    async def reconcile_sha(s: State) -> dict:
        result = await documents.update_sha256_post_load(
            db.pool, s["document_id"], s["real_sha256"],
        )
        if result == "duplicate":
            log.info("structure.aborted_duplicate", document_id=s["document_id"])
            return {"aborted": True}
        return {"aborted": False}

    def route_after_reconcile(s: State) -> str:
        return "done" if s.get("aborted") else "parse"

    async def parse_md(s: State) -> dict:
        if s["source_type"] != "markdown":
            raise NotImplementedError("Wave 0 sólo soporta markdown. PDF en Wave 1.")
        content = s["raw_bytes"].decode("utf-8")
        return {"md_content": content}

    async def build_tree_and_persist(s: State) -> dict:
        content = s["md_content"]
        headers = parse_markdown_to_headers(content)
        total_lines = len(content.splitlines())
        roots = build_tree(headers, total_lines=total_lines)

        # flatten + map parents
        all_nodes = list(flatten(roots))
        async with db.pool.acquire() as conn:
            async with conn.transaction():
                id_map: dict[str, str] = {}   # node_id_str → uuid
                for n in all_nodes:
                    parent_uuid = id_map.get(n.parent.node_id_str) if n.parent else None
                    new_id = await conn.fetchval(
                        """insert into tree_nodes (
                            document_id, parent_id, node_id_str, structure_code,
                            depth, title, start_index, end_index, text
                           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                           returning id""",
                        s["document_id"], parent_uuid,
                        n.node_id_str, n.structure_code, n.depth, n.title,
                        n.start_index, n.end_index, n.text,
                    )
                    id_map[n.node_id_str] = str(new_id)
        return {"node_count": len(all_nodes)}

    async def mark_summarizing(s: State) -> dict:
        async with db.pool.acquire() as conn:
            await conn.execute(
                "update documents set status='summarizing' where id=$1",
                s["document_id"],
            )
        return {}

    g = StateGraph(State)
    g.add_node("load_from_storage", load_from_storage)
    g.add_node("reconcile_sha", reconcile_sha)
    g.add_node("parse_md", parse_md)
    g.add_node("build_and_persist", build_tree_and_persist)
    g.add_node("mark_summarizing", mark_summarizing)

    g.add_edge(START, "load_from_storage")
    g.add_edge("load_from_storage", "reconcile_sha")
    g.add_conditional_edges("reconcile_sha", route_after_reconcile, {
        "parse": "parse_md",
        "done": END,
    })
    g.add_edge("parse_md", "build_and_persist")
    g.add_edge("build_and_persist", "mark_summarizing")
    g.add_edge("mark_summarizing", END)
    return g.compile()


async def run_structure(graph, *, document_id: str) -> dict:
    final = await graph.ainvoke({"document_id": document_id})
    return {"node_count": final.get("node_count", 0), "aborted": final.get("aborted", False)}
```

- [ ] **Step 4: Run, expect pass**

```bash
uv run pytest tests/integration/test_workflow_structure_md.py -v
```

- [ ] **Step 5: Commit**

```bash
git add src/sda_indexer/workflows/structure.py tests/integration/test_workflow_structure_md.py
git commit -m "feat(indexer): workflows/structure — MD path Wave 0

load_from_storage → reconcile_sha (dedup) → parse_md → build+persist →
mark_summarizing. Triggers on tree_nodes encolan q_summarize_node.
PDF/full-path en Wave 1.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 27: workflows/finalize.py — marca documents.status=ready

**Files:**
- Create: `services/sda-indexer/src/sda_indexer/workflows/finalize.py`

- [ ] **Step 1: Write finalize.py**

Create `services/sda-indexer/src/sda_indexer/workflows/finalize.py`:
```python
"""LangGraph workflow para finalize. Verifica que todos los nodos están ready,
calcula costo agregado, marca documents.status='ready'. Wave 0: sin
doc_description, sin quality_metrics propios (Wave 2)."""

from typing import TypedDict
import structlog
from langgraph.graph import StateGraph, START, END
from ..db.client import DB
from ..db import documents as docs_db

log = structlog.get_logger()


class State(TypedDict, total=False):
    document_id: str
    node_count: int
    total_cost_cents: float


def build_graph(db: DB):

    async def verify_all_ready(s: State) -> dict:
        async with db.pool.acquire() as conn:
            row = await conn.fetchrow(
                """select count(*) filter (where status='ready') as ready,
                          count(*) as total
                     from tree_nodes where document_id=$1""",
                s["document_id"],
            )
        if row["total"] == 0 or row["ready"] != row["total"]:
            raise RuntimeError(
                f"finalize called but not all nodes ready: "
                f"{row['ready']}/{row['total']}"
            )
        return {"node_count": row["total"]}

    async def aggregate_cost(s: State) -> dict:
        async with db.pool.acquire() as conn:
            cost = await conn.fetchval(
                "select coalesce(sum(cost_cents), 0) from llm_calls where document_id=$1",
                s["document_id"],
            )
        return {"total_cost_cents": float(cost or 0)}

    async def mark_ready(s: State) -> dict:
        await docs_db.mark_ready_meta(
            db.pool, s["document_id"],
            node_count=s["node_count"],
            page_count=None,
            path_used="full",       # Wave 0 sólo MD path; Wave 1 inyecta real path_used
            doc_description=None,
            total_cost_cents=s["total_cost_cents"],
        )
        log.info("finalize.complete",
                 document_id=s["document_id"],
                 node_count=s["node_count"],
                 cost_cents=s["total_cost_cents"])
        return {}

    g = StateGraph(State)
    g.add_node("verify", verify_all_ready)
    g.add_node("cost", aggregate_cost)
    g.add_node("mark", mark_ready)
    g.add_edge(START, "verify")
    g.add_edge("verify", "cost")
    g.add_edge("cost", "mark")
    g.add_edge("mark", END)
    return g.compile()


async def run_finalize(graph, *, document_id: str) -> dict:
    final = await graph.ainvoke({"document_id": document_id})
    return {
        "status": "ready",
        "node_count": final.get("node_count", 0),
        "total_cost_cents": final.get("total_cost_cents", 0),
    }
```

- [ ] **Step 2: Commit (test integral en E2E task)**

```bash
git add src/sda_indexer/workflows/finalize.py
git commit -m "feat(indexer): workflows/finalize — verify + cost + mark_ready

3-step workflow. Wave 0 sin doc_description ni quality_metrics (Wave 2).
path_used hardcoded 'full' en Wave 0; Wave 1 inyecta real.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase I — API endpoints (Tasks 28-32)

### Task 28: api/auth.py — bearer token middleware

**Files:**
- Create: `services/sda-indexer/src/sda_indexer/api/auth.py`
- Test: `services/sda-indexer/tests/unit/test_api_auth.py`

- [ ] **Step 1: Write failing test**

Create `services/sda-indexer/tests/unit/test_api_auth.py`:
```python
import pytest
from fastapi import FastAPI, Depends
from fastapi.testclient import TestClient
from sda_indexer.api.auth import require_bearer


def make_app(token: str):
    app = FastAPI()
    @app.get("/protected", dependencies=[Depends(require_bearer(token))])
    def ok():
        return {"ok": True}
    return app


def test_missing_header_401():
    app = make_app("secret123")
    client = TestClient(app)
    r = client.get("/protected")
    assert r.status_code == 401


def test_wrong_token_401():
    app = make_app("secret123")
    client = TestClient(app)
    r = client.get("/protected", headers={"Authorization": "Bearer wrong"})
    assert r.status_code == 401


def test_correct_token_200():
    app = make_app("secret123")
    client = TestClient(app)
    r = client.get("/protected", headers={"Authorization": "Bearer secret123"})
    assert r.status_code == 200
```

- [ ] **Step 2: Run, expect ImportError**

- [ ] **Step 3: Write auth.py**

Create `services/sda-indexer/src/sda_indexer/api/__init__.py` (empty).

Create `services/sda-indexer/src/sda_indexer/api/auth.py`:
```python
"""Bearer token middleware factory. Token compartido entre pg_net y srv-ia-01."""

import secrets
from fastapi import Header, HTTPException, status


def require_bearer(expected_token: str):
    """Devuelve una FastAPI dependency que valida Authorization: Bearer <expected_token>."""
    async def _validator(authorization: str | None = Header(None)):
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Missing Bearer token",
            )
        token = authorization[len("Bearer "):]
        if not secrets.compare_digest(token, expected_token):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid Bearer token",
            )
    return _validator
```

- [ ] **Step 4: Run tests, expect pass**

```bash
uv run pytest tests/unit/test_api_auth.py -v
```

- [ ] **Step 5: Commit**

```bash
git add src/sda_indexer/api/auth.py tests/unit/test_api_auth.py
git commit -m "feat(indexer): api/auth — bearer middleware factory

require_bearer(expected_token) → FastAPI dependency. secrets.compare_digest
contra timing attacks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 29: api/health.py — health endpoint

**Files:**
- Create: `services/sda-indexer/src/sda_indexer/api/health.py`

- [ ] **Step 1: Write health.py**

Create `services/sda-indexer/src/sda_indexer/api/health.py`:
```python
"""GET /health — chequeo de dependencias (DB, LLM client reachable)."""

from fastapi import APIRouter, Depends, Request

router = APIRouter()


@router.get("/health")
async def health(request: Request) -> dict:
    db_ok = await request.app.state.db.health()
    return {
        "service": "sda-indexer",
        "version": "0.1.0",
        "db": db_ok,
        "llm": True,    # Wave 0: no hacemos ping al provider en cada health
        "status": "ok" if db_ok else "degraded",
    }
```

- [ ] **Step 2: Commit**

```bash
git add src/sda_indexer/api/health.py
git commit -m "feat(indexer): api/health — DB-aware health endpoint

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 30: api/structure.py — POST /index/structure

**Files:**
- Create: `services/sda-indexer/src/sda_indexer/api/structure.py`

- [ ] **Step 1: Write structure.py**

Create `services/sda-indexer/src/sda_indexer/api/structure.py`:
```python
"""POST /index/structure — dispara structure_workflow para un documento."""

from fastapi import APIRouter, Request, Depends, HTTPException
from pydantic import BaseModel
from ..workflows.structure import run_structure

router = APIRouter()


class StructureIn(BaseModel):
    document_id: str
    idempotency_key: str | None = None
    trace_id: str | None = None


class StructureOut(BaseModel):
    node_count: int
    aborted: bool
    document_id: str


@router.post("/index/structure", response_model=StructureOut)
async def structure(payload: StructureIn, request: Request) -> StructureOut:
    graph = request.app.state.structure_graph
    try:
        result = await run_structure(graph, document_id=payload.document_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return StructureOut(
        node_count=result["node_count"],
        aborted=result["aborted"],
        document_id=payload.document_id,
    )
```

- [ ] **Step 2: Commit**

```bash
git add src/sda_indexer/api/structure.py
git commit -m "feat(indexer): api/structure — POST /index/structure router

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 31: api/summarize.py — POST /index/summarize

**Files:**
- Create: `services/sda-indexer/src/sda_indexer/api/summarize.py`

- [ ] **Step 1: Write summarize.py**

Create `services/sda-indexer/src/sda_indexer/api/summarize.py`:
```python
"""POST /index/summarize — dispara summarize_workflow para un nodo."""

from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel
from ..workflows.summarize import run_summarize

router = APIRouter()


class SummarizeIn(BaseModel):
    node_id: str
    document_id: str
    idempotency_key: str | None = None


class SummarizeOut(BaseModel):
    node_id: str
    summary: str
    model: str
    tokens_in: int
    tokens_out: int
    cached_tokens: int


@router.post("/index/summarize", response_model=SummarizeOut)
async def summarize(payload: SummarizeIn, request: Request) -> SummarizeOut:
    graph = request.app.state.summarize_graph
    try:
        result = await run_summarize(
            graph, node_id=payload.node_id, document_id=payload.document_id,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return SummarizeOut(
        node_id=payload.node_id,
        summary=result["summary"],
        model=result["selected_model"],
        tokens_in=result["tokens_in"],
        tokens_out=result["tokens_out"],
        cached_tokens=result["cached_tokens"],
    )
```

- [ ] **Step 2: Commit**

```bash
git add src/sda_indexer/api/summarize.py
git commit -m "feat(indexer): api/summarize — POST /index/summarize router

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 32: api/finalize.py — POST /index/finalize

**Files:**
- Create: `services/sda-indexer/src/sda_indexer/api/finalize.py`

- [ ] **Step 1: Write finalize.py**

Create `services/sda-indexer/src/sda_indexer/api/finalize.py`:
```python
"""POST /index/finalize — dispara finalize_workflow."""

from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel
from ..workflows.finalize import run_finalize

router = APIRouter()


class FinalizeIn(BaseModel):
    document_id: str
    idempotency_key: str | None = None


class FinalizeOut(BaseModel):
    document_id: str
    status: str
    node_count: int
    total_cost_cents: float


@router.post("/index/finalize", response_model=FinalizeOut)
async def finalize(payload: FinalizeIn, request: Request) -> FinalizeOut:
    graph = request.app.state.finalize_graph
    try:
        result = await run_finalize(graph, document_id=payload.document_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return FinalizeOut(
        document_id=payload.document_id,
        status=result["status"],
        node_count=result["node_count"],
        total_cost_cents=result["total_cost_cents"],
    )
```

- [ ] **Step 2: Commit**

```bash
git add src/sda_indexer/api/finalize.py
git commit -m "feat(indexer): api/finalize — POST /index/finalize router

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase J — main.py (Task 33)

### Task 33: main.py — FastAPI app + lifespan + wiring

**Files:**
- Create: `services/sda-indexer/src/sda_indexer/main.py`

- [ ] **Step 1: Write main.py**

Create `services/sda-indexer/src/sda_indexer/main.py`:
```python
"""FastAPI app + lifespan + wiring de DB, settings, LLM, workflows."""

from contextlib import asynccontextmanager
import structlog
from fastapi import FastAPI, Depends
from supabase import create_client
from .config import Settings
from .db.client import DB
from .settings.client import SettingsClient
from .settings.sync import sync_registry_to_db
from .settings.registry import SETTINGS
from .llm.client import LLMClient
from .workflows.structure import build_graph as build_structure_graph
from .workflows.summarize import build_graph as build_summarize_graph
from .workflows.finalize import build_graph as build_finalize_graph
from .api.auth import require_bearer
from .api.health import router as health_router
from .api.structure import router as structure_router
from .api.summarize import router as summarize_router
from .api.finalize import router as finalize_router

log = structlog.get_logger()


@asynccontextmanager
async def lifespan(app: FastAPI):
    cfg = Settings()
    log.info("startup", env=cfg.env, supabase=cfg.supabase_url)

    db = DB(
        dsn=cfg.db_dsn.get_secret_value(),
        min_size=cfg.db_pool_min_size,
        max_size=cfg.db_pool_max_size,
    )
    await db.start()

    log.info("settings.sync.start")
    await sync_registry_to_db(db.pool, SETTINGS)

    settings_client = SettingsClient(db.pool, SETTINGS, start_listener=True)

    supabase = create_client(
        cfg.supabase_url, cfg.supabase_service_key.get_secret_value(),
    )

    llm = LLMClient(
        api_key=cfg.deepseek_api_key.get_secret_value(),
        base_url=cfg.deepseek_base_url,
    )

    app.state.db = db
    app.state.settings_client = settings_client
    app.state.llm = llm
    app.state.supabase = supabase
    app.state.structure_graph = build_structure_graph(db=db, supabase=supabase)
    app.state.summarize_graph = build_summarize_graph(
        db=db, settings=settings_client, llm=llm,
    )
    app.state.finalize_graph = build_finalize_graph(db=db)

    yield

    await settings_client.close()
    await db.close()
    log.info("shutdown")


def make_app() -> FastAPI:
    cfg = Settings()
    bearer = cfg.srv_ia_01_secret.get_secret_value()
    deps = [Depends(require_bearer(bearer))]

    app = FastAPI(
        title="sda-indexer",
        version="0.1.0",
        lifespan=lifespan,
    )
    # Health sin auth para Docker healthcheck
    app.include_router(health_router)
    # Endpoints protegidos
    app.include_router(structure_router, dependencies=deps)
    app.include_router(summarize_router, dependencies=deps)
    app.include_router(finalize_router, dependencies=deps)
    return app


app = make_app()
```

- [ ] **Step 2: Smoke test boot**

```bash
cd services/sda-indexer
# en otra terminal: supabase start && supabase db push
SDA_DB_DSN="postgresql://postgres:postgres@localhost:54322/postgres" \
SDA_SUPABASE_URL="http://127.0.0.1:54321" \
SDA_SUPABASE_SERVICE_KEY="<copiar de 'supabase status'>" \
SDA_DEEPSEEK_API_KEY="<tu key>" \
SDA_SRV_IA_01_SECRET="test-secret-$(openssl rand -hex 16)" \
  uv run uvicorn sda_indexer.main:app --host 0.0.0.0 --port 8000 &

curl -fsS http://localhost:8000/health
# Expected: {"service":"sda-indexer","version":"0.1.0","db":true,"llm":true,"status":"ok"}

kill %1
```

- [ ] **Step 3: Commit**

```bash
git add src/sda_indexer/main.py
git commit -m "feat(indexer): main.py — FastAPI app + lifespan + wiring

Lifespan boota DB pool, settings client + sync, LLM client, supabase,
y compila los 3 LangGraph graphs. Health sin auth, endpoints con bearer.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase K — End-to-end integration test (Task 34)

### Task 34: tests/integration/test_end_to_end.py

**Files:**
- Create: `services/sda-indexer/tests/integration/test_end_to_end.py`

- [ ] **Step 1: Write E2E test**

Create `services/sda-indexer/tests/integration/test_end_to_end.py`:
```python
"""E2E: subir un .md a Storage local → esperar status='ready' → verificar tree_nodes.

Requiere:
- Supabase local corriendo (supabase start)
- Migraciones aplicadas (supabase db push)
- srv-ia-01 corriendo en :8000 con env vars correctas
- Vault tiene 'srv_ia_01_secret' con el mismo token que el server usa
"""

import os
import asyncio
import time
import pytest
import asyncpg
from supabase import create_client

pytestmark = pytest.mark.asyncio


@pytest.fixture
async def pool():
    dsn = os.getenv("SDA_DB_DSN", "postgresql://postgres:postgres@localhost:54322/postgres")
    p = await asyncpg.create_pool(dsn, min_size=1, max_size=3)
    yield p
    async with p.acquire() as conn:
        await conn.execute("delete from documents where source_path like 'docs/test-e2e-%';")
    await p.close()


@pytest.fixture
def supabase():
    url = os.getenv("SDA_SUPABASE_URL", "http://127.0.0.1:54321")
    key = os.getenv("SDA_SUPABASE_SERVICE_KEY", "")
    return create_client(url, key)


async def test_e2e_md_to_ready(pool, supabase, tmp_path):
    md = (
        "# Documento E2E\n\nDescripción.\n\n"
        "## Sección Uno\n\nContenido suficientemente largo para que el "
        "summarizer tenga algo concreto que resumir y generar texto.\n\n"
        "## Sección Dos\n\nMás contenido en otra sección con detalles.\n"
    )
    path = "docs/test-e2e-1.md"
    local = tmp_path / "doc.md"
    local.write_bytes(md.encode())
    supabase.storage.from_("docs").upload(path, str(local), {"upsert": "true"})

    # El trigger on_storage_doc_uploaded crea el doc; pg_cron cada 10s
    # dispatchea a /index/structure → triggers crean rows tree_nodes →
    # pgmq encola summarize por cada nodo → finalize cuando todos ready.
    timeout = 120
    start = time.time()
    final_status = None
    while time.time() - start < timeout:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "select status, node_count from documents where source_path=$1",
                path,
            )
        if row and row["status"] == "ready":
            final_status = row["status"]
            assert row["node_count"] >= 3
            break
        await asyncio.sleep(2)

    assert final_status == "ready", f"timeout: doc didn't reach ready in {timeout}s"

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "select status, summary from tree_nodes where document_id="
            "(select id from documents where source_path=$1)",
            path,
        )
    assert all(r["status"] == "ready" for r in rows)
    assert all(r["summary"] for r in rows)


async def test_e2e_idempotent_same_sha(pool, supabase, tmp_path):
    """Subir el mismo contenido bajo dos paths distintos → uno se vuelve duplicate."""
    md = "# Idempotency test\n\nContenido fijo.\n"
    local = tmp_path / "dup.md"
    local.write_bytes(md.encode())

    p1 = "docs/test-e2e-orig.md"
    p2 = "docs/test-e2e-dup.md"
    supabase.storage.from_("docs").upload(p1, str(local), {"upsert": "true"})
    await asyncio.sleep(15)  # tiempo para que structure corra y reconcile sha
    supabase.storage.from_("docs").upload(p2, str(local), {"upsert": "true"})

    # Esperar suficiente para que ambos pasen por structure
    await asyncio.sleep(30)

    async with pool.acquire() as conn:
        statuses = await conn.fetch(
            "select status from documents where source_path in ($1, $2)",
            p1, p2,
        )
    statuses_set = {r["status"] for r in statuses}
    assert "ready" in statuses_set
    assert "duplicate" in statuses_set
```

- [ ] **Step 2: Setup local Supabase + Vault**

```bash
cd /Users/enzo/sda.framework/sda.framework
supabase start
supabase db push

# Vault secret para el bearer (mismo que srv-ia-01 espera)
TOKEN=$(openssl rand -hex 32)
supabase db remote query "select vault.create_secret('$TOKEN', 'srv_ia_01_secret');"
echo "SDA_SRV_IA_01_SECRET=$TOKEN" > services/sda-indexer/.env.local

# Levantar srv-ia-01
cd services/sda-indexer
docker compose up -d
sleep 5
curl -fsS http://localhost:8000/health
```

- [ ] **Step 3: Run E2E**

```bash
cd services/sda-indexer
uv run pytest tests/integration/test_end_to_end.py -v --tb=long
```
Expected: 2 passed.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/test_end_to_end.py
git commit -m "test(indexer): E2E — Storage upload → ready con tree_nodes summary

Cubre criterios D-0.1, D-0.2. Validación del loop completo.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase L — Deploy + verificación final (Tasks 35-38)

### Task 35: Deploy migrations a Supabase remote

- [ ] **Step 1: Verificar linked project**

```bash
cd /Users/enzo/sda.framework/sda.framework
cat supabase/.temp/project-ref     # debe ser anfawvxfepowsudlffnl
supabase status --linked
```

- [ ] **Step 2: Push migrations a remoto**

```bash
supabase db push --linked
```
Expected: las 8 migraciones (20260525000001..00008) se aplican sin error.

- [ ] **Step 3: Verify schemas remotos**

```bash
supabase db remote query "select tablename from pg_tables where schemaname='public' and tablename in ('documents','tree_nodes','indexing_jobs','llm_calls','quality_metrics','rate_limits','node_questions','node_entities','node_relations','node_typed_fields','node_embeddings','app_settings','app_settings_history') order by tablename;"
```
Expected: 13 tablas.

- [ ] **Step 4: Verify cron jobs**

```bash
supabase db remote query "select jobname from cron.job order by jobname;"
```
Expected: 2 rows (drain-queues-10s, gc-langgraph-checkpoints).

- [ ] **Step 5: Commit del push log**

```bash
# Las migraciones ya están commiteadas. Sólo si hay cambios al supabase/.temp:
git status
```

---

### Task 36: Vault secrets en remoto

- [ ] **Step 1: Generar bearer compartido**

```bash
TOKEN=$(openssl rand -hex 32)
echo "$TOKEN" > /tmp/sda_bearer_$$.txt
```

- [ ] **Step 2: Crear Vault secrets en Supabase remoto**

```bash
supabase db remote query "
  select vault.create_secret('$TOKEN', 'srv_ia_01_secret');
  select vault.create_secret('YOUR_DEEPSEEK_KEY', 'deepseek_api_key');
"
# Reemplazar YOUR_DEEPSEEK_KEY con tu key real.
```

- [ ] **Step 3: Verify secrets**

```bash
supabase db remote query "select name from vault.secrets where name in ('srv_ia_01_secret','deepseek_api_key');"
```
Expected: 2 rows.

- [ ] **Step 4: Setear app.srv_ia_01_url en remoto**

```bash
# Necesitamos que pg_cron sepa dónde está srv-ia-01 público
supabase db remote query "alter database postgres set app.srv_ia_01_url = 'https://srv-ia-01.tu-dominio.com';"
# Reemplazar con la URL pública real de srv-ia-01.
```

- [ ] **Step 5: Guardar el bearer en pass manager + .env de srv-ia-01**

```bash
cat /tmp/sda_bearer_$$.txt
# Copiarlo manualmente al pass manager.
# En srv-ia-01: setear SDA_SRV_IA_01_SECRET=<token> en /etc/sda-indexer.env
shred -u /tmp/sda_bearer_$$.txt
```

---

### Task 37: Deploy srv-ia-01 a producción

- [ ] **Step 1: Build + push image**

```bash
cd services/sda-indexer
docker build -t registry/sda-indexer:0.1.0 .
docker push registry/sda-indexer:0.1.0
```

- [ ] **Step 2: SSH a srv-ia-01, pull + correr**

```bash
ssh srv-ia-01
cd /opt/sda-indexer
docker pull registry/sda-indexer:0.1.0
docker compose down
docker compose up -d
sleep 10
curl -fsS http://localhost:8000/health
```
Expected: `{"db":true, ..., "status":"ok"}`.

- [ ] **Step 3: Verificar logs**

```bash
docker compose logs --tail 50 sda-indexer
```
Expected: ver "startup", "db.pool.started", "settings.sync.complete", "settings.listener.started", sin errores.

- [ ] **Step 4: Verificar reachability desde Supabase**

Desde el Supabase SQL editor:
```sql
select net.http_get(
  url := 'https://srv-ia-01.tu-dominio.com/health',
  timeout_milliseconds := 5000
);
-- Esperar 1-2 segundos
select * from net._http_response order by id desc limit 1;
```
Expected: status_code = 200, content JSON con `"status":"ok"`.

---

### Task 38: Verify all D-0.x criteria (release gate)

- [ ] **D-0.1 — Markdown end-to-end**

```bash
# Subir tiny.md a Storage remoto vía supabase CLI o JS
supabase storage cp services/sda-indexer/tests/fixtures/tiny.md \
  ss:///docs/release-test-tiny.md --linked

# Esperar máx 30s
sleep 35
supabase db remote query "
  select d.status, d.node_count,
         (select count(*) from tree_nodes where document_id=d.id and summary is not null) as with_summaries
    from documents d where source_path='docs/release-test-tiny.md';
"
```
Expected: status='ready', node_count >= 3, with_summaries == node_count.

- [ ] **D-0.2 — Idempotencia sha256**

```bash
supabase storage cp services/sda-indexer/tests/fixtures/tiny.md \
  ss:///docs/release-test-tiny-dup.md --linked
sleep 30
supabase db remote query "
  select count(*) from documents
   where source_path in ('docs/release-test-tiny.md','docs/release-test-tiny-dup.md');
  select source_path, status from documents
   where source_path in ('docs/release-test-tiny.md','docs/release-test-tiny-dup.md');
"
```
Expected: 2 rows. Uno con status='ready', otro con status='duplicate'.

- [ ] **D-0.3 — Resiliencia**

```bash
# Subir un md mediano, mientras el indexer empieza, kill y restart
supabase storage cp services/sda-indexer/tests/fixtures/nested.md \
  ss:///docs/release-test-resil.md --linked

# Inmediatamente (<10s después):
ssh srv-ia-01 'docker compose restart sda-indexer'

# Esperar 60s
sleep 60
supabase db remote query "select status from documents where source_path='docs/release-test-resil.md';"
```
Expected: status='ready' (pgmq reentregó después del restart).

- [ ] **D-0.4 — LangGraph checkpoints**

```bash
supabase db remote query "
  select count(*) from langgraph_checkpoints.checkpoints;
  select thread_id, ts from langgraph_checkpoints.checkpoints
   order by ts desc limit 5;
"
```
Expected: count > 0; rows recientes.

- [ ] **D-0.5 — Tests verdes + coverage**

```bash
cd services/sda-indexer
uv run pytest --cov=src/sda_indexer/pipeline --cov-report=term-missing
```
Expected: 100% passed; coverage >80% en `pipeline/`.

- [ ] **D-0.6 — Hot-reload de setting**

```bash
# Verificar modelo actual
supabase db remote query "
  select value from app_settings
   where key='llm.model.summarize' and scope_type='global' and scope_value is null;
"
# Cambiar
supabase db remote query "
  update app_settings
     set value = '\"deepseek/deepseek-chat-v2\"'::jsonb,
         updated_by = 'release-test'
   where key='llm.model.summarize' and scope_type='global' and scope_value is null;
"
# Verificar logs del indexer
ssh srv-ia-01 'docker compose logs --tail 20 sda-indexer | grep settings'
```
Expected: log line `settings.invalidated key=llm.model.summarize count=N`.

- [ ] **Step 5: Cleanup test docs**

```bash
supabase db remote query "
  delete from documents where source_path like 'docs/release-test-%';
  -- Volver el setting al default
  update app_settings
     set value = '\"deepseek/deepseek-chat\"'::jsonb,
         updated_by = 'release-cleanup'
   where key='llm.model.summarize' and scope_type='global';
"
```

- [ ] **Step 6: Tag release**

```bash
git tag wave-0-foundation-complete
git push origin wave-0-foundation-complete
```

---

## Self-Review

**1. Spec coverage:**

| Spec section | Tasks que lo implementan |
|---|---|
| §1 Arquitectura + topología | Tasks 1, 10, 33 (compute layout) + 2-9 (Supabase layout) |
| §2 Tablas core | Tasks 3, 4 |
| §2 app_settings | Tasks 5, 12-15 |
| §2 pgmq queues | Task 6 |
| §2 Triggers | Task 7 |
| §2 pg_cron + dispatcher | Task 8 |
| §2 Storage bucket | Task 9 |
| §3.1 Endpoints FastAPI | Tasks 28-32 |
| §3.2 structure_workflow | Task 26 (Wave 0 MD only) |
| §3.3 summarize_workflow | Task 25 |
| §3.4 Cache-friendly prompts | Task 24 |
| §3.5 Módulos Python | Task 1 |
| §4 Wave 0 deliverables | Phases A-K |
| §5 Error handling capa 1 (tenacity) | Task 20 |
| §5 Error handling capa 3 (pgmq visibility) | Task 8 + Task 34 (D-0.3) |
| §5.5 Configurabilidad | Tasks 5, 12-15 |
| §6 Out of scope | Documentado al header (sin retrieval, sin auth, sin DLQ, sin OTel — Wave 2) |

**Gaps detectados (no son críticos para Wave 0):**

- llm_calls tabla existe en Task 3 pero el plan no inserta filas en ella desde el workflow de summarize. Eso es OK para Wave 0 porque las métricas de costos son Wave 2. Anotado para Wave 2.
- finalize_workflow tiene un `path_used="full"` hardcoded en Wave 0 — correcto, Wave 1 inyecta path real.
- Trigger `on_tree_node_inserted` encola `q_summarize_node` — pero el pg_cron drain tickea cada 10s. Si un doc tiene 50 nodos, todos se procesan en ondas de 10s. Aceptable para Wave 0; Wave 2 ajusta intervalos.

**2. Placeholder scan:** búsqueda manual de "TBD", "TODO", "fill in" — no encontrados. Algunos `<bootstrapped-from-prompts/...>` en registry son intencionalmente literales (el sync los detecta y los carga del FS al boot). Documentado.

**3. Type consistency:**

- `FlatHeader` y `TreeNode` consistentes entre Tasks 21 y 22.
- `LLMResult` consistente entre Tasks 19, 23, 25.
- `State` TypedDicts en workflows usan `total=False` consistentemente.
- `node_id_str` vs `node_id` (UUID): el primero es la cadena estilo "n_1_2", el segundo el UUID de DB. Usado correctamente.

**4. Ambiguity check:**

- "kill srv-ia-01 mid-summarize" en D-0.3 podría interpretarse como SIGKILL vs docker restart. Aclarado: usar `docker compose restart` en Task 38.
- `path_used='fast'|'full'` en Wave 0 sólo MD → siempre 'full'. Wave 1 introduce 'fast'. Documentado.

No issues bloqueantes.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-25-ingest-index-wave-0.md`.

**Dos opciones de ejecución:**

**1. Subagent-Driven (recomendado)** — dispatcheo un subagent fresh por task, reviso entre tasks, iteración rápida.

**2. Inline Execution** — ejecutar tasks en esta sesión con executing-plans, batch con checkpoints.

¿Cuál preferís?

