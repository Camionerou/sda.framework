# Backend

Documentacion corta y granular del backend actual de SDA Framework.

El backend no es un servicio unico. Es un control plane compuesto por Next.js,
Supabase, Inngest y workers privados en `srv-ia-01`. La app Next maneja UI,
rutas server-side y acciones cercanas al usuario; Supabase es la fuente de
verdad; Inngest orquesta jobs durables; los workers hacen el computo pesado.

## Guia rapida

- [`01-mapa-del-backend.md`](./01-mapa-del-backend.md): piezas, carpetas y flujo general.
- [`02-auth-tenants-rls.md`](./02-auth-tenants-rls.md): login, claims, tenants, permisos y RLS.
- [`03-documentos-storage-upload.md`](./03-documentos-storage-upload.md): carga, Storage, dedupe y descargas.
- [`04-indexacion-inngest.md`](./04-indexacion-inngest.md): corrida de indexacion, eventos y reconciliador.
- [`05-workers-compute-tree-indexer.md`](./05-workers-compute-tree-indexer.md): Compute Gateway, MinerU y Tree Indexer.
- [`06-contratos-frontend.md`](./06-contratos-frontend.md): como conectar frontend al backend sin romper seguridad.
- [`07-operacion-env-health.md`](./07-operacion-env-health.md): env vars, comandos, health checks y debugging.
- [`08-upstash-redis.md`](./08-upstash-redis.md): Redis operacional para locks, backpressure, rate limits, heartbeats, snapshots live y caches TTL.

## Estado real

Implementado:

- Next.js 16 con App Router.
- Supabase Auth, SSR cookies y Google OAuth.
- Invite-only por tenant.
- Postgres multitenant con RLS.
- Supabase Storage privado para documentos y artefactos.
- Upload con dedupe por `checksum_sha256`.
- Inngest endpoint y funciones de indexacion.
- Upstash Redis para locks efimeros, backpressure, rate limits, heartbeats,
  snapshots live y cache server-side reconstruible.
- Timeline live con Supabase Realtime.
- Compute Gateway Node para MinerU.
- Tree Indexer Python FastAPI con LangGraph y LLM.

Pendiente o incompleto:

- Chat agent de usuario final (`chat_agent = 0.0.0`).
- Embeddings jerarquicos (`embedding_pipeline = 0.0.0`).
- Retrieval tools productivas sobre `doc_tree` y `chunks`.

## Regla de lectura

Si un documento dice "frontend", se refiere a la app Next que consume este
backend. Si dice "worker", se refiere a servicios fuera de Vercel, normalmente
corriendo en `srv-ia-01`.
