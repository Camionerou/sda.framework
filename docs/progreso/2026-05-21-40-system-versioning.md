# 2026-05-21 - Versionado operativo del sistema

Estado: implementado, migrado en Supabase remoto, deployado y verificado.

## Que cambia

- Se agrego `system_component_versions` como registro canonico de versiones
  latest por componente.
- Se agregaron columnas explicitas de version a:
  - `documents`
  - `indexing_runs`
  - `document_extractions`
  - `doc_tree`
  - `chunks`
- Las corridas nuevas guardan:
  - `indexing_pipeline_version`
  - `extraction_pipeline_version`
  - `tree_indexer_version`
  - `embedding_pipeline_version`
- `doc_tree.version` se mantiene como tag runtime legacy
  (`sda-pageindex-python-langgraph-vX.Y.Z`), pero ahora tambien queda la
  version semantica comparable en `tree_indexer_version`.

## Version actual

- App: `0.1.2`
- Indexing pipeline: `0.1.2`
- Inngest workflow: `0.1.2`
- Compute Gateway extraction: `0.1.1`
- Extraction pipeline: `0.1.2`
- Tree Indexer Python: `0.1.1`
- Tree prompt: `0.1.1`
- Embedding pipeline: `0.0.0`
- Chat agent: `0.0.0`

Los documentos indexados antes de esta migracion se backfillean como `0.1.0`.
Eso permite detectar cuales quedaron viejos y reindexarlos con latest.

## Prevencion

- `npm run versions:check` revisa cambios contra `HEAD` y falla si se toca un
  componente versionado sin subir su version en `lib/system-versions.ts`.
- `request_document_indexing` lee latest desde `system_component_versions`; no
  debe hardcodear versiones en la RPC.
- El dedupe de extraccion incluye `extraction_pipeline_version`, asi una misma
  fuente puede reextraerse cuando cambia el pipeline.
- El reconciliador solo puede cerrar corridas con `doc_tree` y `chunks` que
  coincidan en version y `run_id`; no puede usar arboles viejos para runs
  nuevos.
- Para revisar un commit ya creado:

```bash
npm run versions:check -- --base HEAD~1 --head HEAD
```

## Observabilidad

- `npm run indexing:health` ahora muestra `versions.latest`,
  `versions.stale_indexed_documents_count` y una muestra de documentos que
  requieren reindex.
- Tambien marca documentos en estado intermedio (`queued`, `parsing`,
  `structuring`) que no tengan corrida activa.
- La pantalla de detalle del documento muestra si el pipeline, extractor, tree
  indexer, prompt o embeddings estan en version actual o vieja.

## Verificacion remota

Ultimo cierre verificado:

- `npm run indexing:health`
- `stale_indexed_documents_count = 0`
- `version_drift_requires_reindex = []`
- `active_run_without_uploaded_at = []`
- `indexed_without_tree = []`
- `indexed_without_chunks = []`
- `nonterminal_without_active_run = []`
- `running_with_persisted_tree = []`

Documentos indexados con latest al cierre:

- `SALDIVIA BUSES PORTFOLIO_compressed.pdf`: extraction `0.1.2`, indexing
  `0.1.2`, tree indexer `0.1.1`.
- `Practica 1 - Unidad 5 SQL.pdf`: extraction `0.1.2`, indexing `0.1.2`,
  tree indexer `0.1.1`.
- `Unidad 3 Sistemas Operativos.pdf`: extraction `0.1.2`, indexing `0.1.2`,
  tree indexer `0.1.1`.
