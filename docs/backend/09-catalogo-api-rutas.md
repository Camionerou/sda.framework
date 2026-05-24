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

## RPCs Tier 1 (workspaces, groups, collections, tags, documents extended)

28 RPCs definidas en migraciones `20260522220000`-`20260522221500`. Todas
`security definer` con `search_path = ''`. Los servicios TypeScript que las
envolveran viven en `lib/workspaces/`, `lib/groups/`, `lib/collections/`,
`lib/tags/` (placeholders). El modelo completo y RLS triple en
[`11-workspaces-collections-groups.md`](./11-workspaces-collections-groups.md)
y [`12-rls-patterns.md`](./12-rls-patterns.md).

### Workspaces RPCs (8)

```text
create_workspace(
  _name text,
  _slug text default null,
  _description text default null,
  _settings jsonb default '{}',
  _request_context jsonb default '{}'
) returns uuid

update_workspace(
  _workspace_id uuid,
  _patch jsonb,
  _request_context jsonb default '{}'
) returns void

archive_workspace(
  _workspace_id uuid,
  _request_context jsonb default '{}'
) returns void

delete_workspace(
  _workspace_id uuid,
  _request_context jsonb default '{}'
) returns void

add_workspace_member(
  _workspace_id uuid,
  _principal_kind public.principal_kind,    -- 'user' | 'group'
  _principal_id uuid,
  _role public.workspace_role default 'workspace_viewer',
  _request_context jsonb default '{}'
) returns void

remove_workspace_member(
  _workspace_id uuid,
  _principal_kind public.principal_kind,
  _principal_id uuid,
  _request_context jsonb default '{}'
) returns void

change_workspace_member_role(
  _workspace_id uuid,
  _principal_kind public.principal_kind,
  _principal_id uuid,
  _role public.workspace_role,
  _request_context jsonb default '{}'
) returns void

set_active_workspace(_workspace_id uuid) returns void
  -- actualiza user_metadata.active_workspace_id; el hook v2 lo refleja en JWT.
```

### Groups RPCs (5)

```text
create_group(
  _key text,
  _name text,
  _description text default null,
  _metadata jsonb default '{}',
  _request_context jsonb default '{}'
) returns uuid

update_group(
  _group_id uuid,
  _patch jsonb,
  _request_context jsonb default '{}'
) returns void

archive_group(
  _group_id uuid,
  _request_context jsonb default '{}'
) returns void

add_group_member(
  _group_id uuid,
  _user_id uuid,
  _request_context jsonb default '{}'
) returns void

remove_group_member(
  _group_id uuid,
  _user_id uuid,
  _request_context jsonb default '{}'
) returns void
```

### Collections RPCs (6)

```text
create_collection(
  _workspace_id uuid,
  _slug text,
  _name text,
  _description text default null,
  _visibility public.collection_visibility default 'workspace_private',
  _request_context jsonb default '{}'
) returns uuid

update_collection(
  _collection_id uuid,
  _patch jsonb,
  _request_context jsonb default '{}'
) returns void

set_collection_visibility(
  _collection_id uuid,
  _visibility public.collection_visibility,   -- 'workspace_private' | 'tenant_public'
  _request_context jsonb default '{}'
) returns void

archive_collection(
  _collection_id uuid,
  _request_context jsonb default '{}'
) returns void

add_document_to_collection(
  _document_id uuid,
  _collection_id uuid,
  _request_context jsonb default '{}'
) returns void

remove_document_from_collection(
  _document_id uuid,
  _collection_id uuid,
  _request_context jsonb default '{}'
) returns void
```

### Tags RPCs (4)

```text
create_tag(
  _key text,
  _label text,
  _color text default null,
  _description text default null,
  _request_context jsonb default '{}'
) returns uuid

update_tag(
  _tag_id uuid,
  _patch jsonb,
  _request_context jsonb default '{}'
) returns void

tag_document(
  _document_id uuid,
  _tag_id uuid,
  _request_context jsonb default '{}'
) returns void

untag_document(
  _document_id uuid,
  _tag_id uuid,
  _request_context jsonb default '{}'
) returns void
```

### Documents RPCs extendidas (5)

`create_document_upload` cambia firma respecto a la version pre-Tier 1
(agrega `_workspace_id` requerido y `_collection_id` opcional). Detalle de
soft-delete y move en [`03-documentos-storage-upload.md`](./03-documentos-storage-upload.md).

```text
create_document_upload(
  _filename text,
  _workspace_id uuid,                       -- nuevo, requerido
  _mime_type text default 'application/pdf',
  _byte_size bigint default null,
  _title text default null,
  _metadata jsonb default '{}',
  _checksum_sha256 text default null,
  _collection_id uuid default null,         -- nuevo, opcional
  _request_context jsonb default '{}'
) returns table (
  document_id uuid,
  tenant_id uuid,
  r2_bucket text,
  r2_key text,
  ...
)

archive_document(
  _document_id uuid,
  _request_context jsonb default '{}'
) returns void

restore_document(
  _document_id uuid,
  _request_context jsonb default '{}'
) returns void

move_document(
  _document_id uuid,
  _to_workspace_id uuid,
  _collection_ids uuid[] default null,
  _request_context jsonb default '{}'
) returns void

bulk_update_documents(
  _document_ids uuid[],
  _patch jsonb,
  _request_context jsonb default '{}'
) returns jsonb
```

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
