# Infra env, secretos y cache Redis

Estado: implementado localmente.

## Cambios

- Se agrego `npm run env:doctor` para validar configuracion sin imprimir
  secretos.
- Se agrego `npm run secrets:scan` para detectar secretos accidentales en
  archivos trackeables por Git.
- CI corre ambos checks antes de lint/typecheck/build.
- Redis ahora guarda snapshots operativos de detalle documental para documentos
  en estado terminal.
- La cache se invalida cuando se solicita una nueva indexacion.

## Criterio Redis

Upstash se usa como plataforma seria para estado operacional valioso:

- rate limits;
- locks efimeros;
- heartbeats;
- caches server-side reconstruibles.

No se usa para archivos completos, signed URLs, service-role keys ni estado que
no pueda reconstruirse desde Supabase/Inngest.

## Verificacion aplicada

- `npm run secrets:scan`
- `npm run env:doctor`
- `npm run redis:health`
- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm run versions:check -- --base HEAD`
- `npm run versions:sync -- --dry-run`
- `npm run indexing:health`
- `npm run test:tree-indexer`
- `npm run test:db`

`env:doctor` queda con warnings conocidos del entorno local:

- `SUPABASE_URL` y `NEXT_PUBLIC_SUPABASE_URL` apuntan a hosts distintos;
- falta `INNGEST_API_KEY` local para sync manual;
- falta `COMPUTE_GATEWAY_URL`/token local;
- Google OAuth no esta configurado en este shell.
