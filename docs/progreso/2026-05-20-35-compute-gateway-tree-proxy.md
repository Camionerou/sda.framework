# Compute Gateway proxy para Tree Indexer

Estado: implementado, desplegado y verificado en `srv-ia-01`.

## Que se hizo

- El gateway Node ahora proxy a `SDA_TREE_INDEXER_URL`.
- Rutas expuestas por la misma URL publica del gateway:
  - `POST /v1/tree-index-jobs`
  - `GET /v1/tree-index-jobs/:id`
  - `GET /v1/tree-index-jobs/:id/result`
- Se reutiliza bearer auth del gateway y se reenvia al FastAPI worker.
- El `deploy.sh` del gateway conserva `SUPABASE_URL` y
  `SUPABASE_SERVICE_ROLE_KEY` desde el `.env` remoto para evitar pisarlos con
  entornos locales viejos.

## Verificacion

- `node --check workers/compute-gateway/server.mjs`
- `bash -n workers/compute-gateway/deploy.sh`
- `GET https://srv-ia-01.taileb1b9c.ts.net/v1/health` respondio:
  - `ok: true`
  - `mineru_storage_configured: true`
  - `tree_indexer_url: http://127.0.0.1:8790`
- Smoke publico real:
  - `POST https://srv-ia-01.taileb1b9c.ts.net/v1/tree-index-jobs`
  - `artifact_count`: 49.
  - `page_count`: 12.
  - `stage`: `llm_missing`.

## Decision

No se cambio Tailscale Funnel. El unico endpoint publico sigue siendo el gateway
Node y el Tree Indexer queda privado en `127.0.0.1:8790`.

## Pendiente

1. Conectar Inngest a las rutas `/v1/tree-index-jobs`.
2. Configurar LLM estructural.
3. Persistir `doc_tree` y `chunks` desde el resultado Python cuando el job sea
   `succeeded`.
