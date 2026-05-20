# Arquitectura del Sistema

App empresarial multitenant para ingesta, indexacion y consulta de documentos
mediante agentes de IA.

Este documento describe la arquitectura general vigente. La especificacion de
indexacion estructural vive en
[`docs/sda-tree-index-live-architecture.md`](./sda-tree-index-live-architecture.md).

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
      │ FastAPI / job worker                                           │
      │                                                                │
      │ /v1/index-jobs  -> crea job async                              │
      │ /v1/health      -> healthcheck                                 │
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
POST /v1/index-jobs
GET  /v1/index-jobs/:id
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

### 3.6 LangGraph · SDA Tree Indexer

Construye el indice estructural propio.

Pipeline conceptual:

```text
MinerU extraction
  -> detectar tipo documental
  -> proponer arbol candidato
  -> verificar cobertura/evidencia
  -> refinar nodos grandes o inciertos
  -> generar summaries bottom-up
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

- rate limits
- quotas
- dedup hash
- cache corto

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
2. RPC `create_document_upload` crea row en `documents`.
3. Browser sube directo a Supabase Storage bucket `documents`.
4. RPC `mark_document_uploaded` pasa estado a `uploaded`.
5. UI ve el documento en la lista y detalle.

Siguiente paso:

1. `uploaded` dispara workflow de Inngest.
2. Se crea `indexing_run`.
3. Se emiten `indexing_events`.
4. UI muestra timeline en vivo por Supabase Realtime.

### 4.3 Ingest + SDA Tree Index

```text
documents.status = uploaded
  -> Inngest document.index.requested
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

- `indexer_version`
- `mineru_version`
- `tree_builder_version`
- `summary_model`
- `embedding_model`
- `vlm_model`
- `document_checksum`
- `prompt_version`

Esto permite reindexacion selectiva y auditoria.

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
7. Docs de SDA Tree Index + live architecture.
8. Primer push a GitHub.

Siguiente corte:

1. Agregar `indexing_runs` e `indexing_events`.
2. Mostrar timeline live en detalle de documento.
3. Crear skeleton de Inngest.
4. Crear skeleton de Compute Gateway para `srv-ia-01`.
5. Conectar evento `document.uploaded -> indexing queued`.
6. Integrar MinerU extraction.
7. Implementar LangGraph SDA Tree Indexer minimo.
8. Persistir `doc_tree`.
9. Persistir nodos/paginas en `chunks`.
10. Agregar retrieval tools iniciales.

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
