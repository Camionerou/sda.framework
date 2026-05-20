# Schema Multitenant y RLS

Estado: listo y pusheado a remoto.

## Hecho

- Se creó el schema core multitenant sobre Supabase Postgres.
- Se agregaron tablas principales:
  - `tenants`
  - `roles`
  - `users`
  - `documents`
  - `doc_tree`
  - `chunks`
  - `conversations`
  - `messages`
  - `langgraph_checkpoints`
  - `audit_log`
- Se agregaron helpers en schema `app`:
  - tenant actual desde JWT
  - rol actual
  - check admin/owner
  - updated_at trigger
  - roles default por tenant
  - acceso a conversación
- Se activó RLS en tablas operativas.
- Se agregaron policies tenant-scoped para lectura/escritura.

## Archivos relevantes

- `supabase/migrations/20260520145604_core_multitenant_schema.sql`
- `supabase/tests/auth_claims_rls_test.sql`

## Decisiones

- `tenant_id` manda la seguridad.
- Los claims del JWT alimentan las policies.
- `chunks.embedding` usa `pgvector` con `vector(1536)`.
