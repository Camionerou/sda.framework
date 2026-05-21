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
GET  /app/documents/:id/download
GET|POST|PUT /api/inngest
```

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

