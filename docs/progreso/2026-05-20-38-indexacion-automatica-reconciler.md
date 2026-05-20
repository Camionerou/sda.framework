# Indexacion automatica con reconciliador

Estado: implementado en codigo, pendiente de validacion cloud completa.

## Objetivo

Evitar que la ingesta dependa solamente del request que hace la UI despues del
upload. Para operar muchos documentos, el sistema necesita una capa automatica
que detecte archivos subidos y corridas en cola que no llegaron a ejecutar.

## Que se agrego

- Funcion Inngest programada `reconcile-document-indexing`.
- Cron default: `*/2 * * * *`.
- Batch default: 25 documentos/corridas por tick.
- Barrido de documentos `uploaded` sin corrida activa.
- Redispatch de corridas `queued` viejas para recuperar eventos que no llegaron
  a Inngest.
- Claim idempotente en `process-document-index` antes de crear jobs de MinerU.

## Por que importa

El upload sigue separado de la ingesta: si Compute Gateway, Inngest o Tree
Indexer fallan, el archivo queda guardado en Storage y DB. El reconciliador
convierte esa separacion en un flujo automatico eventual: cuando la infra vuelve,
los documentos pendientes vuelven a entrar al pipeline sin depender de clicks.

## Filosofia

No hay mock ni demo. El reconciliador usa Supabase real, eventos Inngest reales y
el mismo pipeline productivo de MinerU + Tree Indexer.

## Pendiente

1. Deploy en Vercel.
2. Sync de Inngest Cloud para registrar el cron. Si no esta instalada la
   integracion de Vercel, el sync programatico requiere `INNGEST_API_KEY`.
3. Smoke real subiendo un documento y observando que llegue a `indexed`.
