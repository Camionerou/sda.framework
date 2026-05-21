# Indexacion E Inngest

## Entrada

Ruta:

```text
POST /api/documents/:id/indexing/request
```

Hace:

1. Valida sesion y claims.
2. Aplica rate limit con Upstash Redis si esta configurado.
3. Ejecuta RPC `request_document_indexing`.
4. Crea o reutiliza una corrida en `indexing_runs`.
5. Inserta evento inicial en `indexing_events`.
6. Invalida cache Redis de detalle documental para ese documento.
7. Toma un lock efimero por tenant/documento/run antes de despachar.
8. Reserva un slot Redis de backpressure por tenant.
9. Envia `document/index.requested` a Inngest si hay `INNGEST_DEV=1` o
   `INNGEST_EVENT_KEY`, con event id estable `document-index:<run_id>`.

Si Inngest no esta configurado, la ruta responde con `eventQueued: false` y una
advertencia, pero conserva la corrida en DB.

La RPC toma las versiones latest desde `_metadata.versions`, generado por
`lib/system-versions.json` en la app. No debe consultar
`system_component_versions` para decidir versiones operativas.

## Tablas

`indexing_runs`:

- Una corrida activa por documento (`queued` o `running`).
- Tiene `stage`, `progress`, `attempt`, `compute_job_id`, `inngest_run_id`.
- Guarda versiones de pipeline.

`indexing_events`:

- Timeline historico.
- Realtime para UI.
- Mensajes accionables por etapa.

`document_extractions` y `document_extraction_artifacts`:

- Estado y artefactos del parseo MinerU.
- Realtime para el panel de workspace.
- No se escriben desde browser; los persisten workers/backend.

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
inngest/functions/process-document-index/
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

Si la corrida fue reencolada por el reconciliador y todavia conserva un
`compute_job_id` compatible con las versiones actuales, el workflow retoma ese
job remoto en vez de crear otro MinerU.

## Transiciones de estado

Archivo:

```text
lib/indexing/state.ts
```

`recordTransition` usa descriptores declarativos del workflow y termina llamando
a `recordIndexingTransition`, que coordina en un solo lugar:

- update opcional de `indexing_runs`;
- update opcional de `documents`;
- insert en `indexing_events`;
- snapshot live en Redis;
- liberacion del slot Redis de backpressure cuando la transicion es terminal o
  vuelve a `queued`.

El workflow puede seguir haciendo escrituras de dominio por fuera de este
helper, por ejemplo `document_extractions` y `document_extraction_artifacts`.
Lo que no debe duplicarse por fuera es el paquete run/document/event/snapshot:
si se agrega un nuevo estado operativo, debe declararse en
`inngest/functions/process-document-index/transitions.ts` y pasar por
`recordTransition`, `transitionInput` o `recordPermanentIndexingFailure`.

El claim inicial de `indexing_runs` sigue siendo directo porque necesita un
`update ... where status = queued ... select` atomico para evitar doble
procesamiento.

## Reconciliador

Archivo:

```text
inngest/functions/reconcile-document-indexing.ts
```

Corre por cron (`INDEXING_RECONCILER_CRON`, default `*/2 * * * *`).

Hace:

- Cierra corridas activas si ya existe `doc_tree` y `chunks` del mismo
  `run_id` y con las mismas versiones del run.
- Falla corridas cuyo upload nunca se completo.
- Encola documentos `uploaded`, `queued`, `parsing` o `structuring` sin corrida
  activa.
- Redispatcha corridas `queued` viejas.
- Reencola corridas `running` sin progreso reciente.
- Respeta el backpressure Redis por tenant antes de redispatchar.

Esto cubre casos donde el upload completo, pero el request de encolado o un
workflow murio a mitad de camino.

## Reglas de idempotencia

- Una corrida activa por documento.
- Inngest debe reclamar antes de crear jobs externos.
- El evento `document/index.requested` usa `run_id` como idempotency key de
  productor y la funcion principal usa `idempotency: event.data.run_id`.
- El lock Redis de dispatch es una barrera efimera contra doble click o
  redispatch inmediato; no reemplaza la unicidad durable en Postgres.
- El backpressure Redis limita corridas activas por tenant y se libera cuando
  el workflow termina, falla, se cancela o queda esperando Compute Gateway.
- La cache Redis de detalle documental solo se usa para estados terminales y se
  invalida antes de una nueva indexacion.
- El workflow escribe snapshots live reconstruibles en Redis para health y
  futura UI operacional.
- Redispatch no debe crear dos jobs MinerU para la misma corrida reclamada.
- Si un run stale tiene `compute_job_id` y las versiones coinciden, el
  redispatch puede reutilizar ese job. Si las versiones cambiaron, debe borrar
  `compute_job_id` y arrancar limpio.
- Si Storage dice "object not found", se trata como corrupcion permanente de
  upload y no como retry infinito.
- Si el arbol y chunks ya estan persistidos, el reconciliador solo puede cerrar
  la corrida cuando `doc_tree.metadata.run_id` y `chunks.metadata.run_id`
  pertenecen a esa corrida y las columnas de version coinciden.
