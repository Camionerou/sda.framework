"""LLM client OpenAI-compatible. Funciona con DeepSeek y OpenRouter."""

from dataclasses import dataclass
from openai import AsyncOpenAI
import structlog

log = structlog.get_logger()


@dataclass(frozen=True)
class LLMResult:
    text: str
    tokens_in: int
    tokens_out: int
    cached_tokens: int
    model: str


class LLMClient:
    def __init__(self, api_key: str, base_url: str):
        self._client = AsyncOpenAI(api_key=api_key, base_url=base_url)

    async def complete(
        self, *,
        model: str,
        system: str,
        user: str,
        temperature: float = 0.2,
        max_tokens: int | None = None,
        response_format: dict | None = None,
    ) -> LLMResult:
        kwargs = {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": temperature,
        }
        if max_tokens is not None:
            kwargs["max_tokens"] = max_tokens
        if response_format is not None:
            kwargs["response_format"] = response_format

        log.debug("llm.call.start", model=model, system_len=len(system), user_len=len(user))
        resp = await self._client.chat.completions.create(**kwargs)
        usage = resp.usage
        cached = 0
        details = getattr(usage, "prompt_tokens_details", None)
        if details is not None:
            cached = getattr(details, "cached_tokens", 0) or 0
        text = resp.choices[0].message.content or ""
        if not text.strip():
            # Algunos modelos (ej. DeepSeek bajo carga concurrente) devuelven
            # content vacío sin error. Tratamos como transient para que tenacity
            # reintente con backoff en vez de persistir un summary vacío.
            log.warning(
                "llm.empty_content",
                model=model,
                tokens_out=usage.completion_tokens,
                finish_reason=getattr(resp.choices[0], "finish_reason", None),
            )
            raise EmptyLLMResponseError(
                f"LLM returned empty content (model={model}, "
                f"tokens_out={usage.completion_tokens}, "
                f"finish_reason={getattr(resp.choices[0], 'finish_reason', None)})"
            )
        return LLMResult(
            text=text,
            tokens_in=usage.prompt_tokens,
            tokens_out=usage.completion_tokens,
            cached_tokens=cached,
            model=resp.model,
        )


class EmptyLLMResponseError(Exception):
    """LLM devolvió content vacío. Retryable — el siguiente intento puede
    completar normalmente bajo menos carga concurrente."""
    pass
