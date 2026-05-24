# Documentacion

Indice operativo de la documentacion vigente del proyecto.

## Lectura recomendada

1. [`arquitectura.md`](./arquitectura.md): vision general del sistema.
2. [`backend/README.md`](./backend/README.md): backend, Supabase, Inngest,
   workers y operacion.
3. [`middleware/README.md`](./middleware/README.md): proxy de sesion,
   CSRF, rate limits y fronteras de seguridad.
4. [`frontend/README.md`](./frontend/README.md): como conectar UI con backend.
5. [`backend/09-catalogo-api-rutas.md`](./backend/09-catalogo-api-rutas.md):
   catalogo canonico de rutas, handlers, RPCs y endpoints externos.
6. [`backend/10-supabase-realtime.md`](./backend/10-supabase-realtime.md):
   contrato de Postgres Changes, Broadcast, Presence y topics privados.

## Separacion por area

```text
docs/
  backend/      Backend app, Supabase, Inngest, Redis y workers.
  middleware/   Proxy Next, protecciones HTTP y fronteras de seguridad.
  frontend/     Guia para construir UI conectada al backend real.
  archivado/    Informes historicos o planes ya ejecutados.
```

## Documentos transversales

- [`arquitectura.md`](./arquitectura.md): decision tecnica de alto nivel.
- [`tree-indexer-pipeline.md`](./tree-indexer-pipeline.md): referencia
  operativa del pipeline desplegado en `srv-ia-01` (grafo LangGraph
  detallado, decisiones de paralelizacion, cache Upstash, operacion via
  `sda` CLI, gotchas vigentes). Estado: 2026-05-22.
- [`gotchas.md`](./gotchas.md): trampas operativas y decisiones que no conviene
  repetir.
- [`pageindex-tree-builder-reference.md`](./pageindex-tree-builder-reference.md):
  referencia tecnica del arbol PageIndex-style.

## Backend Tier 1 (workspaces, collections, RLS, audit, retencion)

- [`backend/11-workspaces-collections-groups.md`](./backend/11-workspaces-collections-groups.md):
  modelo de workspaces, memberships polimorficas, groups, collections,
  visibilidad `workspace_private` vs `tenant_public` y tags.
- [`backend/12-rls-patterns.md`](./backend/12-rls-patterns.md): helpers
  `app.*`, visibilidad triple (tenant + workspace + collection), JWT v2 con
  `active_workspace_id` y guia para nuevas tablas.
- [`backend/13-audit-log-conventions.md`](./backend/13-audit-log-conventions.md):
  triggers de auditoria Tier 1 y convenciones de `audit_log`.
- [`backend/14-retention-and-cleanup.md`](./backend/14-retention-and-cleanup.md):
  soft-delete, retencion y cleanup de documentos archivados.

## Archivado

- [`archivado/informe-refactor.md`](./archivado/informe-refactor.md): informe
  historico del refactor. No usar como contrato vigente sin contrastarlo contra
  el codigo actual.

## Regla practica

Si hay conflicto entre documentos, usar este orden:

1. Codigo actual y migraciones.
2. Catalogo de API/rutas.
3. Docs de area.
4. Informes archivados.
