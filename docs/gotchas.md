# Gotchas

## Google OAuth with Supabase

- The frontend must implement `/auth/callback`. Supabase redirects users back to the `redirect_to` URL after Google finishes auth.
- Google Cloud Console redirect URIs must point to Supabase Auth callbacks, not the frontend callback:
  - Local: `http://127.0.0.1:54321/auth/v1/callback`
  - Remote: `https://anfawvxfepowsudlffnl.supabase.co/auth/v1/callback`
- Frontend callback URLs still need to be allow-listed in Supabase Auth `additional_redirect_urls`:
  - `http://localhost:3000/auth/callback`
  - `http://127.0.0.1:3000/auth/callback`
- `supabase config push` resolves `env(...)` values from the shell that runs the command. If the Google client ID/secret were exported in another terminal, the push will not see them.
- Never commit the Google client secret. Keep it in environment variables or the eventual secrets manager.

## Invite-Only Onboarding

- A newly authenticated Google user does not automatically have `tenant_id` claims. The custom JWT hook only emits tenant claims after `public.users` has an active row for that auth user.
- The callback flow must accept an invite first, then refresh the Supabase session so the next JWT includes `tenant_id` and `tenant_role`.
- Invite links should carry the one-time invite token. The database stores only `token_hash`, never the raw token.
- Only tenant admins can create/revoke normal invites. Owner invites are reserved for `service_role` bootstrap flows.

## Inngest Cloud

- `INNGEST_EVENT_KEY` lets the app send events to Inngest. `INNGEST_SIGNING_KEY` protects `/api/inngest` and lets Inngest identify the correct environment.
- Do not set `INNGEST_DEV=1` in production. That flag is only for local Dev Server mode.
- Keys alone are not enough for cloud execution. Inngest Cloud also needs a public HTTPS URL for the serve endpoint, for example `https://app.example.com/api/inngest`.
- A Cloudflare quick tunnel can expose localhost for a temporary test, but it is not production hosting. The final setup needs a stable deploy URL.
- If keys are pasted in chat, rotate them after validation from Inngest Cloud.
