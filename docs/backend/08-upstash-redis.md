# Upstash Redis

Estado: implementado como infraestructura operacional TTL/reconstruible.

Redis no es fuente de verdad del sistema, pero si es una plataforma seria para
estado operacional de alto valor. La verdad durable sigue en Supabase, RLS,
`indexing_runs`, `indexing_events` e Inngest. Si Redis se degrada, la app debe
seguir permitiendo upload, lectura de documentos e indexacion.

## Usos actuales

- Rate limit del endpoint `POST /api/documents/:id/indexing/request` por
  tenant/user.
- Backpressure por tenant para limitar corridas activas antes de despachar a
  Inngest o desde el reconciliador.
- Lock efimero con TTL para evitar doble dispatch inmediato de la misma corrida
  de indexacion.
- Heartbeat corto de la API de indexacion y del workflow.
- Snapshot live de corrida por run/documento y ultimo snapshot global para
  health/debugging.
- Cache server-side de snapshots operativos de detalle documental cuando el
  documento y su corrida estan en estado terminal.
- Health check local/CI con `npm run redis:health`.

## Env

```text
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
UPSTASH_REDIS_KEY_PREFIX=sda:local
UPSTASH_REDIS_RATELIMIT_TIMEOUT_MS=1000
UPSTASH_REDIS_RATELIMIT_ANALYTICS=0
UPSTASH_REDIS_HEARTBEAT_TTL_SECONDS=120
INDEXING_REQUEST_RATE_LIMIT_MAX=20
INDEXING_REQUEST_RATE_LIMIT_WINDOW="1 m"
INDEXING_DISPATCH_LOCK_TTL_SECONDS=120
INDEXING_TENANT_ACTIVE_LIMIT=2
INDEXING_TENANT_ACTIVE_TTL_SECONDS=3600
INDEXING_RUN_SNAPSHOT_TTL_SECONDS=3600
DOCUMENT_DETAIL_CACHE_TTL_SECONDS=60
```

`UPSTASH_REDIS_KEY_PREFIX` debe diferenciar ambientes, por ejemplo
`sda:local`, `sda:preview` o `sda:production`.

## Comandos

```bash
npm run redis:health
```

Sin URL/token, el comando responde `configured: false` y sale con codigo `0`.
Con URL/token, hace `PING` al REST endpoint de Upstash y falla si no recibe
`PONG`.

## Contrato de degradacion

- Sin Redis configurado: rate limit deshabilitado, locks se consideran
  adquiridos, backpressure se permite en abierto y heartbeats/snapshots no se
  escriben.
- Redis con error transitorio: las rutas deben seguir fail-open y apoyarse en
  la idempotencia durable de Postgres/Inngest.
- Redis puede guardar metadata operativa server-side de documentos ya
  procesados, como snapshot de detalle, conteos y timeline. No debe guardar
  archivos completos, secretos, signed URLs ni service-role keys.
- Los locks tienen TTL corto; no se usan como coordinador durable.
- Las caches deben tener TTL y una ruta clara de invalidacion o reconstruccion.
- El backpressure usa sorted sets con vencimiento por score. Si un workflow cae
  sin liberar el slot, el cleanup por timestamp evita bloqueo permanente.

## Archivos

- `lib/redis/client.ts`: cliente central, keys namespaced, locks, heartbeat.
- `lib/redis/rate-limit.ts`: rate limit de requests de indexacion.
- `lib/indexing/redis.ts`: wrappers especificos de indexacion, backpressure y
  snapshots live.
- `lib/redis/document-detail-cache.ts`: cache de snapshots terminales de detalle.
- `scripts/health/redis-health.mjs`: smoke de conectividad.
- `scripts/health/indexing-health.mjs`: incluye Redis configurado, heartbeats,
  ultimo snapshot live y corridas activas por tenant.
