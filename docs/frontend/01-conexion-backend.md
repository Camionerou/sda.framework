# Como Conectar El Frontend Al Backend

Guia corta para el frontend dev. La idea es elegir siempre la puerta mas simple
que mantenga seguridad.

## Las tres puertas

### 1. Server Components

Usar cuando la pantalla necesita leer datos iniciales protegidos por RLS.

Import:

```ts
import { createClient } from "@/lib/supabase/server";
```

Patron:

```ts
const supabase = await createClient();
const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();

if (claimsError || !claimsData?.claims) {
  redirect("/login");
}

const { data } = await supabase.from("documents").select("*");
```

Ejemplos vivos:

- `app/app/page.tsx`
- `app/app/documents/page.tsx`
- `app/app/invites/page.tsx`

### 2. Client Components

Usar cuando el usuario interactua desde browser: upload, Realtime o botones que
no necesitan service role.

Import:

```ts
import { createClient } from "@/lib/supabase/client";
```

Ejemplos vivos:

- `DocumentUploadForm`: RPCs + Storage directo.
- `IndexingTimeline`: Supabase Realtime.

Regla: en client component solo se usa publishable/anon key. Nunca service role.

### 3. Route Handlers o Server Actions

Usar cuando hay que esconder logica server-side:

- signed URLs;
- Inngest;
- bearer tokens;
- service role;
- CSRF/same-origin;
- rate limits;
- redirecciones con efectos.

Ejemplos vivos:

- `GET /api/documents/:id/file-url`
- `POST /api/documents/:id/indexing/request`
- `POST /auth/sign-out`
- `createInviteAction`
- `revokeInviteAction`

## Decision rapida

| Necesidad | Usar |
| --- | --- |
| Render inicial de una pagina con datos del tenant | Server Component + Supabase server client |
| Upload de archivo privado | Browser Supabase client + RPC + Storage |
| Timeline live | Browser Supabase client + Realtime filtrado por `document_id` |
| Pedir indexacion | `POST /api/documents/:id/indexing/request` |
| Descargar archivo | Link a `/app/documents/:id/download` |
| Ver PDF embebido | `GET /api/documents/:id/file-url` |
| Crear/revocar invitaciones | Server Action existente |
| Llamar Compute Gateway o Tree Indexer | No desde frontend; pasa por Inngest/backend |
| Leer algo que RLS ya protege | Supabase directo |
| Escribir algo sensible | RPC o Route Handler |

## Flujos actuales

### Upload e indexacion

```text
Usuario elige archivo
  -> browser calcula SHA-256
  -> RPC create_document_upload
  -> Storage upload directo al bucket documents
  -> RPC mark_document_uploaded
  -> POST /api/documents/:id/indexing/request
  -> Inngest + workers
  -> Realtime actualiza timeline
```

Archivos:

- `components/documents/document-upload-form.tsx`
- `app/api/documents/[id]/indexing/request/route.ts`
- `components/documents/indexing-timeline.tsx`

### Detalle de documento

```text
/app/documents/:id
  -> Server Component valida claims
  -> getDocumentDetailSnapshot({ documentId, tenantId })
  -> muestra document, latestRun, indexingEvents, tree y chunks.count
  -> client se suscribe a Realtime para updates
```

Archivos:

- `app/app/documents/[id]/page.tsx`
- `lib/documents/detail.ts`
- `components/documents/indexing-timeline.tsx`

### Visor PDF

Para embeber un PDF:

1. Llamar `GET /api/documents/:id/file-url`.
2. Usar `url` en el visor.
3. Refrescar antes de `expiresAt`.
4. Para highlights, usar `metadata.source_blocks` de chunks/nodos cuando exista.

No usar `/app/documents/:id/download` para visor, porque esa ruta fuerza
descarga.

### Invitaciones

```text
/app/invites
  -> Server Component valida owner/admin
  -> InviteCreateForm usa createInviteAction
  -> revoke usa revokeInviteAction
  -> link apunta a /login?invite_token=...
  -> /auth/callback acepta el token despues del OAuth
```

## Estados que debe entender la UI

Documentos:

```text
uploading
uploaded
queued
parsing
structuring
embedding
indexed
failed
archived
```

Runs de indexacion:

```text
queued
running
completed
failed
canceled
```

Stages:

```text
queued
extracting
structuring
verifying_tree
refining_tree
summarizing
embedding
persisting
indexed
failed
canceled
```

## Errores que la UI debe tratar bien

- `401`: sesion vencida; mandar a `/login`.
- `403`: falta tenant o request cross-origin.
- `404`: RLS no expone el recurso; mostrar "no encontrado".
- `429`: rate limit o backpressure; mostrar retry.
- `eventQueued: false`: el run existe, pero Inngest no fue despachado.
- `warning`: mostrar advertencia operativa sin ocultar el documento.

## No hacer

- No llamar workers desde el browser.
- No guardar signed URLs en Redis, localStorage ni DB.
- No asumir que `uploaded` significa `indexed`.
- No pedir `service_role` para resolver problemas de UI.
- No suscribirse a tablas completas en Realtime; filtrar por `document_id`.
- No usar `next/link` para `/auth/sign-out`; es `POST`.

## Checklist para una pantalla nueva

1. Definir si es lectura inicial, interaccion o tarea server-side.
2. Elegir Server Component, Client Component o Route Handler.
3. Confirmar que RLS cubre el acceso por tenant.
4. Usar los tipos de `lib/documents/types.ts` cuando aplique.
5. Para mutaciones, refrescar con `router.refresh()` o `revalidatePath()`.
6. Si necesita live updates, suscribirse con filtro estrecho.
7. Revisar el catalogo: `docs/backend/09-catalogo-api-rutas.md`.
