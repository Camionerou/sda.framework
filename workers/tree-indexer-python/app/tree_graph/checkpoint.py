from __future__ import annotations

import os
from typing import Any


def checkpoint_dsn() -> str | None:
    return (
        os.getenv("SDA_TREE_CHECKPOINT_DSN")
        or os.getenv("SDA_LANGGRAPH_CHECKPOINT_DSN")
        or os.getenv("SUPABASE_POOLER_URL")
        or os.getenv("DATABASE_URL")
    )


def checkpointing_enabled() -> bool:
    value = os.getenv("SDA_TREE_CHECKPOINTING")
    if value is not None and value != "":
        return value.lower() not in {"0", "false", "no", "off"}
    return bool(checkpoint_dsn())


def is_checkpointing_configured() -> bool:
    return bool(checkpoint_dsn() and checkpointing_enabled())


async def run_graph_with_optional_checkpoint(
    graph_builder,
    base_graph,
    initial_state,
    *,
    thread_id: str,
) -> dict[str, Any]:
    """`graph_builder` is `build_graph` callable, `base_graph` is the pre-built graph
    for the no-checkpoint path."""
    dsn = checkpoint_dsn()
    if not dsn or not checkpointing_enabled():
        return await base_graph.ainvoke(initial_state)

    try:
        from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
    except ImportError as error:
        raise RuntimeError(
            "SDA_TREE_CHECKPOINTING requiere instalar langgraph-checkpoint-postgres."
        ) from error

    async with AsyncPostgresSaver.from_conn_string(dsn) as checkpointer:
        if os.getenv("SDA_TREE_CHECKPOINT_SETUP") == "1":
            await checkpointer.setup()
        graph = graph_builder(checkpointer=checkpointer)
        return await graph.ainvoke(
            initial_state,
            config={"configurable": {"thread_id": thread_id}},
        )
