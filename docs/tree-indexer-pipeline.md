# Tree Indexer Pipeline — Estado actual

Estado: post-deploy 2026-05-22.
Versiones vigentes:

- `tree_indexer_python v0.2.0`
- `compute_gateway_extraction v0.1.5`
- `extraction_pipeline v0.2.0`
- `mineru 3.1.15` con backend `hybrid-http-client`

Este documento es referencia operativa del pipeline real corriendo en
produccion. Para la decision teorica (por que copiamos a PageIndex), ver
[`pageindex-tree-builder-reference.md`](./pageindex-tree-builder-reference.md).
Para la vision general del sistema, ver [`arquitectura.md`](./arquitectura.md).

---

## 1. Resumen

SDA Tree Indexer construye un indice jerarquico tipo PageIndex desde los
artefactos que produce MinerU. El pipeline corre en `srv-ia-01` en tres
servicios separados que se comunican por HTTP privado:

- `mineru-api.service` (systemd, port 8765) tiene los modelos VLM
  precargados en GPU.
- `sda-compute-gateway.service` (systemd --user, port 8787) recibe jobs de
  Inngest, descarga el PDF y dispara MinerU via CLI con backend
  `hybrid-http-client` apuntando al puerto local 8765.
- `sda-tree-indexer.service` (systemd --user, port 8790) recibe los
  artefactos extraidos y ejecuta el grafo LangGraph que produce
  `doc_tree`, `doc_tree_nodes` y `chunks` con embeddings.

La paralelizacion es selectiva: solo los nodos que son genuinamente
independientes (refine de nodos grandes, summaries por nodo, routing
summaries por nodo) corren en paralelo via Send API. El outline inicial
queda secuencial porque depende de contexto acumulado entre grupos.

---

## 2. Diagrama de infraestructura

```
+------------------------------------------------------------------+
| CLOUD                                                            |
|                                                                  |
|   +----------+   +-----------+   +----------+   +------------+   |
|   | Vercel   |   | Supabase  |   | Inngest  |   | Upstash    |   |
|   | (Next 16)|<->| Postgres +|   | Cloud    |   | Redis      |   |
|   | frontend |   | Storage   |   | workflows|   | (cache v1) |   |
|   +----+-----+   +-----+-----+   +-----+----+   +-----+------+   |
|        |               |               |              |          |
|        | signed URL    | artifacts     | events       | summary  |
|        | document      | doc_tree/     | mineru.done  | cache    |
|        |               | chunks        | tree.done    | sha256   |
|        |               |               v              |          |
+--------+---------------+---------------+--------------+----------+
         |               |               |              |
         | HTTPS         | REST          | HTTP webhook | REST
         |               |               v              |
         |    +------------------------------------------------+
         |    | srv-ia-01 (Tailscale Funnel:                   |
         |    | https://srv-ia-01.taileb1b9c.ts.net)           |
         |    |                                                |
         |    | +--------------------------------------------+ |
         |    | | sda-compute-gateway.service  port 8787     | |
         |    | |  * recibe Inngest webhook                  | |
         |    | |  * descarga PDF de Supabase signed URL     | |
         |    | |  * spawn mineru CLI -b hybrid-http-client  | |
         |    | |  * sube artefactos a Supabase Storage      | |
         |    | |  * proxy /v1/tree-index-jobs               | |
         |    | |  concurrency: 2                            | |
         |    | +-------------+-------------+----------------+ |
         |    |               | ssh+spawn   | proxy HTTP       |
         |    |               v             v                  |
         |    | +----------------------+ +--------------------+|
         |    | | mineru-api.service   | | sda-tree-indexer   ||
         |    | | port 8765            | | port 8790          ||
         |    | |  * VLM preloaded     | |  * LangGraph       ||
         |    | |  * 2.7 GB VRAM       | |  * concurrency 4   ||
         |    | |  * concurrency 3     | |  * llm_inflight 12 ||
         |    | |  * hybrid-auto-      | |  * summary_conc 6  ||
         |    | |    engine on GPU     | |                    ||
         |    | +-----+----------------+ +--------------------+|
         |    |       |                                        |
         |    |       +---- consume GPU ------+                |
         |    |                                                |
         |    |  GPU: RTX PRO 6000 Blackwell, 98 GB VRAM       |
         |    |  used:  ~2.7 GB (MinerU VLM preloaded)         |
         |    |  free: ~94.5 GB                                |
         |    |  (vllm-nemotron container apagado el 21-05)    |
         |    +------------------------------------------------+
```

`mineru-api` esta bindeado a `127.0.0.1:8765` y NO se expone por
Funnel. Solo el gateway local lo consume. Esto evita pagar bearer auth y
mantiene la superficie minima.

---

## 3. Pipeline end-to-end

```
Usuario sube PDF
       |
       v
+------------------+
| Frontend Vercel  |
| /upload          |  document row + signed URL
+--------+---------+
         |
         v  event: indexing.requested
+------------------+
|  Inngest Cloud   |  workflow indexar()
+--------+---------+
         | POST /v1/index-jobs  (signed URL del PDF)
         v
+--------------------------------------------------+
|  Compute Gateway (srv-ia-01)                     |
|                                                  |
|  1. descarga PDF                                 |
|  2. spawn mineru CLI -b hybrid-http-client \\    |
|       -u http://127.0.0.1:8765                   |
|        |                                         |
|        v                                         |
|       mineru-api (GPU, hot)                      |
|        | devuelve: content_list, middle_json,    |
|        |            markdown, layout PDFs, OCR   |
|        v                                         |
|  3. sube artefactos a Supabase Storage           |
|  4. emit event compute/mineru.completed          |
+--------+-----------------------------------------+
         |
         v
+------------------+
|  Inngest Cloud   |  workflow construir_arbol()
+--------+---------+
         | POST /v1/tree-index-jobs  (extraction_id)
         v
+--------------------------------------------------+
|  Tree Indexer Python (srv-ia-01)                 |
|                                                  |
|  1. list_extraction_artifacts(extraction_id)     |
|  2. download_storage_json(content_list, middle)  |
|  3. content_list -> labeled_pages (raw_pages)    |
|  4. strip_repeated_headers_footers -> prompt_pgs |
|  5. source_blocks_from_mineru_middle             |
|  6. run_tree_index_graph(...)  <- ver Seccion 4  |
|  7. persist_tree_index(...)                      |
|       |                                          |
|       v                                          |
|     Supabase:                                    |
|       * doc_tree           (1 row con tree)      |
|       * doc_tree_nodes     (N rows + confidence) |
|       * chunks             (N rows + embedding)  |
|       * documents.metadata (status: completed)   |
|  8. emit event compute/tree.completed            |
+--------+-----------------------------------------+
         |
         v
+------------------+
|  Inngest Cloud   |  workflow notificar()
+--------+---------+
         | Supabase Realtime
         v
   Frontend ve doc en estado "indexed"
```

---

## 4. Grafo LangGraph

```
                            +------------+
                            |   START    |
                            +-----+------+
                                  |
                                  v
                  +-------------------------------+
                  | detect_document_type          |  LLM (retry policy)
                  | input: prompt_pages[:3]       |
                  | out:   metrics.document_type  |
                  +---------------+---------------+
                                  |
                                  v
                  +-------------------------------+
                  | detect_toc                    |  heuristico
                  |  * TOC_LINE regex en          |  determinista
                  |    primeras 15% paginas       |  SIN LLM
                  |  * resolucion logico->fisico  |
                  |    con matching de titulo     |
                  |  * si >=4 secciones con       |
                  |    ratio >=0.70 ->            |
                  |    tree_mode=toc_heuristic    |
                  |  * si no -> tree_mode=no_toc  |
                  +---------------+---------------+
                                  |
                    route_after_detect_toc
                  +---------------+---------------+
                  | toc_heuristic | no_toc        |
                  | (atajo)       | (normal)      |
                  v               v
            +=============================================+
            | build_candidate_tree                        |  LLM secuencial
            |  * split prompt_pages por _max_prompt_chars |  acumula contexto
            |  * por cada grupo: candidate_prompt(..)     |  entre grupos
            |  * acumula sections cross-grupo             |  retry policy
            |                                             |
            |  NOTA: NO se paraleliza porque rompe        |
            |  numeracion structure cross-grupo           |
            +-------------------+-------------------------+
                                |
                                v
                +-------------------------------+
                | verify_tree                   |  LLM
                |  * anchor matching contra     |  retry policy
                |    prompt_pages               |
                |  * metrics.verification_      |
                |    accuracy                   |
                +---------------+---------------+
                                |
                      route_after_verify
        +---------+----------+--------+-------------+
        | acc>=.95| acc.6-.95| acc<.6 | toc_heuris  |
        | o 0 inv | repair<1 | degrade| & acc<.7    |
        v         v          v        v
   post_process repair    degrade   build_candidate
   _tree        _sections _mode     _tree
   |            -> verify -> build  (descarta atajo
   |            (LLM)      candidate ToC, retry)
   |                       (tree_mode=
   |                        no_toc)
   v
+----------------------------------+
| post_process_tree                |
|  * candidate_sections -> tree    |
|  * assign source_blocks          |
|  * compute_node_confidence(      |
|      verifier_says_valid=True,   |
|      pages=raw_pages,            |
|      source_blocks)              |
|  IMPORTANTE: usa raw_pages       |
|  (no prompt_pages)               |
+----------------+-----------------+
                 |
                 v
+----------------------------------+
| coverage_check                   |
|  * calcula coverage_ratio        |
|  * si <0.95: crea orphan nodes   |
|    title="Paginas no             |
|    clasificadas N-M"             |
|    confidence=0.0                |
|  * renumber_tree                 |
|  metrics.coverage_ratio,         |
|  metrics.orphan_node_count       |
+----------------+-----------------+
                 |
                 v
+----------------------------------+
| select_refine_targets            |
| (passthrough)                    |
+----------------+-----------------+
                 |
       fan_out_refine_targets    PARALELIZACION
   +-------------+----------+--------+
   |             |          |        |  (1 Send por nodo grande)
   v             v          v        v
+------------------------------------+
| refine_one_node x N (paralelo)     |  LLM (2 calls c/u)
|  * prompt_pages del rango          |  retry policy
|  * candidate_prompt(refine mode)   |
|  * verify_prompt                   |
|  * si verified ratio >=0.6:        |
|    devuelve subtree shifted        |
|                                    |
|  GOTCHA: si N=0, emite 1 Send      |
|  dummy a collect_refined_results   |
|  para no cortar el grafo           |
+----------------+-------------------+
                 |
                 v (collect)
+------------------------------------+
| collect_refined_results            |
|  * aplica subtrees a state.tree    |
|  * renumber_tree                   |
|  * compute_node_confidence en      |
|    nodos nuevos (preserva 0.0 de   |
|    orphans con guard)              |
|  * RESET refined_results: []       |  crucial para iteracion
|  metrics.refined_node_count++      |
+----------------+-------------------+
                 |
   route_after_refine_collect
       +---------+--------+
       | refines y iter<3 | done
       v                  v
   select_refine      prepare_summaries
   _targets           |
   (loop)             v
            +-------------------------------+
            | prepare_summaries             |
            | metrics.tree_node_count       |
            +---------------+---------------+
                            |
                  fan_out_summaries    PARALELIZACION
           +----------------+----------------+
           v                v                v
+--------------------------------------------+
| summarize_one_node x N (paralelo)          |
|  * CACHE LOOKUP Upstash:                   |
|    key = sha256("v1|tree_prompt_version|   |
|              model|title|page_range|text") |
|  * HIT  -> return cached + cache_hits++    |
|  * MISS -> LLM call + set_cached(TTL 30d)  |
|                      + cache_misses++      |
|  retry policy                              |
+---------------------+----------------------+
                      |
                      v (collect)
+--------------------------------------------+
| collect_summaries                          |
|  * aplica summaries al tree                |
|  * LLM call: doc_summary_prompt(tree)      |
|  metrics.summary_cache_hits/misses         |
+---------------+----------------------------+
                |
    fan_out_routing_summaries
       +--------+--------+--------+
       v                          v
+--------------------------------------------+
| summarize_one_routing x N (paralelo)       |  LLM (sin cache v1)
|  * routing_summary_prompt(node, path,      |  retry policy
|    document_type, page_range, summary)     |
+---------------+----------------------------+
                |
                v
+--------------------------------------------+
| collect_routing_summaries                  |
|  * aplica routing_summary a cada nodo      |
|  * build_chunks_from_tree                  |
|  * metrics.confidence_mean/min             |
|  * metrics.chunk_count                     |
+---------------+----------------------------+
                |
                v
+--------------------------------------------+
| embed_hierarchy                            |  embeddings provider
|  * embed_chunks(chunks, document_type)     |  retry policy
|  * dim 1536 (gemini-embedding-2-preview)   |
|  metrics.embedding_count/model             |
+---------------+----------------------------+
                |
                v
        +---------------+
        |     END       |
        +---------------+
```

---

## 5. Decisiones de diseno clave

### 5.1 `raw_pages` vs `prompt_pages`

`TreeState` mantiene dos vistas de las paginas:

- `raw_pages`: texto fiel a MinerU. Lo consumen `post_process_tree`,
  `coverage_check`, `build_chunks_from_tree`, y `compute_node_confidence`
  para metricas y persistencia.
- `prompt_pages`: dedupeado por `strip_repeated_headers_footers` (borra
  lineas top/bottom repetidas across paginas, ej. logos y headers de
  marca). Lo consumen `detect_document_type`, `build_candidate_tree`,
  `verify_tree`, `repair_sections`, `refine_one_node` para prompts LLM.

Por que la distincion: aplicar dedupe in-place a `state["pages"]` (lo que
hacia el codigo pre-refactor) contaminaba `chunks.content` con texto
mutilado y rompia el visor.

### 5.2 Paralelizacion selectiva via Send

Tres nodos usan `Send` fan-out:

- `refine_one_node`: cada nodo grande es independiente.
- `summarize_one_node`: cada nodo se resume sin dependencias.
- `summarize_one_routing`: idem para routing summaries.

Tres nodos quedan secuenciales deliberadamente:

- `build_candidate_tree`: acumula `sections` entre grupos para mantener
  numeracion `structure` coherente (`"1"`, `"1.1"`, `"2"` cross-grupo).
  Paralelizar romperia la jerarquia.
- `verify_tree`, `repair_sections`: trabajan sobre el outline global,
  no por nodo.

### 5.3 RetryPolicy tipado + semaforo LLM

`llm.py` distingue dos clases de errores HTTP:

- `TreeLlmTransientError(408, 425, 429, 5xx)`: reintentable.
- `TreeLlmPermanentError(400, 401, 403, 404, 422)`: no reintentar.

`RetryPolicy(max_attempts=3, retry_on=(TreeLlmTransientError,
httpx.TimeoutException, httpx.ReadError, httpx.RemoteProtocolError,
httpx.ConnectError))` aplica a 8 nodos del grafo. Si la clave esta mal
(401), falla rapido sin gastar reintentos. Si el provider tira 429,
reintenta con backoff 2x.

Semaforo global `SDA_TREE_LLM_MAX_INFLIGHT=12` previene que la
paralelizacion masacre el rate limit del provider. Con
`SDA_TREE_INDEXER_CONCURRENCY=4` jobs concurrentes, eso es 48 in-flight
maximo. Si se ven 429s en produccion, bajar a 8.

### 5.4 Cache Upstash v1: solo summaries

`summarize_one_node` consulta Upstash antes del LLM. Key:

```
tree:summary:v1:<sha256(
  "v1|tree_prompt_version|summary_model|title|page_start-page_end|text"
)>
```

TTL 30 dias. Si Upstash cae o esta sin configurar, `_is_configured()`
retorna False y el cache es no-op silencioso.

`routing_summary` NO se cachea en v1. Su prompt depende de mas inputs
(document_type, path, summary derivado) y la key parcial corre riesgo de
devolver routing text incorrecto que contaminaria embeddings.

Cumple los gotchas operativos de Upstash (`gotchas.md:73-79`): TTL
absoluto, rebuildable, sin bloquear el flujo si esta down.

### 5.5 Confidence scoring por nodo

`compute_node_confidence` (helpers.py) suma:

- `+0.5` si `verifier_says_valid=True`, `+0.25` si None.
- `+0.3` si el titulo aparece en los primeros 600 chars del texto de la
  pagina `start_index` (casefold).
- `+0.2` si overlap de `source_blocks` >= 0.5 del rango, `+0.1` si >= 0.2.

Score final `round(min(score, 1.0), 3)`.

Persiste en `doc_tree_nodes.metadata.confidence`. El front puede mostrar
nodos de baja confianza; el retrieval puede penalizarlos. Orphans creados
por `coverage_check` tienen `confidence: 0.0`. `collect_refined_results`
preserva ese 0.0 con `if "confidence" not in child` guard.

### 5.6 Detector ToC heuristico como atajo opcional

`detect_toc` busca un Table of Contents real en las primeras 15% paginas
con regex `^(?P<title>.+?)\s*\.{3,}\s*(?P<page>\d+)\s*$`. Si encuentra
>=4 secciones y >=70% se resuelven a paginas fisicas (matching de titulo
en texto real, no asumiendo que el numero impreso == pagina fisica), se
salta `build_candidate_tree` y se va directo a `verify_tree`.

Si `verify_tree` rechaza >30% en modo `toc_heuristic`, degrada a flujo
LLM normal sin gastar `repair_sections`. Evita una ronda LLM extra
reparando un esqueleto fundamentalmente malo.

---

## 6. Metricas que emite el pipeline

```
Originales (pre-trabajo)           Nuevas (post-trabajo)
============================       ====================================
candidate_section_count            + toc_detected
verification_accuracy              + toc_section_count
tree_node_count                    + toc_resolution_ratio
chunk_count                        + toc_used
embedding_count                    + candidate_group_count
embedding_model                    + coverage_ratio
                                   + missing_page_count
                                   + coverage_gap
                                   + orphan_node_count
                                   + confidence_mean
                                   + confidence_min
                                   + summary_cache_hits
                                   + summary_cache_misses
                                   + refined_node_count
                                   + refinement_iteration
```

Todas viven en `doc_tree.metadata.metrics` y se actualizan a medida que
los nodos LangGraph corren.

---

## 7. Versionado vigente

`lib/system-versions.json` (HEAD `c9200ed`):

| Componente | Version | Cambio |
| --- | --- | --- |
| `app` | 0.1.7 | sin cambio |
| `compute_gateway_extraction` | 0.1.5 | bumped (HTTP client switch) |
| `embedding_pipeline` | 0.1.0 | sin cambio |
| `extraction_pipeline` | 0.2.0 | bumped (invalida cache extracciones) |
| `indexing_pipeline` | 0.1.8 | NO bumpeado (contrato chunks intacto) |
| `inngest_indexing_workflow` | 0.1.6 | sin cambio |
| `tree_indexer_python` | 0.2.0 | bumped (refactor + features) |
| `tree_prompt` | 0.1.2 | NO bumpeado (prompts intactos) |

`extraction_pipeline` se bumpea porque cambia el backend MinerU
(`pipeline` -> `hybrid-http-client`); la cache key de
`document_extractions` incluye `extraction_pipeline_version` para forzar
reextraccion. `indexing_pipeline` NO se bumpea porque el contrato
persistido (`doc_tree` + `chunks`) sigue identico aunque el grafo
interno cambie.

---

## 8. Operacion via CLI `sda`

### 8.1 Manejar el server `srv-ia-01`

```bash
sda ssh status               # snapshot GPU + servicios + healths
sda ssh gpu                  # detalle nvidia-smi + procesos
sda ssh logs <service>       # journalctl. <service>: gateway|tree|mineru
sda ssh logs tree --follow   # streaming
sda ssh logs gateway -n 200  # ultimas 200 lineas
sda ssh restart <service>    # systemctl restart con confirmacion
sda ssh '<comando shell>'    # passthrough generico
sda ssh                      # SSH interactivo
```

Aliases en `bin/sda.mjs`: `s` -> `ssh`.

### 8.2 Deploy

```bash
sda deploy all               # gateway + tree-indexer (en orden)
sda deploy gateway           # solo Compute Gateway
sda deploy tree              # solo Tree Indexer Python
sda deploy mineru-api        # refresh systemd unit + restart + preload wait
sda deploy all --smoke       # tras deploy, health 3 services con latencia
sda deploy gateway --diff    # rsync dry-run sin deployar
sda deploy gateway --version # imprime versiones local/remota
sda deploy --rollback        # revert versions.json al commit anterior
                             # + nuevo commit forward + redeploy
```

El deploy aborta automaticamente si detecta downgrade (version local <
remota) o pide confirmacion si version local == remota.

Aliases: `dp` y `dep` -> `deploy`, `g` -> `gateway`, `t` -> `tree`, `m`
-> `mineru`.

### 8.3 Aliases utiles del CLI raiz

| Alias | Comando |
| --- | --- |
| `?`, `h` | `help` |
| `ok`, `d` | `doctor --quick` |
| `r` | `redis ping` |
| `i`, `idx` | `indexing list` |
| `dp`, `dep` | `deploy all --version` |
| `v`, `inv` | `invite` |
| `sh` | `ship` |
| `s` | `ssh` |

---

## 9. Gotchas operativos

### 9.1 mineru-api unit y path

El binario correcto es
`/home/sistemas/sda-mineru/.venv/bin/mineru-api`. NO existe
`/home/sistemas/sda/.venv/`. Si el unit apunta al path viejo, el service
entra en loop de reinicios (status 203/EXEC). El unit canonico lo
reaplica `sda deploy mineru-api`.

`--enable-vlm-preload True` precarga el VLM al startup. El primer
request despues del boot no paga cold-load. El preload tarda ~3 min en
RTX PRO 6000 Blackwell; `TimeoutStartSec=600` cubre el preload.

El service loguea `API documentation: http://127.0.0.1:8765/docs` antes
de estar listo. NO confundir el log de startup con readiness real;
usar `curl /docs` para chequear.

### 9.2 vllm-nemotron-omni-nvfp4 apagado

El container `vllm-nemotron-omni-nvfp4` ocupaba 85 GB de VRAM antes del
2026-05-21. Lo apagamos para que MinerU pueda usar la GPU:

```bash
docker stop vllm-nemotron-omni-nvfp4
docker update --restart=no vllm-nemotron-omni-nvfp4
```

Container y volumenes persisten. NO reiniciar sin decision explicita;
ocupa toda la VRAM y mata el throughput de indexacion.

### 9.3 Concurrencia

- `mineru-api` acepta 3 requests concurrent maximo (`Request concurrency
  limited to 3` en startup logs).
- `SDA_COMPUTE_GATEWAY_CONCURRENCY=2` deja headroom 1 sobre ese limite.
- `SDA_TREE_INDEXER_CONCURRENCY=4` permite 4 jobs LangGraph
  simultaneos. Cada uno puede tener hasta 12 LLM in-flight
  (`SDA_TREE_LLM_MAX_INFLIGHT=12`), total 48 maximo. Para Gemini Flash
  via OpenRouter alcanza; si aparecen 429s, bajar a 8.

### 9.4 Cache Upstash

Variables requeridas en el `.env` remoto del tree indexer:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

Si estan vacias, `_is_configured()` retorna False y el cache es no-op
silencioso (todas las summaries se generan via LLM). El `summary_cache_*`
en metrics quedara en 0/0.

Para activar:

```bash
ssh sistemas@srv-ia-01 'grep UPSTASH /home/sistemas/sda-tree-indexer-python/.env'
```

Si las dos lineas tienen valor, ok. Sino, agregar al `.env` local antes
del proximo `sda deploy tree`.

### 9.5 Bumpear prompts invalida el cache

La cache key incluye `tree_prompt_version`. Cuando se bumpea
`tree_prompt` en `system-versions.json`, todas las keys viejas dejan de
matchear. Esperado: primera reindexacion despues del bump paga el costo
LLM completo de cada summary. Las keys viejas expiran solas en 30 dias.

### 9.6 Inngest reconciler vs estado parcial

Si un job de indexacion muere a mitad de camino (deploy en el medio,
crash del server), el reconciler de Inngest puede redespachar la corrida
sin re-correr MinerU si ya hay artefactos en Supabase Storage. Para que
una corrida sea considerada "completa", `doc_tree.metadata.run_id`,
`chunks.metadata.run_id`, `indexing_pipeline_version` y
`tree_indexer_version` deben coincidir con el `run_id` actual.

---

## 10. Cobertura de tests

Suite Python (`npm run test:tree-indexer`):

- 85 unit tests (cobertura de los 13 nodos LangGraph, llm.py + embeddings.py con
  `httpx.MockTransport`, cache, helpers, persistencia).
- 3 integration tests skip-ables (smoke contra mineru-api real via SSH).

Suite JS (`npm run test:cli`):

- 29 tests de `normalize-argv` (todos los aliases del CLI + insercion
  de subcomandos default).
- 23 tests de `deploy` (resolveTargets para gateway/tree/mineru/all,
  compareSemver, edge cases).

Para correr integration tests contra mineru-api real:

```bash
cd workers/tree-indexer-python && python3 -m pytest -m integration -v
```

Por default los integration estan deselected (`addopts = "-m 'not
integration'"` en `pyproject.toml`).

---

## 11. Referencias cruzadas

- [`pageindex-tree-builder-reference.md`](./pageindex-tree-builder-reference.md)
  Decision teorica de copiar la filosofia PageIndex.
- [`arquitectura.md`](./arquitectura.md)
  Vision general del sistema (Supabase, Inngest, RLS, multitenancy).
- [`gotchas.md`](./gotchas.md)
  Trampas operativas detalladas: Google OAuth, Upstash, Inngest, etc.
- [`backend/04-indexacion-inngest.md`](./backend/04-indexacion-inngest.md)
  Workflow de indexacion del lado Inngest.
- [`backend/05-workers-compute-tree-indexer.md`](./backend/05-workers-compute-tree-indexer.md)
  Contrato de los workers.
- `docs/superpowers/specs/2026-05-21-mineru-gpu-tree-pipeline-acceleration-design.md`
  Spec original del trabajo que produjo este estado.
- `docs/superpowers/plans/2026-05-21-mineru-gpu-tree-pipeline-acceleration.md`
  Plan de implementacion ejecutado.
