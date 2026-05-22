from __future__ import annotations

from typing import Any

from ...llm import call_tree_llm_json
from ...pageindex_style import CandidateSection
from ...prompts import verification_prompt
from ..events import emit_tree_node_event
from ..helpers import assert_sections as _assert_sections, section_identity
from ..state import TreeState


async def verify_tree(state: TreeState) -> dict[str, Any]:
    await emit_tree_node_event(
        state,
        message="Verificando arbol candidato.",
        node="verify_tree",
        progress=58,
        status="started",
    )
    response = await call_tree_llm_json(
        verification_prompt(state["candidate_sections"], state["prompt_pages"]),
        "structure",
    )
    checked_sections = _assert_sections(response["json"])
    verified = [
        section
        for section in checked_sections
        if section.get("valid") is not False
    ]
    invalid = [
        section
        for section in checked_sections
        if section.get("valid") is False
    ]
    checked_identities = {section_identity(section) for section in checked_sections}
    invalid.extend(
        {
            **section,
            "reason": "Verifier omitted this candidate section.",
            "valid": False,
        }
        for section in state["candidate_sections"]
        if section_identity(section) not in checked_identities
    )
    accuracy = len(verified) / len(state["candidate_sections"])
    await emit_tree_node_event(
        state,
        message=f"Verificacion completada con accuracy {accuracy:.2f}.",
        metadata={
            "invalid_section_count": len(invalid),
            "verification_accuracy": accuracy,
            "verified_section_count": len(verified),
        },
        node="verify_tree",
        progress=62,
        status="completed",
    )
    return {
        "invalid_sections": invalid,
        "metrics": {
            **state["metrics"],
            "invalid_section_count": len(invalid),
            "verification_accuracy": accuracy,
            "verified_section_count": len(verified),
        },
        "verified_sections": verified,
    }
