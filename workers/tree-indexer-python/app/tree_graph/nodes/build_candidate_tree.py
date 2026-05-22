from __future__ import annotations

from typing import Any

from ...llm import call_tree_llm_json
from ...pageindex_style import CandidateSection, split_pages_for_prompt, tagged_pages_text
from ...prompts import candidate_prompt
from ...versions import TREE_INDEXER_PYTHON_VERSION
from ..config import max_prompt_chars
from ..events import emit_tree_node_event
from ..helpers import assert_sections as _assert_sections
from ..state import TreeState

TREE_INDEXER_VERSION = TREE_INDEXER_PYTHON_VERSION


async def build_candidate_tree(state: TreeState) -> dict[str, Any]:
    await emit_tree_node_event(
        state,
        message="Construyendo arbol candidato.",
        metadata={"tree_mode": state.get("tree_mode", "toc")},
        node="build_candidate_tree",
        progress=50,
        status="started",
    )
    groups = split_pages_for_prompt(state["prompt_pages"], max_prompt_chars())
    sections: list[CandidateSection] = []
    model: str | None = None
    provider: str | None = None
    provider_order: list[str] = []
    service_tier: str | None = None

    for group in groups:
        response = await call_tree_llm_json(
            candidate_prompt(
                state["document_title"],
                state["document_type"],
                tagged_pages_text(group),
                sections if sections else None,
                state.get("tree_mode", "toc"),
            ),
            "structure",
        )
        sections.extend(_assert_sections(response["json"]))
        model = response["model"]
        provider = response["provider"]
        provider_order = response.get("provider_order") or []
        service_tier = response.get("service_tier")

    if not sections:
        raise RuntimeError("Tree LLM no encontro secciones para construir el arbol.")

    metrics = {
        **state["metrics"],
        "candidate_section_count": len(sections),
        "llm_model": model,
        "llm_provider": provider,
        "llm_provider_order": provider_order,
        "llm_service_tier": service_tier,
    }
    await emit_tree_node_event(
        state,
        message=f"Arbol candidato generado con {len(sections)} secciones.",
        metadata={"candidate_section_count": len(sections)},
        node="build_candidate_tree",
        progress=55,
        status="completed",
    )
    return {
        "candidate_sections": sections,
        "metrics": metrics,
        "provider": provider or "",
        "version": TREE_INDEXER_VERSION,
    }
