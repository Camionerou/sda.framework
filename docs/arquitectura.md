# Arquitectura del Sistema

App empresarial multitenant para ingesta, indexación y consulta de documentos mediante agentes de IA.

---

## 1. Resumen ejecutivo

El sistema permite a clientes empresariales subir documentos (principalmente PDFs), indexarlos automáticamente con un enfoque de razonamiento estructural (no solo embeddings), y consultarlos mediante un agente conversacional. La arquitectura combina **servicios cloud managed** para todo lo síncrono y de auth, **un workflow engine durable** para la ingesta, y **un servidor local con GPU** para el LLM open-source y el parsing de documentos.

**Principios rectores:**

- **Multitenancy desde el primer día** vía Row Level Security (RLS) en Postgres con `tenant_id` en JWT.
- **Separación sync/durable**: el chat corre en un runtime persistente; la ingesta vive en un workflow engine con reintentos.
- **Hybrid reasoning**: razonamiento estructural complejo en LLM local; tareas triviales (resúmenes) en LLM hosted barato.
- **Sin lock-in fuerte**: cada componente es reemplazable con esfuerzo razonable.

---

## 2. Diagrama de arquitectura

```
                         ┌──────────────────────────┐
                         │  CLIENTE (Next.js)       │
                         └────────────┬─────────────┘
                                      │ HTTPS + SSE
                                      ▼
                         ┌──────────────────────────┐
                         │  CLOUDFLARE              │
                         │  WAF · rate limit ·      │
                         │  Worker (upload gw) ·    │
                         │  Tunnel + Access (mTLS)  │
                         └──┬─────────┬─────────────┘
                            │         │
              ┌─────────────┘         └─────────────────┐
              │ chat (SSE)                              │ upload PDF
              ▼                                         ▼
   ┌──────────────────────┐                   ┌────────────────────┐
   │  AGENT RUNTIME       │                   │  CLOUDFLARE R2     │
   │  Fly.io              │                   │  PDFs originales   │
   │  FastAPI · LangGraph │                   │  zero egress       │
   └──┬───────────┬───────┘                   └─────────┬──────────┘
      │           │                                     │ event
      │           ▼                                     ▼
      │   ┌──────────────────────┐           ┌────────────────────────┐
      │   │  OPENROUTER          │           │  INNGEST               │
      │   │  • chat agente       │           │  workflow durable      │
      │   │  • embeddings        │           │  concurrency control   │
      │   │  • hybrid reasoning  │◄──────────┤                        │
      │   │    (Gemini Flash     │  summary  │  Steps:                │
      │   │     para resúmenes   │  calls    │  1. signed R2 URL      │
      │   │     de hojas)        │  fan-out  │  2. /v1/parse  (local) │
      │   └──────────────────────┘           │  3. /v1/structure      │
      │                                      │     (local, reasoning) │
      │                                      │  4. fan-out resúmenes  │
      │                                      │     → OpenRouter Flash │
      │                                      │  5. embed chunks       │
      │                                      │     → OpenRouter       │
      │                                      │  6. upsert Postgres    │
      │                                      └──────────┬─────────────┘
      │                                                 │ HTTPS via
      │                                                 │ CF Tunnel
      │                                                 ▼
      │   ┌──────────────────────────────────────────────────────────┐
      │   │  SERVIDOR LOCAL (GPU)                                    │
      │   │  ─────────────────────────────────────────────           │
      │   │  cloudflared (outbound tunnel)                           │
      │   │       │                                                  │
      │   │       ▼                                                  │
      │   │  FastAPI Gateway                                         │
      │   │   ├── /v1/parse      → MinerU                            │
      │   │   ├── /v1/chat       → vLLM (Nemotron)                   │
      │   │   └── /v1/structure  → reasoning estructural local       │
      │   │  ─────────────────────────────────────────────           │
      │   │  vLLM serving Nemotron Omni 3 30B-A3B (NVFP4)            │
      │   └──────────────────────────────────────────────────────────┘
      │
      │   ┌────────────────┐    ┌─────────────────┐
      │   │  LANGSMITH     │    │  UPSTASH REDIS  │
      ├──►│  traces        │    │  cache          │
      │   │  costo/tenant  │    │  rate limit     │
      │   │  evals         │    │  quotas         │
      │   └────────────────┘    └─────────────────┘
      ▼
   ┌────────────────────────────────────────────────────────────────┐
   │  SUPABASE                                                      │
   │  ┌────────────────────────────────────────────────────────┐   │
   │  │  AUTH — SAML SSO · JWT con tenant_id                   │   │
   │  └────────────────────────────────────────────────────────┘   │
   │  ┌────────────────────────────────────────────────────────┐   │
   │  │  POSTGRES + pgvector — RLS por tenant_id en todas      │   │
   │  │  · tenants · users · roles                             │   │
   │  │  · documents (metadata + r2_key + ACL)                 │   │
   │  │  · doc_tree (JSONB del SDA Tree Index)                 │   │
   │  │  · chunks (text + embedding vector)                    │   │
   │  │  · conversations + messages                            │   │
   │  │  · langgraph_checkpoints                               │   │
   │  │  · audit_log                                           │   │
   │  └────────────────────────────────────────────────────────┘   │
   └────────────────────────────────────────────────────────────────┘

   TRANSVERSALES
   ┌──────────────┐  ┌──────────────────┐
   │  DOPPLER     │  │  GITHUB ACTIONS  │
   │  secrets     │  │  CI/CD           │
   └──────────────┘  └──────────────────┘
```

---

## 3. Componentes

### 3.1 Cliente — Next.js

Frontend que sirve la UI de chat y la UI de upload. Vive en Vercel o donde sea (no es decisión crítica).

**Por qué Next.js**: ecosystem maduro de SSE y streaming, fácil de wirear a Supabase Auth en cliente, vibe-codeable.

### 3.2 Cloudflare — capa de borde

Cumple cuatro roles en una sola cuenta:


| Subcomponente               | Función                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **CDN + WAF + DDoS**        | Capa de borde estándar                                                                                              |
| **Rate limit por tenant**   | Reglas custom por header/JWT claim                                                                                  |
| **Worker (Upload Gateway)** | Recibe pedido del cliente, valida JWT, genera signed URL para R2, inserta row en `documents` con status `uploading` |
| **R2**                      | Bucket S3-compatible para PDFs originales, con zero egress fee                                                      |
| **Tunnel + Access**         | Expone el servidor local con TLS sin abrir puertos inbound; Access aplica service tokens para auth cloud→local      |


**Por qué Cloudflare**: un solo vendor cubre edge, storage, gateway y túnel al server local. Tres servicios de competidores reemplazados con uno.

### 3.3 Supabase — Auth + Postgres + pgvector

El **source of truth** del sistema.

**Auth**: SAML SSO para clientes enterprise, OAuth para self-serve. Emite JWT con `tenant_id`, `user_id`, `role` como claims. Ese JWT viaja en todos los requests.

**Postgres + pgvector**: una sola base de datos para todo:

- Tablas operacionales (`tenants`, `users`, `documents`, `chunks`, etc.)
- Estado del agente (`langgraph_checkpoints`)
- Audit log
- Vectores de embeddings en columnas `pgvector`

**RLS (Row Level Security)** activado en TODAS las tablas con políticas que filtran por `tenant_id` del JWT. Esto significa que aunque el agente o un bug intente leer datos de otro tenant, Postgres devuelve vacío.

**Por qué Supabase**: Postgres + Auth + Storage en un solo producto, RLS battle-tested para multitenant, CLI excelente para migrations, dashboard vibe-codeable.

### 3.4 Fly.io — Agent Runtime

Servidor persistente que corre el agente conversacional.

**Stack interno**:

- **FastAPI** sirviendo endpoint SSE para streaming de tokens al cliente
- **LangGraph** orquestando el grafo del agente (tool calls, branches, loops)
- **LangChain** para tools que consultan Postgres con cliente RLS-aware
- **OpenAI SDK** apuntando a OpenRouter como provider

**Características operativas**:

- Auto-scale por carga (1 mínimo, N máximo)
- SSE/WebSocket nativo, sin timeout artificial
- Cold start rápido para no destruir UX
- Multi-región si hace falta (`fly scale count --region`)

**Por qué Fly.io**: containers Docker como microVMs, sin límite de duración de request, DX excelente para vibe-coding, cold start mucho mejor que Lambda.

### 3.5 OpenRouter — LLM gateway

Un solo API key + endpoint OpenAI-compatible para tres usos:


| Uso                                              | Modelo sugerido                                                |
| ------------------------------------------------ | -------------------------------------------------------------- |
| Chat del agente                                  | GPT-5, Gemini 2.5 Pro, o el modelo que mejor performe en evals |
| Embeddings de chunks                             | `text-embedding-3-large` o `text-embedding-3-small`            |
| Hybrid reasoning (resúmenes de hojas en indexer) | Gemini 2.5 Flash                                               |


**Por qué OpenRouter**:

- Switching de modelo con un string, sin tocar código
- Failover automático entre providers
- Billing unificado
- Soporte de embeddings desde noviembre 2025

**Trade-off conocido**: prompt caching es desigual según provider. Para el agente, que repite system prompts cada turn, vale la pena verificar el cache hit rate en el dashboard de OR. Si el costo escala feo, se puede bypasear OR para el modelo principal del agente.

### 3.6 Servidor Local — GPU dedicada

Hardware del cliente con RTX PRO 6000 Blackwell (96GB VRAM). Corre dos servicios principales y un gateway:

**FastAPI Gateway** unifica auth, logging y routing:

- `/v1/parse` → MinerU (extracción de PDFs)
- `/v1/structure` → reasoning estructural Nemotron
- `/v1/chat` → endpoint OpenAI-compatible para llamadas directas a Nemotron (uso interno, no exposed al agent runtime)

**MinerU**: librería open-source para parsing avanzado de PDFs. Maneja layout, tablas, fórmulas, OCR. Corre mayormente en CPU con uso ligero de GPU, lo que evita competir con vLLM por VRAM.

**vLLM serving Nemotron Omni 3 30B-A3B**: modelo MoE de NVIDIA con ~3B parámetros activos por token, cuantizado en NVFP4 (formato nativo de Blackwell). Sirve API OpenAI-compatible.

**Cloudflared** mantiene un túnel outbound siempre activo hacia Cloudflare. Inngest workers llaman al endpoint público (`ml.tudominio.com`) y CF Access valida el service token antes de proxear al server local.

**Por qué un server local**:

- Datos sensibles no salen de infraestructura del cliente en el cold path
- Costo marginal cero por token una vez amortizado el hardware
- Control total de versión del modelo y disponibilidad

**Trade-offs aceptados**:

- Single point of failure para ingest (mitigado por queue durable en Inngest + alertas)
- Throughput finito y conocido, no elástico
- Mantenimiento (drivers, vLLM updates, modelo) lo opera el equipo

### 3.7 Inngest — Workflow engine durable

Orquesta toda la pipeline de ingest como un workflow con steps tipados, reintentos automáticos, y observabilidad nativa.

**Workflow de ingest** (steps):

1. Generar signed URL de R2 con el `doc_id`
2. `POST /v1/parse` al server local → recibe markdown estructurado + metadata
3. `POST /v1/structure` al server local → recibe árbol estructural del documento (nodos sin resúmenes)
4. Fan-out: para cada nodo hoja del árbol, llamar a OpenRouter (Gemini Flash) para generar el resumen
5. Embeddings de chunks vía OpenRouter
6. Upsert en Postgres: `documents`, `doc_tree` (JSONB), `chunks`
7. Update `documents.status = 'indexed'`
8. (opcional) webhook al cliente

**Concurrency control**: límite explícito de N calls paralelas a `/v1/index` para no saturar el server local. Inngest acumula el resto en cola, no falla.

**Por qué Inngest**:

- TypeScript-first, vibe-codeable
- Reintentos por step con backoff exponencial
- Dashboard visual de runs en vivo
- Fan-out, scheduling, cancelación todo nativo
- Free tier generoso

### 3.8 SDA Tree Index — indexación estructural

Construye un árbol jerárquico y polimórfico sobre el documento, donde cada nodo tiene evidencia, rango de páginas, resumen y `routing_summary`. El agente navega ese árbol usando reasoning y búsqueda jerárquica, no similitud vectorial plana.

Se implementa como **SDA Tree Indexer** propio con MinerU + LangGraph. PageIndex queda como referencia conceptual, no como dependencia central.

La especificación viva de esta decisión está en [`docs/sda-tree-index-live-architecture.md`](./sda-tree-index-live-architecture.md).

**Por qué**: para documentos largos o complejos, el approach estructural supera a RAG vectorial puro. Igualmente generamos embeddings sobre summaries/nodos para búsqueda híbrida cuando aplique, sin destruir contexto.

### 3.9 Upstash Redis

Cache + rate limit + quotas + dedup hash.


| Uso                                     | TTL típico |
| --------------------------------------- | ---------- |
| Session state del agente (corto plazo)  | minutos    |
| Rate limit counter por tenant           | segundos   |
| Quota usage por tenant                  | día / mes  |
| Dedup hash de uploads (mismo contenido) | día        |


**Por qué Upstash**: serverless Redis con REST API, paga por request, integración trivial. Sin servidor a operar.

### 3.10 LangSmith

Observabilidad LLM nativa de LangGraph. Cada llamada al modelo, cada tool call, cada step del grafo se trace automáticamente con metadata.

**Lo que usamos**:

- Traces por conversation con drill-down a cada call
- Costo por tenant (vía metadata)
- Datasets de evals para regresión cuando cambiamos modelo o prompt
- Replay de sesiones para debugging y auditoría

**Por qué LangSmith** (no Langfuse): viene "gratis" con LangGraph — un env var y trace todo. Si en el futuro compliance exige self-host, Langfuse open-source es el plan B.

### 3.11 Doppler

Secrets management. Inyecta env vars en Fly.io, en runners de Inngest, en GitHub Actions, en el server local. Rotación con CLI.

**Por qué Doppler**: vibe-codeable, integración nativa con Fly y GitHub, free tier suficiente para empezar.

### 3.12 GitHub Actions

CI/CD para todo:

- Deploy a Fly.io del agent runtime
- Deploy de migrations a Supabase
- Deploy de Workers a Cloudflare
- Tests unitarios y de integración

---

## 4. Flujos clave

### 4.1 Flujo de Auth

1. Usuario se loguea en el cliente (SAML SSO o OAuth)
2. Supabase Auth emite un JWT firmado con claims: `sub`, `tenant_id`, `role`, `exp`
3. El cliente guarda el JWT y lo manda en cada request (`Authorization: Bearer ...`)
4. Cloudflare en el borde puede inspeccionar el JWT para rate limit por tenant
5. El Agent Runtime valida el JWT en cada conexión SSE
6. Postgres recibe el JWT vía Supabase client → RLS aplica políticas usando `auth.jwt() ->> 'tenant_id'`

**Resultado**: una sola fuente de verdad de tenancy que se propaga end-to-end. Imposible que un agente o un bug "olviden" aplicar el filtro de tenant.

### 4.2 Flujo de Upload + Ingest

1. Cliente pide URL de upload al **Cloudflare Worker** (con JWT)
2. Worker valida JWT, verifica quota en Redis, genera signed URL de R2 con path `tenants/{tenant_id}/{doc_id}.pdf`, inserta row en `documents` con status `uploading`
3. Cliente hace PUT multipart directo a R2 (sin pasar por backend propio)
4. R2 dispara **event notification** al webhook de Inngest cuando el upload termina
5. Inngest arranca el workflow de ingest:
  - Genera signed URL de lectura para que el server local descargue
  - Llama `POST /v1/parse` al server local → MinerU procesa, devuelve markdown estructurado
  - Llama `POST /v1/structure` al server local → Nemotron razona sobre la estructura, devuelve árbol sin resúmenes
  - Fan-out: para cada nodo hoja, llama OpenRouter (Gemini Flash) para generar resumen
  - Chunkea el contenido de cada hoja, genera embeddings vía OpenRouter
  - Upsert en `documents`, `doc_tree`, `chunks`
  - Actualiza `documents.status = 'indexed'`
6. (opcional) Webhook al cliente avisando que el doc está listo

**Resiliencia**: cada step es reintentable; si Nemotron está caído, Inngest acumula la cola y reintenta cuando vuelve. Si el cliente del agente está esperando, ve el status del documento en tiempo real.

### 4.3 Flujo de Chat

1. Cliente abre conexión SSE con el **Agent Runtime** (con JWT)
2. Runtime valida JWT, extrae `tenant_id`, abre/recupera sesión en Redis y/o `langgraph_checkpoints`
3. LangGraph arranca el grafo del agente con la pregunta del usuario
4. El agente decide tool calls — las tools consultan Postgres usando cliente Supabase RLS-aware (el `tenant_id` del JWT se inyecta automáticamente)
5. Las tools típicas:
  - `search_documents`: búsqueda híbrida (vector + filtros) sobre `chunks`
  - `navigate_tree`: navegación del SDA Tree Index en `doc_tree`
  - `get_document_text`: contenido completo de un doc o rango
6. LLM llamado vía OpenRouter genera respuesta token por token
7. Cada token streamea al cliente vía SSE
8. Todo el grafo (steps, tool calls, latencias, tokens) se trace a LangSmith con `tenant_id` como metadata
9. Conversation + messages se persisten en Postgres con RLS

**Punto crítico**: el agente NUNCA bypassa RLS. Aunque "alucine" un `tenant_id` distinto, Postgres no le devuelve nada. La seguridad vive en la DB, no en el código del agente.

### 4.4 Flujo de Observabilidad

- **LLM calls**: LangSmith captura prompt, completion, tokens, latencia, modelo, costo, conversation_id, tenant_id
- **Workflow steps**: Inngest dashboard muestra cada step, retries, duración, errores
- **HTTP requests**: Cloudflare Analytics + logs de Fly.io
- **DB queries**: Supabase logs + slow query monitoring
- **Local server**: logs estructurados del FastAPI Gateway, métricas de vLLM (tokens/s, queue depth, KV cache util)

Sin servicio APM unificado por ahora; cada plano tiene su observabilidad nativa. Si en el futuro exige correlación, OpenTelemetry + Grafana es el upgrade.

---

## 5. Decisiones arquitectónicas

### 5.1 Multitenant via RLS, no app-level

Cada tabla del schema tiene una política RLS que filtra por `tenant_id` del JWT. El filtro no está en el código del agente ni en queries SQL — está en la DB.

**Por qué**: el agente puede equivocarse, un bug puede olvidar un `WHERE tenant_id = ?`, un endpoint nuevo puede saltarse el middleware. RLS hace que todos esos errores se manifiesten como "no se devuelve nada" en lugar de "leak de datos cross-tenant".

### 5.2 Separación sync vs durable

El chat agente vive en un servidor persistente (Fly.io). La ingesta vive en un workflow engine durable (Inngest).

**Por qué**: una ingesta de 10K docs no debe degradar el chat. Workers de Inngest pueden saturarse o reintentar sin que el runtime del agente se entere. Además, los time scales son distintos: chat = segundos, ingest = minutos-horas.

### 5.3 Hybrid reasoning en el indexer

El reasoning estructural corre con LLM. MinerU extrae páginas, bloques, layout y tablas, pero no decide por sí solo la memoria navegable final.

El LLM estructural detecta tipo documental, propone el árbol, verifica cobertura/evidencia, corrige nodos dudosos y refina partes demasiado grandes. Ese trabajo corre preferentemente en `srv-ia-01` con modelo fuerte/local. Los summaries y `routing_summary` pueden correr en modelos hosted más baratos vía OpenRouter.

**Por qué**: el árbol define la calidad futura de recuperación. Si el árbol está mal, el agente trabaja más y encuentra peor evidencia. Los summaries son tareas más repetitivas y toleran modelos más baratos.

**Trade-off**: dependencia de LLM en el cold path. Mitigación: versionado de prompts/modelos, retries por Inngest, degradación graceful cuando falten summaries y reindexación selectiva cuando mejore el indexer.

### 5.4 Server local detrás de Cloudflare Tunnel

El server local nunca abre puertos inbound. `cloudflared` mantiene una conexión outbound y todo el tráfico entrante viene proxeado por CF.

**Por qué**: el server puede vivir en una red residencial, oficina del cliente, o cualquier lugar sin IP estática ni firewall configurable. No hay superficie de ataque pública sobre el server. CF Access aplica auth con service tokens.

### 5.5 OpenRouter como gateway único (en vez de N providers directos)

Una sola API key para chat agente + embeddings + hybrid reasoning. Switching de modelo con un string.

**Por qué**: vibe-coding amigable, billing unificado, failover automático. Trade-off de ~5% markup vs. precios directos.

**Plan B si el markup duele**: bypasear OR para el modelo principal del agente (que es donde está el grueso del costo), dejar OR solo para embeddings y hybrid reasoning.

### 5.6 Cloudflare R2 para storage de PDFs

Storage S3-compatible con **zero egress fee**.

**Por qué**: documentos empresariales generan mucho egress potencial (descargas, re-procesamiento, auditorías). En cualquier otro provider eso se traduce en factura mensual variable. R2 lo elimina como variable.

### 5.7 pgvector dentro de la misma Postgres

Embeddings viven en una columna `pgvector` de la tabla `chunks`, no en un vector DB separado.

**Por qué**: una sola DB simplifica todo. Permite joins entre embeddings y metadata (filtrar por `tenant_id`, `doc_acl`, fechas, tipo de doc) en un solo query, sin sincronización entre dos sistemas. Para volúmenes razonables (millones de chunks), pgvector + HNSW alcanza.

**Cuándo reconsiderar**: si superamos las decenas de millones de chunks, o necesitamos filtros muy complejos, o el query time se vuelve un problema, migrar a Qdrant/Pinecone para vectors y mantener Postgres para todo lo demás.

### 5.8 LangGraph en lugar de DIY agent loop

Usamos el framework con su grafo, checkpointer en Postgres, y tracing nativo.

**Por qué**: el agente tiene estado complejo, branches condicionales, posibles loops. Hacerlo a mano son semanas de plomería. LangGraph también nos da el checkpointer (estado persistente del grafo) gratis.

**Trade-off**: dependencia del ecosystem LangChain. Aceptable porque la abstracción es lo suficientemente delgada como para reemplazar si fuera necesario.

---

## 6. Lo que NO incluye (y por qué)


| Componente                             | Por qué no                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| Vector DB dedicado (Qdrant, Pinecone)  | pgvector alcanza para empezar. Joins con metadata son clave para multitenant. |
| Kubernetes                             | Over-engineering. Fly.io da scaling sin complejidad operacional.              |
| Service mesh                           | Sin valor agregado a este tamaño.                                             |
| Message broker (Kafka, RabbitMQ)       | Inngest cubre el rol con DX mucho mejor.                                      |
| Search engine separado (Elasticsearch) | Postgres FTS + pgvector híbrido alcanza al inicio.                            |
| Claude API                             | Decisión explícita del proyecto.                                              |
| OpenAI directo                         | Reemplazado por OpenRouter para tener single API key.                         |
| Servicio OCR separado                  | MinerU incluye OCR cuando hace falta.                                         |
| Langfuse                               | LangSmith es nativo de LangGraph y suficiente.                                |
| Vault de HashiCorp                     | Doppler alcanza para el tamaño actual.                                        |
| CDN extra                              | Cloudflare ya cumple.                                                         |
| AWS / GCP completos                    | El stack actual no necesita un cloud completo, solo servicios puntuales.      |


---

## 7. Riesgos y mitigaciones


| Riesgo                                         | Mitigación                                                                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Server local cae → ingest detenido             | Inngest acumula cola durable; alerta por queue depth; degradación temporal a extracción/summaries hosted cuando aplique |
| Throughput del server local insuficiente       | Hybrid reasoning ya offloadea ~65% de calls; segunda GPU como upgrade futuro                                           |
| OpenRouter down                                | Failover entre providers configurable en cada request; modelo principal puede bypasear OR si hace falta                |
| Supabase down                                  | Sin mitigación real a este tamaño; aceptable porque es el caso menos probable                                          |
| Modelo Nemotron cambia salidas entre versiones | Version pinning del modelo; re-indexación selectiva si hace falta                                                      |
| Crecimiento de chunks excede pgvector          | Threshold definido (decenas de millones); plan de migración a vector DB dedicado                                       |
| Costo de tokens en OpenRouter escala feo       | Métricas por tenant en LangSmith; alertas por umbral; quotas por tenant en Redis                                       |
| Cliente intenta acceder cross-tenant           | RLS bloquea automáticamente; auditoría en `audit_log`                                                                  |


---

## 8. Próximos pasos

En orden sugerido de implementación:

1. **Schema de Postgres** — tablas, índices, RLS policies, migrations
2. **Supabase Auth setup** — providers, JWT claims, RLS testing
3. **Cloudflare Worker (Upload Gateway)** — signed URLs a R2, validación JWT
4. **Inngest workflow skeleton** — steps placeholder con mock de server local
5. **Server local — FastAPI Gateway** — endpoints `/v1/parse` y `/v1/structure` con MinerU + vLLM
6. **Cloudflare Tunnel + Access** — exposición segura del server local
7. **Inngest workflow real** — wireado con el server local + OpenRouter
8. **Agent Runtime básico** — FastAPI + LangGraph + tools sobre Postgres
9. **Frontend** — chat UI + upload UI
10. **LangSmith + observabilidad por tenant**
11. **Hardening** — rate limits, quotas, audit log, alertas

---

## 9. Glosario rápido

- **MCP** (Model Context Protocol): protocolo para exponer herramientas y contexto a agentes LLM.
- **MoE** (Mixture of Experts): arquitectura de modelo donde solo un subset de parámetros se activa por token.
- **NVFP4**: formato de cuantización de 4 bits de NVIDIA para Blackwell.
- **SDA Tree Index**: índice jerárquico propio que representa documentos como árboles semánticos verificables.
- **RLS** (Row Level Security): mecanismo de Postgres para filtrar filas según el usuario.
- **SSE** (Server-Sent Events): protocolo para streaming unidireccional de servidor a cliente.
- **vLLM**: servidor de inferencia LLM open-source con continuous batching.
