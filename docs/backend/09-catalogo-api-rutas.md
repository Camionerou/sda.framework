# Catalogo De API Y Rutas

Este es el catalogo canonico de superficies consumibles. Esta escrito desde el
codigo actual, no desde planes historicos.

## Reglas generales

- Browser nunca usa `SUPABASE_SERVICE_ROLE_KEY`.
- Datos multitenant se leen con Supabase y RLS siempre que alcance.
- Route Handlers se usan para signed URLs, Inngest, CSRF, rate limits y detalles
  server-side.
- Workers privados no se llaman desde el browser.
- Las rutas `POST` que cambian estado deben pasar por same-origin/CSRF.

## Rutas UI Next

| Ruta | Archivo | Quien la usa | Auth | Proposito |
| --- | --- | --- | --- | --- |
| `GET /login` | `app/login/page.tsx` | Usuario | Publica | Login Google; acepta `invite_token`, `error`, `message`. |
| `GET /auth/callback` | `app/auth/callback/route.ts` | Supabase Auth | OAuth code | Intercambia `code`, acepta invitacion si hay `invite_token`, refresca claims y redirige. |
| `POST /auth/sign-out` | `app/auth/sign-out/route.ts` | Form UI | Same-origin | Cierra sesion y redirige a `/login`. No usar `next/link`. |
| `GET /app` | `app/app/page.tsx` | Usuario autenticado | Claims + RLS | Dashboard del tenant, perfil y conteos. |
| `GET /app/documents` | `app/app/documents/page.tsx` | Usuario autenticado | Claims + RLS | Biblioteca, upload y listado de documentos visibles. |
| `GET /app/documents/:id` | `app/app/documents/[id]/page.tsx` | Usuario autenticado | Claims + tenant | Detalle, timeline live, estado de indice y descarga. |
| `GET /app/documents/:id/download` | `app/app/documents/[id]/download/route.ts` | Link/boton UI | Claims + RLS | Redirige a signed URL con `download`, TTL 60 segundos. |
| `GET /app/invites` | `app/app/invites/page.tsx` | Owner/admin | Claims + RLS | Alta, listado y revocacion de invitaciones del tenant. |

## Route Handlers API

### `GET /api/documents/:id/file-url`

Archivo: `app/api/documents/[id]/file-url/route.ts`

Uso principal: visor PDF embebido.

Auth:

- Sesion Supabase por cookies.
- `supabase.auth.getClaims()`.
- Lectura de `documents` bajo RLS.

Respuesta `200`:

```json
{
  "url": "https://.../signed...",
  "expiresAt": "2026-05-21T12:34:56.000Z",
  "mimeType": "application/pdf",
  "filename": "contrato.pdf",
  "byteSize": 1048576
}
```

Errores esperados:

- `400 invalid_document_id`.
- `401 unauthorized`.
- `404 document_not_found`.
- `500 document_lookup_failed`.
- `502 file_url_failed`.

Notas:

- Firma inline sin `download`.
- TTL por `PDF_VIEWER_SIGNED_URL_TTL`, default `900`.
- El frontend debe refrescar antes de `expiresAt`.

### `POST /api/documents/:id/indexing/request`

Archivo: `app/api/documents/[id]/indexing/request/route.ts`

Uso principal: pedir primera indexacion o reindexacion.

Auth y protecciones:

- `requireSameOrigin(request)`.
- Sesion Supabase por cookies.
- Claims `sub` y `tenant_id`.
- Rate limit Redis cuando Upstash esta configurado.
- RPC `request_document_indexing`.
- Lock efimero y backpressure Redis antes de despachar a Inngest.

Body recomendado:

```json
{
  "source": "document_upload"
}
```

Valores actuales de `source` usados por UI:

- `document_upload`
- `document_detail`

Respuesta `200` normal:

```json
{
  "eventQueued": true,
  "run": {
    "document_id": "uuid",
    "progress": 0,
    "run_id": "uuid",
    "stage": "queued",
    "status": "queued"
  }
}
```

Respuesta `200` sin Inngest configurado:

```json
{
  "eventQueued": false,
  "run": {
    "document_id": "uuid",
    "progress": 0,
    "run_id": "uuid",
    "stage": "queued",
    "status": "queued"
  },
  "warning": "INNGEST_EVENT_KEY o INNGEST_DEV no estan configurados."
}
```

Errores esperados:

- `401 Authentication required`.
- `403 Tenant claim is required` o error same-origin.
- `400` con error de RPC.
- `429` por rate limit o backpressure.
- `500` si la RPC no devuelve `run_id`.

### `GET|POST|PUT /api/inngest`

Archivo: `app/api/inngest/route.ts`

Uso principal: endpoint de Inngest Cloud/Dev Server.

Funciones expuestas:

- `processDocumentIndex`.
- `reconcileDocumentIndexing`.
- `recordTreeGraphEvent`.

Notas:

- No es endpoint para UI.
- Requiere env Inngest correctos en despliegue.
- Runtime `nodejs`, `maxDuration = 60`, streaming habilitado.

## Server Actions

| Action | Archivo | Quien la llama | Contrato |
| --- | --- | --- | --- |
| `createInviteAction` | `app/app/invites/actions.ts` | `InviteCreateForm` | Valida email/rol/expiracion, exige owner/admin, llama RPC `create_tenant_invite`, devuelve `inviteUrl`. |
| `revokeInviteAction` | `app/app/invites/actions.ts` | Form en `/app/invites` | Llama RPC `revoke_tenant_invite`, revalida `/app` y `/app/invites`, redirige con estado. |

## Supabase RPCs Consumidas Por Frontend/App

| RPC | Donde se usa | Cliente | Proposito |
| --- | --- | --- | --- |
| `create_document_upload` | `components/documents/document-upload-form.tsx` | Browser anon + RLS | Crea row `documents`, devuelve bucket/path y dedupe. |
| `mark_document_uploaded` | `components/documents/document-upload-form.tsx` | Browser anon + RLS | Marca upload completo despues de Storage. |
| `mark_document_upload_failed` | `components/documents/document-upload-form.tsx` | Browser anon + RLS | Marca falla de Storage para no dejar `uploading` eterno. |
| `request_document_indexing` | `lib/indexing/request.ts` | Server route | Crea o reutiliza corrida y eventos iniciales. |
| `accept_tenant_invite` | `app/auth/callback/route.ts` | Server route | Acepta invite token despues del OAuth. |
| `create_tenant_invite` | `app/app/invites/actions.ts` | Server action | Crea invitacion y devuelve token raw una sola vez. |
| `revoke_tenant_invite` | `app/app/invites/actions.ts` | Server action | Revoca invitacion pendiente. |

## Tablas Leidas Directamente

Server Components y helpers leen por Supabase con RLS o con admin server-side
cuando hay una cache controlada:

- `users`
- `tenant_invites`
- `documents`
- `doc_tree`
- `chunks`
- `indexing_runs`
- `indexing_events`
- `conversations`

Realtime actual:

- `documents` filtrado por `tenant_id` para biblioteca live.
- `indexing_runs` filtrado por `document_id`.
- `indexing_events` filtrado por `document_id`.
- `document_extractions` filtrado por `document_id`.
- `document_extraction_artifacts` filtrado por `document_id`.

Topics privados:

- `tenant:<tenant_id>:notifications` para Broadcast de cambios livianos.
- `document:<document_id>:presence` para usuarios activos en workspace.
- `document:<document_id>:indexing` para Broadcast de run/eventos de
  indexacion.

Ver contrato completo en [`10-supabase-realtime.md`](./10-supabase-realtime.md).

## Storage

Bucket: `documents`.

Path original:

```text
<tenant_id>/<document_id>/<safe_filename>
```

Browser:

- Sube directo con `supabase.storage.from(bucket).upload(path, file)`.
- No construye signed URLs privadas.

Server:

- `GET /app/documents/:id/download` firma URL con `download`.
- `GET /api/documents/:id/file-url` firma URL inline para visor.

## Workers Privados

No llamar desde frontend. Los consume Inngest/server con bearer token.

Compute Gateway:

```text
GET  /v1/health
POST /v1/index-jobs
GET  /v1/index-jobs/:id
POST /v1/tree-index-jobs
GET  /v1/tree-index-jobs/:id
GET  /v1/tree-index-jobs/:id/result
```

Tree Indexer Python directo:

```text
GET  /v1/health
POST /v1/tree-index-jobs
GET  /v1/tree-index-jobs/:job_id
GET  /v1/tree-index-jobs/:job_id/result
```

## Pendiente

- Chat agent de usuario final.
- SSE de conversaciones.
- Retrieval tools productivas sobre `doc_tree` y `chunks`.
- Embeddings jerarquicos productivos.
