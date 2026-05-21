# Operacion, Env Y Health

## Scripts locales

```bash
npm run lint
npm run typecheck
npm run build
npm run secrets:scan
npm run env:doctor
npm run test:tree-indexer
npm run test:db
npm run indexing:health
npm run indexing:health -- --strict
npm run redis:health
npm run supabase:auth:health
npm run bootstrap:owner-invite
```

El sync manual de Inngest vive en GitHub Actions via workflow dispatch:

```bash
gh workflow run "Sync Inngest"
```

`indexing:health` revisa DB con service role y devuelve JSON con un estado
operativo (`healthy`, `recovering`, `degraded`, `critical`) y hallazgos
catalogados por severidad:

- documentos visibles vs ocultos, incluyendo fallidos cargados
  (`warning/degraded`) y uploads incompletos (`info/recovering`);
- corridas activas, para marcar el sistema como `recovering` aunque no haya
  una anomalia estructural;
- ultima corrida fallida sobre un documento todavia indexado
  (`latest_reindex_failed_index_preserved`), que conserva visible el indice
  anterior y queda como warning operativo;
- documentos `uploaded` sin corrida activa;
- documentos `queued`, `parsing` o `structuring` sin corrida activa;
- corridas activas sin upload completo;
- documentos `indexed` sin arbol o chunks;
- corridas running con arbol ya persistido, catalogadas como `info/recovering`
  durante una reindexacion normal y como warning si quedan viejas;
- drift de versiones contra `lib/system-versions.json`.

En modo default el script falla por problemas `critical` o errores de query; los
warnings no rompen health para que estados recuperables o transitorios no
bloqueen deploys. Con `--strict`, tambien falla por warnings y stale indexes si
se pide explicitamente. El drift de versiones es informativo por defecto: los
documentos siguen siendo usables. Si se quiere exigir que todo este reindexado
con latest, usar `--strict --require-fresh-indexes`.

Las versiones operativas viven en `lib/system-versions.json`. Los workers copian
ese JSON durante deploy y la RPC recibe las versiones por `_metadata.versions`;
`system_component_versions` ya no requiere sync manual para crear corridas.

`env:doctor` valida configuracion sin imprimir secretos. Reporta mismatch de
Supabase admin/public URL, reuse accidental de service key como public key y
prefijos Redis peligrosos en produccion. Tambien detecta valores guardados con
comillas como parte del secreto/env, `APP_ORIGIN`/`NEXT_PUBLIC_APP_URL` como
origen canonico e `INNGEST_APP_URL` desalineado con ese origen. En modo default,
el mismatch de Supabase se informa como warning local; con `--strict` o CI pasa
a error.

`secrets:scan` revisa archivos trackeables por Git y falla si encuentra tokens
con forma de secreto. No escanea `.env.local` porque esta ignorado, pero evita
commits accidentales de Redis URLs con password, tokens Upstash, private keys y
service-role-like keys.

`supabase:auth:health` lee Supabase Management API con `SUPABASE_ACCESS_TOKEN`
y compara Auth remoto contra `supabase/config.toml`: `auth.site_url`,
`auth.additional_redirect_urls` y estado de Google OAuth. No imprime secretos.
Para aplicar solo `site_url`/redirects sin tocar OAuth client/secret:

```bash
npm run supabase:auth:health -- --apply
```

## Env por grupo

Supabase publico:

```text
NEXT_PUBLIC_APP_URL
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

Visor PDF:

```text
PDF_VIEWER_SIGNED_URL_TTL
```

Default: `900` segundos. Controla el TTL de `GET /api/documents/:id/file-url`;
la URL se firma inline y el cliente debe refrescarla antes de `expiresAt`.

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

En produccion, el origen canonico debe ser `https://sdaframework.com` y
`INNGEST_APP_URL` debe ser `https://sdaframework.com/api/inngest`.

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

Upstash Redis operacional:

```text
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
UPSTASH_REDIS_KEY_PREFIX
UPSTASH_REDIS_RATELIMIT_TIMEOUT_MS
UPSTASH_REDIS_RATELIMIT_ANALYTICS
UPSTASH_REDIS_HEARTBEAT_TTL_SECONDS
INDEXING_REQUEST_RATE_LIMIT_MAX
INDEXING_REQUEST_RATE_LIMIT_WINDOW
INDEXING_DISPATCH_LOCK_TTL_SECONDS
INDEXING_TENANT_ACTIVE_LIMIT
INDEXING_TENANT_ACTIVE_TTL_SECONDS
INDEXING_RUN_SNAPSHOT_TTL_SECONDS
DOCUMENT_DETAIL_CACHE_TTL_SECONDS
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

El health del gateway es autenticado y no devuelve URLs internas. Debe informar
`auth_configured: true` y los limites operativos, no secretos.

Tree Indexer via gateway:

```bash
curl -H "authorization: Bearer $COMPUTE_GATEWAY_TOKEN" \
  "$COMPUTE_GATEWAY_URL/v1/tree-index-jobs/not-a-real-id"
```

Ese segundo check deberia devolver `404` autenticado, no `401` ni error de red.

Upstash Redis:

```bash
npm run redis:health
```

Sin `UPSTASH_REDIS_REST_URL` y `UPSTASH_REDIS_REST_TOKEN`, el comando informa
`configured: false` y sale con codigo `0`. Si Redis esta configurado, espera
`PONG`; una falla ahi si sale con codigo distinto de cero.

`npm run indexing:health` tambien incluye estado Redis cuando hay Upstash
configurado: heartbeats de API/workflow, ultimo snapshot live de indexacion y
conteo de slots activos por tenant.

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
  `signals.indexed_document_version_drift`.
- Reencolarlo es opcional y se decide cuando una version nueva cambie calidad,
  parsing, estructura o compatibilidad. La version sirve tambien como marca de
  epoca/auditoria.
- Si el deploy acaba de cambiar versiones, confirmar que `lib/system-versions.json`
  fue incluido en el deploy antes de reencolar.
- No desplegar Vercel/Inngest mientras haya reindexaciones activas salvo
  hotfix necesario.

## Secretos

- Nunca hardcodear keys en codigo.
- En Vercel, guardar valores sin comillas. `KEY=https://...`, no
  `KEY="https://..."` como valor pegado en el dashboard.
- No poner service role en browser.
- No commitear tokens de Upstash. Usar solo `UPSTASH_REDIS_REST_URL` y
  `UPSTASH_REDIS_REST_TOKEN` por env.
- Rotar tokens si se copiaron en chat, logs o shell history.
- El gateway debe recibir signed URLs cortas, no service role desde Inngest.
