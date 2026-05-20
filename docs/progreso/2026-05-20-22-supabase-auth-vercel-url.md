# Supabase Auth Vercel URL

Estado: aplicado remoto.

## Hecho

- Supabase Auth `site_url` quedo en:

```text
https://sda-framework.vercel.app
```

- Supabase Auth `uri_allow_list` incluye:

```text
https://sda-framework.vercel.app
https://sda-framework.vercel.app/auth/callback
http://localhost:3000
http://localhost:3000/auth/callback
http://127.0.0.1:3000
http://127.0.0.1:3000/auth/callback
```

- Google OAuth quedo verificado:
  - provider habilitado;
  - client id restaurado;
  - secret presente en remoto.
- Storage global quedo restaurado inicialmente a `500MiB`. Luego el bucket
  `documents` se elevo a `5GiB` para soportar PDFs pesados.

## Verificacion

- Management API confirmo `site_url = https://sda-framework.vercel.app`.
- Management API confirmo Google OAuth enabled y secret presente.
- Management API confirmo `fileSizeLimit = 524288000`.

## Nota

No correr `supabase config push` sin tener las variables de Google OAuth
exportadas en el mismo shell.
