"""Retry wrapper basado en tenacity. Backoff exponencial con jitter."""

from typing import Callable, TypeVar, Awaitable
from tenacity import (
    AsyncRetrying, stop_after_attempt, wait_exponential_jitter,
    retry_if_exception_type, before_sleep_log,
)
import structlog
import logging
from openai import APIError, APITimeoutError, RateLimitError, APIConnectionError

log = structlog.get_logger()
_stdlib_log = logging.getLogger("sda_indexer.llm.retry")

T = TypeVar("T")

RETRY_EXCEPTIONS = (APIError, APITimeoutError, RateLimitError, APIConnectionError)


def with_llm_retry(
    fn: Callable[..., Awaitable[T]],
    *,
    max_attempts: int = 3,
    base_ms: int = 1000,
    max_ms: int = 8000,
) -> Callable[..., Awaitable[T]]:
    """Devuelve una versión retryable de fn (async). Reintenta sólo en errores
    transients de OpenAI SDK; deja propagar todo lo demás."""
    async def wrapped(*args, **kwargs):
        async for attempt in AsyncRetrying(
            stop=stop_after_attempt(max_attempts),
            wait=wait_exponential_jitter(initial=base_ms / 1000.0, max=max_ms / 1000.0),
            retry=retry_if_exception_type(RETRY_EXCEPTIONS),
            before_sleep=before_sleep_log(_stdlib_log, logging.WARNING),
            reraise=True,
        ):
            with attempt:
                return await fn(*args, **kwargs)
    return wrapped
