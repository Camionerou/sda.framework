from __future__ import annotations

from typing import Any

from ...embeddings import embed_chunks
from ..events import emit_tree_node_event
from ..state import TreeState


async def embed_hierarchy(state: TreeState) -> dict[str, Any]:
    await emit_tree_node_event(
        state,
        message="Generando embeddings jerarquicos.",
        metadata={"chunk_count": len(state["chunks"])},
        node="embed_hierarchy",
        progress=92,
        status="started",
    )
    embedded_chunks, config = await embed_chunks(
        state["chunks"],
        document_type=state["document_type"],
    )
    await emit_tree_node_event(
        state,
        message=f"Embeddings jerarquicos listos: {len(embedded_chunks)} vectores.",
        metadata={
            "embedding_count": len(embedded_chunks),
            "embedding_dimension": config.dimensions,
            "embedding_model": config.model,
            "embedding_provider": config.provider,
        },
        node="embed_hierarchy",
        progress=96,
        status="completed",
    )
    return {
        "chunks": embedded_chunks,
        "metrics": {
            **state["metrics"],
            "embedding_count": len(embedded_chunks),
            "embedding_dimension": config.dimensions,
            "embedding_model": config.model,
            "embedding_provider": config.provider,
        },
    }
