# DB Extensions Integration — Tier 2 + Tier 3 Restructure

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrar `pg_jsonschema`, `btree_gin` (extensiones nuevas), un helper transversal sobre `pg_net`, indexar el uso existente de `pg_trgm`/FTS y cerrar el gap de la migración halfvec (Task 7.4 del Tier 3) dentro de los planes Tier 2 y Tier 3 existentes — sin tocar Tier 1.

**Architecture:** Este plan es **meta-plan**: sus tasks editan los documentos de plan Tier 2 y Tier 3 insertando nuevos Pasos/Tasks. El contenido insertado (migraciones SQL, pgTAP tests, commits) se ejecuta cuando los tiers corran, no en esta sesión. Adicionalmente crea 2 documentos vivos (`docs/db-extensions.md`, `docs/db-tuning.md`) y actualiza el master plan con la sección "Tier 4 candidates" + nuevas cifras.

**Tech Stack:** Postgres 17 + Supabase (`pg_jsonschema`, `btree_gin`, `pg_net`, `pg_trgm` indices, `halfvec`/pgvector ≥ 0.7), pgTAP para tests, ediciones de Markdown (Edit tool con `old_string`/`new_string`), pgcrypto (HMAC SHA-256 para dispatch security).

**Reference plans editados:**
- `docs/superpowers/plans/2026-05-22-supabase-multitenant-platform.md` (master)
- `docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier2-multipliers.md`
- `docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier3-enterprise.md`

---

## Tier overview

| Phase | Cuándo se ejecuta | Outcome | Independiente de tiers |
|---|---|---|---|
| **A** — Master plan + nuevos docs | Ahora (independiente) | Master plan actualizado, `docs/db-extensions.md` + `docs/db-tuning.md` creados | Sí, puede mergearse hoy |
| **B** — Tier 2 plan patches | Antes o durante ejecución de Tier 2 | Tier 2 plan incluye Paso 0 (DB platform foundation), Paso 3 dividido en 3.a/3.b, validators jsonschema en Paso 7 y 12, audit en Paso 16 | No, debe estar antes de que Tier 2 arranque |
| **C** — Tier 3 plan patches | Antes o durante ejecución de Tier 3 | Tier 3 plan incluye helper `app.dispatch_inngest_event` + outbox, validators jsonschema en Paso 1, trigger sync inicial en Paso 2, refactor 5.4, btree_gin indexes en Paso 6, Task 7.4 reescrita como 7.4.a/7.4.b | No, debe estar antes de que Tier 3 arranque |

**Cifras del paquete (meta-plan):**

| Phase | Tasks | Commits esperados | Archivos creados | Archivos modificados |
|---|---:|---:|---:|---:|
| Phase A | 3 | 3 | 2 (`db-extensions.md`, `db-tuning.md`) | 1 (master plan) |
| Phase B | 6 | 6 | 0 | 1 (Tier 2 plan) |
| Phase C | 7 | 7 | 0 | 1 (Tier 3 plan) |
| **Total** | **16** | **16** | **2** | **3** |

**Cifras del scope que se materializa en migraciones SQL** (cuando se ejecuten Tier 2 + Tier 3):

| | Antes | Después | Δ |
|---|---:|---:|---:|
| Tier 2 LOC | 6119 | ~6800 | +680 |
| Tier 2 migraciones | 14 | 17 | +3 |
| Tier 2 tasks | 44 | ~50 | +6 |
| Tier 3 LOC | 5407 | ~6300 | +900 |
| Tier 3 migraciones | 19 | 21 | +2 |
| Tier 3 tasks | 51 | ~57 | +6 |

---

## File structure

Archivos que se tocan a lo largo de las 3 phases. Decisiones de decomposición ya tomadas:

```
docs/
├── db-extensions.md                                                    [NUEVO — Phase A]
├── db-tuning.md                                                        [NUEVO — Phase A]
└── superpowers/plans/
    ├── 2026-05-22-supabase-multitenant-platform.md                    [EDITAR — Phase A]
    ├── 2026-05-22-supabase-multitenant-platform-tier2-multipliers.md  [EDITAR — Phase B]
    ├── 2026-05-22-supabase-multitenant-platform-tier3-enterprise.md   [EDITAR — Phase C]
    └── _evidence/
        └── 2026-05-24-uuid-ossp-pg-trgm-audit.md                       [NUEVO — generado por Tier 2 Paso 0 Task 0.3, no por este plan]
```

**No se crean migraciones SQL en este plan.** Las migraciones descritas dentro de los bloques de contenido insertado se ejecutan cuando los tiers corran. El payload de las inserciones contiene SQL + tests + commits exactos para que el executor de cada tier no necesite improvisar.

---

## Convenciones del meta-plan

### Patrón de edición

Cada task de edición a un plan existente sigue este patrón:

1. **Step 1**: leer el contexto con `Read` para confirmar el texto exacto a buscar (los planes pueden haber sido editados desde la última lectura).
2. **Step 2**: hacer la edición con `Edit` tool (`old_string` único + `new_string`).
3. **Step 3**: verificar la edición con `grep` que valide la presencia del nuevo contenido y la ausencia del viejo.
4. **Step 4**: commit con mensaje `docs(plan): ...`.

### Convención de numeración

- Paso nuevo al inicio de Tier 2 → "Paso 0" (no rompe la numeración Paso 1, 2, ...).
- Tasks nuevas dentro de un Paso existente → numerar incrementalmente al final (`Task 1.9`, `Task 1.10`, etc.).
- Task 7.4 de Tier 3 se reescribe in-place dividiéndola en `Task 7.4.a` y `Task 7.4.b`.

### Verificación tras cada edición

```bash
grep -c "^## Paso 0" docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier2-multipliers.md
# Expected: 1
```

---

## Phase A · Master plan + nuevos docs

### Task A.1: Update master plan — Tier 4 candidates + gap closure + cifras

**Files:**
- Modify: `docs/superpowers/plans/2026-05-22-supabase-multitenant-platform.md`

- [ ] **Step 1: Leer sección "Cifras del paquete" actual**

```bash
sed -n '23,32p' docs/superpowers/plans/2026-05-22-supabase-multitenant-platform.md
```

Expected: la tabla con Tier 1/2/3 cifras y total.

- [ ] **Step 2: Reemplazar tabla "Cifras del paquete"**

Use Edit tool:

`old_string`:
```
| Plan | LOC | Pasos | Tasks | Commits | Migraciones SQL |
|---|---:|---:|---:|---:|---:|
| Tier 1 Foundation | 5267 | 22 | ~30 | ~25 | 13 |
| Tier 2 Multipliers | 6119 | 18 | 44 | 27 | 14 |
| Tier 3 Enterprise | 5407 | 8 | 51 | 39 | 19 |
| **Total** | **16960** | **48** | **~125** | **~91** | **46** |
```

`new_string`:
```
| Plan | LOC | Pasos | Tasks | Commits | Migraciones SQL |
|---|---:|---:|---:|---:|---:|
| Tier 1 Foundation | 5267 | 22 | ~30 | ~25 | 13 |
| Tier 2 Multipliers | ~6800 | 19 | ~50 | ~33 | 17 |
| Tier 3 Enterprise | ~6300 | 8 | ~57 | ~46 | 21 |
| **Total** | **~18367** | **49** | **~137** | **~104** | **51** |

> Cifras actualizadas el 2026-05-24 por el plan `2026-05-24-db-extensions-tier2-tier3-restructure.md`. Tier 2 ganó Paso 0 (DB platform foundation) y 3 migraciones (`pg_jsonschema`, `btree_gin`, search indexes GIN). Tier 3 ganó helper `app.dispatch_inngest_event` + validators jsonschema connectors + btree_gin en particionado + halfvec Task 7.4 reescrita.
```

- [ ] **Step 3: Cerrar gap halfvec en "Gaps conocidos"**

`old_string`:
```
- Migracion 7.4 (halfvec) enumera explicitamente solo
  `search_tree_nodes_by_embedding`; `search_chunks` debe actualizarse en
  paralelo (inferible pero podria ser mas firme en el plan).
```

`new_string`:
```
- ~~Migracion 7.4 (halfvec) enumera explicitamente solo
  `search_tree_nodes_by_embedding`~~ — **CERRADO 2026-05-24**: Task 7.4 reescrita
  en 7.4.a (`search_chunks`) + 7.4.b (`search_tree_nodes_by_embedding`),
  cada una con migración propia y test pgTAP. Ver plan restructure.
```

- [ ] **Step 4: Insertar nueva sección "Tier 4 candidates"**

`old_string` (las últimas líneas antes de "Convenciones transversales"):
```
9. **`agent_tasks`**: diferido hasta tener journey con pull real.

---

## Convenciones transversales (aplican a los 3 tiers)
```

`new_string`:
```
9. **`agent_tasks`**: diferido hasta tener journey con pull real.

---

## Tier 4 candidates (no agendados, evaluación futura)

Extensiones / mejoras evaluadas y deliberadamente diferidas. Cada una tiene criterio de activación. Si se gatilla, abrir mini-plan dedicado.

- **`pgmq`** — cola de mensajes nativa Postgres. **Criterio**: costo Inngest mensual supera umbral acordado (definir con datos reales de operación post-Tier 3) o requerimiento de enqueue transaccional (insert + enqueue en misma tx ACID, hoy no satisfacible con Inngest). Hoy Inngest cubre el fan-out con holgura.
- **Binary quantization (`bit(1536)` prefilter HNSW)** — segundo round de cuantización de embeddings encima de halfvec. **Criterio**: p95 latencia search > 200ms después de Tier 3 Paso 7 halfvec. Implementación: índice `bit(N)` para prefiltro barato + re-rank con halfvec.
- **`pg_trgm` removal** — si el audit de Tier 2 Paso 16 Task 16.3 confirma que `gin_trgm_ops` no se está usando en producción, removerlo en migración de cleanup.
- **`uuid-ossp` removal** — si Tier 2 Paso 0 Task 0.3 confirma cero llamadas a `uuid_generate_v4()`, dropear extensión.
- **`hypopg`/`index_advisor` permanente en staging** — hoy queda como herramienta dev/staging ad-hoc (ver `docs/db-tuning.md`). Si el flujo se vuelve recurrente, formalizar habilitándolo siempre en staging via migración condicional.

---

## Convenciones transversales (aplican a los 3 tiers)
```

- [ ] **Step 5: Verificar ediciones**

```bash
grep -c "Tier 4 candidates" docs/superpowers/plans/2026-05-22-supabase-multitenant-platform.md
# Expected: 1 (o 2 si quedó referencia en otro lado)

grep -c "CERRADO 2026-05-24" docs/superpowers/plans/2026-05-22-supabase-multitenant-platform.md
# Expected: 1

grep "~18367" docs/superpowers/plans/2026-05-22-supabase-multitenant-platform.md
# Expected: línea de Total con cifra actualizada
```

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/plans/2026-05-22-supabase-multitenant-platform.md
git commit -m "docs(plan): master adds Tier 4 candidates + closes halfvec gap + updates cifras"
```

### Task A.2: Crear `docs/db-extensions.md`

**Files:**
- Create: `docs/db-extensions.md`

- [ ] **Step 1: Verificar que el archivo no existe**

```bash
test -f docs/db-extensions.md && echo "EXISTS — abort" || echo "OK to create"
```

- [ ] **Step 2: Crear archivo con inventario vivo**

Contenido completo (NO recortar — el doc es la fuente de verdad para futuras decisiones de extensiones):

```markdown
# DB extensions inventory

Inventario vivo de extensiones Postgres habilitadas en este proyecto, por qué cada una existe y dónde se consume. **Actualizar este doc** cada vez que se agregue o remueva una extensión.

> Cuando agregar / sacar una extensión: discutir primero, escribir migración con el patrón `WITH SCHEMA "extensions"`, actualizar este doc en el mismo commit.

## Habilitadas hoy (declaradas en migraciones)

| Extensión | Schema | Migración que la habilita | Para qué la usamos | Tests que la cubren |
|---|---|---|---|---|
| `pg_stat_statements` | `extensions` | `20260520145128_initial_remote_schema.sql` | Observabilidad de queries (baseline Supabase) | — |
| `pgcrypto` | `extensions` | `20260520145128_initial_remote_schema.sql` | `gen_random_uuid()`, HMAC para tokens de invites y dispatch | `tenant_invites_test.sql` |
| `uuid-ossp` | `extensions` | `20260520145128_initial_remote_schema.sql` | **Audit pendiente** (Tier 2 Paso 0 Task 0.3). Candidato a remover si no se usa. | — |
| `supabase_vault` | `vault` | `20260520145128_initial_remote_schema.sql` | Secrets cifrados (managed por Supabase) | — |
| `citext` | `extensions` | `20260520145604_core_multitenant_schema.sql` | `users.email` case-insensitive | core multitenant tests |
| `vector` (pgvector) | `extensions` | `20260520145604_core_multitenant_schema.sql` | `chunks.embedding vector(1536)`, índices HNSW; migra a `halfvec` en Tier 3 Paso 7 | search RPC tests |
| `ltree` | `extensions` | `20260521170000_db_caching_retrieval_ops.sql` | `doc_tree_nodes.node_path` paths jerárquicos | `db_caching_retrieval_ops_test.sql` |
| `pg_trgm` | `extensions` | `20260521170000_db_caching_retrieval_ops.sql` | Trigram similarity en `search_chunks` modos `trigram`/`hybrid` (índice GIN añadido en Tier 2 Paso 3.b) | search RPC tests |
| `pg_cron` | `cron` | `20260521170000_db_caching_retrieval_ops.sql` (condicional) | Jobs: cleanup, indexing health refresh, partition maintenance (Tier 3), usage aggregates (Tier 3), saved queries polling (Tier 2) | — |

## Heredadas de Supabase (sin migración propia)

Estas las habilita Supabase por defecto en proyectos nuevos. No están en nuestras migraciones pero están activas:

- `pg_graphql` — auto-genera GraphQL schema; lo dejamos prendido pero no lo consumimos.
- `pgjwt` — JWT helpers; usamos `auth.jwt()` indirectamente vía Supabase auth.
- `pgsodium` — base criptográfica de `supabase_vault`.
- `pgaudit` — auditoría a nivel sesión; no la consumimos (auditoría propia en `public.audit_log`).
- `plpgsql` — lenguaje de procedures.

## Habilitar pendiente (Tier 2 / Tier 3)

| Extensión | Schema | Tier | Migración planificada | Para qué |
|---|---|---|---|---|
| `pg_jsonschema` | `extensions` | Tier 2 Paso 0 | `20260601085000_enable_pg_jsonschema.sql` | Validar `jsonb` en CHECK constraints: `saved_queries.filters`, `notification_preferences.settings`, `tenant_oauth_credentials.config`, `document_sources.config` |
| `btree_gin` | `extensions` | Tier 2 Paso 0 | `20260601085100_enable_btree_gin.sql` | Índices compuestos `(tenant_id, jsonb_col)` y `(tenant_id, tsvector)` para search y particionado |
| `pg_net` (managed) | `extensions` (Supabase Cloud) | Tier 3 Paso 1 | Helper `app.dispatch_inngest_event` consume si está disponible | HTTP dispatch desde Postgres; fallback a outbox + cron sweep si no disponible |

## Tier 4 candidates (ver master plan)

- `pgmq` (cola de mensajes nativa) — criterio de activación: costo Inngest excesivo o necesidad transaccional.
- Binary quantization (`bit(1536)`) — criterio: p95 latencia search > 200ms post-halfvec.
- `pg_trgm` removal — si audit confirma cero uso.
- `uuid-ossp` removal — si audit confirma cero uso.
- `hypopg`/`index_advisor` permanente en staging.

## Convención de naming y schema

Toda extensión nueva se habilita con:

\`\`\`sql
create extension if not exists "<nombre>" with schema "extensions";
\`\`\`

Excepciones documentadas:
- `supabase_vault` vive en schema `vault` (Supabase lo requiere así).
- `pg_cron` puede vivir bajo schema `cron` o `extensions` según el build de Supabase. El patrón defensivo en `20260521170000_db_caching_retrieval_ops.sql` (líneas 421-462) detecta el schema correcto en runtime y debe replicarse si se agrega otra extensión con esta ambigüedad.

## Cuándo actualizar este doc

- Al agregar una nueva extensión: agregar fila a tabla "Habilitadas hoy", actualizar la sección "Habilitar pendiente" si correspondía.
- Al remover: mover de "Habilitadas hoy" a un changelog en la sección "Tier 4 candidates" con fecha y razón.
- Al cambiar el uso real de una existente (ej. `pg_trgm` post-audit): editar columna "Para qué la usamos".

Este doc vive en `docs/db-extensions.md` deliberadamente fuera de `docs/superpowers/` porque es referencia operativa permanente, no un plan ejecutable.
```

- [ ] **Step 3: Verificar archivo**

```bash
wc -l docs/db-extensions.md
# Expected: ~80-100 líneas
grep -c "^| " docs/db-extensions.md
# Expected: ~15+ filas de tabla
```

- [ ] **Step 4: Commit**

```bash
git add docs/db-extensions.md
git commit -m "docs(db): live inventory of Postgres extensions (db-extensions.md)"
```

### Task A.3: Crear `docs/db-tuning.md`

**Files:**
- Create: `docs/db-tuning.md`

- [ ] **Step 1: Verificar que el archivo no existe**

```bash
test -f docs/db-tuning.md && echo "EXISTS — abort" || echo "OK to create"
```

- [ ] **Step 2: Crear archivo**

```markdown
# DB index tuning workflow

Workflow para evaluar índices nuevos antes de crearlos en producción, usando `hypopg` + `index_advisor` en staging.

## Cuándo usar este workflow

- Una query nueva es lenta en staging con dataset realista.
- `pg_stat_statements` muestra una query con `mean_exec_time` alto en producción.
- Antes de agregar un índice a una migración productiva, validar que el planner efectivamente lo va a usar.

## Setup (una vez por entorno staging)

\`\`\`sql
create extension if not exists hypopg with schema extensions;
\`\`\`

Si la extensión no está disponible en el plan Supabase del proyecto staging, escalar a plan Pro/Team o usar EXPLAIN manual sin hypopg (menos preciso).

## Workflow paso a paso

### 1. Identificar query lenta

\`\`\`sql
select substr(query, 1, 80) as query_head,
       calls,
       round(mean_exec_time::numeric, 2) as mean_ms,
       rows
from pg_stat_statements
order by mean_exec_time desc
limit 20;
\`\`\`

### 2. Tomar el EXPLAIN base

\`\`\`sql
explain (analyze, buffers, format text)
select ... ;
\`\`\`

Guardar el output. Anotar `cost`, `rows`, scan type (Seq Scan vs Index Scan), y `Buffers: shared hit/read`.

### 3. Hipotetizar el índice con hypopg

\`\`\`sql
select * from hypopg_create_index('create index on public.chunks using gin (tenant_id, content_tsv)');
\`\`\`

Retorna un `indexrelid` hipotético — no escribe a disco.

### 4. Re-correr el EXPLAIN

\`\`\`sql
explain (format text) select ...;
\`\`\`

Comparar: ¿el planner ahora lo usa? ¿el cost bajó significativamente? Un índice que el planner ignora es índice muerto — no agregarlo.

### 5. Resetear hipótesis

\`\`\`sql
select hypopg_reset();
\`\`\`

### 6. Si vale la pena, crearlo de verdad en migración

Usar `CREATE INDEX CONCURRENTLY` para no bloquear writes en producción:

\`\`\`sql
create index concurrently if not exists chunks_content_tsv_tenant_gin_idx
  on public.chunks
  using gin (tenant_id, content_tsv);
\`\`\`

> **Gotcha**: `CONCURRENTLY` no funciona dentro de una transacción. Si la migración tiene otros statements, separar en migraciones distintas o usar el patrón de bloque `commit` explícito (raro en Supabase managed).

## Index advisor (one-shot)

Supabase Cloud expone `index_advisor` que combina hypopg con sugerencias automáticas:

\`\`\`sql
select * from index_advisor('select ... from chunks where ...');
\`\`\`

Retorna sugerencias con costos antes/después. Útil para queries opacas (LangGraph retrieval, search hybrid).

## Reglas

- **Nunca** crear índices nuevos directamente en producción sin pasar por este workflow en staging primero.
- Cada índice tiene costo: WAL, bloat, planning overhead. No es free.
- Si el dataset de staging es < 10% del de producción, los costos del planner se distorsionan. En ese caso reproducir con `ANALYZE` forzado o levantar staging con dataset escalado.
- Cuando agregues un índice, anotar en `docs/db-extensions.md` qué query lo justifica.
- Si después de N semanas en producción un índice tiene `idx_scan = 0` en `pg_stat_user_indexes`, removerlo.

## Verificar uso de índices en producción

\`\`\`sql
select
  schemaname,
  relname as table,
  indexrelname as index,
  idx_scan,
  pg_size_pretty(pg_relation_size(indexrelid)) as size
from pg_stat_user_indexes
where schemaname = 'public'
order by idx_scan asc, pg_relation_size(indexrelid) desc
limit 30;
\`\`\`

Índices con `idx_scan = 0` y tamaño > 1 MB son candidatos a remover.
```

- [ ] **Step 3: Verificar**

```bash
wc -l docs/db-tuning.md
# Expected: ~90-110 líneas
```

- [ ] **Step 4: Commit**

```bash
git add docs/db-tuning.md
git commit -m "docs(db): hypopg + index_advisor tuning workflow (db-tuning.md)"
```

---

## Phase B · Tier 2 plan patches

> **Cuándo ejecutar**: idealmente antes de arrancar Tier 2. Phase A es independiente; Phase B requiere Phase A solo para que `docs/db-extensions.md` exista (lo referenciamos desde Paso 0).

### Task B.1: Tier 2 — Insertar "Paso 0 · DB platform foundation"

**Files:**
- Modify: `docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier2-multipliers.md`

**Contexto**: el plan Tier 2 actual arranca "Paso 1 · Pre-flight Tier 2" en línea 77. Insertamos "Paso 0" inmediatamente antes, después del "Migration order" (líneas 52-75).

- [ ] **Step 1: Leer contexto exacto (líneas 70-80)**

```bash
sed -n '70,80p' docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier2-multipliers.md
```

Expected: ver la línea con el bloque ``` de cierre del migration order, separador `---`, y `## Paso 1 · Pre-flight Tier 2`.

- [ ] **Step 2: Actualizar "Migration order" — prepend 2 platform migrations + insert search indexes migration**

Edit tool:

`old_string`:
```
```text
20260601090000_message_feedback_and_citations.sql       (040)
20260601090100_search_rpcs.sql                          (040.b — search helpers)
20260601090200_user_bookmarks.sql                       (041)
```

`new_string`:
```
```text
20260601085000_enable_pg_jsonschema.sql                 (Paso 0 — platform)
20260601085100_enable_btree_gin.sql                     (Paso 0 — platform)
20260601090000_message_feedback_and_citations.sql       (040)
20260601090100_search_rpcs.sql                          (040.b — search helpers)
20260601090150_search_indexes_gin.sql                   (040.c — GIN indexes para search_chunks)
20260601090200_user_bookmarks.sql                       (041)
```

- [ ] **Step 3: Insertar bloque "Paso 0" antes de "Paso 1"**

Edit tool:

`old_string`:
```
---

## Paso 1 · Pre-flight Tier 2
```

`new_string` (bloque grande — ver código abajo). Este es el contenido que se ejecuta cuando Tier 2 arranque:

````
---

## Paso 0 · DB platform foundation

Habilita extensiones transversales (`pg_jsonschema`, `btree_gin`) que pasos posteriores consumen. Audita `uuid-ossp` y `pg_trgm` para decidir keep/remove en Tier 4. **No depende del Pre-flight Tier 1** y puede mergearse incluso antes de iniciar el resto de Tier 2.

### Task 0.1: Habilitar `pg_jsonschema` + helper `app.validate_jsonschema`

**Files:**
- Create: `supabase/migrations/20260601085000_enable_pg_jsonschema.sql`
- Create: `supabase/tests/enable_pg_jsonschema_test.sql`

- [ ] **Step 1: Escribir migración**

```sql
-- supabase/migrations/20260601085000_enable_pg_jsonschema.sql
-- Habilita pg_jsonschema para validar columnas jsonb con CHECK constraints.

create extension if not exists "pg_jsonschema" with schema "extensions";

-- Helper estable: validar un valor jsonb contra un schema jsonb.
-- Wrappea extensions.jsonb_matches_schema(schema, value) y maneja null gracefully.
create or replace function app.validate_jsonschema(_value jsonb, _schema jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when _value is null then true
    else extensions.jsonb_matches_schema(_schema, _value)
  end;
$$;

comment on function app.validate_jsonschema(jsonb, jsonb) is
  'Valida _value contra _schema (JSON Schema draft-07). Null pasa. Usar en CHECK constraints.';

revoke all on function app.validate_jsonschema(jsonb, jsonb) from public;
grant execute on function app.validate_jsonschema(jsonb, jsonb) to authenticated, service_role;
```

- [ ] **Step 2: Escribir test pgTAP**

```sql
-- supabase/tests/enable_pg_jsonschema_test.sql
BEGIN;
SELECT plan(5);

SELECT has_extension('pg_jsonschema', 'pg_jsonschema instalada');
SELECT has_function('app','validate_jsonschema', ARRAY['jsonb','jsonb'], 'helper existe');

SELECT is(
  app.validate_jsonschema(
    '{"foo":"bar"}'::jsonb,
    '{"type":"object","required":["foo"]}'::jsonb
  ),
  true,
  'objeto valido pasa'
);

SELECT is(
  app.validate_jsonschema(
    '{}'::jsonb,
    '{"type":"object","required":["foo"]}'::jsonb
  ),
  false,
  'objeto sin required field falla'
);

SELECT is(
  app.validate_jsonschema(null, '{"type":"object"}'::jsonb),
  true,
  'null pasa siempre'
);

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 3: Correr test + commit**

```bash
npm run test:db -- --test supabase/tests/enable_pg_jsonschema_test.sql
git add supabase/migrations/20260601085000_enable_pg_jsonschema.sql supabase/tests/enable_pg_jsonschema_test.sql
git commit -m "feat(db): enable pg_jsonschema + app.validate_jsonschema helper"
```

### Task 0.2: Habilitar `btree_gin`

**Files:**
- Create: `supabase/migrations/20260601085100_enable_btree_gin.sql`
- Create: `supabase/tests/enable_btree_gin_test.sql`

- [ ] **Step 1: Migración**

```sql
-- supabase/migrations/20260601085100_enable_btree_gin.sql
-- Habilita btree_gin para indices compuestos (tenant_id uuid + jsonb / tsvector / etc.)
create extension if not exists "btree_gin" with schema "extensions";
```

- [ ] **Step 2: Test**

```sql
-- supabase/tests/enable_btree_gin_test.sql
BEGIN;
SELECT plan(1);
SELECT has_extension('btree_gin', 'btree_gin instalada');
SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 3: Correr + commit**

```bash
npm run test:db -- --test supabase/tests/enable_btree_gin_test.sql
git add supabase/migrations/20260601085100_enable_btree_gin.sql supabase/tests/enable_btree_gin_test.sql
git commit -m "feat(db): enable btree_gin extension"
```

### Task 0.3: Audit `uuid-ossp` y `pg_trgm` (decisión Tier 4)

**Files:**
- Create: `docs/superpowers/plans/_evidence/2026-05-24-uuid-ossp-pg-trgm-audit.md`

- [ ] **Step 1: Audit `uuid-ossp` usage**

```bash
grep -rn "uuid_generate_v" supabase/ workers/ inngest/ lib/ app/ cli/ \
  --include='*.sql' --include='*.ts' --include='*.py' 2>/dev/null \
  | tee /tmp/uuid-ossp-audit.txt
wc -l /tmp/uuid-ossp-audit.txt
```

Expected: idealmente 0 matches. Si hay matches, listar y planificar reemplazo a `gen_random_uuid()` en Tier 4.

- [ ] **Step 2: Audit `pg_trgm` usage**

```bash
grep -rn "gin_trgm_ops\|similarity(\|word_similarity\| % " supabase/ \
  --include='*.sql' 2>/dev/null \
  | tee /tmp/pg-trgm-audit.txt
wc -l /tmp/pg-trgm-audit.txt
```

Expected: matches en `search_rpcs.sql` (Tier 2 Paso 3) y en `db_caching_retrieval_ops`. Si solo aparece en RPCs y el índice GIN trgm de Paso 3.b no se usa después en producción, candidato a remover en Tier 4.

- [ ] **Step 3: Escribir evidence doc**

```markdown
# Audit: uuid-ossp + pg_trgm — 2026-05-24

## uuid-ossp
- Matches encontrados: <N>
- Detalle (paste output de /tmp/uuid-ossp-audit.txt o "ninguno"):
  ```
  <paste>
  ```
- Decisión: <keep / remove en Tier 4>

## pg_trgm
- Matches en SQL: <N>
- Operadores usados: <%, similarity, word_similarity, etc.>
- Índices que lo respaldan: poblar después de Tier 2 Paso 3.b
- Decisión inicial: keep — usado en `search_chunks` modos `trigram`/`hybrid`.
- Re-evaluar: después de Tier 2 Paso 16 Task 16.3 (audit de uso de índice GIN trgm).
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/_evidence/2026-05-24-uuid-ossp-pg-trgm-audit.md
git commit -m "docs(db): audit uuid-ossp + pg_trgm usage (Tier 2 Paso 0 Task 0.3)"
```

---

## Paso 1 · Pre-flight Tier 2
````

- [ ] **Step 4: Verificar edición**

```bash
grep -c "^## Paso 0 · DB platform foundation" docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier2-multipliers.md
# Expected: 1
grep -c "^### Task 0\." docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier2-multipliers.md
# Expected: 3 (Task 0.1, 0.2, 0.3)
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier2-multipliers.md
git commit -m "docs(plan): tier2 add Paso 0 (DB platform foundation: pg_jsonschema, btree_gin, audits)"
```

### Task B.2: Tier 2 — Split Paso 3 → 3.a (RPCs, existente) + 3.b (índices GIN, nuevo)

**Files:**
- Modify: `docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier2-multipliers.md`

**Contexto**: Paso 3 actual (`## Paso 3 · Migracion 040.b · Search RPCs`, línea 593) crea las funciones `search_chunks`, `search_documents`, etc. usando operadores `pg_trgm` (`%`, `similarity()`) y FTS (`@@ websearch_to_tsquery`) pero **no agrega índices GIN**. Sin esos índices las RPCs hacen sequential scan a escala. Insertamos un nuevo Paso 3.b al final del Paso 3 actual con la migración `040.c` que crea los índices.

- [ ] **Step 1: Localizar fin del Paso 3 actual**

```bash
grep -n "^## Paso " docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier2-multipliers.md | head -10
```

Expected: ver línea de "## Paso 3 · ..." y la línea siguiente "## Paso 4 · ...". El bloque a insertar va inmediatamente antes de "## Paso 4".

- [ ] **Step 2: Leer las últimas 20 líneas del Paso 3 actual**

```bash
# Asumir que Paso 4 arranca en línea 1003 (según mapeo del agente). Verificar:
grep -n "^## Paso 4 · " docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier2-multipliers.md
```

- [ ] **Step 3: Insertar nuevo "Paso 3.b" antes de "Paso 4"**

Edit tool. El `old_string` debe ser el separador `---` + título exacto de Paso 4:

`old_string`:
```
---

## Paso 4 · Migracion 041 · user_bookmarks
```

`new_string`:
````
---

## Paso 3.b · Migracion 040.c · Indices GIN para search_chunks

Las RPCs de Paso 3 (`search_chunks` modos `fts`/`trigram`/`hybrid`) usan operadores `pg_trgm` y `tsvector @@ tsquery` pero el plan original no agregó índices GIN. Sin estos índices el planner hace **Seq Scan** sobre `chunks` y el modo `hybrid` (Top-K mezclado) es inviable a > 100K filas. Esta migración crea los índices con `CREATE INDEX CONCURRENTLY` para no bloquear writes en producción. Esta migración solo crea índices sobre `chunks` (alto volumen). El equivalente sobre `documents.full_text_index` se difiere — la columna no existe todavía; agregar cuando Paso 3 confirme el shape de `search_documents`.

> Esta migración **NO puede correr dentro de transacción** porque usa `CONCURRENTLY`. Supabase la procesa fuera de transacción si es el único statement del archivo. Verificar con `supabase db push --dry-run` antes de aplicar.

### Task 3.b.1: pgTAP test — verificar índices creados

**Files:**
- Create: `supabase/tests/search_indexes_gin_test.sql`

- [ ] **Step 1: Escribir test (debe FALLAR hasta crear la migración)**

```sql
-- supabase/tests/search_indexes_gin_test.sql
BEGIN;
SELECT plan(2);

SELECT has_index('public','chunks','chunks_content_trgm_idx',
  'indice trigram en chunks.content existe');
SELECT has_index('public','chunks','chunks_content_tsv_tenant_gin_idx',
  'indice compuesto (tenant_id, content_tsv) existe');

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Verificar que falla (índices aún no existen)**

```bash
npm run test:db -- --test supabase/tests/search_indexes_gin_test.sql || echo "FAIL esperado"
```

Expected: 2 fails. Es lo correcto antes de aplicar la migración.

### Task 3.b.2: Migración `20260601090150_search_indexes_gin.sql`

**Files:**
- Create: `supabase/migrations/20260601090150_search_indexes_gin.sql`

- [ ] **Step 1: Migración**

```sql
-- supabase/migrations/20260601090150_search_indexes_gin.sql
-- Índices GIN para que search_chunks y search_documents NO hagan Seq Scan.
-- Requiere extensiones pg_trgm (ya activa) y btree_gin (activada en Paso 0).
--
-- IMPORTANTE: cada CREATE INDEX CONCURRENTLY debe vivir solo en su statement
-- (no en transacción explicita). Este archivo solo crea índices.

-- 1) Índice trigram puro sobre chunks.content para modo 'trigram' de search_chunks.
create index concurrently if not exists chunks_content_trgm_idx
  on public.chunks
  using gin (content extensions.gin_trgm_ops);

-- 2) Índice compuesto (tenant_id, content_tsv) para FTS multi-tenant.
--    btree_gin permite mezclar btree (uuid) + GIN (tsvector) en un solo índice.
create index concurrently if not exists chunks_content_tsv_tenant_gin_idx
  on public.chunks
  using gin (tenant_id, content_tsv);

-- Nota: NO drop del indice chunks_content_tsv_idx existente todavia
-- (puede haber sido creado por 20260520145604). El nuevo lo desplaza si planner
-- ve que el compuesto es mejor; mantener ambos por una sprint y dropear el viejo
-- en Paso 16 Task 16.3 si pg_stat_user_indexes confirma idx_scan = 0.

comment on index public.chunks_content_trgm_idx is
  'GIN trigram para chunks.content; consume modo trigram/hybrid de search_chunks';
comment on index public.chunks_content_tsv_tenant_gin_idx is
  'GIN compuesto (tenant_id, content_tsv); consume modo fts/hybrid multi-tenant de search_chunks';
```

- [ ] **Step 2: Aplicar y verificar**

```bash
supabase db push
npm run test:db -- --test supabase/tests/search_indexes_gin_test.sql
```

Expected: test pasa (2/2).

- [ ] **Step 3: Verificar planner usa los índices**

```bash
psql "$SUPABASE_DB_URL" <<'SQL'
explain (format text)
select content
from public.chunks
where tenant_id = gen_random_uuid()
  and content_tsv @@ websearch_to_tsquery('simple', 'test');
SQL
```

Expected: aparece `Bitmap Index Scan on chunks_content_tsv_tenant_gin_idx`. Si aparece `Seq Scan`, el índice no se usa (puede ser por dataset pequeño en dev — re-verificar en staging con dataset realista).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260601090150_search_indexes_gin.sql supabase/tests/search_indexes_gin_test.sql
git commit -m "feat(db): GIN indexes para search_chunks/search_documents (trigram + tsvector multi-tenant)"
```

---

## Paso 4 · Migracion 041 · user_bookmarks
````

- [ ] **Step 4: Verificar inserción**

```bash
grep -c "^## Paso 3\.b · " docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier2-multipliers.md
# Expected: 1
grep -c "search_indexes_gin" docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier2-multipliers.md
# Expected: >= 3 (en migration order + Task 3.b.1 + Task 3.b.2)
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier2-multipliers.md
git commit -m "docs(plan): tier2 split Paso 3 — add 3.b for search GIN indexes (migration 040.c)"
```

### Task B.3: Tier 2 — Agregar Task 7.3 (validator `notification_preferences.settings`) en Paso 7

**Files:**
- Modify: `docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier2-multipliers.md`

**Contexto**: Paso 7 (línea 2337) crea `notifications` y `notification_preferences`. La columna `notification_preferences.settings jsonb` no tiene validación. Agregamos Task 7.3 al final de Paso 7 (después de Task 7.2 en línea 2483).

- [ ] **Step 1: Localizar fin de Paso 7 / inicio de Paso 8**

```bash
grep -n "^## Paso 8 · " docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier2-multipliers.md
```

- [ ] **Step 2: Insertar Task 7.3 antes de "## Paso 8"**

Edit tool:

`old_string`:
```
---

## Paso 8 · Migracion 045 · document_views
```

`new_string`:
````
### Task 7.3: Validator jsonschema para `notification_preferences.settings`

**Files:**
- Create: `supabase/migrations/20260601090550_notification_preferences_settings_validator.sql`
- Create: `supabase/tests/notification_preferences_settings_validator_test.sql`

**Contexto**: el column `settings jsonb` puede contener cualquier basura sin esta validación. Definimos schema explícito y lo aplicamos como CHECK constraint via `app.validate_jsonschema` (Paso 0 Task 0.1).

- [ ] **Step 1: pgTAP test (escribir primero, debe fallar)**

```sql
-- supabase/tests/notification_preferences_settings_validator_test.sql
BEGIN;
SELECT plan(4);

-- Setup tenant + user mínimo
insert into public.tenants (id, slug, name)
values ('00000000-0000-0000-0000-000000007301','np-tenant','NP Tenant');
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000007311','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','np@np.test',now(),'{}'::jsonb,'{}'::jsonb,now(),now());
insert into public.users (id, tenant_id, email, role, status)
values ('00000000-0000-0000-0000-000000007311','00000000-0000-0000-0000-000000007301',
  'np@np.test','member','active');

-- Caso valido
SELECT lives_ok(
  $$ insert into public.notification_preferences (user_id, tenant_id, kind, channel, settings)
     values ('00000000-0000-0000-0000-000000007311','00000000-0000-0000-0000-000000007301',
             'mention','in_app',
             '{"digest_frequency":"daily","muted":false}'::jsonb) $$,
  'settings con campos validos pasa CHECK');

-- Caso invalido — campo extra no permitido
SELECT throws_ok(
  $$ insert into public.notification_preferences (user_id, tenant_id, kind, channel, settings)
     values ('00000000-0000-0000-0000-000000007311','00000000-0000-0000-0000-000000007301',
             'mention','in_app',
             '{"digest_frequency":"daily","extra_field":"x"}'::jsonb) $$,
  '23514',
  null,
  'settings con campo extra falla CHECK');

-- Caso invalido — tipo incorrecto
SELECT throws_ok(
  $$ insert into public.notification_preferences (user_id, tenant_id, kind, channel, settings)
     values ('00000000-0000-0000-0000-000000007311','00000000-0000-0000-0000-000000007301',
             'mention','in_app',
             '{"digest_frequency":"daily","muted":"yes"}'::jsonb) $$,
  '23514',
  null,
  'settings con muted no-boolean falla CHECK');

-- Caso null permitido
SELECT lives_ok(
  $$ insert into public.notification_preferences (user_id, tenant_id, kind, channel, settings)
     values ('00000000-0000-0000-0000-000000007311','00000000-0000-0000-0000-000000007301',
             'access_request','in_app', null) $$,
  'settings null pasa CHECK');

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Migración**

```sql
-- supabase/migrations/20260601090550_notification_preferences_settings_validator.sql
-- CHECK constraint sobre notification_preferences.settings via pg_jsonschema.

alter table public.notification_preferences
  add constraint notification_preferences_settings_schema_chk
  check (
    app.validate_jsonschema(
      settings,
      jsonb_build_object(
        'type', 'object',
        'additionalProperties', false,
        'properties', jsonb_build_object(
          'digest_frequency', jsonb_build_object(
            'type', 'string',
            'enum', jsonb_build_array('immediate','hourly','daily','weekly','never')
          ),
          'muted', jsonb_build_object('type','boolean'),
          'muted_until', jsonb_build_object('type','string','format','date-time'),
          'quiet_hours_start', jsonb_build_object('type','string','pattern','^[0-2][0-9]:[0-5][0-9]$'),
          'quiet_hours_end', jsonb_build_object('type','string','pattern','^[0-2][0-9]:[0-5][0-9]$')
        )
      )
    )
  );

comment on constraint notification_preferences_settings_schema_chk
  on public.notification_preferences is
  'JSON Schema: digest_frequency enum, muted bool, quiet_hours HH:MM. additionalProperties=false.';
```

- [ ] **Step 3: Aplicar + correr test**

```bash
supabase db push
npm run test:db -- --test supabase/tests/notification_preferences_settings_validator_test.sql
```

Expected: 4/4 pasan.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260601090550_notification_preferences_settings_validator.sql supabase/tests/notification_preferences_settings_validator_test.sql
git commit -m "feat(db): jsonschema validator para notification_preferences.settings"
```

---

## Paso 8 · Migracion 045 · document_views
````

- [ ] **Step 3: Verificar inserción**

```bash
grep -c "^### Task 7\.3:" docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier2-multipliers.md
# Expected: 1
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier2-multipliers.md
git commit -m "docs(plan): tier2 Paso 7 Task 7.3 — jsonschema validator para notification_preferences.settings"
```

### Task B.4: Tier 2 — Agregar Task 12.3 (validator `saved_queries.filters`) en Paso 12

**Files:**
- Modify: `docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier2-multipliers.md`

**Contexto**: Paso 12 (línea 4224) crea `saved_queries` con `filters jsonb`. Agregamos Task 12.3 al final del Paso 12 (después de Task 12.2 en línea 4322).

- [ ] **Step 1: Localizar fin de Paso 12 / inicio de Paso 13**

```bash
grep -n "^## Paso 13 · " docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier2-multipliers.md
```

- [ ] **Step 2: Insertar Task 12.3 antes de "## Paso 13"**

Edit tool:

`old_string`:
```
---

## Paso 13 · Migracion 049.b · audit_log enriquecido
```

`new_string`:
````
### Task 12.3: Validator jsonschema para `saved_queries.filters`

**Files:**
- Create: `supabase/migrations/20260601091050_saved_queries_filters_validator.sql`
- Create: `supabase/tests/saved_queries_filters_validator_test.sql`

**Contexto**: `saved_queries.filters jsonb` define el alcance de la búsqueda (workspace_ids, collection_ids, tag slugs, fecha, kinds). Sin schema, un cliente con bug puede meter una lista anidada o un string donde debe ir array de UUIDs y romper `run_saved_query`. JSON Schema lock-in.

- [ ] **Step 1: pgTAP test**

```sql
-- supabase/tests/saved_queries_filters_validator_test.sql
BEGIN;
SELECT plan(5);

insert into public.tenants (id, slug, name)
values ('00000000-0000-0000-0000-000000012301','sqf-tenant','SQF Tenant');
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000012311','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','sqf@sqf.test',now(),'{}'::jsonb,'{}'::jsonb,now(),now());
insert into public.users (id, tenant_id, email, role, status)
values ('00000000-0000-0000-0000-000000012311','00000000-0000-0000-0000-000000012301',
  'sqf@sqf.test','member','active');

-- Valido
SELECT lives_ok(
  $$ insert into public.saved_queries
       (tenant_id, user_id, name, query, filters, notify_on_new_results)
     values ('00000000-0000-0000-0000-000000012301','00000000-0000-0000-0000-000000012311',
             'Normativa','normativa fiscal',
             '{"workspace_ids":["00000000-0000-0000-0000-000000000001"],"kinds":["document"]}'::jsonb,
             true) $$,
  'filters con workspace_ids y kinds pasa CHECK');

-- Tipo invalido — workspace_ids debe ser array de strings (UUID format)
SELECT throws_ok(
  $$ insert into public.saved_queries
       (tenant_id, user_id, name, query, filters, notify_on_new_results)
     values ('00000000-0000-0000-0000-000000012301','00000000-0000-0000-0000-000000012311',
             'Bad','bad',
             '{"workspace_ids":"not-an-array"}'::jsonb, true) $$,
  '23514', null,
  'workspace_ids como string falla');

-- Campo extra no permitido
SELECT throws_ok(
  $$ insert into public.saved_queries
       (tenant_id, user_id, name, query, filters, notify_on_new_results)
     values ('00000000-0000-0000-0000-000000012301','00000000-0000-0000-0000-000000012311',
             'Bad2','bad',
             '{"unknown_field":"x"}'::jsonb, true) $$,
  '23514', null,
  'campo extra falla CHECK');

-- Filters vacio permitido (todos los docs del tenant)
SELECT lives_ok(
  $$ insert into public.saved_queries
       (tenant_id, user_id, name, query, filters, notify_on_new_results)
     values ('00000000-0000-0000-0000-000000012301','00000000-0000-0000-0000-000000012311',
             'AllDocs','*', '{}'::jsonb, false) $$,
  'filters {} pasa CHECK');

-- date_after valido (ISO 8601)
SELECT lives_ok(
  $$ insert into public.saved_queries
       (tenant_id, user_id, name, query, filters, notify_on_new_results)
     values ('00000000-0000-0000-0000-000000012301','00000000-0000-0000-0000-000000012311',
             'Recent','recent',
             '{"date_after":"2026-01-01T00:00:00Z"}'::jsonb, false) $$,
  'date_after ISO pasa CHECK');

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 2: Migración**

```sql
-- supabase/migrations/20260601091050_saved_queries_filters_validator.sql
-- CHECK constraint sobre saved_queries.filters via pg_jsonschema.

alter table public.saved_queries
  add constraint saved_queries_filters_schema_chk
  check (
    app.validate_jsonschema(
      filters,
      jsonb_build_object(
        'type', 'object',
        'additionalProperties', false,
        'properties', jsonb_build_object(
          'workspace_ids', jsonb_build_object(
            'type','array',
            'items', jsonb_build_object('type','string','format','uuid')
          ),
          'collection_ids', jsonb_build_object(
            'type','array',
            'items', jsonb_build_object('type','string','format','uuid')
          ),
          'tag_slugs', jsonb_build_object(
            'type','array',
            'items', jsonb_build_object('type','string','minLength',1)
          ),
          'kinds', jsonb_build_object(
            'type','array',
            'items', jsonb_build_object(
              'type','string',
              'enum', jsonb_build_array('document','chunk','annotation')
            )
          ),
          'date_after', jsonb_build_object('type','string','format','date-time'),
          'date_before', jsonb_build_object('type','string','format','date-time'),
          'mode', jsonb_build_object(
            'type','string',
            'enum', jsonb_build_array('fts','trigram','embedding','hybrid')
          )
        )
      )
    )
  );

comment on constraint saved_queries_filters_schema_chk
  on public.saved_queries is
  'JSON Schema: workspace_ids/collection_ids arrays de UUID, kinds enum, dates ISO 8601, mode enum.';
```

- [ ] **Step 3: Aplicar + correr test**

```bash
supabase db push
npm run test:db -- --test supabase/tests/saved_queries_filters_validator_test.sql
```

Expected: 5/5 pasan.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260601091050_saved_queries_filters_validator.sql supabase/tests/saved_queries_filters_validator_test.sql
git commit -m "feat(db): jsonschema validator para saved_queries.filters"
```

---

## Paso 13 · Migracion 049.b · audit_log enriquecido
````

- [ ] **Step 3: Verificar inserción**

```bash
grep -c "^### Task 12\.3:" docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier2-multipliers.md
# Expected: 1
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier2-multipliers.md
git commit -m "docs(plan): tier2 Paso 12 Task 12.3 — jsonschema validator para saved_queries.filters"
```

### Task B.5: Tier 2 — Agregar Task 16.3 (audit `pg_trgm` usage) en Paso 16

**Files:**
- Modify: `docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier2-multipliers.md`

**Contexto**: Paso 16 implementa el worker `run-saved-queries`. Una vez que el worker corre en producción, podemos medir si los índices GIN trigram realmente se usan. Si `idx_scan = 0` después de N días, candidato a Tier 4 removal.

- [ ] **Step 1: Localizar fin de Paso 16 / inicio de Paso 17**

```bash
grep -n "^## Paso 17 · " docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier2-multipliers.md
```

- [ ] **Step 2: Insertar Task 16.3 antes de "## Paso 17"**

Edit tool:

`old_string`:
```
---

## Paso 17 · Documentacion
```

`new_string`:
````
### Task 16.3: Audit uso real de índices `pg_trgm` y FTS (gate para Tier 4)

**Files:**
- Modify: `docs/superpowers/plans/_evidence/2026-05-24-uuid-ossp-pg-trgm-audit.md`

**Contexto**: después de 2 semanas de Paso 3.b en producción, medir si los índices `chunks_content_trgm_idx` y `chunks_content_tsv_tenant_gin_idx` se usan. Si no, candidatos a remover en Tier 4.

- [ ] **Step 1: Query de uso real**

```bash
psql "$SUPABASE_DB_URL" <<'SQL'
select
  indexrelname as index,
  idx_scan,
  pg_size_pretty(pg_relation_size(indexrelid)) as size,
  case
    when idx_scan = 0 then 'CANDIDATO_REMOVER'
    when idx_scan < 100 then 'BAJO_USO'
    else 'USO_NORMAL'
  end as status
from pg_stat_user_indexes
where indexrelname in (
  'chunks_content_trgm_idx',
  'chunks_content_tsv_tenant_gin_idx'
)
order by idx_scan asc;
SQL
```

Expected: para que sea útil, este step se corre **2+ semanas después** del deploy de Paso 3.b en producción. Antes solo da ruido.

- [ ] **Step 2: Actualizar `2026-05-24-uuid-ossp-pg-trgm-audit.md`**

Agregar sección al final:

```markdown
## Re-audit post-Tier 2 Paso 16 (fecha: <ISO>)

| Índice | idx_scan | tamaño | status | decisión Tier 4 |
|---|---:|---|---|---|
| chunks_content_trgm_idx | <N> | <X> | <status> | <keep/remove> |
| chunks_content_tsv_tenant_gin_idx | <N> | <X> | <status> | <keep/remove> |

Si CANDIDATO_REMOVER: abrir mini-plan "Tier 4 cleanup pg_trgm/FTS".
Si BAJO_USO: dejar 2 semanas más y re-medir.
Si USO_NORMAL: cerrar audit, marcar resolved.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/_evidence/2026-05-24-uuid-ossp-pg-trgm-audit.md
git commit -m "docs(db): re-audit pg_trgm/FTS index usage post-Tier 2 Paso 16"
```

---

## Paso 17 · Documentacion
````

- [ ] **Step 3: Verificar**

```bash
grep -c "^### Task 16\.3:" docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier2-multipliers.md
# Expected: 1
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier2-multipliers.md
git commit -m "docs(plan): tier2 Paso 16 Task 16.3 — audit índices pg_trgm/FTS usage"
```

### Task B.6: Tier 2 — Update cifras + tier overview

**Files:**
- Modify: `docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier2-multipliers.md`

- [ ] **Step 1: Localizar tabla "Tier overview"**

```bash
sed -n '28,50p' docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier2-multipliers.md
```

- [ ] **Step 2: Update "Tier overview" — incluir Paso 0 + Paso 3.b**

El cambio exacto depende del contenido actual. Buscar la tabla con "Pasos" y "Migraciones" y agregar las filas faltantes. Si la sección es un párrafo en lugar de tabla, agregar referencia explícita a Paso 0 al final.

Edit tool — encontrar el texto y actualizar.

(Verificación manual: comparar `wc -l` antes y después.)

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier2-multipliers.md
git commit -m "docs(plan): tier2 update overview cifras (+Paso 0, +Paso 3.b, +Task 7.3, +Task 12.3, +Task 16.3)"
```

---

## Phase C · Tier 3 plan patches

> **Cuándo ejecutar**: antes de arrancar Tier 3. No depende de que Tier 2 esté ejecutado, pero las migraciones que describe sí asumen `pg_jsonschema` y `btree_gin` habilitadas (Tier 2 Paso 0).

### Task C.1: Tier 3 — Agregar Task 1.9 (helper `app.dispatch_inngest_event` + outbox) en Paso 1

**Files:**
- Modify: `docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier3-enterprise.md`

**Contexto**: Tier 3 actual ya implementa el patrón `pg_net` puntualmente en Task 5.4 (data exports). Lo refactoreamos a un helper reusable + tabla outbox que sirve como fallback determinista cuando `pg_net` no está disponible. Connectors (Paso 2 Task 2.6) y data exports (Paso 5 Task 5.4 modificada) lo consumen.

- [ ] **Step 1: Localizar fin de Paso 1 / inicio de Paso 2**

```bash
grep -n "^## Paso 2 · " docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier3-enterprise.md
```

Expected: línea ~1069.

- [ ] **Step 2: Insertar Task 1.9 antes de "## Paso 2"**

Edit tool:

`old_string`:
```
---

## Paso 2 · Connectors workers: OAuth callback + sync worker
```

`new_string`:
````
### Task 1.9: Helper `app.dispatch_inngest_event` + tabla outbox

**Files:**
- Create: `supabase/migrations/20260801123500_dispatch_inngest_event.sql`
- Create: `supabase/tests/dispatch_inngest_event_test.sql`

**Contexto**: hoy Task 5.4 inline-ea `pg_net.http_post` con fallback "depender del cron sweep". Lo formalizamos en un helper transversal que: (a) si `pg_net` está disponible hace HTTP POST con HMAC sig; (b) si no, escribe a `app.dispatch_outbox` que un cron sweep consume y reenvía. Consumido por connectors (Task 2.6) y data exports (Task 5.4 refactor).

- [ ] **Step 1: Migración**

```sql
-- supabase/migrations/20260801123500_dispatch_inngest_event.sql
-- Helper transversal para disparar eventos Inngest desde Postgres,
-- con fallback determinista via outbox + cron sweep.

-- Tabla outbox: filas que el sweep cron procesa si pg_net no disponible o falla.
create table if not exists app.dispatch_outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  event_name text not null,
  payload jsonb not null,
  signature text not null,
  endpoint_url text not null,
  attempts int not null default 0,
  status text not null default 'pending'
    check (status in ('pending','succeeded','failed','abandoned')),
  last_error text,
  created_at timestamptz not null default now(),
  next_attempt_at timestamptz not null default now(),
  succeeded_at timestamptz
);

create index if not exists dispatch_outbox_pending_idx
  on app.dispatch_outbox (next_attempt_at)
  where status = 'pending';

create index if not exists dispatch_outbox_tenant_idx
  on app.dispatch_outbox (tenant_id, status);

revoke all on app.dispatch_outbox from public, authenticated;

-- Helper: compone signature HMAC y dispatcha; si pg_net no esta, inserta a outbox.
create or replace function app.dispatch_inngest_event(
  _tenant_id uuid,
  _event_name text,
  _payload jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  _endpoint_url text;
  _signing_key text;
  _signature text;
  _outbox_id uuid;
  _pg_net_available boolean;
begin
  -- Config: leer desde GUCs propios (set por bootstrap del proyecto)
  _endpoint_url := coalesce(current_setting('app.inngest_endpoint_url', true), '');
  _signing_key  := coalesce(current_setting('app.inngest_signing_key', true), '');

  if _endpoint_url = '' or _signing_key = '' then
    raise exception 'app.inngest_endpoint_url / app.inngest_signing_key no configurados';
  end if;

  -- Signature HMAC-SHA256 (hex) del payload con la signing key
  _signature := encode(
    extensions.hmac(_payload::text::bytea, _signing_key::bytea, 'sha256'),
    'hex'
  );

  -- Outbox row siempre (audit + fallback)
  insert into app.dispatch_outbox
    (tenant_id, event_name, payload, signature, endpoint_url)
  values
    (_tenant_id, _event_name, _payload, _signature, _endpoint_url)
  returning id into _outbox_id;

  -- Intentar pg_net si disponible
  select exists (
    select 1 from pg_extension where extname = 'pg_net'
  ) into _pg_net_available;

  if _pg_net_available then
    begin
      perform net.http_post(
        url := _endpoint_url,
        body := jsonb_build_object(
          'name', _event_name,
          'data', _payload,
          'ts', extract(epoch from now())::bigint
        ),
        headers := jsonb_build_object(
          'content-type', 'application/json',
          'x-inngest-signature', _signature,
          'x-dispatch-id', _outbox_id::text
        ),
        timeout_milliseconds := 5000
      );
      -- Marcar succeeded optimisticamente; el sweep verifica response real
      update app.dispatch_outbox
        set status = 'succeeded', succeeded_at = now()
        where id = _outbox_id;
    exception
      when others then
        update app.dispatch_outbox
          set last_error = sqlerrm,
              attempts = attempts + 1
          where id = _outbox_id;
        -- No rethrow: el sweep cron retira
    end;
  end if;

  return _outbox_id;
end;
$$;

revoke all on function app.dispatch_inngest_event(uuid, text, jsonb) from public;
grant execute on function app.dispatch_inngest_event(uuid, text, jsonb) to service_role;

-- Sweep cron: re-intenta filas pending o failed con next_attempt_at <= now
create or replace function app.dispatch_outbox_sweep()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  _row record;
  _processed int := 0;
  _pg_net_available boolean;
begin
  select exists (select 1 from pg_extension where extname = 'pg_net') into _pg_net_available;

  for _row in
    select * from app.dispatch_outbox
    where status = 'pending'
      and next_attempt_at <= now()
      and attempts < 5
    order by created_at
    limit 100
  loop
    if _pg_net_available then
      begin
        perform net.http_post(
          url := _row.endpoint_url,
          body := jsonb_build_object('name', _row.event_name, 'data', _row.payload),
          headers := jsonb_build_object(
            'content-type','application/json',
            'x-inngest-signature', _row.signature,
            'x-dispatch-id', _row.id::text
          ),
          timeout_milliseconds := 5000
        );
        update app.dispatch_outbox
          set status = 'succeeded', succeeded_at = now()
          where id = _row.id;
      exception when others then
        update app.dispatch_outbox
          set attempts = attempts + 1,
              last_error = sqlerrm,
              next_attempt_at = now() + (interval '1 minute' * power(2, attempts))
          where id = _row.id;
      end;
    end if;
    _processed := _processed + 1;
  end loop;

  -- Marcar abandoned los que excedieron retries
  update app.dispatch_outbox
    set status = 'abandoned'
    where status = 'pending' and attempts >= 5;

  return _processed;
end;
$$;

revoke all on function app.dispatch_outbox_sweep() from public;
grant execute on function app.dispatch_outbox_sweep() to service_role;

-- Schedule sweep cada 1 min via pg_cron (patrón defensivo idéntico al de
-- 20260521170000_db_caching_retrieval_ops.sql)
do $$
declare
  cron_schema text;
begin
  select namespace.nspname
  into cron_schema
  from pg_namespace namespace
  where namespace.nspname in ('cron', 'extensions', 'pg_catalog')
    and to_regprocedure(format('%I.schedule(text,text,text)', namespace.nspname)) is not null
  order by case namespace.nspname when 'cron' then 1 when 'extensions' then 2 else 3 end
  limit 1;

  if cron_schema is not null then
    begin
      execute format('select %I.unschedule(%L)', cron_schema, 'sda-dispatch-outbox-sweep');
    exception when others then null;
    end;
    begin
      execute format(
        'select %I.schedule(%L, %L, %L)',
        cron_schema,
        'sda-dispatch-outbox-sweep',
        '*/1 * * * *',
        'select app.dispatch_outbox_sweep();'
      );
    exception when others then
      raise notice 'No se pudo programar dispatch_outbox_sweep: %', sqlerrm;
    end;
  end if;
end;
$$;
```

- [ ] **Step 2: pgTAP test**

```sql
-- supabase/tests/dispatch_inngest_event_test.sql
BEGIN;
SELECT plan(6);

SELECT has_function('app','dispatch_inngest_event',
  ARRAY['uuid','text','jsonb'], 'helper existe');
SELECT has_function('app','dispatch_outbox_sweep',
  ARRAY[]::text[], 'sweep existe');
SELECT has_table('app','dispatch_outbox','tabla outbox existe');

-- Setup GUCs ficticios
SELECT set_config('app.inngest_endpoint_url', 'https://example.test/x', true);
SELECT set_config('app.inngest_signing_key', 'test-key-1234', true);
SELECT set_config('role', 'service_role', true);

-- Disparar evento
SELECT isnt(
  app.dispatch_inngest_event(
    '00000000-0000-0000-0000-000000019001'::uuid,
    'test.event',
    '{"hello":"world"}'::jsonb
  ),
  null,
  'dispatch retorna uuid del outbox row'
);

SELECT is(
  (select count(*)::int from app.dispatch_outbox
   where event_name = 'test.event'),
  1,
  'fila escrita a outbox'
);

-- Verificar signature no vacia
SELECT isnt(
  (select signature from app.dispatch_outbox
   where event_name = 'test.event' limit 1),
  '',
  'signature HMAC presente'
);

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 3: Aplicar + correr test**

```bash
supabase db push
npm run test:db -- --test supabase/tests/dispatch_inngest_event_test.sql
```

Expected: 6/6.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260801123500_dispatch_inngest_event.sql supabase/tests/dispatch_inngest_event_test.sql
git commit -m "feat(db): app.dispatch_inngest_event helper + outbox pattern (pg_net + sweep fallback)"
```

---

## Paso 2 · Connectors workers: OAuth callback + sync worker
````

- [ ] **Step 3: Verificar**

```bash
grep -c "^### Task 1\.9:" docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier3-enterprise.md
# Expected: 1
grep -c "dispatch_inngest_event" docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier3-enterprise.md
# Expected: >= 5 (referencias en otras tasks)
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier3-enterprise.md
git commit -m "docs(plan): tier3 Paso 1 Task 1.9 — app.dispatch_inngest_event helper + outbox"
```

### Task C.2: Tier 3 — Agregar Task 1.10 (validators jsonschema connectors) en Paso 1

**Files:**
- Modify: `docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier3-enterprise.md`

**Contexto**: agregar validators a `tenant_oauth_credentials.config` y `document_sources.config` (ambos jsonb). Validar shape específica por provider (`google_drive`, `microsoft_365`).

- [ ] **Step 1: Insertar Task 1.10 inmediatamente después de Task 1.9**

Edit tool:

`old_string`:
```
git commit -m "feat(db): app.dispatch_inngest_event helper + outbox pattern (pg_net + sweep fallback)"
```
```

(NOTA: el `old_string` debe ser el último commit de Task 1.9 + el separador. Usar contexto único.)

`new_string` agrega Task 1.10 después:

````
git commit -m "feat(db): app.dispatch_inngest_event helper + outbox pattern (pg_net + sweep fallback)"
```

### Task 1.10: Validators jsonschema para `tenant_oauth_credentials.config` y `document_sources.config`

**Files:**
- Create: `supabase/migrations/20260801123600_connectors_jsonschema_validators.sql`
- Create: `supabase/tests/connectors_jsonschema_validators_test.sql`

**Contexto**: ambas tablas tienen una columna `config jsonb` cuyo contenido depende del provider. Sin validation, un connector mal configurado falla silenciosamente y solo se nota cuando el worker intenta sync. Lock-in del shape.

- [ ] **Step 1: Migración**

```sql
-- supabase/migrations/20260801123600_connectors_jsonschema_validators.sql

-- Helper para construir el schema de tenant_oauth_credentials.config segun provider
create or replace function app.oauth_credentials_config_schema()
returns jsonb
language sql
immutable
parallel safe
as $$
  select jsonb_build_object(
    'type','object',
    'required', jsonb_build_array('provider'),
    'oneOf', jsonb_build_array(
      jsonb_build_object(
        'properties', jsonb_build_object(
          'provider', jsonb_build_object('const','google_drive'),
          'scopes', jsonb_build_object('type','array','items',jsonb_build_object('type','string')),
          'redirect_uri', jsonb_build_object('type','string','format','uri'),
          'drive_id', jsonb_build_object('type','string')
        ),
        'required', jsonb_build_array('provider','scopes','redirect_uri'),
        'additionalProperties', false
      ),
      jsonb_build_object(
        'properties', jsonb_build_object(
          'provider', jsonb_build_object('const','microsoft_365'),
          'scopes', jsonb_build_object('type','array','items',jsonb_build_object('type','string')),
          'redirect_uri', jsonb_build_object('type','string','format','uri'),
          'tenant_id', jsonb_build_object('type','string')
        ),
        'required', jsonb_build_array('provider','scopes','redirect_uri'),
        'additionalProperties', false
      )
    )
  );
$$;

alter table public.tenant_oauth_credentials
  add constraint tenant_oauth_credentials_config_schema_chk
  check (app.validate_jsonschema(config, app.oauth_credentials_config_schema()));

-- Schema de document_sources.config
create or replace function app.document_sources_config_schema()
returns jsonb
language sql
immutable
parallel safe
as $$
  select jsonb_build_object(
    'type','object',
    'additionalProperties', false,
    'properties', jsonb_build_object(
      'root_folder_id', jsonb_build_object('type','string'),
      'include_subfolders', jsonb_build_object('type','boolean'),
      'mime_filters', jsonb_build_object(
        'type','array',
        'items', jsonb_build_object('type','string')
      ),
      'max_file_size_mb', jsonb_build_object('type','integer','minimum',1,'maximum',5000),
      'sync_interval_minutes', jsonb_build_object('type','integer','minimum',5,'maximum',1440)
    )
  );
$$;

alter table public.document_sources
  add constraint document_sources_config_schema_chk
  check (app.validate_jsonschema(config, app.document_sources_config_schema()));
```

- [ ] **Step 2: pgTAP test**

```sql
-- supabase/tests/connectors_jsonschema_validators_test.sql
BEGIN;
SELECT plan(6);

-- Setup minimo
insert into public.tenants (id, slug, name)
values ('00000000-0000-0000-0000-000000110001','ck-tenant','CK Tenant');

-- Google Drive valido
SELECT lives_ok(
  $$ insert into public.tenant_oauth_credentials
       (tenant_id, provider, status, config, encrypted_payload_ref)
     values ('00000000-0000-0000-0000-000000110001','google_drive','pending',
             '{"provider":"google_drive","scopes":["drive.readonly"],"redirect_uri":"https://app.test/oauth/callback"}'::jsonb,
             'vault-ref-1') $$,
  'google_drive config valida pasa');

-- MS 365 valido
SELECT lives_ok(
  $$ insert into public.tenant_oauth_credentials
       (tenant_id, provider, status, config, encrypted_payload_ref)
     values ('00000000-0000-0000-0000-000000110001','microsoft_365','pending',
             '{"provider":"microsoft_365","scopes":["Files.Read"],"redirect_uri":"https://app.test/oauth/callback","tenant_id":"common"}'::jsonb,
             'vault-ref-2') $$,
  'microsoft_365 config valida pasa');

-- Provider mismatch (config dice google_drive pero falta scopes)
SELECT throws_ok(
  $$ insert into public.tenant_oauth_credentials
       (tenant_id, provider, status, config, encrypted_payload_ref)
     values ('00000000-0000-0000-0000-000000110001','google_drive','pending',
             '{"provider":"google_drive","redirect_uri":"https://app.test/cb"}'::jsonb,
             'vault-ref-3') $$,
  '23514', null,
  'config sin scopes falla');

-- document_sources valido
SELECT lives_ok(
  $$ insert into public.document_sources
       (id, tenant_id, source_name, provider, config, status)
     values (gen_random_uuid(),'00000000-0000-0000-0000-000000110001','Drive Folder X','google_drive',
             '{"root_folder_id":"abc","include_subfolders":true,"max_file_size_mb":100}'::jsonb,
             'active') $$,
  'document_sources config valida pasa');

-- document_sources invalido (sync_interval muy bajo)
SELECT throws_ok(
  $$ insert into public.document_sources
       (id, tenant_id, source_name, provider, config, status)
     values (gen_random_uuid(),'00000000-0000-0000-0000-000000110001','Bad','google_drive',
             '{"sync_interval_minutes":1}'::jsonb,'active') $$,
  '23514', null,
  'sync_interval_minutes < 5 falla');

-- document_sources invalido (campo extra)
SELECT throws_ok(
  $$ insert into public.document_sources
       (id, tenant_id, source_name, provider, config, status)
     values (gen_random_uuid(),'00000000-0000-0000-0000-000000110001','Bad2','google_drive',
             '{"unknown_field":"x"}'::jsonb,'active') $$,
  '23514', null,
  'campo extra falla');

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 3: Aplicar + correr test**

```bash
supabase db push
npm run test:db -- --test supabase/tests/connectors_jsonschema_validators_test.sql
```

Expected: 6/6.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260801123600_connectors_jsonschema_validators.sql supabase/tests/connectors_jsonschema_validators_test.sql
git commit -m "feat(db): jsonschema validators para tenant_oauth_credentials + document_sources configs"
```

---

## Paso 2 · Connectors workers: OAuth callback + sync worker
````

- [ ] **Step 2: Verificar**

```bash
grep -c "^### Task 1\.10:" docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier3-enterprise.md
# Expected: 1
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier3-enterprise.md
git commit -m "docs(plan): tier3 Paso 1 Task 1.10 — jsonschema validators connectors"
```

### Task C.3: Tier 3 — Agregar Task 2.6 (trigger dispatch sync inicial) en Paso 2

**Files:**
- Modify: `docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier3-enterprise.md`

**Contexto**: hoy, cuando `tenant_oauth_credentials.status` pasa a `connected`, nada dispara el sync inicial — depende del cron periódico del worker. Esto introduce latencia de hasta el intervalo de polling. Con el helper Task 1.9 disponible, podemos disparar inmediatamente.

- [ ] **Step 1: Localizar fin de Paso 2 / inicio de Paso 3**

```bash
grep -n "^## Paso 3 · " docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier3-enterprise.md
```

- [ ] **Step 2: Insertar Task 2.6 antes de "## Paso 3"**

Edit tool:

`old_string`:
```
---

## Paso 3 · Usage records + aggregations + threshold notification
```

`new_string`:
````
### Task 2.6: Trigger dispatch sync inicial al conectar credentials

**Files:**
- Create: `supabase/migrations/20260801125000_connector_sync_initial_trigger.sql`
- Create: `supabase/tests/connector_sync_initial_trigger_test.sql`

**Contexto**: cuando `tenant_oauth_credentials.status` transita a `connected`, queremos disparar `connector.sync_initial` al worker Inngest **inmediatamente** vía `app.dispatch_inngest_event` (Task 1.9). Sin esto, el primer sync espera hasta el próximo tick del cron de Paso 2 Task 2.5.

- [ ] **Step 1: Migración**

```sql
-- supabase/migrations/20260801125000_connector_sync_initial_trigger.sql

create or replace function app.dispatch_connector_sync_initial()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'connected' and (old.status is null or old.status <> 'connected') then
    perform app.dispatch_inngest_event(
      new.tenant_id,
      'connector.sync_initial',
      jsonb_build_object(
        'credential_id', new.id,
        'provider', new.provider,
        'connected_at', extract(epoch from now())::bigint
      )
    );
  end if;
  return new;
end;
$$;

drop trigger if exists tenant_oauth_credentials_dispatch_sync_initial
  on public.tenant_oauth_credentials;

create trigger tenant_oauth_credentials_dispatch_sync_initial
  after insert or update of status on public.tenant_oauth_credentials
  for each row
  execute function app.dispatch_connector_sync_initial();

comment on trigger tenant_oauth_credentials_dispatch_sync_initial
  on public.tenant_oauth_credentials is
  'Cuando status pasa a connected, dispara connector.sync_initial vía dispatch_inngest_event (pg_net o outbox fallback).';
```

- [ ] **Step 2: Test**

```sql
-- supabase/tests/connector_sync_initial_trigger_test.sql
BEGIN;
SELECT plan(4);

SELECT has_function('app','dispatch_connector_sync_initial',
  ARRAY[]::text[], 'function existe');
SELECT has_trigger('public','tenant_oauth_credentials',
  'tenant_oauth_credentials_dispatch_sync_initial','trigger existe');

-- Setup GUCs para que dispatch funcione
SELECT set_config('app.inngest_endpoint_url','https://example.test/x',true);
SELECT set_config('app.inngest_signing_key','test-key',true);

insert into public.tenants (id, slug, name)
values ('00000000-0000-0000-0000-000000026001','st-tenant','ST Tenant');

-- Insert con status='pending' NO dispara
insert into public.tenant_oauth_credentials
  (tenant_id, provider, status, config, encrypted_payload_ref)
values ('00000000-0000-0000-0000-000000026001','google_drive','pending',
        '{"provider":"google_drive","scopes":["drive.readonly"],"redirect_uri":"https://x.test/cb"}'::jsonb,
        'vref');

SELECT is(
  (select count(*)::int from app.dispatch_outbox where event_name = 'connector.sync_initial'),
  0,
  'status=pending no dispara'
);

-- Update a connected dispara
update public.tenant_oauth_credentials
  set status = 'connected'
  where tenant_id = '00000000-0000-0000-0000-000000026001';

SELECT is(
  (select count(*)::int from app.dispatch_outbox where event_name = 'connector.sync_initial'),
  1,
  'status -> connected dispara 1 evento'
);

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 3: Aplicar + correr**

```bash
supabase db push
npm run test:db -- --test supabase/tests/connector_sync_initial_trigger_test.sql
```

Expected: 4/4.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260801125000_connector_sync_initial_trigger.sql supabase/tests/connector_sync_initial_trigger_test.sql
git commit -m "feat(db): trigger connector.sync_initial al transitar credentials a connected"
```

---

## Paso 3 · Usage records + aggregations + threshold notification
````

- [ ] **Step 3: Verificar**

```bash
grep -c "^### Task 2\.6:" docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier3-enterprise.md
# Expected: 1
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier3-enterprise.md
git commit -m "docs(plan): tier3 Paso 2 Task 2.6 — trigger dispatch sync inicial al conectar credentials"
```

### Task C.4: Tier 3 — Refactor Task 5.4 (data_exports) a consumir `app.dispatch_inngest_event`

**Files:**
- Modify: `docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier3-enterprise.md`

**Contexto**: Task 5.4 actual (línea 3533) implementa el patrón `pg_net` inline con fallback "depender del cron sweep". Lo reemplazamos por una llamada al helper `app.dispatch_inngest_event` (Task 1.9). Más simple, mismo comportamiento.

- [ ] **Step 1: Leer Task 5.4 actual**

```bash
sed -n '3533,3548p' docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier3-enterprise.md
```

- [ ] **Step 2: Reemplazar contenido de Task 5.4**

Edit tool:

`old_string`:
```
### Task 5.4: Trigger DB-side que dispara evento Inngest al insertar

> Patron: usamos `pg_net.http_post` para llamar al endpoint Inngest. Como esto puede no estar disponible, dejamos como FALLBACK el sweep cron del paso anterior. Documentamos.

- [ ] **Step 1: Verificar disponibilidad de pg_net**

```bash
psql "$SUPABASE_DB_URL" -c "select 1 from pg_extension where extname='pg_net'"
```

Expected: 1 si esta. Si esta, agregamos trigger; si no, dependemos solo del cron sweep cada 5 min.

- [ ] **Step 2 (opcional, solo si pg_net disponible): trigger DB-side**

Si pg_net no esta disponible, skipear esta task. El cron del Task 5.3 ya cubre el caso.
```

`new_string`:
````
### Task 5.4: Trigger DB-side que dispara evento Inngest al insertar (vía helper Paso 1)

> **Refactor 2026-05-24**: ahora consume `app.dispatch_inngest_event` (Tier 3 Paso 1 Task 1.9). El helper centraliza el patrón `pg_net` + outbox fallback, así que esta task ya no inline-ea HTTP. Si pg_net no está disponible, el outbox sweep cron (Paso 1 Task 1.9 — `sda-dispatch-outbox-sweep` cada 1 min) procesa el dispatch en su lugar.

**Files:**
- Create: `supabase/migrations/20260801150500_data_exports_dispatch_trigger.sql`
- Create: `supabase/tests/data_exports_dispatch_trigger_test.sql`

- [ ] **Step 1: Migración del trigger**

```sql
-- supabase/migrations/20260801150500_data_exports_dispatch_trigger.sql

create or replace function app.dispatch_data_export_requested()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Solo al insertar con status='queued' (estado inicial del RPC request_data_export)
  if new.status = 'queued' then
    perform app.dispatch_inngest_event(
      new.tenant_id,
      'data_export.requested',
      jsonb_build_object(
        'export_id', new.id,
        'scope', new.scope::text,
        'requested_by', new.requested_by
      )
    );
  end if;
  return new;
end;
$$;

drop trigger if exists data_exports_dispatch_requested on public.data_exports;
create trigger data_exports_dispatch_requested
  after insert on public.data_exports
  for each row
  execute function app.dispatch_data_export_requested();

comment on trigger data_exports_dispatch_requested on public.data_exports is
  'Dispatcha data_export.requested al worker Inngest vía dispatch_inngest_event (pg_net + outbox fallback).';
```

- [ ] **Step 2: Test**

```sql
-- supabase/tests/data_exports_dispatch_trigger_test.sql
BEGIN;
SELECT plan(3);

SELECT has_function('app','dispatch_data_export_requested',
  ARRAY[]::text[], 'function existe');
SELECT has_trigger('public','data_exports','data_exports_dispatch_requested','trigger existe');

-- Setup GUCs + tenant
SELECT set_config('app.inngest_endpoint_url','https://example.test/x',true);
SELECT set_config('app.inngest_signing_key','test-key',true);

insert into public.tenants (id, slug, name)
values ('00000000-0000-0000-0000-000000054001','de-tenant','DE Tenant');
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000054011','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','de@de.test',now(),'{}'::jsonb,'{}'::jsonb,now(),now());
insert into public.users (id, tenant_id, email, role, status)
values ('00000000-0000-0000-0000-000000054011','00000000-0000-0000-0000-000000054001',
  'de@de.test','owner','active');

insert into public.data_exports (id, tenant_id, scope, status, requested_by)
values (gen_random_uuid(),'00000000-0000-0000-0000-000000054001','user'::public.data_export_scope,
        'queued','00000000-0000-0000-0000-000000054011');

SELECT is(
  (select count(*)::int from app.dispatch_outbox
   where event_name = 'data_export.requested'),
  1,
  'inserts con status=queued disparan 1 evento'
);

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 3: Aplicar + correr**

```bash
supabase db push
npm run test:db -- --test supabase/tests/data_exports_dispatch_trigger_test.sql
```

Expected: 3/3.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260801150500_data_exports_dispatch_trigger.sql supabase/tests/data_exports_dispatch_trigger_test.sql
git commit -m "feat(db): data_exports trigger via app.dispatch_inngest_event (refactor)"
```
````

- [ ] **Step 3: Verificar**

```bash
grep -c "Refactor 2026-05-24" docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier3-enterprise.md
# Expected: 1
grep "dispatch_inngest_event" docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier3-enterprise.md | wc -l
# Expected: > 0
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier3-enterprise.md
git commit -m "docs(plan): tier3 Task 5.4 refactor — consume app.dispatch_inngest_event helper"
```

### Task C.5: Tier 3 — Agregar Task 6.7 (btree_gin indexes en particionado) en Paso 6

**Files:**
- Modify: `docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier3-enterprise.md`

**Contexto**: Paso 6 particionado de `audit_log`, `indexing_events`, `document_views`, `notifications`. Es la oportunidad de agregar índices `btree_gin` compuestos para queries multi-tenant con predicados jsonb. Las particiones se crean ya con el índice y las nuevas heredan.

- [ ] **Step 1: Localizar fin de Paso 6 / inicio de Paso 7**

```bash
grep -n "^## Paso 7 · " docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier3-enterprise.md
```

- [ ] **Step 2: Insertar Task 6.7 antes de "## Paso 7"**

Edit tool:

`old_string`:
```
---

## Paso 7 · halfvec migration (dual-write window)
```

`new_string`:
````
### Task 6.7: Índices `btree_gin` compuestos en tablas particionadas

**Files:**
- Create: `supabase/migrations/20260801164500_partition_btree_gin_indexes.sql`
- Create: `supabase/tests/partition_btree_gin_indexes_test.sql`

**Contexto**: las tablas recién particionadas (`audit_log`, `indexing_events`, `notifications`, `document_views`) reciben queries multi-tenant con predicados sobre jsonb (`payload`, `metadata`, `properties`). Sin `btree_gin`, el planner combina dos índices separados — funcional pero caro. Con esto, un solo índice compuesto cubre el predicado mixto.

Requiere `btree_gin` activo (Tier 2 Paso 0 Task 0.2).

- [ ] **Step 1: Migración**

```sql
-- supabase/migrations/20260801164500_partition_btree_gin_indexes.sql
-- Indices compuestos (tenant_id uuid + jsonb_path_ops) en tablas particionadas.
-- Postgres propaga estos indices a todas las particiones (presentes y futuras).
-- NOTA: en tablas particionadas NO se usa CONCURRENTLY (Postgres lo prohibe);
-- el CREATE INDEX no-concurrente toma SHARE lock breve sobre el padre y construye
-- sin concurrencia en cada particion, aceptable en ventana de deploy.

-- audit_log.metadata
create index if not exists audit_log_tenant_metadata_gin_idx
  on public.audit_log
  using gin (tenant_id, metadata jsonb_path_ops);

-- indexing_events.payload
create index if not exists indexing_events_tenant_payload_gin_idx
  on public.indexing_events
  using gin (tenant_id, payload jsonb_path_ops);

-- notifications.metadata
create index if not exists notifications_tenant_metadata_gin_idx
  on public.notifications
  using gin (tenant_id, metadata jsonb_path_ops);

-- document_views.metadata
create index if not exists document_views_tenant_metadata_gin_idx
  on public.document_views
  using gin (tenant_id, metadata jsonb_path_ops);

comment on index public.audit_log_tenant_metadata_gin_idx is
  'btree_gin: tenant_id + metadata jsonb_path_ops para filtros mixtos audit.';
comment on index public.indexing_events_tenant_payload_gin_idx is
  'btree_gin: tenant_id + payload jsonb_path_ops para health/analytics queries.';
comment on index public.notifications_tenant_metadata_gin_idx is
  'btree_gin: tenant_id + metadata jsonb_path_ops para filtros de inbox.';
comment on index public.document_views_tenant_metadata_gin_idx is
  'btree_gin: tenant_id + metadata jsonb_path_ops para reporting views.';
```

> Verificado contra Task 6.1-6.5: `audit_log`, `notifications`, `document_views` usan `metadata`; `indexing_events` usa `payload`. Si Tier 1/2 cambia estos nombres, re-verificar antes de mergear.

- [ ] **Step 2: Test**

```sql
-- supabase/tests/partition_btree_gin_indexes_test.sql
BEGIN;
SELECT plan(4);

SELECT has_index('public','audit_log','audit_log_tenant_metadata_gin_idx','indice audit_log existe');
SELECT has_index('public','indexing_events','indexing_events_tenant_payload_gin_idx','indice indexing_events existe');
SELECT has_index('public','notifications','notifications_tenant_metadata_gin_idx','indice notifications existe');
SELECT has_index('public','document_views','document_views_tenant_metadata_gin_idx','indice document_views existe');

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 3: Aplicar + correr**

```bash
supabase db push
npm run test:db -- --test supabase/tests/partition_btree_gin_indexes_test.sql
```

Expected: 4/4.

- [ ] **Step 4: Verificar planner usa al menos uno**

```bash
psql "$SUPABASE_DB_URL" <<'SQL'
explain (format text)
select count(*)
from public.audit_log
where tenant_id = gen_random_uuid()
  and metadata @> '{"action":"document.created"}'::jsonb;
SQL
```

Expected: `Bitmap Index Scan on audit_log_tenant_metadata_gin_idx`. Si aparece `Seq Scan` puede ser dataset pequeño — re-verificar en staging con dataset real.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260801164500_partition_btree_gin_indexes.sql supabase/tests/partition_btree_gin_indexes_test.sql
git commit -m "feat(db): btree_gin compuestos (tenant_id + jsonb) en tablas particionadas Tier 3"
```

---

## Paso 7 · halfvec migration (dual-write window)
````

- [ ] **Step 3: Verificar**

```bash
grep -c "^### Task 6\.7:" docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier3-enterprise.md
# Expected: 1
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier3-enterprise.md
git commit -m "docs(plan): tier3 Paso 6 Task 6.7 — btree_gin indexes en tablas particionadas"
```

### Task C.6: Tier 3 — Reescribir Task 7.4 como 7.4.a (`search_chunks`) + 7.4.b (`search_tree_nodes_by_embedding`)

**Files:**
- Modify: `docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier3-enterprise.md`

**Contexto**: Task 7.4 actual dice "search RPCs en `lib/system-versions.json` o las migraciones que las definieron" sin enumerar específicamente cuáles. El master plan reconoce este gap. Lo cerramos partiendo Task 7.4 en dos tasks explícitas.

- [ ] **Step 1: Leer Task 7.4 actual (líneas 4429-4486)**

```bash
sed -n '4429,4490p' docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier3-enterprise.md
```

- [ ] **Step 2: Reemplazar Task 7.4 con 7.4.a + 7.4.b**

Edit tool. El `old_string` debe ser el bloque completo de Task 7.4 actual (desde `### Task 7.4: Switch RPCs ...` hasta justo antes de `### Task 7.5: Migracion swap final`):

`old_string` (resumen — el step 1 confirma el texto exacto):
```
### Task 7.4: Switch RPCs de search a usar `embedding_half`

**Files:**
- Modify: search RPCs en `lib/system-versions.json` o las migraciones que las definieron.

> Decision: durante la ventana, las RPCs de search leen `embedding_half` (FP16). Si no esta seteada todavia (rows viejas pre-backfill), fallback a `embedding`. Tras el swap del Paso 7.5 desaparece el fallback.
```

(continuar hasta el `### Task 7.5:` siguiente, copiar el bloque exacto del Step 1)

`new_string`:
````
### Task 7.4.a: Switch RPC `search_chunks` a leer `embedding_half`

**Files:**
- Create: `supabase/migrations/20260801170100_search_chunks_use_halfvec.sql`
- Create: `supabase/tests/search_chunks_use_halfvec_test.sql`

**Contexto**: `search_chunks` (definida en Tier 2 Paso 3 migración 040.b) acepta el modo `embedding` y `hybrid` que leen `chunks.embedding vector(1536)`. Durante la ventana dual-write debe leer `chunks.embedding_half halfvec(1536)` con fallback a `embedding` si halfvec es null (filas pre-backfill).

- [ ] **Step 1: Migración**

```sql
-- supabase/migrations/20260801170100_search_chunks_use_halfvec.sql
-- Re-escribir search_chunks para leer chunks.embedding_half con fallback a embedding.

create or replace function public.search_chunks(
  _query text,
  _query_embedding extensions.halfvec default null,
  _mode text default 'fts',
  _filters jsonb default '{}'::jsonb,
  _limit int default 10
)
returns table (
  chunk_id uuid,
  document_id uuid,
  content text,
  score float8,
  metadata jsonb
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  _tenant uuid := (select app.current_tenant_id());
begin
  return query
  select
    c.id as chunk_id,
    c.document_id,
    c.content,
    case _mode
      when 'fts' then ts_rank(c.content_tsv, websearch_to_tsquery('simple', _query))::float8
      when 'trigram' then extensions.similarity(c.content, _query)::float8
      when 'embedding' then (1 - (coalesce(c.embedding_half, c.embedding::extensions.halfvec) <=> _query_embedding))::float8
      when 'hybrid' then (
        coalesce(ts_rank(c.content_tsv, websearch_to_tsquery('simple', _query)), 0)
        + coalesce(extensions.similarity(c.content, _query), 0) * 0.4
        + case
            when _query_embedding is not null
            then (1 - (coalesce(c.embedding_half, c.embedding::extensions.halfvec) <=> _query_embedding)) * 0.6
            else 0
          end
      )::float8
      else 0::float8
    end as score,
    c.metadata
  from public.chunks c
  where c.tenant_id = _tenant
    and (
      (_mode = 'fts' and c.content_tsv @@ websearch_to_tsquery('simple', _query)) or
      (_mode = 'trigram' and c.content OPERATOR(extensions.%) _query) or
      (_mode in ('embedding','hybrid') and _query_embedding is not null) or
      (_mode = 'hybrid' and c.content_tsv @@ websearch_to_tsquery('simple', _query))
    )
  order by score desc
  limit greatest(coalesce(_limit, 10), 1);
end;
$$;

revoke all on function public.search_chunks(text, extensions.halfvec, text, jsonb, int) from public;
grant execute on function public.search_chunks(text, extensions.halfvec, text, jsonb, int) to authenticated, service_role;

comment on function public.search_chunks(text, extensions.halfvec, text, jsonb, int) is
  'Multi-mode search (fts/trigram/embedding/hybrid). Lee embedding_half con fallback a embedding durante ventana dual-write.';
```

- [ ] **Step 2: Test**

```sql
-- supabase/tests/search_chunks_use_halfvec_test.sql
BEGIN;
SELECT plan(3);

-- La firma cambio: 5 argumentos, incluyendo halfvec en posicion 2
SELECT has_function('public','search_chunks',
  ARRAY['text','extensions.halfvec','text','jsonb','integer'],
  'search_chunks acepta halfvec');

-- Verifica que la funcion compila y lee embedding_half (smoke)
SELECT lives_ok(
  $$ select * from public.search_chunks('test', null, 'fts', '{}'::jsonb, 5) $$,
  'invocacion modo fts sin embedding pasa');

SELECT lives_ok(
  $$ select * from public.search_chunks(
       'test',
       array_fill(0.0::real, ARRAY[1536])::extensions.halfvec,
       'embedding', '{}'::jsonb, 5) $$,
  'invocacion modo embedding con halfvec pasa');

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 3: Aplicar + correr**

```bash
supabase db push
npm run test:db -- --test supabase/tests/search_chunks_use_halfvec_test.sql
```

Expected: 3/3.

- [ ] **Step 4: Smoke con dataset real (staging)**

```bash
psql "$STAGING_DB_URL" <<'SQL'
select chunk_id, score
from public.search_chunks('contrato fiscal', null, 'fts', '{}'::jsonb, 5);
SQL
```

Expected: filas (no error). El modo embedding/hybrid require generar un embedding query del lado del worker.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260801170100_search_chunks_use_halfvec.sql supabase/tests/search_chunks_use_halfvec_test.sql
git commit -m "refactor(db): search_chunks lee embedding_half con fallback a embedding (halfvec dual-write)"
```

### Task 7.4.b: Switch RPC `search_tree_nodes_by_embedding` a leer `embedding_half`

**Files:**
- Create: `supabase/migrations/20260801170200_search_tree_nodes_use_halfvec.sql`
- Create: `supabase/tests/search_tree_nodes_use_halfvec_test.sql`

**Contexto**: `search_tree_nodes_by_embedding` (definida en Tier 2 Paso 3) hace KNN sobre `doc_tree_nodes.embedding`. Igual que 7.4.a, lee `embedding_half` con fallback.

- [ ] **Step 1: Migración**

```sql
-- supabase/migrations/20260801170200_search_tree_nodes_use_halfvec.sql

create or replace function public.search_tree_nodes_by_embedding(
  _embedding extensions.halfvec,
  _filters jsonb default '{}'::jsonb,
  _limit int default 10
)
returns table (
  node_id text,
  document_id uuid,
  score float8,
  title text,
  summary text
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  _tenant uuid := (select app.current_tenant_id());
begin
  return query
  select
    n.node_id,
    n.document_id,
    (1 - (coalesce(n.embedding_half, n.embedding::extensions.halfvec) <=> _embedding))::float8 as score,
    n.title,
    n.summary
  from public.doc_tree_nodes n
  where n.tenant_id = _tenant
    and (n.embedding_half is not null or n.embedding is not null)
  order by coalesce(n.embedding_half, n.embedding::extensions.halfvec) <=> _embedding
  limit greatest(coalesce(_limit, 10), 1);
end;
$$;

revoke all on function public.search_tree_nodes_by_embedding(extensions.halfvec, jsonb, int) from public;
grant execute on function public.search_tree_nodes_by_embedding(extensions.halfvec, jsonb, int) to authenticated, service_role;

comment on function public.search_tree_nodes_by_embedding(extensions.halfvec, jsonb, int) is
  'KNN sobre doc_tree_nodes. Lee embedding_half con fallback a embedding durante ventana dual-write.';
```

- [ ] **Step 2: Test**

```sql
-- supabase/tests/search_tree_nodes_use_halfvec_test.sql
BEGIN;
SELECT plan(2);

SELECT has_function('public','search_tree_nodes_by_embedding',
  ARRAY['extensions.halfvec','jsonb','integer'],
  'firma halfvec');

SELECT lives_ok(
  $$ select * from public.search_tree_nodes_by_embedding(
       array_fill(0.0::real, ARRAY[1536])::extensions.halfvec,
       '{}'::jsonb, 5) $$,
  'invocacion smoke pasa');

SELECT * FROM finish();
ROLLBACK;
```

- [ ] **Step 3: Aplicar + correr**

```bash
supabase db push
npm run test:db -- --test supabase/tests/search_tree_nodes_use_halfvec_test.sql
```

Expected: 2/2.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260801170200_search_tree_nodes_use_halfvec.sql supabase/tests/search_tree_nodes_use_halfvec_test.sql
git commit -m "refactor(db): search_tree_nodes_by_embedding lee embedding_half con fallback"
```

> Tras 7.4.a y 7.4.b, las dos RPCs principales de búsqueda vectorial leen halfvec con fallback. Cuando Task 7.5 (+7d) haga el swap final, las RPCs no requieren cambio adicional — el `coalesce(n.embedding_half, n.embedding)` se vuelve no-op una vez que `embedding_half` está poblado en 100% y la columna `embedding` antigua se dropea.

````

- [ ] **Step 3: Verificar**

```bash
grep -c "^### Task 7\.4\.a:" docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier3-enterprise.md
# Expected: 1
grep -c "^### Task 7\.4\.b:" docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier3-enterprise.md
# Expected: 1
grep -c "^### Task 7\.4:" docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier3-enterprise.md
# Expected: 0 (la original ya no existe)
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier3-enterprise.md
git commit -m "docs(plan): tier3 Task 7.4 split into 7.4.a (search_chunks) + 7.4.b (search_tree_nodes) — closes gap"
```

### Task C.7: Tier 3 — Update Migration order table + tier overview

**Files:**
- Modify: `docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier3-enterprise.md`

**Contexto**: agregar las 5 nuevas migraciones del Tier 3 a la tabla "Migration order" (línea 62-82):
- `20260801123500_dispatch_inngest_event.sql` (Task 1.9)
- `20260801123600_connectors_jsonschema_validators.sql` (Task 1.10)
- `20260801125000_connector_sync_initial_trigger.sql` (Task 2.6)
- `20260801150500_data_exports_dispatch_trigger.sql` (Task 5.4 refactor)
- `20260801164500_partition_btree_gin_indexes.sql` (Task 6.7)
- `20260801170100_search_chunks_use_halfvec.sql` (Task 7.4.a)
- `20260801170200_search_tree_nodes_use_halfvec.sql` (Task 7.4.b)

- [ ] **Step 1: Leer tabla actual**

```bash
sed -n '62,90p' docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier3-enterprise.md
```

- [ ] **Step 2: Reemplazar tabla con nuevas filas insertadas en orden cronológico**

Edit tool. `old_string` debe ser la tabla completa actual. `new_string` la tabla con las 7 filas extras intercaladas en posición correcta por timestamp:

Insertar:
- Después de fila 4 (`20260801123000_connectors_rpcs.sql`): filas para `123500` y `123600`.
- Después de fila 4.2 (lo de arriba): para `125000` (sync_initial_trigger).
- Después de fila 9 (`20260801150000_data_exports.sql`): para `150500` (data_exports_dispatch_trigger).
- Después de fila 14 (`20260801164000_partition_maintenance.sql`): para `164500` (partition_btree_gin_indexes).
- Después de fila 15 (`20260801170000_halfvec_dual_write.sql`): para `170100` y `170200` (search RPCs use halfvec).

Renumerar todas las filas para que el campo "Orden" siga incrementando.

- [ ] **Step 3: Verificar**

```bash
grep -c "dispatch_inngest_event.sql\|connectors_jsonschema_validators.sql\|connector_sync_initial_trigger.sql\|data_exports_dispatch_trigger.sql\|partition_btree_gin_indexes.sql\|search_chunks_use_halfvec.sql\|search_tree_nodes_use_halfvec.sql" \
  docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier3-enterprise.md
# Expected: 7 (uno por cada nueva migración mencionada en la tabla)
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier3-enterprise.md
git commit -m "docs(plan): tier3 update Migration order table (+7 nuevas migraciones)"
```

---

## Estados de salida del meta-plan

Tras completar las 16 tasks de las 3 phases:

- [ ] Phase A:
  - `docs/superpowers/plans/2026-05-22-supabase-multitenant-platform.md` contiene sección "Tier 4 candidates" y cifras actualizadas.
  - `docs/db-extensions.md` existe con inventario inicial.
  - `docs/db-tuning.md` existe con workflow hypopg.
  - 3 commits con tipo `docs(...)`.
- [ ] Phase B:
  - Tier 2 plan contiene `## Paso 0 · DB platform foundation` y 3 tasks dentro.
  - Tier 2 plan contiene `## Paso 3.b · Migracion 040.c · Indices GIN para search_chunks`.
  - Tier 2 plan contiene `### Task 7.3` (validator notification_preferences.settings).
  - Tier 2 plan contiene `### Task 12.3` (validator saved_queries.filters).
  - Tier 2 plan contiene `### Task 16.3` (audit pg_trgm usage).
  - Migration order de Tier 2 incluye `enable_pg_jsonschema`, `enable_btree_gin`, `search_indexes_gin`.
  - 6 commits con tipo `docs(plan): tier2 ...`.
- [ ] Phase C:
  - Tier 3 plan contiene `### Task 1.9` (helper dispatch + outbox), `### Task 1.10` (jsonschema connectors).
  - Tier 3 plan contiene `### Task 2.6` (trigger sync_initial).
  - Task 5.4 original reemplazada por versión que consume `app.dispatch_inngest_event`.
  - Tier 3 plan contiene `### Task 6.7` (btree_gin particionado).
  - Tier 3 plan contiene `### Task 7.4.a` y `### Task 7.4.b`; original `### Task 7.4` ya no aparece.
  - Migration order de Tier 3 incluye las 7 nuevas migraciones.
  - 7 commits con tipo `docs(plan): tier3 ...`.

**Comandos de verificación final**:

```bash
# Phase A
grep -c "Tier 4 candidates" docs/superpowers/plans/2026-05-22-supabase-multitenant-platform.md
# Expected: 1
test -f docs/db-extensions.md && test -f docs/db-tuning.md && echo OK

# Phase B
grep -c "^## Paso 0 · DB platform foundation\|^## Paso 3\.b" \
  docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier2-multipliers.md
# Expected: 2
grep -c "^### Task 7\.3:\|^### Task 12\.3:\|^### Task 16\.3:" \
  docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier2-multipliers.md
# Expected: 3

# Phase C
grep -c "^### Task 1\.9:\|^### Task 1\.10:\|^### Task 2\.6:\|^### Task 6\.7:\|^### Task 7\.4\.a:\|^### Task 7\.4\.b:" \
  docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier3-enterprise.md
# Expected: 6
grep -c "^### Task 7\.4:" \
  docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier3-enterprise.md
# Expected: 0 (Task 7.4 original reemplazada)
```

---

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| `pg_jsonschema` no disponible en plan Supabase del proyecto | Phase B Task B.1 Task 0.1 falla con `extension not available`; abrir ticket Supabase y diferir Phase B hasta resolverlo. |
| `btree_gin` no disponible | Mismo patrón. Las migraciones que dependen (3.b, 6.7) quedan bloqueadas pero el resto avanza. |
| `pg_net` no disponible en el proyecto | El helper `app.dispatch_inngest_event` (Task 1.9) maneja el caso: si la extensión no está, escribe a outbox y el sweep cron de 1 min lo procesa. Latencia ~1 min vs ~0s con pg_net, pero funcional. |
| `CREATE INDEX CONCURRENTLY` falla por lock conflict en producción | Re-correr la migración; `CONCURRENTLY` es retry-safe (deja índice en estado `INVALID` si falla, dropear con `DROP INDEX` y re-correr). |
| El executor de Tier 2/3 no respeta el orden de `Migration order` | Cada migración nueva referencia su dependencia en el comentario superior (ej. "requiere `app.validate_jsonschema` de Paso 0"). Si el orden se rompe, la migración falla con `function does not exist`. |
| El `old_string` del Edit tool no coincide exactamente con el texto actual del plan | Cada task tiene Step 1 que lee el contexto antes de editar. Si el texto cambió, ajustar manualmente; el plan no se rompe. |

---

## Self-review

**1. Spec coverage** (chequeo contra el análisis original que dio origen al plan):

- ✅ `pg_jsonschema` enabled (B.1 Task 0.1) + 3 validators (B.3, B.4, C.2 ×2) — 4 validators totales, mismo count que el análisis prometió.
- ✅ `btree_gin` enabled (B.1 Task 0.2) + 2 grupos de índices (B.2 Tier 2 search, C.5 Tier 3 particionado) — match.
- ✅ Helper `pg_net` con outbox fallback (C.1) consumido por trigger connectors (C.3), refactor data_exports (C.4) — match.
- ✅ Halfvec Task 7.4 split en 7.4.a + 7.4.b (C.6) — cierra gap del master plan.
- ✅ `pg_trgm` index agregado (B.2) + audit task post-deploy (B.5) — match.
- ✅ `uuid-ossp` audit (B.1 Task 0.3) — match.
- ✅ Master plan: Tier 4 candidates + cifras + gap closure (A.1) — match.
- ✅ Docs nuevos: db-extensions.md + db-tuning.md (A.2, A.3) — match.
- ⚠️ Task B.6 "update tier2 overview cifras" tiene Step 2 con instrucción genérica "encontrar el texto y actualizar". No es placeholder per-se (es operación de mantenimiento de cifras) pero podría ser más específico. Aceptable: el Step 1 hace la lectura precisa antes del Edit.

**2. Placeholder scan**:

- ✅ Búsqueda manual de "TBD", "TODO", "implement later" en el plan: ninguna instancia.
- ✅ Búsqueda de "Similar to Task N": ninguna instancia — cada task tiene contenido completo.
- ⚠️ Task C.7 Step 2 dice "Edit tool. `old_string` debe ser la tabla completa actual. `new_string` la tabla con las 7 filas extras intercaladas en posición correcta por timestamp" — esto es una instrucción de patrón, no código exacto. Razonable porque la tabla actual es grande (~20 filas) y reproducirla aquí es ruido; el executor lee + edita por orden. Aceptable.

**3. Type consistency**:

- ✅ `app.validate_jsonschema(_value jsonb, _schema jsonb) returns boolean` — usado consistentemente en Tasks 0.1, 7.3, 12.3, 1.10.
- ✅ `app.dispatch_inngest_event(_tenant_id uuid, _event_name text, _payload jsonb) returns uuid` — firma definida en Task 1.9, consumida idéntica en Tasks 2.6 y 5.4 refactor.
- ✅ `extensions.halfvec(1536)` — tipo halfvec consistente en Tasks 7.4.a y 7.4.b.
- ✅ Nombres de extensiones siempre `pg_jsonschema`, `btree_gin`, `pg_net`, `pg_trgm`, `halfvec` — sin variantes.

**4. Cifras del master plan post-restructure**:

- Tier 2: 6119 → ~6800 LOC, 18 → 19 Pasos (Paso 0 nuevo), 44 → ~50 tasks, 14 → 17 migraciones. Confirmar con `wc -l` después de Phase B.
- Tier 3: 5407 → ~6300 LOC, 8 Pasos (sin nuevos pasos), 51 → ~57 tasks, 19 → 21 migraciones (efectivamente +7 migraciones — corregir cifra en Task A.1 Step 2: 19 → 26). 

⚠️ **Fix inline**: la cifra de migraciones Tier 3 debe ser 26, no 21. Ver Task A.1 Step 2.

(Corrección aplicada inline en este self-review.)

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-24-db-extensions-tier2-tier3-restructure.md`.**

**Recommendation:** ejecutar en orden A → B → C. Phase A (3 tasks) puede mergearse en cualquier momento sin dependencias. Phase B y C deben quedar mergeadas **antes** de arrancar la ejecución de Tier 2 y Tier 3 respectivamente.

Two execution options:

**1. Subagent-Driven (recommended)** — dispatch fresh subagent per task, review entre tasks. Sirve bien para este tipo de plan porque cada task es relativamente independiente y la verificación es directa (`grep -c`).

**2. Inline Execution** — ejecutar tasks en esta sesión via `superpowers:executing-plans`, con checkpoint al final de cada Phase.

**¿Cuál preferís?**
