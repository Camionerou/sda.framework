# Wave 1 — Deuda técnica trackeada

**Tag de cierre:** `wave-1-pdf-complete` (2026-05-26)
**Estado:** Wave 1 deployed y operativo para markdown + fast-path PDFs con TOC detectable.
**Pendiente:** ver matriz abajo, priorizada para Wave 2.

Esta lista consolida hallazgos del implementation + deploy real (PDF saldivia-buses-portfolio, 1.1MB, processed en 80s, $0.000274 cost, status=ready). Cada item incluye severidad, effort y dónde se manifiesta.

---

## Matriz priorizada

| # | Severidad | Effort | Área | Resumen |
|---|-----------|--------|------|---------|
| 1 | 🔴 **Crítica** | 2-4h | indexer workflow | `tree_nodes.text=""` en PDF path — retrieval roto |
| 2 | 🟡 Media | 1-2h | Supabase + dispatcher | `rate_limits.in_flight` counter leak ya stuck en prod |
| 3 | 🟡 Media | 1-2h | mineru service | Race condition con docs enqueados >1 vez |
| 4 | 🟡 Media | 30min | indexer pipeline | `index_extractor` genera secciones duplicadas |
| 5 | 🟡 Media | 1h | db migration + workflow | `tree_nodes.appear_start` populated nunca |
| 6 | 🟡 Media | 2-3h | mineru parser | full-path MinerU sin page markers `## Page N` |
| 7 | 🟡 Media | 2-3h | mineru deploy | resolver `magic-pdf` → `mineru` package rename + conflict pydantic |
| 8 | 🟢 Bajo | 1h | api endpoint | `RepairLoopExhausted` no mapea a `failure_reason='structure_unreparable'` |
| 9 | 🟢 Bajo | 1h | indexer lifespan | `parser.mineru.url` requiere restart de machines para tomar efecto |
| 10 | 🟢 Bajo | 30min | mineru parser | DeepSeek `deepseek-chat` aliasea a `deepseek-v4-flash` |

---

## Detalle por ítem

### 1. 🔴 `tree_nodes.text = ""` en PDF path — retrieval roto

**File:** `services/sda-indexer/src/sda_indexer/workflows/structure.py:persist_tree`

**Comportamiento:** después de procesar el PDF real con fast-path:
```sql
SELECT title, length(text) FROM tree_nodes WHERE document_id = '<doc>';
-- QUIENES SOMOS | 0
-- FAMILIA       | 0
-- ...
```

**Root cause:** el PDF branch del workflow construye `FlatHeader(text="")` sin slicear el markdown por page boundaries entre TocNodes. `build_tree(headers)` propaga el text vacío. El LLM summarize "rescata" la situación porque usa `doc_summary_short` (primeros 600 chars) como contexto — los summaries lucen plausibles pero NO reflejan el contenido real del chunk.

**Fix:**
```python
# en persist_tree, PDF branch
md_lines = s["md_content"].splitlines()
sorted_toc = sorted(s["toc_nodes"], key=lambda n: n["page_start"])
for i, nd in enumerate(sorted_toc):
    start_line = page_line_index.get(nd["page_start"], 0)
    # extract text hasta el page_start del NEXT toc node (o EOF)
    if i + 1 < len(sorted_toc):
        end_line = page_line_index.get(sorted_toc[i+1]["page_start"], total_lines)
    else:
        end_line = total_lines
    text = "\n".join(md_lines[start_line:end_line])
    headers.append(FlatHeader(level=nd["depth"], title=nd["title"],
                              start_line=start_line, text=text))
```

**Impact:** sin este fix, los retrieval queries por chunk_text fallan completamente. Wave 3 (embeddings) requiere texto real por nodo.

---

### 2. 🟡 `rate_limits.in_flight` counter leak

**File:** dispatcher SQL `supabase/migrations/20260525000007_cron.sql:dispatch_pgmq_to_srv_ia`

**Síntoma:** counter `rate_limits.deepseek.in_flight` se incrementa con cada dispatch pero NO siempre decrementa (si machine Fly muere mid-call). Después de N horas/días → `in_flight >= max_concurrent` → cero dispatches → docs eternamente pending.

**Detectado en sesión:** counter quedó stuck en 51/50. `update rate_limits set in_flight=0` lo resolvió manualmente.

**Fix permanente (sugerido):** complementar `gc_stuck_jobs()` para decrementar proporcional:
```sql
create or replace function gc_stuck_jobs() returns int as $$
declare reclaimed int;
begin
  with done as (
    update indexing_jobs set status='failed', failure_reason='unknown',
                             failure_detail='stuck in_flight >30 min, GC reclaimed',
                             completed_at=now()
    where status='in_flight' and started_at < now() - interval '30 minutes'
    returning 1
  )
  select count(*) into reclaimed from done;

  if reclaimed > 0 then
    update rate_limits set in_flight = greatest(0, in_flight - reclaimed)
    where provider = 'deepseek';
  end if;

  return reclaimed;
end $$ language plpgsql;
```

**Alternativa más LEAN:** migrar a counter calculado en view en lugar de manual:
```sql
create or replace view rate_limits_live as
select 'deepseek' as provider,
       count(*) filter (where status='in_flight') as in_flight,
       50 as max_concurrent
from indexing_jobs;
```

Tradeoff: query cost cada dispatch vs reset periódico.

---

### 3. 🟡 Race condition mineru con docs duplicados

**File:** `services/sda-mineru-parser/src/sda_mineru/main.py:parse`

**Síntoma:** si un doc se enqueua 2 veces (trigger automático + `pgmq.send` manual de debug), las 2 machines del indexer reciben dispatch concurrente con MISMO `doc_id`. Ambas llaman `/parse` al mineru con `tmp = /var/cache/sda-mineru/_dl_{doc_id}.pdf`.

```
Call A: download → cache.put → finally tmp.unlink → 200 OK
Call B: comienza download al MISMO path → A ya lo eliminó →
        FileNotFoundError en _sha256_file(dst_path) → 500
```

**Detectado en sesión:** un smoke test con doc duplicado mostró exactamente este flow.

**Fix:** advisory lock por sha256 en el endpoint:
```python
import asyncio
_LOCKS: dict[str, asyncio.Lock] = {}

@app.post("/parse")
async def parse(req: ParseRequest):
    lock = _LOCKS.setdefault(req.expected_sha256, asyncio.Lock())
    async with lock:
        # cache lookup + download + put
        ...
```

O usar `aiofiles` con flock advisory lock a nivel filesystem. O usar un cache_keyed_lock pattern.

**Alternativa:** advisory lock en el indexer ANTES de llamar a mineru (`pg_try_advisory_lock(hashtext(doc_id))`). Mejor porque elimina la race en origen, pero requiere coordinar con LangGraph state.

---

### 4. 🟡 `index_extractor` genera secciones duplicadas

**File:** `services/sda-indexer/src/sda_indexer/pipeline/structure/index_extractor.py:extract_index`

**Síntoma:** el PDF real generó nodos `DISEÑO EXTERIOR` 2 veces (chunks del mismo documento detectaron la misma section en cada chunk). El extract_index hace `asyncio.gather` de chunks paralelos sin dedupe.

**Fix (1 línea adicional):**
```python
async def extract_index(...):
    chunks = _chunk_by_pages(...)
    sem = asyncio.Semaphore(max_concurrency)
    async def _bounded(chunk_md): ...
    results = await asyncio.gather(*[_bounded(c) for c in chunks])
    flat = [n for sub in results for n in sub]
    flat.sort(key=lambda n: n.page_start)

    # NEW: dedupe by (normalized_title, depth) preservando el primer page_start
    seen = set()
    deduped = []
    for n in flat:
        key = (n.title.strip().lower(), n.depth)
        if key not in seen:
            seen.add(key)
            deduped.append(n)
    return deduped
```

---

### 5. 🟡 `tree_nodes.appear_start` siempre NULL

**Files:**
- `supabase/migrations/20260526000011_pdf_wave1_columns.sql` (crea columna)
- `services/sda-indexer/src/sda_indexer/pipeline/tree/builder.py` (TreeNode dataclass)
- `services/sda-indexer/src/sda_indexer/workflows/structure.py:persist_tree`

**Comportamiento:** migration 011 crea `tree_nodes.appear_start int` + index `tree_nodes_appear_start_idx(document_id, appear_start)`. PERO `TreeNode` (pipeline/tree/builder.py) no tiene atributo `appear_start`, y `persist_tree` hace `getattr(n, "appear_start", None)` → siempre NULL.

**Fix:**
1. Agregar `appear_start: int | None = None` al `TreeNode` dataclass.
2. En `persist_tree` PDF branch, crear `FlatHeader` con extra atributo o un `node_id_str → page_start` map paralelo:
```python
page_starts = {nd["title"]: nd["page_start"] for nd in s["toc_nodes"]}
# ...
new_id = await conn.fetchval(
    """insert into tree_nodes (..., appear_start) values (..., $10) returning id""",
    ..., page_starts.get(n.title),
)
```

---

### 6. 🟡 Page markers `## Page N` solo en native/fast path

**File:** `services/sda-mineru-parser/src/sda_mineru/parser.py:_parse_mineru` vs `_parse_native`

**Síntoma:** `_parse_native` (pypdf) inyecta `## Page N\n\n<text>` por página. `_parse_mineru` (subprocess `magic-pdf`) lee el `.md` que produce MinerU y NO inyecta page markers (MinerU genera flowing markdown). Resultado: en full-path PDFs, el `page_line_index` del workflow queda vacío → todos los nodos terminan con `start_line=0` → bloquea D-1.3 y agrava Gap 1.

**Fix:** post-procesar el markdown de MinerU para inyectar markers basado en MinerU JSON metadata por página (MinerU expone `content_list.json` con bbox + page). O usar form-feed (`\f`) cuando MinerU lo inyecte.

**Bloqueante para:** D-1.3 (PDFs feos scan-only).

---

### 7. 🟡 `magic-pdf` package conflict pydantic + rename a `mineru`

**File:** `services/sda-mineru-parser/pyproject.toml` (línea con TODO Task 34)

**Síntoma:** la línea `magic-pdf[full]>=0.10.0` fue COMENTADA durante scaffold (Task 8) por conflicto: `magic-pdf` pinea `pydantic<2.8.0` vs nuestro `>=2.9.0`. Adicionalmente, el package fue **renombrado a `mineru`** en mid-2025.

**Impact:** full-path PDFs (subprocess) NO funcionan en srv-ia-01 — el binary `magic-pdf` no existe en el venv del service.

**Fix:** durante deploy a srv-ia-01:
1. Verificar nombre actual del CLI: `which mineru || which magic-pdf`
2. Si es `mineru`: instalar en venv ISOLADO (separado del service):
   ```bash
   ssh sistemas@srv-ia-01 'cd ~ && uv venv mineru-venv --python 3.10
       source mineru-venv/bin/activate
       uv pip install mineru
       which mineru'
   ```
3. Actualizar `parser.py:_parse_mineru` para apuntar al binary correcto:
   ```python
   MINERU_BIN = os.environ.get("MINERU_BIN", "/home/sistemas/mineru-venv/bin/mineru")
   cmd = [MINERU_BIN, "-p", str(pdf_path), "-o", str(work_dir), "-m", "auto"]
   ```
4. systemd `Environment=MINERU_BIN=/home/sistemas/mineru-venv/bin/mineru`

**Bloqueante para:** D-1.3 (junto con #6).

---

### 8. 🟢 `RepairLoopExhausted` no mapea a `failure_reason='structure_unreparable'`

**File:** `services/sda-indexer/src/sda_indexer/api/structure.py`

**Comportamiento:** cuando `repair_tree` lanza `RepairLoopExhausted`, el handler captura todo con `HTTPException(status_code=500, detail=str(e))` genérico. El `failure_reason` en `indexing_jobs` queda NULL.

**Fix:** middleware o decorador que mapee specific exceptions:
```python
from sda_indexer.pipeline.structure.repair import RepairLoopExhausted
from sda_indexer.pipeline.parser.pdf_mineru import MineruError

@app.exception_handler(RepairLoopExhausted)
async def repair_exhausted_handler(req, exc):
    return JSONResponse(
        status_code=422,
        content={"failure_reason": "structure_unreparable", "detail": str(exc)},
    )

@app.exception_handler(MineruError)
async def mineru_handler(req, exc):
    return JSONResponse(
        status_code=exc.status_code,
        content={"failure_reason": exc.failure_reason, "detail": exc.detail},
    )
```

Y wirear el dispatcher SQL para que parse el response y popule `failure_reason` en `indexing_jobs`.

**Impact:** Wave 2 dashboards de DLQ van a tener todo agrupado bajo "unknown" en lugar de buckets específicos.

---

### 9. 🟢 `parser.mineru.url` requiere restart de machines

**File:** `services/sda-indexer/src/sda_indexer/main.py:lifespan`

**Comportamiento:** `MineruClient` se construye una sola vez en `lifespan` con `mineru_url = await settings_client.resolve("parser.mineru.url")`. Si se cambia el setting via `app_settings` + `pg_notify`, el cache de SettingsClient se invalida pero el `MineruClient` ya construido sigue apuntando al URL viejo.

**Workaround actual:** `flyctl machines restart -a sda-indexer-prod`.

**Fix:** o (a) lazy construction per-request del MineruClient, o (b) listener `settings_changed` que reconstruya `app.state.mineru` cuando cambia `parser.mineru.url`.

---

### 10. 🟢 DeepSeek `deepseek-chat` → `deepseek-v4-flash` aliasing

**Comportamiento:** la API de DeepSeek aliasea `deepseek-chat` → `deepseek-v4-flash`. Para usar el modelo Pro (reasoning) hay que usar nombre específico (a confirmar en el catálogo actual).

**Impact actual:** spec §3.2 dice "Pro para TOC/structure, Flash para summarize". Como todas las settings `llm.router.*.model` apuntan a `"deepseek-chat"`, **todo corre Flash**. Esto NO bloquea funcionalidad (de hecho ahorra costo), pero NO valida D-1.5 (tiered routing visible en dashboards).

**Fix Wave 2:** verificar catálogo DeepSeek actual:
```bash
DEEPSEEK_API_KEY=... curl https://api.deepseek.com/v1/models | jq
```
Cambiar settings `llm.router.toc.model` y `llm.router.structure.model` a `deepseek-reasoner` (o nombre actual del Pro).

---

## Información de contexto

- **E2E real ejecutado:** PDF de Saldivia Buses portfolio (1.1MB, ~28pag fast-path pypdf)
- **Tiempo:** 80s desde upload hasta status=ready
- **Cost:** $0.000274 (0.027¢)
- **Cache hit ratio:** 71.8% (1792/2495 tokens)
- **Nodos:** 5 top-level extraídos correctamente

## Cómo contribuir un fix

1. Pickear el item priorizado (1 > 2 > 3 > ...)
2. Branch desde main: `git checkout -b fix/wave1-debt-<N>-<short-desc>`
3. Test failing → impl → green (TDD, sin mocks por CLAUDE.md)
4. Tachar el item de esta lista en el PR
5. Después de merge, actualizar `wave_1_known_gaps.md` memoria
