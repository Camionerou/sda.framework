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
