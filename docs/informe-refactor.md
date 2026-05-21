# Informe de Refactor — SDA Framework

Estado: revisado. Las correcciones tras el self-review estan documentadas en
el apendice final "Errata y notas de verificacion".

Convención de referencias: `path/al/archivo.ts:linea` para apuntar al punto
exacto que se discute.

---

## Indice

- [1. Reorganización física del repo](#1-reorganización-física-del-repo)
  - 1.1 `app/app/` → `app/(dashboard)/`
  - 1.2 Agrupar `lib/` por dominio
  - 1.3 Partir `inngest/functions/process-document-index.ts` (1012 LOC)
  - 1.4 `scripts/` con sub-namespaces
  - 1.5 `docs/progreso/` → `CHANGELOG.md` o branch separado
  - 1.6 Partir `workers/compute-gateway/server.mjs` (832 LOC)
  - 1.7 Worker Python: separar prompts del grafo
  - 1.8 No mover: migraciones SQL
- [2. Reduccion de LOC confiando en los servicios](#2-reduccion-de-loc-confiando-en-los-servicios)
  - 2.1 Eliminar dualidad `lib/system-versions.ts` ↔ `system_component_versions`
  - 2.2 Reemplazar `lib/compute-gateway.ts` (382 LOC) con un wrapper generico
  - 2.3 Borrar `scripts/secret-scan.mjs` (117 LOC)
  - 2.4 Reducir `scripts/env-doctor.mjs` (284 LOC) a un check minimo
  - 2.5 Reescribir `scripts/indexing-health.mjs` (433 LOC) como una view SQL
  - 2.6 Reemplazar `lib/document-detail-cache.ts` con `unstable_cache` de Next 16
  - 2.7 Colapsar transiciones de Inngest con un descriptor declarativo
  - 2.8 Usar `supabase-js` typed RPC en lugar de strings
  - 2.9 Eliminar `lib/utils.ts` o consolidar con shadcn ya importado
  - 2.10 Inngest: reemplazar polling manual con `step.waitForEvent`
- [3. Mejoras de ingestado e indexado (con LangGraph)](#3-mejoras-de-ingestado-e-indexado-con-langgraph)
  - 3.1 Agregar `detect_document_type` como primer nodo
  - 3.2 Implementar `recursive_refinement` (hoy ausente)
  - 3.3 Conditional edge `repair_or_degrade_mode`
  - 3.4 Routing summary separado del summary
  - 3.5 Checkpointing en `langgraph_checkpoints`
  - 3.6 Embeddings jerarquicos como nodo del grafo
  - 3.7 LangGraph `Send` para fan-out paralelo de summaries
  - 3.8 Estado live durante la corrida (Inngest event stream)
  - 3.9 Document type-aware retrieval (preparacion para el agente futuro)
  - Diagrama del grafo propuesto
- [4. CLI propia: `sda`](#4-cli-propia-sda)
  - 4.1 Stack y filosofia
  - 4.2 `sda doctor` — health check completo
  - 4.3 `sda ship` — typecheck + lint + build + push
  - 4.4 `sda deploy <worker>` — deploy seguro a srv-ia-01
  - 4.5 `sda indexing` — operaciones sobre runs
  - 4.6 `sda invite` — gestion de invitaciones desde shell
  - 4.7 `sda db` — operaciones de base
  - 4.8 `sda redis` — operaciones Redis
  - 4.9 `sda dev` — entorno de desarrollo unificado
  - 4.10 Comando de bootstrap del proyecto
- [5. Mejoras de DB y caching](#5-mejoras-de-db-y-caching)
  - 5.1 Normalizar `doc_tree` a tabla relacional `doc_tree_nodes`
  - 5.2 Particionar `indexing_events` por mes
  - 5.3 `pg_cron` para limpieza programada
  - 5.4 Indices que faltan
  - 5.5 Cache de `system_component_versions` (solo si NO se acepta 2.1)
  - 5.6 Vista materializada para `sda doctor --deep`
  - 5.7 Realtime: confirmar que RLS filtra al cliente
  - 5.8 Caches de Next.js (Data Cache + revalidateTag)
  - 5.9 Edge runtime para handlers chicos
  - 5.10 Indices SQL para retrieval futuro (preparacion del agente)
- [6. Limpieza, reestructuracion y fixes](#6-limpieza-reestructuracion-y-fixes)
  - 6.1 Renombrar `r2_bucket` / `r2_key` (legacy naming)
  - 6.2 Eliminar `scripts/inngest-sync.mjs` o estandarizar en CI
  - 6.3 ~~RETIRADO~~ — `supabase/.temp/*` ya no esta en git
  - 6.4 Separar tipos de UI en `lib/documents.ts`
  - 6.5 `app/auth/sign-out/route.ts` no debe ser GET
  - 6.6 `lib/system-versions.ts` mezclado con metadata derivada
  - 6.7 `app/api/.../indexing/request/route.ts` complejidad excesiva
  - 6.8 Reconciliador: queries duplicadas
  - 6.9 `app/page.tsx` redirect redundante
  - 6.10 `next-env.d.ts` autogenerado
  - 6.11 `docs/sda-tree-index-live-architecture.md` duplica `docs/arquitectura.md`
  - 6.12 ~~RETIRADO~~ — `tsconfig.tsbuildinfo` ya no esta en git
- [7. Seguridad](#7-seguridad)
  - 7.1 **CRITICO** — rotar tokens visibles en historia conversacional
  - 7.2 **ALTA** — `app/auth/sign-out` debe ser POST (CSRF)
  - 7.3 **ALTA** — rate-limit en `accept_tenant_invite`
  - 7.4 **ALTA** — CSRF en route handlers POST
  - 7.5 **ALTA** — Compute Gateway token compartido sin rotacion
  - 7.6 **MEDIA** — RLS sin policies de DELETE en muchas tablas
  - 7.7 **MEDIA** — Storage RLS path traversal
  - 7.8 **MEDIA** — `audit_log` no captura todas las escrituras criticas
  - 7.9 **MEDIA** — dependencias sin actualizar
  - 7.10 **BAJA** — tokens en environment variables del worker
  - 7.11 **BAJA** — log de signed URLs en Inngest steps
  - 7.12 **BAJA** — `secrets:scan` no cubre PRs con history rewrite
  - 7.13 **MEDIA** — revisar `app.current_tenant_role()` default a `'member'`
- [Cierre](#cierre)
- [Apendice: Errata y notas de verificacion](#apendice-errata-y-notas-de-verificacion)

---

## 1. Reorganización física del repo

Mover archivos no cambia funcionalidad pero reduce la carga cognitiva al navegar.
La regla aplicada: agrupar por **dominio de cambio** (qué archivos se editan
juntos) en vez de por tipo técnico. Hoy `lib/` tiene 11 archivos planos en
root (`lib/redis.ts`, `lib/rate-limit.ts`, `lib/indexing-*.ts`, etc.) y solo 3
subdirectorios (`auth/`, `platform/`, `supabase/`). Lo que toca Redis está
disperso, lo mismo con indexing.

### 1.1 `app/app/` → `app/(dashboard)/`

El duplicado visual `app/app/documents/[id]/page.tsx` aparece en todas las
imports y es confuso. Next 16 soporta **route groups** con paréntesis que no
consumen segmento de URL.

Movimiento:

```text
app/app/page.tsx        → app/(dashboard)/page.tsx
app/app/documents/...   → app/(dashboard)/documents/...
app/app/invites/...     → app/(dashboard)/invites/...
```

No cambia URLs, solo el layout filesystem. Referencias a actualizar:

- `components/dashboard/app-topbar.tsx:6-10`: los `href` ya son `/app`, no cambian.
- `app/auth/callback/route.ts:17`: `safeNextPath` default `/app`, sigue funcionando.
- `app/page.tsx:4`: `redirect("/app")`, sigue funcionando.

### 1.2 Agrupar `lib/` por dominio

Hoy `lib/` tiene **11 archivos en root** + 7 ya agrupados en `auth/`,
`platform/`, `supabase/`. La inconsistencia es justamente que algunos dominios
ya estan en carpeta y otros no. Propuesta de unificar:

```text
lib/
  auth/
    session.ts                   (era lib/session.ts)
    supabase/                    (queda donde está)
  indexing/
    state.ts                     (era lib/indexing-state.ts)
    redis.ts                     (era lib/indexing-redis.ts)
    versions.ts                  (era lib/indexing-versions.ts)
    compute-gateway.ts           (era lib/compute-gateway.ts)
  redis/
    client.ts                    (era lib/redis.ts)
    rate-limit.ts                (era lib/rate-limit.ts)
    document-detail-cache.ts     (era lib/document-detail-cache.ts)
  documents/
    types.ts                     (extraer de lib/documents.ts)
    format.ts                    (helpers UI extraídos)
  platform/                      (queda)
  system-versions.ts             (queda o se elimina; ver seccion 6)
  utils.ts                       (queda)
```

Por que: cuando alguien toca "rate limit", abre Redis y la cache de detalle al
mismo tiempo, son la misma feature. Hoy esos archivos estan en `lib/redis.ts`,
`lib/rate-limit.ts`, `lib/document-detail-cache.ts` con `lib/indexing-redis.ts`
en otra punta. Agrupar baja el costo de "saltar entre archivos".

### 1.3 Partir `inngest/functions/process-document-index.ts` (1012 LOC)

Es el archivo de codigo mas grande del repo despues de `app/globals.css`. Hoy mezcla:

- claim de run (`process-document-index.ts:81-180`)
- dispatch a Compute Gateway MinerU (`:290-460`)
- poll MinerU (`:462-594`)
- persistencia de extraction + artifacts (`:595-685`)
- dispatch a Tree Indexer (`:687-770`)
- poll Tree (`:803-858`)
- transiciones finales (`:860-1010`)

Propuesta: dejar el archivo principal como **orquestador** que invoca steps de
archivos chicos.

```text
inngest/functions/process-document-index/
  index.ts        (~120 LOC, solo Inngest.createFunction + secuencia)
  claim.ts        (claim idempotente)
  mineru.ts       (dispatch + poll + persist artifacts)
  tree.ts         (dispatch + poll + terminal transitions)
  helpers.ts      (era indexing-workflow-helpers.ts; ya existe)
```

Reparto aproximado (estimado, no balanceado): `claim.ts` ~80 LOC,
`mineru.ts` ~400, `tree.ts` ~300, `index.ts` ~120. La reduccion real viene en
la seccion 2.

### 1.4 `scripts/` con sub-namespaces

Hoy son 9 scripts planos con prefijos implicitos por nombre. Propongo:

```text
scripts/
  db/
    versions-check.mjs
    versions-sync.mjs
    bootstrap-owner-invite.mjs
  health/
    env-doctor.mjs
    indexing-health.mjs
    redis-health.mjs
  ci/
    secret-scan.mjs
    inngest-sync.mjs
  shared/
    env-loader.mjs               (helper comun)
```

Esto se conecta con la seccion 4 (CLI `sda` que termina invocando estos scripts
internos).

### 1.5 `docs/progreso/` → `CHANGELOG.md` o branch separado

Son **47 archivos** ocupando 2.500+ LOC de markdown. Cada archivo es ~50 lineas
con "que hice, que pendiente, verificacion". Esto es ruido en GitHub: cualquier
`Ctrl+P` o busqueda devuelve resultados de progreso historico irrelevantes para
el codigo activo.

Opcion A conservadora: condensarlos en `CHANGELOG.md` agrupado por version
semver del componente principal (`app`). Cada bullet apunta al commit hash del
progreso original.

Opcion B agresiva: moverlos a un branch `progress-archive` (no se borra
historia, no se ve en `main`). Util si los progresos sirven solo para auditar
la evolucion.

Recomendacion: Opcion A, porque las decisiones tecnicas en
`docs/progreso/2026-05-20-29-extracciones-enterprise-control-plane.md`,
`:36-openrouter-gemini-tree-index-real.md`,
`:42-worker-infra-hardening-version-sync.md` son referenciadas desde
`docs/arquitectura.md:599-602`. Si los moves a branch perdes el linkeo.

### 1.6 Partir `workers/compute-gateway/server.mjs` (832 LOC)

Hoy es un archivo monolitico con HTTP server + pool de jobs + downloader +
MinerU runner + uploader + storage helpers. Propuesta:

```text
workers/compute-gateway/
  server.mjs              (~200 LOC: HTTP routing + auth)
  jobs/
    mineru.mjs            (downloader + execMineru + uploadArtifacts)
    queue.mjs             (pendingJobs + drainQueue + activeJobs)
  storage.mjs             (Supabase Storage REST helpers)
  proxy.mjs               (proxyTreeIndexer)
```

Hoy `enqueueJob` (`workers/compute-gateway/server.mjs:634-654`) esta en medio
del archivo entre `processJob` y el handler HTTP. Partir lo hace evidente.

### 1.7 Worker Python: separar prompts del grafo

`workers/tree-indexer-python/app/tree_graph.py` tiene **4 funciones de prompt**
(`_candidate_prompt`, `_verification_prompt`, `_summary_prompt`,
`_doc_summary_prompt`) mezcladas con los nodos del grafo. Cada una pesa entre
20 y 40 LOC (texto del prompt en heredoc). Propuesta:

```text
workers/tree-indexer-python/app/
  tree_graph.py    (solo nodos + build_graph)
  prompts.py       (todos los _*_prompt; versionado de prompt vive aqui)
```

`tree_prompt` ya es un componente versionado independiente
(`lib/system-versions.ts:9`). Separarlo fisicamente alinea el archivo con esa
decision.

### 1.8 No mover: migraciones SQL

Las **22 migraciones** en `supabase/migrations/` estan planas en una carpeta
unica. Supabase recomienda esta estructura (timestamp-ordered) y romperla
**rompe la herramienta** `supabase db push`. No mover. Pero si proponer
cambiar nombres genericos como `20260521121000_system_component_versions_016.sql`
por algo descriptivo en el futuro (no renombrar las existentes; ya estan
aplicadas en remoto).

### Resumen ejecutable de la seccion

| # | Cambio | Archivos afectados | Riesgo |
|---|---|---|---|
| 1.1 | `app/app/` → `app/(dashboard)/` | 6 rutas | Bajo (mismo URL) |
| 1.2 | Agrupar `lib/` por dominio | ~18 archivos, ~80 imports | Medio (muchas refs) |
| 1.3 | Partir `process-document-index.ts` | 1 → 5 archivos | Bajo |
| 1.4 | Sub-namespaces en `scripts/` | 9 scripts + `package.json` | Bajo |
| 1.5 | `docs/progreso/` → `CHANGELOG.md` | 47 → 1 | Bajo |
| 1.6 | Partir `compute-gateway/server.mjs` | 1 → 4 | Bajo |
| 1.7 | Separar prompts en Python worker | 1 → 2 | Bajo |

### Estado de ejecucion — 2026-05-21

- [ ] 1.1 `app/app/` → `app/(dashboard)/`: omitido por pedido del usuario.
- [x] 1.2 `lib/` agrupado por dominio: `auth/`, `documents/`, `indexing/` y
  `redis/`.
- [x] 1.3 `process-document-index` partido en `index.ts`, `claim.ts`,
  `mineru.ts`, `tree.ts`, `helpers.ts` y `types.ts`.
- [x] 1.4 `scripts/` movido a `db/`, `health/`, `ci/` y `shared/`; comandos
  npm actualizados.
- [x] 1.5 `docs/progreso/` consolidado en `CHANGELOG.md`; carpeta removida.
- [x] 1.6 `workers/compute-gateway/server.mjs` reducido a routing HTTP; config,
  storage, proxy, cola y ejecucion MinerU quedaron en modulos separados.
- [x] 1.7 prompts del Tree Indexer movidos a
  `workers/tree-indexer-python/app/prompts.py`.
- [x] 1.8 migraciones SQL preservadas sin mover.

---

## 2. Reduccion de LOC confiando en los servicios

Principio rector: si Vercel, Supabase, Upstash, Inngest o GitHub ya hacen una
cosa, no la reimplementamos. Las propuestas de esta seccion borran codigo neto:
el repo termina con menos archivos y menos lineas.

### Estado de ejecucion — 2026-05-21

- [x] 2.1 Eliminar dualidad de versiones: implementado; fuente unica en
  `lib/system-versions.json`, TS/Python/workers leen de ahi y la RPC usa
  `_metadata.versions`.
- [x] 2.2 Wrapper generico Compute Gateway: implementado; tipos extraidos a
  `lib/indexing/types.ts` y fetches duplicados colapsados en `callGateway`.
- [~] 2.3 Secret scanning nativo: implementado parcialmente; GitHub Secret
  Scanning y Push Protection habilitados en remoto, scanner local retenido
  porque los patrones no-provider siguen sin cobertura nativa verificada.
- [x] 2.4 `env-doctor` minimo: implementado; queda limitado a mismatch
  Supabase, reuse de keys y prefijo Redis local en production.
- [x] 2.5 `indexing-health` como SQL view: implementado; anomalías
  estructurales viven en `public.indexing_health_anomalies` y el script solo
  consume/formatea.
- [x] 2.6 Cache de detalle con `unstable_cache`: implementado; Redis manual
  eliminado para detalle documental y revalidación por tag estático.
- [x] 2.7 Transiciones declarativas de Inngest: implementado; nuevo
  `transitions.ts` centraliza descriptores y los steps de MinerU/Tree usan
  `recordTransition`.
- [x] 2.8 Supabase typed RPC: implementado; clientes Supabase tipados con
  `Database` y RPCs principales declaradas en `types.gen.ts`.
- [x] 2.9 `lib/utils.ts`: implementado como decisión de no tocar; `cn()` queda
  como alias shadcn oficial.
- [x] 2.10 `waitForEvent`: implementado en modo híbrido; workers publican
  eventos terminales y el workflow espera eventos con fallback a polling.

### 2.1 Eliminar dualidad `lib/system-versions.ts` ↔ `system_component_versions`

Hoy hay **dos fuentes de verdad** para versiones:

- `lib/system-versions.ts:1-11`: objeto `SYSTEM_COMPONENT_VERSIONS`.
- Tabla DB `public.system_component_versions` poblada con
  `npm run versions:sync` (`scripts/versions-sync.mjs`).

Y un tercer espejo en Python: `workers/tree-indexer-python/app/versions.py:10-20`.

Esto requiere **dos scripts** completos solo para mantenerlos en sync:

- `scripts/versions-check.mjs` (268 LOC)
- `scripts/versions-sync.mjs` (132 LOC)

Mas la migracion historica
`supabase/migrations/20260521011000_system_component_versions.sql` (319 LOC).

Propuesta: **una sola fuente** en `lib/system-versions.json` (no `.ts` porque
asi lo lee Python tambien). Borrar:

- `scripts/versions-sync.mjs`
- `scripts/versions-check.mjs` (CI verifica con un `jq` y `git diff`)
- `system_component_versions` se mantiene en DB pero se popula via funcion SQL
  que lee de un GUC o de un endpoint, no por sync manual.

Mejor aun: la RPC `request_document_indexing` deja de leer versiones de la
tabla. Las versiones viajan en el `_metadata` del request desde Inngest, que ya
las tiene en `INDEXING_VERSION_METADATA` (`lib/system-versions.ts:27-38`). La
tabla solo queda como **auditoria opcional**.

Ahorro: ~400 LOC en scripts + 1 tabla + 3 columnas operativas.

Riesgo: medio, hay que cambiar la RPC. Migracion: nueva version de
`request_document_indexing` que ignora la tabla.

### 2.2 Reemplazar `lib/compute-gateway.ts` (382 LOC) con un wrapper generico

Hoy `lib/compute-gateway.ts` tiene:

- 4 funciones de fetch casi identicas (`createComputeGatewayIndexJob`,
  `getComputeGatewayIndexJob`, `createComputeGatewayTreeIndexJob`,
  `getComputeGatewayTreeIndexJob`).
- `readJsonResponse`, `formatResponseStatus`, `truncateResponseBody`,
  `errorMessageFromBody`: parseo defensivo de respuesta.
- `getTimeoutMs`, `getSignedUrlTtlSeconds`: helpers de env.

Todo se puede colapsar a:

```ts
// lib/indexing/compute-gateway.ts (~80 LOC)
async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const { url, token, timeoutMs } = getConfig();
  const response = await fetch(`${url}${path}`, {
    body: body ? JSON.stringify(body) : undefined,
    headers: {
      ...(token && { authorization: `Bearer ${token}` }),
      ...(body && { "content-type": "application/json" })
    },
    method,
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  return response.json();
}

export const createIndexJob = (p: IndexJobReq) =>
  call<IndexJobRes>("POST", "/v1/index-jobs", p);
export const getIndexJob = (id: string) =>
  call<IndexJobStatus>("GET", `/v1/index-jobs/${id}`);
export const createTreeJob = (p: TreeJobReq) =>
  call<TreeJobRes>("POST", "/v1/tree-index-jobs", p);
export const getTreeJob = (id: string) =>
  call<TreeJobStatus>("GET", `/v1/tree-index-jobs/${id}`);
```

Confiamos en:

- `AbortSignal.timeout` (Node 17.3+; Vercel runtime usa Node 20+ por default)
  reemplaza el `setTimeout` + `clearTimeout` manual.
- `response.ok` y `response.json()` reemplazan `readJsonResponse`,
  `truncateResponseBody`, `errorMessageFromBody`.

Las **tipos** (`ComputeGatewayIndexJobStatus`, `ComputeGatewayArtifact`) van a
`lib/indexing/types.ts`, no se borran.

Ahorro: 382 → ~80 LOC. Riesgo: bajo. El reporting de errores es menos
detallado, pero Inngest ya captura el stack del Error.

### 2.3 Borrar `scripts/secret-scan.mjs` (117 LOC)

GitHub hace secret scanning para repos publicos por default desde 2024. Push
protection esta disponible pero hay que activarlo en Settings → Code security.
**Verificar antes de borrar** que el repo lo tenga habilitado; si no, primero
activar y despues eliminar el script.

Borrar:

- `scripts/secret-scan.mjs`
- `npm run secrets:scan` en `package.json:17`
- step `npm run secrets:scan` en `.github/workflows/ci.yml:38`

Sustituir por un hook nativo de GitHub: en Settings → Code security → Secret
scanning **Push protection**. Si alguien pushea un token, el push es rechazado
desde el lado servidor antes de que entre al historial.

Para tokens custom que GitHub no detecta (Inngest event keys, Upstash tokens),
GitHub permite **custom patterns** en Advanced Security. Configurar los 3-4
patrones del scanner local.

Ahorro: 117 LOC + un paso de CI.

### 2.4 Reducir `scripts/env-doctor.mjs` (284 LOC) a un check minimo

El env-doctor hace 12+ checks. La mayoria son redundantes con Vercel:

- Vercel ya falla el deploy si falta una env var declarada en el dashboard.
- Vercel ya valida que las `NEXT_PUBLIC_*` esten configuradas en build.
- Supabase ya valida URLs en su propio SDK.

Lo que **si** vale chequear localmente y no esta cubierto:

- mismatch entre `SUPABASE_URL` y `NEXT_PUBLIC_SUPABASE_URL` (apuntan a hosts
  distintos)
- reuse accidental de `SERVICE_ROLE_KEY` como `PUBLISHABLE_KEY`
- prefijo Redis `sda:local` en `VERCEL_ENV=production`

Eso son 30 LOC. El resto se elimina.

Ahorro: 284 → ~40 LOC.

### 2.5 Reescribir `scripts/indexing-health.mjs` (433 LOC) como una view SQL

Hoy hace `selectRows` sobre 7 tablas y arma anomalies en JS. Es un JSON dump
con detection de:

- `uploaded_without_active_run`
- `nonterminal_without_active_run`
- `indexed_without_tree`
- `running_with_persisted_tree`
- version drift

Todo eso son joins. Propuesta: crear **una view** SQL en migracion nueva.

```sql
create view public.indexing_health_anomalies as
  select 'uploaded_without_active_run' as anomaly, d.id, d.tenant_id, ...
  from documents d
  left join indexing_runs r on r.document_id = d.id and r.status in ('queued','running')
  where d.status = 'uploaded' and d.uploaded_at is not null and r.id is null
  union all
  select 'indexed_without_tree' ...
  union all
  ...;
```

El script en JS se vuelve `select * from indexing_health_anomalies` + format.

Ventaja extra: pgAdmin, Studio o cualquier client SQL puede consultar la view
sin correr Node. Sirve tambien para `sda doctor` (seccion 4) y para alertas
externas (Grafana, Metabase) en el futuro.

Ahorro: 433 → ~60 LOC.

### 2.6 Reemplazar `lib/document-detail-cache.ts` con `unstable_cache` de Next 16

Hoy `app/app/documents/[id]/page.tsx:93-159` arma un snapshot con 5 queries
paralelas y lo cachea en Redis manualmente.

Next 16 tiene `unstable_cache` con **tag-based invalidation**:

```ts
import { unstable_cache, revalidateTag } from "next/cache";

const getDocumentDetail = unstable_cache(
  async (documentId: string, tenantId: string) => { /* 5 queries */ },
  ["document-detail"],
  { tags: (id) => [`document:${id}`], revalidate: 60 }
);

// En el handler que dispara indexacion:
await revalidateTag(`document:${documentId}`);
```

Ventajas:

- Cache vive en Vercel Data Cache, no en Upstash. Reduce dependencia.
- Invalidacion automatica por tag, no manual.
- No corremos JSON serialize/deserialize ourselves.

Borrar `lib/document-detail-cache.ts` (88 LOC). El detalle queda mas corto y
declarativo.

Limitacion: `unstable_cache` no es per-tenant por default; hay que incluir
`tenantId` en la cache key. La API actual ya lo hace.

Ahorro: 88 LOC + una dependencia menos sobre Redis para esta feature.

### 2.7 Colapsar transiciones de Inngest con un descriptor declarativo

Hoy `inngest/functions/process-document-index.ts` tiene **17 llamadas** a
`recordIndexingTransition` con boilerplate enorme (15-30 lineas cada una).
Cada llamada repite el patron:

```ts
await step.run("record-XXX", async () => {
  await recordIndexingTransition({
    document: { status: "...", status_reason: "..." },
    documentId: event.data.document_id,
    event: { eventType: "indexing.XXX", message: "...", severity: "info" },
    progress: NN,
    run: { progress: NN, stage: "...", status: "..." },
    runId: event.data.run_id,
    stage: "...",
    status: "...",
    tenantId: event.data.tenant_id
  });
});
```

Propuesta: tabla declarativa de estados.

```ts
// inngest/functions/process-document-index/transitions.ts
export const TRANSITIONS = {
  orchestrator_received: {
    stage: "queued",  progress: 0,   status: "running",
    document: null,
    event: { type: "indexing.orchestrator.received", severity: "info" }
  },
  compute_gateway_dispatching: {
    stage: "extracting", progress: 5, status: "running",
    document: { status: "parsing", reason: "Enviando documento al Compute Gateway" },
    event: { type: "indexing.compute_gateway.dispatching", severity: "info" }
  },
  // ...
} as const;

// helper:
async function transition(key: keyof typeof TRANSITIONS, ctx: TransitionCtx, extras?) {
  const t = TRANSITIONS[key];
  await recordIndexingTransition({ ...t, ...ctx, ...extras });
}
```

El workflow se vuelve una secuencia legible:

```ts
await step.run("record-orchestrator-received", () => transition("orchestrator_received", ctx));
const job = await step.run("create-compute-job", () => createIndexJob(...));
await step.run("record-job-created", () => transition("compute_gateway_job_created", ctx, { metadata: { job_id: job.job_id } }));
```

Ahorro estimado: ~400 LOC en `process-document-index.ts`. El archivo principal
baja aproximadamente de 1012 a ~500 LOC sin perder informacion (las strings
duplicadas viven en `transitions.ts`).

### 2.8 Usar `supabase-js` typed RPC en lugar de strings

Hoy las RPC calls usan strings:

```ts
await supabase.rpc("create_document_upload", { _filename, _byte_size, ... });
```

Sin tipos. Si alguien renombra un parametro en SQL, TypeScript no se entera.

Supabase CLI puede generar tipos:

```bash
supabase gen types typescript --linked > lib/auth/supabase/types.gen.ts
```

Y `createClient<Database>(...)` infiere tipos de RPCs, tablas y enums.

Cambio puntual: agregar el comando a CI y al deploy script. Y a `package.json`:

```json
"types:gen": "supabase gen types typescript --linked > lib/auth/supabase/types.gen.ts"
```

No reduce LOC directamente, pero **evita futuros archivos de types manuales**
(hoy `lib/documents.ts:12-29` mantiene `DocumentRow` a mano y hay que
sincronizar con SQL).

Ahorro: ~70 LOC de types manuales + bugs futuros.

### 2.9 Eliminar `lib/utils.ts` o consolidar con shadcn ya importado

`lib/utils.ts` solo exporta `cn()` (5 LOC). Es trivial. No mover, pero
mencionar: el archivo ya esta importado de `components.json:18` como alias
oficial de shadcn. No tocar.

### 2.10 Inngest: reemplazar polling manual con `step.waitForEvent`

`inngest/functions/process-document-index.ts:462-516` y `:803-858` son loops
de polling con `step.sleep` cada 30s, hasta 240 intentos (2 horas).

Inngest soporta **`step.waitForEvent`** que duerme hasta que llega un evento
con match. Si los workers Python/Node emitieran un evento al terminar
(en vez de exponer un endpoint para pollear), el workflow se simplifica:

```ts
const result = await step.waitForEvent("wait-mineru", {
  event: "compute/mineru.completed",
  match: "data.job_id",
  timeout: "2h"
});
```

Requiere cambios no triviales en los workers:

- `workers/compute-gateway/server.mjs`: al final de `processJob`
  (`workers/compute-gateway/server.mjs:596-632`), enviar evento HTTP a
  `https://inn.gs/e/<event_key>`.
- `workers/tree-indexer-python/app/main.py`: idem al final de `process_tree_job`.
- Distribuir `INNGEST_EVENT_KEY` al `.env` de cada worker (hoy no lo tienen).
- Handling de errores: si Inngest Cloud no responde, el worker no debe fallar
  el job — solo loguea y deja que el reconciliador detecte que el run quedo
  sin terminal event y redispatchee.

Ventajas:

- Cero polling. No hay 240 `step.run` por documento.
- Latencia de deteccion baja de ~30s (peor caso del polling) a ~1s.
- Es event-driven puro.

Riesgo: medio-alto. Es una pieza nueva (event publisher) en cada worker.
Hasta tenerla, dejar polling como fallback o pasar a un esquema mixto
(`waitForEvent` con timeout, si vence usar poll).

Ahorro estimado: ~150 LOC de polling boilerplate.

### Resumen ejecutable de la seccion

| # | Cambio | LOC quitadas | Riesgo |
|---|---|---|---|
| 2.1 | Unificar fuente de versiones | ~400 | Medio |
| 2.2 | Wrapper generico Compute Gateway | ~300 | Bajo |
| 2.3 | Borrar secret-scan local | 117 | Bajo |
| 2.4 | Adelgazar env-doctor | ~240 | Bajo |
| 2.5 | Indexing-health como SQL view | ~370 | Bajo |
| 2.6 | Cache con `unstable_cache` | ~80 | Bajo |
| 2.7 | Transiciones declarativas | ~400 | Bajo |
| 2.8 | Tipos generados de Supabase | ~70 (futuro) | Bajo |
| 2.10 | `waitForEvent` en lugar de polling | ~150 | Medio-Alto |
| **Total estimado** | | **~2.100 LOC** | |

Las cifras de cada fila son **estimadas**, redondeadas hacia arriba. El
ahorro real probablemente sea 1.500–1.800 LOC. Aun asi, representa
aproximadamente **6–9% del codigo del repo (~23.6k LOC)** sin perder
funcionalidad.

---

## 3. Mejoras de ingestado e indexado (con LangGraph)

Condicion: usar LangGraph. Ya se usa en
`workers/tree-indexer-python/app/tree_graph.py`. Al inicio de esta seccion el
grafo tenia **4 nodos** lineales:

```text
START -> build_candidate_tree -> verify_tree -> post_process_tree -> summarize_tree -> END
```

Ese camino feliz fue ampliado con deteccion de tipo documental, reparacion y
degradacion, refinamiento recursivo, summaries de routing, embeddings,
checkpointing opcional, fan-out `Send` y eventos live por nodo.

### Estado de ejecucion — 2026-05-21

| Punto | Estado | Nota |
|---|---|---|
| 3.1 | implementado | `detect_document_type` corre como primer nodo y parametriza el prompt de candidato. |
| 3.2 | implementado | `refine_large_nodes` divide hojas grandes antes de summaries/embeddings, con limites por paginas/tokens/iteraciones. |
| 3.3 | implementado | `verify_tree` routea a aceptar, reparar, degradar a `no_toc` o fallar con limite configurable. |
| 3.4 | implementado | `routing_summary` agregado a DB, nodos del grafo, chunks y persistencia. |
| 3.5 | implementado | Checkpointing Postgres queda soportado via `langgraph-checkpoint-postgres`, activable con DSN/env y thread_id por job. |
| 3.6 | implementado | `embed_hierarchy` genera vectores 1536 sobre `routing_summary` y los persiste en `chunks.embedding`. |
| 3.7 | implementado | Summaries y routing summaries usan fan-out LangGraph `Send` con nodos `summarize_one_*` y collectors. |
| 3.8 | implementado | Worker Python emite eventos `indexing/tree.node` por nodo del grafo y una funcion Inngest los persiste como `indexing_events`. |
| 3.9 | implementado | `document_type` se persiste en `documents.metadata`, `doc_tree` y `chunks.metadata`. |

### 3.1 Agregar `detect_document_type` como primer nodo

Hoy el sistema procesa toda PDF igual: libro, factura, contrato, slide deck.
PageIndex Reference (`docs/pageindex-tree-builder-reference.md:84-92`) y la
arquitectura (`docs/sda-tree-index-live-architecture.md:147-184`) dicen
explicitamente que el tipo documental cambia la estrategia.

Propuesta: nuevo nodo `detect_document_type` antes de `build_candidate_tree`.

```python
async def detect_document_type(state: TreeState) -> dict:
    # LLM barato/rapido, prompt minimo con paginas 1-3
    response = await call_tree_llm_json(
        _doc_type_prompt(state["pages"][:3]),
        purpose="document_type"
    )
    return {"document_type": response["json"]["type"]}
```

Tipos esperados: `book`, `report`, `invoice`, `contract`, `slides`, `manual`,
`other`. Cada tipo dispara un prompt distinto en `build_candidate_tree`:

- `book`: prompt PageIndex tradicional (chapters/sections).
- `slides`: nodo = slide, sin jerarquia anidada.
- `invoice`: nodos por seccion (header/items/totals), no por pagina.
- `contract`: nodos por clausula.

Hoy el prompt en `workers/tree-indexer-python/app/tree_graph.py:73-111` es uno
solo, agnostico de tipo. Cambiarlo por una dispatch table de prompts indexada
por `document_type`.

Costo: 1 llamada LLM extra al modelo barato (`SDA_TREE_SUMMARY_MODEL`), <500
tokens. Beneficio: arbol mejor estructurado para tipos no-libro.

### 3.2 Implementar `recursive_refinement` (hoy ausente)

`docs/pageindex-tree-builder-reference.md:155-166` documenta refinamiento
recursivo de nodos grandes:

> Si un nodo cubre demasiadas paginas y demasiados tokens, PageIndex vuelve a
> ejecutar el extractor estructural dentro de ese rango.
>
> Defaults observados: max paginas por nodo: 10, max tokens por nodo: 20000.

El grafo actual **no** lo implementa. Un nodo "Capitulo 1" que cubre 30
paginas se persiste con un solo summary, perdiendo granularidad.

Propuesta: agregar nodo `refine_large_nodes` despues de `post_process_tree`,
con conditional edge.

```python
async def refine_large_nodes(state: TreeState) -> dict:
    large = [n for n in flatten_tree(state["tree"])
             if (n.end_index - n.start_index + 1) > MAX_PAGES_PER_NODE
             or estimate_tokens(n.text) > MAX_TOKENS_PER_NODE]

    if not large:
        return {"tree": state["tree"], "refined": False}

    # Para cada nodo grande, correr el subgrafo (candidate -> verify -> post_process)
    # solo sobre sus paginas. Reemplazar el nodo por su sub-arbol.
    for node in large:
        sub_pages = state["pages"][node.start_index-1:node.end_index]
        sub_tree = await TREE_GRAPH.ainvoke({...sub_pages...})
        replace_node_with_subtree(state["tree"], node, sub_tree)

    return {"tree": state["tree"], "refined": True}

# Conditional edge:
graph.add_conditional_edges(
    "refine_large_nodes",
    lambda state: "summarize_tree" if not state["refined"] else "verify_tree",
    {"summarize_tree": "summarize_tree", "verify_tree": "verify_tree"}
)
```

El loop verify -> refine -> verify garantiza que iteramos hasta que todos los
nodos cumplen size constraints o cap se alcanza (3 iteraciones max).

### 3.3 Conditional edge `repair_or_degrade_mode`

`docs/pageindex-tree-builder-reference.md:124-138`:

> si accuracy es 1.0, acepta;
> si accuracy es mayor a 0.6 y hay errores, repara;
> si falla, degrada de modo: ToC con paginas → ToC sin paginas → no ToC;
> si todo falla, aborta.

Hoy `tree_graph.py:222-238` solo tiene **un threshold de aborto** (0.6).
Si accuracy = 0.7 (errores reparables) tira un error y mata el run.

Propuesta:

```python
def route_after_verify(state: TreeState) -> str:
    accuracy = state["metrics"]["verified_section_count"] / state["metrics"]["candidate_section_count"]
    if accuracy >= 0.95: return "post_process_tree"
    if accuracy >= 0.6: return "repair_sections"
    return "degrade_mode"  # o END con failed

graph.add_conditional_edges("verify_tree", route_after_verify, {...})
```

- `repair_sections`: prompt LLM con solo los items con `valid=false`, pidiendo
  reubicarlos.
- `degrade_mode`: cambia el prompt de candidate a uno sin numeracion fuerte
  (modo `no_toc`), reintenta.

Ambos son nodos nuevos en el grafo.

### 3.4 Routing summary separado del summary

`docs/sda-tree-index-live-architecture.md:357-374` distingue dos summaries:

```text
summary           = Que dice esta parte.
routing_summary   = Para que tipo de preguntas sirve esta parte.
```

Hoy `tree_graph.py:158-167` genera solo `summary`. La tabla `chunks` ni
siquiera tiene columna `routing_summary` (`supabase/migrations/20260520145604_core_multitenant_schema.sql:148-172`).

Propuesta:

1. Migracion nueva:

   ```sql
   alter table public.chunks add column routing_summary text;
   alter table public.doc_tree add column routing_summary text;
   ```

2. Nuevo nodo en grafo `summarize_routing` (despues de `summarize_tree`).
   Prompt:

   ```text
   Given this section, list 3-5 types of questions a user might ask
   that this section can answer. Be specific. Output one line per question.
   ```

3. El embedding (seccion 3.6 abajo) se calcula sobre `routing_summary`, no
   sobre `summary`. Asi el retrieval encuentra ramas por "para que sirve"
   y no por "que dice".

### 3.5 Checkpointing en `langgraph_checkpoints`

La tabla `langgraph_checkpoints` **ya existe**
(`supabase/migrations/20260520145604_core_multitenant_schema.sql:203-218`)
pero esta vacia y no se usa. Originalmente fue pensada para el chat agent
futuro.

LangGraph soporta nativamente persistencia de state via `Checkpointer`. Hoy si
el worker crashea a mitad de tree-indexing, perdemos todo el progreso (el
grafo arranca desde 0). Con checkpointing, podriamos retomar despues de
`verify_tree` sin reejecutar el candidate.

Propuesta: usar `langgraph-checkpoint-postgres` (paquete separado del core).

```python
from langgraph.checkpoint.postgres import AsyncPostgresSaver

checkpointer = AsyncPostgresSaver(SUPABASE_POOLER_URL)
TREE_GRAPH = build_graph().compile(checkpointer=checkpointer)

# Al invocar:
config = {"configurable": {"thread_id": job_id}}
result = await TREE_GRAPH.ainvoke(state, config=config)
```

Verificar compatibilidad con `langgraph==1.0.5` actual
(`workers/tree-indexer-python/requirements.txt:3`). Si requiere bump mayor,
evaluar el cambio en su propia PR.

El schema de `langgraph_checkpoints` actual
(`supabase/migrations/20260520145604_core_multitenant_schema.sql:203-218`)
puede no coincidir con el esperado por `AsyncPostgresSaver`. La lib expone
`setup()` que crea sus propias tablas; convivirian con la nuestra o
reemplazariamos la nuestra (decidir antes de migrar).

Si el worker muere a mitad y reinicia, LangGraph levanta del ultimo
checkpoint del thread (`job_id`). El reconciliador
(`inngest/functions/reconcile-document-indexing.ts`) ya redispacha jobs
stale; con checkpointing, el redispatch no reprocesa MinerU + verify, solo
sigue desde el ultimo paso completado.

Ahorro: en una corrida tipica, **80% menos LLM tokens** en retries. En docs
grandes con verify+refine multiples iteraciones, mas.

### 3.6 Embeddings jerarquicos como nodo del grafo

`lib/system-versions.json` ahora versiona `embedding_pipeline`. La primera
implementacion real genera vectores jerarquicos al final del grafo, usando
`routing_summary` como texto principal de embedding.

Propuesta: nuevo nodo final del grafo `embed_hierarchy`.

```python
async def embed_hierarchy(state: TreeState) -> dict:
    # Por cada chunk, embed sobre (path + title + routing_summary + entities)
    texts = [
        f"{' > '.join(c['node_path'])}: {c['title']}\n{c.get('routing_summary', '')}"
        for c in state["chunks"]
    ]
    embeddings = await call_embedding_model(texts)
    return {"chunks_with_embedding": [
        {**c, "embedding": e} for c, e in zip(state["chunks"], embeddings)
    ]}
```

Provider: OpenAI `text-embedding-3-small` (dimension 1536, ya hay un
`chunks_embedding_hnsw_idx` HNSW con `vector(1536)` en
`supabase/migrations/20260520145604_core_multitenant_schema.sql:320-323`).

Persistencia: `supabase_io.py:insert_chunks` ya inserta `embedding`. Hoy va
null. Pasaria a tener vector.

Costo: ~0.02 USD por documento de 100 paginas (estimacion text-embedding-3-small).

### 3.7 LangGraph `Send` para fan-out paralelo de summaries

Hoy `summarize_tree` (`tree_graph.py:245-263`) usa `asyncio.gather` con un
semaforo (`SDA_TREE_SUMMARY_CONCURRENCY=3` por default). Funciona pero **no
es resumible**: si murio en el medio, todos los summaries se rehacen.

LangGraph 1.0+ soporta el constructo `Send` para fan-out con checkpointing
por nodo individual:

```python
def fan_out_summaries(state: TreeState):
    return [Send("summarize_one_node", {"node": n, "path": p})
            for n, p in flatten_tree(state["tree"])]

graph.add_conditional_edges("post_process_tree", fan_out_summaries)
graph.add_node("summarize_one_node", summarize_one_node)
graph.add_edge("summarize_one_node", "collect_summaries")
graph.add_node("collect_summaries", collect_summaries)
```

Cada `summarize_one_node` se ejecuta con checkpoint propio. Si el worker
crashea, solo los nodes no terminados se rehacen.

Costo: medio refactor del summarize. Beneficio: resumibilidad fina + paralelismo
manejado por LangGraph en vez de manualmente.

### 3.8 Estado live durante la corrida (Inngest event stream)

Hoy el frontend recibe `indexing_events` via Supabase Realtime
(`components/documents/indexing-timeline.tsx:117-176`). Esos eventos se
escriben desde el workflow Inngest, no desde el worker Python. Entre el
"create-tree-indexer-job" y el "poll-tree-indexer-job-1" pasa 1 minuto sin
eventos en la UI.

Propuesta: el worker Python emite eventos Inngest directamente desde cada
nodo del grafo.

```python
# tree_graph.py
async def build_candidate_tree(state: TreeState) -> dict:
    await emit_inngest_event("indexing.tree.candidate_started", {
        "tenant_id": state["tenant_id"],
        "document_id": state["document_id"],
        "run_id": state["run_id"]
    })
    # ... logica actual
    await emit_inngest_event("indexing.tree.candidate_completed", {
        "section_count": len(sections), ...
    })
    return {...}
```

Inngest puede republicar esos eventos como `indexing_events` en Supabase via
un workflow secundario (o el primary workflow puede escuchar via
`step.waitForEvent` ver seccion 2.10).

Resultado: la UI ve **granularidad por nodo del grafo**, no solo "structuring
35%" -> "structuring 95%".

### 3.9 Document type-aware retrieval (preparacion para el agente futuro)

Cuando entre el chat agent (`chat_agent: "0.0.0"` hoy), el retrieval no debe
ser uniforme. Un contrato pide busqueda exacta de clausulas; un libro pide
navegacion jerarquica.

Propuesta: persistir `document_type` (de 3.1) en `documents.metadata` y en
cada chunk. Las tools de retrieval (`docs/arquitectura.md:367-376`)
parametrizan su estrategia segun ese tipo.

No requiere cambio de grafo; solo asegurar que `document_type` se persista en
`doc_tree.metadata` y `chunks.metadata`.

### Diagrama del grafo propuesto

```text
START
  ↓
detect_document_type  (3.1)
  ↓
build_candidate_tree  (prompt parametrizado por tipo)
  ↓
verify_tree
  ↓
[router]              (3.3)
  ├─ accuracy >= 0.95 → post_process_tree
  ├─ 0.6 <= acc < 0.95 → repair_sections → verify_tree
  └─ acc < 0.6 → degrade_mode → build_candidate_tree
       (max 1 degradacion, sino fail)
  ↓
post_process_tree
  ↓
refine_large_nodes    (3.2)
  ↓ [si refined=true, vuelve a verify]
[fan-out Send]        (3.7)
  ↓
summarize_one_node × N
  ↓
collect_summaries
  ↓
summarize_routing     (3.4)
  ↓
embed_hierarchy       (3.6)
  ↓
END
```

Todo con `AsyncPostgresSaver` (3.5) checkpointeando entre nodos.

### Resumen ejecutable de la seccion

| # | Mejora | Beneficio principal | Costo |
|---|---|---|---|
| 3.1 | `detect_document_type` | Arbol mejor por tipo | 1 LLM call extra (~500 tok) |
| 3.2 | `recursive_refinement` | Granularidad en docs grandes | LLM calls por nodo refinable |
| 3.3 | `repair_or_degrade` | No abortar accuracy 0.6-0.95 | 1 LLM call cuando aplica |
| 3.4 | `routing_summary` separado | Retrieval por intencion | +1 columna SQL, +1 nodo |
| 3.5 | Checkpointing Postgres | 80% menos LLM en retries | Migracion menor, dep nueva |
| 3.6 | Embeddings jerarquicos | Habilita el chat agent | ~0.02 USD/doc |
| 3.7 | Fan-out con `Send` | Resumibilidad fina | Refactor de summarize |
| 3.8 | Eventos directos desde Python | UI live granular | Worker emite Inngest events |
| 3.9 | Type-aware retrieval | Preparacion del agente | Solo persistencia |

---

## 4. CLI propia: `sda`

Hoy hay **12 comandos NPM** en `package.json:7-22`. Cada uno hace una cosa
chica y el operador encadena varios a mano. La CLI propuesta agrupa flujos
completos en supercomandos con UX bonita.

### Estado de ejecucion — 2026-05-21

- [x] 4.1 Stack y filosofia: implementado con `citty`, `@clack/prompts`,
  `picocolors`, entrypoint `bin/sda.mjs` y bins `sf`, `sdf`, `sda`,
  `sdaframework`.
- [x] 4.2 `sda doctor`: implementado; unifica env doctor, secret scan,
  Upstash, Inngest, Compute Gateway, versiones y `--deep` para indexing. Atajo:
  `sf d`.
- [x] 4.3 `sda ship`: implementado; corre lint/typecheck/build, stage
  interactivo, commit y push con `--no-push` / `--skip-checks`.
- [x] 4.4 `sda deploy`: implementado para `gateway`, `tree` y `all`, con
  comparacion local/remota de versiones, `--diff`, `--version` y healthcheck.
  Atajo seguro: `sf dp` muestra versiones.
- [x] 4.5 `sda indexing`: implementado con `list`, `health`, `tail`,
  `cancel` y `requeue` con despacho Inngest. Atajos: `sf i`, `sf i t`, `sf i rq`.
- [x] 4.6 `sda invite`: implementado con create directo (`sda invite
  email@dominio.com`), `owner`, `list`, `revoke` y `resend`. Atajo:
  `sf v email@dominio.com`.
- [x] 4.7 `sda db`: implementado con `diff`, `push`, `test`, `reset` y
  `migrate`.
- [x] 4.8 `sda redis`: implementado con `ping`, `ls`, `get`, `del`,
  `flush --namespace` y `snapshot`. Atajo: `sf r`.
- [x] 4.9 `sda dev`: implementado; arranca Next + Inngest dev, con opciones
  `--tunnel` y `--tail-logs`.
- [x] 4.10 `sda init`: implementado; verifica deps, escribe `.env.local`,
  corre `sda doctor --quick` y opcionalmente `types:gen`.

### 4.1 Stack y filosofia

- **Runtime:** Node nativo, mismo entorno que el resto del repo. Sin Go ni
  Rust; no queremos otro toolchain.
- **Framework:** `citty` (de UnJS). Mas liviano que `commander`, type-safe,
  nested commands de primera clase. Alternativa: built-in
  `node:util.parseArgs` si queremos cero dependencias (perdemos auto-help).
- **UX:** `@clack/prompts` para prompts interactivos (spinner, multiselect,
  confirm) + `picocolors` para color. Ambas son minimas (~10kb total).
- **Distribucion:** se instala con `npm link` localmente o como bin en
  `package.json:"bin": { "sda": "./bin/sda.mjs" }`. No publicamos a npm, queda
  workspace-local.

Estructura propuesta:

```text
cli/
  bin/sda.mjs           (entry, ~20 LOC)
  commands/
    doctor.mjs
    ship.mjs
    deploy.mjs
    indexing.mjs
    invite.mjs
    db.mjs
    redis.mjs
    dev.mjs
  shared/
    config.mjs          (carga .env.local con env-loader)
    spinner.mjs         (wrapper clack)
    supabase.mjs        (admin client compartido)
```

### 4.2 `sda doctor` — health check completo

Hoy para chequear "esta todo OK?" hace falta correr:

```bash
npm run secrets:scan
npm run env:doctor
npm run redis:health
npm run indexing:health
```

4 comandos, 4 outputs distintos, cada uno con un JSON distinto.

Propuesta:

```bash
sda doctor                # rapido (env + redis + version registry)
sda doctor --deep         # agrega indexing health (consulta DB)
sda doctor --json         # output structurado para CI
```

Output rendereado:

```text
SDA Doctor
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Env             ✓  20 vars OK, 3 info (gateway/oauth no local)
Supabase URL    ✓  anfawvxfepowsudlffnl.supabase.co
Redis           ✓  PONG (12ms) · prefix=sda:local
Inngest         ✓  signed-key configured · 2 functions registered
Compute Gateway ⚠  COMPUTE_GATEWAY_URL not set (queue stays pending)
Versions        ✓  app=0.1.6 · indexing=0.1.7 · tree=0.1.3
Indexing        ✓  0 anomalies · 3 docs indexed
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1 warning, 0 errors
```

Internamente invoca los scripts adelgazados (seccion 2.4-2.5).

### 4.3 `sda ship` — typecheck + lint + build + push

Hoy para deployar un cambio se corre:

```bash
npm run lint
npm run typecheck
npm run build
git add .
git commit -m "..."
git push
```

6 pasos, 3 errores posibles en checks.

Propuesta:

```bash
sda ship                  # interactivo: pide commit message si hay cambios staged
sda ship -m "..."         # no interactivo
sda ship --no-push        # solo commit
sda ship --skip-checks    # emergencia (warning visible)
```

Flujo:

1. Detecta si la branch es `main` y avisa
2. Corre `lint`, `typecheck` y `build` en paralelo (todos independientes; falla
   rapida si uno trona)
3. Si hay cambios sin commit, abre `@clack/prompts` con multiselect de
   archivos modificados y pide commit message
4. Push a la branch actual
5. Si la branch tiene PR abierto, muestra link

Beneficio: 1 comando en vez de 7. Falla rapido si hay algo mal.

### 4.4 `sda deploy <worker>` — deploy seguro a srv-ia-01

Hoy:

```bash
cd workers/compute-gateway && ./deploy.sh
# o
cd workers/tree-indexer-python && ./deploy.sh
```

Sin safety checks. Si la branch local difiere de la deployada, no avisa.

Propuesta:

```bash
sda deploy gateway        # alias de compute-gateway
sda deploy tree           # alias de tree-indexer-python
sda deploy all            # ambos en orden (gateway primero, tree segundo)
sda deploy --diff         # muestra que cambio vs el servicio actual sin deployar
sda deploy --version      # imprime versions remotas y locales antes de deployar
```

Antes de correr `./deploy.sh`:

1. SSH al server, leer version actual del `.env` remoto
2. Comparar con `lib/system-versions.json` local
3. Si la local es **menor**, abortar (downgrade)
4. Si la local es **igual**, preguntar "ya estas en esta version, deployar de
   todos modos?"
5. Tras deploy exitoso, hace healthcheck (`curl` autenticado al endpoint) y
   muestra "version reportada: X.Y.Z"

### 4.5 `sda indexing` — operaciones sobre runs

Hoy para reindexar un documento hay que abrir Supabase Studio, marcar la
corrida como `failed` a mano, y disparar la API. O usar Inngest UI.

Propuesta:

```bash
sda indexing list                          # ultimos 20 runs con status
sda indexing list --failed                 # solo fallidos
sda indexing requeue <document-id>         # marca run actual como failed + redispatch
sda indexing requeue --all-failed          # bulk
sda indexing tail <document-id>            # sigue events en realtime (Supabase subscribe)
sda indexing cancel <run-id>               # cancela activo
sda indexing health                        # alias de doctor --deep para indexing
```

`sda indexing tail` usa Supabase Realtime y renderea events live con
`picocolors`:

```text
$ sda indexing tail 2e1c2b6b-e608-461a-aab7-1f4c4c34f408

queued     0%   indexing.run.queued                Documento en cola
extracting 5%   indexing.compute_gateway.dispatching  Enviando documento al Compute Gateway
extracting 8%   indexing.compute_gateway.job_created  job=63d9abe4
extracting 20%  indexing.compute_gateway.progress     stage=mineru_extraction
structuring 35% indexing.extract.completed            48 artifacts uploaded
structuring 40% indexing.tree.started                 indexer=sda-pageindex-python-v0.1.3
structuring 60% indexing.tree.candidate_completed     11 sections
indexed    100% indexing.tree.completed               chunks=11 model=gemini-3.5-flash
```

### 4.6 `sda invite` — gestion de invitaciones desde shell

Hoy hay `npm run bootstrap:owner-invite` que requiere `INVITE_EMAIL` en env.
Y revocacion solo desde UI.

Propuesta:

```bash
sda invite owner <email>                   # crea owner invite (service role)
sda invite <email> --role admin            # admin/member/viewer
sda invite list                            # pending invites del tenant
sda invite revoke <invite-id-or-email>     # revoca por id o email
sda invite resend <invite-id>              # genera nuevo token, marca el viejo como revoked
```

`resend` cierra un caso que hoy no existe: invite caducado pero email valido.

### 4.7 `sda db` — operaciones de base

```bash
sda db diff                                # diff de schema local vs remoto (wrapper supabase)
sda db push                                # supabase db push --linked --yes con safety
sda db test                                # corre los 5 pgTAP tests, output bonito
sda db reset --confirm                     # reset local con confirmacion fuerte
sda db migrate <name>                      # crea migracion timestampada nueva
```

`sda db push` antes de pushear:

1. Lee migraciones aplicadas remotas
2. Compara con `supabase/migrations/` local
3. Muestra lista de migraciones nuevas que va a aplicar
4. Confirm

Esto reemplaza `supabase db push --linked --yes`, agregando preview.

### 4.8 `sda redis` — operaciones Redis

```bash
sda redis ping                             # health (alias de redis-health)
sda redis ls <pattern>                     # lista keys con prefijo del ambiente
sda redis get <key>                        # imprime valor (json formatted)
sda redis del <key>                        # borra key
sda redis flush --namespace                # borra solo claves con UPSTASH_REDIS_KEY_PREFIX
sda redis snapshot                         # imprime ultimo indexing-latest snapshot
```

Hoy no hay forma de ver que hay en Redis sin abrir Upstash dashboard.

### 4.9 `sda dev` — entorno de desarrollo unificado

Hoy para desarrollo local hace falta:

1. `npm run dev` (Next)
2. En otra terminal: `npx inngest-cli@latest dev` (Inngest dev server,
   no esta en `package.json`)
3. En otra: ngrok o cloudflared para exponer localhost si se prueba Inngest
   cloud

`inngest-cli` se invoca via `npx`; alternativamente agregar como `devDependency`
para evitar descarga repetida.

Propuesta:

```bash
sda dev                                    # arranca todo en una sola consola
sda dev --tunnel                           # agrega cloudflared tunnel publico
sda dev --tail-logs                        # con tail de indexing events
```

Usa `concurrently` o `pm2-runtime` para multi-process. Renderea en columns:

```text
[next     ] ✓ Compiled /login in 234ms
[next     ] GET /login 200 in 89ms
[inngest  ] ▷ document/index.requested dispatched
[inngest  ] ✓ process-document-index ran in 1.2s
[tunnel   ] https://feed-fish-laugh-sale.trycloudflare.com -> localhost:3000
```

### 4.10 Comando de bootstrap del proyecto

```bash
sda init                                   # primer setup: link supabase, gen types, .env.local
```

Para un dev nuevo en el repo, hoy hay que leer 3 docs para arrancar
(`docs/backend/07-operacion-env-health.md`, `supabase/google-oauth.md`,
`README.md`). El comando hace:

1. Verifica deps (node, supabase cli, python, MinerU si aplica)
2. Pregunta si tiene un proyecto Supabase existente o crea uno
3. Pide envs criticas con `@clack/prompts` (URL, service key)
4. Escribe `.env.local` validandolo con `sda doctor --quick`
5. Corre `supabase gen types` y guarda en la ubicacion actual de
   `lib/supabase/` (o `lib/auth/supabase/` si ya se aplico el refactor 1.2)
6. Imprime "todo listo, corre `sda dev`"

### Resumen ejecutable de la seccion

| Comando | Reemplaza | Chats ahorrados |
|---|---|---|
| `sda doctor` | 5 npm scripts | 4 |
| `sda ship` | 7 pasos manuales | 6 |
| `sda deploy gateway/tree` | `cd + ./deploy.sh` + safety | 2 + bugs evitados |
| `sda indexing requeue` | Studio + manual SQL | 5+ |
| `sda indexing tail` | (no existe hoy) | feature nueva |
| `sda invite resend` | (no existe hoy) | feature nueva |
| `sda dev` | 2-3 terminales | 2 |
| `sda init` | leer 3 docs + 10min | 10min para devs nuevos |

Estimacion rough: una sesion tipica de operacion baja de ~15 comandos a 3-4
(no medido, es a ojo en base a flujos comunes).

### Notas de implementacion

- El `package.json` puede mantener los scripts viejos como aliases hacia el
  CLI: `"test:db": "sda db test"`, etc. No es necesario romper compat.
- El CLI lee config con el mismo `env-loader.mjs` de los scripts. Cero
  duplicacion de carga de envs.
- Tests del CLI con `node --test` (built-in). No agregar Jest/Vitest solo para
  esto.

---

## 5. Mejoras de DB y caching

Trabajamos sobre Supabase Postgres 17 (`supabase/.temp/postgres-version`).
Hay margen para mejor modelado, indices que faltan, y caching mas barato.

### Estado de ejecucion — 2026-05-21

| Punto | Estado | Progreso |
|---|---|---|
| 5.1 | implementado | `doc_tree_nodes` agregado con `ltree`, RLS, backfill desde `doc_tree`, indices de path/vector/metadata/routing summary y persistencia desde el worker Python. Se mantiene `chunks` como contrato compatible. |
| 5.2 | diferido | Particionado mensual de `indexing_events` queda fuera de esta tanda por ser una migracion costosa con Realtime/RLS/publication; se implementan indices y cleanup TTL como mitigacion segura. |
| 5.3 | implementado | `cleanup_operational_data()` borra invites revocadas, eventos viejos y audit log viejo; `pg_cron` se programa best-effort si la extension esta disponible, sin romper Free plan. |
| 5.4 | implementado | Agregados indices faltantes para `documents`, `indexing_events.metadata`, `chunks.node_path`, `chunks.content` trigram y `chunks.metadata->document_type`. |
| 5.5 | no aplica | La seccion 2.1 ya elimino el hot path DB de versiones; no queda cachear `system_component_versions`. |
| 5.6 | implementado | `indexing_health_snapshot` materialized view + RPC de refresh; `indexing-health` y `sda doctor --deep` usan cache por default con `--no-cache` / `--refresh-cache`. |
| 5.7 | verificado parcial | RLS y grants de `indexing_runs`/`indexing_events` siguen filtrando por tenant; falta confirmacion manual del toggle de Realtime Authorization en el dashboard de Supabase. |
| 5.8 | implementado | Ya cubierto por 2.6: `lib/documents/detail.ts` usa `unstable_cache` + `revalidateTag` con query admin filtrada por `tenantId`. |
| 5.9 | diferido | No se activa Edge runtime todavia: requiere preview deploy validando `@supabase/ssr` 0.10.3 en Edge antes de produccion. |
| 5.10 | implementado | Preparacion retrieval agregada sobre `doc_tree_nodes` y `chunks` con indices por tipo, metadata, trigram y vector. |

### 5.1 Normalizar `doc_tree` a tabla relacional `doc_tree_nodes`

Hoy `doc_tree.tree` es un campo `jsonb`
(`supabase/migrations/20260520145604_core_multitenant_schema.sql:133-146`).
Para encontrar "todos los nodos cuyo `routing_summary` mencione X" hay que:

1. Leer el JSON entero del documento
2. Parsearlo en Node
3. Filtrar en memoria

No escala. Cuando el chat agent (seccion 3.9) haga retrieval sobre **decenas
de miles de docs**, esto es prohibitivo.

Propuesta: agregar tabla relacional manteniendo `doc_tree.tree` como
**cache** del arbol completo. Requiere habilitar `ltree`:

```sql
create extension if not exists ltree;

create table public.doc_tree_nodes (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  document_id uuid not null,
  parent_id uuid references public.doc_tree_nodes(id) on delete cascade,
  node_id text not null,                  -- "0000", "0001" etc
  node_path ltree not null,               -- "0000.0001.0002" usando extension ltree
  node_type text not null default 'section',
  title text not null,
  summary text,
  routing_summary text,
  page_start integer not null,
  page_end integer not null,
  confidence numeric(3,2),
  origin text check (origin in ('explicit', 'visual', 'inferred', 'fallback')),
  embedding extensions.vector(1536),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, document_id)
    references public.documents(tenant_id, id)
    on delete cascade,
  unique (tenant_id, document_id, node_id)
);

create index doc_tree_nodes_tenant_document_idx
  on public.doc_tree_nodes (tenant_id, document_id);

-- ltree GIST para queries como "todos los descendientes de 0001":
create index doc_tree_nodes_path_idx
  on public.doc_tree_nodes using gist (node_path);

-- vector index para retrieval por routing_summary:
create index doc_tree_nodes_embedding_hnsw_idx
  on public.doc_tree_nodes
  using hnsw (embedding extensions.vector_cosine_ops)
  where embedding is not null;
```

Beneficios:

- Query "todos los chapter de docs del tenant X" → `where node_type='chapter'`.
- Query "subarbol de un nodo" → ltree `node_path <@ '0000.0001'`.
- Retrieval semantico → vector similarity directo sin parseo JSON.
- Cada nodo es FK directa a documento, no escondido en JSON.

`chunks` queda como **vista materializada** sobre `doc_tree_nodes`, o se
elimina (los chunks son redundantes con nodos). Decision: eliminar `chunks`
porque hoy ya repite info del arbol (`workers/tree-indexer-python/app/pageindex_style.py:318-338`).

### 5.2 Particionar `indexing_events` por mes

`indexing_events` crece sin bound. Hoy hay 80 events por documento (default
`limit 80` en `app/app/documents/[id]/page.tsx:135-137`). En 1 ano con 10k
docs: 800k filas. Postgres lo aguanta pero las queries de la UI degradan.

Propuesta: particionar por mes.

```sql
-- Migracion (operacion costosa, hacer fuera de rush):
create table public.indexing_events_new (like public.indexing_events including all)
  partition by range (created_at);

create table public.indexing_events_2026_05
  partition of public.indexing_events_new
  for values from ('2026-05-01') to ('2026-06-01');
-- ... una por mes

-- Mover datos, hacer rename atomico
```

Plus: `pg_cron` para crear particiones del mes siguiente automaticamente:

```sql
select cron.schedule('partition-indexing-events', '0 0 28 * *', $$
  -- crea particion del mes siguiente
$$);
```

Y borra particiones de mas de 6 meses (audit log si quiere mantenerse, copia a
`audit_log` o archivo).

### 5.3 `pg_cron` para limpieza programada

Supabase soporta `pg_cron` con extension en planes Pro+. **Verificar plan
del proyecto antes de adoptar.** En plan Free no esta disponible; alternativa
es un cron externo (GitHub Actions schedule) que llame una RPC de cleanup.

Tareas que hoy no existen:

- Borrar `tenant_invites` revocadas con `updated_at < now() - interval '90 days'`
- Borrar `indexing_events` de hace mas de 6 meses (despues de partition)
- Borrar `audit_log` con `created_at < now() - interval '2 years'`
- Refrescar materialized view de health (ver 5.6)

```sql
-- migracion
create extension if not exists pg_cron;

select cron.schedule('cleanup-revoked-invites', '0 4 * * *', $$
  delete from public.tenant_invites
  where status = 'revoked' and updated_at < now() - interval '90 days'
$$);
```

Hoy estas tablas crecen indefinidamente.

### 5.4 Indices que faltan

Reviso indices existentes vs queries del codigo:

**Falta:** `indexing_events.metadata` GIN. La query
`app/app/documents/[id]/page.tsx:130-137` no lo necesita, pero el reconciler
(`inngest/functions/reconcile-document-indexing.ts:528-554`) consulta por
metadata. Hoy hace full scan filtrado.

```sql
create index indexing_events_metadata_gin_idx
  on public.indexing_events using gin (metadata jsonb_path_ops);
```

**Falta:** `chunks.node_path` GIN (si decidimos mantener `chunks`).

```sql
create index chunks_node_path_gin_idx
  on public.chunks using gin (node_path);
```

**Falta:** `documents (tenant_id, created_at)` para listado paginado. Hoy
existe `documents_tenant_status_created_idx (tenant_id, status, created_at)`
pero filtra por status. Para "ultimos docs del tenant" sin filtro:

```sql
create index documents_tenant_created_idx
  on public.documents (tenant_id, created_at desc);
```

(verificar primero con `pg_stat_statements` que la query existe; si no, no
agregar el indice).

### 5.5 Cache de `system_component_versions` (solo si NO se acepta 2.1)

> **Nota:** este item es **redundante con 2.1**. Si se acepta 2.1 (eliminar
> la dualidad fuente de versiones), 5.5 desaparece. Listo aqui por si se
> elige mantener la tabla DB y solo optimizar el hot path.

Hoy `request_document_indexing`
(`supabase/migrations/20260521015500_request_document_indexing_latest_versions.sql:44-56`)
hace `select coalesce(jsonb_object_agg(...))` en cada request. Esa tabla
cambia 1 vez por deploy.

Propuesta intermedia (si la tabla se mantiene):

- En Vercel, una env var `BUILD_VERSIONS` con el JSON serializado de versiones
  al momento del build.
- `request_document_indexing` recibe versiones via `_metadata` (ya lo hace).
- DB solo se consulta como **fallback** si el cliente no las pasa.

Resultado: 0 queries a `system_component_versions` en hot path.

### 5.6 Vista materializada para `sda doctor --deep`

`scripts/indexing-health.mjs` (433 LOC) corre 7 selects pesados cada vez. Si
lo invocamos seguido (CI, cron, monitoreo), satura DB.

Propuesta: materialized view refrescable cada 5min. Si `pg_cron` esta
disponible (ver 5.3), refrescar con scheduler interno; si no, agregar un
GitHub Actions schedule que dispare `refresh materialized view ...` via
service role.

```sql
create materialized view public.indexing_health_snapshot as
  select
    now() as snapshotted_at,
    jsonb_build_object(
      'documents_by_status', (select jsonb_object_agg(status, c)
                              from (select status, count(*) c from documents group by status) s),
      'runs_by_status', ...,
      'anomalies', ...
    ) as data;

create unique index on public.indexing_health_snapshot (snapshotted_at);

select cron.schedule('refresh-indexing-health', '*/5 * * * *', $$
  refresh materialized view concurrently public.indexing_health_snapshot;
$$);
```

`sda doctor --deep` lee la MV, no recalcula. Si necesita freshness, pasa
`--no-cache` y refresca on-demand.

### 5.7 Realtime: confirmar que RLS filtra al cliente

Hoy
`supabase/migrations/20260520203000_indexing_live_runs_events.sql:231-255`
agrega la tabla entera a `supabase_realtime`. El cliente
(`components/documents/indexing-timeline.tsx:120-170`) filtra del lado
cliente con `filter: document_id=eq.${documentId}`.

Supabase Realtime **respeta RLS** desde 2024 cuando se usan los policies
estandar (Realtime Authorization). El cliente recibe solo filas que pase la
policy `select` del tenant; el `filter:` cliente reduce mas aun por
documento.

Accion: **verificar manualmente** que Realtime esta configurado para
respetar RLS en este proyecto. Si lo hace, el setup actual es correcto y no
hay propuesta de cambio. Si no, activar Realtime Authorization en el
dashboard de Supabase (no requiere migracion).

Nota: este item quedo como `verificar`, no es una propuesta concreta de
cambio. Eliminar de la tabla resumen si tras verificacion no hace falta
nada.

### 5.8 Caches de Next.js (Data Cache + revalidateTag)

Hoy las queries en server components no cachean nada (`dynamic = "force-dynamic"`
en `app/app/documents/page.tsx:38`, `app/app/page.tsx:34`, etc.). Pasar a
cache reduce queries a Supabase.

**Esto requiere refactor de la lectura de auth.** Hoy
`createClient()` lee `cookies()` adentro, y cualquier funcion que use cookies
**no es cacheable**. Para que la cache funcione:

1. La auth se hace en el server component (fuera del cache):
   ```ts
   const { tenantId, documentId } = await requireSession(params);
   ```
2. La query se separa en una funcion que recibe `tenantId` y `documentId`
   como argumentos (no lee cookies):
   ```ts
   const getDocumentDetail = unstable_cache(
     async (documentId, tenantId) => { /* queries con admin client + filter manual */ },
     ["document-detail"],
     { tags: (id) => [`doc:${id}`], revalidate: 60 }
   );
   ```
3. Cuando una RPC cambia el documento, invalida:
   ```ts
   await revalidateTag(`doc:${documentId}`);
   ```

Caveat: como la query corre fuera de la sesion del usuario, **RLS no se
aplica automaticamente**. Hay que usar admin client (service role) y filtrar
manualmente por `tenantId`. Eso es seguro porque `tenantId` viene del JWT
verificado por `requireSession`.

Next 16 tambien introdujo `'use cache'` (Cache Components) como API mas nueva.
`unstable_cache` sigue funcionando y es lo mas estable hoy; si Cache
Components madura, migrar despues.

Beneficio: para el detalle del documento en estados terminales, **0 queries
a Supabase** en hits cacheados.

Riesgo: medio. El refactor pasa la responsabilidad de filtrar por tenant del
RLS al codigo de la query. Si alguien copia la query y olvida el filtro
manual, fuga cross-tenant.

### 5.9 Edge runtime para handlers chicos

`app/api/inngest/route.ts:7-8` declara `runtime = "nodejs"` con
`maxDuration = 60`. Inngest necesita Node, OK.

Candidatos a `runtime = "edge"` (no usan APIs Node-only):

- `app/auth/callback/route.ts`
- `app/auth/sign-out/route.ts`
- `app/app/documents/[id]/download/route.ts`

Beneficios potenciales:

- Latencia menor en regiones lejos de la region principal de Vercel
- Cold start despreciable
- Costo menor por invocacion

Pre-requisito: **verificar que `@supabase/ssr` 0.10.3** (la version en
`package.json:30`) funciona en edge runtime. Edge no soporta todas las APIs
Node; en versiones viejas del paquete habia problemas. Probar en preview
deploy antes de pasar a prod.

### 5.10 Indices SQL para retrieval futuro (preparacion del agente)

Hoy `chunks.embedding` tiene HNSW (`supabase/migrations/20260520145604:320-323`).
Falta:

- Indice combinado `(tenant_id, node_type)` en `doc_tree_nodes` (cuando exista) para
  "buscar solo en chapters".
- Indice GIN sobre `chunks.metadata` para filtros por document_type, parser, etc.
- `pg_trgm` extension + indice trigram sobre `chunks.content` para FTS rapido
  con typos. Hoy hay tsvector pero requiere match exacto.

```sql
create extension if not exists pg_trgm;

create index chunks_content_trgm_idx
  on public.chunks using gin (content extensions.gin_trgm_ops);
```

### Resumen ejecutable de la seccion

| # | Cambio | Beneficio | Riesgo |
|---|---|---|---|
| 5.1 | `doc_tree_nodes` relacional + ltree + pgvector | Retrieval queryable | Medio (migra datos) |
| 5.2 | Particionar `indexing_events` | Escala a 1M+ filas | Medio |
| 5.3 | `pg_cron` para cleanup | TTL automatico | Bajo |
| 5.4 | Indices faltantes | Queries especificas mas rapidas | Bajo |
| 5.5 | Cache de versiones en proceso | 0 queries hot path | Bajo |
| 5.6 | MV `indexing_health_snapshot` | doctor barato | Bajo |
| 5.7 | Filtrado Realtime por RLS | Menos ruido al cliente | Bajo |
| 5.8 | `unstable_cache` con tags | 0 queries hits cacheados | Bajo |
| 5.9 | Edge runtime para handlers chicos | Latencia menor | Bajo |
| 5.10 | Indices para retrieval futuro | Habilita chat agent | Bajo |

---

## 6. Limpieza, reestructuracion y fixes

Cosas que estan mal hechas, son legacy, o duplican otra mejor.

### 6.1 Renombrar `r2_bucket` / `r2_key` (legacy naming)

R2 fue considerado en arquitectura temprana
(`docs/arquitectura.md:163`: "Cloudflare R2 sigue siendo buen upgrade"), pero
**nunca se uso**. Hoy esas columnas apuntan a Supabase Storage.

Apariciones:

- `documents.r2_bucket`, `documents.r2_key` (`supabase/migrations/20260520145604_core_multitenant_schema.sql:119-120`)
- En todo el codigo: `lib/documents.ts:22-23`, `app/app/documents/page.tsx:57`,
  `app/app/documents/[id]/download/route.ts:21,31-32`,
  `inngest/functions/process-document-index.ts:209,237,332,378`, etc.

Propuesta: rename a `storage_bucket` / `storage_path`.

Migracion segura (no breakage):

```sql
-- Migration 1: agregar columnas nuevas + populated por trigger
alter table public.documents
  add column storage_bucket text generated always as (r2_bucket) stored,
  add column storage_path text generated always as (r2_key) stored;

-- Migration 2: deploy app con uso de las nuevas columnas (lee de generated)

-- Migration 3: deprecate de las viejas: convertir a generated cols al reves
-- (luego de que app NO use mas r2_bucket/r2_key)

-- Migration 4: drop r2_bucket/r2_key
```

Mientras tanto, lectura sigue funcionando porque `generated always as`
mantiene sync.

Bonus: `documents.metadata` puede recibir un campo `storage_provider`
(`'supabase' | 'r2'`) si en el futuro hacemos multi-provider — no requiere
esquema cambiado.

### 6.2 Eliminar `scripts/inngest-sync.mjs` o estandarizar en CI

Hay **dos paths** para sincronizar Inngest:

- `scripts/inngest-sync.mjs` (corre localmente con `INNGEST_API_KEY`)
- `.github/workflows/inngest-sync.yml` (corre en GitHub Actions tras deploy)

El workflow YAML hace **exactamente lo mismo** que el script Node, solo con
curl. Tener ambos invita a drift.

Propuesta: borrar el script local. Si alguien necesita sync manual, usar
`workflow_dispatch` del workflow desde GitHub UI o `gh`:

```bash
gh workflow run "Sync Inngest"
```

Ahorro: 78 LOC en `scripts/inngest-sync.mjs`. Un script menos en
`package.json`.

### 6.3 RETIRADO — `supabase/.temp/*` ya no esta en git

> **Premisa erronea en la version original del informe.** Verificado con
> `git ls-files supabase/.temp/`: la carpeta esta correctamente ignorada y
> ningun archivo .temp esta trackeado. Los archivos existen en el filesystem
> local pero no en git.
>
> El item completo se elimina. No hay accion requerida.

### 6.4 Separar tipos de UI en `lib/documents.ts`

`lib/documents.ts:1-148` mezcla:

- Tipos DB: `DocumentRow`, `IndexingRunRow`, `IndexingEventRow`,
  `DocumentStatus`, `IndexingStage`
- Helpers UI: `formatBytes`, `documentStatusTone`, `documentStatusLabel`,
  `indexingStageLabel`, `indexingRunTone`

Cuando el agente futuro consuma tipos (server-side), no quiere arrastrar
labels en castellano. Separar:

```text
lib/documents/
  types.ts       (interfaces DB - sin imports de UI)
  format.ts      (helpers de display)
  index.ts       (re-export para compat retroactiva)
```

Cero cambios en imports si `lib/documents/index.ts` re-exporta todo.

### 6.5 `app/auth/sign-out/route.ts` no debe ser GET

`docs/gotchas.md:84-87` documenta el bug que provoco esta decision:
`next/link` con prefetch puede llamar la ruta antes de que el user clickee.
Solucion actual: usar `<a>` plano (`components/dashboard/app-topbar.tsx:66-69`).

Esto **arregla el sintoma**, no la causa. Una ruta que cierra sesion no debe
ser GET segun spec HTTP (idempotencia). Si manana otro componente vuelve a
usar `next/link`, el bug regresa.

Propuesta: cambiar a `POST`.

```ts
// app/auth/sign-out/route.ts
export async function POST(request: NextRequest) { /* same code */ }
```

El topbar pasa de `<a href>` a `<form action="/auth/sign-out" method="POST">`:

```tsx
<form action="/auth/sign-out" method="POST">
  <button type="submit" className="nav-item nav-signout">
    <LogOut size={16} /> Salir
  </button>
</form>
```

Visual identico, conducta robusta.

### 6.6 `lib/system-versions.ts` mezclado con metadata derivada

`lib/system-versions.ts:20-38` exporta tres constructs:

- `SYSTEM_COMPONENT_VERSIONS` (datos)
- `TREE_INDEXER_PYTHON_VERSION` (string compuesto)
- `INDEXING_VERSION_COLUMNS`, `INDEXING_VERSION_METADATA` (derivados)

Si pasamos a JSON (seccion 2.1), los derivados quedan en un `.ts` que solo
exporta computed. Mas limpio.

```ts
// lib/indexing/versions.ts
import versions from "./versions.json" assert { type: "json" };

export const SYSTEM_COMPONENT_VERSIONS = versions;
export const TREE_INDEXER_PYTHON_VERSION =
  `sda-pageindex-python-langgraph-v${versions.tree_indexer_python}`;
// ...
```

Python lee el mismo JSON con `json.load`. Una fuente, dos consumidores.

### 6.7 `app/api/documents/[id]/indexing/request/route.ts` complejidad excesiva

193 LOC para una operacion que conceptualmente es "request indexing":

- rate limit
- RPC call
- cache invalidation
- lock acquire
- backpressure reserve
- inngest send
- heartbeat record
- error rollback (release lock + release slot)

Eso es **8 efectos en una sola ruta**. Si falla cualquiera, el rollback es
manual y propenso a desincronizacion.

Propuesta: refactorizar como un **pipeline transaccional**.

```ts
// app/api/documents/[id]/indexing/request/route.ts (~40 LOC)
export async function POST(request: Request, { params }) {
  const { id } = await params;
  const source = await readSource(request);
  const session = await requireSession(request);

  return withIndexingGuards({ documentId: id, tenantId: session.tenantId, actorId: session.actorId }, async () => {
    const run = await requestDocumentIndexing(id, source);
    await dispatchIndexingEvent(run, source);
    return run;
  });
}
```

Donde `withIndexingGuards` (helper nuevo en `lib/indexing/guards.ts`) hace
rate limit + lock + backpressure y libera todo automaticamente en finally.

Hoy esa logica esta inline. Ese helper es reusable para el reconciliador
tambien.

### 6.8 Reconciliador: queries duplicadas

`inngest/functions/reconcile-document-indexing.ts` tiene dos funciones que
empiezan con el mismo patron:

- `completeRunsWithPersistedTree` (`:150-311`) carga active runs
- `failIncompleteUploadRuns` (`:313-390`) carga active runs (otra vez)
- `loadStaleRunningRuns` (`:583-674`) carga active runs (otra vez)

Cada una llama `loadActiveRuns(limit)`. Son 3 queries identicas en cada tick.

Propuesta: cargar una vez al inicio del cron, pasar la lista a las 3 funcs.

```ts
const activeRuns = await loadActiveRuns(batchSize * 3);
const repaired = await completeRunsWithPersistedTree(activeRuns);
const failed = await failIncompleteUploadRuns(activeRuns);
const stale = filterStale(activeRuns, getStaleRunningMinutes());
```

Ahorro: 2 queries por tick. Y mas claro el flujo.

### 6.9 `app/page.tsx` redirect redundante

```tsx
// app/page.tsx
import { redirect } from "next/navigation";
export default function HomePage() { redirect("/app"); }
```

5 LOC. Next 16 permite hacerlo en `next.config.mjs`:

```js
export default {
  reactStrictMode: true,
  async redirects() {
    return [{ source: "/", destination: "/app", permanent: false }];
  }
};
```

Misma conducta, sin route handler. Borra `app/page.tsx`.

### 6.10 `next-env.d.ts` autogenerado

`next-env.d.ts:1-7` dice "should not be edited". Pero esta en git. Next lo
regenera cada build. Trackearlo crea conflictos en PRs (`Next 16.2.6` lo
modifica al actualizar versiones).

`.gitignore` deberia incluirlo. Pero ojo: Next docs sugieren mantenerlo para
TS strict. Verificar primero si CI rompe sin el (no rompe; lo regenera).

Recomendacion: agregar a `.gitignore`, dejar que Next lo regenere.

### 6.11 `docs/sda-tree-index-live-architecture.md` duplica `docs/arquitectura.md`

`docs/arquitectura.md:5-8`:

> La especificacion de indexacion estructural vive en
> `docs/sda-tree-index-live-architecture.md`.

Pero ambos archivos tienen contenido **muy similar** sobre el pipeline de
indexacion, fases, decisiones de modelo, etc.

Propuesta: dejar solo `docs/arquitectura.md` (el general) y mover los
detalles especificos no cubiertos a:

- `docs/backend/04-indexacion-inngest.md` (que ya existe)
- `docs/backend/05-workers-compute-tree-indexer.md` (que ya existe)

Borrar `docs/sda-tree-index-live-architecture.md` (631 LOC duplicadas).

### 6.12 RETIRADO — `tsconfig.tsbuildinfo` ya no esta en git

> **Premisa erronea en la version original del informe.** Verificado con
> `git ls-files | grep tsbuildinfo`: el archivo no esta trackeado. El
> `.gitignore:10` lo excluye correctamente.
>
> El item completo se elimina. No hay accion requerida.

### Resumen ejecutable de la seccion

| # | Limpieza | Tipo | LOC/ruido | Riesgo |
|---|---|---|---|---|
| 6.1 | Rename r2_bucket → storage_bucket | Migracion multi-step | -30 menciones legacy | Medio |
| 6.2 | Borrar inngest-sync local | Borrado | -78 | Bajo |
| 6.3 | ~~Git rm supabase/.temp~~ | **RETIRADO** (premisa erronea) | — | — |
| 6.4 | Partir lib/documents.ts | Refactor | -0 (solo split) | Bajo |
| 6.5 | sign-out: GET → POST | Fix de seguridad/correctness | -1 gotcha | Bajo |
| 6.6 | system-versions a JSON puro | Refactor | conecta con 2.1 | Bajo |
| 6.7 | API route refactor a pipeline | Refactor | -100 | Medio |
| 6.8 | Reconciler: una sola query | Fix perf | -2 queries/tick | Bajo |
| 6.9 | Eliminar app/page.tsx | Borrado | -5 | Bajo |
| 6.10 | next-env.d.ts a .gitignore | Limpieza | -1 archivo trackeable | Bajo |
| 6.11 | Borrar archivo doc duplicado | Borrado | -631 LOC docs | Bajo |
| 6.12 | ~~tsbuildinfo del tracking~~ | **RETIRADO** (premisa erronea) | — | — |

---

## 7. Seguridad

Lista priorizada por severidad: criticos primero, luego defense-in-depth.

### 7.1 CRITICO: rotar tokens visibles en historia conversacional

Durante la lectura del repo encontre tokens reales en `.env.local`:

- `SUPABASE_SERVICE_ROLE_KEY` (acceso total a la DB, bypass RLS)
- `SUPABASE_SECRET_KEY` (idem)
- `INNGEST_EVENT_KEY`
- `INNGEST_SIGNING_KEY`
- `INNGEST_API_KEY`
- `UPSTASH_REDIS_REST_TOKEN`

`.env.local` esta en `.gitignore:14` pero los valores **estan en el contexto
de esta conversacion**. Si la transcripcion se loguea, se exporta, o se
comparte, esos tokens estan expuestos.

Accion inmediata:

1. Rotar **todos** esos tokens en sus dashboards respectivos (Supabase,
   Inngest, Upstash) hoy.
2. Verificar que no aparezcan en `git log -p` con `gitleaks`:

   ```bash
   docker run --rm -v $(pwd):/repo zricethezav/gitleaks:latest detect --source=/repo
   ```

3. Si aparecen en el historial: `git filter-repo` para reescribir.

`docs/progreso/2026-05-20-20-inngest-keys-local.md:21` ya advierte
explicitamente: "Rotar las claves despues de validar, porque fueron
compartidas en chat". Si nunca se hizo, hacerlo ahora.

### 7.2 ALTA: `app/auth/sign-out` debe ser POST (CSRF)

Ya cubierto en 6.5 desde el angulo correctness. Lo repito desde el angulo
seguridad: una pagina maliciosa con `<img src="https://tu-app/auth/sign-out">`
**cierra sesiones de usuarios autenticados** sin interaccion.

Hoy mitigado parcialmente porque la cookie de Supabase es `SameSite=Lax`,
pero atacantes pueden hacer redirects desde su origen. Cambiar a POST cierra
el vector.

### 7.3 ALTA: rate-limit en `accept_tenant_invite`

`supabase/migrations/20260520155323_invite_only_onboarding.sql:181-332` no
tiene rate limit. Un atacante autenticado puede brute-forcear tokens.

El espacio es enorme (32 bytes base64 ~ 256 bits), no es feasible. Pero:

- Si un dia se reduce el token a algo mas corto, el codigo se vuelve
  vulnerable.
- Mas importante: cualquier llamada a la RPC consume DB. Aunque el token sea
  imposible de brute-forcear, el atacante puede saturar la DB.

Propuesta: rate-limit en el wrapper Next.

```ts
// app/auth/callback/route.ts (antes de accept_tenant_invite)
const limit = await limiter.limit(`invite-accept:${authUserId}`, {
  ip: clientIp
});
if (!limit.success) return redirectWithError(request, "rate_limited");
```

Usar el mismo `@upstash/ratelimit` ya configurado. Limit sugerido: 5
intentos/hora por usuario.

### 7.4 ALTA: CSRF en route handlers POST

Hoy `app/api/documents/[id]/indexing/request/route.ts:41-193` (POST) no valida
origin ni token CSRF. Acepta cualquier POST con cookie de Supabase valida.

Mitigaciones:

- **Origin check:** validar que `request.headers.get("origin")` matchea
  `APP_ORIGIN` o `VERCEL_PROJECT_PRODUCTION_URL`.
- **SameSite=Strict** en cookies de auth si Supabase lo permite (hoy default
  es Lax).
- **Form action de Next 16** (`use server` actions) tienen CSRF built-in via
  origin check. Esa ruta podria ser una server action en vez de route
  handler.

Propuesta minima:

```ts
// lib/auth/csrf.ts
export function requireSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const allowed = [process.env.APP_ORIGIN, /* prod URL */].filter(Boolean);
  if (origin && !allowed.includes(origin)) {
    throw new Response("Forbidden", { status: 403 });
  }
}
```

Aplicar al request de indexing y a cualquier futuro POST handler.

### 7.5 ALTA: Compute Gateway token compartido sin rotacion

`workers/compute-gateway/server.mjs:29` lee `SDA_COMPUTE_GATEWAY_TOKEN`.
Mismo token en:

- Vercel (en `COMPUTE_GATEWAY_TOKEN`)
- `srv-ia-01/.env` (deployado por `workers/compute-gateway/deploy.sh:53`)
- `srv-ia-01/sda-tree-indexer-python/.env` (compartido por
  `workers/tree-indexer-python/deploy.sh:23`)

Tres copias. Si una se filtra, las otras quedan comprometidas.

Propuestas en orden de fortaleza:

1. **Corto plazo:** que `deploy.sh` rote el token automaticamente cada N dias.
2. **Medio plazo:** Cloudflare Tunnel con **service tokens** (uno por
   consumer). Inngest tiene su token, el chat agent tendra otro, etc.
3. **Largo plazo:** mTLS con cert client en Cloudflare Access. Sin secret
   compartido.

Adicional: eliminar `SDA_ALLOW_UNAUTHENTICATED_WORKER=1` como opcion
(`workers/compute-gateway/server.mjs:31`). Es flag que en algun momento
alguien va a setear en prod por error. Reemplazar por "si no hay token, el
proceso no arranca, log fatal".

### 7.6 MEDIA: RLS sin policies de DELETE en muchas tablas

Reviso las migraciones. Las policies cubren:

- `select` para tenant_id en todas las tablas
- `insert`/`update` para algunas (documents, conversations)
- **`delete`** solo en:
  - `conversations_delete_admin` (`supabase/migrations/20260520145604_core_multitenant_schema.sql:427-429`)
  - `documents_storage_delete_admin` (`supabase/migrations/20260520164528_documents_upload_flow.sql:48-54`)

Las tablas `documents`, `doc_tree`, `chunks`, `indexing_runs`,
`indexing_events`, `document_extractions` NO tienen policy de delete para
authenticated. Esto significa: nadie puede borrar a traves de Supabase SDK,
todo cleanup va por service role.

Bien para seguridad ofensiva (no se puede borrar atacando con session
robada), pero significa que el cleanup automatizado (seccion 5.3 con pg_cron)
corre como `postgres`, que es service role implicito — verificar que
`pg_cron` esta habilitado y los jobs efectivamente corren con esos privilegios
(si lo hace por default en Supabase).

Acotacion: agregar policy de DELETE de propios documentos para el autor.
Hoy borrar un doc requiere admin SQL.

```sql
create policy documents_delete_owner on public.documents
  for delete to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and created_by = (select auth.uid())
    and status in ('failed', 'uploading')
  );
```

(solo borrable si no esta indexado).

### 7.7 MEDIA: Storage RLS path traversal

`supabase/migrations/20260520164528_documents_upload_flow.sql:23-46` valida
storage policies con:

```sql
(storage.foldername(name))[1] = (select app.current_tenant_id())::text
```

`storage.foldername()` parte por `/`. Una path como
`<tenant_id>/../<other_tenant>/file.pdf` retorna `['<tenant_id>', '..',
'<other_tenant>', 'file.pdf']`. El primer elemento es el tenant correcto,
chequeo pasa, **pero el archivo se guarda en otro tenant** despues de
resolucion de path por el storage backend.

Verificacion necesaria: probar si Supabase Storage resuelve `..` o no. Si lo
hace, es un bug critico.

Mitigacion defensiva (independiente del bug): validar el path completo
contra regex en la RPC `create_document_upload`
(`supabase/migrations/20260520223500_document_upload_dedupe.sql:103-105`):

```sql
if r2_key !~ ('^' || current_tenant_id::text || '/[a-f0-9-]+/[a-zA-Z0-9._-]+$') then
  raise exception 'Invalid storage path';
end if;
```

Hoy el path lo arma la RPC misma, asi que es controlado. Pero defense in
depth.

### 7.8 MEDIA: `audit_log` no captura todas las escrituras criticas

`audit_log` (`supabase/migrations/20260520145604_core_multitenant_schema.sql:220-232`)
es la base para forense. Cobertura actual:

- `tenant_invite.created/accepted/revoked` (en migracion invites)
- `document.upload_created/uploaded/upload_failed/upload_deduped`
- `document.indexing_requested`

Falta:

- `indexing_runs.failed` (cuando un run termina mal)
- `documents.indexed` (sucesso final)
- Cualquier escritura de service role desde workers (Inngest, MinerU)

Propuesta: trigger BEFORE INSERT/UPDATE en tablas criticas que escribe a
`audit_log` con `actor_id = coalesce(auth.uid(), 'system'::uuid)`.

Cubrir minimamente: `documents`, `indexing_runs`, `users.role` (escalation
detection), `tenant_invites`.

### 7.9 MEDIA: dependencias sin actualizar

`package.json:42-50` tiene devDeps con versiones especificas. No hay
`renovate` ni dependabot configurado.

Propuesta: agregar `renovate.json`:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended"],
  "schedule": ["before 6am on Monday"],
  "vulnerabilityAlerts": { "enabled": true, "labels": ["security"] }
}
```

GitHub renderea PRs automaticos cada lunes. Critical vulnerabilities crean PR
inmediatamente.

Idem `workers/tree-indexer-python/requirements.txt` para Python (Dependabot
soporta `pip`).

### 7.10 BAJA: tokens en environment variables del worker (proceso visible)

`workers/compute-gateway/server.mjs` corre con `EnvironmentFile=.env` por
systemd. El `.env` tiene chmod 600 (correcto, ver
`workers/compute-gateway/deploy.sh:63`), pero las variables son visibles en
`/proc/$pid/environ` para cualquier proceso con UID matching.

Mitigacion: usar Cloudflare Workers Secrets o systemd `LoadCredential=` (carga
secretos en runtime sin estar en env del proceso).

Mas pragmatico: aceptar el riesgo (server privado, single-tenant) y
documentar.

### 7.11 BAJA: log de signed URLs en Inngest steps

`docs/gotchas.md:43` advierte:

> Do not log `document.signed_url` in the gateway, Inngest step output, or DB
> metadata.

Verificar:

- `inngest/functions/process-document-index.ts:346-353` pasa `signed_url` a
  `createComputeGatewayIndexJob`. El step name es `create-compute-gateway-job`,
  el output del step incluye lo que devuelve la funcion. La funcion devuelve
  `{ job_id, ... }`, no la signed URL. **OK**.
- Compute Gateway: hace fetch a la signed URL pero no la persiste en el
  manifest. **OK**.

Add una guardrail: tipo `Brand<string, "SignedUrl">` que tiene un `toJSON()`
custom que retorna `"<redacted>"`. Cualquier intento de loguearlo lo redacta
automaticamente.

### 7.12 BAJA: `secrets:scan` no cubre PRs con history rewrite

`scripts/secret-scan.mjs:39-54` corre `git ls-files`. Solo ve la working
copy. No detecta secretos en commits viejos.

Si nos quedamos sin el script (seccion 2.3), GitHub Secret Scanning Push
Protection cubre push. Pero historia previa no se reescanea automaticamente.

Accion unica: correr `gitleaks` contra todo el historial **hoy**. Si encuentra
algo, `git filter-repo`. Despues, GitHub se encarga del futuro.

### 7.13 MEDIA: revisar `app.current_tenant_role()` default a `'member'`

`supabase/migrations/20260520145604_core_multitenant_schema.sql:37-50`:

```sql
return coalesce(
  nullif(auth.jwt() ->> 'tenant_role', ''),
  ...
  'member'  -- default!
);
```

Si por algun bug del JWT hook un user no tiene tenant_role, la funcion
retorna `'member'`. Eso le da acceso de **member** a queries que filtran por
rol, en lugar de denegar.

Defensa correcta: retornar `null` y que toda policy fail-closed.

```sql
return nullif(
  coalesce(
    auth.jwt() ->> 'tenant_role',
    ...
  ),
  ''
);
```

Las policies que comparan a `'admin'`/`'owner'` siguen funcionando.
`is_tenant_admin()` retorna `false` (correcto). No hay default permisivo.

### Resumen ejecutable de la seccion

| # | Issue | Severidad | Costo de fix |
|---|---|---|---|
| 7.1 | Rotar tokens vistos en chat | CRITICA | 30 min manual |
| 7.2 | sign-out a POST | ALTA | 1 commit |
| 7.3 | Rate-limit invite accept | ALTA | 15 LOC |
| 7.4 | CSRF en route POST | ALTA | helper + 3 llamadas |
| 7.5 | Token gateway sin rotacion | ALTA | medio plazo (mTLS) |
| 7.6 | Sin policies DELETE | MEDIA | 5 policies SQL |
| 7.7 | Storage path traversal | MEDIA | regex en RPC |
| 7.8 | audit_log cobertura | MEDIA | triggers |
| 7.9 | Renovate/Dependabot | MEDIA | 1 file |
| 7.10 | Env vars visibles en proceso | BAJA | aceptar/documentar |
| 7.11 | Signed URLs en logs | BAJA | branded type |
| 7.12 | Historial pre-secret-scan | BAJA | gitleaks one-shot |
| 7.13 | Default `'member'` en JWT hook | MEDIA | 1 linea SQL |

---

## Cierre

Este informe tiene 7 secciones con propuestas concretas, todas referenciadas
contra el codigo actual del repo al momento de escribirlo
(commit `47ad0e8` segun `git log`).

Si se aprueba ejecutarlo entero, el orden recomendado:

1. **Seccion 7** primero (criticos de seguridad: rotar tokens, sign-out POST,
   CSRF).
2. **Seccion 6** segundo (limpieza de bajo riesgo que despeja el repo:
   borrados, gitignores, renames).
3. **Seccion 1** tercero (reorganizacion fisica, alto impacto en lectura
   pero bajo riesgo funcional).
4. **Seccion 2** cuarto (reduccion de LOC apoyandose en servicios).
5. **Seccion 5** quinto (DB y caching: requiere migraciones cuidadas).
6. **Seccion 3** sexto (mejoras de indexado con LangGraph: agregan features).
7. **Seccion 4** ultimo (CLI propia: nice to have, requiere todo lo anterior
   estable).

Si se quiere ejecutar parcialmente, sugerencia minima de alto impacto:

- **7.1, 7.2, 7.13** (criticos seguridad: rotar tokens, sign-out POST,
  default `'member'` en JWT hook)
- **6.5** (sign-out a POST — duplica 7.2 desde otro angulo)
- **2.7** (transiciones declarativas: limpia el archivo mas grande del repo)
- **3.5** (checkpointing LangGraph: ahorro real de costos LLM en retries,
  verificar compat de la lib antes)
- **4.2** (`sda doctor`: feedback inmediato a operadores)

Esos items ya transforman la operacion diaria.

---

## Apendice: Errata y notas de verificacion

Tras un self-review del informe original se detectaron y corrigieron los
siguientes errores. Se documentan aqui para trazabilidad.

### Errores factuales corregidos

| Ubicacion | Error original | Correccion |
|---|---|---|
| 1.2 intro | "lib/ tiene 18 archivos planos" | Son 11 en root + 7 en subdirectorios |
| 1.7 | "8 funciones de prompt en tree_graph.py" | Son **4** (las 4 que se listan: `_candidate`, `_verification`, `_summary`, `_doc_summary`) |
| 2.7 | "18 llamadas a recordIndexingTransition" | Verificado: **17** |
| 6.3 | "supabase/.temp/ esta en git" | **Falso**, no esta trackeado. Item retirado. |
| 6.12 | "tsbuildinfo esta en git" | **Falso**, no esta trackeado. Item retirado. |
| 7.6 enum | "DELETE solo en conversations" | Tambien existe `documents_storage_delete_admin` |

### Cuantificaciones suavizadas

Las siguientes cifras eran estimaciones presentadas como ciertas; ahora se
marcan como aproximaciones:

- "10x mas chico que commander" (4.1) → "mas liviano"
- "Cada archivo ~200 LOC" (1.3) → reparto desbalanceado por archivo
- "Total ~2.100 LOC quitados" (2 fin) → "Total estimado" + caveat de redondeo
- "Sesion baja de ~15 a 3-4 comandos" (4 fin) → "estimacion rough, no medido"

### Propuestas reescritas por problemas tecnicos

- **5.7 (Realtime publication WHERE):** la version original se contradecia.
  Reescrita como "verificar que Realtime respeta RLS; no hay propuesta de
  cambio si lo hace".
- **5.8 (`unstable_cache`):** la version original ignoraba que las queries
  actuales leen cookies (que rompe cache). Reescrita explicando el refactor
  necesario para separar auth del cache, con caveat de seguridad (filtro
  manual por tenant en lugar de RLS).
- **2.10 (`waitForEvent`):** la version original lo presentaba como cambio
  chico. Reescrita aclarando que requiere event publisher en cada worker,
  distribucion de `INNGEST_EVENT_KEY`, y manejo de errores adicional.
- **3.5 (AsyncPostgresSaver):** agregado caveat sobre compat con
  `langgraph==1.0.5` y el posible conflicto con la tabla
  `langgraph_checkpoints` existente.

### Verificaciones requeridas antes de adoptar

Items que no se verificaron al escribir el informe y deben validarse antes
de ejecutarlos:

- **2.3** (borrar secret-scan): confirmar que GitHub Push Protection esta
  activo en el repo.
- **3.5** (LangGraph checkpointing): compat con version actual de langgraph.
- **5.1** (ltree): requiere `create extension ltree` (no es default).
- **5.3 / 5.6** (pg_cron): requiere plan Pro+ de Supabase; en Free hay que
  usar GitHub Actions cron externo.
- **5.7** (Realtime + RLS): verificar configuracion de Realtime
  Authorization en el dashboard.
- **5.9** (edge runtime): probar `@supabase/ssr` 0.10.3 en edge en preview
  deploy antes de prod.
- **6.6** (system-versions JSON): conecta con 2.1. Decidir antes que
  cualquiera de los dos se ejecute.

### Inconsistencias internas resueltas

- **2.1 vs 5.5** se cancelaban. 5.5 ahora explicita que es **alternativa**
  si 2.1 NO se acepta.
- **4.10** referenciaba `lib/auth/supabase/types.gen.ts`, path que solo
  existe tras 1.2. Reescrito como "ubicacion actual de `lib/supabase/`".
- **6.3 y 6.12** removidos de la tabla resumen de seccion 6 (marcados
  como retirados).
