# Inngest skeleton

Estado: implementado localmente y listo para configurar claves.

## Hecho

- Se instalo `inngest` v4.
- Se agrego cliente tipado en `inngest/client.ts`.
- Se creo evento `document/index.requested`.
- Se agrego funcion `process-document-index` como primer workflow durable.
- Se expuso `/api/inngest` con `serve()` para App Router.
- Se creo ruta server-side
  `/api/documents/[id]/indexing/request` para:
  - validar sesion y claims;
  - pedir o reutilizar una corrida con `request_document_indexing`;
  - enviar el evento a Inngest si `INNGEST_DEV=1` o `INNGEST_EVENT_KEY` estan
    configurados.
- Upload y detalle de documento ahora usan la ruta server-side en vez de llamar
  la RPC directamente desde el cliente.
- `.env.example` documenta `INNGEST_DEV`, `INNGEST_EVENT_KEY` e
  `INNGEST_SIGNING_KEY`.

## Nota operativa

Si Inngest no esta configurado, el documento igual queda en cola en Supabase. La
app no falla el upload por eso. Cuando conectemos Inngest Cloud o el Dev Server,
el evento empieza a disparar el workflow.

En desarrollo local, el cliente Inngest usa modo dev si no hay signing key para
que `/api/inngest` pueda responder al Dev Server sin claves productivas.

## Verificacion

- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `curl -i http://127.0.0.1:3000/api/inngest`
- `curl -i -X POST http://127.0.0.1:3000/api/documents/00000000-0000-0000-0000-000000000000/indexing/request`

## Siguiente corte

- Crear Compute Gateway minimo en `srv-ia-01`.
- Agregar endpoint async `POST /v1/index-jobs`.
- Hacer que `process-document-index` cree el job remoto y actualice
  `indexing_runs` con `compute_job_id`.
