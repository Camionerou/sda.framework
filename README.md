# SDA Framework

App empresarial multitenant para ingesta, indexacion y consulta de documentos
con un indice semantico tipo arbol verificable.

## Stack vigente

- Next.js 16 App Router para UI, route handlers y server-side workflows chicos.
- Supabase Auth, Postgres, RLS, Storage privado y Realtime como fuente durable.
- Inngest para orquestacion durable de indexacion, retries y reconciliador.
- `srv-ia-01` para Compute Gateway, MinerU y Tree Indexer Python.
- Upstash Redis para estado operacional rapido y reconstruible: rate limits,
  locks con TTL, heartbeats y cache server-side corto.

## Comandos principales

```bash
npm run secrets:scan
npm run env:doctor
npm run lint
npm run typecheck
npm run build
npm run redis:health
npm run indexing:health
npm run test:tree-indexer
npm run test:db
```

`secrets:scan` y `env:doctor` corren en CI antes de lint/typecheck/build.
`env:doctor` usa `.env.local` como fuente local del proyecto y deja faltantes
externos no criticos como `info` en modo default. `redis:health` pasa sin
secretos cuando Redis no esta configurado; si hay Upstash env, exige `PONG`.

## Redis

Redis no reemplaza Supabase ni Inngest. Se usa para datos que toleran TTL o se
pueden reconstruir:

- rate limit de requests de indexacion;
- lock efimero de dispatch por tenant/documento/run;
- backpressure de corridas activas por tenant;
- heartbeat corto de API/workers;
- snapshot live de la ultima corrida de indexacion;
- cache de snapshots de detalle documental en estados terminales.

No guardar ahi archivos completos, signed URLs, service-role keys ni permisos.

## Documentacion

- [`docs/arquitectura.md`](./docs/arquitectura.md): arquitectura general.
- [`docs/backend/README.md`](./docs/backend/README.md): mapa granular del backend.
- [`docs/backend/07-operacion-env-health.md`](./docs/backend/07-operacion-env-health.md): env, health checks y debugging.
- [`docs/backend/08-upstash-redis.md`](./docs/backend/08-upstash-redis.md): contrato Redis.
- [`docs/gotchas.md`](./docs/gotchas.md): decisiones y trampas operativas.
- [`CHANGELOG.md`](./CHANGELOG.md): historial incremental consolidado.
