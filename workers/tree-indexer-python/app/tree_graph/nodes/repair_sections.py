from __future__ import annotations

from typing import Any

from ...llm import call_tree_llm_json
from ...pageindex_style import CandidateSection
from ...prompts import repair_sections_prompt
from ..events import emit_tree_node_event
from ..helpers import assert_sections as _assert_sections, ordered_unique_sections
from ..state import TreeState


async def repair_sections(state: TreeState) -> dict[str, Any]:
    await emit_tree_node_event(
        state,
        message="Reparando secciones invalidas.",
        metadata={"invalid_section_count": len(state.get("invalid_sections", []))},
        node="repair_sections",
        progress=64,
        status="started",
    )
    response = await call_tree_llm_json(
        repair_sections_prompt(
            state["document_title"],
            state["document_type"],
            state["verified_sections"],
            state["invalid_sections"],
            state["prompt_pages"],
        ),
        "structure",
    )
    repaired = _assert_sections(response["json"])
    candidate_sections = ordered_unique_sections([*state["verified_sections"], *repaired])
    if not candidate_sections:
        raise RuntimeError("Tree repair no devolvio secciones recuperables.")
    await emit_tree_node_event(
        state,
        message=f"Reparacion genero {len(repaired)} secciones candidatas.",
        metadata={"repair_section_count": len(repaired)},
        node="repair_sections",
        progress=66,
        status="completed",
    )
    return {
        "candidate_sections": candidate_sections,
        "invalid_sections": [],
        "metrics": {
            **state["metrics"],
            "candidate_section_count": len(candidate_sections),
            "repair_attempts": state.get("repair_attempts", 0) + 1,
            "repair_section_count": len(repaired),
        },
        "repair_attempts": state.get("repair_attempts", 0) + 1,
        "verified_sections": [],
    }
