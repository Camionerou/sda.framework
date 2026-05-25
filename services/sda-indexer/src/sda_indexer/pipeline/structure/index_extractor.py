"""Fallback cuando no hay TOC: extrae estructura página por página via LLM.

Más caro que toc_transformer (10-30 calls vs 1) pero necesario para PDFs
"feos" sin TOC (scans, libros viejos). Spec §3 algoritmo PageIndex.

Estrategia: chunkear el markdown por `chunk_size_pages`, pedirle al LLM
que extraiga headings en cada chunk, y agregar manteniendo orden de página.
"""

import asyncio
import json

import structlog

from ...llm.cache_design import PromptParts, system_user_split
from ...llm.client import LLMClient
from .types import TocNode

log = structlog.get_logger()


_STATIC_SYSTEM = (
    "You are SDA-Indexer, a document structure extractor. Identify "
    "section headings inside arbitrary document text."
)

_STATIC_INSTRUCTIONS = """\
Task: scan the provided pages and emit a JSON array of headings found.

Rules:
- Heading = line that introduces a new topic/section (numbered, bold, all-caps...).
- Ignore running headers/footers, page numbers, watermarks.
- depth=1 for top-level, increment for sub-sections. Infer from numbering or formatting.
- page_start = the page number the heading appears on (look for `## Page N` markers).
- Return ONLY new headings found in THIS chunk (no globals).
- Output JSON object with key 'headings' (array)."""

_STATIC_SCHEMA = """\
JSON schema:
{"headings": [{"title": string, "depth": int, "page_start": int}]}"""

_STATIC_EXAMPLES = """\
Example: pages 5-7 contain "## Page 5\\n2. Methods\\n...".
Output: {"headings": [{"title": "Methods", "depth": 1, "page_start": 5}]}"""


def _chunk_by_pages(markdown: str, pages_per_chunk: int) -> list[str]:
    """Split markdown en chunks que contienen pages_per_chunk páginas cada uno."""
    chunks: list[list[str]] = [[]]
    page_in_chunk = 0
    for line in markdown.splitlines():
        if line.startswith("## Page "):
            if page_in_chunk >= pages_per_chunk:
                chunks.append([])
                page_in_chunk = 0
            page_in_chunk += 1
        chunks[-1].append(line)
    return ["\n".join(c) for c in chunks if c]


async def _extract_chunk(
    *,
    llm: LLMClient,
    model: str,
    chunk_md: str,
    doc_summary_short: str,
    temperature: float,
) -> list[TocNode]:
    parts = PromptParts(
        static_system=_STATIC_SYSTEM,
        static_instructions=_STATIC_INSTRUCTIONS,
        static_schema=_STATIC_SCHEMA,
        static_examples=_STATIC_EXAMPLES,
        semi_static_doc_ctx=f"Document context: {doc_summary_short}",
        dynamic_payload=f"Pages chunk:\n\n{chunk_md}",
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
    except json.JSONDecodeError:
        log.warning("index_extractor.json_invalid", text=result.text[:200])
        return []
    return [
        TocNode(
            title=str(h["title"]).strip(),
            depth=int(h.get("depth", 1)),
            page_start=int(h["page_start"]),
        )
        for h in data.get("headings", [])
    ]


async def extract_index(
    *,
    llm: LLMClient,
    model: str,
    markdown: str,
    doc_summary_short: str,
    chunk_size_pages: int = 10,
    temperature: float = 0.0,
    max_concurrency: int = 5,
) -> list[TocNode]:
    """Devuelve [TocNode] inferidos page-by-page. Calls paralelos con cap."""
    chunks = _chunk_by_pages(markdown, chunk_size_pages)
    sem = asyncio.Semaphore(max_concurrency)

    async def _bounded(chunk_md: str) -> list[TocNode]:
        async with sem:
            return await _extract_chunk(
                llm=llm, model=model, chunk_md=chunk_md,
                doc_summary_short=doc_summary_short, temperature=temperature,
            )

    results = await asyncio.gather(*[_bounded(c) for c in chunks])
    flat: list[TocNode] = [n for sub in results for n in sub]
    flat.sort(key=lambda n: n.page_start)
    return flat
