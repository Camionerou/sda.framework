# Contratos Para Frontend

## Regla base

El frontend debe consumir el backend a traves de tres puertas:

1. Supabase SSR/browser client para datos protegidos por RLS.
2. RPCs de Supabase para operaciones sensibles.
3. Route Handlers de Next para operaciones que necesitan backend server-side.

Nunca usar service role en browser.

## Server Components

Usar:

```ts
import { createClient } from "@/lib/supabase/server";
```

Bueno para:

- Leer documentos.
- Leer perfil/tenant.
- Render inicial de dashboard.
- Redirigir a `/login` si no hay claims.

Patron:

```text
createClient()
  -> supabase.auth.getClaims()
  -> validar tenant_id
  -> query normal
  -> RLS filtra
```

## Client Components

Usar:

```ts
import { createClient } from "@/lib/supabase/client";
```

Bueno para:

- Upload directo a Storage.
- Realtime.
- Acciones interactivas que no requieren service role.

Ejemplo vivo:

- `DocumentUploadForm` calcula checksum, llama RPCs y sube a Storage.
- `IndexingTimeline` se subscribe a `indexing_runs` e `indexing_events`.

## Route Handlers

Usar cuando hace falta:

- Validar sesion server-side.
- Crear signed URLs.
- Disparar Inngest.
- Ocultar detalles de backend.

Contratos actuales:

```text
POST /api/documents/:id/indexing/request
GET  /api/documents/:id/file-url
GET  /app/documents/:id/download
GET|POST|PUT /api/inngest
```

## Visor PDF embebido

`GET /api/documents/:id/file-url` devuelve una signed URL inline para que
`pdf.js` o un visor equivalente cargue el archivo original sin forzar descarga.
La ruta valida sesion con `getClaims()` y lee `documents` bajo RLS; no usa
service role.

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

- `401` sin sesion.
- `404` si RLS no expone el documento.
- `502` si Storage no puede firmar la URL.

`PDF_VIEWER_SIGNED_URL_TTL` define el TTL en segundos; default `900`. La ruta de
descarga `/app/documents/:id/download` se mantiene separada y sigue usando
`Content-Disposition: attachment`.

## Evidencia para highlights

Los chunks derivados del arbol pueden traer `metadata.source_blocks` para
resaltar bloques del PDF:

```json
{
  "page_range": [3, 5],
  "source": "pageindex_style_python_tree",
  "source_blocks_coordinate_system": "normalized_page_bbox_top_left_v1",
  "source_blocks": [
    { "page": 3, "bbox": [0.1, 0.2, 0.8, 0.35], "kind": "text" }
  ]
}
```

`bbox` usa `[x0, y0, x1, y1]` normalizado `0..1` contra `page_size` de
`middle_json` de MinerU, con origen arriba-izquierda. En un canvas/render HTML,
el frontend escala multiplicando por ancho/alto renderizado de pagina. Los
documentos viejos pueden no tener `source_blocks`; en ese caso el visor debe caer
a navegacion por pagina con `page_start`/`page_end`.

## Buenas practicas

- Preferir RLS sobre filtros manuales por tenant.
- Mostrar `status_reason` cuando exista.
- Tratar errores de ingesta como advertencias, no como fallo de upload.
- Suscribirse por `document_id` para timelines, no a tablas completas.
- No asumir que `uploaded` significa `indexed`.
- No llamar "listo para chat" si no existe `doc_tree` y al menos un `chunk`.
- Reintentar indexacion desde detalle cuando la corrida esta `failed`,
  `completed` o no existe.
- Mantener textos normales sin jerga tecnica para usuarios finales.
- Reservar `run_id`, `compute_job_id`, provider/modelo y eventos crudos para
  pantallas admin/debug.

## Estados UI sugeridos

Documentos:

```text
uploading  -> "Subiendo"
uploaded   -> "Subido"
queued     -> "En cola"
parsing    -> "Extrayendo"
structuring-> "Armando arbol"
embedding  -> "Embeddings"
indexed    -> "Indexado"
failed     -> "Fallo"
archived   -> "Archivado"
```

Timeline:

- Barra con `indexing_runs.progress`.
- Estado principal con `indexing_runs.stage`.
- Lista historica desde `indexing_events`.
- Mensaje de error desde `indexing_runs.error_message`.

## Integracion futura de chat

El chat aun no esta implementado. Cuando entre:

- Crear Route Handler o servidor runtime propio para SSE.
- Persistir `conversations` y `messages`.
- Usar `langgraph_checkpoints` para continuidad.
- Recuperar primero desde `doc_tree`, no desde texto crudo.
- Citar evidencia por pagina/nodo.
- Stream de acciones legibles: buscando, abriendo secciones, leyendo evidencia,
  preparando respuesta.
