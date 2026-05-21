from __future__ import annotations

from typing import Any

from ..events import publish_inngest_event
from .state import TreeState


def graph_event_base(state: TreeState) -> dict[str, Any] | None:
    tenant_id = state.get("tenant_id")
    document_id = state.get("document_id")
    run_id = state.get("run_id")
    job_id = state.get("job_id")
    if not all(isinstance(value, str) and value for value in [tenant_id, document_id, run_id, job_id]):
        return None
    return {
        "document_id": document_id,
        "job_id": job_id,
        "run_id": run_id,
        "tenant_id": tenant_id,
    }


def context_for_send(state: TreeState) -> dict[str, str]:
    return {
        "document_id": state.get("document_id", ""),
        "document_title": state.get("document_title", ""),
        "document_type": state.get("document_type", "other"),
        "job_id": state.get("job_id", ""),
        "run_id": state.get("run_id", ""),
        "tenant_id": state.get("tenant_id", ""),
    }


async def emit_tree_node_event(
    state: TreeState,
    *,
    message: str,
    metadata: dict[str, Any] | None = None,
    node: str,
    progress: int,
    status: str,
) -> None:
    base = graph_event_base(state)
    if not base:
        return
    await publish_inngest_event(
        "indexing/tree.node",
        {
            **base,
            "message": message,
            "metadata": metadata or {},
            "node": node,
            "progress": progress,
            "stage": "structuring",
            "status": status,
        },
    )
