# Documentos: Upload

Estado: listo, pusheado a remoto y validado con un PDF real.

## Hecho

- Se creó bucket privado en Supabase Storage:

```text
documents
```

- Se agregó pantalla:

```text
/app/documents
```

- Se implementó upload directo desde browser a Storage.
- Se agregó RPC para crear registro previo en `documents`.
- Se agregó RPC para marcar documento como `uploaded`.
- El path de Storage queda aislado por tenant:

```text
{tenant_id}/{document_id}/{safe_filename}
```

## Funciones

- `public.create_document_upload`
- `public.mark_document_uploaded`

## Archivos relevantes

- `supabase/migrations/20260520164528_documents_upload_flow.sql`
- `supabase/tests/documents_upload_flow_test.sql`
- `app/app/documents/page.tsx`
- `components/documents/document-upload-form.tsx`
- `lib/documents.ts`

## Validación real

Documento subido:

- filename: `Práctica 1 - Unidad 5 SQL.pdf`
- status: `uploaded`
- byte_size DB: `68022`
- byte_size Storage: `68022`
- bucket: `documents`
- `indexed_at`: `null`, esperado porque falta pipeline de indexación.

## Nota

El nombre original queda en `documents.filename`. El path de Storage se sanitiza
para evitar problemas con espacios, acentos o caracteres especiales.
