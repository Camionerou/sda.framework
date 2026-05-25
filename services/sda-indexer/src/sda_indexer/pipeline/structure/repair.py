"""LLM-driven repair de [TocNode] que falló el validator.

Loop cap = 2 iteraciones (spec §5.4). Si después de 2 sigue inválido,
raise RepairLoopExhausted → caller maps a failure_reason='structure_unreparable'.
"""

import json
from dataclasses import asdict

import structlog

from ...llm.cache_design import PromptParts, system_user_split
from ...llm.client import LLMClient
from .types import TocNode
from .validator import validate_tree

log = structlog.get_logger()


class RepairLoopExhausted(Exception):
    """Después de max_iterations el tree sigue inválido. DLQ."""


_STATIC_SYSTEM = (
    "You are SDA-Indexer, a structure repair assistant. Fix issues in a "
    "JSON list of TOC nodes so it passes downstream validation."
)

_STATIC_INSTRUCTIONS = """\
Task: receive a list of TOC nodes + validator errors + suggestions.
Output a fixed list of nodes that resolves the errors.

Rules:
- Preserve original titles when possible (only edit for clarity).
- Adjust depth to fix depth-jump errors.
- Reorder if page_start is out of sequence.
- Truncate page_start to [1, total_pages] range when out of bounds.
- Drop nodes that are obviously bogus (empty title + out-of-range page).
- Output JSON object {"nodes": [...]}."""

_STATIC_SCHEMA = """\
JSON schema:
{"nodes": [{"title": string, "depth": int, "page_start": int}]}"""

_STATIC_EXAMPLES = """\
Example input nodes: [{"title": "A", "depth": 1, "page_start": 1},
                       {"title": "B", "depth": 3, "page_start": 2}]
Errors: ["node[1] depth jump from 1 to 3"]
Example fixed: {"nodes": [{"title": "A", "depth": 1, "page_start": 1},
                            {"title": "B", "depth": 2, "page_start": 2}]}"""


async def _llm_repair_once(
    *,
    llm: LLMClient,
    model: str,
    nodes: list[TocNode],
    errors: list[str],
    suggestions: list[str],
    total_pages: int,
    doc_summary_short: str,
    temperature: float,
) -> list[TocNode]:
    payload = json.dumps({
        "current_nodes": [asdict(n) for n in nodes],
        "errors": errors,
        "suggestions": suggestions,
        "total_pages": total_pages,
    }, indent=2)
    parts = PromptParts(
        static_system=_STATIC_SYSTEM,
        static_instructions=_STATIC_INSTRUCTIONS,
        static_schema=_STATIC_SCHEMA,
        static_examples=_STATIC_EXAMPLES,
        semi_static_doc_ctx=f"Document context: {doc_summary_short}",
        dynamic_payload=f"Repair input:\n\n{payload}",
    )
    system, user = system_user_split(parts)
    result = await llm.complete(
        model=model, system=system, user=user,
        temperature=temperature, max_tokens=4096,
        response_format={"type": "json_object"},
    )
    data = json.loads(result.text)
    return [
        TocNode(
            title=str(n["title"]).strip(),
            depth=int(n["depth"]),
            page_start=int(n["page_start"]),
        )
        for n in data.get("nodes", [])
    ]


async def repair_tree(
    *,
    llm: LLMClient,
    model: str,
    nodes: list[TocNode],
    total_pages: int,
    max_depth: int,
    doc_summary_short: str,
    max_iterations: int = 2,
    temperature: float = 0.0,
) -> tuple[list[TocNode], int]:
    """Repair loop: valida → llama LLM → re-valida. Hasta max_iterations.

    Returns:
        (fixed_nodes, iterations_taken)
    Raises:
        RepairLoopExhausted: después de max_iterations sigue inválido.
    """
    current = nodes
    for i in range(1, max_iterations + 1):
        v = validate_tree(current, total_pages=total_pages, max_depth=max_depth)
        if v.ok:
            log.info("repair.converged", iteration=i)
            return current, i
        log.info(
            "repair.iter", iteration=i, errors_count=len(v.errors),
            sample_error=v.errors[0] if v.errors else None,
        )
        current = await _llm_repair_once(
            llm=llm, model=model, nodes=current,
            errors=v.errors, suggestions=v.suggestions,
            total_pages=total_pages,
            doc_summary_short=doc_summary_short,
            temperature=temperature,
        )

    final = validate_tree(current, total_pages=total_pages, max_depth=max_depth)
    if final.ok:
        return current, max_iterations
    raise RepairLoopExhausted(
        f"Tree still invalid after {max_iterations} iterations. "
        f"Remaining errors: {final.errors[:3]}"
    )
