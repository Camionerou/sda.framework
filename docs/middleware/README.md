# Middleware

Esta carpeta documenta la capa entre browser, Next.js, Supabase y las rutas que
cambian estado.

## Piezas actuales

| Pieza | Archivo | Responsabilidad |
| --- | --- | --- |
| Next proxy | `proxy.ts` | Ejecuta `updateSession(request)` para refrescar cookies Supabase. |
| Supabase SSR proxy | `lib/supabase/proxy.ts` | Crea server client, lee claims y propaga cookies renovadas. |
| CSRF/same-origin | `lib/auth/csrf.ts` | Bloquea `POST` cross-origin en rutas sensibles. |
| Rate limit | `lib/redis/rate-limit.ts` | Limita accept invite e indexing request cuando Redis esta configurado. |
| RLS | Migraciones Supabase | Aisla datos por tenant en Postgres y Storage. |

## Flujo de request

```text
Browser
  -> proxy.ts
  -> updateSession(request)
  -> cookies Supabase refrescadas si hace falta
  -> page / route handler
  -> page o handler vuelve a validar claims segun su contrato
```

El proxy no reemplaza auth en paginas ni handlers. Cada superficie protegida
debe llamar `supabase.auth.getClaims()` y decidir si redirige, responde `401` o
responde `403`.

## Matcher

`proxy.ts` corre para casi todo excepto assets estaticos:

```text
/_next/static
/_next/image
/favicon.ico
*.svg, *.png, *.jpg, *.jpeg, *.gif, *.webp
```

## Rutas protegidas por same-origin

- `POST /auth/sign-out`
- `POST /api/documents/:id/indexing/request`

`requireSameOrigin(request)` acepta:

- requests sin `origin` salvo `sec-fetch-site: cross-site`;
- `origin` igual al request URL;
- origins configurados por `APP_ORIGIN`, `NEXT_PUBLIC_APP_URL`,
  `VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_BRANCH_URL` o `VERCEL_URL`.

## Rate limits actuales

- Aceptar invitacion en `/auth/callback` cuando viene `invite_token`.
- Pedir indexacion en `POST /api/documents/:id/indexing/request`.

Sin Upstash configurado, el sistema debe degradar en abierto y confiar en la
idempotencia durable de Postgres/Inngest.

## Fronteras de seguridad

- Middleware/proxy mantiene cookies sanas.
- CSRF protege rutas `POST` con efectos.
- RLS protege datos por tenant.
- RPCs encapsulan escrituras sensibles.
- Route Handlers encapsulan signed URLs, Inngest y logica server-side.
- Workers privados quedan fuera del browser.

## Al agregar una ruta nueva

1. Si cambia estado, usar `requireSameOrigin`.
2. Si depende del tenant, validar claims y dejar que RLS filtre.
3. Si llama servicios externos o usa secretos, hacerlo server-side.
4. Si puede recibir clicks repetidos, evaluar Redis rate limit/lock o una RPC
   idempotente.
5. Documentarla en `docs/backend/09-catalogo-api-rutas.md`.
