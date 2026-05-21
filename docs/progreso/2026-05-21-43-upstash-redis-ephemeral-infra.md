# Upstash Redis operacional base

Estado: implementado localmente como primera base operacional. Luego se amplio
en `2026-05-21-44-infra-env-secret-redis-cache.md` con cache server-side de
detalle documental.

## Cambios

- Se agregaron `@upstash/redis` y `@upstash/ratelimit`.
- Se creo `lib/redis.ts` como cliente central con prefijo por ambiente, locks
  con TTL y heartbeats.
- Se creo `lib/rate-limit.ts` para rate limit de requests de indexacion.
- Se creo `lib/indexing-redis.ts` para locks/heartbeats especificos de
  indexacion.
- `POST /api/documents/:id/indexing/request` ahora aplica rate limit opcional,
  usa lock efimero antes de despachar a Inngest y escribe heartbeat corto.
- Se agrego `npm run redis:health` y CI lo ejecuta sin requerir secretos.

## Contrato

- Redis es operacional y fail-open para no cortar documentos si se degrada.
- Redis no reemplaza `indexing_runs`, `indexing_events`, RLS ni Inngest.
- No se commitean tokens. Configurar con `UPSTASH_REDIS_REST_URL` y
  `UPSTASH_REDIS_REST_TOKEN`.
- Los documentos existentes siguen siendo usables aunque Redis falle.

## Verificacion

- `npm run redis:health`
- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm run versions:check -- --base HEAD`
- `npm run versions:sync -- --dry-run`
- `npm run indexing:health`
- `npm run test:tree-indexer`
- `npm run test:db`
