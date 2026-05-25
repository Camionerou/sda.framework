"""Convierte el toc_raw del detector en [TocNode] tipados. Spec §3 PageIndex.

El raw del TOC suele tener formato libre (dotted leaders, indentación
variable, numeración mixta). Un LLM call interpreta los niveles y emite
JSON estructurado. NO toca el contenido del documento — solo el TOC.
"""

import json

import structlog

from ...llm.cache_design import PromptParts, system_user_split
from ...llm.client import LLMClient
from .types import TocNode

log = structlog.get_logger()


_STATIC_SYSTEM = (
    "You are SDA-Indexer, a TOC transformer. Convert raw table-of-contents "
    "text into structured JSON nodes with title, depth, and page number."
)

_STATIC_INSTRUCTIONS = """\
Task: parse the raw TOC text into a JSON array of nodes.

Rules:
- depth=1 for top-level entries, 2 for sub-entries, etc.
- Infer depth from indentation, numbering (1, 1.1, 1.1.1), or formatting cues.
- page_start = the page number printed next to the entry.
- Titles must be cleaned of dotted leaders and trailing page numbers.
- Output STRICTLY valid JSON. Wrap the array in an object with key 'nodes'."""

_STATIC_SCHEMA = """\
JSON schema:
{"nodes": [{"title": string, "depth": int, "page_start": int}]}"""

_STATIC_EXAMPLES = """\
Example input:
"1. Intro ........ 3
   1.1 Why ....... 4
2. Setup ......... 7"

Example output:
{"nodes": [
  {"title": "Intro", "depth": 1, "page_start": 3},
  {"title": "Why", "depth": 2, "page_start": 4},
  {"title": "Setup", "depth": 1, "page_start": 7}
]}"""


async def transform_toc(
    *,
    llm: LLMClient,
    model: str,
    toc_raw: str,
    doc_summary_short: str,
    temperature: float = 0.0,
) -> list[TocNode]:
    """Devuelve [TocNode] ordenados por aparición."""
    parts = PromptParts(
        static_system=_STATIC_SYSTEM,
        static_instructions=_STATIC_INSTRUCTIONS,
        static_schema=_STATIC_SCHEMA,
        static_examples=_STATIC_EXAMPLES,
        semi_static_doc_ctx=f"Document context: {doc_summary_short}",
        dynamic_payload=f"Raw TOC:\n\n{toc_raw}",
    )
    system, user = system_user_split(parts)

    result = await llm.complete(
        model=model,
        system=system,
        user=user,
        temperature=temperature,
        max_tokens=4096,
        response_format={"type": "json_object"},
    )
    data = json.loads(result.text)
    raw_nodes = data.get("nodes", [])
    if not isinstance(raw_nodes, list):
        log.warning("toc_transformer.invalid_shape", text=result.text[:200])
        raise ValueError(f"Expected array under 'nodes', got: {type(raw_nodes)}")

    return [
        TocNode(
            title=str(n["title"]).strip(),
            depth=int(n["depth"]),
            page_start=int(n["page_start"]),
        )
        for n in raw_nodes
    ]
