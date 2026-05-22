from __future__ import annotations

from typing import Any

from ...llm import call_tree_llm_json
from ...pageindex_style import (
    CandidateSection,
    LabeledPage,
    TreeNode,
    candidate_sections_to_tree,
    flatten_tree,
    tagged_pages_text,
)
from ...prompts import candidate_prompt, verification_prompt
from ..config import refine_max_pages, refine_max_tokens
from ..events import emit_tree_node_event
from ..helpers import (
    assert_sections as _assert_sections,
    is_large_leaf,
    renumber_tree,
    shift_tree_pages,
    sub_pages_for_node,
    visit_tree,
)
from ..state import TreeState


async def _refined_subtree_for_node(state: TreeState, node: TreeNode) -> list[TreeNode] | None:
    sub_pages = sub_pages_for_node(node, state["prompt_pages"])
    if len(sub_pages) <= 1:
        return None

    response = await call_tree_llm_json(
        candidate_prompt(
            node["title"],
            state["document_type"],
            tagged_pages_text(sub_pages),
            None,
            "refine",
        ),
        "structure",
    )
    candidate_sections = _assert_sections(response["json"])
    if len(candidate_sections) <= 1:
        return None

    verification = await call_tree_llm_json(
        verification_prompt(candidate_sections, sub_pages),
        "structure",
    )
    verified = [
        section
        for section in _assert_sections(verification["json"])
        if section.get("valid") is not False
    ]
    if len(verified) <= 1 or len(verified) / len(candidate_sections) < 0.6:
        return None

    subtree = candidate_sections_to_tree(verified, sub_pages)
    if len(flatten_tree(subtree)) <= 1:
        return None

    return shift_tree_pages(subtree, node["start_index"] - 1)


async def refine_large_nodes(state: TreeState) -> dict[str, Any]:
    await emit_tree_node_event(
        state,
        message="Buscando nodos grandes para refinamiento recursivo.",
        node="refine_large_nodes",
        progress=74,
        status="started",
    )
    max_pages = refine_max_pages()
    max_tokens = refine_max_tokens()
    refined_count = 0
    tree = state["tree"]
    candidates = [
        node for node in visit_tree(tree)
        if is_large_leaf(node, max_pages=max_pages, max_tokens=max_tokens)
    ]

    for node in candidates:
        subtree = await _refined_subtree_for_node(state, node)
        if not subtree:
            continue
        node["nodes"] = subtree
        refined_count += 1

    if refined_count:
        renumber_tree(tree)

    iteration = state.get("refinement_iteration", 0) + 1
    await emit_tree_node_event(
        state,
        message=f"Refinamiento completo: {refined_count} nodos refinados.",
        metadata={
            "large_node_count": len(candidates),
            "refined_node_count": refined_count,
            "refinement_iteration": iteration,
        },
        node="refine_large_nodes",
        progress=76,
        status="completed",
    )
    return {
        "metrics": {
            **state["metrics"],
            "last_refined_node_count": refined_count,
            "refinement_iteration": iteration,
            "refined_node_count": state["metrics"].get("refined_node_count", 0) + refined_count,
        },
        "refinement_iteration": iteration,
        "tree": tree,
    }
