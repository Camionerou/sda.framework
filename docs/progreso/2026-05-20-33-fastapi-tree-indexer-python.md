# FastAPI Tree Indexer Python

Estado: primer corte implementado y verificado con artefactos reales de
Supabase/MinerU. Pendiente: deploy en `srv-ia-01` y provider LLM.

## Que se hizo

- Se agrego `workers/tree-indexer-python`.
- Se implemento un worker FastAPI con endpoints:
  - `GET /v1/health`
  - `POST /v1/tree-index-jobs`
  - `GET /v1/tree-index-jobs/{job_id}`
  - `GET /v1/tree-index-jobs/{job_id}/result`
- El job consulta `document_extraction_artifacts` en Supabase.
- Descarga el `content_list` de MinerU desde Supabase Storage.
- Convierte `content_list` a paginas etiquetadas `<physical_index_X>`.
- Ejecuta un grafo LangGraph Python para:
  - proponer arbol PageIndex-style con LLM;
  - verificar anchors de pagina con LLM;
  - calcular rangos `start_index/end_index`;
  - generar summaries por nodo;
  - producir chunks por nodo, no chunking naive.
- Si no hay LLM configurado, el job falla en `llm_missing` y conserva
  `pages.json`; no genera arbol fake.

## Verificacion

- `python3 -m compileall workers/tree-indexer-python/app`
- `PYTHONPATH=workers/tree-indexer-python python3 -m unittest discover workers/tree-indexer-python/tests`
- Instalacion real de dependencias:
  - `fastapi`
  - `langgraph`
  - `httpx`
  - `pydantic`
  - `uvicorn`
- Smoke local de FastAPI:
  - `GET /v1/health` respondio `ok: true`.
- Smoke real contra Supabase/MinerU:
  - `artifact_count`: 49.
  - `page_count`: 12.
  - resultado esperado sin LLM: `status=failed`, `stage=llm_missing`.

## Decision

Python queda como worker de computo estructural pesado. Next.js/Inngest sigue
siendo el control-plane. Esta separacion permite operar 50k documentos con cola,
reintentos y observabilidad sin acoplar el frontend al procesamiento caro.

## Pendiente inmediato

1. Desplegar el FastAPI worker en `srv-ia-01`.
2. Configurar secrets de Supabase y LLM en el servidor.
3. Conectar Inngest para crear jobs en `/v1/tree-index-jobs`.
4. Persistir `doc_tree` y `chunks` desde el resultado Python.
