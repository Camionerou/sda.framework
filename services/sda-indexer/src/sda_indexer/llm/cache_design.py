"""Anatomía universal de prompts para maximizar DeepSeek prompt cache.

Spec §3.1: todo prompt sigue la forma
  [static_system | static_instructions | static_schema | static_examples |
   semi_static_doc_ctx | dynamic_payload]

Las primeras 4 zonas son idénticas cross-call dentro de una misma fase
(cache hit cross-doc). semi_static_doc_ctx varía por documento (cache hit
cross-chunk del mismo doc). Solo dynamic_payload varía siempre.

`assert_prefix_stable` se usa en dev/test mode para detectar drift: si
dos calls de la misma fase tienen `static_*` distinto, el cache se rompe.
"""

import hashlib
from dataclasses import dataclass


class PrefixDriftError(AssertionError):
    """Las zonas static_* difieren entre calls de la misma fase. El cache
    de DeepSeek se romperá. Bug en quien arma el prompt."""


@dataclass(frozen=True)
class PromptParts:
    static_system: str
    static_instructions: str
    static_schema: str
    static_examples: str
    semi_static_doc_ctx: str
    dynamic_payload: str

    def assemble(self) -> str:
        """Une las zonas en el orden cache-friendly. Newlines explícitos."""
        return "\n\n".join([
            self.static_system,
            self.static_instructions,
            self.static_schema,
            self.static_examples,
            self.semi_static_doc_ctx,
            self.dynamic_payload,
        ])

    def static_hash(self) -> str:
        """SHA256 de las 4 zonas estáticas. Útil para logs/dashboards."""
        blob = "|".join([
            self.static_system,
            self.static_instructions,
            self.static_schema,
            self.static_examples,
        ]).encode("utf-8")
        return hashlib.sha256(blob).hexdigest()

    def assert_prefix_stable(self, other: "PromptParts") -> None:
        """Raises PrefixDriftError si las zonas estáticas difieren."""
        if self.static_hash() != other.static_hash():
            raise PrefixDriftError(
                f"static prefix drift: self={self.static_hash()[:8]}, "
                f"other={other.static_hash()[:8]}. "
                f"Esto rompe DeepSeek cache."
            )


def system_user_split(parts: PromptParts) -> tuple[str, str]:
    """Convierte PromptParts a (system, user) para OpenAI-compatible client.

    - system: static_system (NO incluye instrucciones — esas van en user
      porque DeepSeek cachea por message content combinado).
    - user: instructions + schema + examples + doc_ctx + payload, en orden.

    Heurística de por qué NO meter todo en system: algunos providers
    estiman cache hits a nivel de mensaje, no del prompt concatenado.
    Mantener una división consistente facilita debugging.
    """
    system = parts.static_system
    user = "\n\n".join([
        parts.static_instructions,
        parts.static_schema,
        parts.static_examples,
        parts.semi_static_doc_ctx,
        parts.dynamic_payload,
    ])
    return system, user
