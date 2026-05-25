"""Tiered model router para Wave 1 (Mejora #6 del spec).

Cada fase del pipeline llama a `route(phase, settings)` y obtiene un
`LLMConfig` con model + temperature + max_tokens resueltos contra las
settings runtime. Permite hot-swap sin redeploy.

Sub-fases sin settings propias (validator, repair) caen al "settings group"
de structure por default. Wave 2 puede granularizar si se necesita.
"""

from dataclasses import dataclass
from enum import Enum
from typing import Callable, Awaitable, Any


class Phase(str, Enum):
    TOC = "toc"                   # toc_detect + toc_transform
    STRUCTURE = "structure"       # index_extractor
    VALIDATOR = "validator"       # → cae a structure.*
    REPAIR = "repair"             # → cae a structure.*
    SUMMARIZE = "summarize"       # summary + contextual_prefix combinado


@dataclass(frozen=True)
class LLMConfig:
    model: str
    temperature: float
    phase: Phase
    max_tokens: int | None = None


# Mapping: si la fase no tiene settings propias, ¿de qué grupo lee?
_FALLBACK_GROUP: dict[Phase, Phase] = {
    Phase.VALIDATOR: Phase.STRUCTURE,
    Phase.REPAIR: Phase.STRUCTURE,
}


def _settings_group(phase: Phase) -> str:
    """Devuelve el prefijo de settings que aplica a esta fase."""
    actual = _FALLBACK_GROUP.get(phase, phase)
    return f"llm.router.{actual.value}"


def route(
    phase: Phase,
    *,
    settings_resolver: Callable[..., Any],
    document_id: str | None = None,
    collection_id: str | None = None,
    max_tokens: int | None = None,
) -> LLMConfig:
    """Resuelve LLMConfig para `phase` leyendo settings vía resolver.

    `settings_resolver(key, **kwargs)` debe ser sync o async-resolved upstream.
    Para uso async, el caller pasa `await settings.resolve` envuelto en lambda.
    """
    group = _settings_group(phase)
    model = settings_resolver(
        f"{group}.model",
        document_id=document_id,
        collection_id=collection_id,
    )
    temperature = settings_resolver(
        f"{group}.temperature",
        document_id=document_id,
        collection_id=collection_id,
    )
    return LLMConfig(
        model=model,
        temperature=float(temperature),
        phase=phase,
        max_tokens=max_tokens,
    )


async def aroute(
    phase: Phase,
    *,
    settings,
    document_id: str | None = None,
    collection_id: str | None = None,
    max_tokens: int | None = None,
) -> LLMConfig:
    """Async variant que usa SettingsClient real (await settings.resolve)."""
    group = _settings_group(phase)
    model = await settings.resolve(
        f"{group}.model",
        document_id=document_id,
        collection_id=collection_id,
    )
    temperature = await settings.resolve(
        f"{group}.temperature",
        document_id=document_id,
        collection_id=collection_id,
    )
    return LLMConfig(
        model=model,
        temperature=float(temperature),
        phase=phase,
        max_tokens=max_tokens,
    )
