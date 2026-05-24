# Documentos, Storage Y Upload

## Modelo

Tabla principal: `documents`.

Campos operativos:

- `tenant_id`: frontera multitenant.
- `workspace_id`: workspace duenio (NOT NULL, FK composite `(tenant_id,
  workspace_id) -> workspaces`). Define visibilidad principal.
- `created_by`: usuario que inicio la carga.
- `filename`, `title`, `mime_type`, `byte_size`.
- `checksum_sha256`: dedupe por tenant.
- `r2_bucket`, `r2_key`: nombres historicos; hoy apuntan al bucket/path de
  Supabase Storage.
- `status`, `status_reason`.
- `uploaded_at`, `indexed_at`.
- `deleted_at`, `deleted_by`: soft-delete; independiente de `status`. Un
  documento puede estar `indexed` y a la vez `deleted_at IS NOT NULL`.

Estados:

```text
uploading -> uploaded -> queued -> parsing -> structuring -> indexed
                                      \-> failed
```

Tambien existen `embedding`, `archived` y estados intermedios de corrida.

## Storage

Bucket: `documents`.

Propiedades actuales:

- Privado.
- Limite de 5 GB.
- RLS por primer segmento del path: `tenant_id`.
- MIME types permitidos: PDF, texto, markdown, JSON, imagenes, DOC/DOCX y
  octet-stream para artefactos.

Path canonico de archivo original:

```text
<tenant_id>/<document_id>/<safe_filename>
```

Path canonico de artefactos MinerU:

```text
<tenant_id>/<document_id>/extractions/mineru/<mineru_version>/<extraction_id>/...
```

## Upload

UI: `components/documents/document-upload-form.tsx`.

Pasos:

1. El browser calcula SHA-256 del archivo.
2. RPC `create_document_upload` crea `documents` en `uploading`. Firma Tier 1:
   ```text
   create_document_upload(
     _filename text,
     _workspace_id uuid,                                -- requerido
     _mime_type text default 'application/pdf',
     _byte_size bigint default null,
     _title text default null,
     _metadata jsonb default '{}',
     _checksum_sha256 text default null,
     _collection_id uuid default null,                  -- opcional
     _request_context jsonb default '{}'
   ) returns table (document_id, tenant_id, r2_bucket, r2_key, ...)
   ```
   `_workspace_id` debe ser un workspace del tenant donde el caller tiene rol.
   Si `_collection_id` esta presente, la RPC inserta tambien en
   `document_collections`.
3. Si el checksum ya existe para el tenant y el documento esta subido, retorna
   `deduped = true`.
4. Si no hay dedupe, el browser sube directo a Supabase Storage.
5. RPC `mark_document_uploaded` marca `uploaded_at` y pasa a `uploaded`.
6. La UI pide indexacion con `POST /api/documents/:id/indexing/request`.

Importante: upload exitoso no depende de Inngest ni del Compute Gateway. Si la
ingesta falla, el archivo igual queda guardado y el usuario ve una advertencia.

## Soft-delete y mover

Las RPCs Tier 1 cubren ciclo de vida y reubicacion:

```text
archive_document(_document_id uuid, _request_context jsonb default '{}')
  -> setea deleted_at = now(), deleted_by = auth.uid().
     Requiere edit permission via app.user_can_edit_document.

restore_document(_document_id uuid, _request_context jsonb default '{}')
  -> limpia deleted_at/deleted_by.
     Solo tenant admin (decision conservadora).

move_document(
  _document_id uuid,
  _to_workspace_id uuid,
  _collection_ids uuid[] default null,
  _request_context jsonb default '{}'
)
  -> cambia workspace_id; reemplaza collections si se pasa el array.
     Requiere edit en origen y rol valido en destino.

bulk_update_documents(
  _document_ids uuid[],
  _patch jsonb,                  -- title, metadata, status_reason
  _request_context jsonb default '{}'
) returns jsonb                   -- { updated_count }
  -> workspace_id se cambia via move_document, no por patch.
```

`deleted_at` es ortogonal a `status`. La retencion y purga estan en
[`14-retention-and-cleanup.md`](./14-retention-and-cleanup.md).

## Fallas de upload

Si Storage falla despues de crear la row, el frontend llama:

```text
mark_document_upload_failed(_document_id, _reason)
```

Asi se evita dejar documentos eternamente en `uploading`.

## Descarga

Ruta:

```text
GET /app/documents/:id/download
```

La ruta:

1. Verifica sesion.
2. Lee `documents` bajo RLS.
3. Crea signed URL de 60 segundos.
4. Redirige al archivo privado.

El frontend no debe construir URLs de Storage manualmente para descargas
privadas.

