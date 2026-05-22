from __future__ import annotations

from typing import Any

from ...llm import call_tree_llm_json
from ...pageindex_style import (
    LabeledPage,
    candidate_sections_to_tree,
    flatten_tree,
    tagged_pages_text,
)
from ...prompts import candidate_prompt, verification_prompt
from ..events import emit_tree_node_event
from ..helpers import assert_sections, shift_tree_pages
from ..state import TreeState


async def refine_one_node(state: TreeState) -> dict[str, Any]:
    node_id = state["refine_target_node_id"]
    sub_pages: list[LabeledPage] = state["refine_target_pages"]
    start_index = state["refine_target_start_index"]

    title = "(unknown)"
    for node, _path in flatten_tree(state.get("tree", [])):
        if node["node_id"] == node_id:
            title = node["title"]
            break

    await emit_tree_node_event(
        state,
        message=f"Refinando nodo {node_id}.",
        metadata={"node_id": node_id, "page_count": len(sub_pages)},
        node="refine_one_node",
        progress=75,
        status="started",
    )

    if len(sub_pages) <= 1:
        return {"refined_results": [{"node_id": node_id, "subtree": None}]}

    response = await call_tree_llm_json(
        candidate_prompt(
            title,
            state.get("document_type", "other"),
            tagged_pages_text(sub_pages),
            None,
            "refine",
        ),
        "structure",
    )
    candidate_sections = assert_sections(response["json"])
    if len(candidate_sections) <= 1:
        return {"refined_results": [{"node_id": node_id, "subtree": None}]}

    verification = await call_tree_llm_json(
        verification_prompt(candidate_sections, sub_pages),
        "structure",
    )
    verified = [
        section
        for section in assert_sections(verification["json"])
        if section.get("valid") is not False
    ]
    if len(verified) <= 1 or len(verified) / len(candidate_sections) < 0.6:
        return {"refined_results": [{"node_id": node_id, "subtree": None}]}

    subtree = candidate_sections_to_tree(verified, sub_pages)
    if len(flatten_tree(subtree)) <= 1:
        return {"refined_results": [{"node_id": node_id, "subtree": None}]}

    shifted = shift_tree_pages(subtree, start_index - 1)
    return {"refined_results": [{"node_id": node_id, "subtree": shifted}]}
