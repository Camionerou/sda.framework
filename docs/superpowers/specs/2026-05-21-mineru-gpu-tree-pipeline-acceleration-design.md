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
3. `refine_large_nodes` corre en paralelo via Send API (cada nodo grande es
   independiente). `build_candidate_tree` permanece secuencial porque
   depende de contexto acumulado entre grupos.
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
|   +-- detect_toc.py              # nuevo: heuristico ToC con resolucion logico->fisico
|   +-- build_candidate_tree.py    # secuencial (acumula contexto), no fan-out
|   +-- verify_tree.py             # tolerancia adaptativa segun tree_mode
|   +-- repair_sections.py
|   +-- degrade_mode.py
|   +-- post_process_tree.py
|   +-- coverage_check.py          # nuevo: garantiza cobertura paginas
|   +-- refine_one_node.py         # fan-out Send paralelo por nodo grande
|   +-- collect_refined_results.py # aplica subtrees al arbol, renumera
|   +-- summarize_node.py          # consulta cache Upstash antes del LLM
|   +-- routing_summary.py         # sin cache en v1
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

#### `build_candidate_tree` permanece secuencial (revision post-review)

El codigo actual (`tree_graph.py:384`) acumula `sections` entre grupos y pasa
el resultado parcial como contexto al grupo siguiente
(`candidate_prompt(..., sections if sections else None, ...)`). Esa
acumulacion garantiza numeracion consistente (`structure: "1"`, `"1.1"`,
`"2"`) y evita estructuras locales repetidas por chunk.

Paralelizarlo con `Send` rompe el contrato: cada rama veria `None` como
contexto y emitiria su propia jerarquia local 1.x, 2.x, generando duplicados
y numeracion incoherente al merge.

**Decision**: dejar `build_candidate_tree` exactamente como esta, sin
descomponer en sub-nodos. La unica mejora aplicable es seguir cargando el
contexto incrementalmente, sin Send.

La ganancia de paralelismo se concentra en los nodos que SI son independientes
por construccion:

- `refine_large_nodes` -> Send fan-out (ver siguiente seccion).
- `summarize_one_node` -> ya esta en fan-out.
- `summarize_one_routing` -> ya esta en fan-out.

Para un PDF medio de 50-100 paginas, `build_candidate_tree` corre 1-3 grupos
secuenciales (~15-45s). La ganancia real esta en evitar 8 LLM calls
secuenciales en `refine_large_nodes` cuando un doc largo tiene 5-8 nodos
grandes.

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

#### Excepciones tipadas en `llm.py` (prerequisito de RetryPolicy)

El codigo actual (`llm.py:194-196`) convierte cualquier HTTP `>= 400` en un
`RuntimeError` generico. `RetryPolicy(retry_on=(httpx.TimeoutException, ...))`
no atrapa eso, asi que no se reintenta 429 ni 5xx. Antes de agregar
RetryPolicy hace falta tipar las excepciones.

Nuevas clases en `llm.py`:

```python
class TreeLlmTransientError(RuntimeError):
    """HTTP transient: 408, 425, 429, 500, 502, 503, 504. Reintentable."""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code


class TreeLlmPermanentError(RuntimeError):
    """HTTP permanente: 400, 401, 403, 404, 422. NO reintentar."""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code


TRANSIENT_STATUS = {408, 425, 429, 500, 502, 503, 504}
```

Cambio en `call_tree_llm`:

```python
if response.status_code >= 400:
    message = (
        data.get("error", {}).get("message")
        if isinstance(data, dict)
        else None
    ) or f"Tree LLM fallo con HTTP {response.status_code}."
    if response.status_code in TRANSIENT_STATUS:
        raise TreeLlmTransientError(response.status_code, message)
    raise TreeLlmPermanentError(response.status_code, message)
```

#### `RetryPolicy` por nodo

`graph.py` agrega imports y aplica retry tipado:

```python
import httpx
from langgraph.types import RetryPolicy

from .llm import TreeLlmTransientError

LLM_RETRY = RetryPolicy(
    max_attempts=3,
    initial_interval=2.0,
    backoff_factor=2.0,
    retry_on=(
        TreeLlmTransientError,
        httpx.TimeoutException,
        httpx.ReadError,
        httpx.RemoteProtocolError,
        httpx.ConnectError,
    ),
)

graph.add_node("verify_tree", verify_tree, retry=LLM_RETRY)
graph.add_node("repair_sections", repair_sections, retry=LLM_RETRY)
graph.add_node("refine_one_node", refine_one_node, retry=LLM_RETRY)
graph.add_node("summarize_one_node", summarize_one_node, retry=LLM_RETRY)
graph.add_node("summarize_one_routing", summarize_one_routing, retry=LLM_RETRY)
graph.add_node("embed_hierarchy", embed_hierarchy, retry=LLM_RETRY)
graph.add_node("detect_document_type", detect_document_type, retry=LLM_RETRY)
graph.add_node("build_candidate_tree", build_candidate_tree, retry=LLM_RETRY)
```

`build_candidate_tree` lleva retry porque internamente puede pegarse 1-3 LLM
calls secuenciales y cualquiera puede fallar transient. El nodo entero se
reintentaria si falla en el medio, lo cual es lo correcto cuando NO hay
checkpoint: state interno se reconstruye desde cero. Cuando se prenda
checkpointing, evaluar si conviene cortarlo en sub-nodos para granularidad
mas fina.

Para `embed_hierarchy` la transient suele venir del provider de embeddings
(no de Tree LLM); igual aplica el mismo decorator porque
`embeddings.py` tambien debe levantar `TreeLlmTransientError` para 429/5xx
del provider de embeddings (misma migracion paralela en `embeddings.py`).

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

**Gotcha de paginacion logica vs fisica**: el numero impreso en el ToC
(`"Capitulo 1 ........ 17"`) NO equivale a la pagina fisica 1-based que usa
`pageindex_style.py:264`. Un PDF con portada + romanos + ToC puede tener la
pagina logica "17" como pagina fisica 25. Si pasamos el numero impreso como
`physical_index` crudo, `normalize_candidate_sections` lo descarta o
desplaza todo el arbol.

**Estrategia**: el detector ToC heuristico se trata como *hint*, no como
candidato definitivo. Genera candidatos con flag `from_toc_heuristic=True`,
y SIEMPRE pasa por `verify_tree` con tolerancia mas alta. Si verify acepta
>= 70%, se confirma como atajo y se ahorra `build_candidate_tree`. Si no,
se cae a `build_candidate_tree` con LLM.

`nodes/detect_toc.py`:

```python
import re

TOC_LINE = re.compile(r"^(?P<title>.+?)\s*\.{3,}\s*(?P<page>\d+)\s*$")
TOC_DETECTION_RANGE = 0.15  # primeras 15% paginas

def _resolve_logical_to_physical(
    logical: int,
    title: str,
    pages: list[LabeledPage],
) -> int | None:
    """Busca la pagina fisica donde aparece el titulo, comenzando desde la
    pagina cuyo numero impreso coincide con `logical`. Devuelve None si no
    se puede resolver con confianza."""
    needle = title.strip().casefold()[:80]
    if not needle:
        return None

    # 1) Intento directo: la pagina fisica == logical (cubre PDFs sin portada).
    if 1 <= logical <= len(pages):
        text = pages[logical - 1]["text"].casefold()
        if needle in text[:1000]:
            return logical

    # 2) Buscar el titulo a partir del primer match razonable, desde la
    # mitad del documento hacia adelante (saltea ToC).
    skip = max(1, len(pages) // 10)
    for physical in range(skip, len(pages) + 1):
        text = pages[physical - 1]["text"].casefold()
        if needle in text[:1000]:
            return physical

    return None

async def detect_toc(state: TreeState) -> dict[str, Any]:
    pages = state["raw_pages"]  # ver finding 3
    toc_window = pages[: max(5, int(len(pages) * TOC_DETECTION_RANGE))]
    lines = [
        (page["page"], line.strip())
        for page in toc_window
        for line in page["text"].split("\n")
        if line.strip()
    ]
    matches = [(page, TOC_LINE.match(line)) for page, line in lines]
    parsed = [(page, m) for page, m in matches if m]

    if len(parsed) < 4:
        return {
            "tree_mode": "no_toc",
            "metrics": {**state["metrics"], "toc_detected": False},
        }

    sections: list[CandidateSection] = []
    resolved = 0
    for index, (_page, match) in enumerate(parsed):
        logical = int(match.group("page"))
        title = match.group("title").strip()
        physical = _resolve_logical_to_physical(logical, title, pages)
        if physical is None:
            continue
        resolved += 1
        sections.append({
            "structure": str(index + 1),
            "title": title,
            "physical_index": physical,
            "from_toc_heuristic": True,
        })

    resolution_ratio = resolved / len(parsed)
    if resolution_ratio < 0.7 or len(sections) < 4:
        # No confiable: degradar a flujo LLM normal.
        return {
            "tree_mode": "no_toc",
            "metrics": {
                **state["metrics"],
                "toc_detected": True,
                "toc_resolution_ratio": round(resolution_ratio, 3),
                "toc_used": False,
            },
        }

    return {
        "candidate_sections": sections,
        "tree_mode": "toc_heuristic",
        "metrics": {
            **state["metrics"],
            "toc_detected": True,
            "toc_section_count": len(sections),
            "toc_resolution_ratio": round(resolution_ratio, 3),
            "toc_used": True,
        },
    }
```

**Routing**:

```python
def route_after_detect_toc(state: TreeState) -> str:
    if state.get("tree_mode") == "toc_heuristic" and state.get("candidate_sections"):
        return "verify_tree"          # atajo, valida anclas reales
    return "build_candidate_tree"     # flujo LLM normal (secuencial)
```

**Tolerancia adaptativa en verify_tree**: si el verifier corre con
`tree_mode == "toc_heuristic"` y rechaza > 30% de las secciones, no se
intenta `repair_sections` sino que se degrada a `build_candidate_tree`
completo (LLM puro). Eso evita gastar otra ronda LLM reparando un esqueleto
heuristico fundamentalmente malo.

Helper en `_normalize_section` (`pageindex_style.py`): aceptar
`from_toc_heuristic` como passthrough.

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

**Gotcha de doble fuente**: el codigo actual usa un solo `state["pages"]`
para prompts LLM, post-process de rangos, refinamiento y construccion de
`chunks` persistidos (`tree_graph.py:587, 806`). Si aplicamos dedupe in-place
a `state["pages"]`, el texto persistido en `chunks.content` queda mutilado y
el viewer pierde lineas reales. Mal cambio.

**Separar dos fuentes en `TreeState`**:

- `raw_pages: list[LabeledPage]` — original sin tocar. Lo usa
  `post_process_tree`, `build_chunks_from_tree`, `coverage_check` y todo lo
  que persiste contenido.
- `prompt_pages: list[LabeledPage]` — version dedupeada. Lo usa
  `detect_document_type`, `detect_toc`, `build_candidate_tree`,
  `verify_tree`, `repair_sections`, `refine_one_node`.

Inicializacion en `run_tree_index_graph` (`graph.py`):

```python
from .helpers import strip_repeated_headers_footers

raw_pages = pages
prompt_pages = strip_repeated_headers_footers(raw_pages)
initial_state["raw_pages"] = raw_pages
initial_state["prompt_pages"] = prompt_pages
```

Helper en `pageindex_style.py`:

```python
def strip_repeated_headers_footers(
    pages: list[LabeledPage],
    head_lines: int = 3,
    tail_lines: int = 3,
) -> list[LabeledPage]:
    if len(pages) < 4:
        return pages
    head_counts: dict[str, int] = {}
    tail_counts: dict[str, int] = {}
    for page in pages:
        lines = [line.strip() for line in page["text"].split("\n") if line.strip()]
        for line in lines[:head_lines]:
            head_counts[line] = head_counts.get(line, 0) + 1
        for line in lines[-tail_lines:]:
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

**Migration en los nodos**:

| Nodo | Antes | Despues |
|------|-------|---------|
| `detect_document_type` | `state["pages"][:3]` | `state["prompt_pages"][:3]` |
| `detect_toc` | (nuevo) | `state["raw_pages"]` (busca en bruto), reporta sobre `prompt_pages` |
| `build_candidate_tree` | `state["pages"]` para split | `state["prompt_pages"]` |
| `verify_tree` | `state["pages"]` | `state["prompt_pages"]` |
| `repair_sections` | `state["pages"]` | `state["prompt_pages"]` |
| `_refined_subtree_for_node` | `state["pages"]` | `state["prompt_pages"]` |
| `post_process_tree` | `state["pages"]` (para rangos) | `state["raw_pages"]` |
| `coverage_check` | (nuevo) | `state["raw_pages"]` |
| `build_chunks_from_tree` | `state["pages"]` | `state["raw_pages"]` |
| `_attach_source_blocks` | indirecto via tree | sin cambio |

Como `state["pages"]` desaparece, todos los nodos deben usar explicitamente
`raw_pages` o `prompt_pages`. La migracion se hace en el mismo paso del
refactor (paso 3 del plan) para evitar estados intermedios inconsistentes.

### Cache de summaries en Upstash

**Alcance v1: solo `summary_one_node`**. `routing_summary` queda fuera del
cache porque su prompt depende de mas inputs (`prompts.py:224-237`):
`document_type`, `path`, `page_range`, `summary` previo y el propio text.
Cachearlo con una key parcial corre el riesgo de devolver routing text
incorrecto y contaminar embeddings derivados. Si en v2 se decide cachear
routing, se hace con key completa explicita.

`summary_one_node` (`prompts.py:209-221`) depende de: `title`, page range
y text del nodo. Cache key v1 es estable.

Helper en `app/cache.py`:

```python
import hashlib
import os
from typing import Any

import httpx

from .http_client import get_supabase_client

UPSTASH_URL = os.getenv("UPSTASH_REDIS_REST_URL", "").rstrip("/")
UPSTASH_TOKEN = os.getenv("UPSTASH_REDIS_REST_TOKEN", "")
DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60
CACHE_VERSION = "v1"

def _is_configured() -> bool:
    return bool(UPSTASH_URL and UPSTASH_TOKEN)

def summary_cache_key(
    *,
    text: str,
    title: str,
    page_start: int,
    page_end: int,
    summary_model: str,
    tree_prompt_version: str,
) -> str:
    payload = "|".join([
        CACHE_VERSION,
        tree_prompt_version,
        summary_model,
        title,
        f"{page_start}-{page_end}",
        text,
    ])
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    return f"tree:summary:{CACHE_VERSION}:{digest}"

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
        return  # fallback noop
```

`nodes/summarize_node.py` consulta cache antes del LLM:

```python
from ..cache import summary_cache_key, get_cached, set_cached

async def summarize_one_node(state: TreeState) -> dict[str, Any]:
    target = state["summary_target"]
    text = target.get("text", "")
    title = target.get("title", "")
    model = os.getenv("SDA_TREE_SUMMARY_MODEL", os.getenv("SDA_TREE_LLM_MODEL", ""))
    key = summary_cache_key(
        text=text,
        title=title,
        page_start=target["start_index"],
        page_end=target["end_index"],
        summary_model=model,
        tree_prompt_version=TREE_PROMPT_VERSION,
    )

    cached = await get_cached(key)
    if cached:
        return {
            "summary_results": [{"node_id": target["node_id"], "text": cached}],
            "summary_cache_hits": 1,
        }

    response = await call_tree_llm_text(summary_prompt(_node_from_task(target)), "summary")
    summary = response["content"].strip()
    await set_cached(key, summary)
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

Y `collect_summaries` los expone en `metrics`.

`routing_summary` NO se cachea en v1. Sigue corriendo LLM en cada job.

Compatibilidad con `docs/gotchas.md:73-79`:

- TTL absoluto 30d -> no se acumulan keys huerfanas.
- Fallback a LLM si Redis miss/down -> outage no bloquea indexing.
- Operacional: el dato real vive en `chunks.summary` (postgres). Cache es solo
  acelerador.
- Key incluye `tree_prompt_version` para invalidacion automatica cuando los
  prompts cambien en futuros bumps.

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

Cada paso es un commit independiente (idealmente PR aparte). Antes de cerrar
cada paso, correr la suite de validacion:

```bash
# Tests Python (worker)
npm run test:tree-indexer

# Workspace JS/TS
npm run lint
npm run typecheck
npm run build

# Health checks operativos
npm run env:doctor
npm run redis:health
npm run indexing:health
```

Health remoto de workers (despues de deploy `srv-ia-01`):

```bash
# Compute gateway
curl -sf -H "authorization: Bearer $SDA_COMPUTE_GATEWAY_TOKEN" \
  https://srv-ia-01.taileb1b9c.ts.net/v1/health | jq .

# Tree indexer (via gateway proxy o directo en host privado)
ssh sistemas@srv-ia-01 'curl -sf -H "authorization: Bearer $TOKEN" \
  http://127.0.0.1:8790/v1/health' | jq .

# mineru-api (privado, solo via SSH)
ssh sistemas@srv-ia-01 'curl -sf http://127.0.0.1:8765/health || \
  systemctl status mineru-api.service --no-pager'
```

Verificacion GPU post deploy:

```bash
ssh sistemas@srv-ia-01 'nvidia-smi --query-gpu=memory.used,memory.free,utilization.gpu --format=csv'
```

Resultado esperado: `memory.used` cerca del modelo MinerU preloaded (no
debe quedar en 85+ GB que era vllm), `memory.free` con al menos 70 GB
disponibles, `utilization.gpu` sube cuando hay indexing activo.

Smoke real (no opcional, parte del done):

1. Subir un PDF nuevo al tenant principal (3 perfiles: escaneado, nativo
   corto ~10p, nativo largo ~150p con ToC).
2. Verificar que `indexing.compute_gateway.started` -> `compute/mineru.completed`
   -> `compute/tree.completed` aparecen en Inngest dashboard sin error.
3. Abrir el visor PDF y validar que `doc_tree` se renderiza y que clickear
   un chunk navega al rango de paginas correcto.
4. Re-indexar uno de los tres (forzar reindex). Verificar
   `metrics.summary_cache_hits` > 0 en la segunda corrida.

Si cualquier comando de la suite falla, no avanzar al siguiente paso.

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
  juntos. Cada `Send` en `refine_one_node` lleva contexto minimo
  (`refine_target_node_id`, `refine_target_pages`, `refine_target_start_index`).
  Test con `SDA_TREE_CHECKPOINTING=1` antes de habilitar en produccion.
- **state["pages"] desaparece**: el refactor introduce `raw_pages` y
  `prompt_pages` como campos separados. Cualquier helper externo que
  consuma el state via la API publica `run_tree_index_graph` recibe
  `pages` como antes (input), pero internamente se desdobla. Tests
  existentes que mockeen `state["pages"]` deben actualizarse.
- **ToC heuristico falso positivo**: si `_resolve_logical_to_physical` cae
  en un titulo muy generico ("Introduccion") que aparece en multiples
  paginas, puede asignar la fisica equivocada. Mitigaciones: matching
  case-fold de los primeros 80 chars, busqueda desde la mitad del doc en
  adelante (saltea ToC mismo), umbral de resolucion `>= 70%` y verifier
  con tolerancia `>= 70%` que degrada a flujo LLM si no pasa.
- **Cache key cambio en bump de prompts**: como `tree_prompt_version`
  forma parte de la cache key, un bump invalida todo en una corrida.
  Esperado: primera reindex despues del bump paga el costo LLM completo.
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
