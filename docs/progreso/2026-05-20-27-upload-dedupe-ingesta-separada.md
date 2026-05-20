# Upload dedupe e ingesta separada

Estado: implementado.

## Hecho

- El bucket `documents` sube su limite a `5GiB`.
- El frontend calcula `sha256` del archivo antes de crear el upload.
- `create_document_upload` recibe `_checksum_sha256`.
- Si ya existe un documento del mismo tenant con ese checksum y `uploaded_at`
  completo, la RPC devuelve ese documento con `deduped = true`.
- En un dedupe no se vuelve a subir el archivo a Storage.
- La subida queda como exito aunque el encolado de ingesta falle o este apagado.
- La UI separa el mensaje:
  - documento subido;
  - ingesta en cola;
  - ingesta no iniciada automaticamente;
  - documento ya cargado.

## Decision

El dedupe se hace solo contra documentos realmente subidos (`uploaded_at is not
null`). Un intento a medio subir no bloquea el mismo archivo para siempre.

## Pendiente

- Agregar una accion explicita de "Indexar" desde biblioteca/listado para
  documentos subidos que no entraron a ingesta automaticamente.
- Cuando exista el worker real, mantener upload como dominio separado:
  Storage/RLS primero, ingesta despues.
