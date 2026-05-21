from __future__ import annotations

from typing import Any

from ..events import emit_tree_node_event
from ..state import TreeState


async def degrade_mode(state: TreeState) -> dict[str, Any]:
    await emit_tree_node_event(
        state,
        message="Degradando extraccion a modo no_toc.",
        node="degrade_mode",
        progress=68,
        status="completed",
    )
    return {
        "candidate_sections": [],
        "invalid_sections": [],
        "metrics": {
            **state["metrics"],
            "degrade_attempts": state["metrics"].get("degrade_attempts", 0) + 1,
            "repair_attempts": 0,
            "tree_mode": "no_toc",
        },
        "repair_attempts": 0,
        "tree_mode": "no_toc",
        "verified_sections": [],
    }


def fail_verification(state: TreeState) -> dict[str, Any]:
    accuracy = state["metrics"].get("verification_accuracy")
    invalid_count = len(state.get("invalid_sections", []))
    raise RuntimeError(
        f"Tree verifier rechazo la estructura candidata: accuracy {accuracy}, "
        f"invalid_sections {invalid_count}."
    )
