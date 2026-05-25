# Wave 1 — PDF + Costo (design)

**Status:** approved, ready for implementation plan
**Author:** Claude + Enzo
**Date:** 2026-05-25
**Predecessors:** `2026-05-24-ingest-index-design.md` (spec foundational), `2026-05-25-ingest-index-wave-0.md` (plan ejecutado Wave 0)
**Tag esperado al cierre:** `wave-1-pdf-complete`
**Esfuerzo estimado:** 8-10 días, ~33 tasks

---

## Executive summary

Wave 1 lleva el sistema desde "procesa markdown" (Wave 0) a "procesa PDFs reales del mundo real hasta 500 páginas en minutos por centavos". Implementa la pipeline PDF completa del algoritmo PageIndex (TOC detection + transform + index extraction + T+ validation + repair + recursive split), agrega las primeras 4 mejoras de costo/calidad sobre PageIndex vanilla, y resuelve el setup de MinerU en el server con GPU local.

**Las 4 mejoras incorporadas:**

| # | Mejora | Impacto |
|---|---|---|
| #1 | Contextual chunking (Anthropic) | summaries más coherentes, retrieval +30% en Wave 3 |
| #4 | Prompt cache maximization | costo input -90% en fases masivas (target hit ratio >75%) |
| #5 | MinerU fast-path heuristics | ~30% de PDFs procesados sin MinerU (gratis y rápido) |
| #6 | Tiered models por fase | costo total -40% (Pro para reasoning, Flash para volumen) |

**Decisiones arquitecturales clave de Wave 1:**

1. **MinerU corre en srv-ia-01** (GPU local) detrás de Cloudflare Tunnel → `mineru.sdaframework.com`. El indexer en Fly.io NUNCA toca el binario PDF — solo orquesta vía HTTP. El ISP residencial queda fuera del datapath crítico porque MinerU descarga el PDF directo de Supabase Storage.

2. **Servicio nuevo separado**: `services/sda-mineru-parser/` (FastAPI mínimo + MinerU wrapper + cache local LRU). NO se mete MinerU dentro del indexer (deps pesadas, GPU-specific, ciclo de vida distinto).

3. **Anatomía universal de prompts**: todos los prompts se estructuran `[static_system | static_instructions | static_schema | static_examples | semi_static_doc_ctx | dynamic_payload]` para maximizar cache de DeepSeek. Helpers en `llm/cache_design.py` con asserts de prefix stability.

4. **Combinar contextual prefix + summary en un solo LLM call** por nodo (no 2 calls separados) — ahorra latencia/costo y garantiza coherencia.

5. **Pull-forward de Wave 2**: `llm_calls` insert y matview `mv_cache_hit_ratio` se adelantan a Wave 1 porque sin ellos los criterios D-1.4 (cache hit) y D-1.5 (tiered routing) no son verificables.

---

## Sección 1 — Arquitectura general

### 1.1 Topología

```
                    ┌──────────────────────────────────┐
                    │  Supabase (anfawvxfepowsudlffnl) │
                    │   ┌────────────────────────────┐ │
                    │   │  Storage bucket 'docs'     │ │
                    │   │  (PDFs originales)         │ │
                    │   └────────────────────────────┘ │
                    │   ┌────────────────────────────┐ │
                    │   │  documents, tree_nodes     │ │
                    │   │  pgmq, langgraph_ckpt      │ │
                    │   └────────────────────────────┘ │
                    └──────────────────────────────────┘
                              ▲           ▲
                              │ asyncpg   │ pg_net.http_post
                              │           │ (cron tick)
                              ▼           │
              ┌───────────────────────┐   │
              │  sda-indexer-prod     │───┘
              │  (Fly.io, iad, x2 HA) │
              │  - structure workflow │
              │  - summarize workflow │
              │  - finalize workflow  │
              └───────────────────────┘
                         │ HTTPS POST /parse
                         │ {storage_path, signed_url}
                         ▼
              ┌───────────────────────────────────┐
              │  mineru.sdaframework.com          │
              │  (Cloudflare Tunnel → srv-ia-01)  │
              │      │                            │
              │      ▼                            │
              │  srv-ia-01 :8001                  │
              │  ┌─────────────────────────────┐  │
              │  │  FastAPI wrapper (sda-      │  │
              │  │  mineru-parser, ~500 LoC)   │  │
              │  │  - GET /healthz             │  │
              │  │  - POST /parse → markdown   │  │
              │  └─────────────────────────────┘  │
              │  ┌─────────────────────────────┐  │
              │  │  MinerU on GPU (ya inst.)   │  │
              │  └─────────────────────────────┘  │
              └───────────────────────────────────┘
                         │ HTTPS GET signed_url
                         ▼ (descarga PDF directo)
                  Supabase Storage
```

**Datapath crítico (descarga del PDF):**

El indexer Fly genera signed URL de Supabase Storage (TTL 60 min) y la manda a MinerU en el payload. MinerU descarga el PDF directo desde Supabase. El binario nunca cruza Fly→srv-ia-01 — el ISP residencial sólo procesa el binario en *ingreso* desde Supabase (los ISPs no suelen capear download), nunca por upload. El ISP queda fuera del datapath crítico.

**Resilience:**

Si srv-ia-01 cae, los jobs de `q_extract_structure` quedan en pgmq con visibility timeout. Cuando vuelve, se procesan. Cero pérdida.

### 1.2 Resilience de la descarga PDF

**Modelo de fallos cubiertos:**

| Falla | Frecuencia esperada | Mitigación |
|---|---|---|
| Network blip mid-transfer | Alta (red residencial) | Range resume + retry |
| Signed URL expira durante retry | Media (si re-enqueue) | TTL 60 min + regenerable |
| Supabase Storage 5xx transitorio | Baja | Tenacity retry exponencial |
| TCP timeout en PDFs grandes (50MB+) | Media | Streaming chunks + timeout generoso |
| Corrupción en transit | Muy baja | SHA256 validation end-to-end |
| Disco lleno en srv-ia-01 | Baja | Pre-check espacio + LRU cache |
| MinerU service down / degraded | Media | DLQ tipada después de N retries |

**Approach concreto (8 mecanismos LEAN):**

1. **Retries con tenacity + backoff exponencial + jitter** — reuso del patrón de `llm/retry.py`. 5 intentos, 2s→32s, jitter ±25%.
2. **HTTP Range resume** — `httpx` con header `Range: bytes=N-`. Activado cuando PDF >5MB. Supabase Storage lo soporta (S3-compatible). Convergencia incluso en red inestable.
3. **SHA256 validation end-to-end** — indexer pasa `expected_sha256` en el payload. MinerU valida después de descargar; mismatch → retry desde cero (no resume).
4. **Signed URL TTL = 60 min** (no 10) — cubre N retries con backoff sin regenerar. Si igual expira, MinerU devuelve `410 expired_signed_url` → indexer regenera URL fresca y re-enqueue.
5. **Streaming chunks a disco** — `httpx.stream()` con chunks de 1MB. Nunca cargamos el PDF entero en memoria.
6. **Cache LRU por sha256 en srv-ia-01** — `/var/cache/sda-mineru/<sha256>.pdf`. Limpieza por edad (>24h) o size total (>5GB). Idempotencia gratis para re-enqueues.
7. **Pre-check de espacio en disco** — antes de descargar, verificar `>2GB free`. Si no, abortar con `503 disk_full` (alerta en Wave 2).
8. **DLQ después de 5 fallas consecutivas** — patrón pgmq de Wave 0. Razón loguada con enum tipado (ver 4.1.2).

**Fuera de scope Wave 1 (deuda explícita):**
- Tailscale como fallback al tunnel
- Deep healthz con test-download
- Multi-region MinerU

---

## Sección 2 — Pipeline modules (descomposición LEAN)

### 2.1 Estructura de archivos nuevos

```
services/sda-indexer/src/sda_indexer/
├── pipeline/
│   ├── parser/
│   │   ├── pdf_mineru.py        # cliente HTTP a mineru service
│   │   ├── heuristics.py        # fast-path detection (#5)
│   │   └── pdf_native.py        # pypdf/pdfplumber para PDFs "lindos"
│   ├── structure/               # NUEVO submódulo
│   │   ├── __init__.py
│   │   ├── toc_detector.py
│   │   ├── toc_transformer.py
│   │   ├── index_extractor.py
│   │   ├── validator.py
│   │   └── repair.py
│   ├── splitter/                # NUEVO submódulo
│   │   └── large_node.py
│   └── summarizer/
│       ├── summarize.py         # (ya existe Wave 0)
│       └── contextual_prefix.py # NUEVO (#1)
├── llm/
│   ├── client.py                # (ya existe)
│   ├── retry.py                 # (ya existe)
│   ├── router.py                # NUEVO (#6)
│   └── cache_design.py          # NUEVO (#4)
├── prompts/
│   ├── _base.j2                 # (ya existe)
│   ├── summarize.j2             # (refactor para contextual)
│   ├── toc_detect.j2            # NUEVO
│   ├── toc_transform.j2         # NUEVO
│   ├── structure_extract.j2     # NUEVO
│   ├── structure_repair.j2      # NUEVO
│   └── contextual_prefix.j2     # NUEVO
└── workflows/
    └── structure.py             # REFACTOR — conditional edges fast/full
```

### 2.2 Servicio nuevo: `sda-mineru-parser`

```
services/sda-mineru-parser/
├── pyproject.toml               # deps: fastapi, httpx, magic-pdf, aiofiles, tenacity
├── Dockerfile                   # base GPU image, MinerU pre-installed
├── src/
│   ├── main.py                  # FastAPI app, ~80 LoC
│   ├── download.py              # download resiliente (ver 1.2)
│   ├── cache.py                 # LRU cache por sha256
│   ├── parser.py                # wrapper subprocess MinerU + heurística nativa
│   └── healthz.py               # /healthz endpoint
├── tests/
└── systemd/sda-mineru.service   # boot en srv-ia-01
```

### 2.3 Responsabilidades por módulo

**Regla LEAN:** cada módulo hace UNA cosa, <300 LoC. Si en implementación pasa de 300, parar y descomponer.

| Módulo | Input | Output | LoC est. |
|---|---|---|---|
| `parser/heuristics.py` | `pdf_bytes` o path | `{has_toc, has_text_layer, page_count, confidence, path_recommendation}` | ~150 |
| `parser/pdf_native.py` | path PDF "lindo" | `markdown_str` (pypdf direct extraction) | ~120 |
| `parser/pdf_mineru.py` | doc_id + storage_path | `(markdown_str, metadata)` via HTTP a MinerU service | ~100 |
| `structure/toc_detector.py` | `markdown_str` | `{toc_pages: [int], toc_raw: str}` (LLM-driven) | ~180 |
| `structure/toc_transformer.py` | `toc_raw` | `[TocNode]` (lista de dicts con title/depth/page) | ~200 |
| `structure/index_extractor.py` | `markdown_str` (no TOC) | `[TocNode]` inferido página por página | ~250 |
| `structure/validator.py` | `[TocNode]` | `{ok: bool, errors: [str], suggestions: [str]}` | ~180 |
| `structure/repair.py` | `[TocNode]` + errors | `[TocNode]` corregido (1 LLM call) | ~150 |
| `splitter/large_node.py` | `TreeNode` + `text` | `[TreeNode]` hijos si excede `max_tokens_per_node` | ~180 |
| `summarizer/contextual_prefix.py` | `doc_summary_short`, `chunk_text` | `(prefix_str, summary_str)` (combined call) | ~120 |
| `llm/router.py` | `phase: str` | `LLMConfig{model, temperature, max_tokens}` | ~80 |
| `llm/cache_design.py` | `PromptParts` | string assembled + assert prefix stability | ~100 |

### 2.4 Dependencias inter-módulo (sin ciclos)

```
workflows/structure.py
   ├── parser/heuristics.py (inicial via mineru.metadata)
   ├── parser/pdf_native.py        (fast path — sólo si mineru lo retornó)
   ├── parser/pdf_mineru.py        (1 call combinada)
   ├── structure/toc_detector.py
   │      └── llm/router.py + cache_design.py
   ├── structure/toc_transformer.py
   ├── structure/index_extractor.py  (fallback si no hay TOC)
   ├── structure/validator.py
   ├── structure/repair.py
   └── splitter/large_node.py

workflows/summarize.py
   ├── summarizer/contextual_prefix.py
   ├── summarizer/summarize.py
   └── llm/router.py + cache_design.py
```

---

## Sección 3 — LLM strategy

### 3.1 Anatomía universal de prompts (Mejora #4)

Todo prompt sigue la misma estructura para maximizar cache de DeepSeek:

```
┌─ STATIC (cache hit cross-doc) ─────────────────────────┐
│ [system_prompt]              ~200 toks  fixed forever  │
│ [phase_instructions]         ~400-800   fixed per phase│
│ [output_schema (JSON)]       ~200-400   fixed per phase│
│ [few_shot_examples]          ~500       fixed per phase│
├─ SEMI-STATIC (cache hit per-doc) ──────────────────────┤
│ [doc_summary_short]          ~200       same per doc   │
├─ DYNAMIC (always varies) ──────────────────────────────┤
│ [chunk_text / page / nodes]  variable                  │
└────────────────────────────────────────────────────────┘
```

**Total estático por fase: ~1300-1900 tokens** — por encima del threshold de DeepSeek (~1024 toks para activar cache). Cache hit ratio target: **>75%**.

**Enforcement en `llm/cache_design.py`:**

```python
class PromptParts:
    static_system: str
    static_instructions: str
    static_schema: str
    static_examples: list[dict]
    semi_static_doc_ctx: str    # per-doc
    dynamic_payload: str        # always varies

    def assemble(self) -> str: ...
    def assert_prefix_stable(self, other: 'PromptParts') -> None: ...
```

En dev/test mode, hashea cada zona y asserts cross-call que las static no cambien entre llamadas de la misma fase. Previene drift silencioso ("Cache hit ratio bajo = costos 100x previstos" — gotcha conocido).

### 3.2 Tiered models (Mejora #6)

| Fase | Modelo (default) | Calls/doc (est.) | Razón |
|---|---|---|---|
| `toc_detect` | `deepseek-chat` (Pro) | 5-15 | Reasoning estructural, errores caros |
| `toc_transform` | `deepseek-chat` | 1 | JSON estructurado, infrecuente |
| `index_extract` | `deepseek-chat` | 10-30 | No-TOC path, reasoning duro |
| `validator` | `deepseek-chat` | 1 | Checks lógicos sobre tree completo |
| `repair` | `deepseek-chat` | 0-3 | Necesita contexto rico para fix |
| `summarize+ctx_prefix` | `deepseek-chat` Flash variant¹ | N (1 por nodo, ~50-300) | Massive volume, simple task |

¹ Modelos DeepSeek concretos a confirmar en task 0.6 (verificar catálogo actual). Settings hot-reload (`llm.router.<phase>.model`) permiten swap sin redeploy.

**Defaults en `app_settings`:**

```yaml
llm.router.toc.model: "deepseek-chat"
llm.router.structure.model: "deepseek-chat"
llm.router.repair.model: "deepseek-chat"
llm.router.summarize.model: "deepseek-chat"  # swap a flash cuando aparezca
llm.router.summarize.temperature: 0.1
llm.router.toc.temperature: 0.0
```

### 3.3 Contextual prefix (Mejora #1)

**Approach:** un solo LLM call por nodo que produce JSON `{prefix, summary}`. NO separar en 2 calls.

```jinja
{# contextual_prefix.j2 — combined prompt #}
You are processing a chunk from a document.
Document context: {{ doc_summary_short }}
Chunk content: {{ chunk_text }}

Output JSON:
{
  "prefix": "50-100 token contextual lead-in (e.g., 'This section of the Acme Corp 2026 contract discusses...')",
  "summary": "concise summary of the chunk content, starting with the topic"
}
```

**Persistencia (migration 011 agrega columnas):**
- `tree_nodes.text_contextualized` = `prefix + "\n\n" + chunk_text` → satisface D-1.6
- `tree_nodes.summary` = `summary` (ya existe Wave 0)
- `tree_nodes.summary_model` = "deepseek-chat" (nueva col, tracking #6)

**Generación de `doc_summary_short`** (input al prompt cacheable per-doc): el `structure_workflow` lo produce al final de la fase de estructura (después de armar el tree, antes del fan-out de summarize). Esto garantiza que TODOS los summarize calls del doc tengan el mismo `doc_summary_short` → cache hit dentro del TTL de DeepSeek.

### 3.4 Verificación empírica de cache (task 0.6, quick-fail gate)

Antes de procesar PDFs reales, mini-experimento que el plan ejecuta día 1:

1. Mandar 5 prompts idénticos con un único byte distinto al final
2. Verificar que el segundo+ devuelve `usage.prompt_cache_hit_tokens > 0` (verificar nombre exacto del field en la API actual de DeepSeek)
3. Confirmar TTL aproximado (mandar idéntico después de 1h, 4h, 24h)
4. Documentar en `docs/superpowers/notes/deepseek-cache-empirical.md`

**Gate:** si DeepSeek NO cachea o TTL <30min → re-evaluar Mejora #4 antes de invertir en `cache_design.py`.

---

## Sección 4 — Schema + settings

### 4.1 Migraciones (4 chicas, no monolíticas)

#### 4.1.1 `20260526000011_pdf_wave1_columns.sql`

```sql
alter table documents
  add column page_count int,
  add column parser_used text check (parser_used in ('native', 'mineru')),
  add column path_used text check (path_used in ('fast', 'full')),
  add column doc_summary_short text;

alter table tree_nodes
  add column text_contextualized text,
  add column summary_model text,
  add column appear_start int,
  add column appear_end int;

create index tree_nodes_appear_start_idx
  on tree_nodes(document_id, appear_start);
```

#### 4.1.2 `20260526000012_indexing_failure_reasons.sql`

```sql
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

alter table indexing_jobs
  add column failure_reason indexing_failure_reason,
  add column failure_detail text;
```

#### 4.1.3 `20260526000013_pgmq_resilience.sql` (cierra D-0.3)

```sql
-- Visibility timeout para que jobs in_flight no se queden colgados
-- Wave 0 dejó vt default (~30s); PDFs grandes exceden eso.
-- API pgmq.set_vt(queue, msg_id, vt_seconds) en cada read.

create or replace function gc_stuck_jobs() returns int as $$
  declare n int;
  begin
    update indexing_jobs
       set status='failed',
           failure_reason='unknown',
           failure_detail='stuck in_flight >30 min, GC reclaimed'
     where status='in_flight'
       and started_at < now() - interval '30 minutes'
    returning 1 into n;
    return coalesce(n, 0);
  end $$ language plpgsql;

select cron.schedule('gc-stuck-jobs', '*/5 * * * *',
                     $$select gc_stuck_jobs()$$);
```

#### 4.1.4 `20260526000014_matview_cache_hit.sql` (pull-forward Wave 2)

```sql
create materialized view mv_cache_hit_ratio as
select
  date_trunc('hour', created_at) as hour,
  phase,
  sum(cache_hit_tokens)::float / nullif(sum(prompt_tokens), 0) as hit_ratio,
  count(*) as call_count
from llm_calls
where created_at > now() - interval '7 days'
group by 1, 2;

create unique index on mv_cache_hit_ratio(hour, phase);

select cron.schedule('refresh-cache-hit-mv', '*/5 * * * *',
                     $$refresh materialized view concurrently mv_cache_hit_ratio$$);
```

### 4.2 Settings nuevas (~26)

```yaml
# === Fast-path heuristics (Mejora #5) ===
parser.fast_path.enabled: true
parser.fast_path.min_text_ratio: 0.7
parser.fast_path.max_pages_for_fast: 100
parser.fast_path.require_toc: false
parser.fast_path.min_confidence: 0.8

# === MinerU service ===
parser.mineru.url: "https://mineru.sdaframework.com"
parser.mineru.timeout_seconds: 600
parser.mineru.signed_url_ttl_seconds: 3600
parser.mineru.max_pdf_mb: 100

# === Download resilience (sec 1.2) ===
parser.download.max_retries: 5
parser.download.backoff_base_seconds: 2
parser.download.range_resume_min_mb: 5
parser.download.chunk_size_kb: 1024

# === PageIndex algorithm ===
pageindex.max_tokens_per_node: 8000
pageindex.min_tokens_per_node: 200
pageindex.max_tree_depth: 6
pageindex.toc_detection_max_pages: 20
pageindex.if_add_node_text: true

# === Contextual chunking (Mejora #1) ===
summarize.contextual_chunking.enabled: true
summarize.contextual_chunking.prefix_max_tokens: 100

# === Tiered models (Mejora #6) ===
# Las sub-fases `validator` y `repair` caen al grupo `structure.*` por default
# (son parte conceptual de la fase estructura). Wave 2 puede granularizar más
# si se necesita override per sub-fase.
llm.router.toc.model: "deepseek-chat"
llm.router.toc.temperature: 0.0
llm.router.structure.model: "deepseek-chat"
llm.router.structure.temperature: 0.0
llm.router.summarize.model: "deepseek-chat"
llm.router.summarize.temperature: 0.1
```

Total: 26 settings nuevas, todas con scope `global` default, sobreescribibles a nivel `collection_id` o `document_id` (cascade del sistema Wave 0).

---

## Sección 5 — Workflows

### 5.1 `structure_workflow` (refactor mayor)

**Decisión clave de datapath:** el indexer Fly NUNCA toca el binario PDF. El mineru service hace todo el trabajo pesado en **una sola llamada** que retorna `(markdown, metadata)`.

```
                ┌──────────────────────────────────┐
                │  ENTRY: indexing_job_id          │
                └───────────────┬──────────────────┘
                                ▼
                       load_document(doc_id)
                                │
                                ▼
                    classify_file_type
                       (markdown | pdf | other)
                                │
                ┌───────────────┴────────────────┐
                ▼                                ▼
        parse_markdown                   parse_pdf
        (Wave 0, ya existe)        (POST /parse a mineru service —
                │                   1 call → markdown +
                │                   {parser_used, path_used,
                │                    page_count, heuristics_meta})
                │                                │
                └────────────────┬───────────────┘
                                 ▼
                        detect_toc (LLM)
                                 │
                       ┌─────────┴──────────┐
                       │ toc_found?         │
                       ▼                    ▼
              transform_toc           extract_index
              (toc_raw → tree)        (page-by-page LLM)
                       │                    │
                       └─────────┬──────────┘
                                 ▼
                        validate_tree
                                 │
                       ┌─────────┴──────────┐
                       │ valid?             │
                       ▼                    ▼
                    (skip)             repair_tree
                                       (max 2 iter loop)
                                            │
                       ┌────────────────────┘
                       ▼
                 split_large_nodes
                 (recursive on >max_tokens)
                                 │
                                 ▼
                 generate_doc_summary_short
                 (1 LLM call → cache prefix per-doc)
                                 │
                                 ▼
                      persist_tree
                  (insert tree_nodes →
                   on_tree_node_inserted trigger →
                   pgmq q_summarize_node fan-out)
                                 │
                                 ▼
                mark_structure_complete
                (indexing_jobs.status='structure_done')
```

**Contrato MinerU service (1-call):**

```http
POST https://mineru.sdaframework.com/parse
Content-Type: application/json
Authorization: Bearer <shared_secret>

{
  "doc_id": "uuid",
  "signed_url": "https://...supabase.co/.../doc.pdf?token=...",
  "expected_sha256": "abc123...",
  "force_path": null   // 'fast' | 'full' opcional para override
}

Response 200:
{
  "markdown": "...",
  "metadata": {
    "parser_used": "native|mineru",
    "path_used": "fast|full",
    "page_count": 47,
    "heuristics": {
      "has_text_layer": true,
      "has_toc": true,
      "text_ratio": 0.92,
      "confidence": 0.88
    },
    "elapsed_seconds": 12.3,
    "cache_hit": false  // true si srv-ia-01 lo tenía cached por sha256
  }
}

Response 4xx/5xx con failure_reason tipado del enum 4.1.2.
```

### 5.2 `summarize_workflow` (cambio modest)

```
   ENTRY: tree_node_id
        │
        ▼
  load_node + load_doc_ctx
  (tree_nodes row + documents.doc_summary_short)
        │
        ▼
  assemble_contextual_prompt
  (usa llm/cache_design.PromptParts —
   static + doc_summary_short + chunk_text)
        │
        ▼
  call_llm_combined
  (1 call, returns JSON {prefix, summary})
        │
        ▼
  persist
  (tree_nodes.text_contextualized = prefix + chunk_text,
   tree_nodes.summary = summary,
   tree_nodes.summary_model = router.choice)
        │
        ▼
  insert_llm_call (pull-forward Wave 2 — populate llm_calls row)
        │
        ▼
  mark_node_ready
  (trigger on_tree_node_ready con advisory lock,
   eventually fires q_finalize)
```

### 5.3 LEAN: distribución por archivo

Cada node del grafo es una función importada — `workflows/structure.py` queda como **orquestador puro** (~150 LoC):

```python
# workflows/structure.py (refactor)
from sda_indexer.pipeline.parser import pdf_mineru, markdown_regex
from sda_indexer.pipeline.structure import (
    toc_detector, toc_transformer, index_extractor, validator, repair
)
from sda_indexer.pipeline.splitter import large_node
from sda_indexer.pipeline.summarizer import contextual_prefix

# StateGraph builder + conditional edges, sin lógica de negocio inline.
```

### 5.4 Resume / idempotencia con LangGraph checkpoints

**Gotcha conocido:** AsyncPostgresSaver + `thread_id` pattern (memoria `ingest-index-gotchas`).

- `thread_id = f"structure:{doc_id}"`
- Si el structure_workflow falla en `repair_tree` y se re-encola, LangGraph reanuda desde el checkpoint anterior → `parse_pdf` NO se re-ejecuta (caro). El `markdown` ya está en state.
- **Si pasaron >60min**, el `signed_url` que está en el state expiró. Solución: el `signed_url` NO se guarda en state. El `load_document` (siempre primer nodo, incluso en resume) regenera signed URL cada vez. State guarda sólo `storage_path`.
- Loop `validate → repair → validate` con cap explícito de **2 iteraciones**. Si después de 2 repairs sigue inválido → `failure_reason='structure_unreparable'` → DLQ.

---

## Sección 6 — Testing strategy

### 6.1 Corpus canonical (8 PDFs)

8 PDFs públicos curados, cada uno valida criterios específicos:

| ID | Páginas | Tipo | Valida |
|---|---|---|---|
| `tech_manual_5p` | 5 | Manual chico con TOC | smoke fast-path |
| `tech_manual_50p` | 50 | Manual técnico con TOC | **D-1.1** + **D-1.2** |
| `scan_legal_50p_es` | 50 | Scan en español sin TOC | **D-1.3** |
| `contract_30p` | 30 | Contrato público | **D-1.6** |
| `book_300p` | 300 | Libro técnico completo | **D-1.7** |
| `paper_with_tables` | 25 | Paper con tablas/figuras | edge: parser robustness |
| `toc_misleading_40p` | 40 | TOC que no matchea contenido | repair pathway |
| `paper_en_30p` | 30 | Paper en inglés | robustness multi-idioma |

### 6.2 Ground truth en `tests/fixtures/pdf_corpus.yaml`

```yaml
pdfs:
  - id: tech_manual_50p
    url: https://example.com/path.pdf
    sha256: "abc123..."
    license: "CC-BY-4.0"
    expected:
      page_count: 50
      path_used: fast
      parser_used: native
      llm_calls_max: 30
      duration_seconds_max: 120
      cost_cents_max: 5
      toc_nodes_count_min: 8
      toc_nodes_count_max: 15
      toc_nodes_titles_expected:
        - "Introducción"
        - "Arquitectura"
        - "Instalación"
        # ... usado para F1 score
```

### 6.3 Fixture pytest (descarga on-demand, cache local)

```python
# tests/conftest.py
@pytest.fixture(scope="session")
def canonical_corpus():
    cache_dir = Path("~/.cache/sda-test-corpus").expanduser()
    cache_dir.mkdir(parents=True, exist_ok=True)
    manifest = yaml.safe_load(
        Path("tests/fixtures/pdf_corpus.yaml").read_text()
    )
    corpus = []
    for entry in manifest["pdfs"]:
        local = cache_dir / f"{entry['id']}.pdf"
        if not local.exists() or sha256_file(local) != entry["sha256"]:
            httpx.stream("GET", entry["url"]).save(local)
            assert sha256_file(local) == entry["sha256"], "corpus corrupt"
        corpus.append(CorpusEntry(entry, local))
    return corpus
```

Los PDFs NO entran al repo (binarios pesados). El manifest YAML sí.

### 6.4 Pirámide de tests (respetando "nunca mocks" del CLAUDE.md)

```
                  ┌──────────────────┐
                  │  E2E (8 tests)   │  ← uno por canonical PDF
                  │  test_d1_1_50p   │     full pipeline real
                  │  test_d1_7_300p  │     (DeepSeek + MinerU + Supabase)
                  └──────────────────┘
                         ▲
                  ┌──────────────────────┐
                  │  Integration (~15)   │  ← cada módulo nuevo, LLM real
                  │  test_toc_detector   │
                  │  test_repair_loop    │
                  └──────────────────────┘
                         ▲
              ┌──────────────────────────────┐
              │  Unit (~40, pure functions)  │  ← sin IO, sin mocks
              │  heuristics regex            │
              │  validator on given tree     │
              │  splitter recursive          │
              │  cache_design.assert_prefix  │
              └──────────────────────────────┘
```

**Markers:**

```python
@pytest.mark.unit        # default, en cada commit, <5s total
@pytest.mark.integration # opt-in, ~$0.05 / run, ~30s
@pytest.mark.e2e         # opt-in, ~$0.50 / run, ~10min
@pytest.mark.stress      # script aparte, ~$2-5, ~30min
```

CI default: solo `unit`. Pre-merge gate: `integration`. On-demand local: `e2e + stress`.

**Filosofía:** "nunca mocks" del CLAUDE.md NO equivale a "todo es E2E caro". Las unit tests cubren pure functions (heuristics, validator, splitter) que son determinísticas — no necesitan ni mocks ni IO real.

### 6.5 Stress test — `tests/stress/run_arxiv_sample.py`

Script aparte (no pytest):

1. Descarga 50 PDFs random vía arXiv API (`cs.AI`, páginas 10-200 uniformes)
2. Sube a Supabase Storage bucket `docs-stress/`
3. Polls hasta `ready` o `failed`
4. Recolecta metrics: cache hit ratio promedio, costo, distribución fast/full, percentiles latencia
5. Output: `tests/stress/results/<timestamp>.csv` + `report.md`

Valida **D-1.4** y **D-1.5** sobre N>>1.

### 6.6 Pull-forward de Wave 2

Necesario para hacer Wave 1 verificable:

1. **`llm_calls` insert** en `summarize_workflow` y `structure_workflow` — populate `model`, `prompt_tokens`, `completion_tokens`, `cache_hit_tokens`, `cost_cents` por call. Wave 0 lo dejó TODO; Wave 1 lo cierra.

2. **Matview `mv_cache_hit_ratio`** — migration `014`, refresh cada 5min.

**NO se adelanta:** Langfuse, alertas, admin UI, DLQ replay endpoint. Esos quedan firmes en Wave 2.

---

## Sección 7 — Orden de implementación

### 7.1 Fases paralelizables

```
Fase 0: Bootstrap            ─┐
(migrations + settings)       │ paralelizables
Fase 1: MinerU service       ─┤ entre sí
(srv-ia-01 setup)             │
Fase 2: Pipeline modules     ─┘ (unit-testable)
        │
        ▼
Fase 3: Workflows refactor (depende de Fase 2)
        │
        ▼ (puede arrancar parcial con Fase 4 anotando ground truth)
Fase 4: Corpus + E2E (depende de Fase 1+3)
        │
        ▼
Fase 5: Deploy + verify criterios de done
```

### 7.2 Tasks detalladas

**Fase 0 — Bootstrap (7 tasks)**
- 0.1 Migration `011_pdf_wave1_columns.sql`
- 0.2 Migration `012_indexing_failure_reasons.sql`
- 0.3 Migration `013_pgmq_resilience.sql` — **cierra D-0.3**
- 0.4 Migration `014_matview_cache_hit.sql` + `llm_calls` insert refactor
- 0.5 Settings registry expansion (~26)
- 0.6 Mini-experimento empírico DeepSeek cache
- 0.7 Update `docs/runbooks/wave-0-prod-deploy.md` con realidad Fly.io

**Fase 1 — MinerU service (7 tasks)**
- 1.1 Scaffold `services/sda-mineru-parser/`
- 1.2 `download.py` (Range resume + retries + sha256 + streaming)
- 1.3 `cache.py` (LRU local)
- 1.4 `parser.py` (subprocess MinerU + heurísticas nativas)
- 1.5 `main.py` FastAPI (`/parse`, `/healthz`)
- 1.6 `systemd/sda-mineru.service` + cloudflared en srv-ia-01
- 1.7 DNS Vercel → `mineru.sdaframework.com` + TLS

**Fase 2 — Pipeline modules (13 tasks)**
- 2.1 `pipeline/parser/heuristics.py` + tests
- 2.2 `pipeline/parser/pdf_native.py` + tests
- 2.3 `pipeline/parser/pdf_mineru.py` + integration test
- 2.4 `llm/router.py` + tests
- 2.5 `llm/cache_design.py` + tests
- 2.6 `pipeline/structure/toc_detector.py` + integration tests
- 2.7 `pipeline/structure/toc_transformer.py` + integration tests
- 2.8 `pipeline/structure/index_extractor.py` + integration tests
- 2.9 `pipeline/structure/validator.py` + unit tests
- 2.10 `pipeline/structure/repair.py` + integration tests
- 2.11 `pipeline/splitter/large_node.py` + tests
- 2.12 `pipeline/summarizer/contextual_prefix.py` + integration tests
- 2.13 5 prompts nuevos + refactor `summarize.j2`

**Fase 3 — Workflows refactor (4 tasks)**
- 3.1 `workflows/structure.py` refactor con conditional edges
- 3.2 `workflows/summarize.py` refactor con contextual prefix + `llm_calls` insert
- 3.3 `workflows/finalize.py` ajuste minor
- 3.4 Integration tests workflows end-to-end

**Fase 4 — Corpus + E2E (5 tasks)**
- 4.1 `tests/fixtures/pdf_corpus.yaml` con 8 entries
- 4.2 `tests/conftest.py` fixture `canonical_corpus`
- 4.3 Ground truth de TOCs para 8 PDFs: Claude propone primera versión (LLM-extracted con prompt verboso de "extract every section heading"), Enzo revisa/corrige en ~30min total. NO es lo mismo que correr el pipeline — es un solo LLM call por PDF sin pipeline involvement, sirve como referencia independiente.
- 4.4 8 E2E tests mapeados a criterios D-1.x
- 4.5 `tests/stress/run_arxiv_sample.py` + first run baseline

**Fase 5 — Deploy + verify (3 tasks)**
- 5.1 Deploy MinerU service a srv-ia-01 + smoke test
- 5.2 Deploy indexer v0.2 a Fly.io + smoke test
- 5.3 Run canonical E2E + stress en prod → verify D-1.1 a D-1.7 + update memorias

**Total**: 33 tasks. Esfuerzo: 8-10 días.

### 7.3 Quick-fail gates

| Gate | Cuándo | Acción si falla |
|---|---|---|
| Mini-experimento cache (task 0.6) | Día 1 | Si DeepSeek NO cachea o TTL <30min → re-evaluar Mejora #4 antes de invertir en `cache_design.py` |
| MinerU `/healthz` desde Fly (task 5.1) | Pre-E2E | Si Cloudflare Tunnel agrega >2s latencia base → revisar config |
| D-1.1 con `tech_manual_50p` | Mid-Fase 5 | Si >2min o >$0.05 → analizar bottleneck antes de seguir |
| D-1.4 (cache ratio) post-5-docs | Fin Fase 5 | Si <50% → revisar prefix stability con `assert_prefix_stable` logs |

---

## Sección 8 — Out of scope, riesgos, criterios de done

### 8.1 Out of scope explícito Wave 1

- **Langfuse / OTel** — Wave 2
- **Admin UI** (settings tree, DLQ inspect) — Wave 2
- **DLQ replay endpoint** — Wave 2
- **Alertas** (cache hit bajo, DLQ growing) — Wave 2
- **Entities, embeddings, Kuzu** — Wave 3
- **Multi-modal** (tables, figures como nodos tipados) — Wave 3
- **Incremental re-index** — Wave 3
- **Vllm self-hosted LLM** — sin fecha (depende de economía)
- **Multi-region MinerU** — sin fecha
- **Tailscale fallback al Cloudflare Tunnel** — sin fecha

### 8.2 Riesgos conocidos y mitigaciones

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| DeepSeek cache TTL menor a lo esperado | Media | Alto (costos 2-10x) | Mini-experimento task 0.6, decisión temprana |
| MinerU OOM en PDFs muy grandes (300+pag) | Media | Medio (timeout, retry caro) | `parser.mineru.max_pdf_mb`, DLQ tipada `mineru_oom` |
| Ground truth manual mal anotada → D-1.3 falsos rojos | Baja | Medio (debugging fantasma) | Doble review de los 8 PDFs antes de codificar tests |
| Range resume no funciona en Supabase Storage | Baja | Medio (degrada a retry full) | Test temprano en task 1.2; fallback documentado |
| Cloudflare Tunnel agrega latencia variable | Media | Bajo (latencia, no errores) | Métricas en `/healthz`; queda como deuda si <5s p99 |
| MinerU service down → indexing pausa | Media | Bajo (async, sin pérdida) | Visibility timeout en pgmq, alerta Wave 2 |
| Modelo DeepSeek Flash no existe con nombre esperado | Alta | Bajo (config swap) | Settings hot-reload, default a `deepseek-chat` |

### 8.3 Criterios de done

| # | Criterio | Cómo se valida |
|---|---|---|
| **D-1.1** | PDF 50pag → indexado <2min, costo <$0.05 | E2E con `tech_manual_50p`: assert wall_clock<120s, sum(llm_calls.cost_cents)<5 |
| **D-1.2** | PDF "lindo" con TOC → `path_used='fast'`, <30 calls DeepSeek | E2E: assert `documents.path_used='fast'`, count(llm_calls)<30 |
| **D-1.3** | PDF "feo" scan sin TOC → `path_used='full'`, accuracy_score >0.7 | E2E con `scan_legal_50p_es`: assert path_used='full'. `accuracy_score` = **F1 entre títulos extraídos por el pipeline y `toc_nodes_titles_expected` del ground truth**, normalizando whitespace y casing. Threshold: 0.7. |
| **D-1.4** | `mv_cache_hit_ratio` >0.75 para fase `summarize` post 5 docs | Query SQL después de Fase 5 stress test |
| **D-1.5** | `mv_llm_costs_daily` muestra Pro en TOC/structure, Flash en summaries | Group by phase, model en `llm_calls` |
| **D-1.6** | `tree_nodes.text_contextualized` no null; summaries empiezan con tema | SQL `select text_contextualized, summary from tree_nodes`; assert text_contextualized not null; LLM-as-judge en muestra de 20 nodos |
| **D-1.7** | PDF 300pag → indexado <10min, costo <$0.50 | E2E con `book_300p`: assert wall_clock<600s, cost_cents<50 |

### 8.4 Dependencias con otras Waves

**Hereda de Wave 0:**
- Settings system (cascade global → collection → document)
- pgmq queues, pg_cron dispatcher, pg_net.http_post
- LangGraph + AsyncPostgresSaver checkpoints en `langgraph_checkpoints` schema
- Trigger pattern `on_*_inserted/ready`
- Fly.io deploy patrón
- Vault para secrets (DEEPSEEK_API_KEY, srv_ia_01_url + secret)

**Habilita para Wave 2:**
- `llm_calls` poblado → cost & cache dashboards
- `indexing_failure_reason` enum → DLQ inspection UI tipada
- Matview `mv_cache_hit_ratio` → alertas
- `documents.doc_summary_short` → contexto para re-summarize incremental

**Habilita para Wave 3:**
- `tree_nodes.text_contextualized` → input directo para embeddings (3e)
- Tree estructurado consistente → base para entity extraction (3c)
- Settings `pageindex.*` → tunables por dominio (3b typed extraction)

---

## Apéndice — referencias internas

- Spec foundational: [`2026-05-24-ingest-index-design.md`](./2026-05-24-ingest-index-design.md) — §4 Wave 1, mejoras 1/4/5/6
- Plan Wave 0 (patrón): [`2026-05-25-ingest-index-wave-0.md`](../plans/2026-05-25-ingest-index-wave-0.md)
- Memorias relevantes:
  - `ingest_index_gotchas.md` — race conditions, trampas PageIndex, LangGraph checkpoints
  - `wave_0_prod_deploy.md` — arquitectura final Fly.io + Supabase
  - `wave_0_prod_gotchas.md` — ISP, pooler, vault, cron sub-min
  - `supabase_migrations_gotchas.md` — db push remote, search_path
