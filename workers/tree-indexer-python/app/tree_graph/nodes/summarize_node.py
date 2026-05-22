from __future__ import annotations

from typing import Any

from ...llm import call_tree_llm_text
from ...prompts import summary_prompt
from ..events import emit_tree_node_event
from ..helpers import node_from_task
from ..state import TreeState


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
