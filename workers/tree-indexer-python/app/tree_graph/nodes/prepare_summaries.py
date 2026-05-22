from __future__ import annotations

from typing import Any

from ..helpers import visit_tree
from ..state import TreeState


def prepare_summaries(state: TreeState) -> dict[str, Any]:
    return {
        "metrics": {
            **state["metrics"],
            "tree_node_count": len(visit_tree(state["tree"])),
        }
    }
