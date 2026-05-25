"""Combined (contextual_prefix, summary) en 1 LLM call. Mejora #1 del spec.

Reemplaza la lógica de summarizer/summarize.py (que solo genera summary).
La call retorna JSON {prefix, summary} para garantizar coherencia y ahorro
de latencia/costo vs 2 calls separadas.
"""

import json
from dataclasses import dataclass

import structlog

from ...llm.cache_design import PromptParts, system_user_split
from ...llm.client import LLMClient

log = structlog.get_logger()


@dataclass(frozen=True)
class ContextualResult:
    prefix: str
    summary: str
    tokens_in: int
    tokens_out: int
    cached_tokens: int
    model: str
    rendered_user_prompt: str


_STATIC_SYSTEM = (
    "You are SDA-Indexer, a contextual chunking assistant. For each chunk "
    "you produce a short contextual prefix and a focused summary."
)

_STATIC_INSTRUCTIONS = """\
Task: given a document context and a chunk of text, output JSON with:
- prefix: 50-100 tokens that situate the chunk inside the document
  (e.g., "This section of the Acme 2026 contract discusses..."). The
  prefix will be prepended to the chunk text for retrieval.
- summary: 2-4 sentence focused summary starting with the topic, no
  meta-prose like "This section discusses...".

Rules:
- prefix references the document concretely (use names/dates if present).
- summary stays within the requested character budget.
- Output STRICTLY valid JSON. No markdown fences."""

_STATIC_SCHEMA = """\
JSON schema:
{"prefix": string, "summary": string}"""

_STATIC_EXAMPLES = """\
Example input chunk: "Vacation: 1.5 days/month, max 30."
Document: "Acme 2026 contract."
Output: {
  "prefix": "This section of the Acme 2026 employment contract describes the vacation policy.",
  "summary": "Empleados acumulan 1.5 días por mes hasta un máximo de 30."
}"""


async def generate_contextual_prefix_and_summary(
    *,
    llm: LLMClient,
    model: str,
    doc_summary_short: str,
    chunk_text: str,
    prefix_max_tokens: int = 100,
    max_summary_chars: int = 400,
    language: str = "es",
    temperature: float = 0.1,
) -> ContextualResult:
    """1 LLM call → ContextualResult con prefix + summary."""
    semi_static = (
        f"Document context: {doc_summary_short}\n"
        f"Language for summary: {language}\n"
        f"Prefix budget: {prefix_max_tokens} tokens.\n"
        f"Summary budget: {max_summary_chars} chars."
    )
    parts = PromptParts(
        static_system=_STATIC_SYSTEM,
        static_instructions=_STATIC_INSTRUCTIONS,
        static_schema=_STATIC_SCHEMA,
        static_examples=_STATIC_EXAMPLES,
        semi_static_doc_ctx=semi_static,
        dynamic_payload=f"Chunk text:\n\n{chunk_text}",
    )
    system, user = system_user_split(parts)
    result = await llm.complete(
        model=model,
        system=system,
        user=user,
        temperature=temperature,
        max_tokens=max(256, prefix_max_tokens + max_summary_chars // 2),
        response_format={"type": "json_object"},
    )
    data = json.loads(result.text)
    return ContextualResult(
        prefix=str(data.get("prefix", "")).strip(),
        summary=str(data.get("summary", "")).strip(),
        tokens_in=result.tokens_in,
        tokens_out=result.tokens_out,
        cached_tokens=result.cached_tokens,
        model=result.model,
        rendered_user_prompt=user,
    )
