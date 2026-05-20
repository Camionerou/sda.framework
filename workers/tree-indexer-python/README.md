# SDA Tree Indexer Python

Worker FastAPI para construir un indice PageIndex-style desde artefactos MinerU.

Estado: primer corte real. Prepara paginas desde `content_list` y ejecuta el
grafo LangGraph cuando hay LLM configurado. Si falta LLM, el job falla de forma
explicita con las paginas ya preparadas; no persiste arbol fake.

## Endpoints

- `GET /v1/health`
- `POST /v1/tree-index-jobs`
- `GET /v1/tree-index-jobs/{job_id}`
- `GET /v1/tree-index-jobs/{job_id}/result`

## Env

```bash
PORT=8790
SDA_TREE_INDEXER_DATA_DIR=/var/lib/sda-tree-indexer
SDA_TREE_INDEXER_TOKEN=secret
SDA_TREE_INDEXER_CONCURRENCY=1

SUPABASE_URL=https://project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...

SDA_TREE_LLM_PROVIDER=openrouter
SDA_TREE_LLM_BASE_URL=
SDA_TREE_LLM_API_KEY=
SDA_TREE_LLM_MODEL=google/gemini-3.5-flash
SDA_TREE_SUMMARY_MODEL=google/gemini-3.5-flash
SDA_TREE_LLM_PROVIDER_ORDER=google-vertex/global
SDA_TREE_LLM_ALLOW_FALLBACKS=0
SDA_TREE_LLM_SERVICE_TIER=
SDA_TREE_LLM_REASONING_EFFORT=low
SDA_TREE_LLM_REASONING_EXCLUDE=1
SDA_TREE_LLM_TIMEOUT_SECONDS=120
SDA_TREE_LLM_TIMEOUT_MS=
SDA_TREE_LLM_JSON_MODE=
SDA_TREE_MAX_PROMPT_CHARS=60000
SDA_TREE_SUMMARY_CONCURRENCY=3
```

`SDA_TREE_INDEXER_TOKEN` puede omitirse en desarrollo. En servidor real debe
estar configurado.

## Desarrollo local

Python soportado: `>=3.11,<3.14`. En `srv-ia-01` usamos Python 3.12.

```bash
cd workers/tree-indexer-python
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8790}"
```

## Tests

```bash
PYTHONPATH=. python -m unittest discover tests
```

## Deploy en srv-ia-01

```bash
cd workers/tree-indexer-python
./deploy.sh
```

El script reutiliza `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` y el token del
Compute Gateway remoto si ya existen. Las variables de LLM se conservan desde
un `.env` remoto previo o se toman del entorno local si se exportan antes de
correr el deploy.

## Crear job

```bash
curl -X POST http://localhost:8790/v1/tree-index-jobs \
  -H "content-type: application/json" \
  -H "authorization: Bearer $SDA_TREE_INDEXER_TOKEN" \
  -d '{
    "tenant_id": "...",
    "document_id": "...",
    "run_id": "...",
    "extraction_id": "...",
    "document_title": "Documento"
  }'
```

El worker consulta `document_extraction_artifacts` por `extraction_id`, descarga
el `content_list` desde Supabase Storage, lo convierte a paginas etiquetadas
`<physical_index_X>`, ejecuta LangGraph y persiste `doc_tree` + `chunks` en
Supabase cuando termina con exito.

## Filosofia

- No usa PyPDF2 como fuente primaria.
- No hace chunking naive.
- No construye arbol real sin LLM.
- Los archivos locales son cache operacional del job.
