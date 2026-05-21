# Indexacion E Inngest

## Entrada

Ruta:

```text
POST /api/documents/:id/indexing/request
```

Hace:

1. Valida sesion y claims.
2. Ejecuta RPC `request_document_indexing`.
3. Crea o reutiliza una corrida en `indexing_runs`.
4. Inserta evento inicial en `indexing_events`.
5. Envia `document/index.requested` a Inngest si hay `INNGEST_DEV=1` o
   `INNGEST_EVENT_KEY`.

Si Inngest no esta configurado, la ruta responde con `eventQueued: false` y una
advertencia, pero conserva la corrida en DB.

## Tablas

`indexing_runs`:

- Una corrida activa por documento (`queued` o `running`).
- Tiene `stage`, `progress`, `attempt`, `compute_job_id`, `inngest_run_id`.
- Guarda versiones de pipeline.

`indexing_events`:

- Timeline historico.
- Realtime para UI.
- Mensajes accionables por etapa.

Stages:

```text
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
canceled
```

## Funcion principal

Archivo:

```text
inngest/functions/process-document-index.ts
```

Fases:

1. Reclama la corrida idempotentemente.
2. Registra `indexing.orchestrator.received`.
3. Carga `documents`.
4. Si no hay `uploaded_at`, falla permanentemente.
5. Si falta `COMPUTE_GATEWAY_URL`, deja la corrida en `queued`.
6. Crea signed URL temporal del archivo.
7. Crea job MinerU en `/v1/index-jobs`.
8. Pollea el job hasta terminal.
9. Persiste `document_extractions` y `document_extraction_artifacts`.
10. Crea job Tree Indexer en `/v1/tree-index-jobs`.
11. Pollea el arbol hasta terminal.
12. Marca `indexed` o `failed`.

## Reconciliador

Archivo:

```text
inngest/functions/reconcile-document-indexing.ts
```

Corre por cron (`INDEXING_RECONCILER_CRON`, default `*/2 * * * *`).

Hace:

- Cierra corridas activas si ya existe `doc_tree` y `chunks`.
- Falla corridas cuyo upload nunca se completo.
- Encola documentos `uploaded` sin corrida activa.
- Redispatcha corridas `queued` viejas.
- Reencola corridas `running` sin progreso reciente.

Esto cubre casos donde el upload completo, pero el request de encolado o un
workflow murio a mitad de camino.

## Reglas de idempotencia

- Una corrida activa por documento.
- Inngest debe reclamar antes de crear jobs externos.
- Redispatch no debe crear dos jobs MinerU para la misma corrida reclamada.
- Si Storage dice "object not found", se trata como corrupcion permanente de
  upload y no como retry infinito.
- Si el arbol y chunks ya estan persistidos, el reconciliador puede cerrar la
  corrida aunque Inngest haya muerto antes del ultimo update.

