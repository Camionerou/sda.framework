from __future__ import annotations

from typing import Any

from ...llm import call_tree_llm_text
from ...pageindex_style import build_chunks_from_tree
from ...prompts import routing_summary_prompt
from ..events import emit_tree_node_event
from ..helpers import node_from_task, visit_tree
from ..state import TreeState


async def summarize_one_routing(state: TreeState) -> dict[str, Any]:
    target = state["routing_target"]
    await emit_tree_node_event(
        state,
        message=f"Generando routing summary para nodo {target['node_id']}.",
        metadata={"node_id": target["node_id"], "title": target["title"]},
        node="summarize_one_routing",
        progress=86,
        status="started",
    )
    response = await call_tree_llm_text(
        routing_summary_prompt(node_from_task(target), target["path"], state["document_type"]),
        "summary",
    )
    routing_summary = response["content"].strip()
    await emit_tree_node_event(
        state,
        message=f"Routing summary de nodo {target['node_id']} listo.",
        metadata={"node_id": target["node_id"]},
        node="summarize_one_routing",
        progress=88,
        status="completed",
    )
    return {"routing_summary_results": [{"node_id": target["node_id"], "text": routing_summary}]}


def collect_routing_summaries(state: TreeState) -> dict[str, Any]:
    by_node_id = {
        result["node_id"]: result["text"]
        for result in state.get("routing_summary_results", [])
    }
    for node in visit_tree(state["tree"]):
        if routing_summary := by_node_id.get(node["node_id"]):
            node["routing_summary"] = routing_summary
    chunks = build_chunks_from_tree(state["tree"], document_type=state["document_type"])
    root_routing = "\n".join(
        node.get("routing_summary", "").strip()
        for node in state["tree"]
        if node.get("routing_summary", "").strip()
    )
    return {
        "chunks": chunks,
        "metrics": {
            **state["metrics"],
            "chunk_count": len(chunks),
            "routing_summary_node_count": len(by_node_id),
        },
        "routing_summary": root_routing,
    }
