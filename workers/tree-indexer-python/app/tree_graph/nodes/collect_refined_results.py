from __future__ import annotations

from typing import Any

from ..events import emit_tree_node_event
from ..helpers import compute_node_confidence, renumber_tree, visit_tree
from ..state import TreeState


async def collect_refined_results(state: TreeState) -> dict[str, Any]:
    refined_by_id = {
        r["node_id"]: r["subtree"]
        for r in state.get("refined_results", [])
        if r["subtree"]
    }
    tree = state["tree"]
    if refined_by_id:
        for node in visit_tree(tree):
            subtree = refined_by_id.get(node["node_id"])
            if subtree:
                node["nodes"] = subtree
                for child in visit_tree(subtree):
                    if "confidence" not in child:
                        child["confidence"] = compute_node_confidence(
                            node=child,
                            pages=state["raw_pages"],
                            source_blocks=state["source_blocks"],
                            verifier_says_valid=True,
                        )
        renumber_tree(tree)

    iteration = state.get("refinement_iteration", 0) + 1
    refined_count = len(refined_by_id)

    await emit_tree_node_event(
        state,
        message=f"Refinamiento completo: {refined_count} nodos refinados.",
        metadata={
            "refined_node_count": refined_count,
            "refinement_iteration": iteration,
        },
        node="collect_refined_results",
        progress=78,
        status="completed",
    )

    return {
        "metrics": {
            **state["metrics"],
            "last_refined_node_count": refined_count,
            "refinement_iteration": iteration,
            "refined_node_count": state["metrics"].get("refined_node_count", 0) + refined_count,
        },
        "refined_results": [],  # reset reducer para proxima iteracion
        "refinement_iteration": iteration,
        "tree": tree,
    }
