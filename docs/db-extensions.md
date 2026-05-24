# DB extensions inventory

Inventario vivo de extensiones Postgres habilitadas en este proyecto, por qué cada una existe y dónde se consume. **Actualizar este doc** cada vez que se agregue o remueva una extensión.

> Cuando agregar / sacar una extensión: discutir primero, escribir migración con el patrón `WITH SCHEMA "extensions"`, actualizar este doc en el mismo commit.

## Habilitadas hoy (declaradas en migraciones)

| Extensión | Schema | Migración que la habilita | Para qué la usamos | Tests que la cubren |
|---|---|---|---|---|
| `pg_stat_statements` | `extensions` | `20260520145128_initial_remote_schema.sql` | Observabilidad de queries (baseline Supabase) | — |
| `pgcrypto` | `extensions` | `20260520145128_initial_remote_schema.sql` | `gen_random_uuid()`, HMAC para tokens de invites y dispatch | `tenant_invites_test.sql` |
| `uuid-ossp` | `extensions` | `20260520145128_initial_remote_schema.sql` | **Audit pendiente** (Tier 2 Paso 0 Task 0.3). Candidato a remover si no se usa. | — |
| `supabase_vault` | `vault` | `20260520145128_initial_remote_schema.sql` | Secrets cifrados (managed por Supabase) | — |
| `citext` | `extensions` | `20260520145604_core_multitenant_schema.sql` | `users.email` case-insensitive | core multitenant tests |
| `vector` (pgvector) | `extensions` | `20260520145604_core_multitenant_schema.sql` | `chunks.embedding vector(1536)`, índices HNSW; migra a `halfvec` en Tier 3 Paso 7 | search RPC tests |
| `ltree` | `extensions` | `20260521170000_db_caching_retrieval_ops.sql` | `doc_tree_nodes.node_path` paths jerárquicos | `db_caching_retrieval_ops_test.sql` |
| `pg_trgm` | `extensions` | `20260521170000_db_caching_retrieval_ops.sql` | Trigram similarity en `search_chunks` modos `trigram`/`hybrid` (índice GIN añadido en Tier 2 Paso 3.b) | search RPC tests |
| `pg_cron` | `cron` | `20260521170000_db_caching_retrieval_ops.sql` (condicional) | Jobs: cleanup, indexing health refresh, partition maintenance (Tier 3), usage aggregates (Tier 3), saved queries polling (Tier 2) | — |

## Heredadas de Supabase (sin migración propia)

Estas las habilita Supabase por defecto en proyectos nuevos. No están en nuestras migraciones pero están activas:

- `pg_graphql` — auto-genera GraphQL schema; lo dejamos prendido pero no lo consumimos.
- `pgjwt` — JWT helpers; usamos `auth.jwt()` indirectamente vía Supabase auth.
- `pgsodium` — base criptográfica de `supabase_vault`.
- `pgaudit` — auditoría a nivel sesión; no la consumimos (auditoría propia en `public.audit_log`).
- `plpgsql` — lenguaje de procedures.

## Habilitar pendiente (Tier 2 / Tier 3)

| Extensión | Schema | Tier | Migración planificada | Para qué |
|---|---|---|---|---|
| `pg_jsonschema` | `extensions` | Tier 2 Paso 0 | `20260601085000_enable_pg_jsonschema.sql` | Validar `jsonb` en CHECK constraints: `saved_queries.filters`, `notification_preferences.settings`, `tenant_oauth_credentials.config`, `document_sources.config` |
| `btree_gin` | `extensions` | Tier 2 Paso 0 | `20260601085100_enable_btree_gin.sql` | Índices compuestos `(tenant_id, jsonb_col)` y `(tenant_id, tsvector)` para search y particionado |
| `pg_net` (managed) | `extensions` (Supabase Cloud) | Tier 3 Paso 1 | Helper `app.dispatch_inngest_event` consume si está disponible | HTTP dispatch desde Postgres; fallback a outbox + cron sweep si no disponible |

## Tier 4 candidates (ver master plan)

- `pgmq` (cola de mensajes nativa) — criterio de activación: costo Inngest excesivo o necesidad transaccional.
- Binary quantization (`bit(1536)`) — criterio: p95 latencia search > 200ms post-halfvec.
- `pg_trgm` removal — si audit confirma cero uso.
- `uuid-ossp` removal — si audit confirma cero uso.
- `hypopg`/`index_advisor` permanente en staging.

## Convención de naming y schema

Toda extensión nueva se habilita con:

```sql
create extension if not exists "<nombre>" with schema "extensions";
```

Excepciones documentadas:
- `supabase_vault` vive en schema `vault` (Supabase lo requiere así).
- `pg_cron` puede vivir bajo schema `cron` o `extensions` según el build de Supabase. El patrón defensivo en `20260521170000_db_caching_retrieval_ops.sql` (líneas 421-462) detecta el schema correcto en runtime y debe replicarse si se agrega otra extensión con esta ambigüedad.

## Cuándo actualizar este doc

- Al agregar una nueva extensión: agregar fila a tabla "Habilitadas hoy", actualizar la sección "Habilitar pendiente" si correspondía.
- Al remover: mover de "Habilitadas hoy" a un changelog en la sección "Tier 4 candidates" con fecha y razón.
- Al cambiar el uso real de una existente (ej. `pg_trgm` post-audit): editar columna "Para qué la usamos".

Este doc vive en `docs/db-extensions.md` deliberadamente fuera de `docs/superpowers/` porque es referencia operativa permanente, no un plan ejecutable.
