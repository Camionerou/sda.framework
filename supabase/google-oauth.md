# Google OAuth Setup

Google OAuth is the selected social auth provider for this project.

## Google Cloud Console

Create a Web application OAuth client and configure:

- Authorized JavaScript origins:
  - `http://localhost:3000`
  - `http://127.0.0.1:3000`
  - `https://sdaframework.com`
- Authorized redirect URIs:
  - `http://127.0.0.1:54321/auth/v1/callback`
  - `https://anfawvxfepowsudlffnl.supabase.co/auth/v1/callback`

Supabase Auth must also allow the app redirects configured in `supabase/config.toml`,
including:

- `https://sdaframework.com`
- `https://sdaframework.com/auth/callback`

## Local Environment

Set these locally before enabling the provider:

```sh
export SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID="..."
export SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_SECRET="..."
```

Then update `supabase/config.toml`:

```toml
[auth.external.google]
enabled = true
client_id = "env(SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID)"
secret = "env(SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_SECRET)"
```

Finally run:

```sh
supabase stop
supabase start -x edge-runtime
supabase config push
```
