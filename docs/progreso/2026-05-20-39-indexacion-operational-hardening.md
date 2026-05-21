# Hardening operacional de indexacion

Estado: implementado, migracion aplicada, deployado en Vercel y datos
operacionales reparados. Pendiente externo: sync de Inngest Cloud bloqueado por
GitHub Actions billing.

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
- Se agrego `npm run inngest:sync` para sincronizar Inngest Cloud desde local
  sin depender de GitHub Actions.

## Redis

En este corte no se agrego Redis porque los problemas detectados se corregian
en la fuente durable: Supabase e Inngest. La recomendacion para el siguiente
corte era empezar por estado operacional reconstruible: locks con TTL por
documento, rate limits por tenant/user, heartbeats de jobs y cache de
retrieval/LLM. No debe reemplazar Postgres como fuente de verdad.

Nota posterior: Redis se incorporo despues como plataforma operacional para
rate limits, locks, heartbeats y cache server-side reconstruible. Ver
`2026-05-21-43-upstash-redis-ephemeral-infra.md` y
`2026-05-21-44-infra-env-secret-redis-cache.md`.

## Verificacion aplicada

- Migracion aplicada en Supabase remoto:
  `20260520233000_indexing_operational_hardening.sql`.
- Commit publicado: `181e23c`.
- Vercel Production deploy: `dpl_5PRSnoxYbfFwQnAgQqsXgp7DH2Qn`.
- `npm run typecheck` y `npm run lint` pasan.
- `npm run indexing:health` queda sin anomalias accionables:
  - 2 documentos `indexed`;
  - 1 corrida `failed` terminal por upload incompleto;
  - 0 corridas activas sin `uploaded_at`;
  - 0 documentos `uploaded` sin corrida activa;
  - 0 documentos `indexed` sin arbol/chunks.

## Pendiente operativo

1. Ejecutar `npm run inngest:sync` con `INNGEST_API_KEY` local para registrar el
   cron en Inngest Cloud.
2. Cuando el sync corra, confirmar en Inngest Cloud que existen
   `process-document-index` y `reconcile-document-indexing`.
3. Mantener `npm run indexing:health` como smoke operativo despues de deploys.
