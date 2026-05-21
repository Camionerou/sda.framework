# 2026-05-21 - Hardening de reindexacion versionada

Estado: implementado, deployado, migrado y verificado en remoto.

Nota posterior: la semantica de drift de versiones cambio en
`2026-05-21-42-worker-infra-hardening-version-sync.md`. Drift ya no implica
reindexacion obligatoria; sirve como auditoria y reindexacion selectiva.

## Causa raiz

Durante la reindexacion por versiones viejas aparecieron cuatro bordes:

- El reconciliador cerraba corridas nuevas si encontraba `doc_tree` y `chunks`
  persistidos del documento, aunque esos datos pudieran pertenecer a un run
  anterior.
- La cache exitosa de `document_extractions` no incluia
  `extraction_pipeline_version`, por lo que una misma fuente no podia
  reextraerse con una version nueva del pipeline.
- La RPC `request_document_indexing` tenia versiones hardcodeadas de la
  migracion inicial.
- Un documento podia quedar en `parsing` o `structuring` sin corrida activa y
  el health no lo reportaba como anomalia.

## Cambios aplicados

- `process-document-index` puede retomar un `compute_job_id` existente cuando
  el run reencolado conserva las mismas versiones.
- `reconcile-document-indexing` ahora exige version y `run_id` en `doc_tree` y
  `chunks` antes de cerrar una corrida desde datos persistidos.
- `reconcile-document-indexing` reencola documentos `uploaded`, `queued`,
  `parsing` y `structuring` que no tengan corrida activa.
- La migracion `20260521015000_document_extractions_versioned_cache.sql`
  recrea los indices unicos de `document_extractions` con
  `extraction_pipeline_version`.
- La migracion `20260521015500_request_document_indexing_latest_versions.sql`
  hace que la RPC lea latest desde `system_component_versions`.
- `indexing:health` agrega `nonterminal_without_active_run`.

## Regla operativa

No desplegar Vercel/Inngest mientras haya reindexaciones activas, salvo hotfix
necesario. Si se despliega durante un run, confirmar despues:

```bash
npm run indexing:health
```

La salida debe quedar sin anomalias operativas:

- `active_run_without_uploaded_at`
- `indexed_without_tree`
- `indexed_without_chunks`
- `nonterminal_without_active_run`
- `running_with_persisted_tree`

El drift de versiones queda como senal informativa salvo que se corra
`indexing:health -- --strict --require-fresh-indexes`.

## Estado final verificado

Comandos corridos:

```bash
npm run typecheck
npm run lint
npm run versions:check
git diff --check
npm run indexing:health
```

Resultado remoto:

- 3 documentos `indexed`.
- 0 documentos indexed stale.
- 0 anomalias operativas.
- Latest: app `0.1.2`, indexing pipeline `0.1.2`, extraction pipeline
  `0.1.2`, Inngest workflow `0.1.2`, tree indexer Python `0.1.1`.
- Commit de cierre: `9ff62fc`.
