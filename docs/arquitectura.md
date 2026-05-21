# Arquitectura del Sistema

App empresarial multitenant para ingesta, indexacion y consulta de documentos
mediante agentes de IA.

Este documento describe la arquitectura general vigente. La especificacion
operativa de indexacion estructural vive en
[`docs/backend/04-indexacion-inngest.md`](./backend/04-indexacion-inngest.md)
y [`docs/backend/05-workers-compute-tree-indexer.md`](./backend/05-workers-compute-tree-indexer.md).

---

## 1. Resumen ejecutivo

El sistema permite a clientes empresariales subir documentos, indexarlos con una
arquitectura de arbol semantico verificable y consultarlos mediante un agente
conversacional. La prioridad es evitar naive RAG: no tratamos el documento como
una bolsa de chunks, sino como una memoria navegable.

La arquitectura combina:

- **Next.js + Supabase** para app, auth, storage inicial, Postgres, RLS,
  Realtime y pgvector.
- **Inngest** para ingesta durable, retries, fan-out y observabilidad.
- **Upstash Redis** para estado operacional rapido y reconstruible: locks
  efimeros, rate limits, backpressure por tenant, heartbeats, snapshots live y
  caches TTL; no es fuente de verdad.
- **srv-ia-01** como compute gateway privado para MinerU, LangGraph Tree
  Indexer y VLM futuro.
- **Cloudflare Tunnel + Access** para exponer el compute gateway sin abrir
  puertos inbound.
- **OpenRouter/model providers** para chat, summaries, routing summaries y
  embeddings cuando convenga costo/calidad.

## Principios rectores

- **Multitenancy desde el primer dia** via RLS en Postgres con `tenant_id` en
  JWT.
- **Live-first**: upload, indexacion, chat, tool calls y errores deben sentirse
  en vivo siempre que sea razonable.
- **Separacion sync/durable**: la app y el chat son interactivos; la ingesta
  corre como workflow durable.
- **No naive RAG**: el indice principal es el arbol, no el chunk.
- **Extraccion fiel antes de razonamiento**: MinerU conserva paginas, layout,
  tablas, OCR y bloques; el LLM estructural interpreta.
- **Evidencia verificable**: summaries y embeddings sirven para navegar; la
  respuesta final debe anclarse en paginas/bloques recuperables.
- **Sin lock-in fuerte**: cada componente es reemplazable con esfuerzo razonable.

---

## 2. Diagrama de arquitectura

```text
                         ┌──────────────────────────┐
                         │  CLIENTE NEXT.JS         │
                         │  UI live + SSE           │
                         └────────────┬─────────────┘
                                      │
                 ┌────────────────────┼────────────────────┐
                 │                    │                    │
                 ▼                    ▼                    ▼
      ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐
      │ SUPABASE AUTH     │  │ SUPABASE STORAGE  │  │ SUPABASE REALTIME │
      │ Google/SAML       │  │ PDFs privados     │  │ docs/events live  │
      └─────────┬─────────┘  └─────────┬─────────┘  └─────────┬─────────┘
                │                      │                      │
                ▼                      ▼                      ▼
      ┌────────────────────────────────────────────────────────────────┐
      │ SUPABASE POSTGRES + PGVECTOR                                  │
      │ tenants · users · documents · doc_tree · chunks               │
      │ indexing_runs · indexing_events · conversations · messages    │
      │ langgraph_checkpoints · audit_log                             │
      │ RLS por tenant_id en todas las superficies de datos            │
      └───────────────┬────────────────────────────────────────────────┘
                      │ event/status
                      ▼
              ┌───────────────────┐
              │ INNGEST           │
              │ workflow durable  │
              │ retries/fan-out   │
              └─────────┬─────────┘
                        │ HTTPS + service token
                        ▼
              ┌─────────────────────────────┐
              │ CLOUDFLARE TUNNEL + ACCESS  │
              │ sin inbound abierto          │
              └─────────┬───────────────────┘
                        │
                        ▼
      ┌────────────────────────────────────────────────────────────────┐
      │ srv-ia-01 · SDA COMPUTE GATEWAY                                │
      │ job workers privados                                           │
      │                                                                │
      │ Node gateway:    /v1/index-jobs                                │
      │ FastAPI tree:    /v1/tree-index-jobs                           │
      │ Healthchecks:    /v1/health                                    │
      │                                                                │
      │ MinerU extraction                                              │
      │ LangGraph SDA Tree Indexer                                     │
      │ LLM estructural local/hosted                                   │
      │ VLM enricher futuro                                            │
      └───────────────┬────────────────────────────────────────────────┘
                      │ summaries / embeddings / chat cuando aplique
                      ▼
              ┌───────────────────┐
              │ OPENROUTER        │
              │ model gateway     │
              └───────────────────┘

Transversales:

GitHub Actions · Doppler/secrets · LangSmith traces · Upstash Redis
```

---

## 3. Componentes

### 3.1 Next.js

Frontend de la app. Hoy cubre login, dashboard, invitaciones, upload de
documentos y detalle de documento.

Responsabilidades:

- UI de usuario final.
- Upload directo a Supabase Storage.
- Lectura de datos via Supabase SSR/client.
- Streaming de chat via SSE cuando entre el Agent Runtime.
- Suscripciones live a documentos, `indexing_runs` e `indexing_events`.

### 3.2 Supabase

Source of truth del sistema.

Incluye:

- Auth con Google OAuth hoy; SAML SSO futuro para clientes enterprise.
- Postgres con RLS por `tenant_id`.
- Storage privado `documents` para PDFs y archivos originales.
- Realtime para que la app se sienta en vivo.
- pgvector para embeddings jerarquicos.

Tablas principales:

- `tenants`
- `users`
- `tenant_invites`
- `documents`
- `document_extractions`
- `document_extraction_artifacts`
- `doc_tree`
- `chunks`
- `indexing_runs`
- `indexing_events`
- `conversations`
- `messages`
- `langgraph_checkpoints`
- `audit_log`

Nota de fase: el plan anterior mencionaba Cloudflare R2 como storage principal.
Hoy usamos Supabase Storage para reducir superficie operativa y mover rapido. R2
queda como opcion futura si el egress/costo de reprocesamiento lo justifica.

### 3.3 Inngest

Workflow engine durable para ingesta e indexacion.

Responsabilidades:

- Arrancar indexacion cuando un documento queda `uploaded`.
- Crear y actualizar `indexing_runs`.
- Llamar al compute gateway.
- Aplicar retries con backoff.
- Controlar concurrencia para no saturar `srv-ia-01`.
- Fan-out de summaries/embeddings cuando convenga.
- Marcar `documents.status` final.

Inngest no debe ejecutar el computo pesado directamente. Orquesta.

### 3.4 srv-ia-01 · SDA Compute Gateway

Servidor propio accesible por SSH via Tailscale:

```text
ssh sistemas@srv-ia-01
```

Uso recomendado:

- Tailscale para administracion y acceso interno.
- Cloudflare Tunnel + Access para endpoint consumible por Inngest Cloud.

Servicios esperados:

```text
GET  /v1/health

Node Compute Gateway:
POST /v1/index-jobs
GET  /v1/index-jobs/:id

FastAPI Tree Indexer:
POST /v1/tree-index-jobs
GET  /v1/tree-index-jobs/:id
GET  /v1/tree-index-jobs/:id/result
```

Responsabilidades:

- Descargar el documento privado.
- Correr MinerU.
- Correr LangGraph SDA Tree Indexer.
- Llamar LLM estructural local u hosted segun etapa.
- Enriquecer con VLM en el futuro.
- Persistir resultados o devolverlos a Inngest segun el modo elegido.
- Emitir eventos live hacia Supabase.

### 3.5 MinerU

Primera herramienta de extraccion fiel.

Debe producir:

- paginas
- bloques
- tablas
- figuras
- markdown
- OCR
- coordenadas
- reading order
- metadata de layout

MinerU no decide el arbol final. Conserva evidencia.

### 3.5.1 Extracciones versionadas

Para escalar a decenas de miles de documentos, la extraccion no puede depender
del disco local del compute server como fuente de verdad.

Contrato:

- Cada corrida o reutilizacion se registra en `document_extractions`.
- Cada archivo producido se registra en `document_extraction_artifacts`.
- Los artefactos viven en Supabase Storage bajo un prefijo versionado.
- El dedupe de extraccion usa `tenant_id + parser + parser_version +
  parser_backend + extraction_pipeline_version + source_checksum_sha256`.
- Si el mismo tenant sube el mismo archivo dos veces, la segunda ingesta debe
  poder registrar `reused` sin volver a correr MinerU.
- Si cambia `extraction_pipeline_version`, la misma fuente debe poder
  reextraerse y persistir una nueva extraccion exitosa.

Ruta canonica:

```text
<tenant_id>/<document_id>/extractions/mineru/<mineru_version>/<extraction_id>/...
```

Artefactos esperados:

- markdown
- `content_list.json`
- `content_list_v2.json`
- `middle.json`
- `model.json`
- `layout.pdf`
- `span.pdf`
- imagenes extraidas

El disco de `srv-ia-01` es cache operacional. La verdad durable queda en
Supabase.

### 3.6 LangGraph · SDA Tree Indexer

Construye el indice estructural propio.

Referencia operativa: `docs/pageindex-tree-builder-reference.md`. La decision
central queda fijada ahi: el arbol candidato lo propone un LLM al estilo
PageIndex; las heuristicas deterministicas solo preparan evidencia, validan,
normalizan rangos y persisten.

Implementacion inicial:

- Tree Indexer Python como runtime unico para PageIndex/LLM.
- Python/FastAPI en `workers/tree-indexer-python` para correr en `srv-ia-01`
  cuando pasemos el trabajo estructural pesado al servidor privado.
- Ambos mantienen la misma regla: sin LLM configurado, no se crea arbol fake.

Pipeline conceptual:

```text
MinerU extraction
  -> preparar paginas etiquetadas desde artefactos MinerU
  -> detectar tipo documental
  -> proponer arbol candidato con LLM
  -> verificar cobertura/evidencia con LLM
  -> reparar o degradar modo si hay baja confianza
  -> refinar nodos grandes o inciertos con LLM
  -> generar summaries bottom-up con LLM
  -> generar routing summaries
  -> generar embeddings jerarquicos
  -> persistir doc_tree + chunks/nodes
```

El resultado principal es `doc_tree`: un arbol polimorfico con nodos que tienen
evidencia, rango de paginas, summaries, routing summaries, confianza y origen.

Los registros en `chunks` no representan split naive; representan nodos,
paginas o bloques recuperables.

### 3.7 LLM estructural

SDA Tree Indexer requiere LLM.

MinerU extrae evidencia. El LLM interpreta:

- tipo documental
- estructura candidata
- cobertura
- ubicacion de nodos
- refinamiento
- summaries
- routing summaries

Si no hay provider/modelo LLM configurado, el worker no debe inventar un arbol.
Debe dejar el documento en una etapa pendiente/recuperable con un evento live
claro para el operador.

Politica de modelos:

| Etapa | Modelo |
| --- | --- |
| Tipo documental | barato/rapido |
| Arbol candidato | fuerte |
| Verificacion | fuerte |
| Refinamiento | fuerte solo en nodos problematicos |
| Summary | barato/rapido |
| Routing summary | medio, optimizado para retrieval |
| Embeddings | modelo dedicado |

### 3.8 OpenRouter / providers

Gateway para modelos hosted cuando convenga.

Usos:

- chat del agente
- summaries
- routing summaries
- embeddings
- fallback si el modelo local o `srv-ia-01` no estan disponibles

Secretos siempre por env vars. No se hardcodean keys.

### 3.9 Agent Runtime

Servidor persistente futuro para chat.

Responsabilidades:

- Validar JWT.
- Mantener sesiones/conversaciones.
- Ejecutar LangGraph del agente.
- Stream de tokens por SSE.
- Stream de tool calls/progreso.
- Usar tools RLS-aware contra Supabase.

Tools esperadas:

- `search_documents`
- `search_tree_nodes`
- `navigate_tree`
- `get_document_evidence`
- `verify_answer_evidence`

### 3.10 Redis, LangSmith y secrets

Upstash Redis:

- rate limits por tenant/user en requests sensibles
- backpressure por tenant para corridas activas de indexacion
- locks efimeros con TTL para despachos de indexacion
- heartbeats cortos de APIs/workflows/workers
- snapshots live de corridas de indexacion
- cache server-side de snapshots operativos reconstruibles
- cache corto futuro para retrieval/LLM

Redis es confiable como plataforma operacional, pero los datos guardados ahi
deben ser reconstruibles o tolerar TTL. La verdad durable sigue en Supabase e
Inngest.

LangSmith:

- traces de LangGraph
- tool calls
- latencias
- tokens/costo por tenant

Doppler o equivalente:

- secrets para app, Inngest, compute gateway, GitHub Actions y deploys.

---

## 4. Flujos clave

### 4.1 Auth

1. Usuario entra con Google OAuth o SAML futuro.
2. Supabase emite JWT.
3. Custom claims agregan `tenant_id` y `tenant_role`.
4. Next.js usa Supabase SSR/client.
5. RLS filtra todas las queries por tenant.

Resultado: la seguridad multitenant vive en Postgres, no en la memoria del
agente ni en convenciones de app.

### 4.2 Upload + estado live

Estado actual implementado:

1. Usuario sube archivo desde `/app/documents`.
2. El browser calcula `checksum_sha256` para dedupe por tenant.
3. RPC `create_document_upload` crea row en `documents` o devuelve el documento
   ya subido si el checksum coincide.
4. Browser sube directo a Supabase Storage bucket `documents` solo si no hubo
   dedupe.
5. RPC `mark_document_uploaded` pasa estado a `uploaded`.
6. La subida queda completada aunque la ingesta falle o este apagada.
7. Ruta server-side `/api/documents/[id]/indexing/request` pide la
   indexacion.
8. RPC `request_document_indexing` crea o reutiliza una corrida en
   `indexing_runs`.
9. Se emite `document/index.requested` a Inngest si hay entorno configurado.
10. Inngest firma una URL temporal del archivo privado y crea un job async en el
   Compute Gateway cuando `COMPUTE_GATEWAY_URL` esta configurado.
11. UI muestra timeline en vivo por Supabase Realtime.

### 4.3 Ingest + SDA Tree Index

```text
documents.status = uploaded
  -> Next API /api/documents/[id]/indexing/request
  -> Supabase RPC request_document_indexing
  -> Inngest document/index.requested
  -> indexing_runs.status = queued
  -> compute gateway job
  -> extracting
  -> structuring
  -> verifying_tree
  -> refining_tree
  -> summarizing
  -> embedding
  -> persisting
  -> indexed | failed
```

Cada step escribe eventos:

- `indexing.extract.started`
- `indexing.extract.completed`
- `indexing.tree.candidate_created`
- `indexing.tree.node_refined`
- `indexing.summary.node_completed`
- `indexing.embedding.batch_completed`
- `indexing.persist.completed`
- `indexing.run.completed`
- `indexing.run.failed`

### 4.4 Retrieval del agente

El agente no busca primero en texto crudo.

```text
query
  -> documentos candidatos por summary global
  -> ramas por routing_summary embedding
  -> navegar hijos/padres/hermanos
  -> recuperar paginas/bloques exactos
  -> verificar evidencia
  -> responder
```

El summary guia. La evidencia confirma.

### 4.5 Chat streaming

El chat debe streamear:

- tokens del asistente
- tool calls
- busqueda de documentos
- apertura de nodos del arbol
- lectura de evidencia
- errores recuperables

Texto para usuario final:

```text
Buscando en tus documentos...
Revisando las secciones mas relevantes...
Leyendo las paginas encontradas...
Preparando respuesta...
```

La UI admin/debug puede mostrar detalles tecnicos: modelos, tokens, latencias,
Inngest run id, compute job id y retries.

---

## 5. Live-first

La app debe sentirse en tiempo real.

Superficies live:

- lista de documentos
- detalle de documento
- timeline de indexacion
- preview parcial del arbol
- chat
- tool calls
- errores/retries

Tecnologias:

- Supabase Realtime para cambios de DB.
- SSE para chat y agent runtime.
- Inngest para estado durable y retries.
- `indexing_events` para timeline historico y live.

Regla: si una operacion tarda mas de 1-2 segundos, debe tener feedback visible.

---

## 6. Decisiones arquitectonicas

### 6.1 Supabase Storage primero, R2 despues si hace falta

Usamos Supabase Storage ahora porque ya esta integrado con Auth/RLS, reduce
piezas y acelera desarrollo. Cloudflare R2 sigue siendo buen upgrade si el
egress o reprocesamiento de PDFs se vuelve caro.

### 6.2 Inngest orquesta, srv-ia-01 computa

Inngest no es el lugar para correr MinerU/VLM pesado. Inngest conserva estado,
reintentos y concurrencia. `srv-ia-01` hace el trabajo caro.

Regla cloud-hosted: siempre que exista un servicio cloud confiable para control
plane, scheduling, retries, auth, storage o observabilidad, se prefiere ese
servicio antes que operar infraestructura propia. La infraestructura propia se
reserva para computo caro o especializado.

### 6.3 Compute gateway async, no requests largas

Preferimos:

```text
POST /v1/index-jobs -> job_id
GET /v1/index-jobs/:id -> status
```

en vez de un `POST /v1/index` que queda abierto muchos minutos.

### 6.4 SDA Tree Index, no naive chunks

`chunks` es una tabla de recuperacion, no una obligacion conceptual. Puede
almacenar nodos, paginas o bloques. El arbol en `doc_tree` es la memoria
principal.

### 6.5 RLS como frontera de seguridad

Todas las queries normales pasan por Supabase/RLS. Service role solo para
workers confiables y operaciones backend controladas.

### 6.6 Versionado de indexacion

Cada corrida debe guardar:

- `indexing_pipeline_version`
- `extraction_pipeline_version`
- `tree_indexer_version`
- `embedding_pipeline_version`
- `compute_gateway_extraction_version`
- `mineru_version` / `parser_version`
- `summary_model`
- `embedding_model`
- `vlm_model`
- `document_checksum`
- `prompt_version`

Esto permite auditoria por epoca y reindexacion selectiva cuando una mejora lo
justifique. Un documento con version anterior sigue siendo usable si tiene
`doc_tree` y `chunks` validos.

`lib/system-versions.json` es el registro canonico de latest en el repo.
`lib/system-versions.ts` deriva metadata tipada para la app y los workers
reciben esas versiones por `_metadata.versions` al crear la corrida. La tabla
`system_component_versions` queda como auditoria historica opcional, no como
fuente de verdad del hot path. El reconciliador no puede cerrar corridas usando
arboles de otro run aunque las versiones coincidan: tambien debe validar `run_id`
en metadata de `doc_tree` y `chunks`.

---

## 7. Riesgos y mitigaciones

| Riesgo | Mitigacion |
| --- | --- |
| `srv-ia-01` cae | Inngest acumula cola, UI muestra estado, retry automatico |
| Compute lento | limites de concurrencia, cola durable, segunda GPU como upgrade |
| LLM estructura mal el arbol | verifier, confidence por nodo, reintentos y reindexacion |
| Summaries incompletos | arbol sin summaries sigue navegable; completar en background |
| OpenRouter/provider caido | fallback de proveedor o modelo local cuando aplique |
| Supabase caido | aceptado como dependencia central inicial |
| Leakage cross-tenant | RLS, service role restringido a workers, audit log |
| Costo de tokens escala | metadata de costo por step/tenant, quotas, cache y modelos baratos |
| Crecimiento de vectores | pgvector al inicio; Qdrant/Pinecone si se superan limites razonables |

---

## 8. Lo que no incluye ahora

| Componente | Motivo |
| --- | --- |
| Kubernetes | Over-engineering para esta etapa |
| Vector DB dedicado | pgvector alcanza al inicio |
| Elasticsearch | Postgres FTS + pgvector + arbol alcanza |
| R2 como storage inicial | Supabase Storage ya cubre el flujo actual |
| PageIndex como dependencia central | Usamos la idea, no la caja |
| Servicio OCR separado | MinerU incluye OCR cuando hace falta |
| Message broker propio | Inngest cubre la cola durable |

---

## 9. Roadmap inmediato

Estado ya implementado:

1. Supabase remoto conectado.
2. Google OAuth.
3. Invite-only.
4. Schema multitenant con RLS.
5. Upload a Supabase Storage.
6. Vista de documentos y detalle.
7. Docs backend de indexacion y workers.
8. Primer push a GitHub.
9. `indexing_runs` e `indexing_events`.
10. Timeline live en detalle de documento.
11. Skeleton Inngest con `/api/inngest`.
12. Encolado server-side por `/api/documents/[id]/indexing/request`.

Siguiente corte:

1. Desplegar `workers/tree-indexer-python` en `srv-ia-01` con Python 3.12.
2. Configurar provider/modelo LLM estructural con secrets de servidor.
3. Hacer que Inngest cree jobs en el FastAPI Tree Indexer y observe estado
   hasta terminal.
4. Persistir `doc_tree` y nodos recuperables desde el resultado Python.
5. Agregar embeddings jerarquicos y retrieval tools iniciales.

---

## 10. Glosario

- **SDA Tree Index**: indice jerarquico propio que representa documentos como
  arboles semanticos verificables.
- **MinerU**: herramienta de extraccion PDF/OCR/layout/tablas.
- **Routing summary**: summary optimizado para decidir si una rama sirve para
  una query.
- **SSE**: Server-Sent Events, streaming unidireccional server -> cliente.
- **RLS**: Row Level Security de Postgres.
- **Compute Gateway**: servicio privado en `srv-ia-01` para jobs pesados.
- **Inngest**: workflow engine durable para ingesta y jobs largos.
