# Operacion, Env Y Health

## Scripts locales

```bash
npm run lint
npm run typecheck
npm run build
npm run indexing:health
npm run inngest:sync
npm run bootstrap:owner-invite
```

`indexing:health` revisa DB con service role y devuelve JSON con:

- distribucion de documentos y corridas;
- errores recientes;
- si hay compute gateway configurado;
- documentos `uploaded` sin corrida activa;
- documentos `queued`, `parsing` o `structuring` sin corrida activa;
- corridas activas sin upload completo;
- documentos `indexed` sin arbol o chunks;
- corridas running con arbol ya persistido.
- drift de versiones contra `system_component_versions`.

## Env por grupo

Supabase publico:

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
NEXT_PUBLIC_SUPABASE_ANON_KEY
```

Supabase backend:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_SECRET_KEY
```

Inngest:

```text
INNGEST_DEV
INNGEST_API_KEY
INNGEST_APP_ID
INNGEST_APP_URL
INNGEST_EVENT_KEY
INNGEST_SIGNING_KEY
INNGEST_APP_VERSION
```

Compute:

```text
COMPUTE_GATEWAY_URL
COMPUTE_GATEWAY_TOKEN
COMPUTE_GATEWAY_TIMEOUT_MS
COMPUTE_GATEWAY_SIGNED_URL_TTL_SECONDS
COMPUTE_GATEWAY_POLL_ATTEMPTS
COMPUTE_GATEWAY_POLL_INTERVAL
TREE_INDEXER_POLL_ATTEMPTS
TREE_INDEXER_POLL_INTERVAL
```

Indexacion:

```text
INDEXING_WORKFLOW_CONCURRENCY
INDEXING_RECONCILER_BATCH_SIZE
INDEXING_RECONCILER_CRON
INDEXING_RECONCILER_STALE_QUEUED_MINUTES
INDEXING_RECONCILER_STALE_RUNNING_MINUTES
```

LLM Tree Indexer:

```text
SDA_TREE_LLM_PROVIDER
SDA_TREE_LLM_BASE_URL
SDA_TREE_LLM_API_KEY
SDA_TREE_LLM_MODEL
SDA_TREE_SUMMARY_MODEL
SDA_TREE_MAX_PROMPT_CHARS
SDA_TREE_SUMMARY_CONCURRENCY
```

## Health checks

App:

```text
/api/inngest
```

Compute Gateway:

```bash
curl -H "authorization: Bearer $COMPUTE_GATEWAY_TOKEN" \
  "$COMPUTE_GATEWAY_URL/v1/health"
```

Tree Indexer via gateway:

```bash
curl -H "authorization: Bearer $COMPUTE_GATEWAY_TOKEN" \
  "$COMPUTE_GATEWAY_URL/v1/tree-index-jobs/not-a-real-id"
```

Ese segundo check deberia devolver `404` autenticado, no `401` ni error de red.

## Diagnostico rapido

Documento queda `queued`:

- Falta `INNGEST_EVENT_KEY` o `INNGEST_DEV`.
- Falta sync de Inngest Cloud.
- Reconciliador todavia no corrio.

Documento queda `parsing` o `structuring` sin corrida activa:

- Hubo interrupcion/redeploy del workflow despues de cambiar estado del
  documento.
- El reconciliador debe detectarlo como `nonterminal_without_active_run` y
  reencolarlo.
- Si no se reencola, correr `npm run indexing:health` y revisar
  `indexing_runs` recientes del documento.

Documento queda "Esperando Compute Gateway":

- Falta `COMPUTE_GATEWAY_URL`.
- Vercel/Inngest no tiene el env.

Falla `storage object not found`:

- Upload quedo incompleto.
- Path `r2_key` no existe en Storage.
- Debe fallar permanentemente, no retry infinito.

Falla `llm_missing`:

- MinerU esta listo.
- Falta `SDA_TREE_LLM_API_KEY` o `SDA_TREE_LLM_MODEL` en el Tree Indexer.

Documento figura `indexed` pero no responde chat:

- El chat aun no esta implementado.
- Verificar `doc_tree` y `chunks`.
- Embeddings jerarquicos siguen pendientes.

Documento figura `indexed` pero con version vieja:

- `npm run indexing:health` lo lista en
  `signals.version_drift_requires_reindex`.
- Reencolarlo con una corrida nueva usando las versiones de
  `system_component_versions`.
- No desplegar Vercel/Inngest mientras haya reindexaciones activas salvo
  hotfix necesario.

## Secretos

- Nunca hardcodear keys en codigo.
- No poner service role en browser.
- Rotar tokens si se copiaron en chat, logs o shell history.
- El gateway debe recibir signed URLs cortas, no service role desde Inngest.
