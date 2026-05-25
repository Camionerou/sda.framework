# Base image: CUDA support para MinerU GPU
# Producción en srv-ia-01 usa systemd unit (Task 13 step 1), no este Dockerfile.
# Este Dockerfile es para CI / dev local sin GPU (fallback CPU MinerU).
FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 \
    poppler-utils \
    libmagic1 \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml .
RUN pip install --no-cache-dir uv && uv sync --no-dev

COPY src/ src/

ENV SDA_MINERU_CACHE_DIR=/var/cache/sda-mineru
RUN mkdir -p /var/cache/sda-mineru

EXPOSE 8001

CMD ["uv", "run", "--no-sync", "uvicorn", "sda_mineru.main:app", \
     "--host", "0.0.0.0", "--port", "8001", "--workers", "1"]
