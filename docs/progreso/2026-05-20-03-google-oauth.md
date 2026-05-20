# Google OAuth

Estado: listo en Supabase remoto.

## Hecho

- Se eligió Google OAuth como proveedor de login.
- Se configuró `auth.external.google` en `supabase/config.toml`.
- Se documentó el setup manual en Google Cloud.
- Se verificó que el authorize remoto redirige correctamente a Google.

## URLs importantes

Callback Supabase remoto para Google Cloud:

```text
https://anfawvxfepowsudlffnl.supabase.co/auth/v1/callback
```

Callbacks frontend allow-listed en Supabase:

```text
http://localhost:3000/auth/callback
http://127.0.0.1:3000/auth/callback
```

## Archivos relevantes

- `supabase/config.toml`
- `supabase/google-oauth.md`
- `docs/gotchas.md`

## Gotcha

`supabase config push` resuelve `env(...)` desde la terminal que ejecuta el
comando. Si los env vars están exportados en otra terminal, el push no los ve.
