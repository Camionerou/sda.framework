# SDA Compute Gateway

Gateway minimo para correr trabajo pesado fuera de Vercel. Inngest crea un job
async y el gateway descarga el documento desde una signed URL privada.

## Endpoints

- `GET /v1/health`
- `POST /v1/index-jobs`
- `GET /v1/index-jobs/:id`

## Env

```bash
PORT=8787
SDA_COMPUTE_GATEWAY_DATA_DIR=/var/lib/sda-compute-gateway
SDA_COMPUTE_GATEWAY_TOKEN=secret
SDA_COMPUTE_GATEWAY_CONCURRENCY=1
SDA_COMPUTE_GATEWAY_MAX_BODY_BYTES=1048576
SDA_MINERU_BIN=/home/sistemas/sda-mineru/.venv/bin/mineru
SDA_MINERU_BACKEND=pipeline
SDA_MINERU_LANG=latin
SUPABASE_URL=https://project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
SDA_TREE_INDEXER_URL=http://127.0.0.1:8790
SDA_TREE_INDEXER_TOKEN=secret
```

`SDA_COMPUTE_GATEWAY_TOKEN` es obligatorio. Si falta, el proceso no arranca.
El health check tambien requiere bearer auth.

`SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` son obligatorios para una ingesta
enterprise: el gateway debe subir los artefactos reales de MinerU a Supabase
Storage. El disco local queda como cache operacional.

## Deploy manual en srv-ia-01

```bash
cd workers/compute-gateway
SDA_COMPUTE_GATEWAY_TOKEN="$(openssl rand -hex 32)" \
SDA_TREE_INDEXER_TOKEN="$(openssl rand -hex 32)" \
./deploy.sh
```

El gateway procesa jobs en background con concurrencia limitada. Para cada job:

1. descarga el documento desde la signed URL generada por Inngest;
2. ejecuta MinerU real;
3. sube markdown, JSON, PDFs de debug, imagenes y log a Supabase Storage;
4. deja un manifest consultable en `GET /v1/index-jobs/:id`.

Tambien proxy a `SDA_TREE_INDEXER_URL` para:

- `POST /v1/tree-index-jobs`
- `GET /v1/tree-index-jobs/:id`
- `GET /v1/tree-index-jobs/:id/result`

Esto permite que Inngest use una sola `COMPUTE_GATEWAY_URL` publica y el mismo
control de bearer auth para MinerU y el Tree Indexer Python.
