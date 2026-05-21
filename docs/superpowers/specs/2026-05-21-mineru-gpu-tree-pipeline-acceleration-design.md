# MinerU GPU + Tree Pipeline Acceleration

Estado: spec aprobado, listo para plan de implementacion.
Fecha: 2026-05-21.
Autor: brainstorming session con enzo.

## Resumen

Acelerar el pipeline de extraccion + tree-building moviendo MinerU a GPU con
modelos calientes via `mineru-api`, apagando `vllm-nemotron` que ocupa 85 GB de
los 98 GB de VRAM sin uso real, y refactorizando el Tree Indexer Python para
paralelizar trabajo LangGraph, deduplicar costos de LLM y subir calidad del
arbol generado.

## Contexto operativo

`srv-ia-01` corre tres servicios relevantes:

- `sda-compute-gateway.service` (Node) que invoca MinerU como CLI por job.
- `sda-tree-indexer.service` (Python FastAPI + LangGraph).
- `mineru-api.service` (systemd, root) en estado `activating auto-restart` con
  contador 26.753 reinicios en 7 dias. El unit apunta al path inexistente
  `/home/sistemas/sda/.venv/bin/mineru-api`. El binario real vive en
  `/home/sistemas/sda-mineru/.venv/bin/mineru-api`.

Container `vllm-nemotron-omni-nvfp4` corre hace 7 dias con `restart=unless-stopped`,
ocupando 85.357 MiB / 97.887 MiB de VRAM. Sin trafico relevante asociado al
worker actual.

GPU: NVIDIA RTX PRO 6000 Blackwell Max-Q, driver 590.48.01, 97.887 MiB total.
MinerU instalado: version 3.1.15, con `torch 2.12.0+cu130` y CUDA disponible.

## Objetivos

1. Extraccion MinerU `< 60s` para PDFs de 50-100 paginas (baseline actual estimada
   3-8 min con cold-load CPU).
2. Eliminar cold-load por job de modelos MinerU (Layout + OCR + Formula + VLM).
3. `build_candidate_tree` y `refine_large_nodes` corren en paralelo via Send API
   en lugar de for-loops secuenciales.
4. Pool httpx unico + `RetryPolicy` de LangGraph en nodos que tocan LLM/red.
5. `tree_graph.py` (1031 LOC) descompuesto en `app/tree_graph/` con archivos
   <= 200 LOC, cumpliendo `AGENT.md` ("nunca hacer archivos monoliticos").
6. Calidad de arbol: detectar ToC explicito antes del LLM, scoring de confianza
   por nodo, validacion de cobertura de paginas, dedupe de logos/headers
   repetidos en text antes del verifier.
7. Cache de summaries en Upstash con TTL 30d, fallback a LLM si Redis miss/down.
8. Concurrencia worker: `SDA_TREE_INDEXER_CONCURRENCY=4`,
   `SDA_COMPUTE_GATEWAY_CONCURRENCY=2`.

## No-objetivos

- Cambiar provider LLM, modelo o configuracion de embeddings.
- Tocar schema de `doc_tree`, `chunks`, `doc_tree_nodes`.
- Cambios al frontend o al UI del visor.
- Revamp de prompts (sigue como follow-up con A/B vs baseline).
- Exponer `mineru-api` por Tailscale Funnel; sigue privado a `127.0.0.1`.

## Arquitectura

### Infra GPU MinerU

#### Apagado limpio de vllm-nemotron

```bash
docker stop vllm-nemotron-omni-nvfp4
docker update --restart=no vllm-nemotron-omni-nvfp4
```

Container queda persistido, recuperable con `docker start` si hace falta. No se
borra image ni el modelo descargado.

#### Reescritura de `mineru-api.service`

Unit en `/etc/systemd/system/mineru-api.service` (root):

```ini
[Unit]
Description=MinerU FastAPI server (hot models, GPU)
After=network.target

[Service]
Type=simple
User=sistemas
Group=sistemas
WorkingDirectory=/home/sistemas/sda-mineru
Environment=PATH=/home/sistemas/sda-mineru/.venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=CUDA_VISIBLE_DEVICES=0
Environment=MINERU_DEVICE_MODE=cuda
ExecStart=/home/sistemas/sda-mineru/.venv/bin/mineru-api --host 127.0.0.1 --port 8765 --enable-vlm-preload True
Restart=on-failure
RestartSec=10
LimitNOFILE=65536
TimeoutStartSec=600

[Install]
WantedBy=multi-user.target
```

Notas:

- `Restart=on-failure` en lugar de `always` evita el loop infinito si el binario
  cambia de path otra vez.
- `--enable-vlm-preload True` precarga el VLM al startup. Primer request no paga
  cold-load. El boot tarda 30-90s, por eso `TimeoutStartSec=600`.
- Bind a `127.0.0.1`: el gateway accede al puerto en el mismo host. No se expone
  publico ni via Funnel.

Aplicar:

```bash
sudo systemctl reset-failed mineru-api.service
sudo systemctl daemon-reload
sudo systemctl restart mineru-api.service
sudo systemctl status mineru-api.service
```

#### Gateway: spawn CLI -> HTTP client

`workers/compute-gateway/jobs/mineru.mjs` cambia el flag de backend a
`hybrid-http-client` y le pasa `-u http://127.0.0.1:8765`:

```javascript
function execMineru(inputFile, outputDir) {
  return spawn(
    MINERU_BIN,
    [
      "-p", inputFile,
      "-o", outputDir,
      "-b", MINERU_BACKEND,
      "-l", MINERU_LANG,
      "-u", MINERU_API_URL,
    ],
    {
      env: {
        ...process.env,
        MINERU_PDF_RENDER_TIMEOUT,
        MINERU_TASK_RESULT_TIMEOUT_SECONDS: MINERU_TASK_RESULT_TIMEOUT,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}
```

Config en `workers/compute-gateway/config.mjs` agrega:

```javascript
export const MINERU_API_URL =
  process.env.SDA_MINERU_API_URL ?? "http://127.0.0.1:8765";
```

Env vars del service (`workers/compute-gateway/deploy.sh`):

```bash
SDA_MINERU_BACKEND=hybrid-http-client
SDA_MINERU_API_URL=http://127.0.0.1:8765
SDA_COMPUTE_GATEWAY_CONCURRENCY=2
```

Concurrencia 2 deja headroom respecto del limit de 3 que muestra mineru-api en
sus logs (`Request concurrency limited to 3`).

### Refactor `tree_graph.py` -> paquete

Layout final en `workers/tree-indexer-python/app/tree_graph/`:

```
tree_graph/
+-- __init__.py            # re-exports: run_tree_index_graph, TREE_INDEXER_VERSION, is_checkpointing_configured
+-- state.py               # TreeState TypedDict, NodeTask, NodeTextResult, *Result reducers
+-- config.py              # _max_prompt_chars, _summary_concurrency, _refine_*, _repair_*, _degrade_* con lru_cache
+-- helpers.py             # _visit_tree, _renumber_tree, _section_identity, _node_task, _shift_tree_pages, _node_from_task, _structure_sort_key
+-- events.py              # emit_tree_node_event, _graph_event_base, _context_for_send
+-- nodes/
|   +-- __init__.py
|   +-- detect_document_type.py
|   +-- detect_toc.py              # nuevo: heuristico ToC
|   +-- build_candidate_tree.py    # con fan-out Send paralelo grupos
|   +-- collect_candidate_groups.py
|   +-- verify_tree.py
|   +-- repair_sections.py
|   +-- degrade_mode.py
|   +-- post_process_tree.py
|   +-- coverage_check.py          # nuevo: garantiza cobertura paginas
|   +-- refine_large_nodes.py      # con fan-out Send paralelo nodos
|   +-- collect_refined_results.py
|   +-- summarize_node.py
|   +-- routing_summary.py
|   +-- embed_hierarchy.py
+-- routing.py             # route_after_verify, route_after_refine, fan_out_*, route_after_detect_toc
+-- checkpoint.py          # _checkpoint_dsn, _checkpointing_enabled, _run_graph_with_optional_checkpoint
+-- graph.py               # build_graph(), TREE_GRAPH = build_graph()
```

Migration en commits chicos:

1. `git mv app/tree_graph.py app/tree_graph/_legacy.py`.
2. Crear nuevos archivos importando desde `_legacy.py` para mantener verde.
3. Mover simbolo por simbolo con commit por nodo.
4. Borrar `_legacy.py`.

API publica conservada: `from app.tree_graph import run_tree_index_graph,
TREE_INDEXER_VERSION, is_checkpointing_configured`. Importadores en `main.py` y
`versions.py` no requieren cambios.

### Paralelizacion LangGraph

#### `build_candidate_tree` -> fan-out via Send

`state.py` agrega:

```python
class CandidateGroupResult(TypedDict):
    index: int
    sections: list[CandidateSection]
    model: str
    provider: str
    provider_order: list[str]
    service_tier: str | None

class TreeState(TypedDict):
    # ... existentes
    candidate_group_index: int | None
    candidate_group_pages: list[LabeledPage] | None
    candidate_group_results: Annotated[list[CandidateGroupResult], operator.add]
```

`routing.py`:

```python
def fan_out_candidate_groups(state: TreeState) -> list[Send]:
    groups = split_pages_for_prompt(state["pages"], _max_prompt_chars())
    context = _context_for_send(state)
    return [
        Send(
            "candidate_group",
            {
                **context,
                "candidate_group_index": index,
                "candidate_group_pages": group,
                "candidate_group_results": [],  # reducer mandatory init
            },
        )
        for index, group in enumerate(groups)
    ]
```

`nodes/build_candidate_tree.py`:

```python
async def candidate_group(state: TreeState) -> dict[str, Any]:
    response = await call_tree_llm_json(
        candidate_prompt(
            state["document_title"],
            state["document_type"],
            tagged_pages_text(state["candidate_group_pages"]),
            None,
            state.get("tree_mode", "toc"),
        ),
        "structure",
    )
    return {
        "candidate_group_results": [{
            "index": state["candidate_group_index"],
            "sections": _assert_sections(response["json"]),
            "model": response["model"],
            "provider": response["provider"],
            "provider_order": response.get("provider_order") or [],
            "service_tier": response.get("service_tier"),
        }],
    }
```

`nodes/collect_candidate_groups.py`:

```python
async def collect_candidate_groups(state: TreeState) -> dict[str, Any]:
    results = sorted(state["candidate_group_results"], key=lambda r: r["index"])
    sections = [s for r in results for s in r["sections"]]
    if not sections:
        raise RuntimeError("Tree LLM no encontro secciones.")

    last = results[-1]
    return {
        "candidate_sections": sections,
        "metrics": {
            **state["metrics"],
            "candidate_section_count": len(sections),
            "candidate_group_count": len(results),
            "llm_model": last["model"],
            "llm_provider": last["provider"],
            "llm_provider_order": last["provider_order"],
            "llm_service_tier": last["service_tier"],
        },
        "provider": last["provider"],
        "version": TREE_INDEXER_VERSION,
    }
```

Edges en `graph.py`:

```python
graph.add_conditional_edges(
    "detect_toc",
    route_after_detect_toc,
    {
        "build_candidate_groups": "candidate_group",  # via Send fan-out
        "verify_tree_from_toc": "verify_tree",
    },
)
graph.add_edge("candidate_group", "collect_candidate_groups")
graph.add_edge("collect_candidate_groups", "verify_tree")
```

#### `refine_large_nodes` -> fan-out via Send

Mismo patron. `routing.py`:

```python
def fan_out_refine_targets(state: TreeState) -> list[Send]:
    tree = state["tree"]
    candidates = [node for node in _visit_tree(tree) if _is_large_leaf(node)]
    context = _context_for_send(state)
    return [
        Send(
            "refine_one_node",
            {
                **context,
                "refine_target_node_id": node["node_id"],
                "refine_target_pages": _sub_pages_for_node(node, state["pages"]),
                "refine_target_start_index": node["start_index"],
                "refined_results": [],
            },
        )
        for node in candidates
    ]
```

`nodes/refine_large_nodes.py` se renombra a `nodes/refine_one_node.py` con
firma async aceptando un solo nodo. Reusa `_refined_subtree_for_node` que ya
existe.

`nodes/collect_refined_results.py` aplica cada subtree al arbol vivo,
renumera, decide si itera otra vuelta (preserva `route_after_refine`).

#### `RetryPolicy` por nodo

`graph.py` agrega un import y aplica retry a todos los nodos que tocan red:

```python
import httpx
from langgraph.types import RetryPolicy

LLM_RETRY = RetryPolicy(
    max_attempts=3,
    initial_interval=2.0,
    backoff_factor=2.0,
    retry_on=(
        httpx.TimeoutException,
        httpx.ReadError,
        httpx.RemoteProtocolError,
        httpx.ConnectError,
    ),
)

graph.add_node("candidate_group", candidate_group, retry=LLM_RETRY)
graph.add_node("verify_tree", verify_tree, retry=LLM_RETRY)
graph.add_node("repair_sections", repair_sections, retry=LLM_RETRY)
graph.add_node("refine_one_node", refine_one_node, retry=LLM_RETRY)
graph.add_node("summarize_one_node", summarize_one_node, retry=LLM_RETRY)
graph.add_node("summarize_one_routing", summarize_one_routing, retry=LLM_RETRY)
graph.add_node("embed_hierarchy", embed_hierarchy, retry=LLM_RETRY)
graph.add_node("detect_document_type", detect_document_type, retry=LLM_RETRY)
```

### Pool httpx unico + semaforo LLM

Nuevo modulo `app/http_client.py`:

```python
import asyncio
from functools import lru_cache
import os

import httpx

@lru_cache(maxsize=1)
def get_llm_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=httpx.Timeout(connect=10.0, read=120.0, write=30.0, pool=5.0),
        limits=httpx.Limits(
            max_keepalive_connections=20,
            max_connections=50,
            keepalive_expiry=60.0,
        ),
        http2=True,
    )

@lru_cache(maxsize=1)
def get_supabase_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=httpx.Timeout(connect=10.0, read=120.0, write=30.0, pool=5.0),
        limits=httpx.Limits(
            max_keepalive_connections=10,
            max_connections=30,
            keepalive_expiry=60.0,
        ),
    )

@lru_cache(maxsize=1)
def get_llm_semaphore() -> asyncio.Semaphore:
    raw = os.getenv("SDA_TREE_LLM_MAX_INFLIGHT", "12")
    try:
        limit = max(1, int(raw))
    except ValueError:
        limit = 12
    return asyncio.Semaphore(limit)

async def close_clients() -> None:
    await get_llm_client().aclose()
    await get_supabase_client().aclose()
```

`llm.py` deja de abrir cliente per call:

```python
async def call_tree_llm(prompt: str, purpose: Purpose, expect_json: bool) -> dict[str, Any]:
    config = get_tree_llm_config(purpose)
    client = get_llm_client()
    sem = get_llm_semaphore()
    async with sem:
        response = await client.post(
            f"{config.base_url}/chat/completions",
            headers=...,
            json=payload,
            timeout=config.timeout_seconds,
        )
    # ... rest stays the same
```

`supabase_io.py` y `embeddings.py` migran a `get_supabase_client()`.

`main.py` agrega shutdown hook:

```python
from .http_client import close_clients

@app.on_event("shutdown")
async def _on_shutdown() -> None:
    await close_clients()
```

### Calidad del arbol

#### Detectar ToC determinista antes del LLM

`nodes/detect_toc.py`:

```python
import re

TOC_LINE = re.compile(r"^(?P<title>.+?)\s*\.{3,}\s*(?P<page>\d+)\s*$")

async def detect_toc(state: TreeState) -> dict[str, Any]:
    candidate_text = "\n".join(
        page["text"] for page in state["pages"][: max(5, len(state["pages"]) // 10)]
    )
    lines = [line.strip() for line in candidate_text.split("\n") if line.strip()]
    toc_matches = [TOC_LINE.match(line) for line in lines]
    matched = [m for m in toc_matches if m]

    if len(matched) >= 4:
        sections = [
            {
                "structure": str(index + 1),
                "title": m.group("title").strip(),
                "physical_index": int(m.group("page")),
                "valid": True,
            }
            for index, m in enumerate(matched)
        ]
        return {
            "candidate_sections": sections,
            "tree_mode": "toc_with_pages",
            "metrics": {
                **state["metrics"],
                "toc_detected": True,
                "toc_section_count": len(sections),
            },
        }

    return {
        "tree_mode": "no_toc",
        "metrics": {
            **state["metrics"],
            "toc_detected": False,
        },
    }
```

`route_after_detect_toc` decide:

- Si `tree_mode == "toc_with_pages"` y `candidate_sections` no esta vacio,
  salta directo a `verify_tree`.
- Si no, va a fan-out de `candidate_group`.

#### Confidence scoring

`helpers.py` nuevo:

```python
def compute_node_confidence(
    *,
    node: TreeNode,
    pages: list[LabeledPage],
    source_blocks: list[SourceBlock],
    verifier_says_valid: bool | None,
) -> float:
    score = 0.0
    if verifier_says_valid is True:
        score += 0.5
    elif verifier_says_valid is None:
        score += 0.25

    start_text = next(
        (page["text"] for page in pages if page["page"] == node["start_index"]),
        "",
    )
    title = node.get("title", "").strip().casefold()
    if title and title in start_text.casefold()[:600]:
        score += 0.3

    block_pages = {
        block["page"]
        for block in source_blocks
        if node["start_index"] <= block["page"] <= node["end_index"]
    }
    range_size = max(node["end_index"] - node["start_index"] + 1, 1)
    overlap = len(block_pages) / range_size
    if overlap >= 0.5:
        score += 0.2
    elif overlap >= 0.2:
        score += 0.1

    return round(min(score, 1.0), 3)
```

`post_process_tree` y `collect_refined_results` setean `node["confidence"]`.
`supabase_io._doc_tree_node_rows` lo propaga a `metadata.confidence`.

#### Validacion de cobertura

`nodes/coverage_check.py`:

```python
async def coverage_check(state: TreeState) -> dict[str, Any]:
    tree = state["tree"]
    pages = state["pages"]
    total_pages = max((page["page"] for page in pages), default=0)
    covered = set()
    for node, _path in flatten_tree(tree):
        for page in range(node["start_index"], node["end_index"] + 1):
            covered.add(page)
    expected = set(range(1, total_pages + 1))
    missing = sorted(expected - covered)

    coverage_ratio = (len(covered) / total_pages) if total_pages else 1.0
    metrics = {
        **state["metrics"],
        "coverage_ratio": round(coverage_ratio, 4),
        "missing_page_count": len(missing),
    }

    if not missing or coverage_ratio >= 0.95:
        return {"metrics": metrics}

    # Agrupar paginas faltantes en rangos contiguos -> nodos huerfanos.
    orphan_nodes: list[TreeNode] = []
    if missing:
        groups: list[list[int]] = [[missing[0]]]
        for page in missing[1:]:
            if page == groups[-1][-1] + 1:
                groups[-1].append(page)
            else:
                groups.append([page])
        for index, group in enumerate(groups):
            orphan_nodes.append({
                "node_id": f"orphan-{index:03d}",
                "title": f"Paginas no clasificadas {group[0]}-{group[-1]}",
                "start_index": group[0],
                "end_index": group[-1],
                "summary": "",
                "confidence": 0.0,
                "nodes": [],
            })

    tree = [*tree, *orphan_nodes]
    metrics["coverage_gap"] = True
    metrics["orphan_node_count"] = len(orphan_nodes)
    return {"tree": _renumber_tree(tree), "metrics": metrics}
```

Edge: `post_process_tree -> coverage_check -> refine_large_nodes (Send fan-out)`.

#### Title-near-page-start guard (dedupe logos)

En `pageindex_style.py`, antes de armar `LabeledPage`, calcular las top-K lineas
mas repetidas across paginas y borrarlas del inicio/fin de cada pagina antes
del verifier. Helper nuevo en `pageindex_style.py`:

```python
def strip_repeated_headers_footers(pages: list[LabeledPage], top_k: int = 5) -> list[LabeledPage]:
    if len(pages) < 4:
        return pages
    head_counts: dict[str, int] = {}
    tail_counts: dict[str, int] = {}
    for page in pages:
        lines = [line.strip() for line in page["text"].split("\n") if line.strip()]
        for line in lines[:3]:
            head_counts[line] = head_counts.get(line, 0) + 1
        for line in lines[-3:]:
            tail_counts[line] = tail_counts.get(line, 0) + 1

    threshold = max(2, len(pages) // 3)
    repeated_heads = {line for line, count in head_counts.items() if count >= threshold}
    repeated_tails = {line for line, count in tail_counts.items() if count >= threshold}

    cleaned: list[LabeledPage] = []
    for page in pages:
        lines = page["text"].split("\n")
        while lines and lines[0].strip() in repeated_heads:
            lines.pop(0)
        while lines and lines[-1].strip() in repeated_tails:
            lines.pop()
        cleaned.append({"page": page["page"], "text": "\n".join(lines)})
    return cleaned
```

Aplicado solo al text que se pasa al verifier y al refine, no al text crudo
que se persiste en `chunks`.

### Cache de summaries en Upstash

Helper en `app/cache.py`:

```python
import hashlib
import json
import os
from typing import Any

import httpx

from .http_client import get_supabase_client

UPSTASH_URL = os.getenv("UPSTASH_REDIS_REST_URL", "").rstrip("/")
UPSTASH_TOKEN = os.getenv("UPSTASH_REDIS_REST_TOKEN", "")
DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60

def _is_configured() -> bool:
    return bool(UPSTASH_URL and UPSTASH_TOKEN)

def _key(text: str, title: str, model: str, kind: str) -> str:
    digest = hashlib.sha256(f"{model}|{kind}|{title}|{text}".encode("utf-8")).hexdigest()
    return f"tree:summary:v1:{kind}:{digest}"

async def get_cached(key: str) -> str | None:
    if not _is_configured():
        return None
    client = get_supabase_client()
    try:
        response = await client.get(
            f"{UPSTASH_URL}/get/{key}",
            headers={"Authorization": f"Bearer {UPSTASH_TOKEN}"},
            timeout=2.0,
        )
        if response.status_code >= 400:
            return None
        result = response.json().get("result")
        return result if isinstance(result, str) else None
    except (httpx.TimeoutException, httpx.HTTPError):
        return None

async def set_cached(key: str, value: str, ttl: int = DEFAULT_TTL_SECONDS) -> None:
    if not _is_configured():
        return
    client = get_supabase_client()
    try:
        await client.post(
            f"{UPSTASH_URL}/setex/{key}/{ttl}",
            headers={"Authorization": f"Bearer {UPSTASH_TOKEN}"},
            content=value.encode("utf-8"),
            timeout=2.0,
        )
    except (httpx.TimeoutException, httpx.HTTPError):
        return  # cache fallback noop
```

`nodes/summarize_node.py` consulta cache antes del LLM:

```python
from ..cache import _key, get_cached, set_cached

async def summarize_one_node(state: TreeState) -> dict[str, Any]:
    target = state["summary_target"]
    text = target.get("text", "")
    title = target.get("title", "")
    model = os.getenv("SDA_TREE_SUMMARY_MODEL", "")
    cache_key = _key(text, title, model, "summary")

    cached = await get_cached(cache_key)
    if cached:
        return {
            "summary_results": [{"node_id": target["node_id"], "text": cached}],
            "summary_cache_hits": 1,
        }

    response = await call_tree_llm_text(summary_prompt(_node_from_task(target)), "summary")
    summary = response["content"].strip()
    await set_cached(cache_key, summary)
    return {
        "summary_results": [{"node_id": target["node_id"], "text": summary}],
        "summary_cache_misses": 1,
    }
```

`TreeState` agrega:

```python
summary_cache_hits: Annotated[int, operator.add]
summary_cache_misses: Annotated[int, operator.add]
```

Y `collect_summaries` los expone en `metrics`. Mismo patron para
`routing_summary` con kind `"routing"`.

Compatibilidad con `docs/gotchas.md:73-79`:

- TTL absoluto 30d -> no se acumulan keys huerfanas.
- Fallback a LLM si Redis miss/down -> outage no bloquea indexing.
- Operacional: el dato real vive en `chunks.summary` (postgres). Cache es solo
  acelerador.

### Concurrencia de workers

Defaults nuevos (env override sigue valido):

| Variable | Antes | Despues |
|----------|-------|---------|
| `SDA_TREE_INDEXER_CONCURRENCY` | 1 | 4 |
| `SDA_COMPUTE_GATEWAY_CONCURRENCY` | 1 | 2 |
| `SDA_TREE_LLM_MAX_INFLIGHT` | - | 12 |
| `SDA_TREE_SUMMARY_CONCURRENCY` | 3 | 6 |

Aplicados via `deploy.sh` en cada worker.

## Plan de implementacion (orden + reversa)

| # | Paso | Riesgo | Como reverso |
|---|------|--------|--------------|
| 1 | Apagar vllm + arreglar `mineru-api.service` + preload | Bajo | `docker start vllm-...`, `systemctl disable mineru-api` |
| 2 | Switch gateway a `hybrid-http-client` | Medio | Env `SDA_MINERU_BACKEND=pipeline` |
| 3 | Refactor `tree_graph.py` -> paquete (sin cambio comportamiento) | Bajo | Reverter commits |
| 4 | Pool httpx + RetryPolicy + semaforo LLM | Bajo | Reverter |
| 5 | Paralelizacion `build_candidate_tree` + `refine_large_nodes` | Medio | Reverter |
| 6 | ToC detect + Coverage check + Title-near-page guard | Medio | Reverter |
| 7 | Confidence scoring + persistencia en `metadata.confidence` | Bajo | Mantener; nadie depende de la columna aun |
| 8 | Cache summaries Upstash | Bajo | Borrar prefijo `tree:summary:v1:*`, env flag off |
| 9 | Subir concurrencia workers | Medio | Bajar a 1 |

Cada paso es un commit independiente (idealmente PR aparte) que pasa
`PYTHONPATH=. python -m unittest discover tests` antes de continuar.

## Versiones a bumpear en `lib/system-versions.json`

- `tree_indexer_python`: minor bump (refactor + features).
- `extraction_pipeline`: minor bump (backend MinerU cambia; afecta cache key
  segun `docs/gotchas.md:63`).
- `compute_gateway_extraction`: patch bump (cambio cliente HTTP).
- `indexing_pipeline`: NO bumpear (mismo contrato `doc_tree` + `chunks`).
- `tree_prompt_version`: NO bumpear (prompts no cambian en este spec).

## Metricas e instrumentacion

Ya existen y se conservan:

- `metrics.candidate_section_count`
- `metrics.verification_accuracy`
- `metrics.tree_node_count`
- `metrics.embedding_count`

Nuevas:

- `metrics.toc_detected: bool`
- `metrics.toc_section_count: int`
- `metrics.candidate_group_count: int`
- `metrics.coverage_ratio: float`
- `metrics.missing_page_count: int`
- `metrics.coverage_gap: bool`
- `metrics.orphan_node_count: int`
- `metrics.confidence_mean: float`
- `metrics.confidence_min: float`
- `metrics.summary_cache_hits: int`
- `metrics.summary_cache_misses: int`

Tiempos end-to-end ya viven en `compute_jobs.started_at` / `completed_at`.
No requiere nueva tabla.

## Smoke test

Post-deploy, reindex 3 PDFs reales conocidos del tenant principal:

1. Un escaneado (OCR pesado).
2. Un nativo corto (~10 paginas).
3. Un nativo largo (~150 paginas, con ToC).

Comparar antes/despues:

- `tree_node_count` (debe quedar comparable).
- `verification_accuracy` (no debe bajar).
- `coverage_ratio` (debe ser >= 0.95 en los tres).
- Tiempo end-to-end (debe bajar significativamente).
- `summary_cache_hits` en la segunda corrida (sin cambios) debe ser ~100%.

## Riesgos y mitigaciones

- **mineru-api OOM**: con vllm apagado quedan ~98 GB libres. Modelos MinerU
  preloaded ~5-10 GB. Margen amplio. Si OOM aparece, bajar
  `SDA_COMPUTE_GATEWAY_CONCURRENCY=1`.
- **Provider 429**: semaforo `SDA_TREE_LLM_MAX_INFLIGHT=12` por proceso, con
  `SDA_TREE_INDEXER_CONCURRENCY=4` da 48 in-flight max. Para Gemini Flash via
  OpenRouter alcanza. Si vemos 429s, bajar a 8.
- **Send paralelo + checkpointing**: LangGraph soporta Send + checkpointer
  juntos. Si se prende checkpointing, verificar que cada `Send` lleva el
  contexto minimo (ya esta en spec). Test con `SDA_TREE_CHECKPOINTING=1`
  antes de habilitar en produccion.
- **mineru-api preload tarda al boot**: con `TimeoutStartSec=600` y
  `Restart=on-failure`, si el preload falla no entra en loop infinito.
- **Refactor rompe imports externos**: `app/tree_graph/__init__.py` re-exporta
  `run_tree_index_graph`, `TREE_INDEXER_VERSION` e
  `is_checkpointing_configured`. Test suite cubre esto.
- **Upstash down**: cache es opt-in y siempre tiene fallback LLM. Logs muestran
  cache miss; documento se indexa igual.

## Follow-ups (otros specs)

- **Prompts revamp**: spec separado. Few-shot espanol, A/B vs baseline
  `verification_accuracy`.
- **Reranker/retrieval**: este spec no toca retrieval. Si el visor empieza a
  usar `confidence`, sale aparte.
- **Exposicion mineru-api a otros nodos**: solo si aparece un segundo host.
  Hoy sigue privado.
