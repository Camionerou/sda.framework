from __future__ import annotations

from typing import Any

from ...llm import call_tree_llm_text
from ...prompts import doc_summary_prompt
from ..helpers import visit_tree
from ..state import TreeState


async def collect_summaries(state: TreeState) -> dict[str, Any]:
    by_node_id = {
        result["node_id"]: result["text"]
        for result in state.get("summary_results", [])
    }
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
