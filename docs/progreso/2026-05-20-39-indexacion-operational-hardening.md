# Hardening operacional de indexacion

Estado: implementado en codigo, pendiente de aplicar migracion y deploy.

## Hallazgos que dispara este sprint

- Documento `uploaded` con archivo real en Storage pero sin corrida activa:
  requiere cron de Inngest Cloud y reconciliador efectivo.
- Corrida `running` sobre documento sin `uploaded_at` ni objeto en Storage:
  no debe quedar reintentando como si fuera transitorio.
- Documento con `doc_tree` y `chunks` persistidos pero corrida todavia
  `running/structuring`: el reconciliador debe cerrar estado contra la verdad
  durable.
- `.env.local` puede divergir entre `SUPABASE_URL` y
  `NEXT_PUBLIC_SUPABASE_URL`: el health check lo marca sin imprimir secretos.

## Cambios preventivos

- `request_document_indexing` ahora bloquea documentos sin `uploaded_at` y sin
  referencia Storage completa.
- `process-document-index` valida upload completo antes de enviar a Compute
  Gateway.
- Si Supabase Storage devuelve `Object not found`, la corrida queda `failed`
  terminal con evento `indexing.storage_object_missing`; no queda `running`.
- `process-document-index` guarda tambien `inngest_run_id` desde el `runId` de
  Inngest, no solo desde el id del evento.
- `reconcile-document-indexing` ahora:
  - completa corridas activas cuando ya existen `doc_tree` y `chunks`;
  - falla corridas activas de documentos sin upload confirmado;
  - reencola corridas `running` viejas con TTL configurable;
  - mantiene el auto-queue de documentos `uploaded` sin corrida activa.
- Se agrego `npm run indexing:health` para auditar Supabase remoto con conteos,
  estados y anomalias operativas sin exponer secretos.

## Redis

No se agrega Redis en este corte porque los problemas detectados se corrigen en
la fuente durable: Supabase e Inngest. El uso recomendado para el proximo corte
es efimero: locks con TTL por documento, rate limits por tenant/user,
heartbeats de jobs y cache de retrieval/LLM. No debe reemplazar Postgres como
fuente de verdad.

## Pendiente operativo

1. Aplicar la migracion `20260520233000_indexing_operational_hardening.sql`.
2. Publicar `.github/workflows/inngest-sync.yml` para que Inngest Cloud registre
   el cron despues de deploys productivos.
3. Deployar Vercel.
4. Ejecutar `npm run indexing:health`.
5. Verificar que el documento SQL pase de `uploaded` a `queued/running/indexed`
   por reconciliador.
