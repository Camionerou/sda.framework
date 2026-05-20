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
```

`SDA_COMPUTE_GATEWAY_TOKEN` es opcional para desarrollo, pero obligatorio en el
server real.

## Deploy manual en srv-ia-01

```bash
cd workers/compute-gateway
SDA_COMPUTE_GATEWAY_TOKEN="$(openssl rand -hex 32)" ./deploy.sh
```

La primera version solo descarga el archivo y deja el job en estado
`downloaded`. El siguiente corte reemplaza ese punto por MinerU + SDA Tree
Indexer.
