# Workers: Compute Gateway Y Tree Indexer

## Compute Gateway

Carpeta:

```text
workers/compute-gateway
```

Servicio Node que corre en `srv-ia-01`.

Endpoints:

```text
GET  /v1/health
POST /v1/index-jobs
GET  /v1/index-jobs/:id
POST /v1/tree-index-jobs            # proxy al Tree Indexer
GET  /v1/tree-index-jobs/:id        # proxy al Tree Indexer
GET  /v1/tree-index-jobs/:id/result # proxy al Tree Indexer
```

Responsabilidades:

- Recibir job async desde Inngest.
- Descargar el documento con signed URL corta.
- Ejecutar MinerU real.
- Subir markdown, JSON, PDFs de debug, imagenes y logs a Storage.
- Devolver manifest y lista de artefactos.
- Proteger endpoints con bearer token.
- Fallar cerrado si no hay token, salvo opt-in local
  `SDA_ALLOW_UNAUTHENTICATED_WORKER=1`.
- Rechazar bodies HTTP demasiado grandes antes de procesar jobs.
- Limitar concurrencia.

Env principal:

```text
COMPUTE_GATEWAY_URL
COMPUTE_GATEWAY_TOKEN
SDA_COMPUTE_GATEWAY_TOKEN
SDA_COMPUTE_GATEWAY_MAX_BODY_BYTES
SDA_ALLOW_UNAUTHENTICATED_WORKER
SDA_MINERU_BIN
SDA_MINERU_BACKEND
SDA_MINERU_LANG
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SDA_TREE_INDEXER_URL
SDA_TREE_INDEXER_TOKEN
```

## MinerU

MinerU es extraccion fiel, no razonamiento.

Produce evidencia:

- `content_list`
- `content_list_v2`
- `middle.json`
- `model.json`
- markdown
- PDFs de layout/span/origin
- imagenes
- log operativo

La verdad durable queda en Supabase Storage y Postgres. El disco de
`srv-ia-01` es cache operacional.

## Tree Indexer Python

Carpeta:

```text
workers/tree-indexer-python
```

Servicio FastAPI con LangGraph.

Endpoints:

```text
GET  /v1/health
POST /v1/tree-index-jobs
GET  /v1/tree-index-jobs/:job_id
GET  /v1/tree-index-jobs/:job_id/result
```

Fases:

1. Lee artefactos MinerU desde `document_extraction_artifacts`.
2. Descarga el `content_list` desde Storage.
3. Convierte bloques a paginas etiquetadas `<physical_index_X>`.
4. Si falta LLM, falla con `stage = llm_missing`.
5. Genera arbol candidato con LLM.
6. Verifica secciones contra evidencia.
7. Calcula rangos de paginas.
8. Resume nodos.
9. Persiste `doc_tree`.
10. Borra e inserta `chunks` derivados del arbol.

El Tree Indexer tambien falla cerrado sin token salvo
`SDA_ALLOW_UNAUTHENTICATED_WORKER=1`, y limita bodies con
`SDA_TREE_INDEXER_MAX_BODY_BYTES`.

## LLM

Variables:

```text
SDA_TREE_LLM_PROVIDER
SDA_TREE_LLM_BASE_URL
SDA_TREE_LLM_API_KEY
SDA_TREE_LLM_MODEL
SDA_TREE_SUMMARY_MODEL
SDA_TREE_LLM_PROVIDER_ORDER
SDA_TREE_LLM_ALLOW_FALLBACKS
SDA_TREE_LLM_REASONING_EFFORT
SDA_TREE_LLM_REASONING_EXCLUDE
SDA_TREE_LLM_TIMEOUT_MS
SDA_TREE_MAX_PROMPT_CHARS
SDA_TREE_SUMMARY_CONCURRENCY
```

Regla: sin LLM configurado no se persiste arbol fake. El documento queda en
estado recuperable con MinerU listo.

## Deploy

Comandos:

```bash
cd workers/tree-indexer-python
./deploy.sh

cd workers/compute-gateway
./deploy.sh
```

Los deploy scripts usan systemd user services:

- `sda-tree-indexer.service`
- `sda-compute-gateway.service`
