# sda-indexer

Python service for sda.framework ingest+index pipeline. Spec: [`docs/superpowers/specs/2026-05-24-ingest-index-design.md`](../../docs/superpowers/specs/2026-05-24-ingest-index-design.md).

## Setup

```bash
cd services/sda-indexer
uv sync
cp .env.example .env  # editar con keys reales
uv run pytest
```

## Run locally

```bash
docker compose up
```

## Architecture

Ver spec. Topología control-plane (Supabase) / data-plane (este servicio).
