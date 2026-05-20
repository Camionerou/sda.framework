# Frontend Next Auth

Estado: listo y corriendo local contra Supabase remoto.

## Hecho

- Se creó app Next.js 16 con React 19.
- Se agregó Supabase SSR con `@supabase/ssr`.
- Se implementó:
  - `/login`
  - `/auth/callback`
  - `/auth/sign-out`
  - `/app`
- Login Google soporta `invite_token`.
- Callback hace:
  1. exchange OAuth code
  2. acepta invite si existe token
  3. refresca sesión
  4. redirige a `/app`
- `/app` muestra usuario, tenant, rol, claims y contadores base.

## Archivos relevantes

- `app/login/page.tsx`
- `app/auth/callback/route.ts`
- `app/auth/sign-out/route.ts`
- `app/app/page.tsx`
- `lib/supabase/server.ts`
- `lib/supabase/client.ts`
- `lib/supabase/proxy.ts`
- `proxy.ts`
- `app/globals.css`

## UI

- Componentes base estilo Supabase UI / shadcn:
  - `Button`
  - `Card`
  - `Badge`
- Se evitó `@supabase/auth-ui-react` por estar legacy/deprecated.

## Runtime

- Dev server local:

```text
http://localhost:3000
```

- Producción futura: Vercel + dominio propio.
