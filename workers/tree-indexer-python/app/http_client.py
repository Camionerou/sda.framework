from __future__ import annotations

import asyncio
from functools import lru_cache

import httpx


def _http2_available() -> bool:
    try:
        import h2  # noqa: F401
        return True
    except ImportError:
        return False


@lru_cache(maxsize=1)
def get_llm_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=httpx.Timeout(connect=10.0, read=120.0, write=30.0, pool=5.0),
        limits=httpx.Limits(
            max_keepalive_connections=20,
            max_connections=50,
            keepalive_expiry=60.0,
        ),
        http2=_http2_available(),
    )


@lru_cache(maxsize=1)
def get_supabase_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=httpx.Timeout(connect=10.0, read=120.0, write=30.0, pool=5.0),
        limits=httpx.Limits(
            max_keepalive_connections=10,
            max_connections=30,
            keepalive_expiry=60.0,
        ),
    )


@lru_cache(maxsize=1)
def get_llm_semaphore() -> asyncio.Semaphore:
    from .tree_graph.config import llm_max_inflight
    return asyncio.Semaphore(llm_max_inflight())


async def close_clients() -> None:
    await get_llm_client().aclose()
    await get_supabase_client().aclose()
    get_llm_client.cache_clear()
    get_supabase_client.cache_clear()
