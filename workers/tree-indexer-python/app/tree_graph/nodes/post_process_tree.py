from __future__ import annotations

from typing import Any

from ...pageindex_style import candidate_sections_to_tree, flatten_tree
from ..events import emit_tree_node_event
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
    await emit_tree_node_event(
        state,
        message=f"Arbol normalizado con {len(flatten_tree(tree))} nodos.",
        metadata={"tree_node_count": len(flatten_tree(tree))},
        node="post_process_tree",
        progress=72,
        status="completed",
    )
    return {
        "tree": tree
    }
