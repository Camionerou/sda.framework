from __future__ import annotations

import hashlib
import os

import httpx

CACHE_VERSION = "v1"
DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60  # 30 days

UPSTASH_URL = os.getenv("UPSTASH_REDIS_REST_URL", "")
UPSTASH_TOKEN = os.getenv("UPSTASH_REDIS_REST_TOKEN", "")

_TIMEOUT = httpx.Timeout(connect=2.0, read=2.0, write=2.0, pool=2.0)


def _is_configured() -> bool:
    return bool(UPSTASH_URL and UPSTASH_TOKEN)


def summary_cache_key(
    *,
    text: str,
    title: str,
    page_start: int,
    page_end: int,
    summary_model: str,
    tree_prompt_version: str,
) -> str:
    raw = f"{CACHE_VERSION}|{tree_prompt_version}|{summary_model}|{title}|{page_start}-{page_end}|{text}"
    digest = hashlib.sha256(raw.encode()).hexdigest()
    return f"tree:summary:{CACHE_VERSION}:{digest}"


async def get_cached(key: str) -> str | None:
    if not _is_configured():
        return None
    from .http_client import get_supabase_client
    client = get_supabase_client()
    try:
        resp = await client.get(
            f"{UPSTASH_URL}/get/{key}",
            headers={"Authorization": f"Bearer {UPSTASH_TOKEN}"},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
        result = data.get("result")
        return result if isinstance(result, str) else None
    except (httpx.RequestError, httpx.HTTPError):
        return None


async def set_cached(key: str, value: str, ttl: int = DEFAULT_TTL_SECONDS) -> None:
    if not _is_configured():
        return
    from .http_client import get_supabase_client
    client = get_supabase_client()
    try:
        await client.post(
            f"{UPSTASH_URL}/setex/{key}/{ttl}",
            content=value.encode(),
            headers={"Authorization": f"Bearer {UPSTASH_TOKEN}"},
            timeout=_TIMEOUT,
        )
    except (httpx.RequestError, httpx.HTTPError):
        pass
