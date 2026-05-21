# Documentos, Storage Y Upload

## Modelo

Tabla principal: `documents`.

Campos operativos:

- `tenant_id`: frontera multitenant.
- `created_by`: usuario que inicio la carga.
- `filename`, `title`, `mime_type`, `byte_size`.
- `checksum_sha256`: dedupe por tenant.
- `r2_bucket`, `r2_key`: nombres historicos; hoy apuntan al bucket/path de
  Supabase Storage.
- `status`, `status_reason`.
- `uploaded_at`, `indexed_at`.

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
2. RPC `create_document_upload` crea `documents` en `uploading`.
3. Si el checksum ya existe para el tenant y el documento esta subido, retorna
   `deduped = true`.
4. Si no hay dedupe, el browser sube directo a Supabase Storage.
5. RPC `mark_document_uploaded` marca `uploaded_at` y pasa a `uploaded`.
6. La UI pide indexacion con `POST /api/documents/:id/indexing/request`.

Importante: upload exitoso no depende de Inngest ni del Compute Gateway. Si la
ingesta falla, el archivo igual queda guardado y el usuario ve una advertencia.

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

