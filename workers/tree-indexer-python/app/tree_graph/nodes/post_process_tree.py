from __future__ import annotations

from typing import Any

from ...pageindex_style import candidate_sections_to_tree, flatten_tree
from ..events import emit_tree_node_event
from ..helpers import compute_node_confidence, visit_tree
from ..state import TreeState


async def post_process_tree(state: TreeState) -> dict[str, Any]:
    await emit_tree_node_event(
        state,
        message="Normalizando arbol verificado.",
        node="post_process_tree",
        progress=70,
        status="started",
    )
    tree = candidate_sections_to_tree(
        state["verified_sections"],
        state["raw_pages"],
        state["source_blocks"],
    )
    for node in visit_tree(tree):
        node["confidence"] = compute_node_confidence(
            node=node,
            pages=state["raw_pages"],
            source_blocks=state["source_blocks"],
            verifier_says_valid=True,
        )
    flat_nodes = flatten_tree(tree)
    await emit_tree_node_event(
        state,
        message=f"Arbol normalizado con {len(flat_nodes)} nodos.",
        metadata={"tree_node_count": len(flat_nodes)},
        node="post_process_tree",
        progress=72,
        status="completed",
    )
    return {
        "tree": tree
    }
