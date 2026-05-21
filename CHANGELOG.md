# Changelog

Historial consolidado desde `docs/progreso/`. Las entradas mantienen el nombre
del archivo original como referencia historica, pero el historial incremental ya
no vive como carpeta navegable del repo.

## 0.1.6 - 2026-05-21

- `2026-05-21-46-indexing-state-machine-centralizada.md`: centralizacion de la
  state machine de indexacion y transiciones compartidas.
- `2026-05-21-45-redis-backpressure-live-indexing.md`: backpressure por tenant,
  snapshots live de corridas y heartbeats en Redis.
- `2026-05-21-44-infra-env-secret-redis-cache.md`: endurecimiento de envs,
  secret scan y cache Redis server-side para detalle documental.
- `2026-05-21-43-upstash-redis-ephemeral-infra.md`: base operacional de Upstash
  Redis para locks, health y datos efimeros.
- `2026-05-21-42-worker-infra-hardening-version-sync.md`: workers cerrados por
  token, limites de body, deploy scripts con `.env` protegido, CI y sincronismo
  de versiones contra Supabase.
- `2026-05-21-41-versioned-reindex-hardening.md`: reindexacion versionada,
  drift informativo y compatibilidad con documentos indexados previos.
- `2026-05-21-40-system-versioning.md`: versionado operativo en
  `lib/system-versions.ts` y espejo runtime en `system_component_versions`.

## 0.1.5 - 2026-05-20

- `2026-05-20-39-indexacion-operational-hardening.md`: hardening operacional de
  indexacion, reparacion de datos y despliegue en Vercel.
- `2026-05-20-38-indexacion-automatica-reconciler.md`: reconciliador de
  indexacion automatica con claim idempotente.
- `2026-05-20-37-tree-range-quality-audit.md`: auditoria de calidad del arbol
  generado desde PDF real.
- `2026-05-20-36-openrouter-gemini-tree-index-real.md`: corrida end-to-end real
  con OpenRouter Gemini, persistencia en `doc_tree` y `chunks`, y ajustes por
  headers repetidos en PDF.
- `2026-05-20-35-compute-gateway-tree-proxy.md`: proxy del Compute Gateway hacia
  Tree Indexer desplegado en `srv-ia-01`.
- `2026-05-20-34-fastapi-tree-indexer-deploy-srv.md`: deploy del FastAPI Tree
  Indexer en `srv-ia-01`.
- `2026-05-20-33-fastapi-tree-indexer-python.md`: primer corte FastAPI del Tree
  Indexer Python verificado con artefactos MinerU reales.
- `2026-05-20-32-langgraph-tree-indexer-real.md`: Tree Indexer real con
  LangGraph y contrato inicial de ejecucion.
- `2026-05-20-31-pageindex-tree-builder-reference.md`: referencia PageIndex
  documentada como guia de diseño.
- `2026-05-20-30-compute-gateway-mineru-automatizado.md`: automatizacion de
  MinerU desde Compute Gateway.
- `2026-05-20-29-extracciones-enterprise-control-plane.md`: decision de control
  plane para extracciones en Supabase, artefactos versionados y dedupe por
  checksum/version.
- `2026-05-20-28-mineru-extraccion-real.md`: primera extraccion real MinerU sin
  mocks ni datos demo.
- `2026-05-20-27-upload-dedupe-ingesta-separada.md`: upload e ingesta separados
  con dedupe.
- `2026-05-20-26-compute-gateway-contract.md`: contrato inicial del Compute
  Gateway y worker en `srv-ia-01`.

## 0.1.0 - 2026-05-20

- `2026-05-20-25-invitaciones-sin-expiracion.md`: invitaciones sin expiracion
  por defecto.
- `2026-05-20-24-signout-prefetch-fix.md`: fix de sign-out ante prefetch.
- `2026-05-20-23-inngest-cloud-sync.md`: sincronizacion inicial con Inngest
  Cloud.
- `2026-05-20-22-supabase-auth-vercel-url.md`: ajuste de URLs de auth en
  Supabase para Vercel.
- `2026-05-20-21-vercel-frontend.md`: deploy productivo del frontend en Vercel.
- `2026-05-20-20-inngest-keys-local.md`: claves locales de Inngest configuradas.
- `2026-05-20-19-inngest-cloud-setup.md`: preparacion de Inngest Cloud.
- `2026-05-20-18-inngest-skeleton.md`: skeleton del workflow durable de
  indexacion.
- `2026-05-20-17-indexacion-live-base.md`: base de indexacion live migrada.
- `2026-05-20-16-arquitectura-general-actualizada.md`: arquitectura general
  actualizada.
- `2026-05-20-15-publicacion-github.md`: publicacion inicial preparada.
- `2026-05-20-14-llm-estructural-tree-index.md`: decision de LLM estructural
  para SDA Tree Index.
- `2026-05-20-13-sda-tree-index-live-architecture.md`: arquitectura live del
  SDA Tree Index documentada.
- `2026-05-20-12-pageindex-worker-vendoreado.md`: experimento PageIndex
  vendoreado retirado del codigo activo.
- `2026-05-20-11-pageindex-research.md`: investigacion inicial de PageIndex.
- `2026-05-20-10-verificaciones.md`: registro acumulado de verificaciones.
- `2026-05-20-09-documentos-detalle-en-progreso.md`: detalle de documentos y
  ruta de descarga.
- `2026-05-20-08-documentos-upload.md`: upload de documentos validado con PDF
  real.
- `2026-05-20-07-invitaciones-ui.md`: UI de invitaciones.
- `2026-05-20-06-frontend-next-auth.md`: frontend Next con auth contra Supabase.
- `2026-05-20-05-invite-only.md`: onboarding invite-only validado.
- `2026-05-20-04-jwt-claims-hook.md`: hook de JWT claims.
- `2026-05-20-03-google-oauth.md`: Google OAuth en Supabase remoto.
- `2026-05-20-02-schema-multitenant-rls.md`: schema multitenant y RLS.
- `2026-05-20-01-setup-supabase-remoto.md`: setup inicial de Supabase remoto.
