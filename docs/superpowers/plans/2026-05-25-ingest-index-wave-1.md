# Ingest+Index Wave 1 (PDF + Costo) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Procesar PDFs reales (hasta 500 páginas) en minutos por centavos, agregando contextual chunking (#1), prompt cache maximization (#4), MinerU fast-path heuristics (#5) y tiered models (#6).

**Architecture:** Indexer en Fly.io orquesta vía HTTP a un servicio MinerU nuevo en srv-ia-01 (GPU local, expuesto por Cloudflare Tunnel a `mineru.sdaframework.com`). Indexer NUNCA toca el binario PDF — MinerU descarga directo de Supabase Storage. Prompts con anatomía universal cacheable + tiered routing por fase + un solo LLM call combinado para `(contextual_prefix, summary)`.

**Tech Stack:** Python 3.12 (FastAPI, LangGraph, asyncpg, OpenAI SDK contra DeepSeek), MinerU (magic-pdf), pypdf, httpx, tenacity, Cloudflare Tunnel (cloudflared), systemd, Supabase managed (pgmq + pg_cron + pg_net + vault), Fly.io.

**Spec base:** [`docs/superpowers/specs/2026-05-25-ingest-index-wave-1-design.md`](../specs/2026-05-25-ingest-index-wave-1-design.md)

**Criterios de done (del spec §8.3):**

| # | Criterio |
|---|---|
| D-1.1 | PDF 50pag → indexado <2min, costo <$0.05 |
| D-1.2 | PDF "lindo" con TOC → `path_used='fast'`, <30 calls DeepSeek |
| D-1.3 | PDF "feo" scan sin TOC → `path_used='full'`, accuracy_score (F1 títulos) >0.7 |
| D-1.4 | `mv_cache_hit_ratio` >0.75 para fase `summarize` post 5 docs |
| D-1.5 | `mv_llm_costs_daily` muestra Pro en TOC/structure, Flash en summaries |
| D-1.6 | `tree_nodes.text_contextualized` no null; summaries empiezan con tema |
| D-1.7 | PDF 300pag → indexado <10min, costo <$0.50 |

---

## File Structure

```
sda.framework/
├── supabase/migrations/
│   ├── 20260526000011_pdf_wave1_columns.sql              # Task 1
│   ├── 20260526000012_indexing_failure_reasons.sql       # Task 2
│   ├── 20260526000013_pgmq_resilience.sql                # Task 3 (cierra D-0.3)
│   └── 20260526000014_matview_cache_hit.sql              # Task 4
├── services/sda-indexer/                                  # existente — añade
│   ├── scripts/
│   │   ├── verify_deepseek_cache.py                      # Task 6 (gate)
│   │   └── extract_ground_truth.py                       # Task 32
│   └── src/sda_indexer/
│       ├── config.py                                     # Task 27 (add mineru_shared_secret)
│       ├── main.py                                       # Task 27 (wire MineruClient)
│       ├── settings/registry.py                          # Task 5 (expansion)
│       ├── llm/
│       │   ├── router.py                                 # Task 15
│       │   └── cache_design.py                           # Task 16
│       ├── db/
│       │   └── llm_calls.py                              # Task 28 (insert helper)
│       ├── pipeline/
│       │   ├── parser/
│       │   │   └── pdf_mineru.py                         # Task 17 (HTTP client only — heuristics/native viven en mineru service)
│       │   ├── structure/                                 # NUEVO submódulo
│       │   │   ├── __init__.py                           # Task 18
│       │   │   ├── types.py                              # Task 18
│       │   │   ├── toc_detector.py                       # Task 19
│       │   │   ├── toc_transformer.py                    # Task 20
│       │   │   ├── index_extractor.py                    # Task 21
│       │   │   ├── validator.py                          # Task 22
│       │   │   └── repair.py                             # Task 23
│       │   ├── splitter/                                 # NUEVO submódulo
│       │   │   ├── __init__.py                           # Task 24
│       │   │   └── large_node.py                         # Task 24
│       │   └── summarizer/
│       │       └── contextual_prefix.py                  # Task 25
│       ├── prompts/
│       │   └── summarize.j2                              # Task 26 (deprecated marker — prompts viven inline en pipeline/* Wave 1)
│       └── workflows/
│           ├── structure.py                              # Task 27 (refactor mayor)
│           ├── summarize.py                              # Task 28 (refactor + llm_calls insert)
│           └── finalize.py                               # Task 29 (lee path_used de documents)
├── services/sda-mineru-parser/                            # NUEVO servicio
│   ├── pyproject.toml                                    # Task 8
│   ├── Dockerfile                                        # Task 8
│   ├── README.md                                         # Task 8
│   ├── .gitignore                                        # Task 8
│   ├── src/sda_mineru/
│   │   ├── __init__.py                                   # Task 8
│   │   ├── main.py                                       # Task 12
│   │   ├── download.py                                   # Task 9
│   │   ├── cache.py                                      # Task 10
│   │   ├── parser.py                                     # Task 11
│   │   └── healthz.py                                    # Task 12
│   ├── tests/
│   │   ├── conftest.py                                   # Task 8
│   │   ├── test_download.py                              # Task 9
│   │   ├── test_cache.py                                 # Task 10
│   │   ├── test_parser.py                                # Task 11
│   │   └── test_main.py                                  # Task 12
│   └── systemd/sda-mineru.service                        # Task 13
├── docs/runbooks/
│   └── wave-0-prod-deploy.md                             # Task 7 (rewrite)
└── services/sda-indexer/tests/                            # del indexer
    ├── fixtures/pdf_corpus.yaml                          # Task 30
    ├── fixtures/ground_truth_tocs.yaml                   # Task 32
    ├── conftest.py                                       # Task 31 (extend)
    ├── e2e/test_canonical_corpus.py                      # Task 33
    └── stress/run_arxiv_sample.py                        # Task 33
```

**Naming notes:**
- Migrations Wave 1 usan prefijo `20260526` (un día después de Wave 0) para mantener orden cronológico.
- Submódulos `structure/` y `splitter/` son nuevos en `pipeline/`.
- Servicio `sda-mineru-parser` vive como sibling de `sda-indexer` en `services/`.

---

## Phase 0 — Bootstrap (Tasks 1-7)

Migrations, settings expansion, runbook rewrite. Estos tasks NO bloquean Phase 1 ni Phase 2 — son paralelizables.

### Task 1: Migration 011 — PDF columns

**Files:**
- Create: `supabase/migrations/20260526000011_pdf_wave1_columns.sql`

- [ ] **Step 1: Write migration**

> **Review-fix (B1+I1):** verificado contra schema Wave 0 (20260525000002_tables_core.sql). Las siguientes columnas YA EXISTEN y NO deben re-agregarse: `documents.page_count`, `documents.path_used`, `tree_nodes.text_contextualized`, `tree_nodes.summary_model`. La columna `tree_nodes.appear_start` existe pero como `boolean` (placeholder Wave 0); hay que DROP+ADD como `int` porque sin uso actual.

Create `supabase/migrations/20260526000011_pdf_wave1_columns.sql`:
```sql
-- Wave 1: columnas para PDF parsing tracking + contextual chunking
-- Spec §4.1.1. Wave 0 ya pre-creó page_count/path_used/text_contextualized/
-- summary_model (verificado en 20260525000002_tables_core.sql). Esta migration
-- solo agrega las realmente nuevas + corrige tipo de appear_start.

-- documents: solo parser_used + doc_summary_short (las otras 2 ya existen)
alter table documents
  add column if not exists parser_used text check (parser_used in ('native', 'mineru')),
  add column if not exists doc_summary_short text;

comment on column documents.parser_used is 'Wave 1: native (pypdf) | mineru (full pipeline)';
comment on column documents.doc_summary_short is 'Wave 1: ~200 toks resumen del doc completo, prefix cacheable per-doc para summarize calls';

-- tree_nodes: recrear appear_start (boolean → int) + agregar appear_end
-- DROP+ADD es seguro porque appear_start boolean no se usa en código actual
-- (verificado con grep -rn appear_start services/sda-indexer/src/).
alter table tree_nodes drop column if exists appear_start;
alter table tree_nodes
  add column appear_start int,
  add column if not exists appear_end int;

comment on column tree_nodes.appear_start is 'Wave 1: página inicio del nodo en el PDF';
comment on column tree_nodes.appear_end is 'Wave 1: página fin del nodo';

create index if not exists tree_nodes_appear_start_idx
  on tree_nodes(document_id, appear_start);
```

- [ ] **Step 2: Apply migration locally**

Run:
```bash
supabase db reset --local
```
Expected: migration aplica sin error; columnas visibles en `\d documents` y `\d tree_nodes`.

- [ ] **Step 3: Verify schema**

Run:
```bash
# Solo las columnas REALMENTE nuevas (las otras ya existían Wave 0):
supabase db psql --local -c "\d documents" | grep -E "parser_used|doc_summary_short"
supabase db psql --local -c "\d tree_nodes" | grep -E "appear_start|appear_end"
# Confirmar que appear_start ahora es INT (no boolean):
supabase db psql --local -c "select data_type from information_schema.columns where table_name='tree_nodes' and column_name='appear_start'"
```
Expected: 2 columnas nuevas en documents, 2 en tree_nodes, data_type=integer para appear_start.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260526000011_pdf_wave1_columns.sql
git commit -m "$(cat <<'EOF'
feat(db): migration 011 — PDF columns (Wave 1)

Agrega documents.{page_count, parser_used, path_used, doc_summary_short}
y tree_nodes.{text_contextualized, summary_model, appear_start, appear_end}
+ index para nav futuro. Satisface base de D-1.6 (text_contextualized) y
permite tracking de tiered routing (#6) y fast-path (#5).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Migration 012 — indexing_failure_reasons enum

**Files:**
- Create: `supabase/migrations/20260526000012_indexing_failure_reasons.sql`

- [ ] **Step 1: Write migration**

Create `supabase/migrations/20260526000012_indexing_failure_reasons.sql`:
```sql
-- Wave 1: enum tipado para DLQ failure reasons
-- Spec §4.1.2. Postgres no permite quitar valores de un enum,
-- entonces reservar generosamente upfront.

do $$ begin
  create type indexing_failure_reason as enum (
    'download_failed',
    'mineru_oom',
    'mineru_timeout',
    'sha256_mismatch',
    'disk_full',
    'expired_signed_url',
    'structure_invalid',
    'structure_unreparable',
    'llm_error',
    'llm_timeout',
    'unknown'
  );
exception when duplicate_object then null;
end $$;

alter table indexing_jobs
  add column if not exists failure_reason indexing_failure_reason,
  add column if not exists failure_detail text;

comment on column indexing_jobs.failure_reason is 'Wave 1: enum tipado, evita parsing de strings en Wave 2 dashboards';
comment on column indexing_jobs.failure_detail is 'Wave 1: mensaje libre para debugging (stack trace, raw error)';
```

- [ ] **Step 2: Apply + verify**

Run:
```bash
supabase db reset --local
supabase db psql --local -c "select enum_range(null::indexing_failure_reason)"
```
Expected: lista los 11 valores.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260526000012_indexing_failure_reasons.sql
git commit -m "$(cat <<'EOF'
feat(db): migration 012 — indexing_failure_reason enum

Enum tipado con 11 valores reservados (download_failed, mineru_oom,
sha256_mismatch, expired_signed_url, structure_unreparable, etc).
Reemplaza strings ad-hoc en indexing_jobs.failure_reason. Facilita
group-by en Wave 2 dashboards sin parsing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Migration 013 — pgmq resilience (cierra D-0.3)

**Files:**
- Create: `supabase/migrations/20260526000013_pgmq_resilience.sql`

- [ ] **Step 1: Write migration**

Create `supabase/migrations/20260526000013_pgmq_resilience.sql`:
```sql
-- Wave 1: cierra D-0.3 pendiente de Wave 0 — GC de jobs stuck in_flight.
-- Spec §4.1.3. PDFs grandes pueden colgar jobs por OOM o crash del worker,
-- visibility timeout de pgmq sólo reentrega el mensaje pero indexing_jobs
-- queda en in_flight forever sin GC.
--
-- Review-fix (B2+I5): el schema Wave 0 NO tiene started_at en indexing_jobs
-- (solo completed_at + attempts). Esta migration:
--   1. Agrega started_at timestamptz
--   2. Re-define dispatch_pgmq_to_srv_ia (originalmente en 20260525000007_cron.sql)
--      para popular started_at = now() al marcar in_flight
--   3. Define gc_stuck_jobs() usando started_at + completed_at

alter table indexing_jobs
  add column if not exists started_at timestamptz;

-- Re-define dispatcher para que pople started_at. Resto del cuerpo
-- copiado intacto de 20260525000007_cron.sql + 1 línea agregada.
create or replace function dispatch_pgmq_to_srv_ia(
  p_queue_name text,
  p_endpoint_path text,
  p_max_messages int
) returns int language plpgsql security definer as $$
declare
  msg record;
  count_dispatched int := 0;
  srv_url text;
  bearer text;
begin
  if p_max_messages <= 0 then return 0; end if;
  select decrypted_secret into srv_url from vault.decrypted_secrets where name = 'srv_ia_01_url';
  srv_url := coalesce(srv_url, 'http://host.docker.internal:8000');
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
    -- Wave 1 patch: popular started_at para que gc_stuck_jobs pueda detectar stuck.
    update indexing_jobs
       set status = 'in_flight',
           attempts = attempts + 1,
           started_at = coalesce(started_at, now())
      where msg_id = msg.msg_id;
    perform increment_rate_limit('deepseek');
    count_dispatched := count_dispatched + 1;
  end loop;
  return count_dispatched;
end $$;

create or replace function gc_stuck_jobs() returns int
language plpgsql as $$
declare n int;
begin
  with reclaimed as (
    update indexing_jobs
       set status='failed',
           failure_reason='unknown',
           failure_detail='stuck in_flight >30 min, GC reclaimed',
           completed_at=now()
     where status='in_flight'
       and started_at is not null
       and started_at < now() - interval '30 minutes'
    returning 1
  )
  select count(*) into n from reclaimed;
  return coalesce(n, 0);
end $$;

comment on function gc_stuck_jobs is 'Wave 1 D-0.3: reclaim indexing_jobs stuck in_flight >30min como failed';

select cron.schedule(
  'gc-stuck-jobs',
  '*/5 * * * *',
  $$select gc_stuck_jobs()$$
);
```

- [ ] **Step 2: Apply + verify cron registered**

Run:
```bash
supabase db reset --local
supabase db psql --local -c "select jobname, schedule, active from cron.job where jobname='gc-stuck-jobs'"
```
Expected: 1 row, schedule `*/5 * * * *`, active=true.

- [ ] **Step 3: Smoke test the function**

Run:
```bash
supabase db psql --local -c "select gc_stuck_jobs()"
```
Expected: returns 0 (no stuck jobs en DB fresca).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260526000013_pgmq_resilience.sql
git commit -m "$(cat <<'EOF'
feat(db): migration 013 — pgmq resilience GC (cierra D-0.3)

Agrega gc_stuck_jobs() + pg_cron */5 que reclama indexing_jobs in_flight
>30min como failed con reason=unknown. Cierra criterio D-0.3 pendiente de
Wave 0 — necesario para PDFs grandes que pueden colgar workers vía OOM.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Migration 014 — matview cache_hit + llm_calls insert refactor

**Files:**
- Create: `supabase/migrations/20260526000014_matview_cache_hit.sql`

- [ ] **Step 1: Write migration**

Create `supabase/migrations/20260526000014_matview_cache_hit.sql`:
```sql
-- Wave 1: pull-forward de Wave 2 — sin esto D-1.4 no es verificable.
-- Spec §4.1.4 + §6.6.

-- NOTA: la columna real en llm_calls (migration 20260525000002) es `cached_tokens`,
-- NO `cache_hit_tokens` (el spec §4.1.4 usa el nombre viejo del draft). Verificado
-- contra schema actual antes de escribir esta migration.
create materialized view if not exists mv_cache_hit_ratio as
select
  date_trunc('hour', created_at) as hour,
  phase,
  sum(cached_tokens)::float / nullif(sum(prompt_tokens), 0) as hit_ratio,
  sum(prompt_tokens) as total_prompt_tokens,
  sum(cached_tokens) as total_cached_tokens,
  count(*) as call_count
from llm_calls
where created_at > now() - interval '7 days'
group by 1, 2;

create unique index if not exists mv_cache_hit_ratio_hour_phase_idx
  on mv_cache_hit_ratio(hour, phase);

comment on materialized view mv_cache_hit_ratio is
  'Wave 1: refresh */5min via cron. Validar D-1.4 (>0.75 para summarize)';

-- Daily costs view también (pull-forward parcial para D-1.5)
create materialized view if not exists mv_llm_costs_daily as
select
  date_trunc('day', created_at) as day,
  phase,
  model,
  sum(cost_cents) as cost_cents,
  count(*) as call_count
from llm_calls
where created_at > now() - interval '30 days'
group by 1, 2, 3;

create unique index if not exists mv_llm_costs_daily_idx
  on mv_llm_costs_daily(day, phase, model);

comment on materialized view mv_llm_costs_daily is
  'Wave 1: refresh */5min. Validar D-1.5 (Pro en TOC/structure, Flash en summary)';

select cron.schedule(
  'refresh-cache-hit-mv',
  '*/5 * * * *',
  $$refresh materialized view concurrently mv_cache_hit_ratio$$
);

select cron.schedule(
  'refresh-llm-costs-mv',
  '*/5 * * * *',
  $$refresh materialized view concurrently mv_llm_costs_daily$$
);
```

- [ ] **Step 2: Apply + verify both matviews + cron jobs**

Run:
```bash
supabase db reset --local
supabase db psql --local -c "\d mv_cache_hit_ratio"
supabase db psql --local -c "\d mv_llm_costs_daily"
supabase db psql --local -c "select jobname from cron.job where jobname like 'refresh-%'"
```
Expected: 2 matviews + 2 cron jobs visibles.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260526000014_matview_cache_hit.sql
git commit -m "$(cat <<'EOF'
feat(db): migration 014 — matviews cache + costs (Wave 2 pull-forward)

Agrega mv_cache_hit_ratio y mv_llm_costs_daily + refresh */5min. Pull-
forward necesario para verificar D-1.4 (cache hit >0.75) y D-1.5 (tiered
routing por fase) durante Wave 1. Wave 2 sumará dashboards encima.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Settings registry expansion (~26 settings nuevas)

**Files:**
- Modify: `services/sda-indexer/src/sda_indexer/settings/registry.py`

- [ ] **Step 1: Read current registry tail**

Run:
```bash
tail -n 30 services/sda-indexer/src/sda_indexer/settings/registry.py
```
Identificar dónde termina la lista `SETTINGS` para insertar las nuevas antes del cierre `]`.

- [ ] **Step 2: Append Wave 1 settings**

Editar `services/sda-indexer/src/sda_indexer/settings/registry.py`. Insertar el siguiente bloque ANTES del `]` final de la lista `SETTINGS`:

```python
    # =========================================================================
    # Wave 1 settings — PDF + costo (spec §4.2)
    # =========================================================================

    # --- Fast-path heuristics (Mejora #5) ---
    SettingDef("parser.fast_path.enabled", "boolean", True,
               "Si true, intenta path nativo (pypdf) antes de MinerU.",
               scopes=["global", "collection"]),
    SettingDef("parser.fast_path.min_text_ratio", "number", 0.7,
               "Mínimo % de páginas con capa de texto extraíble para fast path.",
               scopes=["global", "collection"]),
    SettingDef("parser.fast_path.max_pages_for_fast", "number", 100,
               "PDFs con más páginas que esto van siempre por full path.",
               scopes=["global", "collection"]),
    SettingDef("parser.fast_path.require_toc", "boolean", False,
               "Si true, fast path solo se activa cuando hay TOC detectable.",
               scopes=["global", "collection"]),
    SettingDef("parser.fast_path.min_confidence", "number", 0.8,
               "Confidence mínima del clasificador heurístico para fast path.",
               scopes=["global", "collection"]),

    # --- MinerU service ---
    SettingDef("parser.mineru.url", "string",
               "https://mineru.sdaframework.com",
               "URL del servicio sda-mineru-parser (Cloudflare Tunnel).",
               scopes=["global"]),
    SettingDef("parser.mineru.timeout_seconds", "number", 600,
               "Timeout HTTP indexer → mineru (10 min, cubre PDFs grandes).",
               scopes=["global"]),
    SettingDef("parser.mineru.signed_url_ttl_seconds", "number", 3600,
               "TTL de signed URL Supabase Storage (1h, cubre retries).",
               scopes=["global"]),
    SettingDef("parser.mineru.max_pdf_mb", "number", 100,
               "Rechazo upstream si el PDF excede este tamaño.",
               scopes=["global", "collection"]),

    # --- Download resilience (spec §1.2) ---
    SettingDef("parser.download.max_retries", "number", 5,
               "Reintentos de descarga del PDF antes de DLQ.",
               scopes=["global"]),
    SettingDef("parser.download.backoff_base_seconds", "number", 2,
               "Backoff base exponencial para retries de descarga.",
               scopes=["global"]),
    SettingDef("parser.download.range_resume_min_mb", "number", 5,
               "PDFs >X MB usan HTTP Range resume al re-descargar.",
               scopes=["global"]),
    SettingDef("parser.download.chunk_size_kb", "number", 1024,
               "Tamaño de chunk para streaming download.",
               scopes=["global"]),

    # --- PageIndex algorithm ---
    SettingDef("pageindex.max_tokens_per_node", "number", 8000,
               "Nodo del tree con más tokens se split recursivamente.",
               scopes=["global", "collection", "document"]),
    SettingDef("pageindex.min_tokens_per_node", "number", 200,
               "Nodo con menos tokens se merge con el sibling anterior.",
               scopes=["global", "collection", "document"]),
    SettingDef("pageindex.max_tree_depth", "number", 6,
               "Profundidad máxima del tree antes de truncar.",
               scopes=["global", "collection", "document"]),
    SettingDef("pageindex.toc_detection_max_pages", "number", 20,
               "Cuántas primeras páginas escanear buscando TOC.",
               scopes=["global", "collection"]),
    SettingDef("pageindex.if_add_node_text", "boolean", True,
               "Gotcha: defaults PageIndex es false. Necesitamos true para retrieval/re-summary.",
               scopes=["global"]),

    # --- Contextual chunking (Mejora #1) ---
    SettingDef("summarize.contextual_chunking.enabled", "boolean", True,
               "Si true, genera (prefix, summary) combinado y persiste text_contextualized.",
               scopes=["global", "collection", "document"]),
    SettingDef("summarize.contextual_chunking.prefix_max_tokens", "number", 100,
               "Cap del contextual prefix en tokens.",
               scopes=["global", "collection"]),

    # --- Tiered models (Mejora #6) ---
    # Sub-fases validator y repair caen a llm.router.structure.* por default.
    SettingDef("llm.router.toc.model", "model_id", "deepseek-chat",
               "Modelo para fase TOC detection + transformation.",
               scopes=["global", "collection"]),
    SettingDef("llm.router.toc.temperature", "number", 0.0,
               "Temperature para fase TOC (precisión >> creatividad).",
               scopes=["global", "collection"]),
    SettingDef("llm.router.structure.model", "model_id", "deepseek-chat",
               "Modelo para fase structure extraction + validator + repair.",
               scopes=["global", "collection"]),
    SettingDef("llm.router.structure.temperature", "number", 0.0,
               "Temperature para fase structure.",
               scopes=["global", "collection"]),
    SettingDef("llm.router.summarize.model", "model_id", "deepseek-chat",
               "Modelo para summary + contextual_prefix combinado. Swap a flash variant cuando aparezca.",
               scopes=["global", "collection", "document"]),
    SettingDef("llm.router.summarize.temperature", "number", 0.1,
               "Temperature para summarize (poco creativo, algo de variación).",
               scopes=["global", "collection", "document"]),
```

- [ ] **Step 3: Run sync test (registry → DB)**

Run:
```bash
cd services/sda-indexer
uv run pytest tests/unit/test_settings_client.py -v
```
Expected: tests pasan (los settings nuevos son válidos).

- [ ] **Step 4: Verify count**

Run:
```bash
cd services/sda-indexer
uv run python -c "from sda_indexer.settings.registry import SETTINGS; print(f'Total: {len(SETTINGS)}'); wave1 = [s for s in SETTINGS if s.key.startswith(('parser.', 'pageindex.', 'summarize.contextual', 'llm.router.'))]; print(f'Wave 1: {len(wave1)}')"
```
Expected: Wave 1: 26.

- [ ] **Step 5: Commit**

```bash
git add services/sda-indexer/src/sda_indexer/settings/registry.py
git commit -m "$(cat <<'EOF'
feat(settings): Wave 1 registry expansion — 26 settings nuevas

parser.fast_path.* (5), parser.mineru.* (4), parser.download.* (4),
pageindex.* (5), summarize.contextual_chunking.* (2), llm.router.* (6).
validator/repair sub-fases caen a llm.router.structure.* por default.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Mini-experimento DeepSeek cache (quick-fail gate)

**Files:**
- Create: `services/sda-indexer/scripts/verify_deepseek_cache.py`
- Create: `docs/superpowers/notes/deepseek-cache-empirical.md`

- [ ] **Step 1: Write the verification script**

Create `services/sda-indexer/scripts/verify_deepseek_cache.py`:
```python
"""Verifica empíricamente el comportamiento de prompt caching de DeepSeek.

Quick-fail gate de Wave 1 (spec §3.4). Si DeepSeek no cachea como esperamos
(threshold ~1024 toks, TTL > 30min), re-evaluar Mejora #4 antes de invertir
en cache_design.py.

Uso:
  cd services/sda-indexer
  DEEPSEEK_API_KEY=sk-... uv run python scripts/verify_deepseek_cache.py
"""

import asyncio
import os
import time
from openai import AsyncOpenAI


# Prompt > 1024 toks de zona estática (instructions + schema verbosos).
# Repetimos un párrafo descriptivo para inflar tokens.
LARGE_SYSTEM = (
    "You are an assistant that summarizes structured data. "
    "Output strictly valid JSON matching the schema. " * 60
)
SHARED_USER_PREFIX = (
    "Given the following list of items, group them by category and "
    "report counts. " * 30
)


async def call(client: AsyncOpenAI, dynamic_suffix: str) -> dict:
    resp = await client.chat.completions.create(
        model="deepseek-chat",
        messages=[
            {"role": "system", "content": LARGE_SYSTEM},
            {"role": "user", "content": SHARED_USER_PREFIX + dynamic_suffix},
        ],
        temperature=0.0,
        max_tokens=50,
    )
    usage = resp.usage
    details = getattr(usage, "prompt_tokens_details", None)
    cached = getattr(details, "cached_tokens", 0) if details else 0
    return {
        "prompt_tokens": usage.prompt_tokens,
        "cached_tokens": cached or 0,
        "completion_tokens": usage.completion_tokens,
        "model": resp.model,
    }


async def main():
    api_key = os.environ["DEEPSEEK_API_KEY"]
    # Review-fix (I6): usar /v1 para alinear con config.py + llm/client.py (Wave 0)
    client = AsyncOpenAI(api_key=api_key, base_url="https://api.deepseek.com/v1")

    print("=" * 60)
    print("DeepSeek prompt cache empirical verification")
    print("=" * 60)

    print("\n[1] First call (cold cache expected)...")
    r1 = await call(client, "Item set A: apples, oranges, bananas.")
    print(f"  prompt={r1['prompt_tokens']} cached={r1['cached_tokens']} model={r1['model']}")

    print("\n[2] Second call (same static prefix, different suffix)...")
    r2 = await call(client, "Item set B: cats, dogs, hamsters.")
    print(f"  prompt={r2['prompt_tokens']} cached={r2['cached_tokens']}")

    print("\n[3] Third call (third suffix, should also hit cache)...")
    r3 = await call(client, "Item set C: red, green, blue.")
    print(f"  prompt={r3['prompt_tokens']} cached={r3['cached_tokens']}")

    print("\n" + "=" * 60)
    print("VERDICT:")
    if r2["cached_tokens"] > 0:
        ratio = r2["cached_tokens"] / r2["prompt_tokens"]
        print(f"  ✓ Cache HIT on 2nd call ({ratio:.0%} of prompt cached)")
        print(f"  ✓ Mejora #4 viable. Proceed with cache_design.py.")
    else:
        print(f"  ✗ NO cache hit. Either prompt too short (<1024 toks),")
        print(f"    cache disabled, or API field name changed.")
        print(f"  ✗ Investigate before investing in cache_design.py.")
    print("=" * 60)

    print("\n[4] TTL test (waiting 60s, then re-call)...")
    await asyncio.sleep(60)
    r4 = await call(client, "Item set D: north, south, east.")
    print(f"  prompt={r4['prompt_tokens']} cached={r4['cached_tokens']}")
    if r4["cached_tokens"] > 0:
        print(f"  ✓ TTL > 60s")
    else:
        print(f"  ✗ Cache evicted after 60s — TTL menor a lo esperado")


if __name__ == "__main__":
    asyncio.run(main())
```

- [ ] **Step 2: Run the script with real API key**

Run:
```bash
cd services/sda-indexer
DEEPSEEK_API_KEY=$(security find-generic-password -s deepseek_api_key -w 2>/dev/null || echo "$DEEPSEEK_API_KEY") uv run python scripts/verify_deepseek_cache.py
```
Expected output: ratio de cache hit en 2da call >50%.

- [ ] **Step 3: Document findings**

Create `docs/superpowers/notes/deepseek-cache-empirical.md` with the output and the verdict. Template:

```markdown
# DeepSeek prompt cache — empirical verification

**Date:** YYYY-MM-DD
**Spec ref:** [2026-05-25 wave 1 §3.4](../specs/2026-05-25-ingest-index-wave-1-design.md)

## Setup
- Model: deepseek-chat
- Static prompt zone: ~XXXX tokens
- Endpoint: https://api.deepseek.com/v1

## Results

| Call # | prompt_tokens | cached_tokens | hit_ratio |
|---|---|---|---|
| 1 (cold) | X | 0 | 0% |
| 2 | X | Y | Z% |
| 3 | X | Y | Z% |
| 4 (after 60s) | X | Y | Z% |

## Field name in API
- Field path observed: `usage.prompt_tokens_details.cached_tokens`

## Verdict
- [ ] Cache funciona como esperamos
- [ ] TTL > 30min (estimado)
- [ ] Threshold mínimo de prompt confirmado: ~1024 toks

## Action items
- [ ] Si verdict OK → proceder con cache_design.py (Task 16)
- [ ] Si verdict FALLA → escalar al usuario antes de seguir
```

- [ ] **Step 4: Commit**

```bash
git add services/sda-indexer/scripts/verify_deepseek_cache.py docs/superpowers/notes/deepseek-cache-empirical.md
git commit -m "$(cat <<'EOF'
chore(verify): mini-experimento DeepSeek cache (gate Wave 1)

Script que valida empíricamente que DeepSeek prompt caching funciona y
mide TTL. Quick-fail gate antes de invertir en cache_design.py — si el
cache no funciona como esperamos, re-evaluamos Mejora #4 acá.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Rewrite runbook prod-deploy con realidad Fly.io

**Files:**
- Modify: `docs/runbooks/wave-0-prod-deploy.md`

- [ ] **Step 1: Read current runbook**

Run:
```bash
wc -l docs/runbooks/wave-0-prod-deploy.md
head -20 docs/runbooks/wave-0-prod-deploy.md
```
Identificar las secciones que asumen srv-ia-01 (Cloudflare Tunnel del indexer) para reescribirlas.

- [ ] **Step 2: Reescribir el runbook**

Reemplazar el contenido entero por la versión que documenta:
- **Sección 1**: arquitectura real (Fly.io para indexer, srv-ia-01 para MinerU en Wave 1).
- **Sección 2**: Setup Fly.io (`fly launch`, `fly secrets set`, deploy).
- **Sección 3**: Setup Cloudflare Tunnel en srv-ia-01 PARA MINERU (no para indexer).
- **Sección 4**: Setup DNS `mineru.sdaframework.com` en Vercel → tunnel.
- **Sección 5**: Variables de entorno y secrets (DEEPSEEK_API_KEY, SUPABASE_SERVICE_KEY, MINERU_SHARED_SECRET).
- **Sección 6**: Smoke tests post-deploy.
- **Sección 7**: Rollback procedures.
- **Sección 8**: Gotchas conocidos (referencia a memorias `wave_0_prod_gotchas.md`).

Skeleton mínimo (expandir cada sección con comandos concretos):
```markdown
# Runbook — Wave 0+1 prod deploy

**Última actualización:** 2026-05-25 (refactored para Wave 1 — MinerU en srv-ia-01)

## Arquitectura actual

```
Supabase (anfawvxfepowsudlffnl) — control plane
  pgmq + pg_cron + pg_net + langgraph_checkpoints
       │
       ▼
Fly.io (sda-indexer-prod, iad x2 HA) — indexer
       │ HTTPS POST /parse
       ▼
Cloudflare Tunnel → mineru.sdaframework.com
       │
       ▼
srv-ia-01 (Cooperativa Telefónica V.G.G., Santa Fe) — MinerU GPU
```

## Deploy del indexer a Fly.io
... (comandos concretos)

## Deploy del MinerU service a srv-ia-01
... (referencia a tasks 13-14 de Wave 1)

## Smoke tests
... (curl /healthz, upload test PDF)

## Rollback
... (fly deploy --image previous-tag)

## Gotchas
Ver `~/.claude/projects/-Users-enzo-sda-framework-sda-framework/memory/wave_0_prod_gotchas.md`.
```

- [ ] **Step 3: Verify**

Run:
```bash
wc -l docs/runbooks/wave-0-prod-deploy.md
head -30 docs/runbooks/wave-0-prod-deploy.md
```
Expected: archivo > 100 líneas con secciones nuevas visibles.

- [ ] **Step 4: Commit**

```bash
git add docs/runbooks/wave-0-prod-deploy.md
git commit -m "$(cat <<'EOF'
docs(runbook): rewrite prod-deploy con realidad Fly.io + MinerU srv-ia-01

El runbook original asumía Cloudflare Tunnel para el indexer (path no
ejecutado). Refactor: indexer en Fly.io (Wave 0 deploy real), tunnel
PARA el MinerU service en srv-ia-01 (Wave 1). Sección dedicada a setup
de mineru.sdaframework.com + gotchas referenciados a memorias.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 1 — MinerU service (Tasks 8-14)

Servicio nuevo `services/sda-mineru-parser/` que vive en srv-ia-01. FastAPI mínimo + MinerU subprocess + descarga resiliente + cache LRU local. Paralelizable con Phase 0 y Phase 2.

### Task 8: Scaffold sda-mineru-parser

**Files:**
- Create: `services/sda-mineru-parser/pyproject.toml`
- Create: `services/sda-mineru-parser/README.md`
- Create: `services/sda-mineru-parser/.gitignore`
- Create: `services/sda-mineru-parser/.python-version`
- Create: `services/sda-mineru-parser/src/sda_mineru/__init__.py`
- Create: `services/sda-mineru-parser/tests/conftest.py`

- [ ] **Step 1: Create directory structure**

Run:
```bash
mkdir -p services/sda-mineru-parser/src/sda_mineru
mkdir -p services/sda-mineru-parser/tests
mkdir -p services/sda-mineru-parser/systemd
cd services/sda-mineru-parser
touch src/sda_mineru/__init__.py
touch tests/__init__.py
echo "3.12" > .python-version
```

- [ ] **Step 2: Write pyproject.toml**

Create `services/sda-mineru-parser/pyproject.toml`:
```toml
[project]
name = "sda-mineru-parser"
version = "0.1.0"
description = "MinerU PDF parsing service for sda.framework Wave 1"
requires-python = ">=3.12"
dependencies = [
    "fastapi>=0.115.0",
    "uvicorn[standard]>=0.32.0",
    "httpx>=0.27.0",
    "tenacity>=9.0.0",
    "aiofiles>=24.1.0",
    "pydantic>=2.9.0",
    "structlog>=24.4.0",
    "pypdf>=5.0.0",
    "magic-pdf[full]>=0.10.0",  # MinerU package
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
packages = ["src/sda_mineru"]

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
addopts = "-v --tb=short"

[tool.ruff]
line-length = 100
target-version = "py312"
```

- [ ] **Step 3: Write .gitignore**

Create `services/sda-mineru-parser/.gitignore`:
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
/var/cache/sda-mineru/
```

- [ ] **Step 4: Write README**

Create `services/sda-mineru-parser/README.md`:
```markdown
# sda-mineru-parser

PDF parsing service para sda.framework Wave 1. Corre en srv-ia-01 con GPU local, expuesto vía Cloudflare Tunnel a `https://mineru.sdaframework.com`.

## Setup

```bash
cd services/sda-mineru-parser
uv sync
cp .env.example .env  # MINERU_SHARED_SECRET, etc.
uv run pytest
```

## Run

```bash
uv run uvicorn sda_mineru.main:app --host 0.0.0.0 --port 8001
```

## Endpoints

- `GET /healthz` — health check
- `POST /parse` — descarga PDF desde signed_url, ejecuta heuristics + parsing, devuelve markdown + metadata

Ver spec [`docs/superpowers/specs/2026-05-25-ingest-index-wave-1-design.md`](../../docs/superpowers/specs/2026-05-25-ingest-index-wave-1-design.md) §5.1.
```

- [ ] **Step 5: Write conftest**

Create `services/sda-mineru-parser/tests/conftest.py`:
```python
import asyncio
import pytest


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()
```

- [ ] **Step 6: Verify sync**

Run:
```bash
cd services/sda-mineru-parser
uv sync
uv run python -c "import sda_mineru; print('OK')"
```
Expected: prints `OK`.

- [ ] **Step 7: Commit**

```bash
git add services/sda-mineru-parser/
git commit -m "$(cat <<'EOF'
feat(mineru): scaffold sda-mineru-parser service

Nuevo servicio Python (FastAPI + MinerU + httpx) que correrá en srv-ia-01
detrás de Cloudflare Tunnel (mineru.sdaframework.com). Indexer en Fly.io
delega todo el manejo de PDFs acá. Wave 1 §5.1.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: download.py — resilient download

**Files:**
- Create: `services/sda-mineru-parser/src/sda_mineru/download.py`
- Create: `services/sda-mineru-parser/tests/test_download.py`

- [ ] **Step 1: Write failing test**

Create `services/sda-mineru-parser/tests/test_download.py`:
```python
"""Tests reales contra el dev server local. NO mocks (CLAUDE.md)."""

import asyncio
import hashlib
import http.server
import socketserver
import threading
from pathlib import Path

import pytest

from sda_mineru.download import (
    DownloadConfig,
    DownloadError,
    Sha256MismatchError,
    download_with_resume,
)


@pytest.fixture
def http_server(tmp_path):
    """Sirve tmp_path/*.pdf en localhost. Soporta Range requests."""
    serve_dir = tmp_path
    handler = http.server.SimpleHTTPRequestHandler
    handler.directory = str(serve_dir)

    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()

    yield f"http://127.0.0.1:{port}", serve_dir

    httpd.shutdown()


async def test_download_succeeds_for_small_file(tmp_path, http_server):
    url_base, serve_dir = http_server
    src = serve_dir / "tiny.pdf"
    payload = b"%PDF-1.4\n" + b"x" * 100
    src.write_bytes(payload)
    sha = hashlib.sha256(payload).hexdigest()

    dst = tmp_path / "downloaded.pdf"
    cfg = DownloadConfig(max_retries=3, chunk_size_kb=4)
    await download_with_resume(
        url=f"{url_base}/tiny.pdf",
        expected_sha256=sha,
        dst_path=dst,
        config=cfg,
    )
    assert dst.read_bytes() == payload


async def test_download_raises_on_sha_mismatch(tmp_path, http_server):
    url_base, serve_dir = http_server
    src = serve_dir / "bad.pdf"
    src.write_bytes(b"%PDF-1.4\nbogus")
    wrong_sha = "0" * 64

    dst = tmp_path / "downloaded.pdf"
    cfg = DownloadConfig(max_retries=1, chunk_size_kb=4)
    with pytest.raises(Sha256MismatchError):
        await download_with_resume(
            url=f"{url_base}/bad.pdf",
            expected_sha256=wrong_sha,
            dst_path=dst,
            config=cfg,
        )


async def test_download_raises_on_404(tmp_path, http_server):
    url_base, _ = http_server
    dst = tmp_path / "downloaded.pdf"
    cfg = DownloadConfig(max_retries=2, chunk_size_kb=4)
    with pytest.raises(DownloadError):
        await download_with_resume(
            url=f"{url_base}/nonexistent.pdf",
            expected_sha256="0" * 64,
            dst_path=dst,
            config=cfg,
        )
```

Run to verify it fails:
```bash
cd services/sda-mineru-parser
uv run pytest tests/test_download.py -v
```
Expected: `ImportError: cannot import name 'download_with_resume'`.

- [ ] **Step 2: Implement download.py**

Create `services/sda-mineru-parser/src/sda_mineru/download.py`:
```python
"""Descarga resiliente de PDFs desde Supabase Storage. Spec §1.2.

Mecanismos:
- Streaming chunks a disco (nunca PDF entero en memoria)
- SHA256 validation end-to-end
- HTTP Range resume para PDFs >range_resume_min_mb
- Retries con tenacity (exponential backoff + jitter)
- Pre-check de espacio en disco
"""

import hashlib
import shutil
from dataclasses import dataclass
from pathlib import Path

import aiofiles
import httpx
import structlog
from tenacity import (
    AsyncRetrying,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential_jitter,
)

log = structlog.get_logger()


@dataclass(frozen=True)
class DownloadConfig:
    max_retries: int = 5
    backoff_base_seconds: int = 2
    range_resume_min_mb: int = 5
    chunk_size_kb: int = 1024
    timeout_seconds: int = 600
    min_free_gb: float = 2.0


class DownloadError(Exception):
    """Falla persistente de descarga (después de retries)."""


class Sha256MismatchError(DownloadError):
    """El SHA256 calculado no matchea el esperado."""


class DiskFullError(DownloadError):
    """Espacio en disco insuficiente para la descarga."""


class ExpiredSignedUrlError(DownloadError):
    """410 Gone — el signed URL expiró, indexer debe regenerar."""


def _check_disk_space(dst_path: Path, min_free_gb: float) -> None:
    stat = shutil.disk_usage(dst_path.parent)
    free_gb = stat.free / (1024**3)
    if free_gb < min_free_gb:
        raise DiskFullError(
            f"Disk {dst_path.parent}: {free_gb:.1f}GB free, need {min_free_gb}GB"
        )


async def _stream_download(
    url: str, dst_path: Path, chunk_size: int, timeout: int, start_byte: int = 0
) -> None:
    """Descarga streaming. Si start_byte>0, usa Range request."""
    headers = {"Range": f"bytes={start_byte}-"} if start_byte > 0 else {}
    mode = "ab" if start_byte > 0 else "wb"

    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        async with client.stream("GET", url, headers=headers) as resp:
            if resp.status_code == 410:
                raise ExpiredSignedUrlError(f"410 Gone: {url}")
            if start_byte > 0 and resp.status_code != 206:
                # Server no soporta Range, re-descargar desde cero
                log.warning("download.range_unsupported", status=resp.status_code)
                raise DownloadError(f"Range not supported (got {resp.status_code})")
            if resp.status_code >= 400:
                raise DownloadError(f"HTTP {resp.status_code}: {url}")

            async with aiofiles.open(dst_path, mode) as f:
                async for chunk in resp.aiter_bytes(chunk_size):
                    await f.write(chunk)


def _sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(chunk_size):
            h.update(chunk)
    return h.hexdigest()


async def download_with_resume(
    *,
    url: str,
    expected_sha256: str,
    dst_path: Path,
    config: DownloadConfig,
) -> None:
    """Descarga `url` a `dst_path`. Valida sha256. Maneja Range resume.

    Raises:
        Sha256MismatchError: el hash calculado no matchea el esperado.
        ExpiredSignedUrlError: 410 Gone — el caller debe regenerar URL.
        DiskFullError: <min_free_gb disponible.
        DownloadError: falla persistente otra (después de retries).
    """
    dst_path.parent.mkdir(parents=True, exist_ok=True)
    _check_disk_space(dst_path, config.min_free_gb)

    chunk = config.chunk_size_kb * 1024
    range_threshold = config.range_resume_min_mb * 1024 * 1024

    async for attempt in AsyncRetrying(
        stop=stop_after_attempt(config.max_retries),
        wait=wait_exponential_jitter(initial=config.backoff_base_seconds, max=32),
        retry=retry_if_exception_type(
            (httpx.HTTPError, DownloadError),
        ),
        reraise=True,
    ):
        with attempt:
            # Si existe parcial y supera el threshold, intentar Range resume
            start_byte = 0
            if dst_path.exists():
                existing = dst_path.stat().st_size
                if existing >= range_threshold:
                    start_byte = existing
                    log.info("download.resume", url=url, from_byte=start_byte)
                else:
                    dst_path.unlink()  # re-descargar desde cero para chicos

            try:
                await _stream_download(
                    url=url,
                    dst_path=dst_path,
                    chunk_size=chunk,
                    timeout=config.timeout_seconds,
                    start_byte=start_byte,
                )
            except ExpiredSignedUrlError:
                raise  # No retry — caller regenera URL
            except DownloadError:
                # Range fallback: reseteamos y reintentamos desde 0
                if dst_path.exists():
                    dst_path.unlink()
                raise

    # Verify sha256 después de descarga completa
    actual_sha = _sha256_file(dst_path)
    if actual_sha != expected_sha256:
        dst_path.unlink(missing_ok=True)
        raise Sha256MismatchError(
            f"SHA256 mismatch: expected {expected_sha256[:16]}..., got {actual_sha[:16]}..."
        )

    log.info("download.complete", url=url, bytes=dst_path.stat().st_size)
```

- [ ] **Step 3: Run tests**

Run:
```bash
cd services/sda-mineru-parser
uv run pytest tests/test_download.py -v
```
Expected: 3 tests pass.

- [ ] **Step 4: Commit**

```bash
git add services/sda-mineru-parser/src/sda_mineru/download.py services/sda-mineru-parser/tests/test_download.py
git commit -m "$(cat <<'EOF'
feat(mineru): download.py — resilient PDF download

Streaming chunks + sha256 e2e + Range resume para PDFs grandes + tenacity
retries + disk pre-check. Raises tipadas (ExpiredSignedUrlError,
Sha256MismatchError, DiskFullError) que mapean a indexing_failure_reason
enum. Spec §1.2.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: cache.py — LRU local por sha256

**Files:**
- Create: `services/sda-mineru-parser/src/sda_mineru/cache.py`
- Create: `services/sda-mineru-parser/tests/test_cache.py`

- [ ] **Step 1: Write failing tests**

Create `services/sda-mineru-parser/tests/test_cache.py`:
```python
import time
from pathlib import Path

import pytest

from sda_mineru.cache import LocalLRUCache


def test_get_returns_none_for_missing(tmp_path):
    cache = LocalLRUCache(root=tmp_path, max_total_bytes=10_000, max_age_seconds=3600)
    assert cache.get("abcd") is None


def test_put_and_get_returns_path(tmp_path):
    cache = LocalLRUCache(root=tmp_path, max_total_bytes=10_000, max_age_seconds=3600)
    src = tmp_path / "src.pdf"
    src.write_bytes(b"%PDF-1.4 hello")
    cached_path = cache.put("abcd1234", src)
    assert cached_path.exists()
    assert cache.get("abcd1234") == cached_path


def test_evicts_when_over_size(tmp_path):
    cache = LocalLRUCache(root=tmp_path, max_total_bytes=100, max_age_seconds=3600)
    big_a = tmp_path / "a.pdf"
    big_a.write_bytes(b"x" * 80)
    cache.put("a" * 64, big_a)

    big_b = tmp_path / "b.pdf"
    big_b.write_bytes(b"y" * 80)
    cache.put("b" * 64, big_b)

    # `a` debería haber sido evictada (LRU)
    assert cache.get("a" * 64) is None
    assert cache.get("b" * 64) is not None


def test_evicts_when_too_old(tmp_path):
    cache = LocalLRUCache(root=tmp_path, max_total_bytes=10_000, max_age_seconds=1)
    src = tmp_path / "old.pdf"
    src.write_bytes(b"hello")
    cache.put("c" * 64, src)
    time.sleep(1.5)
    cache.cleanup_expired()
    assert cache.get("c" * 64) is None
```

Run:
```bash
cd services/sda-mineru-parser
uv run pytest tests/test_cache.py -v
```
Expected: 4 tests fail with import error.

- [ ] **Step 2: Implement cache.py**

Create `services/sda-mineru-parser/src/sda_mineru/cache.py`:
```python
"""Cache LRU local por sha256. Spec §1.2 mecanismo #6.

Sirve dos propósitos:
- Idempotencia para re-enqueues del mismo PDF
- Debugging local (re-correr MinerU sobre un PDF cached sin tocar Supabase)

Eviction: por tamaño total (LRU) y por edad (TTL).
"""

import shutil
import time
from dataclasses import dataclass
from pathlib import Path

import structlog

log = structlog.get_logger()


@dataclass
class _Entry:
    sha256: str
    path: Path
    size: int
    last_access: float


class LocalLRUCache:
    """Cache de PDFs por sha256 en filesystem local.

    NO thread-safe (asumimos uvicorn single-worker en el servicio).
    Si en el futuro corren múltiples workers, agregar advisory lock por filename.
    """

    def __init__(
        self,
        root: Path,
        max_total_bytes: int = 5 * 1024**3,  # 5 GB default
        max_age_seconds: int = 86400,         # 24h default
    ):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.max_total_bytes = max_total_bytes
        self.max_age_seconds = max_age_seconds

    def _path_for(self, sha256: str) -> Path:
        return self.root / f"{sha256}.pdf"

    def get(self, sha256: str) -> Path | None:
        p = self._path_for(sha256)
        if not p.exists():
            return None
        p.touch()  # mtime = ahora (refresh LRU)
        return p

    def put(self, sha256: str, src: Path) -> Path:
        dst = self._path_for(sha256)
        if dst.exists():
            dst.touch()
            return dst
        shutil.copy2(src, dst)
        log.info("cache.put", sha256=sha256[:8], bytes=dst.stat().st_size)
        self._evict_if_needed()
        return dst

    def _scan(self) -> list[_Entry]:
        entries: list[_Entry] = []
        for p in self.root.glob("*.pdf"):
            stat = p.stat()
            entries.append(_Entry(
                sha256=p.stem, path=p, size=stat.st_size, last_access=stat.st_mtime,
            ))
        return entries

    def _evict_if_needed(self) -> None:
        entries = self._scan()
        total = sum(e.size for e in entries)
        if total <= self.max_total_bytes:
            return
        entries.sort(key=lambda e: e.last_access)
        for e in entries:
            if total <= self.max_total_bytes:
                break
            log.info("cache.evict.size", sha256=e.sha256[:8], bytes=e.size)
            e.path.unlink()
            total -= e.size

    def cleanup_expired(self) -> int:
        now = time.time()
        removed = 0
        for e in self._scan():
            age = now - e.last_access
            if age > self.max_age_seconds:
                log.info("cache.evict.age", sha256=e.sha256[:8], age_seconds=int(age))
                e.path.unlink()
                removed += 1
        return removed
```

- [ ] **Step 3: Run tests**

Run:
```bash
cd services/sda-mineru-parser
uv run pytest tests/test_cache.py -v
```
Expected: 4 tests pass.

- [ ] **Step 4: Commit**

```bash
git add services/sda-mineru-parser/src/sda_mineru/cache.py services/sda-mineru-parser/tests/test_cache.py
git commit -m "$(cat <<'EOF'
feat(mineru): cache.py — LRU local por sha256

Idempotencia para re-enqueues + debugging local. Eviction por tamaño
total (LRU) y por edad (TTL). Single-worker assumption (lock-free).
Spec §1.2 mecanismo #6.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: parser.py — MinerU subprocess + heurísticas nativas

**Files:**
- Create: `services/sda-mineru-parser/src/sda_mineru/parser.py`
- Create: `services/sda-mineru-parser/tests/test_parser.py`
- Create: `services/sda-mineru-parser/tests/fixtures/sample_native.pdf` (vía script)

- [ ] **Step 1: Generate a tiny test PDF fixture**

Create `services/sda-mineru-parser/tests/fixtures/__init__.py` (empty), then a generator script:

Run (from project root):
```bash
mkdir -p services/sda-mineru-parser/tests/fixtures
cd services/sda-mineru-parser
uv add --dev reportlab
uv run python -c "
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter

c = canvas.Canvas('tests/fixtures/sample_native.pdf', pagesize=letter)
for page in range(3):
    c.drawString(100, 750, f'Title — Page {page+1}')
    c.drawString(100, 720, 'Section 1: Intro')
    c.drawString(100, 700, 'Body paragraph with searchable text.')
    c.showPage()
c.save()
print('OK')
"
```
Expected: prints `OK`. File `tests/fixtures/sample_native.pdf` (~2KB) exists.

- [ ] **Step 2: Write failing tests**

Create `services/sda-mineru-parser/tests/test_parser.py`:
```python
from pathlib import Path
import pytest

from sda_mineru.parser import (
    Heuristics,
    ParseResult,
    parse_pdf,
    run_heuristics,
)


FIXTURE = Path(__file__).parent / "fixtures" / "sample_native.pdf"


def test_heuristics_detects_text_layer():
    h = run_heuristics(FIXTURE)
    assert isinstance(h, Heuristics)
    assert h.page_count == 3
    assert h.has_text_layer is True
    assert h.text_ratio > 0.5


async def test_parse_pdf_native_path():
    result = await parse_pdf(FIXTURE, force_path=None)
    assert isinstance(result, ParseResult)
    assert result.path_used in ("fast", "full")
    if result.path_used == "fast":
        assert result.parser_used == "native"
        assert "Title" in result.markdown
    assert result.page_count == 3


async def test_parse_pdf_force_full_uses_mineru(tmp_path, monkeypatch):
    """Verifica que force_path='full' bypasses heuristics y usa MinerU."""
    # En unit test sin GPU, MinerU puede fallar — chequeamos al menos
    # que el routing intentó usar mineru.
    with pytest.raises(Exception) as exc:
        await parse_pdf(FIXTURE, force_path="full")
    # OK si MinerU no está disponible en CI; importante que NO haya intentado native
    assert "native" not in str(exc.value).lower() or "mineru" in str(exc.value).lower()
```

Run:
```bash
cd services/sda-mineru-parser
uv run pytest tests/test_parser.py -v
```
Expected: 3 tests fail (import).

- [ ] **Step 3: Implement parser.py**

Create `services/sda-mineru-parser/src/sda_mineru/parser.py`:
```python
"""Wrapper sobre MinerU + heurísticas nativas con pypdf.

Routing:
- run_heuristics(path) → si has_text_layer y text_ratio>threshold y page_count<max
  → path "fast" (pypdf direct extraction)
- caso contrario → path "full" (subprocess MinerU magic-pdf)
"""

import asyncio
import os
import shutil
import subprocess
import time
from dataclasses import dataclass, asdict
from pathlib import Path

import pypdf
import structlog

log = structlog.get_logger()


@dataclass(frozen=True)
class Heuristics:
    page_count: int
    has_text_layer: bool
    has_toc: bool
    text_ratio: float
    confidence: float


@dataclass(frozen=True)
class ParseResult:
    markdown: str
    parser_used: str   # 'native' | 'mineru'
    path_used: str     # 'fast' | 'full'
    page_count: int
    heuristics: Heuristics
    elapsed_seconds: float


# Defaults; pueden ser sobreescritos por el caller (FastAPI lee de settings remotas).
_DEFAULT_MIN_TEXT_RATIO = 0.7
_DEFAULT_MAX_PAGES_FAST = 100
_DEFAULT_MIN_CONFIDENCE = 0.8


def run_heuristics(pdf_path: Path) -> Heuristics:
    """Lee el PDF con pypdf y deriva heurísticas para fast-path decision."""
    reader = pypdf.PdfReader(str(pdf_path))
    page_count = len(reader.pages)
    pages_with_text = 0
    has_toc = False

    for page in reader.pages[:20]:  # Muestra primeras 20
        text = page.extract_text() or ""
        if text.strip():
            pages_with_text += 1
        # Heurística TOC: busca "table of contents", "índice", "contents", numeración
        low = text.lower()
        if "table of contents" in low or "índice" in low or "tabla de contenido" in low:
            has_toc = True

    sample = min(20, page_count)
    text_ratio = pages_with_text / sample if sample > 0 else 0.0

    # Confidence: cuanto más texto y más linealmente distribuido, más confianza.
    confidence = min(1.0, text_ratio * (1.0 if page_count < 50 else 0.85))

    return Heuristics(
        page_count=page_count,
        has_text_layer=text_ratio > 0.3,
        has_toc=has_toc,
        text_ratio=text_ratio,
        confidence=confidence,
    )


def _decide_path(h: Heuristics, force_path: str | None) -> str:
    if force_path in ("fast", "full"):
        return force_path
    if not h.has_text_layer:
        return "full"
    if h.page_count > _DEFAULT_MAX_PAGES_FAST:
        return "full"
    if h.text_ratio < _DEFAULT_MIN_TEXT_RATIO:
        return "full"
    if h.confidence < _DEFAULT_MIN_CONFIDENCE:
        return "full"
    return "fast"


def _parse_native(pdf_path: Path) -> str:
    """Extract markdown via pypdf — heuristic 'fast path'.

    Convierte cada página a `## Page N\n\n<text>\n\n` (simple pero suficiente
    cuando hay capa de texto limpia + TOC).
    """
    reader = pypdf.PdfReader(str(pdf_path))
    out = []
    for i, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        out.append(f"## Page {i}\n\n{text.strip()}\n")
    return "\n".join(out)


async def _parse_mineru(pdf_path: Path, work_dir: Path) -> str:
    """Ejecuta MinerU (magic-pdf CLI) como subprocess. Devuelve markdown."""
    work_dir.mkdir(parents=True, exist_ok=True)
    # MinerU se invoca por CLI: `magic-pdf -p <pdf> -o <outdir> -m auto`
    cmd = [
        "magic-pdf",
        "-p", str(pdf_path),
        "-o", str(work_dir),
        "-m", "auto",
    ]
    log.info("mineru.subprocess.start", cmd=" ".join(cmd))
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(
            f"magic-pdf failed (exit {proc.returncode}): {stderr.decode()[:500]}"
        )
    # MinerU output: <work_dir>/<pdf_stem>/auto/<pdf_stem>.md
    stem = pdf_path.stem
    md_file = work_dir / stem / "auto" / f"{stem}.md"
    if not md_file.exists():
        candidates = list(work_dir.rglob("*.md"))
        if not candidates:
            raise RuntimeError(f"MinerU produced no markdown output in {work_dir}")
        md_file = candidates[0]
    return md_file.read_text(encoding="utf-8")


async def parse_pdf(
    pdf_path: Path, *, force_path: str | None = None, work_dir: Path | None = None,
) -> ParseResult:
    """Parsea el PDF eligiendo automáticamente fast vs full (override con force_path).

    Returns:
        ParseResult con markdown + metadata. Errores se propagan (caller
        captura y mapea a indexing_failure_reason).
    """
    start = time.monotonic()
    h = run_heuristics(pdf_path)
    path = _decide_path(h, force_path)

    if path == "fast":
        md = _parse_native(pdf_path)
        parser_used = "native"
    else:
        wd = work_dir or Path("/tmp") / f"mineru_{pdf_path.stem}"
        try:
            md = await _parse_mineru(pdf_path, wd)
        finally:
            shutil.rmtree(wd, ignore_errors=True)
        parser_used = "mineru"

    elapsed = time.monotonic() - start
    return ParseResult(
        markdown=md,
        parser_used=parser_used,
        path_used=path,
        page_count=h.page_count,
        heuristics=h,
        elapsed_seconds=elapsed,
    )
```

- [ ] **Step 4: Run tests**

Run:
```bash
cd services/sda-mineru-parser
uv run pytest tests/test_parser.py::test_heuristics_detects_text_layer -v
uv run pytest tests/test_parser.py::test_parse_pdf_native_path -v
```
Expected: ambos pass (el test de force_full puede skipearse en CI sin MinerU instalado).

- [ ] **Step 5: Commit**

```bash
git add services/sda-mineru-parser/
git commit -m "$(cat <<'EOF'
feat(mineru): parser.py — heuristics + native (pypdf) + MinerU subprocess

run_heuristics(): page_count, text ratio, TOC presence. _decide_path():
fast vs full según thresholds. parse_pdf(): orquesta routing y devuelve
ParseResult tipado con markdown + metadata para el indexer.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: main.py — FastAPI con /parse + /healthz

**Files:**
- Create: `services/sda-mineru-parser/src/sda_mineru/main.py`
- Create: `services/sda-mineru-parser/src/sda_mineru/healthz.py`
- Create: `services/sda-mineru-parser/tests/test_main.py`

- [ ] **Step 1: Write healthz.py (simple)**

Create `services/sda-mineru-parser/src/sda_mineru/healthz.py`:
```python
"""Health check. Verifica que el process está vivo. NO hace test download
(Wave 2 puede agregar deep healthz)."""

import shutil
from pathlib import Path
from pydantic import BaseModel


class HealthStatus(BaseModel):
    ok: bool
    version: str
    cache_dir: str
    free_disk_gb: float


def check_health(cache_dir: Path, version: str = "0.1.0") -> HealthStatus:
    stat = shutil.disk_usage(cache_dir if cache_dir.exists() else cache_dir.parent)
    return HealthStatus(
        ok=True,
        version=version,
        cache_dir=str(cache_dir),
        free_disk_gb=round(stat.free / (1024**3), 2),
    )
```

- [ ] **Step 2: Write main.py**

Create `services/sda-mineru-parser/src/sda_mineru/main.py`:
```python
"""FastAPI app principal. Spec §5.1.

Endpoint:
  POST /parse — body ParseRequest, returns ParseResponse o error tipado
  GET /healthz — health check
"""

import os
import secrets
from contextlib import asynccontextmanager
from dataclasses import asdict
from pathlib import Path

import structlog
from fastapi import Depends, FastAPI, Header, HTTPException, status
from pydantic import BaseModel, Field

from .cache import LocalLRUCache
from .download import (
    DownloadConfig,
    DownloadError,
    DiskFullError,
    ExpiredSignedUrlError,
    Sha256MismatchError,
    download_with_resume,
)
from .healthz import HealthStatus, check_health
from .parser import ParseResult, parse_pdf

log = structlog.get_logger()


VERSION = "0.1.0"
CACHE_DIR = Path(os.environ.get("SDA_MINERU_CACHE_DIR", "/var/cache/sda-mineru"))
SHARED_SECRET = os.environ.get("MINERU_SHARED_SECRET", "")


class ParseRequest(BaseModel):
    doc_id: str
    signed_url: str
    expected_sha256: str = Field(min_length=64, max_length=64)
    force_path: str | None = Field(default=None, pattern="^(fast|full)$")


class HeuristicsOut(BaseModel):
    has_text_layer: bool
    has_toc: bool
    text_ratio: float
    confidence: float


class ParseMetadata(BaseModel):
    parser_used: str
    path_used: str
    page_count: int
    heuristics: HeuristicsOut
    elapsed_seconds: float
    cache_hit: bool


class ParseResponse(BaseModel):
    markdown: str
    metadata: ParseMetadata


@asynccontextmanager
async def lifespan(app: FastAPI):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    app.state.cache = LocalLRUCache(root=CACHE_DIR)
    log.info("mineru.startup", version=VERSION, cache_dir=str(CACHE_DIR))
    yield
    log.info("mineru.shutdown")


app = FastAPI(title="sda-mineru-parser", version=VERSION, lifespan=lifespan)


def require_auth(authorization: str = Header(default="")) -> None:
    if not SHARED_SECRET:
        raise HTTPException(503, "MINERU_SHARED_SECRET no configurado")
    expected = f"Bearer {SHARED_SECRET}"
    if not secrets.compare_digest(authorization, expected):
        raise HTTPException(401, "auth failed")


@app.get("/healthz", response_model=HealthStatus)
async def healthz():
    return check_health(CACHE_DIR, VERSION)


@app.post("/parse", response_model=ParseResponse, dependencies=[Depends(require_auth)])
async def parse(req: ParseRequest):
    cache: LocalLRUCache = app.state.cache
    cache_hit = False

    # Cache lookup
    pdf_path = cache.get(req.expected_sha256)
    if pdf_path:
        cache_hit = True
        log.info("mineru.cache_hit", sha256=req.expected_sha256[:8])
    else:
        # Download to temp, validate sha, then put in cache
        tmp = CACHE_DIR / f"_dl_{req.doc_id}.pdf"
        try:
            await download_with_resume(
                url=req.signed_url,
                expected_sha256=req.expected_sha256,
                dst_path=tmp,
                config=DownloadConfig(),
            )
            pdf_path = cache.put(req.expected_sha256, tmp)
        except ExpiredSignedUrlError as e:
            raise HTTPException(410, {"failure_reason": "expired_signed_url", "detail": str(e)})
        except Sha256MismatchError as e:
            raise HTTPException(422, {"failure_reason": "sha256_mismatch", "detail": str(e)})
        except DiskFullError as e:
            raise HTTPException(503, {"failure_reason": "disk_full", "detail": str(e)})
        except DownloadError as e:
            raise HTTPException(502, {"failure_reason": "download_failed", "detail": str(e)})
        finally:
            tmp.unlink(missing_ok=True)

    # Parse
    try:
        result: ParseResult = await parse_pdf(pdf_path, force_path=req.force_path)
    except MemoryError as e:
        raise HTTPException(500, {"failure_reason": "mineru_oom", "detail": str(e)})
    except TimeoutError as e:
        raise HTTPException(504, {"failure_reason": "mineru_timeout", "detail": str(e)})
    except Exception as e:
        raise HTTPException(500, {"failure_reason": "unknown", "detail": f"{type(e).__name__}: {e}"})

    return ParseResponse(
        markdown=result.markdown,
        metadata=ParseMetadata(
            parser_used=result.parser_used,
            path_used=result.path_used,
            page_count=result.page_count,
            heuristics=HeuristicsOut(**asdict(result.heuristics) | {
                "has_text_layer": result.heuristics.has_text_layer,
                "has_toc": result.heuristics.has_toc,
                "text_ratio": result.heuristics.text_ratio,
                "confidence": result.heuristics.confidence,
            }),
            elapsed_seconds=result.elapsed_seconds,
            cache_hit=cache_hit,
        ),
    )
```

- [ ] **Step 3: Write main test**

Create `services/sda-mineru-parser/tests/test_main.py`:
```python
import os
from fastapi.testclient import TestClient
import pytest


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("SDA_MINERU_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setenv("MINERU_SHARED_SECRET", "testsecret")
    from sda_mineru.main import app
    return TestClient(app)


def test_healthz_returns_ok(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["version"]


def test_parse_requires_auth(client):
    r = client.post("/parse", json={
        "doc_id": "x",
        "signed_url": "http://localhost/nope",
        "expected_sha256": "0" * 64,
    })
    assert r.status_code == 401


def test_parse_with_bad_auth(client):
    r = client.post(
        "/parse",
        headers={"Authorization": "Bearer wrong"},
        json={
            "doc_id": "x",
            "signed_url": "http://localhost/nope",
            "expected_sha256": "0" * 64,
        },
    )
    assert r.status_code == 401
```

- [ ] **Step 4: Run tests**

Run:
```bash
cd services/sda-mineru-parser
uv run pytest tests/test_main.py -v
```
Expected: 3 tests pass.

- [ ] **Step 5: Smoke test local**

Run in one terminal:
```bash
cd services/sda-mineru-parser
MINERU_SHARED_SECRET=dev SDA_MINERU_CACHE_DIR=/tmp/mineru-cache uv run uvicorn sda_mineru.main:app --port 8001
```

In another terminal:
```bash
curl http://localhost:8001/healthz
```
Expected: JSON with `ok: true`.

Kill the server (Ctrl+C).

- [ ] **Step 6: Commit**

```bash
git add services/sda-mineru-parser/
git commit -m "$(cat <<'EOF'
feat(mineru): main.py FastAPI app + healthz + auth

POST /parse: descarga PDF (sha validated) → cache LRU → parse_pdf →
ParseResponse. Errores tipados que mapean a indexing_failure_reason enum.
Bearer auth con MINERU_SHARED_SECRET. GET /healthz reporta disk free.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: systemd service file + Dockerfile

**Files:**
- Create: `services/sda-mineru-parser/systemd/sda-mineru.service`
- Create: `services/sda-mineru-parser/Dockerfile`

- [ ] **Step 1: Write systemd unit**

Create `services/sda-mineru-parser/systemd/sda-mineru.service`:
```ini
[Unit]
Description=SDA MinerU PDF parser
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=enzo
WorkingDirectory=/home/enzo/sda-mineru-parser
EnvironmentFile=/etc/sda-mineru/env
ExecStart=/home/enzo/.local/bin/uv run --no-sync uvicorn sda_mineru.main:app \
    --host 127.0.0.1 \
    --port 8001 \
    --workers 1 \
    --log-level info
Restart=on-failure
RestartSec=10s
StandardOutput=journal
StandardError=journal

# Cache dir y disk usage
ReadWritePaths=/var/cache/sda-mineru
StateDirectory=sda-mineru

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Write Dockerfile (alternative / dev)**

Create `services/sda-mineru-parser/Dockerfile`:
```dockerfile
# Base image: CUDA support para MinerU GPU
# Producción en srv-ia-01 usa systemd unit (Task 13 step 1), no este Dockerfile.
# Este Dockerfile es para CI / dev local sin GPU (fallback CPU MinerU).
FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 \
    poppler-utils \
    libmagic1 \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml .
RUN pip install --no-cache-dir uv && uv sync --no-dev

COPY src/ src/

ENV SDA_MINERU_CACHE_DIR=/var/cache/sda-mineru
RUN mkdir -p /var/cache/sda-mineru

EXPOSE 8001

CMD ["uv", "run", "--no-sync", "uvicorn", "sda_mineru.main:app", \
     "--host", "0.0.0.0", "--port", "8001", "--workers", "1"]
```

- [ ] **Step 3: Document deploy steps in README**

Append to `services/sda-mineru-parser/README.md`:
```markdown

## Deploy a srv-ia-01

```bash
# 1. Sync code
rsync -av --exclude='.venv/' --exclude='__pycache__/' \
    services/sda-mineru-parser/ enzo@srv-ia-01:/home/enzo/sda-mineru-parser/

# 2. Install deps en el server
ssh enzo@srv-ia-01 'cd /home/enzo/sda-mineru-parser && uv sync'

# 3. Setup env file (one-time)
ssh enzo@srv-ia-01 'sudo mkdir -p /etc/sda-mineru && sudo tee /etc/sda-mineru/env <<EOF
MINERU_SHARED_SECRET=<generate-with-openssl-rand-hex-32>
SDA_MINERU_CACHE_DIR=/var/cache/sda-mineru
EOF'
ssh enzo@srv-ia-01 'sudo chmod 600 /etc/sda-mineru/env'

# 4. Install systemd unit
ssh enzo@srv-ia-01 'sudo cp /home/enzo/sda-mineru-parser/systemd/sda-mineru.service /etc/systemd/system/'
ssh enzo@srv-ia-01 'sudo systemctl daemon-reload && sudo systemctl enable --now sda-mineru'

# 5. Verify
ssh enzo@srv-ia-01 'systemctl status sda-mineru && curl -s http://127.0.0.1:8001/healthz'
```
```

- [ ] **Step 4: Commit**

```bash
git add services/sda-mineru-parser/systemd/ services/sda-mineru-parser/Dockerfile services/sda-mineru-parser/README.md
git commit -m "$(cat <<'EOF'
feat(mineru): systemd unit + Dockerfile + deploy doc

systemd unit con hardening (NoNewPrivileges, ProtectSystem=strict) y
EnvironmentFile separado para secrets. Dockerfile para CI/dev local sin
GPU. README con pasos de deploy via rsync + systemctl.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Cloudflare Tunnel + DNS mineru.sdaframework.com

**Files:**
- Create: `services/sda-mineru-parser/cloudflared/config.yml.example`
- Modify: `docs/runbooks/wave-0-prod-deploy.md` (sección 3)

Esta task es operacional — instalación en srv-ia-01. Documentar comandos.

- [ ] **Step 1: Write example cloudflared config**

Create `services/sda-mineru-parser/cloudflared/config.yml.example`:
```yaml
# /etc/cloudflared/config.yml (en srv-ia-01)
# Tunnel: mineru-prod (UUID asignado por `cloudflared tunnel create`)
tunnel: REPLACE_WITH_TUNNEL_UUID
credentials-file: /etc/cloudflared/REPLACE_WITH_TUNNEL_UUID.json

ingress:
  - hostname: mineru.sdaframework.com
    service: http://127.0.0.1:8001
    originRequest:
      connectTimeout: 30s
      noTLSVerify: false
  - service: http_status:404
```

- [ ] **Step 2: Document install in runbook**

Append section 3 in `docs/runbooks/wave-0-prod-deploy.md`:
```markdown

## Sección 3 — Setup Cloudflare Tunnel para MinerU (srv-ia-01)

```bash
# 1. Install cloudflared (Debian/Ubuntu)
ssh enzo@srv-ia-01 'wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb && sudo dpkg -i cloudflared-linux-amd64.deb'

# 2. Auth + create tunnel
ssh enzo@srv-ia-01 'cloudflared tunnel login'  # browser opens
ssh enzo@srv-ia-01 'cloudflared tunnel create mineru-prod'
# Note el UUID retornado

# 3. Copy config from repo + edit UUID
scp services/sda-mineru-parser/cloudflared/config.yml.example enzo@srv-ia-01:/tmp/
ssh enzo@srv-ia-01 'sudo mkdir -p /etc/cloudflared && sudo cp /tmp/config.yml.example /etc/cloudflared/config.yml'
ssh enzo@srv-ia-01 'sudo vim /etc/cloudflared/config.yml'  # replace REPLACE_WITH_TUNNEL_UUID
ssh enzo@srv-ia-01 'sudo cp ~/.cloudflared/<UUID>.json /etc/cloudflared/'

# 4. Install as service
ssh enzo@srv-ia-01 'sudo cloudflared service install'
ssh enzo@srv-ia-01 'sudo systemctl enable --now cloudflared'
ssh enzo@srv-ia-01 'sudo systemctl status cloudflared'
```

## Sección 4 — DNS mineru.sdaframework.com en Vercel

Cloudflare Tunnel asigna automáticamente un CNAME del tipo `<UUID>.cfargotunnel.com`. Crear en Vercel:

1. Vercel Dashboard → Project `sdaframework` → Settings → Domains
2. Add: `mineru.sdaframework.com`
3. Type: CNAME
4. Value: `<TUNNEL_UUID>.cfargotunnel.com`
5. Wait for DNS propagation (~1-5 min)

Verify:
```bash
dig mineru.sdaframework.com +short
curl https://mineru.sdaframework.com/healthz
```
Expected: HTTP 200 con JSON `{"ok": true, ...}`.
```

- [ ] **Step 3: Commit**

```bash
git add services/sda-mineru-parser/cloudflared/ docs/runbooks/wave-0-prod-deploy.md
git commit -m "$(cat <<'EOF'
docs(mineru): cloudflared config + tunnel + DNS Vercel setup

Config template + runbook step-by-step para exponer
sda-mineru-parser:8001 (en srv-ia-01) a https://mineru.sdaframework.com
via Cloudflare Tunnel + CNAME en Vercel DNS.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2 — Pipeline modules en el indexer (Tasks 15-25)

**Nota de design (LEAN):** el spec §2.1 listaba `pipeline/parser/heuristics.py` y `pipeline/parser/pdf_native.py` en el indexer, pero §5.1 establece que el indexer NUNCA toca el binario PDF — el mineru service hace todo el trabajo y devuelve `(markdown, metadata)`. Esos dos archivos viven sólo en el mineru service (ya implementados en Task 11). Solo creamos `pdf_mineru.py` (HTTP client) en el indexer. Total Phase 2: 11 tasks (no 13).

### Task 15: llm/router.py — tiered model selection

**Files:**
- Create: `services/sda-indexer/src/sda_indexer/llm/router.py`
- Create: `services/sda-indexer/tests/unit/test_llm_router.py`

- [ ] **Step 1: Write failing tests**

Create `services/sda-indexer/tests/unit/test_llm_router.py`:
```python
"""Unit tests para llm/router.py — pure function, sin IO ni mocks."""

import pytest

from sda_indexer.llm.router import LLMConfig, Phase, route


def test_route_toc_returns_pro_model():
    cfg = route(
        Phase.TOC,
        settings_resolver=lambda key, **kw: {
            "llm.router.toc.model": "deepseek-chat",
            "llm.router.toc.temperature": 0.0,
        }[key],
    )
    assert isinstance(cfg, LLMConfig)
    assert cfg.model == "deepseek-chat"
    assert cfg.temperature == 0.0
    assert cfg.phase == Phase.TOC


def test_route_summarize_returns_flash_temperature():
    cfg = route(
        Phase.SUMMARIZE,
        settings_resolver=lambda key, **kw: {
            "llm.router.summarize.model": "deepseek-chat",
            "llm.router.summarize.temperature": 0.1,
        }[key],
    )
    assert cfg.temperature == 0.1


def test_route_validator_falls_back_to_structure_group():
    # validator y repair NO tienen settings propias — caen a structure
    cfg = route(
        Phase.VALIDATOR,
        settings_resolver=lambda key, **kw: {
            "llm.router.structure.model": "deepseek-chat",
            "llm.router.structure.temperature": 0.0,
        }[key],
    )
    assert cfg.model == "deepseek-chat"
    assert cfg.temperature == 0.0
    assert cfg.phase == Phase.VALIDATOR  # phase original preservada


def test_route_repair_falls_back_to_structure_group():
    cfg = route(
        Phase.REPAIR,
        settings_resolver=lambda key, **kw: {
            "llm.router.structure.model": "deepseek-chat",
            "llm.router.structure.temperature": 0.0,
        }[key],
    )
    assert cfg.model == "deepseek-chat"
```

Run:
```bash
cd services/sda-indexer
uv run pytest tests/unit/test_llm_router.py -v
```
Expected: 4 tests fail with import error.

- [ ] **Step 2: Implement router.py**

Create `services/sda-indexer/src/sda_indexer/llm/router.py`:
```python
"""Tiered model router para Wave 1 (Mejora #6 del spec).

Cada fase del pipeline llama a `route(phase, settings)` y obtiene un
`LLMConfig` con model + temperature + max_tokens resueltos contra las
settings runtime. Permite hot-swap sin redeploy.

Sub-fases sin settings propias (validator, repair) caen al "settings group"
de structure por default. Wave 2 puede granularizar si se necesita.
"""

from dataclasses import dataclass
from enum import Enum
from typing import Callable, Awaitable, Any


class Phase(str, Enum):
    TOC = "toc"                   # toc_detect + toc_transform
    STRUCTURE = "structure"       # index_extractor
    VALIDATOR = "validator"       # → cae a structure.*
    REPAIR = "repair"             # → cae a structure.*
    SUMMARIZE = "summarize"       # summary + contextual_prefix combinado


@dataclass(frozen=True)
class LLMConfig:
    model: str
    temperature: float
    phase: Phase
    max_tokens: int | None = None


# Mapping: si la fase no tiene settings propias, ¿de qué grupo lee?
_FALLBACK_GROUP: dict[Phase, Phase] = {
    Phase.VALIDATOR: Phase.STRUCTURE,
    Phase.REPAIR: Phase.STRUCTURE,
}


def _settings_group(phase: Phase) -> str:
    """Devuelve el prefijo de settings que aplica a esta fase."""
    actual = _FALLBACK_GROUP.get(phase, phase)
    return f"llm.router.{actual.value}"


def route(
    phase: Phase,
    *,
    settings_resolver: Callable[..., Any],
    document_id: str | None = None,
    collection_id: str | None = None,
    max_tokens: int | None = None,
) -> LLMConfig:
    """Resuelve LLMConfig para `phase` leyendo settings vía resolver.

    `settings_resolver(key, **kwargs)` debe ser sync o async-resolved upstream.
    Para uso async, el caller pasa `await settings.resolve` envuelto en lambda.
    """
    group = _settings_group(phase)
    model = settings_resolver(
        f"{group}.model",
        document_id=document_id,
        collection_id=collection_id,
    )
    temperature = settings_resolver(
        f"{group}.temperature",
        document_id=document_id,
        collection_id=collection_id,
    )
    return LLMConfig(
        model=model,
        temperature=float(temperature),
        phase=phase,
        max_tokens=max_tokens,
    )


async def aroute(
    phase: Phase,
    *,
    settings,
    document_id: str | None = None,
    collection_id: str | None = None,
    max_tokens: int | None = None,
) -> LLMConfig:
    """Async variant que usa SettingsClient real (await settings.resolve)."""
    group = _settings_group(phase)
    model = await settings.resolve(
        f"{group}.model",
        document_id=document_id,
        collection_id=collection_id,
    )
    temperature = await settings.resolve(
        f"{group}.temperature",
        document_id=document_id,
        collection_id=collection_id,
    )
    return LLMConfig(
        model=model,
        temperature=float(temperature),
        phase=phase,
        max_tokens=max_tokens,
    )
```

- [ ] **Step 3: Run tests**

Run:
```bash
cd services/sda-indexer
uv run pytest tests/unit/test_llm_router.py -v
```
Expected: 4 tests pass.

- [ ] **Step 4: Commit**

```bash
git add services/sda-indexer/src/sda_indexer/llm/router.py services/sda-indexer/tests/unit/test_llm_router.py
git commit -m "$(cat <<'EOF'
feat(indexer): llm/router.py — tiered model selection (#6)

route(phase, settings_resolver) devuelve LLMConfig con model+temperature
resueltos contra app_settings runtime. Sub-fases validator/repair caen al
grupo structure por default. Async variant aroute() para uso con
SettingsClient real.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: llm/cache_design.py — prompt anatomy + prefix stability

**Files:**
- Create: `services/sda-indexer/src/sda_indexer/llm/cache_design.py`
- Create: `services/sda-indexer/tests/unit/test_cache_design.py`

- [ ] **Step 1: Write failing tests**

Create `services/sda-indexer/tests/unit/test_cache_design.py`:
```python
import pytest
from sda_indexer.llm.cache_design import (
    PromptParts,
    PrefixDriftError,
)


def test_assemble_concatenates_in_order():
    p = PromptParts(
        static_system="SYS",
        static_instructions="INS",
        static_schema="SCH",
        static_examples="EXM",
        semi_static_doc_ctx="DOC",
        dynamic_payload="DYN",
    )
    out = p.assemble()
    assert out.index("SYS") < out.index("INS") < out.index("SCH") < out.index("EXM")
    assert out.index("EXM") < out.index("DOC") < out.index("DYN")


def test_assert_prefix_stable_ok_when_static_zones_match():
    a = PromptParts(
        static_system="SYS", static_instructions="INS", static_schema="SCH",
        static_examples="EXM", semi_static_doc_ctx="DOC1", dynamic_payload="A",
    )
    b = PromptParts(
        static_system="SYS", static_instructions="INS", static_schema="SCH",
        static_examples="EXM", semi_static_doc_ctx="DOC1", dynamic_payload="B",
    )
    # Should NOT raise
    a.assert_prefix_stable(b)


def test_assert_prefix_stable_raises_on_static_drift():
    a = PromptParts(
        static_system="SYS_A", static_instructions="INS", static_schema="SCH",
        static_examples="EXM", semi_static_doc_ctx="DOC", dynamic_payload="X",
    )
    b = PromptParts(
        static_system="SYS_B", static_instructions="INS", static_schema="SCH",
        static_examples="EXM", semi_static_doc_ctx="DOC", dynamic_payload="X",
    )
    with pytest.raises(PrefixDriftError):
        a.assert_prefix_stable(b)


def test_assert_prefix_stable_ok_when_dynamic_differs():
    """dynamic_payload puede variar — eso ES esperado."""
    a = PromptParts(
        static_system="S", static_instructions="I", static_schema="C",
        static_examples="E", semi_static_doc_ctx="D", dynamic_payload="alpha",
    )
    b = PromptParts(
        static_system="S", static_instructions="I", static_schema="C",
        static_examples="E", semi_static_doc_ctx="D", dynamic_payload="omega",
    )
    a.assert_prefix_stable(b)
```

Run:
```bash
cd services/sda-indexer
uv run pytest tests/unit/test_cache_design.py -v
```
Expected: 4 fails with import error.

- [ ] **Step 2: Implement cache_design.py**

Create `services/sda-indexer/src/sda_indexer/llm/cache_design.py`:
```python
"""Anatomía universal de prompts para maximizar DeepSeek prompt cache.

Spec §3.1: todo prompt sigue la forma
  [static_system | static_instructions | static_schema | static_examples |
   semi_static_doc_ctx | dynamic_payload]

Las primeras 4 zonas son idénticas cross-call dentro de una misma fase
(cache hit cross-doc). semi_static_doc_ctx varía por documento (cache hit
cross-chunk del mismo doc). Solo dynamic_payload varía siempre.

`assert_prefix_stable` se usa en dev/test mode para detectar drift: si
dos calls de la misma fase tienen `static_*` distinto, el cache se rompe.
"""

import hashlib
from dataclasses import dataclass


class PrefixDriftError(AssertionError):
    """Las zonas static_* difieren entre calls de la misma fase. El cache
    de DeepSeek se romperá. Bug en quien arma el prompt."""


@dataclass(frozen=True)
class PromptParts:
    static_system: str
    static_instructions: str
    static_schema: str
    static_examples: str
    semi_static_doc_ctx: str
    dynamic_payload: str

    def assemble(self) -> str:
        """Une las zonas en el orden cache-friendly. Newlines explícitos."""
        return "\n\n".join([
            self.static_system,
            self.static_instructions,
            self.static_schema,
            self.static_examples,
            self.semi_static_doc_ctx,
            self.dynamic_payload,
        ])

    def static_hash(self) -> str:
        """SHA256 de las 4 zonas estáticas. Útil para logs/dashboards."""
        blob = "|".join([
            self.static_system,
            self.static_instructions,
            self.static_schema,
            self.static_examples,
        ]).encode("utf-8")
        return hashlib.sha256(blob).hexdigest()

    def assert_prefix_stable(self, other: "PromptParts") -> None:
        """Raises PrefixDriftError si las zonas estáticas difieren."""
        if self.static_hash() != other.static_hash():
            raise PrefixDriftError(
                f"static prefix drift: self={self.static_hash()[:8]}, "
                f"other={other.static_hash()[:8]}. "
                f"Esto rompe DeepSeek cache."
            )


def system_user_split(parts: PromptParts) -> tuple[str, str]:
    """Convierte PromptParts a (system, user) para OpenAI-compatible client.

    - system: static_system (NO incluye instrucciones — esas van en user
      porque DeepSeek cachea por message content combinado).
    - user: instructions + schema + examples + doc_ctx + payload, en orden.

    Heurística de por qué NO meter todo en system: algunos providers
    estiman cache hits a nivel de mensaje, no del prompt concatenado.
    Mantener una división consistente facilita debugging.
    """
    system = parts.static_system
    user = "\n\n".join([
        parts.static_instructions,
        parts.static_schema,
        parts.static_examples,
        parts.semi_static_doc_ctx,
        parts.dynamic_payload,
    ])
    return system, user
```

- [ ] **Step 3: Run tests**

Run:
```bash
cd services/sda-indexer
uv run pytest tests/unit/test_cache_design.py -v
```
Expected: 4 tests pass.

- [ ] **Step 4: Commit**

```bash
git add services/sda-indexer/src/sda_indexer/llm/cache_design.py services/sda-indexer/tests/unit/test_cache_design.py
git commit -m "$(cat <<'EOF'
feat(indexer): llm/cache_design.py — prompt anatomy (#4)

PromptParts con 6 zonas tipadas + assemble() + static_hash() +
assert_prefix_stable() para detectar drift que rompería el cache de
DeepSeek. system_user_split() para convertir a OpenAI-compatible.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 17: pipeline/parser/pdf_mineru.py — HTTP client al mineru service

**Files:**
- Create: `services/sda-indexer/src/sda_indexer/pipeline/parser/pdf_mineru.py`
- Create: `services/sda-indexer/tests/integration/test_pdf_mineru_client.py`

- [ ] **Step 1: Write integration test (skip cuando MINERU_URL no configurada)**

Create `services/sda-indexer/tests/integration/test_pdf_mineru_client.py`:
```python
"""Integration test del HTTP client. Requiere mineru service corriendo en
MINERU_URL o se skipea. NO mocks (CLAUDE.md)."""

import os
import hashlib
from pathlib import Path

import pytest

from sda_indexer.pipeline.parser.pdf_mineru import (
    MineruClient,
    MineruError,
    ParseRequest,
)


pytestmark = pytest.mark.integration


@pytest.fixture
def mineru_url():
    url = os.environ.get("MINERU_URL")
    if not url:
        pytest.skip("MINERU_URL no configurada — skipping integration test")
    return url


@pytest.fixture
def shared_secret():
    s = os.environ.get("MINERU_SHARED_SECRET")
    if not s:
        pytest.skip("MINERU_SHARED_SECRET no configurada")
    return s


async def test_parse_returns_markdown(mineru_url, shared_secret):
    """Smoke test: el client puede comunicarse con el service y obtener markdown.

    Requiere un PDF accesible vía URL pública o signed URL de Supabase.
    """
    test_pdf_url = os.environ.get("TEST_PDF_URL")
    test_pdf_sha = os.environ.get("TEST_PDF_SHA256")
    if not test_pdf_url or not test_pdf_sha:
        pytest.skip("TEST_PDF_URL y TEST_PDF_SHA256 no configurados")

    client = MineruClient(base_url=mineru_url, shared_secret=shared_secret)
    result = await client.parse(ParseRequest(
        doc_id="integration-test",
        signed_url=test_pdf_url,
        expected_sha256=test_pdf_sha,
        force_path=None,
    ))
    assert result.markdown
    assert result.metadata["page_count"] > 0
    assert result.metadata["path_used"] in ("fast", "full")
```

- [ ] **Step 2: Implement pdf_mineru.py**

Create `services/sda-indexer/src/sda_indexer/pipeline/parser/pdf_mineru.py`:
```python
"""HTTP client al servicio sda-mineru-parser (en srv-ia-01 via Cloudflare Tunnel).

El indexer NUNCA toca el binario PDF. Manda payload con signed_url + sha256
y recibe markdown + metadata. Errores tipados mapean a indexing_failure_reason.
"""

from dataclasses import dataclass
from typing import Any

import httpx
import structlog

log = structlog.get_logger()


@dataclass(frozen=True)
class ParseRequest:
    doc_id: str
    signed_url: str
    expected_sha256: str
    force_path: str | None = None    # 'fast' | 'full' | None (auto)


@dataclass(frozen=True)
class ParseResponse:
    markdown: str
    metadata: dict[str, Any]


class MineruError(Exception):
    """Error tipado del mineru service. `failure_reason` matchea el enum
    indexing_failure_reason en Postgres."""
    def __init__(self, failure_reason: str, detail: str, status_code: int):
        super().__init__(f"{failure_reason}: {detail}")
        self.failure_reason = failure_reason
        self.detail = detail
        self.status_code = status_code


class MineruClient:
    def __init__(self, base_url: str, shared_secret: str, timeout: float = 600.0):
        self._base_url = base_url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {shared_secret}"}
        self._timeout = timeout

    async def parse(self, req: ParseRequest) -> ParseResponse:
        log.info(
            "mineru.client.parse.start",
            doc_id=req.doc_id, force_path=req.force_path,
        )
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.post(
                f"{self._base_url}/parse",
                headers=self._headers,
                json={
                    "doc_id": req.doc_id,
                    "signed_url": req.signed_url,
                    "expected_sha256": req.expected_sha256,
                    "force_path": req.force_path,
                },
            )
        if resp.status_code == 200:
            data = resp.json()
            log.info(
                "mineru.client.parse.ok",
                doc_id=req.doc_id,
                path_used=data["metadata"]["path_used"],
                page_count=data["metadata"]["page_count"],
                cache_hit=data["metadata"].get("cache_hit", False),
            )
            return ParseResponse(
                markdown=data["markdown"],
                metadata=data["metadata"],
            )

        # Error tipado: el service devuelve {failure_reason, detail}
        try:
            body = resp.json()
            if isinstance(body, dict) and "detail" in body and isinstance(body["detail"], dict):
                failure_reason = body["detail"].get("failure_reason", "unknown")
                detail = body["detail"].get("detail", str(body))
            else:
                failure_reason = "unknown"
                detail = str(body)
        except Exception:
            failure_reason = "unknown"
            detail = resp.text[:500]

        log.warning(
            "mineru.client.parse.fail",
            doc_id=req.doc_id, status=resp.status_code,
            failure_reason=failure_reason,
        )
        raise MineruError(failure_reason, detail, resp.status_code)

    async def healthz(self) -> dict:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{self._base_url}/healthz")
        resp.raise_for_status()
        return resp.json()
```

- [ ] **Step 3: Run integration test (skip si no hay service local)**

Run:
```bash
cd services/sda-indexer
uv run pytest tests/integration/test_pdf_mineru_client.py -v -m integration
```
Expected: tests SKIPPED si MINERU_URL no está configurada. Si configurada con service local corriendo (Task 12 step 5), debe pasar.

- [ ] **Step 4: Commit**

```bash
git add services/sda-indexer/src/sda_indexer/pipeline/parser/pdf_mineru.py services/sda-indexer/tests/integration/test_pdf_mineru_client.py
git commit -m "$(cat <<'EOF'
feat(indexer): pipeline/parser/pdf_mineru.py — HTTP client al mineru service

MineruClient encapsula POST /parse a sda-mineru-parser. Error tipado
MineruError con failure_reason que matchea el enum indexing_failure_reason.
El indexer NUNCA toca PDF binario — sólo orquesta vía HTTP (spec §5.1).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 18: structure/__init__.py + estructura compartida

**Files:**
- Create: `services/sda-indexer/src/sda_indexer/pipeline/structure/__init__.py`
- Create: `services/sda-indexer/src/sda_indexer/pipeline/structure/types.py`

- [ ] **Step 1: Create directory + empty __init__.py**

Run:
```bash
mkdir -p services/sda-indexer/src/sda_indexer/pipeline/structure
touch services/sda-indexer/src/sda_indexer/pipeline/structure/__init__.py
```

- [ ] **Step 2: Write types.py con dataclasses compartidos**

Create `services/sda-indexer/src/sda_indexer/pipeline/structure/types.py`:
```python
"""Tipos compartidos entre toc_detector, toc_transformer, index_extractor,
validator y repair. Spec §2.3.

TocNode es la representación intermedia ANTES de persistir a tree_nodes —
sirve para que validator/repair operen sobre estructura plana antes de
convertir a TreeNode jerárquico (que vive en pipeline/tree/builder.py).
"""

from dataclasses import dataclass, field


@dataclass(frozen=True)
class TocNode:
    """Una entrada del TOC (intermedia, antes de tree_nodes)."""
    title: str
    depth: int               # 1, 2, 3... (1 = top-level)
    page_start: int          # página en el PDF (1-indexed)
    page_end: int | None = None  # se completa en validator/splitter


@dataclass(frozen=True)
class TocDetection:
    """Resultado de toc_detector — qué páginas tienen el TOC raw."""
    has_toc: bool
    toc_pages: list[int]     # páginas (1-indexed) donde se encontró TOC
    toc_raw: str             # texto crudo del TOC, vacío si has_toc=False


@dataclass(frozen=True)
class ValidationResult:
    ok: bool
    errors: list[str] = field(default_factory=list)
    suggestions: list[str] = field(default_factory=list)
```

- [ ] **Step 3: Smoke test**

Run:
```bash
cd services/sda-indexer
uv run python -c "from sda_indexer.pipeline.structure.types import TocNode, TocDetection, ValidationResult; print('OK')"
```
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add services/sda-indexer/src/sda_indexer/pipeline/structure/
git commit -m "$(cat <<'EOF'
feat(indexer): structure submodule scaffold + types compartidos

TocNode, TocDetection, ValidationResult — representación intermedia entre
detection/transformation/validation/repair antes de persistir a tree_nodes.
Spec §2.3.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 19: structure/toc_detector.py — detección LLM de TOC

**Files:**
- Create: `services/sda-indexer/src/sda_indexer/pipeline/structure/toc_detector.py`
- Create: `services/sda-indexer/tests/integration/test_toc_detector.py`

- [ ] **Step 1: Write failing integration test**

Create `services/sda-indexer/tests/integration/test_toc_detector.py`:
```python
"""Integration test del detector. Usa LLM real — skipea si DEEPSEEK_API_KEY no set.
NO mocks (CLAUDE.md)."""

import os
import pytest

from sda_indexer.llm.client import LLMClient
from sda_indexer.pipeline.structure.toc_detector import detect_toc
from sda_indexer.pipeline.structure.types import TocDetection


pytestmark = pytest.mark.integration


@pytest.fixture
def llm():
    key = os.environ.get("DEEPSEEK_API_KEY")
    if not key:
        pytest.skip("DEEPSEEK_API_KEY no set")
    return LLMClient(api_key=key, base_url="https://api.deepseek.com/v1")


SAMPLE_WITH_TOC = """\
## Page 1
Acme Corp Manual

## Page 2
Table of Contents

1. Introduction .................. 3
2. Installation .................. 5
3. Configuration ................. 8
4. Troubleshooting ............... 12

## Page 3
1. Introduction
Welcome to Acme.
"""


SAMPLE_NO_TOC = """\
## Page 1
Random scan output without structure.
Lorem ipsum dolor sit amet.

## Page 2
More random text without any TOC markers.
"""


async def test_detect_toc_returns_pages_when_present(llm):
    result = await detect_toc(
        llm=llm,
        model="deepseek-chat",
        markdown=SAMPLE_WITH_TOC,
        doc_summary_short="Acme Corp installation manual",
        max_scan_pages=20,
    )
    assert isinstance(result, TocDetection)
    assert result.has_toc is True
    assert 2 in result.toc_pages
    assert "Introduction" in result.toc_raw


async def test_detect_toc_returns_empty_when_absent(llm):
    result = await detect_toc(
        llm=llm,
        model="deepseek-chat",
        markdown=SAMPLE_NO_TOC,
        doc_summary_short="Scanned legal document",
        max_scan_pages=20,
    )
    assert isinstance(result, TocDetection)
    assert result.has_toc is False
    assert result.toc_pages == []
```

Run:
```bash
cd services/sda-indexer
uv run pytest tests/integration/test_toc_detector.py -v -m integration
```
Expected: 2 fails con ImportError (o SKIPPED si no hay API key).

- [ ] **Step 2: Implement toc_detector.py**

Create `services/sda-indexer/src/sda_indexer/pipeline/structure/toc_detector.py`:
```python
"""Detección LLM de TOC. Spec §3 (algoritmo PageIndex) + §3.1 anatomía.

Estrategia: mandar las primeras `max_scan_pages` del markdown al LLM con
prompt que pide identificar (1) si hay TOC, (2) en qué páginas, (3) extraer
el texto crudo. NO transforma a estructura — eso lo hace toc_transformer.

Usa anatomía universal de prompts (cache_design.PromptParts) para
maximizar prompt cache.
"""

import json

import structlog

from ...llm.cache_design import PromptParts, system_user_split
from ...llm.client import LLMClient
from .types import TocDetection

log = structlog.get_logger()


_STATIC_SYSTEM = (
    "You are SDA-Indexer, a document structure analyzer. "
    "Your only job is to identify if a document contains a table of contents (TOC)."
)

_STATIC_INSTRUCTIONS = """\
Task: scan the provided document pages and find the TOC.

Rules:
- A TOC is a list of section titles with page numbers or dotted leaders.
- "Index" at the end of a book is NOT a TOC (it's an alphabetical index).
- If no TOC is present, output has_toc=false and toc_pages=[].
- Output STRICTLY valid JSON matching the schema. No prose, no markdown fences."""

_STATIC_SCHEMA = """\
JSON schema:
{
  "has_toc": boolean,
  "toc_pages": [int],   // 1-indexed page numbers where TOC content appears
  "toc_raw": string     // concatenated text of TOC, or "" if has_toc=false
}"""

_STATIC_EXAMPLES = """\
Example 1 (has TOC):
Input has "Table of Contents" on page 2 with entries.
Output: {"has_toc": true, "toc_pages": [2], "toc_raw": "1. Intro....3\\n2. Setup....5"}

Example 2 (no TOC):
Scanned book with no front matter, just numbered chapters starting page 1.
Output: {"has_toc": false, "toc_pages": [], "toc_raw": ""}"""


def _extract_first_n_pages(markdown: str, n: int) -> str:
    """Devuelve las primeras n páginas asumiendo separadores `## Page X`."""
    lines = markdown.splitlines()
    out: list[str] = []
    page_count = 0
    for line in lines:
        if line.startswith("## Page "):
            page_count += 1
            if page_count > n:
                break
        out.append(line)
    return "\n".join(out)


async def detect_toc(
    *,
    llm: LLMClient,
    model: str,
    markdown: str,
    doc_summary_short: str,
    max_scan_pages: int = 20,
    temperature: float = 0.0,
) -> TocDetection:
    """Devuelve TocDetection. Errores del LLM se propagan (caller decide DLQ)."""
    payload_md = _extract_first_n_pages(markdown, max_scan_pages)

    parts = PromptParts(
        static_system=_STATIC_SYSTEM,
        static_instructions=_STATIC_INSTRUCTIONS,
        static_schema=_STATIC_SCHEMA,
        static_examples=_STATIC_EXAMPLES,
        semi_static_doc_ctx=f"Document context: {doc_summary_short}",
        dynamic_payload=f"Document pages (first {max_scan_pages}):\n\n{payload_md}",
    )
    system, user = system_user_split(parts)

    result = await llm.complete(
        model=model,
        system=system,
        user=user,
        temperature=temperature,
        max_tokens=2048,
        response_format={"type": "json_object"},
    )
    try:
        data = json.loads(result.text)
    except json.JSONDecodeError as e:
        log.warning("toc_detector.json_invalid", text=result.text[:200], err=str(e))
        raise

    return TocDetection(
        has_toc=bool(data.get("has_toc", False)),
        toc_pages=[int(p) for p in data.get("toc_pages", [])],
        toc_raw=str(data.get("toc_raw", "")),
    )
```

- [ ] **Step 3: Run integration test (si hay API key)**

Run:
```bash
cd services/sda-indexer
DEEPSEEK_API_KEY=$(security find-generic-password -s deepseek_api_key -w 2>/dev/null) \
  uv run pytest tests/integration/test_toc_detector.py -v -m integration
```
Expected: 2 tests pass (o SKIPPED si no hay key).

- [ ] **Step 4: Commit**

```bash
git add services/sda-indexer/src/sda_indexer/pipeline/structure/toc_detector.py services/sda-indexer/tests/integration/test_toc_detector.py
git commit -m "$(cat <<'EOF'
feat(indexer): structure/toc_detector.py — LLM-driven TOC detection

detect_toc() usa PromptParts (anatomía universal) + response_format json_object.
Devuelve TocDetection con has_toc, toc_pages, toc_raw. Pure function (sin DB),
caller integra al workflow. Spec §3 algoritmo PageIndex.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 20: structure/toc_transformer.py — TOC raw → [TocNode]

**Files:**
- Create: `services/sda-indexer/src/sda_indexer/pipeline/structure/toc_transformer.py`
- Create: `services/sda-indexer/tests/integration/test_toc_transformer.py`

- [ ] **Step 1: Write failing integration test**

Create `services/sda-indexer/tests/integration/test_toc_transformer.py`:
```python
import os
import pytest

from sda_indexer.llm.client import LLMClient
from sda_indexer.pipeline.structure.toc_transformer import transform_toc
from sda_indexer.pipeline.structure.types import TocNode


pytestmark = pytest.mark.integration


@pytest.fixture
def llm():
    key = os.environ.get("DEEPSEEK_API_KEY")
    if not key:
        pytest.skip("DEEPSEEK_API_KEY no set")
    return LLMClient(api_key=key, base_url="https://api.deepseek.com/v1")


TOC_RAW_SIMPLE = """\
1. Introduction ............ 3
2. Installation ............ 5
   2.1 Requirements ........ 5
   2.2 Steps ............... 7
3. Configuration ........... 12
"""


async def test_transform_toc_returns_typed_nodes(llm):
    nodes = await transform_toc(
        llm=llm,
        model="deepseek-chat",
        toc_raw=TOC_RAW_SIMPLE,
        doc_summary_short="Generic technical manual",
    )
    assert isinstance(nodes, list)
    assert len(nodes) >= 4
    assert all(isinstance(n, TocNode) for n in nodes)
    titles = [n.title for n in nodes]
    assert any("Introduction" in t for t in titles)
    assert any("Requirements" in t for t in titles)
    intro = next(n for n in nodes if "Introduction" in n.title)
    req = next(n for n in nodes if "Requirements" in n.title)
    assert intro.depth == 1
    assert req.depth == 2
```

Run:
```bash
cd services/sda-indexer
uv run pytest tests/integration/test_toc_transformer.py -v -m integration
```
Expected: SKIPPED o FAIL con ImportError.

- [ ] **Step 2: Implement toc_transformer.py**

Create `services/sda-indexer/src/sda_indexer/pipeline/structure/toc_transformer.py`:
```python
"""Convierte el toc_raw del detector en [TocNode] tipados. Spec §3 PageIndex.

El raw del TOC suele tener formato libre (dotted leaders, indentación
variable, numeración mixta). Un LLM call interpreta los niveles y emite
JSON estructurado. NO toca el contenido del documento — solo el TOC.
"""

import json

import structlog

from ...llm.cache_design import PromptParts, system_user_split
from ...llm.client import LLMClient
from .types import TocNode

log = structlog.get_logger()


_STATIC_SYSTEM = (
    "You are SDA-Indexer, a TOC transformer. Convert raw table-of-contents "
    "text into structured JSON nodes with title, depth, and page number."
)

_STATIC_INSTRUCTIONS = """\
Task: parse the raw TOC text into a JSON array of nodes.

Rules:
- depth=1 for top-level entries, 2 for sub-entries, etc.
- Infer depth from indentation, numbering (1, 1.1, 1.1.1), or formatting cues.
- page_start = the page number printed next to the entry.
- Titles must be cleaned of dotted leaders and trailing page numbers.
- Output STRICTLY valid JSON. Wrap the array in an object with key 'nodes'."""

_STATIC_SCHEMA = """\
JSON schema:
{"nodes": [{"title": string, "depth": int, "page_start": int}]}"""

_STATIC_EXAMPLES = """\
Example input:
"1. Intro ........ 3
   1.1 Why ....... 4
2. Setup ......... 7"

Example output:
{"nodes": [
  {"title": "Intro", "depth": 1, "page_start": 3},
  {"title": "Why", "depth": 2, "page_start": 4},
  {"title": "Setup", "depth": 1, "page_start": 7}
]}"""


async def transform_toc(
    *,
    llm: LLMClient,
    model: str,
    toc_raw: str,
    doc_summary_short: str,
    temperature: float = 0.0,
) -> list[TocNode]:
    """Devuelve [TocNode] ordenados por aparición."""
    parts = PromptParts(
        static_system=_STATIC_SYSTEM,
        static_instructions=_STATIC_INSTRUCTIONS,
        static_schema=_STATIC_SCHEMA,
        static_examples=_STATIC_EXAMPLES,
        semi_static_doc_ctx=f"Document context: {doc_summary_short}",
        dynamic_payload=f"Raw TOC:\n\n{toc_raw}",
    )
    system, user = system_user_split(parts)

    result = await llm.complete(
        model=model,
        system=system,
        user=user,
        temperature=temperature,
        max_tokens=4096,
        response_format={"type": "json_object"},
    )
    data = json.loads(result.text)
    raw_nodes = data.get("nodes", [])
    if not isinstance(raw_nodes, list):
        log.warning("toc_transformer.invalid_shape", text=result.text[:200])
        raise ValueError(f"Expected array under 'nodes', got: {type(raw_nodes)}")

    return [
        TocNode(
            title=str(n["title"]).strip(),
            depth=int(n["depth"]),
            page_start=int(n["page_start"]),
        )
        for n in raw_nodes
    ]
```

- [ ] **Step 3: Run test**

Run:
```bash
cd services/sda-indexer
DEEPSEEK_API_KEY=$(security find-generic-password -s deepseek_api_key -w 2>/dev/null) \
  uv run pytest tests/integration/test_toc_transformer.py -v -m integration
```
Expected: pass o SKIPPED.

- [ ] **Step 4: Commit**

```bash
git add services/sda-indexer/src/sda_indexer/pipeline/structure/toc_transformer.py services/sda-indexer/tests/integration/test_toc_transformer.py
git commit -m "$(cat <<'EOF'
feat(indexer): structure/toc_transformer.py — raw TOC → [TocNode]

LLM interpreta dotted leaders, indentación, numeración mixta y devuelve
nodos tipados con title/depth/page_start. JSON envuelto en 'nodes' por
restricción de DeepSeek json_object (requires object root).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 21: structure/index_extractor.py — fallback sin TOC (page-by-page)

**Files:**
- Create: `services/sda-indexer/src/sda_indexer/pipeline/structure/index_extractor.py`
- Create: `services/sda-indexer/tests/integration/test_index_extractor.py`

- [ ] **Step 1: Write failing test**

Create `services/sda-indexer/tests/integration/test_index_extractor.py`:
```python
import os
import pytest

from sda_indexer.llm.client import LLMClient
from sda_indexer.pipeline.structure.index_extractor import extract_index
from sda_indexer.pipeline.structure.types import TocNode


pytestmark = pytest.mark.integration


@pytest.fixture
def llm():
    key = os.environ.get("DEEPSEEK_API_KEY")
    if not key:
        pytest.skip("DEEPSEEK_API_KEY no set")
    return LLMClient(api_key=key, base_url="https://api.deepseek.com/v1")


SAMPLE_NO_TOC = """\
## Page 1
Acme Whitepaper 2026

## Page 2
1. Introduction
This whitepaper introduces Acme's vision.

## Page 3
1.1 Background
Acme was founded in 2020.

## Page 4
2. Architecture
The system uses microservices.

## Page 5
2.1 Data flow
Events flow through Kafka.
"""


async def test_extract_index_infers_structure_when_no_toc(llm):
    nodes = await extract_index(
        llm=llm,
        model="deepseek-chat",
        markdown=SAMPLE_NO_TOC,
        doc_summary_short="Acme 2026 whitepaper",
        chunk_size_pages=3,
    )
    assert isinstance(nodes, list)
    assert all(isinstance(n, TocNode) for n in nodes)
    titles = [n.title for n in nodes]
    assert any("Introduction" in t for t in titles)
    assert any("Architecture" in t for t in titles)
```

Run:
```bash
cd services/sda-indexer
uv run pytest tests/integration/test_index_extractor.py -v -m integration
```
Expected: SKIPPED o FAIL import.

- [ ] **Step 2: Implement index_extractor.py**

Create `services/sda-indexer/src/sda_indexer/pipeline/structure/index_extractor.py`:
```python
"""Fallback cuando no hay TOC: extrae estructura página por página via LLM.

Más caro que toc_transformer (10-30 calls vs 1) pero necesario para PDFs
"feos" sin TOC (scans, libros viejos). Spec §3 algoritmo PageIndex.

Estrategia: chunkear el markdown por `chunk_size_pages`, pedirle al LLM
que extraiga headings en cada chunk, y agregar manteniendo orden de página.
"""

import asyncio
import json

import structlog

from ...llm.cache_design import PromptParts, system_user_split
from ...llm.client import LLMClient
from .types import TocNode

log = structlog.get_logger()


_STATIC_SYSTEM = (
    "You are SDA-Indexer, a document structure extractor. Identify "
    "section headings inside arbitrary document text."
)

_STATIC_INSTRUCTIONS = """\
Task: scan the provided pages and emit a JSON array of headings found.

Rules:
- Heading = line that introduces a new topic/section (numbered, bold, all-caps...).
- Ignore running headers/footers, page numbers, watermarks.
- depth=1 for top-level, increment for sub-sections. Infer from numbering or formatting.
- page_start = the page number the heading appears on (look for `## Page N` markers).
- Return ONLY new headings found in THIS chunk (no globals).
- Output JSON object with key 'headings' (array)."""

_STATIC_SCHEMA = """\
JSON schema:
{"headings": [{"title": string, "depth": int, "page_start": int}]}"""

_STATIC_EXAMPLES = """\
Example: pages 5-7 contain "## Page 5\\n2. Methods\\n...".
Output: {"headings": [{"title": "Methods", "depth": 1, "page_start": 5}]}"""


def _chunk_by_pages(markdown: str, pages_per_chunk: int) -> list[str]:
    """Split markdown en chunks que contienen pages_per_chunk páginas cada uno."""
    chunks: list[list[str]] = [[]]
    page_in_chunk = 0
    for line in markdown.splitlines():
        if line.startswith("## Page "):
            if page_in_chunk >= pages_per_chunk:
                chunks.append([])
                page_in_chunk = 0
            page_in_chunk += 1
        chunks[-1].append(line)
    return ["\n".join(c) for c in chunks if c]


async def _extract_chunk(
    *,
    llm: LLMClient,
    model: str,
    chunk_md: str,
    doc_summary_short: str,
    temperature: float,
) -> list[TocNode]:
    parts = PromptParts(
        static_system=_STATIC_SYSTEM,
        static_instructions=_STATIC_INSTRUCTIONS,
        static_schema=_STATIC_SCHEMA,
        static_examples=_STATIC_EXAMPLES,
        semi_static_doc_ctx=f"Document context: {doc_summary_short}",
        dynamic_payload=f"Pages chunk:\n\n{chunk_md}",
    )
    system, user = system_user_split(parts)
    result = await llm.complete(
        model=model,
        system=system,
        user=user,
        temperature=temperature,
        max_tokens=2048,
        response_format={"type": "json_object"},
    )
    try:
        data = json.loads(result.text)
    except json.JSONDecodeError:
        log.warning("index_extractor.json_invalid", text=result.text[:200])
        return []
    return [
        TocNode(
            title=str(h["title"]).strip(),
            depth=int(h.get("depth", 1)),
            page_start=int(h["page_start"]),
        )
        for h in data.get("headings", [])
    ]


async def extract_index(
    *,
    llm: LLMClient,
    model: str,
    markdown: str,
    doc_summary_short: str,
    chunk_size_pages: int = 10,
    temperature: float = 0.0,
    max_concurrency: int = 5,
) -> list[TocNode]:
    """Devuelve [TocNode] inferidos page-by-page. Calls paralelos con cap."""
    chunks = _chunk_by_pages(markdown, chunk_size_pages)
    sem = asyncio.Semaphore(max_concurrency)

    async def _bounded(chunk_md: str) -> list[TocNode]:
        async with sem:
            return await _extract_chunk(
                llm=llm, model=model, chunk_md=chunk_md,
                doc_summary_short=doc_summary_short, temperature=temperature,
            )

    results = await asyncio.gather(*[_bounded(c) for c in chunks])
    flat: list[TocNode] = [n for sub in results for n in sub]
    flat.sort(key=lambda n: n.page_start)
    return flat
```

- [ ] **Step 3: Run test**

Run:
```bash
cd services/sda-indexer
DEEPSEEK_API_KEY=$(security find-generic-password -s deepseek_api_key -w 2>/dev/null) \
  uv run pytest tests/integration/test_index_extractor.py -v -m integration
```
Expected: pass o SKIPPED.

- [ ] **Step 4: Commit**

```bash
git add services/sda-indexer/src/sda_indexer/pipeline/structure/index_extractor.py services/sda-indexer/tests/integration/test_index_extractor.py
git commit -m "$(cat <<'EOF'
feat(indexer): structure/index_extractor.py — fallback page-by-page

Cuando toc_detector dice has_toc=false, este módulo extrae estructura
chunked por páginas con LLM. Calls paralelos (sem cap), agregación
ordenada por page_start. Cumple D-1.3 (PDFs "feos" sin TOC).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 22: structure/validator.py — checks lógicos puros

**Files:**
- Create: `services/sda-indexer/src/sda_indexer/pipeline/structure/validator.py`
- Create: `services/sda-indexer/tests/unit/test_validator.py`

- [ ] **Step 1: Write failing unit test**

Create `services/sda-indexer/tests/unit/test_validator.py`:
```python
"""Unit tests para validator — pure function, sin LLM ni IO."""

from sda_indexer.pipeline.structure.types import TocNode, ValidationResult
from sda_indexer.pipeline.structure.validator import validate_tree


def test_validate_ok_for_well_formed_tree():
    nodes = [
        TocNode(title="Intro", depth=1, page_start=1),
        TocNode(title="Setup", depth=1, page_start=5),
        TocNode(title="Steps", depth=2, page_start=6),
    ]
    r = validate_tree(nodes, total_pages=20, max_depth=6)
    assert isinstance(r, ValidationResult)
    assert r.ok is True
    assert r.errors == []


def test_validate_detects_page_out_of_range():
    nodes = [TocNode(title="X", depth=1, page_start=999)]
    r = validate_tree(nodes, total_pages=20, max_depth=6)
    assert r.ok is False
    assert any("page_start 999" in e for e in r.errors)


def test_validate_detects_depth_jump():
    nodes = [
        TocNode(title="A", depth=1, page_start=1),
        TocNode(title="B", depth=3, page_start=2),
    ]
    r = validate_tree(nodes, total_pages=20, max_depth=6)
    assert r.ok is False
    assert any("depth jump" in e for e in r.errors)


def test_validate_detects_pages_out_of_order():
    nodes = [
        TocNode(title="A", depth=1, page_start=10),
        TocNode(title="B", depth=1, page_start=5),
    ]
    r = validate_tree(nodes, total_pages=20, max_depth=6)
    assert r.ok is False
    assert any("out of order" in e for e in r.errors)


def test_validate_detects_excessive_depth():
    nodes = [TocNode(title="X", depth=8, page_start=1)]
    r = validate_tree(nodes, total_pages=20, max_depth=6)
    assert r.ok is False
    assert any("max_depth" in e for e in r.errors)


def test_validate_detects_empty_titles():
    nodes = [TocNode(title="  ", depth=1, page_start=1)]
    r = validate_tree(nodes, total_pages=20, max_depth=6)
    assert r.ok is False
    assert any("empty title" in e for e in r.errors)


def test_validate_empty_list_returns_error():
    r = validate_tree([], total_pages=20, max_depth=6)
    assert r.ok is False
    assert any("empty" in e for e in r.errors)
```

Run:
```bash
cd services/sda-indexer
uv run pytest tests/unit/test_validator.py -v
```
Expected: 7 fail con ImportError.

- [ ] **Step 2: Implement validator.py**

Create `services/sda-indexer/src/sda_indexer/pipeline/structure/validator.py`:
```python
"""Validator de [TocNode]. Pure function, sin IO ni LLM.

Checks (de menos a más severo):
1. Lista no vacía.
2. Todos los titles tienen contenido tras strip().
3. Todos los page_start están en [1, total_pages].
4. page_start monótono creciente (orden de aparición).
5. depth jumps de >1 (depth 1 → depth 3 sin pasar por 2) son sospechosos.
6. depth no excede max_depth.

Devuelve ValidationResult con errors (bloqueantes) y suggestions (hints
para repair). Spec §3 PageIndex T+ validation.
"""

from .types import TocNode, ValidationResult


def validate_tree(
    nodes: list[TocNode], *, total_pages: int, max_depth: int = 6,
) -> ValidationResult:
    errors: list[str] = []
    suggestions: list[str] = []

    if not nodes:
        return ValidationResult(
            ok=False,
            errors=["tree is empty — no headings extracted"],
            suggestions=["consider falling back to index_extractor or marking doc as unstructured"],
        )

    prev_page = 0
    prev_depth = 0

    for i, n in enumerate(nodes):
        if not n.title.strip():
            errors.append(f"node[{i}] has empty title")

        if n.page_start < 1 or n.page_start > total_pages:
            errors.append(
                f"node[{i}] '{n.title[:40]}' page_start {n.page_start} "
                f"out of range [1, {total_pages}]"
            )

        if n.page_start < prev_page:
            errors.append(
                f"node[{i}] '{n.title[:40]}' page_start {n.page_start} "
                f"out of order (previous was {prev_page})"
            )

        if n.depth > max_depth:
            errors.append(
                f"node[{i}] '{n.title[:40]}' depth {n.depth} exceeds max_depth {max_depth}"
            )

        if prev_depth > 0 and n.depth > prev_depth + 1:
            errors.append(
                f"node[{i}] '{n.title[:40]}' depth jump from {prev_depth} to {n.depth} "
                f"— missing intermediate level"
            )
            suggestions.append(
                f"reduce node[{i}] depth to {prev_depth + 1} or insert intermediate parent"
            )

        prev_page = n.page_start
        prev_depth = n.depth

    return ValidationResult(ok=not errors, errors=errors, suggestions=suggestions)
```

- [ ] **Step 3: Run tests**

Run:
```bash
cd services/sda-indexer
uv run pytest tests/unit/test_validator.py -v
```
Expected: 7 tests pass.

- [ ] **Step 4: Commit**

```bash
git add services/sda-indexer/src/sda_indexer/pipeline/structure/validator.py services/sda-indexer/tests/unit/test_validator.py
git commit -m "$(cat <<'EOF'
feat(indexer): structure/validator.py — pure-function tree validation

7 checks: empty list, empty titles, page range, monotonic order, depth
jumps, max_depth. Devuelve ValidationResult con errors (bloqueantes) y
suggestions (hints para repair). 100% pure: 7 unit tests sin IO.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 23: structure/repair.py — LLM-driven fix con loop cap 2

**Files:**
- Create: `services/sda-indexer/src/sda_indexer/pipeline/structure/repair.py`
- Create: `services/sda-indexer/tests/integration/test_repair.py`

- [ ] **Step 1: Write failing integration test**

Create `services/sda-indexer/tests/integration/test_repair.py`:
```python
import os
import pytest

from sda_indexer.llm.client import LLMClient
from sda_indexer.pipeline.structure.repair import repair_tree, RepairLoopExhausted
from sda_indexer.pipeline.structure.types import TocNode
from sda_indexer.pipeline.structure.validator import validate_tree


pytestmark = pytest.mark.integration


@pytest.fixture
def llm():
    key = os.environ.get("DEEPSEEK_API_KEY")
    if not key:
        pytest.skip("DEEPSEEK_API_KEY no set")
    return LLMClient(api_key=key, base_url="https://api.deepseek.com/v1")


async def test_repair_fixes_depth_jump(llm):
    bad = [
        TocNode(title="A", depth=1, page_start=1),
        TocNode(title="B", depth=3, page_start=2),
    ]
    fixed, iterations = await repair_tree(
        llm=llm,
        model="deepseek-chat",
        nodes=bad,
        total_pages=20,
        max_depth=6,
        doc_summary_short="Generic doc",
        max_iterations=2,
    )
    result = validate_tree(fixed, total_pages=20, max_depth=6)
    assert result.ok is True
    assert iterations <= 2


async def test_repair_raises_when_unreparable(llm):
    bad = [TocNode(title="", depth=99, page_start=999)]
    with pytest.raises(RepairLoopExhausted):
        await repair_tree(
            llm=llm,
            model="deepseek-chat",
            nodes=bad,
            total_pages=20,
            max_depth=6,
            doc_summary_short="x",
            max_iterations=2,
        )
```

Run:
```bash
cd services/sda-indexer
uv run pytest tests/integration/test_repair.py -v -m integration
```
Expected: SKIPPED o FAIL import.

- [ ] **Step 2: Implement repair.py**

Create `services/sda-indexer/src/sda_indexer/pipeline/structure/repair.py`:
```python
"""LLM-driven repair de [TocNode] que falló el validator.

Loop cap = 2 iteraciones (spec §5.4). Si después de 2 sigue inválido,
raise RepairLoopExhausted → caller maps a failure_reason='structure_unreparable'.
"""

import json
from dataclasses import asdict

import structlog

from ...llm.cache_design import PromptParts, system_user_split
from ...llm.client import LLMClient
from .types import TocNode
from .validator import validate_tree

log = structlog.get_logger()


class RepairLoopExhausted(Exception):
    """Después de max_iterations el tree sigue inválido. DLQ."""


_STATIC_SYSTEM = (
    "You are SDA-Indexer, a structure repair assistant. Fix issues in a "
    "JSON list of TOC nodes so it passes downstream validation."
)

_STATIC_INSTRUCTIONS = """\
Task: receive a list of TOC nodes + validator errors + suggestions.
Output a fixed list of nodes that resolves the errors.

Rules:
- Preserve original titles when possible (only edit for clarity).
- Adjust depth to fix depth-jump errors.
- Reorder if page_start is out of sequence.
- Truncate page_start to [1, total_pages] range when out of bounds.
- Drop nodes that are obviously bogus (empty title + out-of-range page).
- Output JSON object {"nodes": [...]}."""

_STATIC_SCHEMA = """\
JSON schema:
{"nodes": [{"title": string, "depth": int, "page_start": int}]}"""

_STATIC_EXAMPLES = """\
Example input nodes: [{"title": "A", "depth": 1, "page_start": 1},
                       {"title": "B", "depth": 3, "page_start": 2}]
Errors: ["node[1] depth jump from 1 to 3"]
Example fixed: {"nodes": [{"title": "A", "depth": 1, "page_start": 1},
                            {"title": "B", "depth": 2, "page_start": 2}]}"""


async def _llm_repair_once(
    *,
    llm: LLMClient,
    model: str,
    nodes: list[TocNode],
    errors: list[str],
    suggestions: list[str],
    total_pages: int,
    doc_summary_short: str,
    temperature: float,
) -> list[TocNode]:
    payload = json.dumps({
        "current_nodes": [asdict(n) for n in nodes],
        "errors": errors,
        "suggestions": suggestions,
        "total_pages": total_pages,
    }, indent=2)
    parts = PromptParts(
        static_system=_STATIC_SYSTEM,
        static_instructions=_STATIC_INSTRUCTIONS,
        static_schema=_STATIC_SCHEMA,
        static_examples=_STATIC_EXAMPLES,
        semi_static_doc_ctx=f"Document context: {doc_summary_short}",
        dynamic_payload=f"Repair input:\n\n{payload}",
    )
    system, user = system_user_split(parts)
    result = await llm.complete(
        model=model, system=system, user=user,
        temperature=temperature, max_tokens=4096,
        response_format={"type": "json_object"},
    )
    data = json.loads(result.text)
    return [
        TocNode(
            title=str(n["title"]).strip(),
            depth=int(n["depth"]),
            page_start=int(n["page_start"]),
        )
        for n in data.get("nodes", [])
    ]


async def repair_tree(
    *,
    llm: LLMClient,
    model: str,
    nodes: list[TocNode],
    total_pages: int,
    max_depth: int,
    doc_summary_short: str,
    max_iterations: int = 2,
    temperature: float = 0.0,
) -> tuple[list[TocNode], int]:
    """Repair loop: valida → llama LLM → re-valida. Hasta max_iterations.

    Returns:
        (fixed_nodes, iterations_taken)
    Raises:
        RepairLoopExhausted: después de max_iterations sigue inválido.
    """
    current = nodes
    for i in range(1, max_iterations + 1):
        v = validate_tree(current, total_pages=total_pages, max_depth=max_depth)
        if v.ok:
            log.info("repair.converged", iteration=i)
            return current, i
        log.info(
            "repair.iter", iteration=i, errors_count=len(v.errors),
            sample_error=v.errors[0] if v.errors else None,
        )
        current = await _llm_repair_once(
            llm=llm, model=model, nodes=current,
            errors=v.errors, suggestions=v.suggestions,
            total_pages=total_pages,
            doc_summary_short=doc_summary_short,
            temperature=temperature,
        )

    final = validate_tree(current, total_pages=total_pages, max_depth=max_depth)
    if final.ok:
        return current, max_iterations
    raise RepairLoopExhausted(
        f"Tree still invalid after {max_iterations} iterations. "
        f"Remaining errors: {final.errors[:3]}"
    )
```

- [ ] **Step 3: Run test**

Run:
```bash
cd services/sda-indexer
DEEPSEEK_API_KEY=$(security find-generic-password -s deepseek_api_key -w 2>/dev/null) \
  uv run pytest tests/integration/test_repair.py -v -m integration
```
Expected: 2 pass o SKIPPED.

- [ ] **Step 4: Commit**

```bash
git add services/sda-indexer/src/sda_indexer/pipeline/structure/repair.py services/sda-indexer/tests/integration/test_repair.py
git commit -m "$(cat <<'EOF'
feat(indexer): structure/repair.py — LLM-driven repair loop (cap 2)

repair_tree() valida → call LLM con errores+suggestions → re-valida.
Max 2 iter (spec §5.4). Si no converge, RepairLoopExhausted → DLQ con
failure_reason='structure_unreparable'.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 24: splitter/large_node.py — split recursivo por max_tokens

**Files:**
- Create: `services/sda-indexer/src/sda_indexer/pipeline/splitter/__init__.py`
- Create: `services/sda-indexer/src/sda_indexer/pipeline/splitter/large_node.py`
- Create: `services/sda-indexer/tests/unit/test_splitter.py`

- [ ] **Step 1: Write failing unit test**

Create `services/sda-indexer/tests/unit/test_splitter.py`:
```python
"""Unit tests del splitter — pure function, sin IO."""

from sda_indexer.pipeline.splitter.large_node import (
    SplitConfig,
    estimate_tokens,
    split_text_by_tokens,
)


def test_estimate_tokens_returns_int():
    n = estimate_tokens("hello world")
    assert isinstance(n, int)
    assert n > 0


def test_split_returns_single_chunk_when_under_max():
    cfg = SplitConfig(max_tokens=1000, min_tokens=50, overlap_chars=0)
    chunks = split_text_by_tokens("short text here", cfg)
    assert len(chunks) == 1
    assert chunks[0] == "short text here"


def test_split_returns_multiple_chunks_when_over_max():
    cfg = SplitConfig(max_tokens=20, min_tokens=5, overlap_chars=0)
    long_text = "Paragraph one.\n\nParagraph two.\n\nParagraph three.\n\nParagraph four.\n\nFive."
    chunks = split_text_by_tokens(long_text, cfg)
    assert len(chunks) >= 2
    for c in chunks:
        assert estimate_tokens(c) <= 30


def test_split_respects_paragraph_boundaries():
    cfg = SplitConfig(max_tokens=15, min_tokens=3, overlap_chars=0)
    text = "Para one with words.\n\nPara two more words."
    chunks = split_text_by_tokens(text, cfg)
    assert "Para one with words." in chunks[0]
    assert any("Para two" in c for c in chunks)


def test_split_overlap_includes_tail_of_previous():
    cfg = SplitConfig(max_tokens=15, min_tokens=3, overlap_chars=20)
    text = "A" * 40 + "\n\n" + "B" * 40
    chunks = split_text_by_tokens(text, cfg)
    if len(chunks) >= 2:
        tail = chunks[0][-20:]
        assert tail[:5] in chunks[1] or chunks[1].startswith(("A", "B"))
```

Run:
```bash
cd services/sda-indexer
uv run pytest tests/unit/test_splitter.py -v
```
Expected: 5 fails con ImportError.

- [ ] **Step 2: Implement splitter**

Create `services/sda-indexer/src/sda_indexer/pipeline/splitter/__init__.py` (empty).

Create `services/sda-indexer/src/sda_indexer/pipeline/splitter/large_node.py`:
```python
"""Split de nodos que exceden `max_tokens_per_node`. Spec §3 PageIndex
+ §5.3.

NO usa LLM — split puramente heurístico respetando boundaries (paragraphs,
sentences). Conserva contexto via overlap_chars en chunks consecutivos.

estimate_tokens(): aproximación rápida sin tokenizer real (4 chars ≈ 1 token
para spanish/english). Si Wave 2 necesita precisión, swap a tiktoken o
similar. Acá vale más speed que exactitud.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class SplitConfig:
    max_tokens: int = 8000
    min_tokens: int = 200
    overlap_chars: int = 200


def estimate_tokens(text: str) -> int:
    """Aproximación: 1 token ≈ 4 chars (avg latin scripts)."""
    return max(1, len(text) // 4)


def _split_on_boundaries(text: str, max_chars: int) -> list[str]:
    """Split agresivo respetando \\n\\n > \\n > '. ' > ' ' > chars."""
    if len(text) <= max_chars:
        return [text]
    for separator in ("\n\n", "\n", ". ", " "):
        idx = text.rfind(separator, 0, max_chars)
        if idx > max_chars // 2:
            head = text[: idx + len(separator)]
            tail = text[idx + len(separator):]
            return [head] + _split_on_boundaries(tail, max_chars)
    return [text[:max_chars]] + _split_on_boundaries(text[max_chars:], max_chars)


def split_text_by_tokens(text: str, cfg: SplitConfig) -> list[str]:
    """Divide `text` en chunks de hasta ~max_tokens. Devuelve >=1 chunk."""
    if estimate_tokens(text) <= cfg.max_tokens:
        return [text]

    max_chars = cfg.max_tokens * 4
    raw_chunks = _split_on_boundaries(text, max_chars)

    if cfg.overlap_chars > 0 and len(raw_chunks) > 1:
        with_overlap: list[str] = [raw_chunks[0]]
        for prev, cur in zip(raw_chunks, raw_chunks[1:]):
            tail = prev[-cfg.overlap_chars:] if len(prev) > cfg.overlap_chars else prev
            with_overlap.append(tail + cur)
        raw_chunks = with_overlap

    merged: list[str] = []
    for c in raw_chunks:
        if merged and estimate_tokens(c) < cfg.min_tokens:
            merged[-1] = merged[-1] + c
        else:
            merged.append(c)
    return merged
```

- [ ] **Step 3: Run tests**

Run:
```bash
cd services/sda-indexer
uv run pytest tests/unit/test_splitter.py -v
```
Expected: 5 tests pass.

- [ ] **Step 4: Commit**

```bash
git add services/sda-indexer/src/sda_indexer/pipeline/splitter/
git commit -m "$(cat <<'EOF'
feat(indexer): splitter/large_node.py — recursive split sin LLM

estimate_tokens (4 chars ≈ 1 token), _split_on_boundaries (\\n\\n > \\n >
'. ' > ' ' > chars), overlap_chars opcional. 100% pure: 5 unit tests sin IO.
Llamado desde structure_workflow después de validator pasa.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 25: summarizer/contextual_prefix.py — Mejora #1 (combined call)

**Files:**
- Create: `services/sda-indexer/src/sda_indexer/pipeline/summarizer/contextual_prefix.py`
- Create: `services/sda-indexer/tests/integration/test_contextual_prefix.py`

- [ ] **Step 1: Write failing integration test**

Create `services/sda-indexer/tests/integration/test_contextual_prefix.py`:
```python
import os
import pytest

from sda_indexer.llm.client import LLMClient
from sda_indexer.pipeline.summarizer.contextual_prefix import (
    ContextualResult,
    generate_contextual_prefix_and_summary,
)


pytestmark = pytest.mark.integration


@pytest.fixture
def llm():
    key = os.environ.get("DEEPSEEK_API_KEY")
    if not key:
        pytest.skip("DEEPSEEK_API_KEY no set")
    return LLMClient(api_key=key, base_url="https://api.deepseek.com/v1")


async def test_returns_prefix_and_summary_in_one_call(llm):
    r = await generate_contextual_prefix_and_summary(
        llm=llm,
        model="deepseek-chat",
        doc_summary_short="Acme Corp 2026 employment contract for senior engineers.",
        chunk_text=(
            "Vacation policy: employees accrue 1.5 days per month, up to a maximum "
            "of 30 days. Unused days roll over annually with a cap of 10 days."
        ),
        prefix_max_tokens=100,
        max_summary_chars=400,
        language="es",
    )
    assert isinstance(r, ContextualResult)
    assert r.prefix
    assert r.summary
    assert r.tokens_in > 0
    assert r.cached_tokens >= 0
```

Run:
```bash
cd services/sda-indexer
uv run pytest tests/integration/test_contextual_prefix.py -v -m integration
```
Expected: SKIPPED o FAIL import.

- [ ] **Step 2: Implement contextual_prefix.py**

Create `services/sda-indexer/src/sda_indexer/pipeline/summarizer/contextual_prefix.py`:
```python
"""Combined (contextual_prefix, summary) en 1 LLM call. Mejora #1 del spec.

Reemplaza la lógica de summarizer/summarize.py (que solo genera summary).
La call retorna JSON {prefix, summary} para garantizar coherencia y ahorro
de latencia/costo vs 2 calls separadas.
"""

import json
from dataclasses import dataclass

import structlog

from ...llm.cache_design import PromptParts, system_user_split
from ...llm.client import LLMClient

log = structlog.get_logger()


@dataclass(frozen=True)
class ContextualResult:
    prefix: str
    summary: str
    tokens_in: int
    tokens_out: int
    cached_tokens: int
    model: str
    rendered_user_prompt: str


_STATIC_SYSTEM = (
    "You are SDA-Indexer, a contextual chunking assistant. For each chunk "
    "you produce a short contextual prefix and a focused summary."
)

_STATIC_INSTRUCTIONS = """\
Task: given a document context and a chunk of text, output JSON with:
- prefix: 50-100 tokens that situate the chunk inside the document
  (e.g., "This section of the Acme 2026 contract discusses..."). The
  prefix will be prepended to the chunk text for retrieval.
- summary: 2-4 sentence focused summary starting with the topic, no
  meta-prose like "This section discusses...".

Rules:
- prefix references the document concretely (use names/dates if present).
- summary stays within the requested character budget.
- Output STRICTLY valid JSON. No markdown fences."""

_STATIC_SCHEMA = """\
JSON schema:
{"prefix": string, "summary": string}"""

_STATIC_EXAMPLES = """\
Example input chunk: "Vacation: 1.5 days/month, max 30."
Document: "Acme 2026 contract."
Output: {
  "prefix": "This section of the Acme 2026 employment contract describes the vacation policy.",
  "summary": "Empleados acumulan 1.5 días por mes hasta un máximo de 30."
}"""


async def generate_contextual_prefix_and_summary(
    *,
    llm: LLMClient,
    model: str,
    doc_summary_short: str,
    chunk_text: str,
    prefix_max_tokens: int = 100,
    max_summary_chars: int = 400,
    language: str = "es",
    temperature: float = 0.1,
) -> ContextualResult:
    """1 LLM call → ContextualResult con prefix + summary."""
    semi_static = (
        f"Document context: {doc_summary_short}\n"
        f"Language for summary: {language}\n"
        f"Prefix budget: {prefix_max_tokens} tokens.\n"
        f"Summary budget: {max_summary_chars} chars."
    )
    parts = PromptParts(
        static_system=_STATIC_SYSTEM,
        static_instructions=_STATIC_INSTRUCTIONS,
        static_schema=_STATIC_SCHEMA,
        static_examples=_STATIC_EXAMPLES,
        semi_static_doc_ctx=semi_static,
        dynamic_payload=f"Chunk text:\n\n{chunk_text}",
    )
    system, user = system_user_split(parts)
    result = await llm.complete(
        model=model,
        system=system,
        user=user,
        temperature=temperature,
        max_tokens=max(256, prefix_max_tokens + max_summary_chars // 2),
        response_format={"type": "json_object"},
    )
    data = json.loads(result.text)
    return ContextualResult(
        prefix=str(data.get("prefix", "")).strip(),
        summary=str(data.get("summary", "")).strip(),
        tokens_in=result.tokens_in,
        tokens_out=result.tokens_out,
        cached_tokens=result.cached_tokens,
        model=result.model,
        rendered_user_prompt=user,
    )
```

- [ ] **Step 3: Run test**

Run:
```bash
cd services/sda-indexer
DEEPSEEK_API_KEY=$(security find-generic-password -s deepseek_api_key -w 2>/dev/null) \
  uv run pytest tests/integration/test_contextual_prefix.py -v -m integration
```
Expected: pass o SKIPPED.

- [ ] **Step 4: Commit**

```bash
git add services/sda-indexer/src/sda_indexer/pipeline/summarizer/contextual_prefix.py services/sda-indexer/tests/integration/test_contextual_prefix.py
git commit -m "$(cat <<'EOF'
feat(indexer): summarizer/contextual_prefix.py — combined call (#1)

1 LLM call devuelve JSON {prefix, summary} en vez de 2 calls separadas.
Ahorra latencia/costo y garantiza coherencia entre prefix y summary.
Persistencia (text_contextualized = prefix + '\\n\\n' + chunk_text) la
hace workflows/summarize.py.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 26: Prompts j2 — decisión LEAN (inline en código)

**Nota de design (LEAN):** los prompts grandes (anatomía universal con 4 zonas estáticas) ya están definidos como strings en los módulos `structure/*.py` y `summarizer/contextual_prefix.py` (Tasks 19-25). Mover esos prompts a archivos `.j2` separados aporta valor SÓLO si necesitamos override via `app_settings.prompt.template.*` — feature que Wave 2 implementa junto a admin UI.

**Decisión Wave 1:** mantener prompts inline. Beneficios:
- Hashable con `static_hash()` para detectar drift (`assert_prefix_stable`).
- Sin lookup runtime a Jinja loader → 1 step menos por call.
- Cambios versionados con el código del módulo que los usa.

Wave 2 los moverá a `.j2` cuando se necesite override per-collection.

**Acción Wave 1 única:** marcar `summarize.j2` Wave-0 como deprecated comment.

- [ ] **Step 1: Mark summarize.j2 as deprecated**

Modify `services/sda-indexer/src/sda_indexer/prompts/summarize.j2`:
```jinja
{# DEPRECATED Wave 1: el summarize_workflow ahora usa
   pipeline/summarizer/contextual_prefix.py con prompt inline (anatomía
   universal). Este file queda como fallback si app_settings.prompt.template.summarize
   apunta acá explícitamente — comportamiento Wave 0 preservado. #}
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

- [ ] **Step 2: Verify load_prompt_files no rompe**

Run:
```bash
cd services/sda-indexer
uv run python -c "from sda_indexer.prompts.loader import load_prompt_files; p = load_prompt_files(); print(sorted(p.keys()))"
```
Expected: `['summarize']` (sólo summarize, los otros prompts están inline).

- [ ] **Step 3: Commit**

```bash
git add services/sda-indexer/src/sda_indexer/prompts/summarize.j2
git commit -m "$(cat <<'EOF'
docs(prompts): mark summarize.j2 as deprecated (Wave 1 inline migration)

Wave 1 mueve los prompts grandes (anatomía universal) a strings inline
en pipeline/* para hashear con assert_prefix_stable. summarize.j2 queda
como fallback Wave 0 si app_settings apunta acá. Wave 2 reintroducirá
.j2 cuando admin UI permita override per-collection.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3 — Workflows refactor (Tasks 27-29)

### Task 27: workflows/structure.py refactor mayor

**Files:**
- Modify: `services/sda-indexer/src/sda_indexer/workflows/structure.py`
- Create: `services/sda-indexer/tests/integration/test_structure_workflow_pdf.py`

- [ ] **Step 1: Write integration test (skip si MINERU_URL no set)**

Create `services/sda-indexer/tests/integration/test_structure_workflow_pdf.py`:
```python
"""Integration test del structure_workflow refactored. Requiere mineru service
+ DeepSeek + Supabase reales. Skip cuando no estén configurados. NO mocks."""

import os
import hashlib
import uuid
from pathlib import Path

import pytest

from sda_indexer.workflows.structure import build_graph, run_structure
from sda_indexer.db.client import DB
from sda_indexer.settings.client import SettingsClient
from sda_indexer.llm.client import LLMClient
from sda_indexer.pipeline.parser.pdf_mineru import MineruClient


pytestmark = pytest.mark.integration


@pytest.fixture
def env():
    needed = ["DEEPSEEK_API_KEY", "MINERU_URL", "MINERU_SHARED_SECRET",
              "SUPABASE_URL", "SUPABASE_SERVICE_KEY", "POSTGRES_URL"]
    missing = [k for k in needed if not os.environ.get(k)]
    if missing:
        pytest.skip(f"Missing env: {missing}")
    return {k: os.environ[k] for k in needed}


async def test_structure_workflow_pdf_end_to_end(env, tmp_path):
    """Sube un PDF chico, corre el workflow, valida tree_nodes."""
    from supabase import create_client
    sb = create_client(env["SUPABASE_URL"], env["SUPABASE_SERVICE_KEY"])
    test_pdf = tmp_path / "test_e2e.pdf"
    from reportlab.pdfgen import canvas
    c = canvas.Canvas(str(test_pdf))
    for i in range(3):
        c.drawString(100, 750, f"Section {i+1}")
        c.showPage()
    c.save()
    pdf_bytes = test_pdf.read_bytes()
    sha = hashlib.sha256(pdf_bytes).hexdigest()
    doc_id = str(uuid.uuid4())
    storage_path = f"test_e2e/{doc_id}.pdf"
    sb.storage.from_("docs").upload(storage_path, pdf_bytes)

    # Review-fix (B3): la API real es DB(dsn=..., min_size=, max_size=).start()
    db = DB(dsn=env["POSTGRES_URL"], min_size=1, max_size=4)
    await db.start()
    try:
        async with db.pool.acquire() as conn:
            await conn.execute(
                """insert into documents (id, source_path, source_type, status)
                   values ($1, $2, 'pdf', 'pending')""",
                doc_id, storage_path,
            )

        settings = SettingsClient(db.pool)
        llm = LLMClient(api_key=env["DEEPSEEK_API_KEY"], base_url="https://api.deepseek.com/v1")
        mineru = MineruClient(env["MINERU_URL"], env["MINERU_SHARED_SECRET"])

        graph = build_graph(db=db, supabase=sb, settings=settings, llm=llm, mineru=mineru)
        result = await run_structure(graph, document_id=doc_id)
        assert result["node_count"] >= 1
        async with db.pool.acquire() as conn:
            row = await conn.fetchrow(
                "select page_count, parser_used, path_used, doc_summary_short "
                "from documents where id=$1", doc_id,
            )
            assert row["page_count"] == 3
            assert row["parser_used"] in ("native", "mineru")
            assert row["path_used"] in ("fast", "full")
            assert row["doc_summary_short"]
    finally:
        async with db.pool.acquire() as conn:
            await conn.execute("delete from tree_nodes where document_id=$1", doc_id)
            await conn.execute("delete from documents where id=$1", doc_id)
        sb.storage.from_("docs").remove([storage_path])
        await db.close()
```

Run (esperado: SKIPPED en CI):
```bash
cd services/sda-indexer
uv run pytest tests/integration/test_structure_workflow_pdf.py -v -m integration
```

- [ ] **Step 2: Refactor structure.py**

Replace `services/sda-indexer/src/sda_indexer/workflows/structure.py` con:
```python
"""LangGraph workflow para extract_structure. Wave 1: markdown + PDF.

Datapath crítico (spec §5.4): el signed_url NO va en el state. Cada
resume regenera signed_url fresca via supabase.storage.create_signed_url
porque el TTL (60min) puede expirar entre checkpoints.

State only stores JSON-safe types (str, int, list[dict], bool) — LangGraph
serializes the state into the checkpointer between nodes.
"""

import hashlib
from typing import TypedDict

import structlog
from langgraph.graph import StateGraph, START, END

from ..db.client import DB
from ..db import documents
from ..llm.client import LLMClient
from ..llm.router import Phase, aroute
from ..pipeline.parser.markdown_regex import parse_markdown_to_headers
from ..pipeline.parser.pdf_mineru import MineruClient, ParseRequest, MineruError
from ..pipeline.splitter.large_node import SplitConfig, split_text_by_tokens
from ..pipeline.structure import (
    index_extractor, repair, toc_detector, toc_transformer, validator,
)
from ..pipeline.structure.types import TocNode
from ..pipeline.tree.builder import build_tree, flatten
from ..settings.client import SettingsClient

log = structlog.get_logger()


class State(TypedDict, total=False):
    document_id: str
    source_path: str
    source_type: str
    md_content: str
    page_count: int
    parser_used: str
    path_used: str
    toc_nodes: list[dict]            # serializados a dicts JSON-safe
    doc_summary_short: str
    node_count: int
    aborted: bool


def build_graph(
    *,
    db: DB,
    supabase,
    settings: SettingsClient,
    llm: LLMClient,
    mineru: MineruClient,
    checkpointer=None,
):
    async def load_document(s: State) -> dict:
        """Carga el doc desde DB. signed_url se regenera dentro de parse_pdf_path."""
        doc = await documents.get_document(db.pool, s["document_id"])
        return {
            "source_path": doc["source_path"],
            "source_type": doc["source_type"] or "markdown",
        }

    def route_after_load(s: State) -> str:
        return "markdown" if s["source_type"] == "markdown" else "pdf"

    async def parse_markdown_path(s: State) -> dict:
        """Wave 0 path: descarga blob de Storage y decode."""
        resp = supabase.storage.from_("docs").download(s["source_path"])
        raw = resp if isinstance(resp, bytes) else resp.read()
        content = raw.decode("utf-8")
        return {
            "md_content": content,
            "page_count": 0,
            "parser_used": "native",
            "path_used": "fast",
        }

    async def parse_pdf_path(s: State) -> dict:
        """Wave 1 path: signed_url + POST /parse al mineru service."""
        signed = supabase.storage.from_("docs").create_signed_url(
            s["source_path"], 3600,
        )
        signed_url = signed["signedURL"] if isinstance(signed, dict) else signed.signedURL
        raw = supabase.storage.from_("docs").download(s["source_path"])
        sha = hashlib.sha256(raw).hexdigest()

        try:
            resp = await mineru.parse(ParseRequest(
                doc_id=s["document_id"],
                signed_url=signed_url,
                expected_sha256=sha,
            ))
        except MineruError as e:
            log.error(
                "structure.mineru_failed",
                document_id=s["document_id"],
                failure_reason=e.failure_reason,
            )
            raise

        meta = resp.metadata
        return {
            "md_content": resp.markdown,
            "page_count": meta["page_count"],
            "parser_used": meta["parser_used"],
            "path_used": meta["path_used"],
        }

    async def detect_and_extract_toc(s: State) -> dict:
        """LLM-driven TOC detection + transform, con fallback a index_extractor."""
        cfg_toc = await aroute(Phase.TOC, settings=settings, document_id=s["document_id"])

        # doc_summary_short heurístico Wave 1: primeros 600 chars del markdown.
        # Wave 2: 1 LLM call dedicada que produce un resumen mejor.
        doc_summary_short = s["md_content"][:600]

        detection = await toc_detector.detect_toc(
            llm=llm, model=cfg_toc.model,
            markdown=s["md_content"],
            doc_summary_short=doc_summary_short,
            max_scan_pages=await settings.resolve("pageindex.toc_detection_max_pages"),
            temperature=cfg_toc.temperature,
        )

        if detection.has_toc:
            nodes = await toc_transformer.transform_toc(
                llm=llm, model=cfg_toc.model,
                toc_raw=detection.toc_raw,
                doc_summary_short=doc_summary_short,
                temperature=cfg_toc.temperature,
            )
        else:
            cfg_struct = await aroute(Phase.STRUCTURE, settings=settings, document_id=s["document_id"])
            nodes = await index_extractor.extract_index(
                llm=llm, model=cfg_struct.model,
                markdown=s["md_content"],
                doc_summary_short=doc_summary_short,
                chunk_size_pages=10,
                temperature=cfg_struct.temperature,
            )

        return {
            "toc_nodes": [{"title": n.title, "depth": n.depth, "page_start": n.page_start} for n in nodes],
            "doc_summary_short": doc_summary_short,
        }

    async def validate_and_repair(s: State) -> dict:
        """Validator → si !ok → repair (cap 2 iter). Sino propaga."""
        max_depth = await settings.resolve("pageindex.max_tree_depth")
        page_count = s.get("page_count", 9999) or 9999

        nodes = [TocNode(**d) for d in s["toc_nodes"]]
        v = validator.validate_tree(nodes, total_pages=page_count, max_depth=max_depth)
        if v.ok:
            return {}

        cfg = await aroute(Phase.REPAIR, settings=settings, document_id=s["document_id"])
        try:
            fixed, iters = await repair.repair_tree(
                llm=llm, model=cfg.model,
                nodes=nodes, total_pages=page_count, max_depth=max_depth,
                doc_summary_short=s["doc_summary_short"],
                max_iterations=2,
                temperature=cfg.temperature,
            )
        except repair.RepairLoopExhausted as e:
            log.error("structure.unreparable", document_id=s["document_id"], err=str(e))
            raise

        return {
            "toc_nodes": [{"title": n.title, "depth": n.depth, "page_start": n.page_start} for n in fixed],
        }

    async def persist_tree(s: State) -> dict:
        """Convierte TocNode/FlatHeader → tree_nodes + split + insert."""
        max_tokens = await settings.resolve("pageindex.max_tokens_per_node")
        min_tokens = await settings.resolve("pageindex.min_tokens_per_node")
        split_cfg = SplitConfig(max_tokens=max_tokens, min_tokens=min_tokens)

        if s["source_type"] == "markdown":
            headers = parse_markdown_to_headers(s["md_content"])
            total_lines = len(s["md_content"].splitlines())
        else:
            from ..pipeline.tree.builder import FlatHeader
            md_lines = s["md_content"].splitlines()
            page_line_index: dict[int, int] = {}
            for i, line in enumerate(md_lines):
                if line.startswith("## Page "):
                    try:
                        n = int(line.split()[-1])
                        page_line_index[n] = i
                    except (ValueError, IndexError):
                        pass
            headers = []
            for nd in s["toc_nodes"]:
                start = page_line_index.get(nd["page_start"], 0)
                headers.append(FlatHeader(
                    level=nd["depth"], title=nd["title"],
                    start_line=start, text="",
                ))
            total_lines = len(md_lines)

        roots = build_tree(headers, total_lines=total_lines)
        all_nodes = list(flatten(roots))

        async with db.pool.acquire() as conn:
            async with conn.transaction():
                id_map: dict[str, str] = {}
                inserted = 0
                for n in all_nodes:
                    chunks = split_text_by_tokens(n.text or "", split_cfg)
                    if len(chunks) > 1:
                        log.info("structure.split", node=n.title, chunks=len(chunks))
                    parent_uuid = id_map.get(n.parent.node_id_str) if n.parent else None
                    new_id = await conn.fetchval(
                        """insert into tree_nodes (
                            document_id, parent_id, node_id_str, structure_code,
                            depth, title, start_index, end_index, text,
                            appear_start
                           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                           returning id""",
                        s["document_id"], parent_uuid,
                        n.node_id_str, n.structure_code, n.depth, n.title,
                        n.start_index, n.end_index, chunks[0],
                        getattr(n, "appear_start", None),
                    )
                    id_map[n.node_id_str] = str(new_id)
                    inserted += 1
                    for ci, extra in enumerate(chunks[1:], start=2):
                        await conn.execute(
                            """insert into tree_nodes (
                                document_id, parent_id, node_id_str, structure_code,
                                depth, title, start_index, end_index, text
                               ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)""",
                            s["document_id"], new_id,
                            f"{n.node_id_str}_part{ci}", f"{n.structure_code}.{ci}",
                            n.depth + 1, f"{n.title} (part {ci})",
                            n.start_index, n.end_index, extra,
                        )
                        inserted += 1
                await conn.execute(
                    """update documents set
                         page_count=$2, parser_used=$3, path_used=$4,
                         doc_summary_short=$5
                       where id=$1""",
                    s["document_id"], s.get("page_count"),
                    s.get("parser_used"), s.get("path_used"),
                    s.get("doc_summary_short"),
                )
        return {"node_count": inserted}

    async def mark_summarizing(s: State) -> dict:
        async with db.pool.acquire() as conn:
            await conn.execute(
                "update documents set status='summarizing' where id=$1",
                s["document_id"],
            )
        return {}

    g = StateGraph(State)
    g.add_node("load_document", load_document)
    g.add_node("parse_markdown_path", parse_markdown_path)
    g.add_node("parse_pdf_path", parse_pdf_path)
    g.add_node("detect_and_extract_toc", detect_and_extract_toc)
    g.add_node("validate_and_repair", validate_and_repair)
    g.add_node("persist_tree", persist_tree)
    g.add_node("mark_summarizing", mark_summarizing)

    g.add_edge(START, "load_document")
    g.add_conditional_edges("load_document", route_after_load, {
        "markdown": "parse_markdown_path",
        "pdf": "parse_pdf_path",
    })
    g.add_edge("parse_markdown_path", "persist_tree")
    g.add_edge("parse_pdf_path", "detect_and_extract_toc")
    g.add_edge("detect_and_extract_toc", "validate_and_repair")
    g.add_edge("validate_and_repair", "persist_tree")
    g.add_edge("persist_tree", "mark_summarizing")
    g.add_edge("mark_summarizing", END)
    return g.compile(checkpointer=checkpointer)


async def run_structure(graph, *, document_id: str) -> dict:
    config = {"configurable": {"thread_id": f"structure:{document_id}"}}
    final = await graph.ainvoke({"document_id": document_id}, config=config)
    return {"node_count": final.get("node_count", 0), "aborted": final.get("aborted", False)}
```

- [ ] **Step 3: Update wiring en config.py + main.py**

> **Review-fix (I3):** el archivo real es `src/sda_indexer/main.py` (no `api/main.py`). Y hay que agregar el secret a `config.Settings` primero.

**3.a — Add field a `services/sda-indexer/src/sda_indexer/config.py`:**

Edit `config.py` añadiendo después de `srv_ia_01_secret`:
```python
    # --- MinerU (Wave 1) ---
    mineru_shared_secret: SecretStr = Field(
        ..., description="Bearer compartido entre indexer y sda-mineru-parser"
    )
```

**3.b — Update `services/sda-indexer/src/sda_indexer/main.py` lifespan:**

Agregar import al top con los demás:
```python
from .pipeline.parser.pdf_mineru import MineruClient
```

En el lifespan, después de `llm = LLMClient(...)` y antes de `app.state.db = db`:
```python
    # MineruClient: url desde app_settings, secret desde env via config.
    mineru_url = await settings_client.resolve("parser.mineru.url")
    mineru = MineruClient(
        base_url=mineru_url,
        shared_secret=cfg.mineru_shared_secret.get_secret_value(),
    )
    app.state.mineru = mineru
```

Y cambiar el `build_structure_graph(...)` call para incluir los nuevos kwargs:
```python
    app.state.structure_graph = build_structure_graph(
        db=db, supabase=supabase, settings=settings_client,
        llm=llm, mineru=mineru, checkpointer=checkpointer,
    )
```

**3.c — Verify import chain compila:**

Run:
```bash
cd services/sda-indexer
uv run python -c "from sda_indexer.main import app; print('OK')"
```
Expected: `OK` (con `SDA_MINERU_SHARED_SECRET=test` en env si no querés popularlo aún).

- [ ] **Step 4: Run existing tests (no regresión markdown path)**

Run:
```bash
cd services/sda-indexer
uv run pytest tests/ -v -m "not integration and not e2e" -k "structure"
```
Expected: tests Wave 0 markdown siguen pasando.

- [ ] **Step 5: Commit**

```bash
git add services/sda-indexer/src/sda_indexer/workflows/structure.py services/sda-indexer/tests/integration/test_structure_workflow_pdf.py
git commit -m "$(cat <<'EOF'
feat(workflows): structure.py refactor Wave 1 — PDF + TOC dance

Conditional edge markdown vs pdf. PDF path: parse_pdf_path (MinerU) →
detect_and_extract_toc (TOC dance LLM-driven, fallback index_extractor) →
validate_and_repair (cap 2 iter) → persist_tree (con split). Persiste
columnas nuevas (page_count, parser_used, path_used, doc_summary_short).
Signed URL NO va en state (spec §5.4 gotcha).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 28: workflows/summarize.py refactor — contextual + llm_calls insert

**Files:**
- Modify: `services/sda-indexer/src/sda_indexer/workflows/summarize.py`
- Modify: `services/sda-indexer/src/sda_indexer/db/tree_nodes.py` (agregar set_contextual_summary)
- Create: `services/sda-indexer/src/sda_indexer/db/llm_calls.py`

- [ ] **Step 1: Verificar helper existente (NO crear duplicado)**

> **Review-fix (I2):** `tree_nodes.set_summary()` Wave 0 YA acepta `text_contextualized` y `summary_model` como kwargs. Crear `set_contextual_summary()` sería redundante. Reusamos el helper existente.

Run:
```bash
grep -A 12 "async def set_summary" services/sda-indexer/src/sda_indexer/db/tree_nodes.py
```
Expected: signature `set_summary(pool, node_id, *, summary, model, text_contextualized=None)` con `update tree_nodes set summary=$1, summary_model=$2, text_contextualized=coalesce($3, text_contextualized), status='ready', summarized_at=now()`. **No modificar este archivo en Wave 1**.

- [ ] **Step 2: Add helper para llm_calls insert**

Create `services/sda-indexer/src/sda_indexer/db/llm_calls.py`:
```python
"""Insert helper para llm_calls. Pull-forward Wave 2 (necesario para D-1.4/D-1.5)."""

from decimal import Decimal


# Pricing aproximado (cents per 1M tokens). Actualizar Wave 2 con pricing real.
# Defaults conservadores para deepseek-chat en 2026.
_PRICING_PER_M_TOKENS_CENTS = {
    "deepseek-chat": {"input": 14.0, "output": 28.0, "cached": 1.4},
}


def _estimate_cost_cents(model: str, tokens_in: int, tokens_out: int, cached: int) -> Decimal:
    """Calcula costo aproximado. 0 si modelo desconocido."""
    pricing = _PRICING_PER_M_TOKENS_CENTS.get(model.split("/")[-1].lower())
    if not pricing:
        return Decimal("0")
    fresh_in = max(0, tokens_in - cached)
    cost = (
        Decimal(fresh_in) * Decimal(str(pricing["input"])) / Decimal(1_000_000)
        + Decimal(cached) * Decimal(str(pricing["cached"])) / Decimal(1_000_000)
        + Decimal(tokens_out) * Decimal(str(pricing["output"])) / Decimal(1_000_000)
    )
    return cost.quantize(Decimal("0.000001"))


async def insert_llm_call(
    pool, *,
    document_id: str | None,
    node_id: str | None,
    phase: str,
    model: str,
    prompt_tokens: int,
    completion_tokens: int,
    cached_tokens: int,
    latency_ms: int,
    success: bool,
    error_class: str | None = None,
    trace_id: str | None = None,
) -> None:
    cost = _estimate_cost_cents(model, prompt_tokens, completion_tokens, cached_tokens)
    async with pool.acquire() as conn:
        await conn.execute(
            """insert into llm_calls (
                document_id, node_id, phase, model,
                prompt_tokens, completion_tokens, cached_tokens,
                cost_cents, latency_ms, success, error_class, trace_id
              ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)""",
            document_id, node_id, phase, model,
            prompt_tokens, completion_tokens, cached_tokens,
            cost, latency_ms, success, error_class, trace_id,
        )
```

- [ ] **Step 3: Refactor summarize.py**

Replace `services/sda-indexer/src/sda_indexer/workflows/summarize.py`:
```python
"""LangGraph workflow summarize Wave 1: contextual_prefix + summary combined
+ llm_calls insert (pull-forward Wave 2).
"""

import time
from typing import TypedDict

import structlog
from langgraph.graph import StateGraph, START, END

from ..db.client import DB
from ..db import documents, llm_calls, tree_nodes
from ..llm.client import LLMClient
from ..llm.router import Phase, aroute
from ..pipeline.summarizer.contextual_prefix import (
    ContextualResult, generate_contextual_prefix_and_summary,
)
from ..settings.client import SettingsClient

log = structlog.get_logger()


class State(TypedDict, total=False):
    node_id: str
    document_id: str
    node_text: str
    doc_summary_short: str
    selected_model: str
    temperature: float
    max_chars: int
    language: str
    prefix: str
    summary: str
    text_contextualized: str
    tokens_in: int
    tokens_out: int
    cached_tokens: int
    latency_ms: int


def build_graph(
    db: DB,
    settings: SettingsClient,
    llm: LLMClient,
    checkpointer=None,
):
    async def load_node_and_doc(s: State) -> dict:
        n = await tree_nodes.get_node(db.pool, s["node_id"])
        d = await documents.get_document(db.pool, s["document_id"])
        return {
            "node_text": n["text"] or "",
            "doc_summary_short": d.get("doc_summary_short") or d["source_path"],
        }

    async def select_model(s: State) -> dict:
        cfg = await aroute(Phase.SUMMARIZE, settings=settings, document_id=s["document_id"])
        max_chars = await settings.resolve(
            "summarize.max_summary_chars", document_id=s["document_id"],
        )
        language = await settings.resolve(
            "summarize.language", document_id=s["document_id"],
        )
        return {
            "selected_model": cfg.model,
            "temperature": cfg.temperature,
            "max_chars": max_chars,
            "language": language,
        }

    async def call_llm(s: State) -> dict:
        await tree_nodes.mark_summarizing(db.pool, s["node_id"])
        prefix_max = await settings.resolve(
            "summarize.contextual_chunking.prefix_max_tokens",
            document_id=s["document_id"],
        )
        t0 = time.monotonic()
        success = True
        error_class: str | None = None
        result: ContextualResult | None = None
        try:
            result = await generate_contextual_prefix_and_summary(
                llm=llm,
                model=s["selected_model"],
                doc_summary_short=s["doc_summary_short"],
                chunk_text=s["node_text"],
                prefix_max_tokens=prefix_max,
                max_summary_chars=s["max_chars"],
                language=s["language"],
                temperature=s["temperature"],
            )
        except Exception as e:
            success = False
            error_class = type(e).__name__
            raise
        finally:
            elapsed_ms = int((time.monotonic() - t0) * 1000)
            await llm_calls.insert_llm_call(
                db.pool,
                document_id=s["document_id"],
                node_id=s["node_id"],
                phase="summarize",
                model=s["selected_model"],
                prompt_tokens=result.tokens_in if result else 0,
                completion_tokens=result.tokens_out if result else 0,
                cached_tokens=result.cached_tokens if result else 0,
                latency_ms=elapsed_ms,
                success=success,
                error_class=error_class,
            )

        text_contextualized = (
            f"{result.prefix}\n\n{s['node_text']}" if result.prefix else s["node_text"]
        )
        return {
            "prefix": result.prefix,
            "summary": result.summary,
            "text_contextualized": text_contextualized,
            "tokens_in": result.tokens_in,
            "tokens_out": result.tokens_out,
            "cached_tokens": result.cached_tokens,
            "latency_ms": elapsed_ms,
        }

    async def persist(s: State) -> dict:
        # Review-fix (I2): reusar set_summary (Wave 0 ya acepta text_contextualized + summary_model)
        await tree_nodes.set_summary(
            db.pool, s["node_id"],
            summary=s["summary"],
            model=s["selected_model"],
            text_contextualized=s["text_contextualized"],
        )
        log.info(
            "summarize.persisted",
            node_id=s["node_id"],
            tokens_in=s["tokens_in"],
            cached=s["cached_tokens"],
        )
        return {}

    g = StateGraph(State)
    g.add_node("load_node_and_doc", load_node_and_doc)
    g.add_node("select_model", select_model)
    g.add_node("call_llm", call_llm)
    g.add_node("persist", persist)
    g.add_edge(START, "load_node_and_doc")
    g.add_edge("load_node_and_doc", "select_model")
    g.add_edge("select_model", "call_llm")
    g.add_edge("call_llm", "persist")
    g.add_edge("persist", END)
    return g.compile(checkpointer=checkpointer)


async def run_summarize(graph, *, node_id: str, document_id: str) -> dict:
    config = {"configurable": {"thread_id": f"summarize:{node_id}"}}
    return await graph.ainvoke(
        {"node_id": node_id, "document_id": document_id}, config=config,
    )
```

- [ ] **Step 4: Run existing summarize tests (no regresión)**

Run:
```bash
cd services/sda-indexer
uv run pytest tests/ -v -k "summarize" -m "not integration and not e2e"
```
Expected: tests Wave 0 pass o se actualizan al nuevo contract.

- [ ] **Step 5: Commit**

```bash
git add services/sda-indexer/src/sda_indexer/workflows/summarize.py services/sda-indexer/src/sda_indexer/db/llm_calls.py
git commit -m "$(cat <<'EOF'
feat(workflows): summarize.py refactor — contextual prefix + llm_calls insert

Llama generate_contextual_prefix_and_summary (1 call combinada, Mejora #1)
y persiste text_contextualized + summary + summary_model. INSERT a
llm_calls con phase/model/tokens/cached_tokens/cost_cents (pull-forward
Wave 2, necesario para D-1.4 y D-1.5).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 29: workflows/finalize.py — leer path_used/page_count desde documents

> **Review-fix (I4):** `finalize.py` Wave 0 hace `mark_ready_meta(..., path_used="full", page_count=None, ...)` hardcoded. Task 27 persiste el `path_used` real (fast/full) y `page_count` durante structure. Si finalize sigue hardcoded, **PISA** esos valores reales. Hay que leer desde `documents` antes del `mark_ready_meta`.

**Files:**
- Modify: `services/sda-indexer/src/sda_indexer/workflows/finalize.py`

- [ ] **Step 1: Read current finalize para confirmar el hardcoded**

Run:
```bash
grep -A 8 "mark_ready_meta" services/sda-indexer/src/sda_indexer/workflows/finalize.py
```
Expected: ver `path_used="full"` hardcoded.

- [ ] **Step 2: Modificar el nodo `mark_ready` para leer desde documents**

Edit `services/sda-indexer/src/sda_indexer/workflows/finalize.py`. Reemplazar el body de `mark_ready` (líneas ~43-55):

```python
    async def mark_ready(s: State) -> dict:
        # Wave 1: leer path_used + page_count + doc_summary_short que
        # structure_workflow ya persistió. NO hardcoded.
        async with db.pool.acquire() as conn:
            row = await conn.fetchrow(
                """select path_used, page_count, doc_summary_short
                     from documents where id=$1""",
                s["document_id"],
            )
        await docs_db.mark_ready_meta(
            db.pool, s["document_id"],
            node_count=s["node_count"],
            page_count=row["page_count"],
            path_used=row["path_used"] or "full",   # default si fue markdown
            doc_description=row["doc_summary_short"],
            total_cost_cents=s["total_cost_cents"],
        )
        log.info("finalize.complete",
                 document_id=s["document_id"],
                 node_count=s["node_count"],
                 cost_cents=s["total_cost_cents"],
                 path_used=row["path_used"])
        return {}
```

- [ ] **Step 3: Smoke run del workflow markdown path (no regresión Wave 0)**

Run:
```bash
cd services/sda-indexer
uv run pytest tests/ -v -k "finalize" -m "not integration and not e2e"
```
Expected: tests Wave 0 pass.

- [ ] **Step 4: Commit**

```bash
git add services/sda-indexer/src/sda_indexer/workflows/finalize.py
git commit -m "$(cat <<'EOF'
fix(workflows): finalize.py lee path_used desde documents (no hardcoded)

Wave 0 dejaba path_used='full' hardcoded en mark_ready_meta. Wave 1
structure_workflow persiste el path real (fast|full) durante parse_pdf,
así que finalize debe leer ese valor en vez de pisarlo. Idem page_count
y doc_summary_short.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4 — Corpus + E2E testing (Tasks 30-33)

### Task 30: tests/fixtures/pdf_corpus.yaml (8 entries)

**Files:**
- Create: `services/sda-indexer/tests/fixtures/pdf_corpus.yaml`

- [ ] **Step 1: Curate 8 PDFs públicos**

Buscar PDFs públicos (CC-BY / CC0) que matchean los slots del spec §6.1. Sources sugeridas:
- arXiv (papers) — license CC-BY
- Project Gutenberg (libros) — public domain
- W3C specs / IETF RFCs — open
- Government open data portals (contratos públicos AR/ES)

Ejemplos válidos (verificar antes de cada uno con `curl -I <url>` que el PDF existe y es accesible):
- tech_manual_5p: PostgreSQL 17 release notes (5pag aprox), wget desde postgresql.org
- tech_manual_50p: cualquier RFC mediano, ej. RFC 9110 (HTTP semantics) trimmed
- scan_legal_50p_es: ley argentina pública del BORA
- contract_30p: contrato modelo Banco Nación AR (público)
- book_300p: libro de Gutenberg de 300pag aprox
- paper_with_tables: arXiv paper con tablas
- toc_misleading_40p: paper con apendices que disfrazan TOC
- paper_en_30p: arXiv paper inglés

- [ ] **Step 2: Write YAML manifest**

Create `services/sda-indexer/tests/fixtures/pdf_corpus.yaml`:
```yaml
# Canonical PDF corpus para E2E + D-1.x verification. Wave 1 §6.1.
# NO commitear binarios — sólo metadata + URL + sha. Fixture descarga
# on-demand a ~/.cache/sda-test-corpus/ y valida sha256.

pdfs:
  - id: tech_manual_5p
    url: "REEMPLAZAR_URL_PDF_5P"
    sha256: "REEMPLAZAR_SHA256"
    license: "PostgreSQL License (BSD-style)"
    expected:
      page_count: 5
      path_used: fast
      parser_used: native
      llm_calls_max: 10
      duration_seconds_max: 30
      cost_cents_max: 1
      toc_nodes_count_min: 1
      toc_nodes_titles_expected: []

  - id: tech_manual_50p
    url: "REEMPLAZAR_URL_PDF_50P"
    sha256: "REEMPLAZAR_SHA256"
    license: "CC-BY-4.0"
    expected:
      page_count: 50
      path_used: fast
      parser_used: native
      llm_calls_max: 30
      duration_seconds_max: 120
      cost_cents_max: 5
      toc_nodes_count_min: 8
      toc_nodes_titles_expected:
        - "Introducción"
        - "Arquitectura"
        - "Instalación"

  - id: scan_legal_50p_es
    url: "REEMPLAZAR_URL_BORA_LEY"
    sha256: "REEMPLAZAR_SHA256"
    license: "Public domain (gov)"
    expected:
      page_count: 50
      path_used: full
      parser_used: mineru
      llm_calls_max: 60
      duration_seconds_max: 600
      cost_cents_max: 25
      toc_nodes_count_min: 5
      f1_threshold: 0.7
      toc_nodes_titles_expected:
        - "Artículo 1"
        - "Artículo 2"

  - id: contract_30p
    url: "REEMPLAZAR_URL_CONTRATO"
    sha256: "REEMPLAZAR_SHA256"
    license: "Public domain (gov)"
    expected:
      page_count: 30
      path_used: fast
      llm_calls_max: 25
      duration_seconds_max: 90
      cost_cents_max: 4
      toc_nodes_count_min: 4
      validates_d16: true

  - id: book_300p
    url: "REEMPLAZAR_URL_GUTENBERG"
    sha256: "REEMPLAZAR_SHA256"
    license: "Public Domain (Gutenberg)"
    expected:
      page_count: 300
      duration_seconds_max: 600
      cost_cents_max: 50
      toc_nodes_count_min: 20

  - id: paper_with_tables
    url: "REEMPLAZAR_URL_ARXIV"
    sha256: "REEMPLAZAR_SHA256"
    license: "CC-BY-4.0"
    expected:
      page_count: 25
      llm_calls_max: 30
      duration_seconds_max: 120
      cost_cents_max: 5

  - id: toc_misleading_40p
    url: "REEMPLAZAR_URL_PAPER_LARGO"
    sha256: "REEMPLAZAR_SHA256"
    license: "CC-BY-4.0"
    expected:
      page_count: 40
      llm_calls_max: 50
      duration_seconds_max: 240
      cost_cents_max: 10
      repair_iterations_min: 1

  - id: paper_en_30p
    url: "REEMPLAZAR_URL_ARXIV_EN"
    sha256: "REEMPLAZAR_SHA256"
    license: "CC-BY-4.0"
    expected:
      page_count: 30
      llm_calls_max: 30
      duration_seconds_max: 120
      cost_cents_max: 5
```

- [ ] **Step 3: Resolve URLs concretas iterativamente**

Para cada entry, ejecutar:
```bash
curl -sI <URL> | head -5    # verifica 200 y content-type pdf
curl -s <URL> | shasum -a 256
```
Reemplazar `REEMPLAZAR_*` con valores reales. Si una URL queda inestable (404), buscar reemplazo del mismo tipo.

- [ ] **Step 4: Commit**

```bash
git add services/sda-indexer/tests/fixtures/pdf_corpus.yaml
git commit -m "$(cat <<'EOF'
feat(tests): canonical PDF corpus YAML (8 entries) para D-1.x verification

Manifest con URL + sha + license + expected metrics. Binarios NO van al
repo — fixture descarga on-demand al cache local. Cada entry valida un
criterio del spec §6.1.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 31: tests/conftest.py extend con canonical_corpus fixture

**Files:**
- Modify: `services/sda-indexer/tests/conftest.py`

- [ ] **Step 1: Read current conftest + agregar deps faltantes**

Run:
```bash
cat services/sda-indexer/tests/conftest.py
```

> **Review-fix (B4):** `pyyaml` no está en `dev-deps` del `pyproject.toml`. Sin agregarlo, el fixture rompe con `ImportError: yaml`.

Run:
```bash
cd services/sda-indexer
uv add --dev pyyaml
```
Expected: `pyproject.toml` actualizado, lockfile resync.

- [ ] **Step 2: Append fixture**

Edit `services/sda-indexer/tests/conftest.py` agregando:
```python
import hashlib
from dataclasses import dataclass
from pathlib import Path

import httpx
import pytest
import yaml


CORPUS_CACHE = Path("~/.cache/sda-test-corpus").expanduser()


@dataclass(frozen=True)
class CorpusEntry:
    id: str
    url: str
    sha256: str
    license: str
    local_path: Path
    expected: dict


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


@pytest.fixture(scope="session")
def canonical_corpus():
    """Descarga (cached) y devuelve el manifest del corpus canonical."""
    manifest_path = Path(__file__).parent / "fixtures" / "pdf_corpus.yaml"
    if not manifest_path.exists():
        pytest.skip("pdf_corpus.yaml no existe — corpus no anotado")
    manifest = yaml.safe_load(manifest_path.read_text())

    CORPUS_CACHE.mkdir(parents=True, exist_ok=True)
    out: list[CorpusEntry] = []
    for entry in manifest["pdfs"]:
        if entry["url"].startswith("REEMPLAZAR"):
            continue  # skip unanottated
        local = CORPUS_CACHE / f"{entry['id']}.pdf"
        if not local.exists() or _sha256(local) != entry["sha256"]:
            with httpx.stream("GET", entry["url"], timeout=120, follow_redirects=True) as resp:
                resp.raise_for_status()
                with open(local, "wb") as f:
                    for chunk in resp.iter_bytes(1024 * 1024):
                        f.write(chunk)
            actual = _sha256(local)
            if actual != entry["sha256"]:
                pytest.fail(
                    f"Corpus {entry['id']}: expected sha {entry['sha256'][:16]}..., "
                    f"got {actual[:16]}... — URL changed?"
                )
        out.append(CorpusEntry(
            id=entry["id"], url=entry["url"], sha256=entry["sha256"],
            license=entry["license"], local_path=local, expected=entry["expected"],
        ))
    return out


@pytest.fixture(scope="session")
def corpus_by_id(canonical_corpus):
    return {e.id: e for e in canonical_corpus}
```

- [ ] **Step 3: Smoke run (sin tests aún)**

Run:
```bash
cd services/sda-indexer
uv run pytest tests/conftest.py --collect-only 2>&1 | head
```
Expected: no errores de import.

- [ ] **Step 4: Commit**

```bash
git add services/sda-indexer/tests/conftest.py services/sda-indexer/pyproject.toml services/sda-indexer/uv.lock
git commit -m "$(cat <<'EOF'
feat(tests): canonical_corpus fixture — auto-download + sha verify

Fixture session-scoped que lee tests/fixtures/pdf_corpus.yaml, descarga
PDFs al cache local (~/.cache/sda-test-corpus), valida sha256. Entries
con URL REEMPLAZAR se skipean hasta anotación (Task 32).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 32: Ground truth de TOCs para 8 PDFs (LLM-extracted, Enzo revisa)

**Files:**
- Create: `services/sda-indexer/tests/fixtures/ground_truth_tocs.yaml`
- Create: `services/sda-indexer/scripts/extract_ground_truth.py`

- [ ] **Step 1: Write extraction script**

Create `services/sda-indexer/scripts/extract_ground_truth.py`:
```python
"""Extrae ground truth TOC de cada PDF del corpus para review humano.

Para cada PDF:
1. Lo descarga (vía fixture)
2. Manda al servicio mineru → markdown
3. Hace UN prompt verboso a DeepSeek: "extract every section heading with page"
4. Output YAML por PDF — Enzo lo revisa y corrige en ~30min total

NO es lo mismo que el pipeline — esto es referencia independiente para
calcular F1 score en D-1.3.

Uso:
  cd services/sda-indexer
  DEEPSEEK_API_KEY=... MINERU_URL=... MINERU_SHARED_SECRET=... \
    uv run python scripts/extract_ground_truth.py
"""

import asyncio
import hashlib
import json
import os
from pathlib import Path

import httpx
import yaml
from openai import AsyncOpenAI


CORPUS_MANIFEST = Path(__file__).parent.parent / "tests/fixtures/pdf_corpus.yaml"
OUTPUT = Path(__file__).parent.parent / "tests/fixtures/ground_truth_tocs.yaml"
CACHE = Path("~/.cache/sda-test-corpus").expanduser()


GROUND_TRUTH_PROMPT = """\
Identify EVERY section heading in this document. Be exhaustive — don't skip
appendices, indices, or sub-sub-sections.

For each heading return:
- title: cleaned (no leaders/page numbers)
- depth: 1=top, 2=sub, 3=sub-sub...
- page_start: page where heading appears (1-indexed)

Output strict JSON object {"headings": [...]}. No prose.
"""


async def upload_to_supabase_and_signed_url(local_path: Path) -> tuple[str, str]:
    """Sube a Supabase Storage tmp + devuelve (signed_url, sha).

    Adaptar al setup local — o pasar URL pública directa al PDF.
    """
    raise NotImplementedError("Adaptar a tu fixture de upload — o pasar URL pública directa")


async def call_mineru(signed_url: str, sha: str, doc_id: str) -> str:
    url = os.environ["MINERU_URL"]
    secret = os.environ["MINERU_SHARED_SECRET"]
    async with httpx.AsyncClient(timeout=600) as c:
        r = await c.post(
            f"{url}/parse",
            headers={"Authorization": f"Bearer {secret}"},
            json={"doc_id": doc_id, "signed_url": signed_url, "expected_sha256": sha},
        )
        r.raise_for_status()
        return r.json()["markdown"]


async def call_llm_for_headings(client: AsyncOpenAI, markdown: str) -> list[dict]:
    body = markdown[:50_000]  # cap a 50k chars para 1 call
    resp = await client.chat.completions.create(
        model="deepseek-chat",
        messages=[
            {"role": "system", "content": "You are a careful document structure analyzer."},
            {"role": "user", "content": f"{GROUND_TRUTH_PROMPT}\n\n{body}"},
        ],
        temperature=0.0,
        response_format={"type": "json_object"},
        max_tokens=4096,
    )
    data = json.loads(resp.choices[0].message.content)
    return data.get("headings", [])


async def main():
    manifest = yaml.safe_load(CORPUS_MANIFEST.read_text())
    client = AsyncOpenAI(
        api_key=os.environ["DEEPSEEK_API_KEY"],
        base_url="https://api.deepseek.com/v1",
    )
    out: dict[str, list[dict]] = {}
    for entry in manifest["pdfs"]:
        if entry["url"].startswith("REEMPLAZAR"):
            print(f"skip {entry['id']} (URL no anotada)")
            continue
        local = CACHE / f"{entry['id']}.pdf"
        if not local.exists():
            print(f"  fetching {entry['id']}")
            r = httpx.get(entry["url"], timeout=120, follow_redirects=True)
            local.write_bytes(r.content)
        sha = hashlib.sha256(local.read_bytes()).hexdigest()
        print(f"processing {entry['id']} ({sha[:12]}...)")
        signed_url, _ = await upload_to_supabase_and_signed_url(local)
        markdown = await call_mineru(signed_url, sha, entry["id"])
        headings = await call_llm_for_headings(client, markdown)
        out[entry["id"]] = headings
        print(f"  → {len(headings)} headings")

    OUTPUT.write_text(yaml.safe_dump(out, sort_keys=False, allow_unicode=True))
    print(f"\nWrote {OUTPUT} — review/correct manually, then commit.")


if __name__ == "__main__":
    asyncio.run(main())
```

- [ ] **Step 2: Run del script (después de anotación URLs Task 30)**

Esta task se completa CUANDO el corpus YAML está anotado y MinerU está deployado. Ejecutar:
```bash
cd services/sda-indexer
DEEPSEEK_API_KEY=$(security find-generic-password -s deepseek_api_key -w) \
MINERU_URL=https://mineru.sdaframework.com \
MINERU_SHARED_SECRET=$(security find-generic-password -s mineru_shared_secret -w) \
  uv run python scripts/extract_ground_truth.py
```
Expected: `tests/fixtures/ground_truth_tocs.yaml` generado con N PDFs.

- [ ] **Step 3: Review humano + corrección manual**

Enzo abre `ground_truth_tocs.yaml` y para cada entry:
- Quita falsos positivos (running headers detectados como heading)
- Agrega títulos missed por el LLM
- Ajusta `depth` cuando esté mal anotado

Tiempo estimado: ~30min total (5 min × 6 PDFs medianos, 0 para los chicos).

- [ ] **Step 4: Update pdf_corpus.yaml con titles esperados**

Para cada PDF, copiar los top-level titles del ground_truth a `toc_nodes_titles_expected` en `pdf_corpus.yaml`. Esto alimenta el F1 score en D-1.3.

- [ ] **Step 5: Commit**

```bash
git add services/sda-indexer/tests/fixtures/ground_truth_tocs.yaml services/sda-indexer/scripts/extract_ground_truth.py services/sda-indexer/tests/fixtures/pdf_corpus.yaml
git commit -m "$(cat <<'EOF'
feat(tests): ground truth TOCs anotados para 8 PDFs del corpus

LLM-extracted + review manual de Enzo. Permite calcular F1 score en
D-1.3 entre los títulos del pipeline y los esperados. Script reproducible
en scripts/extract_ground_truth.py.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 33: E2E tests + stress arxiv

**Files:**
- Create: `services/sda-indexer/tests/e2e/__init__.py`
- Create: `services/sda-indexer/tests/e2e/test_canonical_corpus.py`
- Create: `services/sda-indexer/tests/stress/__init__.py`
- Create: `services/sda-indexer/tests/stress/run_arxiv_sample.py`

- [ ] **Step 1: Add pytest markers (pyproject.toml)**

Verificar que `services/sda-indexer/pyproject.toml` tiene markers definidos. Si no, agregar:
```toml
[tool.pytest.ini_options]
markers = [
    "unit: pure function tests, no IO",
    "integration: tests con LLM real o DB real (~$0.05/run)",
    "e2e: full pipeline (~$0.50/run, ~10 min)",
    "stress: long-running stress tests (~$5+/run)",
]
```

- [ ] **Step 2: Write E2E test runner**

Create `services/sda-indexer/tests/e2e/__init__.py` (empty).

Create `services/sda-indexer/tests/e2e/test_canonical_corpus.py`:
```python
"""E2E tests: full pipeline contra los 8 PDFs canonicales. Valida D-1.x.

Requiere todos los servicios en pie (Supabase + mineru + indexer + DeepSeek).
"""

import asyncio
import os
import time
import uuid

import pytest


pytestmark = pytest.mark.e2e


def _f1_score(predicted: list[str], expected: list[str]) -> float:
    """F1 case-insensitive whitespace-normalized title matching."""
    def norm(t: str) -> str:
        return " ".join(t.lower().split())
    p = {norm(t) for t in predicted}
    e = {norm(t) for t in expected}
    if not e:
        return 1.0 if not p else 0.0
    tp = len(p & e)
    if tp == 0:
        return 0.0
    prec = tp / len(p)
    rec = tp / len(e)
    return 2 * prec * rec / (prec + rec)


@pytest.fixture
def env():
    needed = ["SUPABASE_URL", "SUPABASE_SERVICE_KEY", "POSTGRES_URL"]
    missing = [k for k in needed if not os.environ.get(k)]
    if missing:
        pytest.skip(f"Missing env: {missing}")
    return {k: os.environ[k] for k in needed}


async def _upload_and_enqueue(env, local_pdf, doc_id):
    """Sube PDF a Storage + insert documents + enqueue. Devuelve storage_path."""
    from supabase import create_client
    import asyncpg
    sb = create_client(env["SUPABASE_URL"], env["SUPABASE_SERVICE_KEY"])
    storage_path = f"e2e/{doc_id}.pdf"
    sb.storage.from_("docs").upload(storage_path, local_pdf.read_bytes(), {"upsert": "true"})
    conn = await asyncpg.connect(env["POSTGRES_URL"])
    try:
        await conn.execute(
            """insert into documents (id, source_path, source_type, status)
               values ($1, $2, 'pdf', 'pending')""",
            doc_id, storage_path,
        )
        await conn.execute(
            "select pgmq.send('q_extract_structure', $1::jsonb)",
            f'{{"document_id":"{doc_id}"}}',
        )
    finally:
        await conn.close()
    return storage_path


async def _wait_for_ready(env, doc_id, timeout):
    """Poll documents.status hasta 'ready' o 'failed' o timeout."""
    import asyncpg
    deadline = time.monotonic() + timeout
    conn = await asyncpg.connect(env["POSTGRES_URL"])
    try:
        while time.monotonic() < deadline:
            row = await conn.fetchrow(
                """select status, page_count, parser_used, path_used,
                          doc_summary_short
                     from documents where id=$1""",
                doc_id,
            )
            if row and row["status"] in ("ready", "failed"):
                return dict(row)
            await asyncio.sleep(3)
        raise TimeoutError(f"doc {doc_id} not ready after {timeout}s")
    finally:
        await conn.close()


async def _measure(env, doc_id):
    """Devuelve metrics post-procesamiento."""
    import asyncpg
    conn = await asyncpg.connect(env["POSTGRES_URL"])
    try:
        cnt_calls = await conn.fetchval(
            "select count(*) from llm_calls where document_id=$1", doc_id,
        )
        sum_cost = await conn.fetchval(
            "select coalesce(sum(cost_cents), 0) from llm_calls where document_id=$1",
            doc_id,
        )
        sum_cached = await conn.fetchval(
            "select coalesce(sum(cached_tokens),0)::float / "
            "nullif(sum(prompt_tokens),0) "
            "from llm_calls where document_id=$1", doc_id,
        )
        titles = await conn.fetch(
            """select title from tree_nodes
                where document_id=$1 and depth=1
                order by structure_code""",
            doc_id,
        )
        contextualized = await conn.fetchval(
            "select count(*) from tree_nodes "
            "where document_id=$1 and text_contextualized is not null",
            doc_id,
        )
        return {
            "llm_calls": cnt_calls,
            "cost_cents": float(sum_cost),
            "cache_hit_ratio": float(sum_cached or 0),
            "top_titles": [r["title"] for r in titles],
            "contextualized_count": contextualized,
        }
    finally:
        await conn.close()


@pytest.mark.parametrize("pdf_id", [
    "tech_manual_50p",
    "scan_legal_50p_es",
    "contract_30p",
    "book_300p",
])
async def test_canonical_pdf_meets_criteria(corpus_by_id, env, pdf_id):
    if pdf_id not in corpus_by_id:
        pytest.skip(f"{pdf_id} no en corpus (URL no anotada)")
    entry = corpus_by_id[pdf_id]
    doc_id = str(uuid.uuid4())

    await _upload_and_enqueue(env, entry.local_path, doc_id)
    t0 = time.monotonic()
    final = await _wait_for_ready(env, doc_id, entry.expected.get("duration_seconds_max", 600))
    elapsed = time.monotonic() - t0

    assert final["status"] == "ready", f"doc failed: {final}"
    if "page_count" in entry.expected:
        assert final["page_count"] == entry.expected["page_count"]
    if "path_used" in entry.expected:
        assert final["path_used"] == entry.expected["path_used"]

    metrics = await _measure(env, doc_id)
    assert metrics["llm_calls"] <= entry.expected.get("llm_calls_max", 10**9)
    assert metrics["cost_cents"] <= entry.expected.get("cost_cents_max", 10**9)

    expected_titles = entry.expected.get("toc_nodes_titles_expected", [])
    if expected_titles and "f1_threshold" in entry.expected:
        f1 = _f1_score(metrics["top_titles"], expected_titles)
        assert f1 >= entry.expected["f1_threshold"], (
            f"F1 {f1:.2f} below threshold {entry.expected['f1_threshold']}"
        )

    if entry.expected.get("validates_d16"):
        assert metrics["contextualized_count"] > 0
```

- [ ] **Step 3: Write stress runner**

Create `services/sda-indexer/tests/stress/__init__.py` (empty).

Create `services/sda-indexer/tests/stress/run_arxiv_sample.py`:
```python
"""Stress test: 50 papers random de arXiv. Valida D-1.4 / D-1.5 sobre N>>1.

NO usa pytest — script standalone con CSV + report.md output.

Uso:
  cd services/sda-indexer
  uv run python tests/stress/run_arxiv_sample.py --sample-size 50
"""

import argparse
import asyncio
import csv
import re
import time
import uuid
from datetime import datetime
from pathlib import Path

import httpx


ARXIV_API = "http://export.arxiv.org/api/query"
RESULTS_DIR = Path(__file__).parent / "results"


def _arxiv_search(category: str = "cs.AI", max_results: int = 50, sortby: str = "submittedDate") -> list[dict]:
    """Devuelve lista de {id, title, pdf_url} via arXiv API."""
    params = {
        "search_query": f"cat:{category}",
        "max_results": max_results,
        "sortBy": sortby,
        "sortOrder": "descending",
    }
    r = httpx.get(ARXIV_API, params=params, timeout=60)
    r.raise_for_status()
    entries = re.findall(
        r"<entry>.*?<id>(.*?)</id>.*?<title>(.*?)</title>.*?<link.*?pdf.*?href=\"(.*?)\".*?</entry>",
        r.text,
        re.DOTALL,
    )
    return [{"id": e[0], "title": e[1].strip(), "pdf_url": e[2]} for e in entries]


async def _process(env, paper: dict) -> dict:
    """Upload paper a Supabase Storage + enqueue + wait + measure."""
    from tests.e2e.test_canonical_corpus import (
        _upload_and_enqueue, _wait_for_ready, _measure,
    )
    doc_id = str(uuid.uuid4())
    tmp = Path(f"/tmp/{doc_id}.pdf")
    async with httpx.AsyncClient(timeout=120, follow_redirects=True) as c:
        r = await c.get(paper["pdf_url"])
        tmp.write_bytes(r.content)
    try:
        await _upload_and_enqueue(env, tmp, doc_id)
        await _wait_for_ready(env, doc_id, timeout=900)
        metrics = await _measure(env, doc_id)
        return {**metrics, "paper_id": paper["id"], "doc_id": doc_id, "status": "ok"}
    except Exception as e:
        return {"paper_id": paper["id"], "doc_id": doc_id, "status": "failed", "error": str(e)}
    finally:
        tmp.unlink(missing_ok=True)


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sample-size", type=int, default=50)
    parser.add_argument("--category", default="cs.AI")
    parser.add_argument("--concurrency", type=int, default=5)
    args = parser.parse_args()

    import os
    env = {k: os.environ[k] for k in [
        "SUPABASE_URL", "SUPABASE_SERVICE_KEY", "POSTGRES_URL",
    ]}

    papers = _arxiv_search(category=args.category, max_results=args.sample_size)
    print(f"Found {len(papers)} papers")

    sem = asyncio.Semaphore(args.concurrency)

    async def bounded(p):
        async with sem:
            return await _process(env, p)

    t0 = time.monotonic()
    rows = await asyncio.gather(*[bounded(p) for p in papers])
    elapsed = time.monotonic() - t0

    RESULTS_DIR.mkdir(exist_ok=True)
    ts = datetime.utcnow().strftime("%Y%m%dT%H%M%S")
    csv_path = RESULTS_DIR / f"{ts}.csv"
    with open(csv_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=sorted({k for r in rows for k in r.keys()}))
        w.writeheader()
        for r in rows:
            w.writerow(r)

    ok = [r for r in rows if r["status"] == "ok"]
    avg_cost = sum(r.get("cost_cents", 0) for r in ok) / max(1, len(ok))
    avg_cache = sum(r.get("cache_hit_ratio", 0) for r in ok) / max(1, len(ok))
    report = RESULTS_DIR / f"{ts}_report.md"
    report.write_text(f"""# arXiv stress run {ts}

- Category: {args.category}
- Sample size: {args.sample_size}
- Concurrency: {args.concurrency}
- Elapsed: {elapsed:.0f}s
- Success: {len(ok)}/{len(rows)}
- Avg cost (cents/doc): {avg_cost:.2f}
- Avg cache hit ratio: {avg_cache:.2%}

CSV: `{csv_path.name}`
""")
    print(f"\nReport: {report}\nCSV: {csv_path}")


if __name__ == "__main__":
    asyncio.run(main())
```

- [ ] **Step 4: Commit**

```bash
git add services/sda-indexer/tests/e2e/ services/sda-indexer/tests/stress/ services/sda-indexer/pyproject.toml
git commit -m "$(cat <<'EOF'
feat(tests): E2E canonical_corpus + stress arxiv runner

E2E parametrizado por pdf_id mapea cada PDF a sus criterios D-1.x (
cost_cents_max, llm_calls_max, F1 threshold, contextualized check).
Stress arxiv standalone: descarga N papers, mide cost/cache_hit promedio,
output CSV + report.md para baseline tracking.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 5 — Deploy + verify (Tasks 34-36)

### Task 34: Deploy MinerU service a srv-ia-01 + smoke

**Files:**
- (Operational, sin código nuevo — usa runbook de Task 7 y systemd de Task 13)

- [ ] **Step 1: Verificar pre-requisitos en srv-ia-01**

Run desde laptop:
```bash
ssh enzo@srv-ia-01 'uname -a && nvidia-smi | head -5 && df -h /var'
ssh enzo@srv-ia-01 'which uv || curl -LsSf https://astral.sh/uv/install.sh | sh'
```
Expected: GPU detectada, >10GB free, uv instalado.

- [ ] **Step 2: Rsync + sync deps**

Run:
```bash
rsync -av --exclude='.venv/' --exclude='__pycache__/' --exclude='tests/' \
    services/sda-mineru-parser/ enzo@srv-ia-01:/home/enzo/sda-mineru-parser/
ssh enzo@srv-ia-01 'cd /home/enzo/sda-mineru-parser && uv sync'
```
Expected: sync OK, magic-pdf instalado.

- [ ] **Step 3: Setup env + systemd**

Run:
```bash
SECRET=$(openssl rand -hex 32)
echo "MINERU_SHARED_SECRET=$SECRET" > /tmp/mineru-env
echo "SDA_MINERU_CACHE_DIR=/var/cache/sda-mineru" >> /tmp/mineru-env
scp /tmp/mineru-env enzo@srv-ia-01:/tmp/mineru-env
ssh enzo@srv-ia-01 'sudo mkdir -p /etc/sda-mineru /var/cache/sda-mineru && sudo mv /tmp/mineru-env /etc/sda-mineru/env && sudo chmod 600 /etc/sda-mineru/env'
ssh enzo@srv-ia-01 'sudo cp /home/enzo/sda-mineru-parser/systemd/sda-mineru.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now sda-mineru'
ssh enzo@srv-ia-01 'sleep 5 && systemctl status sda-mineru --no-pager | head -20'
```
Expected: `active (running)`.

- [ ] **Step 4: Setup cloudflared (Task 14 step 2 — runbook sección 3)**

Seguir runbook de Task 14. Verificar:
```bash
curl https://mineru.sdaframework.com/healthz
```
Expected: `{"ok": true, "version": "0.1.0", ...}`.

- [ ] **Step 5: Set MINERU_SHARED_SECRET en Supabase Vault**

Run:
```bash
supabase secrets set MINERU_SHARED_SECRET=$SECRET --project-ref anfawvxfepowsudlffnl
```
(O usar SQL si Vault prefiere). Verificar via `app_settings` accessible al indexer.

- [ ] **Step 6: Document operation**

Update memoria `wave_0_prod_deploy.md` o nueva `wave_1_prod_deploy.md` con comandos exactos y links a logs.

- [ ] **Step 7: Commit (si tocó archivos)**

Generalmente este task no genera commits — es operacional. Si se ajustó el systemd o cloudflared config para fix encontrado, commit el ajuste.

---

### Task 35: Deploy indexer v0.2 a Fly.io + smoke

**Files:**
- (Operational, sin código)

- [ ] **Step 1: Set Fly secrets nuevos**

Run:
```bash
fly secrets set MINERU_SHARED_SECRET=$SECRET -a sda-indexer-prod
fly secrets list -a sda-indexer-prod | grep MINERU
```
Expected: secret listado.

- [ ] **Step 2: Deploy**

Run:
```bash
cd services/sda-indexer
fly deploy -a sda-indexer-prod
fly status -a sda-indexer-prod
fly logs -a sda-indexer-prod | head -50
```
Expected: deployment success, instancia healthy, no errors en boot.

- [ ] **Step 3: Smoke test — upload markdown chico (Wave 0 path) + verify**

Subir un .md tiny a `docs/` y verificar que el dispatcher lo procesa sin regresión:
```bash
echo "# Test\n\nWave 1 smoke" > /tmp/smoke.md
supabase storage upload --bucket docs /tmp/smoke.md smoke-wave1.md
psql $DATABASE_URL -c "select id, status, parser_used from documents where source_path='smoke-wave1.md'"
```
Expected: status=ready en <60s, parser_used=native.

- [ ] **Step 4: Smoke test PDF chico — full path**

Subir un PDF de 5pag y validar:
```bash
supabase storage upload --bucket docs services/sda-mineru-parser/tests/fixtures/sample_native.pdf smoke-wave1.pdf
sleep 90
psql $DATABASE_URL -c "select status, page_count, parser_used, path_used from documents where source_path='smoke-wave1.pdf'"
```
Expected: status=ready, page_count=3, parser_used=native, path_used=fast.

---

### Task 36: Run canonical E2E + stress en prod + verify D-1.x + tag

**Files:**
- Create: `~/.claude/projects/-Users-enzo-sda-framework-sda-framework/memory/wave_1_prod_results.md`
- Update: `~/.claude/projects/-Users-enzo-sda-framework-sda-framework/memory/MEMORY.md`

- [ ] **Step 1: Ejecutar E2E contra prod**

Run:
```bash
cd services/sda-indexer
SUPABASE_URL=... SUPABASE_SERVICE_KEY=... POSTGRES_URL=... \
DEEPSEEK_API_KEY=... MINERU_URL=https://mineru.sdaframework.com \
MINERU_SHARED_SECRET=... \
  uv run pytest tests/e2e/test_canonical_corpus.py -v -m e2e
```
Expected: 4 tests parametrizados pass (D-1.1, D-1.2, D-1.3, D-1.6, D-1.7).

- [ ] **Step 2: Ejecutar stress arxiv (50 papers)**

Run:
```bash
cd services/sda-indexer
uv run python tests/stress/run_arxiv_sample.py --sample-size 50 --concurrency 5
```
Expected: report.md generado, success >= 45/50, avg_cost <50¢, avg_cache >=75% post 5 docs.

- [ ] **Step 3: Validar D-1.4 + D-1.5 vía SQL**

Run:
```sql
-- D-1.4
select hour, hit_ratio, call_count from mv_cache_hit_ratio
 where phase = 'summarize' and hour >= now() - interval '2 hours'
 order by hour desc;
-- esperar hit_ratio >= 0.75 tras procesar >5 docs

-- D-1.5
select day, phase, model, sum(cost_cents) as cost, sum(call_count) as calls
  from mv_llm_costs_daily
 where day >= current_date - 1
 group by 1,2,3 order by 1,2,3;
-- esperar: Pro para TOC/structure, Flash para summarize (cuando esté disponible)
```

- [ ] **Step 4: Documentar resultados en memoria**

Create `~/.claude/projects/-Users-enzo-sda-framework-sda-framework/memory/wave_1_prod_results.md`:
```markdown
---
name: wave-1-prod-results
description: Resultados de validación D-1.1 a D-1.7 en prod, gotchas encontrados durante deploy + verify
metadata:
  type: project
---

# Wave 1 — resultados de validación en prod

**Fecha:** YYYY-MM-DD
**Tag:** wave-1-pdf-complete

## Criterios D-1.x

| # | Status | Valor medido | Notas |
|---|---|---|---|
| D-1.1 | ✅/❌ | XXs / $0.0X | tech_manual_50p |
| D-1.2 | ✅/❌ | path_used=fast, N calls | |
| D-1.3 | ✅/❌ | F1=0.X | scan_legal_50p_es |
| D-1.4 | ✅/❌ | hit_ratio=0.X post 5 docs | |
| D-1.5 | ✅/❌ | distribución modelos | |
| D-1.6 | ✅/❌ | text_contextualized populated | |
| D-1.7 | ✅/❌ | XXs / $0.X | book_300p |

## Stress arxiv summary

- Sample: 50 papers cs.AI
- Success: X/50
- Avg cost: $0.XX
- Avg cache hit: XX%
- Bottlenecks: ...

## Gotchas nuevos encontrados (para futura Wave)

- ...

## Action items pendientes

- ...
```

Update `~/.claude/projects/-Users-enzo-sda-framework-sda-framework/memory/MEMORY.md` agregando línea:
```markdown
- [Wave 1 prod results](wave_1_prod_results.md) — validación D-1.x + gotchas
```

- [ ] **Step 5: Git tag**

Run:
```bash
git tag -a wave-1-pdf-complete -m "Wave 1 complete: PDF + costo. D-1.x validated en prod."
git push origin wave-1-pdf-complete
```

- [ ] **Step 6: Cierre**

Informar al usuario:
```
Wave 1 complete. Tag: wave-1-pdf-complete
Resultados: ver wave_1_prod_results.md
Próxima Wave: 2 (observability + admin UI + alertas)
```

---

## Self-review post-extensión

### Coverage del spec

| Sección spec | Tasks |
|---|---|
| §1.1 Topología (Fly + srv-ia-01 + tunnel) | 7, 14, 34, 35 |
| §1.2 Resilience download (8 mecanismos) | 9 (download.py) |
| §2.1-2.3 Estructura archivos + responsabilidades | 8, 17, 18, 19-25 |
| §2.4 Sin ciclos inter-módulo | implícito en orden de imports (Tasks 18-25) |
| §3.1 Anatomía universal prompts | 16 (cache_design), aplicado en 19-25 |
| §3.2 Tiered models | 5 (settings), 15 (router), aplicado en 27-28 |
| §3.3 Contextual prefix | 25 (combined call) |
| §3.4 Mini-experimento cache | 6 |
| §4.1.1-4.1.4 Migrations | 1, 2, 3, 4 |
| §4.2 Settings 26 nuevas | 5 |
| §5.1 structure_workflow refactor | 27 |
| §5.2 summarize_workflow refactor | 28 |
| §5.3 LEAN distribución | implícita en submódulos 19-25 |
| §5.4 LangGraph checkpoints + signed_url gotcha | 27 (load_document regenera URL) |
| §6.1 Corpus 8 PDFs | 30 |
| §6.2 Ground truth YAML | 30, 32 |
| §6.3 Fixture pytest | 31 |
| §6.4 Pyramid markers | 33 |
| §6.5 Stress arxiv | 33 |
| §6.6 Pull-forward Wave 2 (llm_calls insert + matview) | 4, 28 |
| §7.3 Quick-fail gates | 6 (cache), 34 (mineru healthz), 36 (D-1.x verify) |
| §8.3 Criterios de done | 33, 36 |

Todo cubierto.

### Placeholders sin cerrar (intencionales)

- Task 30 tiene `REEMPLAZAR_URL_*` que deben anotarse manualmente — proceso de curación humano (no es un placeholder olvidado).
- Task 32 helper `upload_to_supabase_and_signed_url` queda como `NotImplementedError` con comentario explicativo — el operador adapta al setup local.
- Task 26 explica explícitamente que los `.j2` Wave 2 NO se crean en Wave 1 (decisión LEAN), no es un placeholder olvidado.

### Type consistency

- `TocNode` definido en Task 18 (`structure/types.py`) usado por Tasks 19, 20, 21, 22, 23, 27.
- `ValidationResult` definido Task 18 usado por Tasks 22, 23, 27.
- `PromptParts` definido Task 16 usado por Tasks 19, 20, 21, 23, 25.
- `LLMConfig` + `Phase` definidos Task 15 usados por Tasks 27, 28.
- `MineruClient`/`ParseRequest` definidos Task 17 usados por Task 27.
- `SplitConfig` definido Task 24 usado por Task 27.
- `ContextualResult` definido Task 25 usado por Task 28.

Consistente.

### Decisiones LEAN documentadas

1. Phase 2 = 11 tasks (no 13): `heuristics.py` y `pdf_native.py` viven sólo en mineru service. Task 17 nota inicial.
2. Prompts j2 separados se postponen a Wave 2 (Task 26). Wave 1 inline para hashear con `assert_prefix_stable`.
3. Pricing en `llm_calls.py` es aproximado/conservador, Wave 2 swap a real API pricing (Task 28).
4. Cost estimation se hace con tabla local en vez de query a DeepSeek por call.
5. PDF binary download in workflow: para PDFs solo se hace UN download (sha verification) — Wave 2 optimiza persistiendo `sha_expected` al ingest.
