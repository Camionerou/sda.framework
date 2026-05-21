# Mapa Del Backend

## Capas

```text
Browser / Next UI
  -> Server Components, Client Components, Server Actions, Route Handlers
  -> Supabase client SSR/browser
  -> Supabase Auth + Postgres + Storage + Realtime
  -> Inngest workflows
  -> Compute Gateway Node
  -> MinerU + Tree Indexer Python
  -> LLM provider via OpenRouter/OpenAI-compatible API
```

## Responsabilidades

Next.js:

- Renderiza la consola y las paginas protegidas.
- Lee claims de Supabase con `createClient()`.
- Expone rutas de backend chicas bajo `app/api`.
- Ejecuta server actions para invitaciones.
- Nunca expone service role al browser.

Supabase:

- Auth y cookies de sesion.
- Postgres como fuente de verdad.
- RLS por `tenant_id`.
- Storage privado `documents`.
- Realtime para `indexing_runs` e `indexing_events`.
- RPCs para operaciones sensibles.

Inngest:

- Recibe `document/index.requested`.
- Reclama corridas idempotentemente.
- Firma URLs temporales de Storage.
- Crea jobs de Compute Gateway y Tree Indexer.
- Polling durable con sleeps/retries.
- Reconciliador cron para cerrar o reencolar corridas.

Workers:

- `workers/compute-gateway`: gateway Node para jobs MinerU y proxy al Tree Indexer.
- `workers/tree-indexer-python`: FastAPI + LangGraph para arbol PageIndex-style.
- Ambos corren fuera de Vercel porque son trabajos largos o pesados.

## Carpetas clave

```text
app/
  api/inngest/route.ts
  api/documents/[id]/indexing/request/route.ts
  auth/callback/route.ts
  app/documents/
  app/invites/

components/
  documents/document-upload-form.tsx
  documents/indexing-timeline.tsx

inngest/
  client.ts
  functions/process-document-index.ts
  functions/reconcile-document-indexing.ts

lib/
  supabase/
  compute-gateway.ts
  documents.ts
  session.ts
  system-versions.ts
  tree-indexer/

supabase/
  migrations/
  tests/

workers/
  compute-gateway/
  tree-indexer-python/
```

## Flujo principal

```text
Usuario sube documento
  -> RPC create_document_upload
  -> browser sube archivo al bucket documents
  -> RPC mark_document_uploaded
  -> POST /api/documents/:id/indexing/request
  -> RPC request_document_indexing
  -> event document/index.requested
  -> Inngest process-document-index
  -> Compute Gateway /v1/index-jobs
  -> MinerU produce artefactos
  -> Tree Indexer /v1/tree-index-jobs
  -> doc_tree + chunks
  -> documents.status = indexed
```

## Principio central

La app no hace RAG naive como estrategia principal. El indice canonico es
`doc_tree`; `chunks` es una superficie recuperable derivada del arbol, no una
bolsa arbitraria de texto.

