from __future__ import annotations

from langgraph.types import Send

from .config import (
    degrade_attempt_limit,
    refine_iteration_limit,
    repair_attempt_limit,
)
from .events import context_for_send
from .helpers import node_task
from .nodes.refine_large_nodes import flatten_tree  # re-exported from pageindex_style
from .state import TreeState


def route_after_verify(state: TreeState) -> str:
    accuracy = float(state["metrics"].get("verification_accuracy") or 0)
    degrade_attempts = int(state["metrics"].get("degrade_attempts") or 0)
    invalid_count = len(state.get("invalid_sections", []))
    can_degrade = state["tree_mode"] != "no_toc" and degrade_attempts < degrade_attempt_limit()
    if accuracy >= 0.95 or invalid_count == 0:
        return "post_process_tree"
    if accuracy >= 0.6 and state.get("repair_attempts", 0) < repair_attempt_limit():
        return "repair_sections"
    if can_degrade and state.get("repair_attempts", 0) >= repair_attempt_limit():
        return "degrade_mode"
    if can_degrade and accuracy < 0.6:
        return "degrade_mode"
    return "fail_verification"


def route_after_refine(state: TreeState) -> str:
    refined = int(state["metrics"].get("last_refined_node_count") or 0)
    iteration = int(state.get("refinement_iteration", 0))
    if refined > 0 and iteration < refine_iteration_limit():
        return "refine_large_nodes"
    return "prepare_summaries"


def fan_out_summaries(state: TreeState) -> list[Send]:
    context = context_for_send(state)
    return [
        Send("summarize_one_node", {**context, "summary_target": node_task(node, path)})
        for node, path in flatten_tree(state["tree"])
    ]


def fan_out_routing_summaries(state: TreeState) -> list[Send]:
    context = context_for_send(state)
    return [
        Send("summarize_one_routing", {**context, "routing_target": node_task(node, path)})
        for node, path in flatten_tree(state["tree"])
    ]
