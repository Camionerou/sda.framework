# sda-mineru-parser

PDF parsing service para sda.framework Wave 1. Corre en srv-ia-01 con GPU local, expuesto vía Cloudflare Tunnel a `https://mineru.sdaframework.com`.

## Setup

```bash
cd services/sda-mineru-parser
uv sync
cp .env.example .env  # MINERU_SHARED_SECRET, etc.
uv run pytest
```

## Run

```bash
uv run uvicorn sda_mineru.main:app --host 0.0.0.0 --port 8001
```

## Endpoints

- `GET /healthz` — health check
- `POST /parse` — descarga PDF desde signed_url, ejecuta heuristics + parsing, devuelve markdown + metadata

Ver spec [`docs/superpowers/specs/2026-05-25-ingest-index-wave-1-design.md`](../../docs/superpowers/specs/2026-05-25-ingest-index-wave-1-design.md) §5.1.

## Deploy a srv-ia-01

```bash
# 1. Sync code
rsync -av --exclude='.venv/' --exclude='__pycache__/' \
    services/sda-mineru-parser/ enzo@srv-ia-01:/home/enzo/sda-mineru-parser/

# 2. Install deps en el server
ssh enzo@srv-ia-01 'cd /home/enzo/sda-mineru-parser && uv sync'

# 3. Setup env file (one-time)
ssh enzo@srv-ia-01 'sudo mkdir -p /etc/sda-mineru && sudo tee /etc/sda-mineru/env <<EOF
MINERU_SHARED_SECRET=<generate-with-openssl-rand-hex-32>
SDA_MINERU_CACHE_DIR=/var/cache/sda-mineru
EOF'
ssh enzo@srv-ia-01 'sudo chmod 600 /etc/sda-mineru/env'

# 4. Install systemd unit
ssh enzo@srv-ia-01 'sudo cp /home/enzo/sda-mineru-parser/systemd/sda-mineru.service /etc/systemd/system/'
ssh enzo@srv-ia-01 'sudo systemctl daemon-reload && sudo systemctl enable --now sda-mineru'

# 5. Verify
ssh enzo@srv-ia-01 'systemctl status sda-mineru && curl -s http://127.0.0.1:8001/healthz'
```

