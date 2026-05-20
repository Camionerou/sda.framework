# Deploy FastAPI Tree Indexer en srv-ia-01

Estado: desplegado y verificado en `srv-ia-01`.

## Que se hizo

- Se agrego `workers/tree-indexer-python/deploy.sh`.
- Se agrego `workers/tree-indexer-python/sda-tree-indexer.service`.
- El worker quedo instalado en:
  - `/home/sistemas/sda-tree-indexer-python`
  - `/home/sistemas/sda-tree-indexer-data`
- El servicio user-level quedo activo:
  - `sda-tree-indexer.service`
- El gateway Node existente sigue activo:
  - `sda-compute-gateway.service`
- No se cambio la configuracion de Tailscale Funnel. Sigue apuntando `/` al
  gateway Node en `127.0.0.1:8787`.

## Verificacion

- `GET /v1/health` en `127.0.0.1:8790` respondio:
  - `ok: true`
  - `service: sda-tree-indexer`
  - `llm_configured: false`
- Smoke remoto real contra Supabase/MinerU:
  - `artifact_count`: 49.
  - `page_count`: 12.
  - `stage`: `llm_missing`.
  - `error`: `Tree LLM no configurado; paginas MinerU listas.`

## Gotcha detectado

El primer deploy tomo una `SUPABASE_URL` local vieja. Se corrigio el deploy para
que por defecto use el `.env` remoto del Compute Gateway como fuente de verdad
para Supabase.

## Pendiente

1. Decidir como exponer `/v1/tree-index-jobs`:
   - ruta separada en Tailscale Funnel;
   - proxy desde el gateway Node;
   - consumo interno por SSH/Tailscale sin exposicion publica.
2. Configurar provider/modelo LLM estructural.
3. Conectar Inngest al worker Python.
