"""Detección LLM de TOC. Spec §3 (algoritmo PageIndex) + §3.1 anatomía.

Estrategia: mandar las primeras `max_scan_pages` del markdown al LLM con
prompt que pide identificar (1) si hay TOC, (2) en qué páginas, (3) extraer
el texto crudo. NO transforma a estructura — eso lo hace toc_transformer.

Usa anatomía universal de prompts (cache_design.PromptParts) para
maximizar prompt cache.
"""

import json

import structlog

from ...llm.cache_design import PromptParts, system_user_split
from ...llm.client import LLMClient
from .types import TocDetection

log = structlog.get_logger()


_STATIC_SYSTEM = (
    "You are SDA-Indexer, a document structure analyzer. "
    "Your only job is to identify if a document contains a table of contents (TOC)."
)

_STATIC_INSTRUCTIONS = """\
Task: scan the provided document pages and find the TOC.

Rules:
- A TOC is a list of section titles with page numbers or dotted leaders.
- "Index" at the end of a book is NOT a TOC (it's an alphabetical index).
- If no TOC is present, output has_toc=false and toc_pages=[].
- Output STRICTLY valid JSON matching the schema. No prose, no markdown fences."""

_STATIC_SCHEMA = """\
JSON schema:
{
  "has_toc": boolean,
  "toc_pages": [int],   // 1-indexed page numbers where TOC content appears
  "toc_raw": string     // concatenated text of TOC, or "" if has_toc=false
}"""

_STATIC_EXAMPLES = """\
Example 1 (has TOC):
Input has "Table of Contents" on page 2 with entries.
Output: {"has_toc": true, "toc_pages": [2], "toc_raw": "1. Intro....3\\n2. Setup....5"}

Example 2 (no TOC):
Scanned book with no front matter, just numbered chapters starting page 1.
Output: {"has_toc": false, "toc_pages": [], "toc_raw": ""}"""


def _extract_first_n_pages(markdown: str, n: int) -> str:
    """Devuelve las primeras n páginas asumiendo separadores `## Page X`."""
    lines = markdown.splitlines()
    out: list[str] = []
    page_count = 0
    for line in lines:
        if line.startswith("## Page "):
            page_count += 1
            if page_count > n:
                break
        out.append(line)
    return "\n".join(out)


async def detect_toc(
    *,
    llm: LLMClient,
    model: str,
    markdown: str,
    doc_summary_short: str,
    max_scan_pages: int = 20,
    temperature: float = 0.0,
) -> TocDetection:
    """Devuelve TocDetection. Errores del LLM se propagan (caller decide DLQ)."""
    payload_md = _extract_first_n_pages(markdown, max_scan_pages)

    parts = PromptParts(
        static_system=_STATIC_SYSTEM,
        static_instructions=_STATIC_INSTRUCTIONS,
        static_schema=_STATIC_SCHEMA,
        static_examples=_STATIC_EXAMPLES,
        semi_static_doc_ctx=f"Document context: {doc_summary_short}",
        dynamic_payload=f"Document pages (first {max_scan_pages}):\n\n{payload_md}",
    )
    system, user = system_user_split(parts)

    result = await llm.complete(
        model=model,
        system=system,
        user=user,
        temperature=temperature,
        max_tokens=2048,
        response_format={"type": "json_object"},
    )
    try:
        data = json.loads(result.text)
    except json.JSONDecodeError as e:
        log.warning("toc_detector.json_invalid", text=result.text[:200], err=str(e))
        raise

    return TocDetection(
        has_toc=bool(data.get("has_toc", False)),
        toc_pages=[int(p) for p in data.get("toc_pages", [])],
        toc_raw=str(data.get("toc_raw", "")),
    )
