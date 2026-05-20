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
- Before running `supabase config push`, make sure `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` and `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_SECRET` are available in that same shell. Otherwise the remote Google provider can receive the literal `env(...)` placeholder.
- Production OAuth needs Supabase Auth URL Configuration to use `https://sda-framework.vercel.app` as Site URL and `https://sda-framework.vercel.app/auth/callback` in Redirect URLs. Google Cloud still points to the Supabase callback URL.

## Invite-Only Onboarding

- A newly authenticated Google user does not automatically have `tenant_id` claims. The custom JWT hook only emits tenant claims after `public.users` has an active row for that auth user.
- The callback flow must accept an invite first, then refresh the Supabase session so the next JWT includes `tenant_id` and `tenant_role`.
- Invite links should carry the one-time invite token. The database stores only `token_hash`, never the raw token.
- Only tenant admins can create/revoke normal invites. Owner invites are reserved for `service_role` bootstrap flows.
- `expires_at = null` means the invite does not expire automatically. Owner invites created by `service_role` and invites created from an owner session default to this mode.
- When a non-owner admin explicitly chooses no expiration, send `_metadata.never_expires = true`; otherwise `_expires_at = null` is also the "use role default" signal inside the RPC.

## Next.js Redirects

- `redirect()` throws a framework control-flow error (`NEXT_REDIRECT`). Do not wrap it inside broad `try/catch` blocks that render the error message to the UI.
- If a page needs to catch config/session errors before redirecting, store a boolean inside the `try/catch` and call `redirect()` afterwards.

## Inngest Cloud

- `INNGEST_EVENT_KEY` lets the app send events to Inngest. `INNGEST_SIGNING_KEY` protects `/api/inngest` and lets Inngest identify the correct environment.
- Do not set `INNGEST_DEV=1` in production. That flag is only for local Dev Server mode.
- Keys alone are not enough for cloud execution. Inngest Cloud also needs a public HTTPS URL for the serve endpoint, for example `https://app.example.com/api/inngest`.
- A Cloudflare quick tunnel can expose localhost for a temporary test, but it is not production hosting. The final setup needs a stable deploy URL.
- If keys are pasted in chat, rotate them after validation from Inngest Cloud.
- Inngest Cloud app sync can be triggered programmatically against `https://api.inngest.com/v2/apps/<app-id>/syncs` using an Inngest API key. The event key is for sending events, and the signing key secures app/server communication; do not assume either one replaces the REST API key.

## Compute Gateway

- Inngest must not pass Supabase service-role keys to the gateway. It sends a short-lived signed URL for the specific document.
- Do not log `document.signed_url` in the gateway, Inngest step output, or DB metadata. Store only job ids, storage paths, and sanitized status.
- `COMPUTE_GATEWAY_URL` enables real dispatch. Without it, the app keeps the run queued and writes a live `indexing.compute_gateway.pending` event.
- The gateway token is shared between Vercel and `srv-ia-01`; rotate it if it is pasted into chat or shell history.
- `srv-ia-01` is currently exposed through Tailscale Funnel at `https://srv-ia-01.taileb1b9c.ts.net`; keep bearer auth enabled because Funnel is public HTTPS.
- Worker deploys on `srv-ia-01` should treat the remote Compute Gateway `.env` as the source of truth for `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Local shells may contain stale Supabase URLs from earlier projects.
- Keep the FastAPI Tree Indexer private behind the Node Compute Gateway unless there is a specific reason to expose another Funnel route. The gateway already proxies `/v1/tree-index-jobs`.
- OpenRouter can return `401 User not found` when the API key itself is invalid, even if the model/provider config is correct. First test the key with a minimal request before debugging Tree Indexer prompts.
- Do not set a low `max_tokens` cap on tree construction. Gemini 3.5 Flash can spend early output budget on reasoning and return empty `content` if capped too tightly. Prefer controlling reasoning with `reasoning.effort` and `reasoning.exclude`, leaving output uncapped unless there is a measured reason.
- PDFs with repeated logos, brand names, page headers, or family labels before the real title can confuse the LLM range verifier. Keep a deterministic title-near-page-start guard so section ranges do not absorb the next page.

## Upload vs Ingestion

- Upload success must depend only on Supabase DB + Storage. Inngest/Compute Gateway failures should show as ingestion warnings, not upload failures.
- Document dedupe uses `checksum_sha256` per tenant only after `uploaded_at` is set. A half-uploaded attempt should not block the same file forever.
- Duplicate uploads should return the existing document and skip Storage upload; ingestion can be requested separately from the document detail.
- If Storage rejects an upload after the `documents` row is created, call `mark_document_upload_failed` so the library shows `failed` instead of stale `uploading`.
- Automatic indexing needs a cloud reconciler, not only the upload request. The upload path may fail after Storage succeeds, so Inngest must periodically enqueue uploaded documents without active runs and redispatch stale queued runs.
- The indexing worker must claim `indexing_runs` idempotently before creating compute jobs. Reconciler redispatches are expected, and duplicate Inngest events must not create duplicate MinerU jobs.
- Never index a document that does not have `uploaded_at`. If Storage returns `Object not found`, treat it as permanent upload corruption: fail the run/document and emit `indexing.storage_object_missing` instead of leaving the run `running`.
- A document with persisted `doc_tree` plus chunks is materially indexed even if a previous Inngest run died before the final status update. The reconciler should close that run as `completed/indexed`.

## Next.js links with side effects

- Do not use `next/link` for routes with side effects like `/auth/sign-out`. In production, prefetch/navigation behavior can call the route before the user intends to sign out.
- Use a plain `<a>` tag or a POST form for sign-out. Keep `next/link` for safe navigation only.
