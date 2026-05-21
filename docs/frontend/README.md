# Frontend

Documentacion para construir UI contra el backend real del proyecto.

## Leer primero

1. [`01-conexion-backend.md`](./01-conexion-backend.md): guia simple para
   decidir como conectar cada pantalla.
2. [`../backend/09-catalogo-api-rutas.md`](../backend/09-catalogo-api-rutas.md):
   catalogo canonico de rutas, API, RPCs y workers.
3. [`../backend/06-contratos-frontend.md`](../backend/06-contratos-frontend.md):
   contratos especificos de documentos, visor PDF y highlights.

## Pantallas actuales

| Ruta | Archivo | Estado |
| --- | --- | --- |
| `/login` | `app/login/page.tsx` | Implementada. |
| `/app` | `app/app/page.tsx` | Implementada. |
| `/app/documents` | `app/app/documents/page.tsx` | Implementada. |
| `/app/documents/:id` | `app/app/documents/[id]/page.tsx` | Implementada. |
| `/app/invites` | `app/app/invites/page.tsx` | Implementada. |

## Componentes conectados

- `components/documents/document-upload-form.tsx`: RPCs de upload, Storage y
  request de indexacion.
- `components/documents/documents-live-list.tsx`: lista live de documentos del
  tenant.
- `components/documents/indexing-timeline.tsx`: Realtime sobre
  `indexing_runs` e `indexing_events`.
- `components/workspace/workspace-client.tsx`: workspace live con timeline,
  extracciones, Presence y Broadcast.
- `components/invites/invite-create-form.tsx`: server action de invitaciones.
- `components/dashboard/app-topbar.tsx`: navegacion principal y sign-out por
  form `POST`.

## Estado no implementado

- Chat de usuario final.
- SSE de conversaciones.
- UI de retrieval/herramientas sobre `doc_tree`.
- Visor PDF embebido con highlights, aunque el backend ya expone signed URL y
  `source_blocks`.
