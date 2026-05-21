# 2026-05-21 - State machine de indexacion centralizada

Estado: completado.

## Que cambio

- Se agrego `lib/indexing-state.ts` como helper canonico de transiciones de
  indexacion.
- `process-document-index` ya no replica manualmente el bloque
  `indexing_runs` + `documents` + `indexing_events` + Redis snapshot + release
  de backpressure en cada etapa.
- Las transiciones no terminales y terminales pasan por
  `recordIndexingTransition`.
- Las fallas permanentes de upload/storage pasan por
  `recordPermanentIndexingFailure`.
- El claim inicial queda directo porque es la barrera atomica contra doble
  procesamiento.
- `indexing:health` ahora carga `.env.local` con override, igual que
  `env:doctor`, para no reportar mismatch por variables viejas heredadas del
  shell.

## Valor operativo

- Menos drift entre DB, timeline, Redis live state y backpressure.
- Menos riesgo de olvidar liberar el slot activo de Redis en una salida
  terminal.
- Nuevas etapas de indexacion tienen un punto unico donde enchufarse.
- El workflow queda mas corto y auditable sin cambiar el contrato externo de
  Inngest, Supabase ni Compute Gateway.

## Versiones

- `app`: `0.1.5`
- `extraction_pipeline`: `0.1.4`
- `indexing_pipeline`: `0.1.5`
- `inngest_indexing_workflow`: `0.1.4`

## Verificacion

- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm run secrets:scan`
- `npm run env:doctor`
- `npm run redis:health`
- `npm run versions:check`
- `npm run versions:sync -- --dry-run`
- `npm run versions:sync`
- `npm run indexing:health`
- `npm run test:tree-indexer`
- `npm run test:db`

Notas:

- `indexing:health` queda sin anomalias operativas y con Redis OK.
- El unico strict failure esperado en local es `compute_gateway_not_configured`.
- Hay drift de documentos ya indexados contra versiones nuevas; es informativo
  y no fuerza reindexacion.
