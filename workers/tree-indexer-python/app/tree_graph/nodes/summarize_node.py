from __future__ import annotations

from typing import Any

from ...llm import call_tree_llm_text
from ...pageindex_style import flatten_tree
from ...prompts import doc_summary_prompt, summary_prompt
from ..events import emit_tree_node_event
from ..helpers import node_from_task, visit_tree
from ..state import TreeState


def prepare_summaries(state: TreeState) -> dict[str, Any]:
    return {
        "metrics": {
            **state["metrics"],
            "tree_node_count": len(flatten_tree(state["tree"])),
        }
    }


async def summarize_one_node(state: TreeState) -> dict[str, Any]:
    target = state["summary_target"]
    await emit_tree_node_event(
        state,
        message=f"Resumiendo nodo {target['node_id']}.",
        metadata={"node_id": target["node_id"], "title": target["title"]},
        node="summarize_one_node",
        progress=80,
        status="started",
    )
    response = await call_tree_llm_text(summary_prompt(node_from_task(target)), "summary")
    summary = response["content"].strip()
    await emit_tree_node_event(
        state,
        message=f"Resumen de nodo {target['node_id']} listo.",
        metadata={"node_id": target["node_id"]},
        node="summarize_one_node",
        progress=82,
        status="completed",
    )
    return {"summary_results": [{"node_id": target["node_id"], "text": summary}]}


async def collect_summaries(state: TreeState) -> dict[str, Any]:
    by_node_id = {result["node_id"]: result["text"] for result in state.get("summary_results", [])}
    for node in visit_tree(state["tree"]):
        if summary := by_node_id.get(node["node_id"]):
            node["summary"] = summary
    doc_summary = (
        await call_tree_llm_text(doc_summary_prompt(state["tree"]), "summary")
    )["content"].strip()
    return {
        "doc_summary": doc_summary,
        "metrics": {**state["metrics"], "summary_node_count": len(by_node_id)},
    }
