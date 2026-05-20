# SDA Tree Index + Live Architecture

Estado: decision tecnica aceptada para la proxima fase de indexacion.

## Objetivo

Evitar naive RAG y arquitecturas similares que destruyen contexto. El sistema
debe convertir cada documento en una memoria jerarquica navegable, donde el
agente pueda encontrar informacion con el menor trabajo posible y con maxima
calidad de evidencia.

La unidad principal no es el chunk. La unidad principal es el arbol.

```text
documento original
  -> extraccion fiel
  -> arbol semantico verificable
  -> summaries navegacionales
  -> embeddings jerarquicos
  -> recuperacion coarse-to-fine
  -> evidencia exacta
```

## Principios

- No partir texto por tokens como estrategia primaria.
- No perder paginas, layout, tablas, imagenes ni coordenadas.
- Todo documento tiene raiz, pero no todo documento tiene capitulos.
- Todo nodo del arbol debe tener evidencia en paginas o bloques concretos.
- Toda pagina o bloque relevante debe estar cubierto por algun nodo.
- Los summaries son mapas de navegacion, no fuente de verdad.
- La fuente de verdad final es texto/bloque/pagina recuperable.
- El sistema debe sentirse vivo: estados, streaming y progreso visible siempre
  que sea posible.

## Stack decidido

```text
MinerU
  extraccion fiel de PDF, OCR, layout, tablas, formulas y bloques

LangGraph
  construccion, verificacion y refinamiento del arbol

LLM estructural
  razonamiento para detectar tipo documental, proponer arbol, verificar
  cobertura, refinar nodos y generar summaries

Inngest
  workflow durable, retries, fan-out, backoff, rate limits y observabilidad

srv-ia-01
  compute gateway privado para MinerU, VLM futuro y razonamiento pesado

Supabase
  auth, estado, extracciones, artefactos, doc_tree, chunks, eventos live y RLS
  multitenant

Next.js
  UI, upload, vistas live, streaming de chat y feedback de indexacion
```

## Compute Gateway en srv-ia-01

`srv-ia-01` ejecuta el computo pesado. Inngest no deberia correr MinerU ni VLM
directamente en un runtime serverless si eso vuelve fragil la ingesta.

```text
Inngest
  -> crea job durable
  -> llama SDA Compute Gateway
  -> observa estado/retries

srv-ia-01
  -> descarga documento privado
  -> corre MinerU
  -> corre LangGraph Tree Indexer
  -> opcionalmente corre VLM enricher
  -> persiste resultados en Supabase
```

El acceso externo recomendado es Cloudflare Tunnel + Access. Tailscale queda
para administracion por SSH y operacion interna.

```text
Inngest Cloud
  -> https://compute.tudominio.com/v1/index-jobs
  -> Cloudflare Access valida service token
  -> cloudflared en srv-ia-01
  -> SDA Compute Gateway local
```

No queremos requests HTTP largas de 15 minutos. Preferimos jobs async:

```text
POST /v1/index-jobs
  responde rapido: job_id

GET /v1/index-jobs/:id
  estado actual

worker interno
  procesa en background
  persiste artefactos en Storage
  actualiza Supabase como control plane
  emite eventos live
```

Para escala enterprise, `srv-ia-01` no es fuente de verdad. Puede cachear input,
logs y outputs temporales, pero los artefactos que importan quedan en Storage y
su manifest queda en Postgres.

## Arbol polimorfico

No imponemos siempre:

```text
document -> chapter -> section -> subsection -> page ranges
```

Esa forma sirve para libros, papers, manuales y contratos largos. Para otros
documentos, el arbol se adapta.

```text
document
  node(type)
    title
    summary
    routing_summary
    page_start / page_end
    source_blocks
    confidence
    origin
    children
```

Tipos de nodo esperados:

```text
chapter
section
subsection
topic
page_group
page
table
figure
form
field_group
clause
definition
appendix
slide
unknown
```

`origin` indica como se construyo el nodo:

```text
explicit   -> TOC, heading, numeracion, titulo real
visual     -> layout, bloques, tablas, separadores, paginas
inferred   -> cluster semantico o razonamiento del modelo
fallback   -> agrupacion conservadora por paginas
```

## Fallbacks cuando no hay estructura clara

El sistema nunca debe forzar una jerarquia falsa. Si el documento no trae
estructura editorial, baja por esta escalera:

1. Estructura explicita: TOC, headings, numeracion, titulos detectados.
2. Estructura visual: layout, bloques, tablas, columnas, separadores.
3. Estructura semantica: agrupacion por temas y entidades.
4. Estructura por tipo documental: factura, contrato, formulario, slide deck.
5. Fallback conservador: `document -> page_group -> page`.

El fallback page-preserving no es perfecto, pero evita destruir contexto.

## Pipeline de indexacion

```text
document.uploaded
  -> Inngest workflow
    -> create indexing_run
    -> call compute gateway
      -> MinerU extract
      -> detect document type
      -> build candidate tree
      -> verify tree coverage
      -> refine large/uncertain nodes
      -> summarize bottom-up
      -> create routing summaries
      -> embed hierarchy
      -> persist doc_tree + chunks/nodes
    -> mark indexed
```

### 1. MinerU extraction

Salida esperada:

```text
pages
blocks
tables
figures
markdown
ocr_text
coordinates
reading_order
layout metadata
```

Esta capa conserva el documento. No decide la arquitectura de recuperacion.

## Requisito: LLM estructural

MinerU no alcanza para construir el arbol final. MinerU extrae la evidencia
fiel; el LLM interpreta esa evidencia y decide la memoria navegable del
documento.

PageIndex tambien usa LLM para este tipo de tareas: extraer o transformar TOC,
crear estructura cuando no hay TOC, asignar titulos a paginas fisicas, verificar
ubicaciones, corregir nodos dudosos y generar summaries.

SDA Tree Indexer debe hacer lo mismo, pero integrado a nuestro workflow:

```text
MinerU extraction
  -> LLM detecta tipo documental
  -> LLM propone arbol candidato
  -> LLM verifica cobertura y evidencia
  -> LLM refina nodos grandes o inciertos
  -> LLM genera summary y routing_summary
```

El LLM no responde al usuario en esta etapa. Construye una estructura de memoria
para que el agente futuro pueda encontrar evidencia con menos trabajo.

## Politica de modelos por etapa

No todas las etapas requieren el mismo modelo.

```text
document_type_detection
  modelo barato/rapido

candidate_tree_generation
  modelo fuerte, porque define la calidad del indice

tree_verification
  modelo fuerte o critico, porque evita alucinaciones estructurales

recursive_refinement
  modelo fuerte solo sobre nodos problematicos

node_summary
  modelo barato/rapido

routing_summary
  modelo medio, optimizado para recuperacion

embeddings
  modelo dedicado de embeddings
```

Regla practica:

```text
calidad alta para estructura y verificacion
costo bajo para summaries repetitivos
modelo dedicado para embeddings
```

Cada llamada debe persistir metadata:

```text
stage
model
provider
prompt_version
input_tokens
output_tokens
latency_ms
cost_estimate
```

Esto permite medir costo por tenant, comparar versiones y reindexar cuando
mejoremos prompts o modelos.

### 2. Candidate tree

LangGraph genera una propuesta de arbol llamando a un LLM, siguiendo la
filosofia PageIndex documentada en `docs/pageindex-tree-builder-reference.md`.
No usamos una heuristica deterministica como fuente de verdad del arbol.

La entrada al LLM son paginas etiquetadas desde MinerU, mas senales
estructurales:

- headings y TOC si existen
- layout y separadores visuales
- cambios semanticos entre paginas
- tablas o figuras dominantes
- entidades, fechas, clausulas, items o campos

La salida candidata replica el formato PageIndex:

```json
[
  {
    "structure": "1.2",
    "title": "Titulo de la seccion",
    "physical_index": "<physical_index_12>"
  }
]
```

Luego SDA normaliza `physical_index`, calcula `start_index/end_index`, convierte
la lista a arbol y valida cobertura.

### 3. Tree verifier

Otro nodo del grafo valida con LLM:

- que cada nodo tenga evidencia
- que el rango de paginas sea plausible
- que no haya paginas importantes sin cubrir
- que no existan nodos sin contenido real
- que la jerarquia no invente capitulos inexistentes

Los nodos dudosos se marcan con `confidence` bajo y vuelven a refinamiento.

### 4. Recursive refinement

Un nodo se subdivide si:

- cubre demasiadas paginas
- tiene demasiados tokens
- mezcla temas distintos
- contiene muchas tablas/listas
- tiene summary demasiado generico
- tiene baja confianza del verifier

La subdivision no es por token split. Es por estructura, layout o tema.

### 5. Summaries bottom-up y routing summaries

Cada nodo tiene dos summaries:

```text
summary
  Que dice esta parte.

routing_summary
  Para que tipo de preguntas sirve esta parte.
```

El embedding principal se genera sobre:

```text
path + title + routing_summary + entities + questions_it_can_answer
```

El texto crudo se usa despues, cuando el agente ya sabe donde mirar.

## Persistencia

Fase inicial con tablas actuales:

```text
documents
document_extractions
document_extraction_artifacts
doc_tree
chunks
```

Uso propuesto:

```text
document_extractions
  ejecucion o reutilizacion de MinerU por parser_version/backend/checksum

document_extraction_artifacts
  markdown, json, debug pdfs e imagenes producidas por MinerU

doc_tree.tree
  arbol completo, con nodos, summaries, evidence refs y metadata de indexacion

chunks
  no son chunks naive
  representan nodos, paginas o bloques recuperables
```

Campos clave por nodo/chunk:

```text
document_id
node_id
parent_id
node_path
node_type
title
summary
routing_summary
page_start
page_end
source_blocks
confidence
origin
content
embedding
metadata
```

Fase recomendada siguiente para live features:

```text
indexing_runs
indexing_events
doc_tree_versions
```

`indexing_events` permite mostrar progreso real sin depender solo de un status
plano en `documents`.

## Retrieval del agente

El agente no pregunta primero a chunks crudos. Navega el arbol.

```text
query
  -> embed query
  -> buscar documentos por document routing summary
  -> buscar ramas por node routing summaries
  -> abrir nodos candidatos
  -> revisar hijos
  -> recuperar paginas/bloques exactos
  -> verificar evidencia
  -> responder con fuente
```

Tools esperadas:

```text
search_documents
  encuentra documentos candidatos por summary global y metadata

search_tree_nodes
  encuentra ramas por routing_summary embedding

navigate_tree
  abre hijos, padres y hermanos relevantes

get_document_evidence
  trae paginas, bloques, tablas o rangos exactos

verify_answer_evidence
  confirma que la respuesta se sostiene en evidencia recuperada
```

## Live y streaming como default

La app debe sentirse en vivo. Cada proceso largo debe emitir estado visible.

### Upload

- progreso de subida en browser
- estado `uploading -> uploaded`
- aparicion inmediata del documento en la lista
- cambios por Supabase Realtime

### Indexacion

Estados visibles:

```text
uploaded
queued
extracting
structuring
verifying_tree
refining_tree
summarizing
embedding
persisting
indexed
failed
```

Eventos live recomendados:

```text
indexing.run.created
indexing.extract.started
indexing.extract.completed
indexing.tree.candidate_created
indexing.tree.node_refined
indexing.summary.node_completed
indexing.embedding.batch_completed
indexing.persist.completed
indexing.run.failed
indexing.run.completed
```

UI esperada:

- timeline del documento en vivo
- contador de paginas procesadas
- contador de nodos creados
- preview parcial del arbol cuando exista
- errores accionables por step
- boton de reintentar indexacion

### Chat

El chat debe streamear tokens y tambien acciones internas:

```text
assistant.token
tool.started
tool.progress
tool.result
agent.searching_documents
agent.opening_tree_node
agent.reading_evidence
agent.answering
```

El usuario deberia ver que el agente esta:

- buscando documentos
- abriendo ramas del arbol
- leyendo paginas
- verificando evidencia
- generando respuesta

No hace falta mostrar jerga tecnica al usuario final. Para usuarios normales,
copys simples:

```text
Buscando en tus documentos...
Revisando las secciones mas relevantes...
Leyendo las paginas encontradas...
Preparando respuesta...
```

### Admin/debug

Para operadores y admins si mostramos detalles:

```text
Inngest run id
compute job id
latencias por step
modelo usado
tokens
errores
retries
version de indexer
version de MinerU
```

## Responsabilidades

```text
Next.js
  UI live, SSE de chat, Supabase Realtime para estado

Supabase
  estado canonico, RLS, storage, doc_tree, chunks, eventos

Inngest
  orquestacion durable, retries, fan-out, rate limits, scheduling

srv-ia-01
  MinerU, LangGraph Tree Indexer, VLM futuro, jobs pesados

OpenRouter/model providers
  summaries, embeddings, chat o refuerzos segun costo/calidad
```

## Versionado y reindexacion

Cada corrida debe persistir:

```text
indexer_version
mineru_version
tree_builder_version
summary_model
embedding_model
vlm_model
document_checksum
created_at
```

Esto permite:

- reindexar cuando mejore el arbol
- comparar calidad entre versiones
- auditar respuestas viejas
- evitar re-procesar documentos iguales

## Decision final

Construimos un indexador propio:

```text
SDA Tree Indexer
```

Usa MinerU para extraccion fiel y LangGraph para razonamiento estructural. Se
orquesta con Inngest y corre lo pesado en `srv-ia-01` a traves de un compute
gateway protegido.

PageIndex queda como referencia conceptual, no como dependencia central.

La experiencia de producto debe ser live-first: upload, indexacion, preview del
arbol, chat, tool calls y errores deben moverse en tiempo real siempre que el
costo tecnico sea razonable.
