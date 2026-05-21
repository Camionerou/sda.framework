# Redis backpressure y snapshots live

Estado: implementado localmente.

## Cambios

- `POST /api/documents/:id/indexing/request` reserva un slot Redis por tenant
  antes de despachar a Inngest.
- El reconciliador respeta el mismo backpressure antes de redispatchar corridas.
- El workflow de indexacion escribe snapshots live de corrida en Redis por run,
  documento y ultimo snapshot global.
- El workflow libera slots al terminar, fallar, cancelarse o quedar esperando
  Compute Gateway.
- `indexing:health` ahora reporta heartbeats Redis, ultimo snapshot live y
  slots activos por tenant.
- Se bumppeo `app` a `0.1.4`, `indexing_pipeline` a `0.1.4` e
  `inngest_indexing_workflow` a `0.1.3`.
- Se sincronizo `system_component_versions` en Supabase remoto con
  `npm run versions:sync`.

## Env

```text
INDEXING_TENANT_ACTIVE_LIMIT=2
INDEXING_TENANT_ACTIVE_TTL_SECONDS=3600
INDEXING_RUN_SNAPSHOT_TTL_SECONDS=3600
```

## Contrato

- Redis protege compute y mejora observabilidad, pero el estado durable sigue
  en Supabase/Inngest.
- Si Redis falla, la indexacion degrada en abierto.
- El backpressure usa sorted sets con cleanup por timestamp para evitar locks
  permanentes.

## Verificacion

- `npm run secrets:scan`
- `npm run env:doctor`
- `npm run redis:health`
- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm run versions:check -- --base HEAD`
- `npm run versions:sync -- --dry-run`
- `npm run versions:sync`
- `npm run indexing:health`
- `npm run test:tree-indexer`
- `npm run test:db`
