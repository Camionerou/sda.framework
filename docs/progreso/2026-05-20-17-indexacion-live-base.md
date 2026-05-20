# Indexacion live base

Estado: implementado y migrado.

## Hecho

- Se creo la base de corridas live con `indexing_runs`.
- Se creo el stream historico de eventos con `indexing_events`.
- Se agrego la RPC `request_document_indexing` para encolar documentos sin dar
  permisos directos de escritura al cliente.
- Upload de documentos ahora intenta dejar el documento en cola apenas termina
  la subida.
- El detalle de documento muestra timeline en vivo con Supabase Realtime,
  progreso, etapa actual, eventos y errores.
- La migracion quedo aplicada en Supabase remoto.

## Verificacion

- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `supabase test db --local supabase/tests/auth_claims_rls_test.sql`
- `supabase test db --local supabase/tests/invite_only_onboarding_test.sql`
- `supabase test db --local supabase/tests/documents_upload_flow_test.sql`
- `supabase test db --local supabase/tests/indexing_live_flow_test.sql`
- `supabase db push --linked --yes`
- `supabase migration list --linked`

## Siguiente corte

- Crear el skeleton Inngest para consumir corridas `queued`.
- Definir endpoint interno de Compute Gateway para MinerU en `srv-ia-01`.
- Emitir eventos `extracting`, `structuring`, `verifying_tree`, `summarizing`,
  `embedding` y `indexed` desde el worker real.
