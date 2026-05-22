from __future__ import annotations

import os
from typing import Any

from ...cache import get_cached, set_cached, summary_cache_key
from ...llm import call_tree_llm_text
from ...prompts import summary_prompt
from ...versions import TREE_PROMPT_VERSION
from ..events import emit_tree_node_event
from ..helpers import node_from_task
from ..state import TreeState


async def summarize_one_node(state: TreeState) -> dict[str, Any]:
    target = state["summary_target"]
    text = target.get("text", "")
    title = target.get("title", "")
    model = os.getenv("SDA_TREE_SUMMARY_MODEL", os.getenv("SDA_TREE_LLM_MODEL", ""))
    key = summary_cache_key(
        text=text,
        title=title,
        page_start=target["start_index"],
        page_end=target["end_index"],
        summary_model=model,
        tree_prompt_version=TREE_PROMPT_VERSION,
    )

    cached = await get_cached(key)
    if cached:
        await emit_tree_node_event(
            state,
            message=f"Resumen cache hit para nodo {target['node_id']}.",
            metadata={"node_id": target["node_id"], "cache": "hit"},
            node="summarize_one_node",
            progress=80,
            status="completed",
        )
        return {
            "summary_results": [{"node_id": target["node_id"], "text": cached}],
            "summary_cache_hits": 1,
        }

    await emit_tree_node_event(
        state,
        message=f"Resumiendo nodo {target['node_id']}.",
        metadata={"node_id": target["node_id"], "title": title},
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
    await set_cached(key, summary)
    return {
        "summary_results": [{"node_id": target["node_id"], "text": summary}],
        "summary_cache_misses": 1,
    }
