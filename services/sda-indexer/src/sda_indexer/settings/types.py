"""Tipos del sistema de configurabilidad universal. Spec §5.5."""

from dataclasses import dataclass
from typing import Literal, Any

ValueType = Literal[
    "string", "number", "boolean", "object", "array",
    "duration_ms", "prompt_template", "model_id", "json_schema", "enum",
]
Scope = Literal["global", "doc_type", "collection", "document"]


@dataclass(frozen=True)
class SettingDef:
    """Definición de una setting en el registry de código.

    El value que termina en DB puede sobreescribirse en runtime; el `default`
    de acá es la fuente de verdad para qué valor "viene de fábrica".
    """
    key: str
    value_type: ValueType
    default: Any
    description: str
    scopes: list[Scope]
    validation: dict | None = None     # JSON Schema
    is_secret: bool = False
