from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

import httpx

from .pageindex_style import TreeChunk


class EmbeddingMissingConfigError(RuntimeError):
    pass


@dataclass(frozen=True)
class EmbeddingConfig:
    api_key: str
    base_url: str
    batch_size: int
    dimensions: int
    max_input_chars: int
    model: str
    provider: str
    provider_order: list[str]
    timeout_seconds: float


def _positive_int(value: str | None, fallback: int) -> int:
    try:
        parsed = int(value) if value is not None else fallback
    except ValueError:
        return fallback
    return parsed if parsed > 0 else fallback


def _positive_float(value: str | None, fallback: float) -> float:
    try:
        parsed = float(value) if value is not None else fallback
    except ValueError:
        return fallback
    return parsed if parsed > 0 else fallback


def _csv_env(name: str) -> list[str]:
    return [part.strip() for part in os.getenv(name, "").split(",") if part.strip()]


def _embedding_provider() -> str:
    return os.getenv("SDA_EMBEDDING_PROVIDER", "openrouter")


def _api_key() -> str | None:
    provider = _embedding_provider()
    return (
        os.getenv("SDA_EMBEDDING_API_KEY")
        or (os.getenv("OPENROUTER_API_KEY") if provider == "openrouter" else None)
        or os.getenv("OPENAI_API_KEY")
    )


def _base_url(provider: str) -> str:
    if base_url := os.getenv("SDA_EMBEDDING_BASE_URL"):
        return base_url.rstrip("/")
    if provider == "openrouter":
        return "https://openrouter.ai/api/v1"
    return "https://api.openai.com/v1"


def is_embedding_configured() -> bool:
    return bool(_api_key())


def get_embedding_config() -> EmbeddingConfig:
    api_key = _api_key()
    if not api_key:
        raise EmbeddingMissingConfigError(
            "Falta configurar SDA_EMBEDDING_API_KEY, OPENROUTER_API_KEY u OPENAI_API_KEY para embeddings."
        )

    provider = _embedding_provider()

    return EmbeddingConfig(
        api_key=api_key,
        base_url=_base_url(provider),
        batch_size=_positive_int(os.getenv("SDA_EMBEDDING_BATCH_SIZE"), 96),
        dimensions=_positive_int(os.getenv("SDA_EMBEDDING_DIMENSIONS"), 1536),
        max_input_chars=_positive_int(os.getenv("SDA_EMBEDDING_MAX_INPUT_CHARS"), 8000),
        model=os.getenv("SDA_EMBEDDING_MODEL", "google/gemini-embedding-2-preview"),
        provider=provider,
        provider_order=_csv_env("SDA_EMBEDDING_PROVIDER_ORDER"),
        timeout_seconds=_positive_float(os.getenv("SDA_EMBEDDING_TIMEOUT_SECONDS"), 120),
    )


def hierarchy_embedding_text(chunk: TreeChunk, document_type: str) -> str:
    path = " > ".join(chunk["node_path"])
    title = chunk["node_path"][-1] if chunk["node_path"] else chunk["node_id"]
    routing_summary = (chunk.get("routing_summary") or "").strip()
    summary = (chunk.get("summary") or "").strip()
    fallback_content = chunk["content"][:2000].strip()
    useful_text = routing_summary or summary or fallback_content

    return "\n".join(
        part
        for part in [
            f"Document type: {document_type}",
            f"Path: {path}",
            f"Title: {title}",
            "Routing summary:",
            useful_text,
        ]
        if part
    )


def _embedding_from_response(item: Any, dimensions: int) -> list[float]:
    if not isinstance(item, dict) or not isinstance(item.get("embedding"), list):
        raise RuntimeError("Embedding API devolvio un item sin embedding.")

    embedding = item["embedding"]
    if len(embedding) != dimensions:
        raise RuntimeError(
            f"Embedding dimension invalida: esperado {dimensions}, recibido {len(embedding)}."
        )

    values: list[float] = []
    for value in embedding:
        if not isinstance(value, (int, float)):
            raise RuntimeError("Embedding API devolvio valores no numericos.")
        values.append(float(value))
    return values


async def embed_texts(texts: list[str]) -> tuple[list[list[float]], EmbeddingConfig]:
    config = get_embedding_config()
    embeddings: list[list[float] | None] = [None] * len(texts)

    headers = {
        "Authorization": f"Bearer {config.api_key}",
        "Content-Type": "application/json",
    }
    if config.provider == "openrouter":
        headers["HTTP-Referer"] = os.getenv("APP_ORIGIN", "https://sda-framework.vercel.app")
        headers["X-Title"] = "SDA Framework"

    async with httpx.AsyncClient(timeout=config.timeout_seconds) as client:
        for start in range(0, len(texts), config.batch_size):
            batch = [text[: config.max_input_chars] for text in texts[start : start + config.batch_size]]
            payload: dict[str, Any] = {
                "encoding_format": "float",
                "dimensions": config.dimensions,
                "input": batch,
                "model": config.model,
            }
            if config.provider == "openrouter" and config.provider_order:
                payload["provider"] = {
                    "allow_fallbacks": True,
                    "order": config.provider_order,
                }
            response = await client.post(
                f"{config.base_url}/embeddings",
                headers=headers,
                json=payload,
            )

            try:
                data = response.json()
            except ValueError as error:
                raise RuntimeError(
                    f"Embedding API devolvio respuesta no JSON: HTTP {response.status_code}"
                ) from error

            if response.status_code >= 400:
                message = data.get("error", {}).get("message") if isinstance(data, dict) else None
                raise RuntimeError(message or f"Embedding API fallo con HTTP {response.status_code}.")

            items = data.get("data") if isinstance(data, dict) else None
            if not isinstance(items, list) or len(items) != len(batch):
                raise RuntimeError("Embedding API devolvio una cantidad inesperada de embeddings.")

            for offset, item in enumerate(items):
                index = item.get("index") if isinstance(item, dict) else None
                target_index = start + (index if isinstance(index, int) else offset)
                if target_index < start or target_index >= start + len(batch):
                    raise RuntimeError("Embedding API devolvio un indice fuera del batch.")
                embeddings[target_index] = _embedding_from_response(item, config.dimensions)

    if any(embedding is None for embedding in embeddings):
        raise RuntimeError("Embedding API no devolvio todos los embeddings esperados.")

    return [embedding for embedding in embeddings if embedding is not None], config


async def embed_chunks(
    chunks: list[TreeChunk],
    *,
    document_type: str,
) -> tuple[list[TreeChunk], EmbeddingConfig]:
    texts = [hierarchy_embedding_text(chunk, document_type) for chunk in chunks]
    embeddings, config = await embed_texts(texts)
    return [
        {
            **chunk,
            "embedding": embedding,
            "embedding_model": config.model,
        }
        for chunk, embedding in zip(chunks, embeddings, strict=True)
    ], config
