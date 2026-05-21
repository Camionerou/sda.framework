# 2026-05-21 - Versionado operativo del sistema

Estado: implementado en codigo, pendiente de aplicar/verificar en remoto.

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

- App: `0.1.1`
- Indexing pipeline: `0.1.1`
- Inngest workflow: `0.1.1`
- Compute Gateway extraction: `0.1.1`
- Extraction pipeline: `0.1.1`
- Tree Indexer Python: `0.1.1`
- Tree prompt: `0.1.1`
- Embedding pipeline: `0.0.0`
- Chat agent: `0.0.0`

Los documentos indexados antes de esta migracion se backfillean como `0.1.0`.
Eso permite detectar cuales quedaron viejos y reindexarlos con latest.

## Prevencion

- `npm run versions:check` revisa cambios contra `HEAD` y falla si se toca un
  componente versionado sin subir su version en `lib/system-versions.ts`.
- Para revisar un commit ya creado:

```bash
npm run versions:check -- --base HEAD~1 --head HEAD
```

## Observabilidad

- `npm run indexing:health` ahora muestra `versions.latest`,
  `versions.stale_indexed_documents_count` y una muestra de documentos que
  requieren reindex.
- La pantalla de detalle del documento muestra si el pipeline, extractor, tree
  indexer, prompt o embeddings estan en version actual o vieja.
