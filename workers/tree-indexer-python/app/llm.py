from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from typing import Any, Literal, TypeVar

import httpx

from .http_client import get_llm_client, get_llm_semaphore

Purpose = Literal["structure", "summary"]
T = TypeVar("T")


class TreeLlmMissingConfigError(RuntimeError):
    pass


class TreeLlmJsonParseError(RuntimeError):
    def __init__(self, message: str, raw_content: str) -> None:
        super().__init__(message)
        self.raw_content = raw_content


TRANSIENT_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})


class TreeLlmTransientError(RuntimeError):
    """HTTP transient (408, 425, 429, 5xx). Reintentable."""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code


class TreeLlmPermanentError(RuntimeError):
    """HTTP permanente (400, 401, 403, 404, 422). NO reintentar."""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True)
class TreeLlmConfig:
    api_key: str
    base_url: str
    allow_fallbacks: bool
    model: str
    provider: str
    provider_order: list[str]
    reasoning_effort: str | None
    reasoning_exclude: bool
    service_tier: str | None
    timeout_seconds: float


def _positive_float(value: str | None, fallback: float) -> float:
    try:
        parsed = float(value) if value is not None else fallback
    except ValueError:
        return fallback
    return parsed if parsed > 0 else fallback


def _timeout_seconds() -> float:
    if seconds := os.getenv("SDA_TREE_LLM_TIMEOUT_SECONDS"):
        return _positive_float(seconds, 120)
    if milliseconds := os.getenv("SDA_TREE_LLM_TIMEOUT_MS"):
        return _positive_float(milliseconds, 120_000) / 1000
    return 120


def _csv_env(name: str) -> list[str]:
    return [part.strip() for part in os.getenv(name, "").split(",") if part.strip()]


def _bool_env(name: str, fallback: bool) -> bool:
    value = os.getenv(name)
    if value is None or value == "":
        return fallback
    return value.lower() not in {"0", "false", "no", "off"}


def infer_provider() -> str:
    if provider := os.getenv("SDA_TREE_LLM_PROVIDER"):
        return provider
    if os.getenv("OPENROUTER_API_KEY"):
        return "openrouter"
    return "openai"


def infer_base_url(provider: str) -> str:
    if base_url := os.getenv("SDA_TREE_LLM_BASE_URL"):
        return base_url.rstrip("/")
    if provider == "openrouter":
        return "https://openrouter.ai/api/v1"
    return "https://api.openai.com/v1"


def _api_key(provider: str) -> str | None:
    return (
        os.getenv("SDA_TREE_LLM_API_KEY")
        or (os.getenv("OPENROUTER_API_KEY") if provider == "openrouter" else None)
        or os.getenv("OPENAI_API_KEY")
    )


def is_tree_llm_configured() -> bool:
    provider = infer_provider()
    return bool(_api_key(provider) and os.getenv("SDA_TREE_LLM_MODEL"))


def get_tree_llm_config(purpose: Purpose) -> TreeLlmConfig:
    provider = infer_provider()
    api_key = _api_key(provider)
    if purpose == "summary":
        model = os.getenv("SDA_TREE_SUMMARY_MODEL") or os.getenv("SDA_TREE_LLM_MODEL")
    else:
        model = os.getenv("SDA_TREE_LLM_MODEL")

    if not api_key or not model:
        raise TreeLlmMissingConfigError(
            "Falta configurar SDA_TREE_LLM_API_KEY y SDA_TREE_LLM_MODEL."
        )

    return TreeLlmConfig(
        allow_fallbacks=_bool_env("SDA_TREE_LLM_ALLOW_FALLBACKS", True),
        api_key=api_key,
        base_url=infer_base_url(provider),
        model=model,
        provider=provider,
        provider_order=_csv_env("SDA_TREE_LLM_PROVIDER_ORDER"),
        reasoning_effort=os.getenv("SDA_TREE_LLM_REASONING_EFFORT") or None,
        reasoning_exclude=_bool_env("SDA_TREE_LLM_REASONING_EXCLUDE", True),
        service_tier=os.getenv("SDA_TREE_LLM_SERVICE_TIER") or None,
        timeout_seconds=_timeout_seconds(),
    )


def extract_json(content: str) -> Any:
    text = content.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?", "", text, flags=re.IGNORECASE).strip()
        text = re.sub(r"```$", "", text).strip()

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        starts = [index for index in [text.find("{"), text.find("[")] if index >= 0]
        start = min(starts) if starts else -1
        end = max(text.rfind("}"), text.rfind("]"))
        if start >= 0 and end > start:
            try:
                return json.loads(text[start : end + 1])
            except json.JSONDecodeError as error:
                raise TreeLlmJsonParseError("El LLM devolvio JSON invalido.", content) from error
        raise TreeLlmJsonParseError("El LLM no devolvio JSON parseable.", content)


def _message_content(data: dict[str, Any]) -> str:
    content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(part.get("text", "") for part in content if isinstance(part, dict))
    return ""


async def call_tree_llm(prompt: str, purpose: Purpose, expect_json: bool) -> dict[str, Any]:
    config = get_tree_llm_config(purpose)
    headers = {
        "Authorization": f"Bearer {config.api_key}",
        "Content-Type": "application/json",
    }
    if config.provider == "openrouter":
        headers["HTTP-Referer"] = os.getenv("APP_ORIGIN", "https://sda-framework.vercel.app")
        headers["X-Title"] = "SDA Framework"

    payload: dict[str, Any] = {
        "messages": [{"role": "user", "content": prompt}],
        "model": config.model,
        "temperature": 0,
    }
    if config.provider == "openrouter":
        if config.provider_order:
            payload["provider"] = {
                "allow_fallbacks": config.allow_fallbacks,
                "order": config.provider_order,
            }
        if config.service_tier:
            payload["service_tier"] = config.service_tier
        if config.reasoning_effort:
            payload["reasoning"] = {
                "effort": config.reasoning_effort,
                "exclude": config.reasoning_exclude,
            }
    if expect_json and os.getenv("SDA_TREE_LLM_JSON_MODE") == "1":
        payload["response_format"] = {"type": "json_object"}

    client = get_llm_client()
    sem = get_llm_semaphore()
    async with sem:
        response = await client.post(
            f"{config.base_url}/chat/completions",
            headers=headers,
            json=payload,
            timeout=config.timeout_seconds,
        )

    try:
        data = response.json()
    except json.JSONDecodeError as error:
        raise RuntimeError(f"Tree LLM devolvio respuesta no JSON: HTTP {response.status_code}") from error

    if response.status_code >= 400:
        message = (
            data.get("error", {}).get("message") if isinstance(data, dict) else None
        ) or f"Tree LLM fallo con HTTP {response.status_code}."
        if response.status_code in TRANSIENT_STATUS:
            raise TreeLlmTransientError(response.status_code, message)
        raise TreeLlmPermanentError(response.status_code, message)

    content = _message_content(data)
    if not content:
        raise RuntimeError("Tree LLM devolvio una respuesta vacia.")

    return {
        "content": content,
        "finish_reason": data.get("choices", [{}])[0].get("finish_reason"),
        "model": config.model,
        "provider": config.provider,
        "provider_order": config.provider_order,
        "service_tier": data.get("service_tier") or config.service_tier,
    }


async def call_tree_llm_json(prompt: str, purpose: Purpose) -> dict[str, Any]:
    response = await call_tree_llm(prompt, purpose, expect_json=True)
    return {**response, "json": extract_json(response["content"])}


async def call_tree_llm_text(prompt: str, purpose: Purpose) -> dict[str, Any]:
    return await call_tree_llm(prompt, purpose, expect_json=False)
