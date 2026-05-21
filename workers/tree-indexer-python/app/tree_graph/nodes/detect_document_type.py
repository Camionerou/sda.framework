from __future__ import annotations

from typing import Any

from ...llm import call_tree_llm_json
from ...pageindex_style import tagged_pages_text
from ...prompts import DOCUMENT_TYPES, document_type_prompt
from ..events import emit_tree_node_event
from ..state import TreeState


def _assert_document_type(value: Any) -> str:
    raw_type = value.get("type") if isinstance(value, dict) else None
    document_type = raw_type.strip().lower() if isinstance(raw_type, str) else ""
    return document_type if document_type in DOCUMENT_TYPES else "other"


async def detect_document_type(state: TreeState) -> dict[str, Any]:
    await emit_tree_node_event(
        state,
        message="Detectando tipo documental.",
        node="detect_document_type",
        progress=46,
        status="started",
    )
    response = await call_tree_llm_json(
        document_type_prompt(
            state["document_title"],
            tagged_pages_text(state["prompt_pages"][:3]),
        ),
        "summary",
    )
    document_type = _assert_document_type(response["json"])
    await emit_tree_node_event(
        state,
        message=f"Tipo documental detectado: {document_type}.",
        metadata={"document_type": document_type},
        node="detect_document_type",
        progress=48,
        status="completed",
    )
    return {
        "document_type": document_type,
        "metrics": {
            **state["metrics"],
            "document_type": document_type,
            "document_type_model": response["model"],
            "document_type_provider": response["provider"],
        },
    }
