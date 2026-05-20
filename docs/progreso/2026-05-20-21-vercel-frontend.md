# Vercel frontend

Estado: deploy productivo creado.

## Hecho

- Proyecto Vercel linkeado como `sdaframework/sda-framework`.
- Repo GitHub `Camionerou/sda.framework` conectado al proyecto Vercel.
- Variables productivas cargadas en Vercel:
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `SUPABASE_SECRET_KEY`
  - `INNGEST_EVENT_KEY`
  - `INNGEST_SIGNING_KEY`
- Deploy productivo listo en:

```text
https://sda-framework.vercel.app
```

## Verificacion

- Deployment Vercel `Ready`.
- `/app` redirige a `/login` sin sesion.
- `/login` responde `200`.
- `/api/inngest` responde `401 Unauthorized` sin firma, esperado con signing
  key activo.

## Pendiente

- Aplicar `supabase config push` con los valores de Google OAuth disponibles en
  el entorno, para que Supabase Auth permita:

```text
https://sda-framework.vercel.app/auth/callback
```

- Sincronizar en Inngest Cloud:

```text
https://sda-framework.vercel.app/api/inngest
```
