# MinerU GPU + Tree Pipeline Acceleration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mover MinerU a GPU con modelos calientes via `mineru-api`, apagar `vllm-nemotron` que bloquea 85 GB de VRAM, refactorizar el Tree Indexer Python descomponiendo el archivo monolitico de 1031 LOC, paralelizar `refine_large_nodes`, agregar pool httpx + RetryPolicy tipado, sumar cache de summaries en Upstash y mejorar la calidad del arbol (ToC heuristico, confidence scoring, coverage check, dedupe headers).

**Architecture:** Dos workers separados en `srv-ia-01`: el Compute Gateway (Node) pasa de `spawn(mineru CLI)` a backend `hybrid-http-client` apuntando a `mineru-api` privado en `127.0.0.1:8765`. El Tree Indexer Python (FastAPI + LangGraph) descompone `tree_graph.py` en un paquete con un modulo por nodo, agrega `RetryPolicy` con excepciones tipadas, paraleliza solo los nodos genuinamente independientes, separa `raw_pages` de `prompt_pages` y consulta cache Upstash antes de pegarle al LLM para summaries.

**Tech Stack:** MinerU 3.1.15 (hybrid backend, CUDA), LangGraph 1.0.5, FastAPI, httpx (pool + http2), Upstash Redis REST, Supabase (Postgres + Storage), systemd user services en `srv-ia-01`, pytest para tests Python, npm scripts para healths.

**Reference spec:** `docs/superpowers/specs/2026-05-21-mineru-gpu-tree-pipeline-acceleration-design.md`.

---

## Paso 1 · Apagar vllm + arreglar mineru-api.service (Infra GPU)

### Task 1.1: Snapshot pre-cambio del estado GPU

**Files:**
- Create: `docs/superpowers/plans/_evidence/2026-05-21-pre-state.txt` (no commit, evidencia local)

- [ ] **Step 1: Capturar estado GPU + servicios antes de tocar nada**

```bash
ssh sistemas@srv-ia-01 'nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu --format=csv'
ssh sistemas@srv-ia-01 'docker ps --format "table {{.ID}}\t{{.Image}}\t{{.Status}}\t{{.Names}}"'
ssh sistemas@srv-ia-01 'sudo systemctl status mineru-api.service --no-pager -l 2>&1 | head -20'
```

Expected: VRAM con ~85 GB usado por `vllm-nemotron-omni-nvfp4`, `mineru-api.service` en `activating auto-restart` con contador alto.

Guardar output en archivo local para comparar despues.

### Task 1.2: Apagar vllm-nemotron-omni-nvfp4

**Files:**
- Modify: Docker daemon en `srv-ia-01` (no archivo en repo)

- [ ] **Step 1: Stop container preservando estado**

```bash
ssh sistemas@srv-ia-01 'docker stop vllm-nemotron-omni-nvfp4'
```

Expected: `vllm-nemotron-omni-nvfp4` impreso, exit 0 en ~10-30s.

- [ ] **Step 2: Cambiar restart policy a no auto-arrancar**

```bash
ssh sistemas@srv-ia-01 'docker update --restart=no vllm-nemotron-omni-nvfp4'
```

Expected: `vllm-nemotron-omni-nvfp4` impreso.

- [ ] **Step 3: Verificar VRAM liberada**

```bash
ssh sistemas@srv-ia-01 'nvidia-smi --query-gpu=memory.used,memory.free --format=csv'
```

Expected: `memory.used` < 5000 MiB, `memory.free` > 90000 MiB.

- [ ] **Step 4: Confirmar container apagado pero persistido**

```bash
ssh sistemas@srv-ia-01 'docker ps -a --filter "name=vllm-nemotron-omni-nvfp4" --format "{{.Status}}"'
```

Expected: `Exited (0) ...`. Imagen y volumenes intactos.

### Task 1.3: Reescribir mineru-api.service systemd unit

**Files:**
- Modify: `/etc/systemd/system/mineru-api.service` en `srv-ia-01` (root)

- [ ] **Step 1: Reset failed counter**

```bash
ssh sistemas@srv-ia-01 'sudo systemctl reset-failed mineru-api.service && sudo systemctl stop mineru-api.service'
```

Expected: exit 0. `systemctl status` muestra `inactive`.

- [ ] **Step 2: Escribir unit corregido**

```bash
ssh sistemas@srv-ia-01 'sudo tee /etc/systemd/system/mineru-api.service > /dev/null <<EOF
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
EOF'
```

Expected: archivo escrito sin error.

- [ ] **Step 3: Reload daemon + arrancar service**

```bash
ssh sistemas@srv-ia-01 'sudo systemctl daemon-reload && sudo systemctl enable mineru-api.service && sudo systemctl start mineru-api.service'
```

Expected: exit 0. Preload tarda 30-90s.

- [ ] **Step 4: Esperar y validar health**

```bash
ssh sistemas@srv-ia-01 'for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:8765/docs > /dev/null 2>&1; then
    echo "READY"; break
  fi
  sleep 5
done && systemctl status mineru-api.service --no-pager | head -15'
```

Expected: `READY` impreso. Status `active (running)`. Si no, ver logs con `journalctl -u mineru-api.service -n 100 --no-pager`.

- [ ] **Step 5: Verificar VRAM ocupada por modelos preloaded**

```bash
ssh sistemas@srv-ia-01 'nvidia-smi --query-gpu=memory.used --format=csv'
```

Expected: `memory.used` entre 5-15 GB (modelos MinerU cargados pero sin vllm).

- [ ] **Step 6: Commit nota operativa (no toca codigo del repo)**

No hay codigo que commitear. Anotar en `docs/gotchas.md` que `mineru-api.service` ahora apunta al venv correcto.

```bash
# Solo si decidis documentarlo:
echo "" >> docs/gotchas.md
cat >> docs/gotchas.md <<'EOF'

## MinerU GPU service en srv-ia-01

- `mineru-api.service` corre como systemd system unit con
  `ExecStart=/home/sistemas/sda-mineru/.venv/bin/mineru-api --host 127.0.0.1 --port 8765 --enable-vlm-preload True`.
- Binario es wrapper de 327 bytes en el venv. NO confundir con
  `/home/sistemas/sda/.venv/` (path legacy inexistente).
- `--enable-vlm-preload True` carga el VLM al startup (~30-90s).
  `TimeoutStartSec=600` cubre el tiempo de preload.
- Apagar con `sudo systemctl stop mineru-api.service`. Container
  `vllm-nemotron-omni-nvfp4` queda apagado para liberar VRAM.
EOF
git add docs/gotchas.md
git commit -m "docs(gotchas): mineru-api service en srv-ia-01"
```

### Task 1.4: Validacion paso 1 end-to-end

- [ ] **Step 1: GPU libre, mineru-api hot, vllm off**

```bash
ssh sistemas@srv-ia-01 'echo "=== GPU ===" && nvidia-smi --query-gpu=memory.used,memory.free,utilization.gpu --format=csv && \
echo "=== mineru-api ===" && systemctl status mineru-api.service --no-pager | head -8 && \
echo "=== vllm ===" && docker ps -a --filter "name=vllm" --format "{{.Names}}: {{.Status}}"'
```

Expected: VRAM con ~10 GB usado (modelos MinerU), `mineru-api` active running, vllm `Exited`.

---

## Paso 2 · Compute Gateway HTTP client switch

### Task 2.1: Tests de config para el nuevo env var

**Files:**
- Create: `workers/compute-gateway/tests/config.test.mjs`

`workers/compute-gateway/` no tiene tests aun. Si el repo no admite agregar tests JS sin runner configurado, saltar este test y validar manual en Task 2.4.

- [ ] **Step 1: Verificar que existe runner de tests**

```bash
ls workers/compute-gateway/ | grep -i test || echo "NO_TEST_RUNNER"
grep -l "node --test\|vitest\|jest" workers/compute-gateway/package.json 2>/dev/null || echo "NO_TEST_DEPS"
```

Expected: si imprime `NO_TEST_RUNNER` y `NO_TEST_DEPS`, saltar este test y pasar a Task 2.2 directamente.

### Task 2.2: Agregar MINERU_API_URL al config

**Files:**
- Modify: `workers/compute-gateway/config.mjs:54-60`

- [ ] **Step 1: Leer config actual**

Ya cargado en contexto. Lineas 54-60 definen `MINERU_BACKEND`, `MINERU_BIN`, `MINERU_LANG`, `MINERU_PDF_RENDER_TIMEOUT`, `MINERU_TASK_RESULT_TIMEOUT`.

- [ ] **Step 2: Agregar export MINERU_API_URL**

```javascript
// workers/compute-gateway/config.mjs — agregar despues de MINERU_TASK_RESULT_TIMEOUT
export const MINERU_API_URL = process.env.SDA_MINERU_API_URL ?? "http://127.0.0.1:8765";
```

- [ ] **Step 3: Commit aislado**

```bash
git add workers/compute-gateway/config.mjs
git commit -m "feat(gateway): add SDA_MINERU_API_URL config"
```

### Task 2.3: Switch a hybrid-http-client en execMineru

**Files:**
- Modify: `workers/compute-gateway/jobs/mineru.mjs:18-23` (import)
- Modify: `workers/compute-gateway/jobs/mineru.mjs:222-234` (execMineru)

- [ ] **Step 1: Actualizar import con MINERU_API_URL**

```javascript
import {
  COMPUTE_GATEWAY_VERSION,
  EXTRACTION_PIPELINE_VERSION,
  INDEXING_PIPELINE_VERSION,
  MINERU_API_URL,
  MINERU_BACKEND,
  MINERU_BIN,
  MINERU_LANG,
  MINERU_PDF_RENDER_TIMEOUT,
  MINERU_TASK_RESULT_TIMEOUT
} from "../config.mjs";
```

- [ ] **Step 2: Pasar `-u` al CLI**

```javascript
function execMineru(inputFile, outputDir) {
  return spawn(
    MINERU_BIN,
    [
      "-p", inputFile,
      "-o", outputDir,
      "-b", MINERU_BACKEND,
      "-l", MINERU_LANG,
      "-u", MINERU_API_URL
    ],
    {
      env: {
        ...process.env,
        MINERU_PDF_RENDER_TIMEOUT,
        MINERU_TASK_RESULT_TIMEOUT_SECONDS: MINERU_TASK_RESULT_TIMEOUT
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
}
```

- [ ] **Step 3: Validar lint + typecheck**

```bash
npm run lint
npm run typecheck
```

Expected: PASS ambos.

- [ ] **Step 4: Commit**

```bash
git add workers/compute-gateway/jobs/mineru.mjs
git commit -m "feat(gateway): switch MinerU to hybrid-http-client backend"
```

### Task 2.4: Actualizar deploy.sh con backend + concurrencia

**Files:**
- Modify: `workers/compute-gateway/deploy.sh`

- [ ] **Step 1: Verificar deploy.sh actual**

```bash
grep -n "SDA_MINERU_BACKEND\|SDA_COMPUTE_GATEWAY_CONCURRENCY\|SDA_MINERU_API_URL" workers/compute-gateway/deploy.sh
```

Expected: aparece `SDA_MINERU_BACKEND=...` (con valor `pipeline`), `SDA_COMPUTE_GATEWAY_CONCURRENCY=...` con valor 1, y NO existe `SDA_MINERU_API_URL`.

- [ ] **Step 2: Editar valores defaults**

Cambiar el bloque que escribe `.env` en el host remoto para incluir:

```bash
SDA_MINERU_BACKEND=${SDA_MINERU_BACKEND:-hybrid-http-client}
SDA_MINERU_API_URL=${SDA_MINERU_API_URL:-http://127.0.0.1:8765}
SDA_COMPUTE_GATEWAY_CONCURRENCY=${SDA_COMPUTE_GATEWAY_CONCURRENCY:-2}
```

- [ ] **Step 3: Commit**

```bash
git add workers/compute-gateway/deploy.sh
git commit -m "feat(gateway): default to hybrid-http-client + concurrency 2"
```

### Task 2.5: Deploy + smoke remoto

**Files:**
- Modify: `srv-ia-01:/home/sistemas/sda-compute-gateway/.env` (via deploy.sh)

- [ ] **Step 1: Correr deploy.sh contra srv-ia-01**

```bash
cd workers/compute-gateway && ./deploy.sh
```

Expected: rsync + scp + restart del service. Logs muestran `sda-compute-gateway.service` active.

- [ ] **Step 2: Verificar env remoto actualizado**

```bash
ssh sistemas@srv-ia-01 'grep -E "MINERU_BACKEND|MINERU_API_URL|GATEWAY_CONCURRENCY" /home/sistemas/sda-compute-gateway/.env'
```

Expected: tres lineas con los valores nuevos.

- [ ] **Step 3: Health check del gateway**

```bash
curl -sf -H "authorization: Bearer $(ssh sistemas@srv-ia-01 'awk -F= "/^SDA_COMPUTE_GATEWAY_TOKEN/ {print \$2}" /home/sistemas/sda-compute-gateway/.env')" \
  https://srv-ia-01.taileb1b9c.ts.net/v1/health | jq .
```

Expected: `{"ok": true, ...}`.

### Task 2.6: Smoke real con un PDF chico

**Files:** ninguno (testing live).

- [ ] **Step 1: Disparar reindex de un PDF nativo corto desde el frontend o CLI**

Si el repo tiene `npm run sda` con comandos de indexing, usar eso. Si no, subir un PDF nuevo desde el viewer.

- [ ] **Step 2: Monitorear gateway logs durante extraccion**

```bash
ssh sistemas@srv-ia-01 'journalctl --user -u sda-compute-gateway.service -f' &
SSH_PID=$!
# Esperar 3 minutos
sleep 180
kill $SSH_PID
```

Expected: logs muestran spawn MinerU CLI con `-b hybrid-http-client -u http://127.0.0.1:8765`, sin error de conexion ni cold-load.

- [ ] **Step 3: Validar artefactos en Supabase Storage**

```bash
npm run indexing:health
```

Expected: documento aparece en `indexing.health` con `succeeded`.

---

## Paso 3 · Refactor tree_graph.py a paquete (sin cambio comportamiento)

### Task 3.1: Mover archivo legacy

**Files:**
- Modify: `workers/tree-indexer-python/app/tree_graph.py` -> `workers/tree-indexer-python/app/tree_graph/_legacy.py`

- [ ] **Step 1: Crear paquete y mover con git para preservar historia**

```bash
mkdir -p workers/tree-indexer-python/app/tree_graph
git mv workers/tree-indexer-python/app/tree_graph.py workers/tree-indexer-python/app/tree_graph/_legacy.py
```

- [ ] **Step 2: Crear `__init__.py` que re-exporta API publica**

```python
# workers/tree-indexer-python/app/tree_graph/__init__.py
from ._legacy import (
    TREE_INDEXER_VERSION,
    is_checkpointing_configured,
    run_tree_index_graph,
)

__all__ = [
    "TREE_INDEXER_VERSION",
    "is_checkpointing_configured",
    "run_tree_index_graph",
]
```

- [ ] **Step 3: Run tests para confirmar que importes externos siguen funcionando**

```bash
npm run test:tree-indexer
```

Expected: 13/13 passed.

- [ ] **Step 4: Commit**

```bash
git add workers/tree-indexer-python/app/tree_graph
git commit -m "refactor(tree-indexer): move tree_graph.py to package, preserve api"
```

### Task 3.2: Extraer config a `config.py`

**Files:**
- Create: `workers/tree-indexer-python/app/tree_graph/config.py`
- Modify: `workers/tree-indexer-python/app/tree_graph/_legacy.py` (delete env helpers)

- [ ] **Step 1: Crear config.py con todos los env helpers cacheados**

```python
# workers/tree-indexer-python/app/tree_graph/config.py
from __future__ import annotations

import os
from functools import lru_cache


def _positive_int(name: str, fallback: int) -> int:
    try:
        value = int(os.getenv(name, str(fallback)))
    except ValueError:
        return fallback
    return value if value > 0 else fallback


def _non_negative_int(name: str, fallback: int) -> int:
    try:
        value = int(os.getenv(name, str(fallback)))
    except ValueError:
        return fallback
    return max(value, 0)


@lru_cache(maxsize=1)
def max_prompt_chars() -> int:
    return _positive_int("SDA_TREE_MAX_PROMPT_CHARS", 60_000)


@lru_cache(maxsize=1)
def summary_concurrency() -> int:
    return _positive_int("SDA_TREE_SUMMARY_CONCURRENCY", 6)


@lru_cache(maxsize=1)
def repair_attempt_limit() -> int:
    return _non_negative_int("SDA_TREE_REPAIR_ATTEMPTS", 1)


@lru_cache(maxsize=1)
def degrade_attempt_limit() -> int:
    return _non_negative_int("SDA_TREE_DEGRADE_ATTEMPTS", 1)


@lru_cache(maxsize=1)
def refine_max_pages() -> int:
    return _positive_int("SDA_TREE_REFINE_MAX_PAGES", 10)


@lru_cache(maxsize=1)
def refine_max_tokens() -> int:
    return _positive_int("SDA_TREE_REFINE_MAX_TOKENS", 20_000)


@lru_cache(maxsize=1)
def refine_iteration_limit() -> int:
    return _non_negative_int("SDA_TREE_REFINE_MAX_ITERATIONS", 3)


@lru_cache(maxsize=1)
def llm_max_inflight() -> int:
    return _positive_int("SDA_TREE_LLM_MAX_INFLIGHT", 12)
```

- [ ] **Step 2: Reemplazar uso interno en `_legacy.py`**

Buscar en `_legacy.py` las funciones `_max_prompt_chars`, `_summary_concurrency`, `_repair_attempt_limit`, `_degrade_attempt_limit`, `_refine_max_pages`, `_refine_max_tokens`, `_refine_iteration_limit`. Reemplazar el cuerpo de cada una por:

```python
from .config import (
    degrade_attempt_limit as _degrade_attempt_limit,
    max_prompt_chars as _max_prompt_chars,
    refine_iteration_limit as _refine_iteration_limit,
    refine_max_pages as _refine_max_pages,
    refine_max_tokens as _refine_max_tokens,
    repair_attempt_limit as _repair_attempt_limit,
    summary_concurrency as _summary_concurrency,
)
```

Y borrar las definiciones locales. Mantener los nombres con `_` prefix para no romper el uso interno.

- [ ] **Step 3: Run tests**

```bash
npm run test:tree-indexer
```

Expected: 13/13 passed (el comportamiento es identico, solo que ahora `lru_cache` evita re-parsear env).

- [ ] **Step 4: Commit**

```bash
git add workers/tree-indexer-python/app/tree_graph/
git commit -m "refactor(tree-indexer): extract env config to tree_graph/config.py"
```

### Task 3.3: Extraer state a `state.py`

**Files:**
- Create: `workers/tree-indexer-python/app/tree_graph/state.py`
- Modify: `workers/tree-indexer-python/app/tree_graph/_legacy.py`

- [ ] **Step 1: Crear state.py con TypedDicts**

```python
# workers/tree-indexer-python/app/tree_graph/state.py
from __future__ import annotations

import operator
from typing import Annotated, Any, TypedDict

from ..pageindex_style import CandidateSection, LabeledPage, SourceBlock, TreeChunk, TreeNode


class NodeTask(TypedDict):
    end_index: int
    node_id: str
    path: list[str]
    start_index: int
    summary: str
    text: str
    title: str


class NodeTextResult(TypedDict):
    node_id: str
    text: str


class RefinedNodeResult(TypedDict):
    node_id: str
    subtree: list[TreeNode] | None


class TreeState(TypedDict, total=False):
    candidate_sections: list[CandidateSection]
    chunks: list[TreeChunk]
    doc_summary: str
    document_id: str
    document_title: str
    document_type: str
    invalid_sections: list[CandidateSection]
    job_id: str
    metrics: dict[str, Any]
    prompt_pages: list[LabeledPage]
    raw_pages: list[LabeledPage]
    provider: str
    refine_target_node_id: str | None
    refine_target_pages: list[LabeledPage] | None
    refine_target_start_index: int | None
    refined_results: Annotated[list[RefinedNodeResult], operator.add]
    refinement_iteration: int
    repair_attempts: int
    routing_summary: str
    routing_summary_results: Annotated[list[NodeTextResult], operator.add]
    routing_target: NodeTask
    run_id: str
    source_blocks: list[SourceBlock]
    summary_cache_hits: Annotated[int, operator.add]
    summary_cache_misses: Annotated[int, operator.add]
    summary_results: Annotated[list[NodeTextResult], operator.add]
    summary_target: NodeTask
    tenant_id: str
    tree: list[TreeNode]
    tree_mode: str
    verified_sections: list[CandidateSection]
    version: str
```

Note: `pages` key se elimina; los nodos pasan a usar `raw_pages` o `prompt_pages` segun corresponda.

- [ ] **Step 2: Reemplazar TreeState en `_legacy.py`**

Borrar la definicion local de `TreeState`, `NodeTask`, `NodeTextResult` en `_legacy.py` y reemplazar por:

```python
from .state import NodeTask, NodeTextResult, RefinedNodeResult, TreeState
```

- [ ] **Step 3: Migrar `state["pages"]` -> `state["raw_pages"]` y `state["prompt_pages"]` en `_legacy.py`**

Reglas de migracion (referencia tabla del spec):
- `detect_document_type`: `state["pages"][:3]` -> `state["prompt_pages"][:3]`.
- `build_candidate_tree`: `state["pages"]` -> `state["prompt_pages"]`.
- `verify_tree`: `state["pages"]` -> `state["prompt_pages"]`.
- `repair_sections`: `state["pages"]` -> `state["prompt_pages"]`.
- `_refined_subtree_for_node`: `state["pages"]` -> `state["prompt_pages"]`.
- `post_process_tree`: `state["pages"]` -> `state["raw_pages"]`.
- `collect_routing_summaries` -> `build_chunks_from_tree(state["tree"], ...)`: el tree ya tiene texto rico desde `post_process` raw, sin cambio.
- `run_tree_index_graph`: el initial_state recibe `pages`, debe expandir a `raw_pages = pages` y `prompt_pages = strip_repeated_headers_footers(pages)`. Importar `strip_repeated_headers_footers` desde `pageindex_style`.

- [ ] **Step 4: Crear helper `strip_repeated_headers_footers` en pageindex_style.py**

```python
# workers/tree-indexer-python/app/pageindex_style.py — al final del archivo
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

- [ ] **Step 5: Test del helper nuevo**

Agregar a `workers/tree-indexer-python/tests/test_pageindex_style.py`:

```python
from app.pageindex_style import strip_repeated_headers_footers


def test_strip_repeated_headers_footers_removes_common_lines():
    pages = [
        {"page": 1, "text": "ACME Corp\nPagina 1\nContenido real 1\nFooter"},
        {"page": 2, "text": "ACME Corp\nPagina 2\nContenido real 2\nFooter"},
        {"page": 3, "text": "ACME Corp\nPagina 3\nContenido real 3\nFooter"},
        {"page": 4, "text": "ACME Corp\nPagina 4\nContenido real 4\nFooter"},
    ]
    result = strip_repeated_headers_footers(pages)
    assert "ACME Corp" not in result[0]["text"]
    assert "Footer" not in result[0]["text"]
    assert "Contenido real 1" in result[0]["text"]


def test_strip_repeated_headers_footers_passthrough_short_docs():
    pages = [{"page": 1, "text": "single\npage\ndoc"}]
    assert strip_repeated_headers_footers(pages) == pages
```

- [ ] **Step 6: Run tests**

```bash
npm run test:tree-indexer
```

Expected: 15 passed (13 originales + 2 nuevos).

- [ ] **Step 7: Commit**

```bash
git add workers/tree-indexer-python/app/tree_graph/state.py \
        workers/tree-indexer-python/app/tree_graph/_legacy.py \
        workers/tree-indexer-python/app/pageindex_style.py \
        workers/tree-indexer-python/tests/test_pageindex_style.py
git commit -m "refactor(tree-indexer): extract state, split raw_pages and prompt_pages"
```

### Task 3.4: Extraer helpers a `helpers.py`

**Files:**
- Create: `workers/tree-indexer-python/app/tree_graph/helpers.py`
- Modify: `workers/tree-indexer-python/app/tree_graph/_legacy.py`

- [ ] **Step 1: Crear helpers.py con funciones puras compartidas**

```python
# workers/tree-indexer-python/app/tree_graph/helpers.py
from __future__ import annotations

from typing import Any

from ..pageindex_style import CandidateSection, LabeledPage, SourceBlock, TreeNode
from .state import NodeTask


def visit_tree(nodes: list[TreeNode]) -> list[TreeNode]:
    visited: list[TreeNode] = []

    def visit(node: TreeNode) -> None:
        visited.append(node)
        for child in node.get("nodes", []):
            visit(child)

    for node in nodes:
        visit(node)
    return visited


def renumber_tree(nodes: list[TreeNode]) -> list[TreeNode]:
    counter = 0

    def visit(node: TreeNode) -> None:
        nonlocal counter
        node["node_id"] = f"{counter:04d}"
        counter += 1
        for child in node.get("nodes", []):
            visit(child)

    for node in nodes:
        visit(node)
    return nodes


def shift_tree_pages(nodes: list[TreeNode], offset: int) -> list[TreeNode]:
    for node in visit_tree(nodes):
        node["start_index"] += offset
        node["end_index"] += offset
    return nodes


def sub_pages_for_node(node: TreeNode, pages: list[LabeledPage]) -> list[LabeledPage]:
    selected = [page for page in pages if node["start_index"] <= page["page"] <= node["end_index"]]
    return [{"page": index + 1, "text": page["text"]} for index, page in enumerate(selected)]


def node_task(node: TreeNode, path: list[str]) -> NodeTask:
    return {
        "end_index": node["end_index"],
        "node_id": node["node_id"],
        "path": path,
        "start_index": node["start_index"],
        "summary": node.get("summary", ""),
        "text": node.get("text", ""),
        "title": node["title"],
    }


def node_from_task(target: NodeTask) -> TreeNode:
    return {
        "end_index": target["end_index"],
        "node_id": target["node_id"],
        "start_index": target["start_index"],
        "summary": target.get("summary", ""),
        "text": target.get("text", ""),
        "title": target["title"],
    }


def section_identity(section: CandidateSection) -> tuple[str, str, str]:
    return (
        str(section.get("structure", "")).strip(),
        str(section.get("title", "")).strip().casefold(),
        str(section.get("physical_index", "")).strip(),
    )


def section_page(section: CandidateSection) -> int:
    raw_index = section.get("physical_index")
    if isinstance(raw_index, int):
        return raw_index
    digits = "".join(char for char in str(raw_index) if char.isdigit())
    return int(digits) if digits else 0


def structure_sort_key(section: CandidateSection) -> tuple[int, ...]:
    parts = []
    for raw_part in str(section.get("structure", "")).split("."):
        try:
            parts.append(int(raw_part))
        except ValueError:
            parts.append(999)
    return tuple(parts)


def ordered_unique_sections(sections: list[CandidateSection]) -> list[CandidateSection]:
    seen: set[tuple[str, str, str]] = set()
    unique: list[CandidateSection] = []
    for section in sorted(sections, key=lambda item: (section_page(item), structure_sort_key(item))):
        identity = section_identity(section)
        if identity in seen:
            continue
        seen.add(identity)
        unique.append(section)
    return unique


def is_large_leaf(node: TreeNode, *, max_pages: int, max_tokens: int) -> bool:
    from ..pageindex_style import estimate_tokens

    if node.get("nodes"):
        return False
    page_count = node["end_index"] - node["start_index"] + 1
    return page_count > max_pages or estimate_tokens(node.get("text", "")) > max_tokens
```

- [ ] **Step 2: Reemplazar helpers locales en `_legacy.py`**

Borrar las definiciones de `_visit_tree`, `_renumber_tree`, `_shift_tree_pages`, `_sub_pages_for_node`, `_node_task`, `_node_from_task`, `_section_identity`, `_section_page`, `_structure_sort_key`, `_ordered_unique_sections`, `_is_large_leaf`. Reemplazar imports:

```python
from .helpers import (
    is_large_leaf as _is_large_leaf,
    node_from_task as _node_from_task,
    node_task as _node_task,
    ordered_unique_sections as _ordered_unique_sections,
    renumber_tree as _renumber_tree,
    section_identity as _section_identity,
    section_page as _section_page,
    shift_tree_pages as _shift_tree_pages,
    structure_sort_key as _structure_sort_key,
    sub_pages_for_node as _sub_pages_for_node,
    visit_tree as _visit_tree,
)
```

`_is_large_leaf` cambia firma: ahora toma `max_pages` y `max_tokens` explicitos. Crear wrapper local:

```python
def _is_large_leaf(node):
    from .helpers import is_large_leaf
    return is_large_leaf(node, max_pages=_refine_max_pages(), max_tokens=_refine_max_tokens())
```

- [ ] **Step 3: Run tests**

```bash
npm run test:tree-indexer
```

Expected: 15 passed.

- [ ] **Step 4: Commit**

```bash
git add workers/tree-indexer-python/app/tree_graph/
git commit -m "refactor(tree-indexer): extract tree helpers to helpers.py"
```

### Task 3.5: Extraer events a `events.py`

**Files:**
- Create: `workers/tree-indexer-python/app/tree_graph/events.py`
- Modify: `workers/tree-indexer-python/app/tree_graph/_legacy.py`

- [ ] **Step 1: Crear events.py**

```python
# workers/tree-indexer-python/app/tree_graph/events.py
from __future__ import annotations

from typing import Any

from ..events import publish_inngest_event
from .state import TreeState


def graph_event_base(state: TreeState) -> dict[str, Any] | None:
    tenant_id = state.get("tenant_id")
    document_id = state.get("document_id")
    run_id = state.get("run_id")
    job_id = state.get("job_id")
    if not all(isinstance(value, str) and value for value in [tenant_id, document_id, run_id, job_id]):
        return None
    return {
        "document_id": document_id,
        "job_id": job_id,
        "run_id": run_id,
        "tenant_id": tenant_id,
    }


def context_for_send(state: TreeState) -> dict[str, str]:
    return {
        "document_id": state.get("document_id", ""),
        "document_title": state.get("document_title", ""),
        "document_type": state.get("document_type", "other"),
        "job_id": state.get("job_id", ""),
        "run_id": state.get("run_id", ""),
        "tenant_id": state.get("tenant_id", ""),
    }


async def emit_tree_node_event(
    state: TreeState,
    *,
    message: str,
    metadata: dict[str, Any] | None = None,
    node: str,
    progress: int,
    status: str,
) -> None:
    base = graph_event_base(state)
    if not base:
        return
    await publish_inngest_event(
        "indexing/tree.node",
        {
            **base,
            "message": message,
            "metadata": metadata or {},
            "node": node,
            "progress": progress,
            "stage": "structuring",
            "status": status,
        },
    )
```

- [ ] **Step 2: Reemplazar referencias en `_legacy.py`**

Borrar las funciones `_graph_event_base`, `_context_for_send`, `emit_tree_node_event` locales. Reemplazar por:

```python
from .events import context_for_send as _context_for_send, emit_tree_node_event
```

- [ ] **Step 3: Run tests**

```bash
npm run test:tree-indexer
```

Expected: 15 passed.

- [ ] **Step 4: Commit**

```bash
git add workers/tree-indexer-python/app/tree_graph/
git commit -m "refactor(tree-indexer): extract event emission to events.py"
```

### Task 3.6: Extraer checkpoint a `checkpoint.py`

**Files:**
- Create: `workers/tree-indexer-python/app/tree_graph/checkpoint.py`
- Modify: `workers/tree-indexer-python/app/tree_graph/_legacy.py`

- [ ] **Step 1: Crear checkpoint.py**

```python
# workers/tree-indexer-python/app/tree_graph/checkpoint.py
from __future__ import annotations

import os
from typing import Any


def checkpoint_dsn() -> str | None:
    return (
        os.getenv("SDA_TREE_CHECKPOINT_DSN")
        or os.getenv("SDA_LANGGRAPH_CHECKPOINT_DSN")
        or os.getenv("SUPABASE_POOLER_URL")
        or os.getenv("DATABASE_URL")
    )


def checkpointing_enabled() -> bool:
    value = os.getenv("SDA_TREE_CHECKPOINTING")
    if value is not None and value != "":
        return value.lower() not in {"0", "false", "no", "off"}
    return bool(checkpoint_dsn())


def is_checkpointing_configured() -> bool:
    return bool(checkpoint_dsn() and checkpointing_enabled())


async def run_graph_with_optional_checkpoint(
    graph_builder,
    base_graph,
    initial_state,
    *,
    thread_id: str,
) -> dict[str, Any]:
    """`graph_builder` is `build_graph` callable, `base_graph` is the pre-built graph
    for the no-checkpoint path."""
    dsn = checkpoint_dsn()
    if not dsn or not checkpointing_enabled():
        return await base_graph.ainvoke(initial_state)

    try:
        from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
    except ImportError as error:
        raise RuntimeError(
            "SDA_TREE_CHECKPOINTING requiere instalar langgraph-checkpoint-postgres."
        ) from error

    async with AsyncPostgresSaver.from_conn_string(dsn) as checkpointer:
        if os.getenv("SDA_TREE_CHECKPOINT_SETUP") == "1":
            await checkpointer.setup()
        graph = graph_builder(checkpointer=checkpointer)
        return await graph.ainvoke(
            initial_state,
            config={"configurable": {"thread_id": thread_id}},
        )
```

- [ ] **Step 2: Reemplazar referencias en `_legacy.py`**

```python
from .checkpoint import (
    is_checkpointing_configured,
    run_graph_with_optional_checkpoint as _run_graph_with_optional_checkpoint_impl,
)


async def _run_graph_with_optional_checkpoint(initial_state, *, thread_id):
    return await _run_graph_with_optional_checkpoint_impl(
        build_graph, TREE_GRAPH, initial_state, thread_id=thread_id
    )
```

Borrar `_checkpoint_dsn`, `_checkpointing_enabled`, `is_checkpointing_configured` local.

- [ ] **Step 3: Run tests**

```bash
npm run test:tree-indexer
```

Expected: 15 passed.

- [ ] **Step 4: Commit**

```bash
git add workers/tree-indexer-python/app/tree_graph/
git commit -m "refactor(tree-indexer): extract checkpoint handling"
```

### Task 3.7: Mover cada nodo a `nodes/`

**Files:**
- Create: `workers/tree-indexer-python/app/tree_graph/nodes/__init__.py`
- Create: `workers/tree-indexer-python/app/tree_graph/nodes/detect_document_type.py`
- Create: `workers/tree-indexer-python/app/tree_graph/nodes/build_candidate_tree.py`
- Create: `workers/tree-indexer-python/app/tree_graph/nodes/verify_tree.py`
- Create: `workers/tree-indexer-python/app/tree_graph/nodes/repair_sections.py`
- Create: `workers/tree-indexer-python/app/tree_graph/nodes/degrade_mode.py`
- Create: `workers/tree-indexer-python/app/tree_graph/nodes/post_process_tree.py`
- Create: `workers/tree-indexer-python/app/tree_graph/nodes/refine_one_node.py`
- Create: `workers/tree-indexer-python/app/tree_graph/nodes/collect_refined_results.py`
- Create: `workers/tree-indexer-python/app/tree_graph/nodes/summarize_node.py`
- Create: `workers/tree-indexer-python/app/tree_graph/nodes/routing_summary.py`
- Create: `workers/tree-indexer-python/app/tree_graph/nodes/embed_hierarchy.py`
- Modify: `workers/tree-indexer-python/app/tree_graph/_legacy.py`

Cada nodo se mueve en un commit individual. Patron por nodo:

- [ ] **Step 1: Crear el archivo en `nodes/<nombre>.py`**

Copiar la funcion async del `_legacy.py` con sus helpers privados. Ajustar imports relativos para subir dos niveles (`from ..helpers import ...`, `from ..events import ...`).

- [ ] **Step 2: Importar desde `_legacy.py` y borrar la implementacion local**

```python
# _legacy.py
from .nodes.detect_document_type import detect_document_type
```

- [ ] **Step 3: Run tests entre nodo y nodo**

```bash
npm run test:tree-indexer
```

Expected: 15 passed despues de cada nodo movido.

- [ ] **Step 4: Commit por nodo**

```bash
git add workers/tree-indexer-python/app/tree_graph/
git commit -m "refactor(tree-indexer): move <node_name> to nodes/<node_name>.py"
```

Repetir Steps 1-4 para cada nodo en este orden (de mas simple a mas complejo, minimiza riesgo): `detect_document_type`, `fail_verification` (sigue en degrade_mode), `degrade_mode`, `prepare_summaries` (sigue en summarize_node), `summarize_node`, `routing_summary`, `post_process_tree`, `repair_sections`, `verify_tree`, `embed_hierarchy`, `build_candidate_tree`.

`refine_large_nodes` se descompone en `refine_one_node` + `collect_refined_results` en Paso 5 (paralelizacion), no en este refactor. En este paso se mueve como `refine_large_nodes.py` tal cual esta.

### Task 3.8: Extraer routing a `routing.py` + graph builder a `graph.py`

**Files:**
- Create: `workers/tree-indexer-python/app/tree_graph/routing.py`
- Create: `workers/tree-indexer-python/app/tree_graph/graph.py`
- Modify: `workers/tree-indexer-python/app/tree_graph/_legacy.py`

- [ ] **Step 1: Crear routing.py con condicionales**

```python
# workers/tree-indexer-python/app/tree_graph/routing.py
from __future__ import annotations

from langgraph.types import Send

from .config import (
    degrade_attempt_limit,
    refine_iteration_limit,
    repair_attempt_limit,
)
from .events import context_for_send
from .helpers import node_task
from .nodes.refine_large_nodes import flatten_tree  # uses pageindex_style
from .state import TreeState


def route_after_verify(state: TreeState) -> str:
    accuracy = float(state["metrics"].get("verification_accuracy") or 0)
    degrade_attempts = int(state["metrics"].get("degrade_attempts") or 0)
    invalid_count = len(state.get("invalid_sections", []))
    can_degrade = state["tree_mode"] != "no_toc" and degrade_attempts < degrade_attempt_limit()
    if accuracy >= 0.95 or invalid_count == 0:
        return "post_process_tree"
    if accuracy >= 0.6 and state.get("repair_attempts", 0) < repair_attempt_limit():
        return "repair_sections"
    if can_degrade and state.get("repair_attempts", 0) >= repair_attempt_limit():
        return "degrade_mode"
    if can_degrade and accuracy < 0.6:
        return "degrade_mode"
    return "fail_verification"


def route_after_refine(state: TreeState) -> str:
    refined = int(state["metrics"].get("last_refined_node_count") or 0)
    iteration = int(state.get("refinement_iteration", 0))
    if refined > 0 and iteration < refine_iteration_limit():
        return "refine_large_nodes"
    return "prepare_summaries"


def fan_out_summaries(state: TreeState) -> list[Send]:
    context = context_for_send(state)
    return [
        Send("summarize_one_node", {**context, "summary_target": node_task(node, path)})
        for node, path in flatten_tree(state["tree"])
    ]


def fan_out_routing_summaries(state: TreeState) -> list[Send]:
    context = context_for_send(state)
    return [
        Send("summarize_one_routing", {**context, "routing_target": node_task(node, path)})
        for node, path in flatten_tree(state["tree"])
    ]
```

- [ ] **Step 2: Crear graph.py con build_graph()**

Copiar `build_graph` desde `_legacy.py` y todos los imports de nodos:

```python
# workers/tree-indexer-python/app/tree_graph/graph.py
from __future__ import annotations

from typing import Any

from langgraph.graph import END, START, StateGraph

from .nodes.build_candidate_tree import build_candidate_tree
from .nodes.collect_refined_results import collect_refined_results
from .nodes.degrade_mode import degrade_mode, fail_verification
from .nodes.detect_document_type import detect_document_type
from .nodes.embed_hierarchy import embed_hierarchy
from .nodes.post_process_tree import post_process_tree
from .nodes.refine_large_nodes import (
    collect_summaries,
    prepare_summaries,
    refine_large_nodes,
)
from .nodes.repair_sections import repair_sections
from .nodes.routing_summary import collect_routing_summaries, summarize_one_routing
from .nodes.summarize_node import summarize_one_node
from .nodes.verify_tree import verify_tree
from .routing import (
    fan_out_routing_summaries,
    fan_out_summaries,
    route_after_refine,
    route_after_verify,
)
from .state import TreeState


def build_graph(checkpointer: Any | None = None):
    graph = StateGraph(TreeState)
    graph.add_node("collect_refined_results", collect_refined_results)
    graph.add_node("collect_routing_summaries", collect_routing_summaries)
    graph.add_node("collect_summaries", collect_summaries)
    graph.add_node("detect_document_type", detect_document_type)
    graph.add_node("build_candidate_tree", build_candidate_tree)
    graph.add_node("degrade_mode", degrade_mode)
    graph.add_node("embed_hierarchy", embed_hierarchy)
    graph.add_node("fail_verification", fail_verification)
    graph.add_node("prepare_summaries", prepare_summaries)
    graph.add_node("refine_large_nodes", refine_large_nodes)
    graph.add_node("repair_sections", repair_sections)
    graph.add_node("summarize_one_node", summarize_one_node)
    graph.add_node("summarize_one_routing", summarize_one_routing)
    graph.add_node("verify_tree", verify_tree)
    graph.add_node("post_process_tree", post_process_tree)
    graph.add_edge(START, "detect_document_type")
    graph.add_edge("detect_document_type", "build_candidate_tree")
    graph.add_edge("build_candidate_tree", "verify_tree")
    graph.add_conditional_edges(
        "verify_tree",
        route_after_verify,
        {
            "degrade_mode": "degrade_mode",
            "fail_verification": "fail_verification",
            "post_process_tree": "post_process_tree",
            "repair_sections": "repair_sections",
        },
    )
    graph.add_edge("repair_sections", "verify_tree")
    graph.add_edge("degrade_mode", "build_candidate_tree")
    graph.add_edge("post_process_tree", "refine_large_nodes")
    graph.add_conditional_edges(
        "refine_large_nodes",
        route_after_refine,
        {
            "prepare_summaries": "prepare_summaries",
            "refine_large_nodes": "refine_large_nodes",
        },
    )
    graph.add_conditional_edges("prepare_summaries", fan_out_summaries, ["summarize_one_node"])
    graph.add_edge("summarize_one_node", "collect_summaries")
    graph.add_conditional_edges("collect_summaries", fan_out_routing_summaries, ["summarize_one_routing"])
    graph.add_edge("summarize_one_routing", "collect_routing_summaries")
    graph.add_edge("collect_routing_summaries", "embed_hierarchy")
    graph.add_edge("embed_hierarchy", END)
    return graph.compile(checkpointer=checkpointer)


TREE_GRAPH = build_graph()
```

- [ ] **Step 3: Mover `run_tree_index_graph` a `graph.py`**

```python
# graph.py — al final
from .checkpoint import run_graph_with_optional_checkpoint
from ..pageindex_style import SOURCE_BLOCKS_COORDINATE_SYSTEM, LabeledPage, SourceBlock, strip_repeated_headers_footers


async def run_tree_index_graph(
    document_title: str,
    pages: list[LabeledPage],
    source_blocks: list[SourceBlock] | None = None,
    *,
    document_id: str = "",
    job_id: str = "",
    run_id: str = "",
    tenant_id: str = "",
) -> dict[str, Any]:
    source_blocks = source_blocks or []
    raw_pages = pages
    prompt_pages = strip_repeated_headers_footers(raw_pages)
    initial_state: TreeState = {
        "candidate_sections": [],
        "chunks": [],
        "doc_summary": "",
        "document_id": document_id,
        "document_title": document_title,
        "document_type": "other",
        "invalid_sections": [],
        "job_id": job_id,
        "metrics": {
            "candidate_section_count": 0,
            "chunk_count": 0,
            "degrade_attempts": 0,
            "llm_model": None,
            "llm_provider": None,
            "page_count": len(raw_pages),
            "repair_attempts": 0,
            "source_block_count": len(source_blocks),
            "verified_section_count": 0,
        },
        "raw_pages": raw_pages,
        "prompt_pages": prompt_pages,
        "provider": "",
        "refined_results": [],
        "refinement_iteration": 0,
        "repair_attempts": 0,
        "routing_summary": "",
        "routing_summary_results": [],
        "run_id": run_id,
        "source_blocks": source_blocks,
        "summary_cache_hits": 0,
        "summary_cache_misses": 0,
        "summary_results": [],
        "tenant_id": tenant_id,
        "tree": [],
        "tree_mode": "toc",
        "verified_sections": [],
        "version": TREE_INDEXER_VERSION,
    }
    result = await run_graph_with_optional_checkpoint(
        build_graph,
        TREE_GRAPH,
        initial_state,
        thread_id=job_id or run_id or document_id or "tree-index",
    )
    return {
        "chunks": result["chunks"],
        "doc_summary": result["doc_summary"],
        "document_type": result["document_type"],
        "metrics": result["metrics"],
        "model": result["metrics"].get("llm_model") or "unknown",
        "provider": result["metrics"].get("llm_provider") or result["provider"],
        "routing_summary": result["routing_summary"],
        "source_blocks_coordinate_system": (
            SOURCE_BLOCKS_COORDINATE_SYSTEM if source_blocks else None
        ),
        "tree": result["tree"],
        "tree_for_storage": remove_node_text(result["tree"]),
        "version": result["version"],
    }
```

- [ ] **Step 4: Actualizar `__init__.py` para re-exportar desde graph.py**

```python
# workers/tree-indexer-python/app/tree_graph/__init__.py
from .checkpoint import is_checkpointing_configured
from .graph import TREE_GRAPH, build_graph, run_tree_index_graph
from ..versions import TREE_INDEXER_PYTHON_VERSION as TREE_INDEXER_VERSION

__all__ = [
    "TREE_GRAPH",
    "TREE_INDEXER_VERSION",
    "build_graph",
    "is_checkpointing_configured",
    "run_tree_index_graph",
]
```

- [ ] **Step 5: Borrar `_legacy.py`**

```bash
rm workers/tree-indexer-python/app/tree_graph/_legacy.py
```

- [ ] **Step 6: Run tests + lint**

```bash
npm run test:tree-indexer
npm run lint
```

Expected: 15 passed, 0 lint errors.

- [ ] **Step 7: Commit**

```bash
git add workers/tree-indexer-python/app/tree_graph/
git rm workers/tree-indexer-python/app/tree_graph/_legacy.py
git commit -m "refactor(tree-indexer): extract graph + routing, remove legacy file"
```

### Task 3.9: Validacion fin de Paso 3

- [ ] **Step 1: Suite completa**

```bash
npm run test:tree-indexer
npm run lint
npm run typecheck
npm run build
```

Expected: 15 passed Python, 0 errors JS/TS, build ok.

- [ ] **Step 2: Validar que el package public api no rompio nada**

```bash
cd workers/tree-indexer-python && python3 -c "from app.tree_graph import run_tree_index_graph, TREE_INDEXER_VERSION, is_checkpointing_configured; print('imports ok', TREE_INDEXER_VERSION)"
```

Expected: `imports ok sda-pageindex-python-langgraph-v0.1.4`.

- [ ] **Step 3: LOC por archivo bajo control**

```bash
wc -l workers/tree-indexer-python/app/tree_graph/*.py workers/tree-indexer-python/app/tree_graph/nodes/*.py | sort -n
```

Expected: ningun archivo > 250 LOC.

---

## Paso 4 · Pool httpx + RetryPolicy tipado + semaforo LLM

### Task 4.1: Excepciones tipadas en llm.py

**Files:**
- Modify: `workers/tree-indexer-python/app/llm.py`
- Create: `workers/tree-indexer-python/tests/test_llm.py`

- [ ] **Step 1: Tests primero**

```python
# workers/tree-indexer-python/tests/test_llm.py
import unittest

from app.llm import TreeLlmPermanentError, TreeLlmTransientError, TRANSIENT_STATUS


class LlmErrorClassificationTests(unittest.TestCase):
    def test_transient_statuses_known(self):
        for status in (408, 425, 429, 500, 502, 503, 504):
            self.assertIn(status, TRANSIENT_STATUS)

    def test_transient_error_carries_status(self):
        error = TreeLlmTransientError(429, "rate limited")
        self.assertEqual(error.status_code, 429)
        self.assertEqual(str(error), "rate limited")

    def test_permanent_error_carries_status(self):
        error = TreeLlmPermanentError(400, "bad request")
        self.assertEqual(error.status_code, 400)
        self.assertEqual(str(error), "bad request")
```

- [ ] **Step 2: Verificar test falla**

```bash
npm run test:tree-indexer -- workers/tree-indexer-python/tests/test_llm.py
```

Expected: FAIL `ImportError: cannot import name 'TreeLlmTransientError'`.

- [ ] **Step 3: Agregar clases + constante en llm.py**

```python
# workers/tree-indexer-python/app/llm.py — despues de TreeLlmJsonParseError
TRANSIENT_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})


class TreeLlmTransientError(RuntimeError):
    """HTTP transient (408, 425, 429, 5xx). Reintentable."""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code


class TreeLlmPermanentError(RuntimeError):
    """HTTP permanente (400, 401, 403, 404, 422). NO reintentar."""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
```

- [ ] **Step 4: Cambiar raise generico por tipado en `call_tree_llm`**

Localizar en `llm.py:194-196`:

```python
if response.status_code >= 400:
    message = data.get("error", {}).get("message") if isinstance(data, dict) else None
    raise RuntimeError(message or f"Tree LLM fallo con HTTP {response.status_code}.")
```

Reemplazar por:

```python
if response.status_code >= 400:
    message = (
        data.get("error", {}).get("message") if isinstance(data, dict) else None
    ) or f"Tree LLM fallo con HTTP {response.status_code}."
    if response.status_code in TRANSIENT_STATUS:
        raise TreeLlmTransientError(response.status_code, message)
    raise TreeLlmPermanentError(response.status_code, message)
```

- [ ] **Step 5: Run tests**

```bash
npm run test:tree-indexer
```

Expected: 18 passed (15 anteriores + 3 nuevos).

- [ ] **Step 6: Commit**

```bash
git add workers/tree-indexer-python/app/llm.py workers/tree-indexer-python/tests/test_llm.py
git commit -m "feat(tree-indexer): typed transient/permanent LLM errors"
```

### Task 4.2: Mismo cambio en embeddings.py

**Files:**
- Modify: `workers/tree-indexer-python/app/embeddings.py`

- [ ] **Step 1: Importar errores tipados de llm.py**

```python
from .llm import TRANSIENT_STATUS, TreeLlmPermanentError, TreeLlmTransientError
```

- [ ] **Step 2: Buscar y reemplazar `RuntimeError` por error HTTP en `embeddings.py`**

```bash
grep -n "status_code >= 400\|raise RuntimeError" workers/tree-indexer-python/app/embeddings.py
```

Reemplazar cada raise post-HTTP por el patron tipado. Si el codigo actual hace `raise RuntimeError(f"Embeddings ... {response.status_code}")`, cambiar a:

```python
if response.status_code in TRANSIENT_STATUS:
    raise TreeLlmTransientError(response.status_code, message)
raise TreeLlmPermanentError(response.status_code, message)
```

- [ ] **Step 3: Run tests**

```bash
npm run test:tree-indexer
```

Expected: 18 passed.

- [ ] **Step 4: Commit**

```bash
git add workers/tree-indexer-python/app/embeddings.py
git commit -m "feat(tree-indexer): typed errors in embeddings http calls"
```

### Task 4.3: Pool httpx en `http_client.py`

**Files:**
- Create: `workers/tree-indexer-python/app/http_client.py`

- [ ] **Step 1: Crear modulo nuevo**

```python
# workers/tree-indexer-python/app/http_client.py
from __future__ import annotations

import asyncio
from functools import lru_cache

import httpx

from .tree_graph.config import llm_max_inflight


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
    return asyncio.Semaphore(llm_max_inflight())


async def close_clients() -> None:
    await get_llm_client().aclose()
    await get_supabase_client().aclose()
    get_llm_client.cache_clear()
    get_supabase_client.cache_clear()
```

Note: `http2=True` requiere `h2` instalado. Verificar `pip show h2` o agregar a `requirements.txt` si falta.

- [ ] **Step 2: Si h2 no esta, agregarlo**

```bash
cd workers/tree-indexer-python && .venv/bin/pip show h2 || echo "h2 missing"
```

Si falta, agregar `h2==4.1.0` a `requirements.txt` y reinstalar.

- [ ] **Step 3: Test del pool**

```python
# workers/tree-indexer-python/tests/test_http_client.py
import unittest

from app.http_client import get_llm_client, get_llm_semaphore, get_supabase_client


class HttpClientPoolTests(unittest.TestCase):
    def test_llm_client_singleton(self):
        a = get_llm_client()
        b = get_llm_client()
        self.assertIs(a, b)

    def test_supabase_client_singleton(self):
        a = get_supabase_client()
        b = get_supabase_client()
        self.assertIs(a, b)

    def test_semaphore_has_positive_capacity(self):
        sem = get_llm_semaphore()
        self.assertGreater(sem._value, 0)
```

- [ ] **Step 4: Run tests**

```bash
npm run test:tree-indexer
```

Expected: 21 passed.

- [ ] **Step 5: Commit**

```bash
git add workers/tree-indexer-python/app/http_client.py \
        workers/tree-indexer-python/tests/test_http_client.py \
        workers/tree-indexer-python/requirements.txt
git commit -m "feat(tree-indexer): http client pool + llm semaphore"
```

### Task 4.4: Migrar `llm.py` al pool + semaforo

**Files:**
- Modify: `workers/tree-indexer-python/app/llm.py`

- [ ] **Step 1: Importar pool**

```python
from .http_client import get_llm_client, get_llm_semaphore
```

- [ ] **Step 2: Reescribir bloque httpx en `call_tree_llm`**

Reemplazar:

```python
async with httpx.AsyncClient(timeout=config.timeout_seconds) as client:
    response = await client.post(
        f"{config.base_url}/chat/completions",
        headers=headers,
        json=payload,
    )
```

Por:

```python
client = get_llm_client()
sem = get_llm_semaphore()
async with sem:
    response = await client.post(
        f"{config.base_url}/chat/completions",
        headers=headers,
        json=payload,
        timeout=config.timeout_seconds,
    )
```

- [ ] **Step 3: Run tests**

```bash
npm run test:tree-indexer
```

Expected: 21 passed.

- [ ] **Step 4: Commit**

```bash
git add workers/tree-indexer-python/app/llm.py
git commit -m "feat(tree-indexer): llm uses pooled http client + semaphore"
```

### Task 4.5: Migrar `supabase_io.py` y `embeddings.py` al pool

**Files:**
- Modify: `workers/tree-indexer-python/app/supabase_io.py`
- Modify: `workers/tree-indexer-python/app/embeddings.py`

- [ ] **Step 1: Reemplazar todos los `async with httpx.AsyncClient(...) as client:` por uso de pool**

Patron por funcion en `supabase_io.py`:

```python
# Antes
async with httpx.AsyncClient(timeout=60) as client:
    response = await client.get(...)

# Despues
client = get_supabase_client()
response = await client.get(..., timeout=60)
```

Importar `from .http_client import get_supabase_client`.

- [ ] **Step 2: Repetir para `embeddings.py`** (mismo patron)

- [ ] **Step 3: Run tests**

```bash
npm run test:tree-indexer
```

Expected: 21 passed.

- [ ] **Step 4: Commit**

```bash
git add workers/tree-indexer-python/app/supabase_io.py workers/tree-indexer-python/app/embeddings.py
git commit -m "feat(tree-indexer): supabase + embeddings use pooled http client"
```

### Task 4.6: Shutdown hook en `main.py`

**Files:**
- Modify: `workers/tree-indexer-python/app/main.py`

- [ ] **Step 1: Importar close + registrar shutdown**

```python
# main.py — agregar import
from .http_client import close_clients

# Despues de app = FastAPI(...)
@app.on_event("shutdown")
async def _on_shutdown() -> None:
    await close_clients()
```

- [ ] **Step 2: Run tests + lint**

```bash
npm run test:tree-indexer
```

Expected: 21 passed.

- [ ] **Step 3: Commit**

```bash
git add workers/tree-indexer-python/app/main.py
git commit -m "feat(tree-indexer): close http pool on shutdown"
```

### Task 4.7: RetryPolicy en graph.py

**Files:**
- Modify: `workers/tree-indexer-python/app/tree_graph/graph.py`

- [ ] **Step 1: Imports**

```python
import httpx
from langgraph.types import RetryPolicy

from ..llm import TreeLlmTransientError

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
```

- [ ] **Step 2: Aplicar retry a cada add_node que llama LLM o red**

```python
graph.add_node("detect_document_type", detect_document_type, retry=LLM_RETRY)
graph.add_node("build_candidate_tree", build_candidate_tree, retry=LLM_RETRY)
graph.add_node("verify_tree", verify_tree, retry=LLM_RETRY)
graph.add_node("repair_sections", repair_sections, retry=LLM_RETRY)
graph.add_node("refine_large_nodes", refine_large_nodes, retry=LLM_RETRY)
graph.add_node("summarize_one_node", summarize_one_node, retry=LLM_RETRY)
graph.add_node("summarize_one_routing", summarize_one_routing, retry=LLM_RETRY)
graph.add_node("embed_hierarchy", embed_hierarchy, retry=LLM_RETRY)
```

Los nodos sin red (`degrade_mode`, `fail_verification`, `prepare_summaries`, `post_process_tree`, `collect_*`) NO llevan retry.

- [ ] **Step 3: Run tests**

```bash
npm run test:tree-indexer
```

Expected: 21 passed.

- [ ] **Step 4: Commit**

```bash
git add workers/tree-indexer-python/app/tree_graph/graph.py
git commit -m "feat(tree-indexer): RetryPolicy for LLM nodes with typed transient errors"
```

### Task 4.8: Validacion Paso 4

- [ ] **Step 1: Suite + healths**

```bash
npm run test:tree-indexer
npm run lint
npm run typecheck
```

Expected: PASS todos.

- [ ] **Step 2: Deploy worker**

```bash
cd workers/tree-indexer-python && ./deploy.sh
```

Expected: service `sda-tree-indexer.service` active running.

- [ ] **Step 3: Health remoto**

```bash
ssh sistemas@srv-ia-01 'curl -sf -H "authorization: Bearer $(awk -F= "/^SDA_TREE_INDEXER_TOKEN/ {print \$2}" /home/sistemas/sda-tree-indexer-python/.env)" http://127.0.0.1:8790/v1/health' | jq .
```

Expected: `ok: true`, `llm_configured: true`, `embedding_configured: true`.

---

## Paso 5 · Paralelizar `refine_large_nodes` via Send fan-out

### Task 5.1: Tests del refactor de refine

**Files:**
- Create: `workers/tree-indexer-python/tests/test_refine_fan_out.py`

- [ ] **Step 1: Test que fan_out_refine_targets emite un Send por nodo grande**

```python
import unittest

from app.tree_graph.routing import fan_out_refine_targets


def _state_with_two_large_nodes() -> dict:
    return {
        "document_id": "doc1",
        "document_title": "Titulo",
        "document_type": "report",
        "job_id": "job1",
        "metrics": {},
        "raw_pages": [
            {"page": i, "text": f"page {i} " * 5000}
            for i in range(1, 25)
        ],
        "prompt_pages": [
            {"page": i, "text": f"page {i} " * 5000}
            for i in range(1, 25)
        ],
        "refined_results": [],
        "refinement_iteration": 0,
        "run_id": "run1",
        "tenant_id": "tenant1",
        "tree": [
            {
                "end_index": 12,
                "node_id": "0000",
                "nodes": [],
                "start_index": 1,
                "summary": "",
                "text": "x" * 50000,
                "title": "Capitulo 1",
            },
            {
                "end_index": 24,
                "node_id": "0001",
                "nodes": [],
                "start_index": 13,
                "summary": "",
                "text": "y" * 50000,
                "title": "Capitulo 2",
            },
        ],
    }


class RefineFanOutTests(unittest.TestCase):
    def test_emits_one_send_per_large_node(self):
        sends = fan_out_refine_targets(_state_with_two_large_nodes())
        self.assertEqual(len(sends), 2)
        for send in sends:
            self.assertEqual(send.node, "refine_one_node")
            self.assertIn("refine_target_node_id", send.arg)
            self.assertIn("refine_target_pages", send.arg)
            self.assertIn("refine_target_start_index", send.arg)
```

- [ ] **Step 2: Verificar test falla**

```bash
npm run test:tree-indexer -- workers/tree-indexer-python/tests/test_refine_fan_out.py
```

Expected: FAIL ImportError `fan_out_refine_targets`.

### Task 5.2: Crear `refine_one_node` y `collect_refined_results`

**Files:**
- Create: `workers/tree-indexer-python/app/tree_graph/nodes/refine_one_node.py`
- Create: `workers/tree-indexer-python/app/tree_graph/nodes/collect_refined_results.py`
- Modify: `workers/tree-indexer-python/app/tree_graph/nodes/refine_large_nodes.py`

- [ ] **Step 1: Crear refine_one_node.py**

```python
# workers/tree-indexer-python/app/tree_graph/nodes/refine_one_node.py
from __future__ import annotations

from typing import Any

from ...llm import call_tree_llm_json
from ...pageindex_style import (
    LabeledPage,
    candidate_sections_to_tree,
    flatten_tree,
)
from ...prompts import candidate_prompt, verification_prompt
from ..events import emit_tree_node_event
from ..helpers import shift_tree_pages
from ..state import TreeState
from .build_candidate_tree import _assert_sections  # reusar validador


async def refine_one_node(state: TreeState) -> dict[str, Any]:
    node_id = state["refine_target_node_id"]
    sub_pages: list[LabeledPage] = state["refine_target_pages"]
    start_index = state["refine_target_start_index"]
    title = "(unknown)"
    for node, _path in flatten_tree(state["tree"]):
        if node["node_id"] == node_id:
            title = node["title"]
            break

    await emit_tree_node_event(
        state,
        message=f"Refinando nodo {node_id}.",
        metadata={"node_id": node_id, "page_count": len(sub_pages)},
        node="refine_one_node",
        progress=75,
        status="started",
    )

    if len(sub_pages) <= 1:
        return {"refined_results": [{"node_id": node_id, "subtree": None}]}

    response = await call_tree_llm_json(
        candidate_prompt(title, state["document_type"], tagged_pages_text(sub_pages), None, "refine"),
        "structure",
    )
    candidate_sections = _assert_sections(response["json"])
    if len(candidate_sections) <= 1:
        return {"refined_results": [{"node_id": node_id, "subtree": None}]}

    verification = await call_tree_llm_json(
        verification_prompt(candidate_sections, sub_pages),
        "structure",
    )
    verified = [
        section
        for section in _assert_sections(verification["json"])
        if section.get("valid") is not False
    ]
    if len(verified) <= 1 or len(verified) / len(candidate_sections) < 0.6:
        return {"refined_results": [{"node_id": node_id, "subtree": None}]}

    subtree = candidate_sections_to_tree(verified, sub_pages)
    if len(flatten_tree(subtree)) <= 1:
        return {"refined_results": [{"node_id": node_id, "subtree": None}]}

    shifted = shift_tree_pages(subtree, start_index - 1)
    return {"refined_results": [{"node_id": node_id, "subtree": shifted}]}


from ...pageindex_style import tagged_pages_text  # bottom import to avoid cycle
```

- [ ] **Step 2: Crear collect_refined_results.py**

```python
# workers/tree-indexer-python/app/tree_graph/nodes/collect_refined_results.py
from __future__ import annotations

from typing import Any

from ..events import emit_tree_node_event
from ..helpers import renumber_tree, visit_tree
from ..state import TreeState


async def collect_refined_results(state: TreeState) -> dict[str, Any]:
    refined_by_id = {r["node_id"]: r["subtree"] for r in state.get("refined_results", []) if r["subtree"]}
    tree = state["tree"]
    if refined_by_id:
        for node in visit_tree(tree):
            subtree = refined_by_id.get(node["node_id"])
            if subtree:
                node["nodes"] = subtree
        renumber_tree(tree)

    iteration = state.get("refinement_iteration", 0) + 1
    refined_count = len(refined_by_id)

    await emit_tree_node_event(
        state,
        message=f"Refinamiento completo: {refined_count} nodos refinados.",
        metadata={
            "refined_node_count": refined_count,
            "refinement_iteration": iteration,
        },
        node="collect_refined_results",
        progress=78,
        status="completed",
    )

    return {
        "metrics": {
            **state["metrics"],
            "last_refined_node_count": refined_count,
            "refinement_iteration": iteration,
            "refined_node_count": state["metrics"].get("refined_node_count", 0) + refined_count,
        },
        "refined_results": [],  # reset reducer para proxima iteracion
        "refinement_iteration": iteration,
        "tree": tree,
    }
```

- [ ] **Step 3: Convertir `refine_large_nodes.py` en orquestador (selector)**

El nodo `refine_large_nodes` se queda solo emitiendo el evento de inicio + delega al fan-out via condicional. Reescribir:

```python
# workers/tree-indexer-python/app/tree_graph/nodes/refine_large_nodes.py
from __future__ import annotations

from typing import Any

from ..config import refine_max_pages, refine_max_tokens
from ..events import emit_tree_node_event
from ..helpers import is_large_leaf, visit_tree
from ..state import TreeState

# Mantener `prepare_summaries` y `collect_summaries` aca (siguen siendo del flujo).
```

Mover `prepare_summaries` y `collect_summaries` a un archivo dedicado o dejarlas en `refine_large_nodes.py` como helpers post-refine. Recomendado: moverlas a `nodes/prepare_summaries.py` y `nodes/collect_summaries.py` para no mezclar responsabilidades.

`refine_large_nodes` original (con for loop) se elimina por completo; el orquestador es ahora el condicional `fan_out_refine_targets` que ya emite Sends paralelos.

- [ ] **Step 4: Crear `nodes/prepare_summaries.py` y `nodes/collect_summaries.py`**

```python
# nodes/prepare_summaries.py
from ..helpers import visit_tree
from ..state import TreeState


def prepare_summaries(state: TreeState) -> dict:
    return {
        "metrics": {**state["metrics"], "tree_node_count": len(visit_tree(state["tree"]))},
    }
```

```python
# nodes/collect_summaries.py
from typing import Any

from ...llm import call_tree_llm_text
from ...prompts import doc_summary_prompt
from ..helpers import visit_tree
from ..state import TreeState


async def collect_summaries(state: TreeState) -> dict[str, Any]:
    by_node_id = {result["node_id"]: result["text"] for result in state.get("summary_results", [])}
    for node in visit_tree(state["tree"]):
        if summary := by_node_id.get(node["node_id"]):
            node["summary"] = summary
    doc_summary = (await call_tree_llm_text(doc_summary_prompt(state["tree"]), "summary"))["content"].strip()
    return {
        "doc_summary": doc_summary,
        "metrics": {**state["metrics"], "summary_node_count": len(by_node_id)},
    }
```

### Task 5.3: Actualizar routing.py con fan_out_refine_targets

**Files:**
- Modify: `workers/tree-indexer-python/app/tree_graph/routing.py`

- [ ] **Step 1: Agregar funcion**

```python
# routing.py — agregar al final
from .config import refine_max_pages, refine_max_tokens
from .helpers import is_large_leaf, sub_pages_for_node, visit_tree


def fan_out_refine_targets(state: TreeState) -> list[Send]:
    max_pages = refine_max_pages()
    max_tokens = refine_max_tokens()
    candidates = [
        node
        for node in visit_tree(state["tree"])
        if is_large_leaf(node, max_pages=max_pages, max_tokens=max_tokens)
    ]
    if not candidates:
        return []
    pages = state["prompt_pages"]
    context = context_for_send(state)
    return [
        Send(
            "refine_one_node",
            {
                **context,
                "refine_target_node_id": node["node_id"],
                "refine_target_pages": sub_pages_for_node(node, pages),
                "refine_target_start_index": node["start_index"],
                "refined_results": [],
            },
        )
        for node in candidates
    ]


def route_after_refine_collect(state: TreeState) -> str:
    last_refined = int(state["metrics"].get("last_refined_node_count") or 0)
    iteration = int(state.get("refinement_iteration", 0))
    from .config import refine_iteration_limit
    if last_refined > 0 and iteration < refine_iteration_limit():
        return "select_refine_targets"
    return "prepare_summaries"
```

### Task 5.4: Refactor graph.py para usar fan-out

**Files:**
- Modify: `workers/tree-indexer-python/app/tree_graph/graph.py`

- [ ] **Step 1: Rewire edges para refine**

Reemplazar el bloque:

```python
graph.add_edge("post_process_tree", "refine_large_nodes")
graph.add_conditional_edges(
    "refine_large_nodes",
    route_after_refine,
    {"prepare_summaries": "prepare_summaries", "refine_large_nodes": "refine_large_nodes"},
)
```

Por:

```python
from .nodes.collect_refined_results import collect_refined_results
from .nodes.refine_one_node import refine_one_node
from .routing import fan_out_refine_targets, route_after_refine_collect

graph.add_node("refine_one_node", refine_one_node, retry=LLM_RETRY)
graph.add_node("collect_refined_results", collect_refined_results)

# `select_refine_targets` es un nodo passthrough que dispara fan-out.
def _select_refine_targets(state):
    return {}

graph.add_node("select_refine_targets", _select_refine_targets)
graph.add_edge("post_process_tree", "select_refine_targets")
graph.add_conditional_edges("select_refine_targets", fan_out_refine_targets, ["refine_one_node"])
graph.add_edge("refine_one_node", "collect_refined_results")
graph.add_conditional_edges(
    "collect_refined_results",
    route_after_refine_collect,
    {
        "select_refine_targets": "select_refine_targets",
        "prepare_summaries": "prepare_summaries",
    },
)
```

Borrar el viejo `graph.add_node("refine_large_nodes", ...)`. La logica de `route_after_refine` se reemplaza por `route_after_refine_collect`.

- [ ] **Step 2: Tests pasan**

```bash
npm run test:tree-indexer
```

Expected: el test viejo de `route_after_refine` puede fallar porque cambia firma. Actualizarlo para usar `route_after_refine_collect`. Si falla:

```python
# tests/test_tree_graph.py — reemplazar test viejo
from app.tree_graph.routing import route_after_refine_collect

def _refine_state(*, last_refined: int, iteration: int) -> dict:
    return {
        "metrics": {"last_refined_node_count": last_refined},
        "refinement_iteration": iteration,
    }

class RefineRoutingTests(unittest.TestCase):
    def test_repeats_when_refined_and_under_limit(self):
        self.assertEqual(
            route_after_refine_collect(_refine_state(last_refined=2, iteration=1)),
            "select_refine_targets",
        )

    def test_proceeds_to_summaries_when_no_refines(self):
        self.assertEqual(
            route_after_refine_collect(_refine_state(last_refined=0, iteration=0)),
            "prepare_summaries",
        )
```

- [ ] **Step 3: Commit**

```bash
git add workers/tree-indexer-python/app/tree_graph/ workers/tree-indexer-python/tests/
git commit -m "feat(tree-indexer): parallelize refine via Send fan-out"
```

### Task 5.5: Validacion Paso 5

- [ ] **Step 1: Suite + lint + deploy**

```bash
npm run test:tree-indexer
npm run lint
cd workers/tree-indexer-python && ./deploy.sh
```

Expected: PASS, deploy ok.

- [ ] **Step 2: Smoke real con doc largo**

Reindex de un PDF >= 100 paginas. Verificar en Inngest dashboard que aparecen N eventos `indexing/tree.node` con `node=refine_one_node` en paralelo (timestamps cercanos), no secuenciales.

---

## Paso 6 · ToC heuristico + coverage check (calidad)

### Task 6.1: `detect_toc` con resolucion logico->fisico

**Files:**
- Create: `workers/tree-indexer-python/app/tree_graph/nodes/detect_toc.py`
- Create: `workers/tree-indexer-python/tests/test_detect_toc.py`

- [ ] **Step 1: Tests primero**

```python
# tests/test_detect_toc.py
import asyncio
import unittest

from app.tree_graph.nodes.detect_toc import detect_toc


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _doc_with_toc() -> dict:
    pages = [
        {"page": 1, "text": "Portada"},
        {"page": 2, "text": "Indice\nIntroduccion ........ 3\nMetodo ........ 5\nResultados ........ 8\nConclusiones ........ 12"},
        {"page": 3, "text": "Introduccion\nEste documento describe..."},
        {"page": 4, "text": "Mas intro"},
        {"page": 5, "text": "Metodo\nLos pasos seguidos..."},
        {"page": 6, "text": "Mas metodo"},
        {"page": 7, "text": "Mas metodo"},
        {"page": 8, "text": "Resultados\nLos datos obtenidos..."},
        {"page": 9, "text": "Mas resultados"},
        {"page": 10, "text": "Mas resultados"},
        {"page": 11, "text": "Mas resultados"},
        {"page": 12, "text": "Conclusiones\nFinalmente..."},
    ]
    return {"raw_pages": pages, "prompt_pages": pages, "metrics": {}}


def _doc_no_toc() -> dict:
    pages = [
        {"page": 1, "text": "Solo texto sin estructura"},
        {"page": 2, "text": "Mas texto"},
    ]
    return {"raw_pages": pages, "prompt_pages": pages, "metrics": {}}


class DetectTocTests(unittest.TestCase):
    def test_detects_toc_and_resolves_to_physical_pages(self):
        result = _run(detect_toc(_doc_with_toc()))
        self.assertEqual(result["tree_mode"], "toc_heuristic")
        self.assertEqual(len(result["candidate_sections"]), 4)
        titles = [s["title"] for s in result["candidate_sections"]]
        self.assertIn("Introduccion", titles)
        # Introduccion impreso=3, fisico debe ser 3 (sin desplazamiento)
        intro = next(s for s in result["candidate_sections"] if s["title"] == "Introduccion")
        self.assertEqual(intro["physical_index"], 3)

    def test_no_toc_falls_back(self):
        result = _run(detect_toc(_doc_no_toc()))
        self.assertEqual(result["tree_mode"], "no_toc")
        self.assertFalse(result["metrics"]["toc_detected"])
```

- [ ] **Step 2: Verificar fallan**

```bash
npm run test:tree-indexer -- workers/tree-indexer-python/tests/test_detect_toc.py
```

Expected: FAIL ImportError.

- [ ] **Step 3: Implementar detect_toc.py**

Copiar exactamente el codigo del spec (seccion "Detectar ToC determinista antes del LLM", lineas con `_resolve_logical_to_physical` y `detect_toc`).

- [ ] **Step 4: Run tests**

```bash
npm run test:tree-indexer
```

Expected: tests nuevos passing.

- [ ] **Step 5: Commit**

```bash
git add workers/tree-indexer-python/app/tree_graph/nodes/detect_toc.py \
        workers/tree-indexer-python/tests/test_detect_toc.py
git commit -m "feat(tree-indexer): detect_toc with logical->physical resolution"
```

### Task 6.2: Soporte `from_toc_heuristic` en pageindex_style

**Files:**
- Modify: `workers/tree-indexer-python/app/pageindex_style.py:252-275` (normalize_candidate_sections)

- [ ] **Step 1: Permitir passthrough de la flag**

En `normalize_candidate_sections`, ajustar el dict que retorna para incluir `from_toc_heuristic` si esta presente. Como ya usa `**section`, solo verificar que la flag no se filtre.

- [ ] **Step 2: Commit**

Si no necesita cambios, skip. Si hay que ajustar, commit:

```bash
git add workers/tree-indexer-python/app/pageindex_style.py
git commit -m "feat(pageindex): preserve from_toc_heuristic flag in normalize"
```

### Task 6.3: Wire detect_toc en graph + routing

**Files:**
- Modify: `workers/tree-indexer-python/app/tree_graph/graph.py`
- Modify: `workers/tree-indexer-python/app/tree_graph/routing.py`

- [ ] **Step 1: Routing**

```python
# routing.py — agregar
def route_after_detect_toc(state: TreeState) -> str:
    if state.get("tree_mode") == "toc_heuristic" and state.get("candidate_sections"):
        return "verify_tree"
    return "build_candidate_tree"
```

- [ ] **Step 2: Graph edges**

```python
# graph.py — reemplazar:
# graph.add_edge("detect_document_type", "build_candidate_tree")
# por:
from .nodes.detect_toc import detect_toc
from .routing import route_after_detect_toc

graph.add_node("detect_toc", detect_toc)
graph.add_edge("detect_document_type", "detect_toc")
graph.add_conditional_edges(
    "detect_toc",
    route_after_detect_toc,
    {"verify_tree": "verify_tree", "build_candidate_tree": "build_candidate_tree"},
)
```

- [ ] **Step 3: Tolerancia adaptativa en `verify_tree`**

En `route_after_verify`, agregar regla: si `tree_mode == "toc_heuristic"` y accuracy < 0.7, ir a `build_candidate_tree` en lugar de `repair_sections`:

```python
def route_after_verify(state: TreeState) -> str:
    accuracy = float(state["metrics"].get("verification_accuracy") or 0)
    if state.get("tree_mode") == "toc_heuristic" and accuracy < 0.7:
        # Degradar a flujo LLM normal sin gastar repair.
        return "build_candidate_tree"
    # resto de logica igual
    ...
```

- [ ] **Step 4: Run tests + commit**

```bash
npm run test:tree-indexer
```

```bash
git add workers/tree-indexer-python/app/tree_graph/
git commit -m "feat(tree-indexer): wire detect_toc with adaptive verify tolerance"
```

### Task 6.4: Coverage check + nodos huerfanos

**Files:**
- Create: `workers/tree-indexer-python/app/tree_graph/nodes/coverage_check.py`
- Create: `workers/tree-indexer-python/tests/test_coverage_check.py`
- Modify: `workers/tree-indexer-python/app/tree_graph/graph.py`

- [ ] **Step 1: Tests primero**

```python
# tests/test_coverage_check.py
import asyncio
import unittest

from app.tree_graph.nodes.coverage_check import coverage_check


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _state_with_gap() -> dict:
    return {
        "metrics": {},
        "raw_pages": [{"page": i, "text": ""} for i in range(1, 11)],
        "tree": [
            {"node_id": "0000", "start_index": 1, "end_index": 3, "nodes": [], "title": "A"},
            {"node_id": "0001", "start_index": 7, "end_index": 10, "nodes": [], "title": "B"},
        ],
    }


def _state_full_coverage() -> dict:
    return {
        "metrics": {},
        "raw_pages": [{"page": i, "text": ""} for i in range(1, 6)],
        "tree": [{"node_id": "0000", "start_index": 1, "end_index": 5, "nodes": [], "title": "A"}],
    }


class CoverageCheckTests(unittest.TestCase):
    def test_creates_orphan_for_gaps(self):
        result = _run(coverage_check(_state_with_gap()))
        titles = [n["title"] for n in result["tree"]]
        self.assertTrue(any("4-6" in t for t in titles))
        self.assertTrue(result["metrics"]["coverage_gap"])

    def test_no_orphan_when_full(self):
        result = _run(coverage_check(_state_full_coverage()))
        self.assertEqual(len(result["tree"]), 1)
        self.assertEqual(result["metrics"]["coverage_ratio"], 1.0)
```

- [ ] **Step 2: Implementar coverage_check.py**

Copiar el codigo del spec (seccion "Validacion de cobertura"), respetando: usar `state["raw_pages"]` (no `prompt_pages`), usar `flatten_tree` de pageindex_style, `renumber_tree` de helpers.

- [ ] **Step 3: Wire en graph.py**

```python
# graph.py — reemplazar:
# graph.add_edge("post_process_tree", "select_refine_targets")
# por:
from .nodes.coverage_check import coverage_check

graph.add_node("coverage_check", coverage_check)
graph.add_edge("post_process_tree", "coverage_check")
graph.add_edge("coverage_check", "select_refine_targets")
```

- [ ] **Step 4: Run tests + commit**

```bash
npm run test:tree-indexer
git add workers/tree-indexer-python/app/tree_graph/nodes/coverage_check.py \
        workers/tree-indexer-python/app/tree_graph/graph.py \
        workers/tree-indexer-python/tests/test_coverage_check.py
git commit -m "feat(tree-indexer): coverage check with orphan node for gaps"
```

### Task 6.5: Validacion Paso 6

- [ ] **Step 1: Smoke con doc que tiene ToC**

Reindex un PDF con ToC explicito. Verificar `metrics.toc_detected: true`, `metrics.toc_used: true`, `metrics.coverage_ratio >= 0.95`.

```bash
npm run indexing:health
```

---

## Paso 7 · Confidence scoring por nodo

### Task 7.1: Helper compute_node_confidence + persistencia

**Files:**
- Modify: `workers/tree-indexer-python/app/tree_graph/helpers.py`
- Modify: `workers/tree-indexer-python/app/tree_graph/nodes/post_process_tree.py`
- Modify: `workers/tree-indexer-python/app/tree_graph/nodes/collect_refined_results.py`
- Modify: `workers/tree-indexer-python/app/supabase_io.py`
- Create: `workers/tree-indexer-python/tests/test_confidence.py`

- [ ] **Step 1: Tests**

```python
# tests/test_confidence.py
import unittest

from app.tree_graph.helpers import compute_node_confidence


class ConfidenceTests(unittest.TestCase):
    def test_score_when_verified_and_title_matches(self):
        node = {"start_index": 1, "end_index": 3, "title": "Introduccion"}
        pages = [{"page": 1, "text": "Introduccion\nContenido"}, {"page": 2, "text": ""}, {"page": 3, "text": ""}]
        score = compute_node_confidence(
            node=node, pages=pages, source_blocks=[], verifier_says_valid=True
        )
        self.assertGreaterEqual(score, 0.8)

    def test_low_when_title_missing(self):
        node = {"start_index": 1, "end_index": 3, "title": "Inexistente"}
        pages = [{"page": 1, "text": "Otro texto"}, {"page": 2, "text": ""}, {"page": 3, "text": ""}]
        score = compute_node_confidence(
            node=node, pages=pages, source_blocks=[], verifier_says_valid=None
        )
        self.assertLessEqual(score, 0.5)
```

- [ ] **Step 2: Implementar en helpers.py**

Copiar `compute_node_confidence` del spec (seccion "Confidence scoring").

- [ ] **Step 3: Aplicar en `post_process_tree.py`**

Despues de construir el tree, iterar `visit_tree(tree)` y setear `node["confidence"] = compute_node_confidence(...)` con `verifier_says_valid=True` (porque acaban de pasar verify).

- [ ] **Step 4: Aplicar en `collect_refined_results.py`**

Igual: por cada subtree refinada, calcular confidence con `verifier_says_valid=True`.

- [ ] **Step 5: Propagar a metadata en supabase_io.py**

En `_doc_tree_node_rows`, leer `node.get("confidence")` y agregarlo a `metadata`:

```python
if "confidence" in node:
    metadata["confidence"] = node["confidence"]
```

- [ ] **Step 6: Metrics agregadas**

En `collect_routing_summaries` (o en `coverage_check`, donde el tree esta finalizado), calcular `confidence_mean` y `confidence_min` y agregarlos a metrics.

- [ ] **Step 7: Run tests + commit**

```bash
npm run test:tree-indexer
git add workers/tree-indexer-python/
git commit -m "feat(tree-indexer): confidence scoring per node, persist to metadata"
```

---

## Paso 8 · Cache Upstash para summaries

### Task 8.1: Helper de cache en app/cache.py

**Files:**
- Create: `workers/tree-indexer-python/app/cache.py`
- Create: `workers/tree-indexer-python/tests/test_cache.py`

- [ ] **Step 1: Tests primero**

```python
# tests/test_cache.py
import unittest

from app.cache import CACHE_VERSION, summary_cache_key


class CacheKeyTests(unittest.TestCase):
    def test_key_includes_version(self):
        key = summary_cache_key(
            text="t", title="T", page_start=1, page_end=2,
            summary_model="m", tree_prompt_version="v1.0",
        )
        self.assertTrue(key.startswith(f"tree:summary:{CACHE_VERSION}:"))

    def test_key_changes_with_prompt_version(self):
        a = summary_cache_key(text="t", title="T", page_start=1, page_end=2,
                              summary_model="m", tree_prompt_version="v1")
        b = summary_cache_key(text="t", title="T", page_start=1, page_end=2,
                              summary_model="m", tree_prompt_version="v2")
        self.assertNotEqual(a, b)

    def test_key_changes_with_page_range(self):
        a = summary_cache_key(text="t", title="T", page_start=1, page_end=2,
                              summary_model="m", tree_prompt_version="v")
        b = summary_cache_key(text="t", title="T", page_start=1, page_end=3,
                              summary_model="m", tree_prompt_version="v")
        self.assertNotEqual(a, b)
```

- [ ] **Step 2: Implementar cache.py**

Copiar codigo del spec (seccion "Cache de summaries en Upstash"). `summary_cache_key`, `get_cached`, `set_cached`, `_is_configured`. Importa `get_supabase_client` de `http_client.py` para reusar pool.

- [ ] **Step 3: Run tests**

```bash
npm run test:tree-indexer
```

Expected: tests cache passing (sin necesidad de Redis real para test de key).

- [ ] **Step 4: Commit**

```bash
git add workers/tree-indexer-python/app/cache.py workers/tree-indexer-python/tests/test_cache.py
git commit -m "feat(tree-indexer): upstash cache helper for summaries"
```

### Task 8.2: Wire cache en summarize_one_node

**Files:**
- Modify: `workers/tree-indexer-python/app/tree_graph/nodes/summarize_node.py`

- [ ] **Step 1: Importar cache**

```python
from ...cache import summary_cache_key, get_cached, set_cached
from ...versions import TREE_PROMPT_VERSION
```

- [ ] **Step 2: Consultar cache antes del LLM**

Reescribir `summarize_one_node` con el patron del spec (lookup, miss -> LLM -> set, devolver `summary_cache_hits` o `summary_cache_misses` en el state delta).

- [ ] **Step 3: Run tests + commit**

```bash
npm run test:tree-indexer
git add workers/tree-indexer-python/app/tree_graph/nodes/summarize_node.py
git commit -m "feat(tree-indexer): consult upstash cache in summarize_one_node"
```

### Task 8.3: Surfacear metrics de cache

**Files:**
- Modify: `workers/tree-indexer-python/app/tree_graph/nodes/collect_summaries.py`

- [ ] **Step 1: Sumar cache metrics al metrics dict**

```python
async def collect_summaries(state: TreeState) -> dict[str, Any]:
    # ... existing
    return {
        "doc_summary": doc_summary,
        "metrics": {
            **state["metrics"],
            "summary_node_count": len(by_node_id),
            "summary_cache_hits": state.get("summary_cache_hits", 0),
            "summary_cache_misses": state.get("summary_cache_misses", 0),
        },
    }
```

- [ ] **Step 2: Commit**

```bash
git add workers/tree-indexer-python/app/tree_graph/nodes/collect_summaries.py
git commit -m "feat(tree-indexer): surface summary cache metrics"
```

### Task 8.4: Validacion Paso 8

- [ ] **Step 1: Verificar env vars Upstash presentes**

```bash
ssh sistemas@srv-ia-01 'grep -E "UPSTASH_REDIS_REST_URL|UPSTASH_REDIS_REST_TOKEN" /home/sistemas/sda-tree-indexer-python/.env | wc -l'
```

Expected: `2`. Si es `0`, agregar al `deploy.sh` defaults o ENV remoto.

- [ ] **Step 2: Smoke: reindex 2 veces el mismo doc**

Primera corrida: `summary_cache_hits=0`, `summary_cache_misses=N`. Segunda corrida: `summary_cache_hits=N`, `summary_cache_misses=0`.

---

## Paso 9 · Subir concurrencia + bump versiones

### Task 9.1: Defaults nuevos en deploy.sh

**Files:**
- Modify: `workers/tree-indexer-python/deploy.sh`
- Modify: `workers/compute-gateway/deploy.sh` (ya hecho en Paso 2.4)

- [ ] **Step 1: Editar tree-indexer/deploy.sh**

```bash
CONCURRENCY="${SDA_TREE_INDEXER_CONCURRENCY:-4}"
SDA_TREE_SUMMARY_CONCURRENCY="${SDA_TREE_SUMMARY_CONCURRENCY:-6}"
SDA_TREE_LLM_MAX_INFLIGHT="${SDA_TREE_LLM_MAX_INFLIGHT:-12}"
```

Agregar `SDA_TREE_LLM_MAX_INFLIGHT=$SDA_TREE_LLM_MAX_INFLIGHT` al heredoc del `.env`.

- [ ] **Step 2: Commit**

```bash
git add workers/tree-indexer-python/deploy.sh
git commit -m "feat(tree-indexer): default concurrency 4, summary 6, llm inflight 12"
```

### Task 9.2: Bump versiones en lib/system-versions.json

**Files:**
- Modify: `lib/system-versions.json`

- [ ] **Step 1: Editar**

```json
{
  "app": "0.1.7",
  "chat_agent": "0.0.0",
  "compute_gateway_extraction": "0.1.5",
  "embedding_pipeline": "0.1.0",
  "extraction_pipeline": "0.2.0",
  "indexing_pipeline": "0.1.8",
  "inngest_indexing_workflow": "0.1.6",
  "tree_indexer_python": "0.2.0",
  "tree_prompt": "0.1.2"
}
```

Cambios: `compute_gateway_extraction` 0.1.4 -> 0.1.5 (patch), `extraction_pipeline` 0.1.7 -> 0.2.0 (minor, invalida cache extracciones por backend MinerU), `tree_indexer_python` 0.1.4 -> 0.2.0 (minor, refactor + features).

- [ ] **Step 2: Commit**

```bash
git add lib/system-versions.json
git commit -m "chore(versions): bump extraction + tree indexer for GPU pipeline"
```

### Task 9.3: Deploy final + suite completa

- [ ] **Step 1: Suite local**

```bash
npm run test:tree-indexer
npm run lint
npm run typecheck
npm run build
npm run env:doctor
npm run redis:health
npm run indexing:health
npm run secrets:scan
```

Expected: TODO PASS. Si falla algo, abortar.

- [ ] **Step 2: Deploy workers en orden**

```bash
cd workers/compute-gateway && ./deploy.sh
cd ../tree-indexer-python && ./deploy.sh
```

- [ ] **Step 3: Healths remotos**

```bash
# Gateway
GW_TOKEN=$(ssh sistemas@srv-ia-01 'awk -F= "/^SDA_COMPUTE_GATEWAY_TOKEN/ {print \$2}" /home/sistemas/sda-compute-gateway/.env')
curl -sf -H "authorization: Bearer $GW_TOKEN" https://srv-ia-01.taileb1b9c.ts.net/v1/health | jq .

# Tree indexer (via SSH)
ssh sistemas@srv-ia-01 'TI_TOKEN=$(awk -F= "/^SDA_TREE_INDEXER_TOKEN/ {print \$2}" /home/sistemas/sda-tree-indexer-python/.env); curl -sf -H "authorization: Bearer $TI_TOKEN" http://127.0.0.1:8790/v1/health' | jq .

# mineru-api
ssh sistemas@srv-ia-01 'curl -sf http://127.0.0.1:8765/docs > /dev/null && echo READY || echo DOWN'
```

Expected: gateway `ok:true`, tree-indexer `llm_configured:true`, mineru-api `READY`.

- [ ] **Step 4: GPU monitoring durante smoke**

```bash
ssh sistemas@srv-ia-01 'watch -n 2 "nvidia-smi --query-gpu=memory.used,memory.free,utilization.gpu --format=csv"' &
```

Disparar reindex de 3 PDFs (escaneado, nativo corto, nativo largo). Observar `utilization.gpu` subiendo al usar MinerU.

- [ ] **Step 5: Validar metrics post-corrida**

Consultar `doc_tree.metadata.metrics` para los 3 docs:

- `coverage_ratio >= 0.95`
- `confidence_mean >= 0.5`
- `summary_cache_misses > 0` en primera corrida

Segunda corrida del mismo doc:

- `summary_cache_hits > 0`
- Tiempo end-to-end significativamente menor.

---

## Self-review checklist

- [ ] Cada paso del spec esta cubierto por al menos una task: 1 (Task 1.*), 2 (Task 2.*), 3 (Task 3.*), 4 (Task 4.*), 5 (Task 5.*), 6 (Task 6.*), 7 (Task 7.*), 8 (Task 8.*), 9 (Task 9.*).
- [ ] Sin placeholders TBD/TODO/"add error handling sin codigo".
- [ ] Cada nombre de funcion/clase aparece en la task que lo crea antes de ser referenciado.
- [ ] Comandos de validacion son los reales del repo: `npm run test:tree-indexer`, `npm run lint`, etc.
- [ ] Reversa documentada para cada paso de infra (vllm restart, mineru-api stop, env vars).
- [ ] Smoke real es obligatorio antes de cerrar Pasos 1, 2, 5, 6, 8, 9.
