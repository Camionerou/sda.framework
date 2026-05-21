from __future__ import annotations

import os
from functools import lru_cache


def _positive_int(name: str, fallback: int) -> int:
    try:
        value = int(os.getenv(name, str(fallback)))
    except ValueError:
        return fallback
    return value if value > 0 else fallback


def _non_negative_int(name: str, fallback: int) -> int:
    try:
        value = int(os.getenv(name, str(fallback)))
    except ValueError:
        return fallback
    return max(value, 0)


@lru_cache(maxsize=1)
def max_prompt_chars() -> int:
    return _positive_int("SDA_TREE_MAX_PROMPT_CHARS", 60_000)


@lru_cache(maxsize=1)
def summary_concurrency() -> int:
    return _positive_int("SDA_TREE_SUMMARY_CONCURRENCY", 6)


@lru_cache(maxsize=1)
def repair_attempt_limit() -> int:
    return _non_negative_int("SDA_TREE_REPAIR_ATTEMPTS", 1)


@lru_cache(maxsize=1)
def degrade_attempt_limit() -> int:
    return _non_negative_int("SDA_TREE_DEGRADE_ATTEMPTS", 1)


@lru_cache(maxsize=1)
def refine_max_pages() -> int:
    return _positive_int("SDA_TREE_REFINE_MAX_PAGES", 10)


@lru_cache(maxsize=1)
def refine_max_tokens() -> int:
    return _positive_int("SDA_TREE_REFINE_MAX_TOKENS", 20_000)


@lru_cache(maxsize=1)
def refine_iteration_limit() -> int:
    return _non_negative_int("SDA_TREE_REFINE_MAX_ITERATIONS", 3)


@lru_cache(maxsize=1)
def llm_max_inflight() -> int:
    return _positive_int("SDA_TREE_LLM_MAX_INFLIGHT", 12)
