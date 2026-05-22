from __future__ import annotations

from langgraph.types import Send

from .config import (
    degrade_attempt_limit,
    refine_iteration_limit,
    refine_max_pages,
    refine_max_tokens,
    repair_attempt_limit,
)
from .events import context_for_send
from .helpers import is_large_leaf, node_task, sub_pages_for_node, visit_tree
from ..pageindex_style import flatten_tree
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


def fan_out_refine_targets(state: TreeState) -> list[Send]:
    max_pages = refine_max_pages()
    max_tokens = refine_max_tokens()
    candidates = [
        node
        for node in visit_tree(state["tree"])
        if is_large_leaf(node, max_pages=max_pages, max_tokens=max_tokens)
    ]
    context = context_for_send(state)
    if not candidates:
        return [Send("collect_refined_results", context)]
    pages = state["prompt_pages"]
    return [
        Send(
            "refine_one_node",
            {
                **context,
                "refine_target_node_id": node["node_id"],
                "refine_target_pages": sub_pages_for_node(node, pages),
                "refine_target_start_index": node["start_index"],
                "refined_results": [],
                "tree": state["tree"],
            },
        )
        for node in candidates
    ]


def route_after_refine_collect(state: TreeState) -> str:
    last_refined = int(state["metrics"].get("last_refined_node_count") or 0)
    iteration = int(state.get("refinement_iteration", 0))
    if last_refined > 0 and iteration < refine_iteration_limit():
        return "select_refine_targets"
    return "prepare_summaries"
