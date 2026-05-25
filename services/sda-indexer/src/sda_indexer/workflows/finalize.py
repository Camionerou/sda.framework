"""LangGraph workflow para finalize. Verifica que todos los nodos están ready,
calcula costo agregado, marca documents.status='ready'. Wave 0: sin
doc_description, sin quality_metrics propios (Wave 2)."""

from typing import TypedDict
import structlog
from langgraph.graph import StateGraph, START, END
from ..db.client import DB
from ..db import documents as docs_db

log = structlog.get_logger()


class State(TypedDict, total=False):
    document_id: str
    node_count: int
    total_cost_cents: float


def build_graph(db: DB):

    async def verify_all_ready(s: State) -> dict:
        async with db.pool.acquire() as conn:
            row = await conn.fetchrow(
                """select count(*) filter (where status='ready') as ready,
                          count(*) as total
                     from tree_nodes where document_id=$1""",
                s["document_id"],
            )
        if row["total"] == 0 or row["ready"] != row["total"]:
            raise RuntimeError(
                f"finalize called but not all nodes ready: "
                f"{row['ready']}/{row['total']}"
            )
        return {"node_count": row["total"]}

    async def aggregate_cost(s: State) -> dict:
        async with db.pool.acquire() as conn:
            cost = await conn.fetchval(
                "select coalesce(sum(cost_cents), 0) from llm_calls where document_id=$1",
                s["document_id"],
            )
        return {"total_cost_cents": float(cost or 0)}

    async def mark_ready(s: State) -> dict:
        await docs_db.mark_ready_meta(
            db.pool, s["document_id"],
            node_count=s["node_count"],
            page_count=None,
            path_used="full",       # Wave 0 sólo MD path; Wave 1 inyecta real path_used
            doc_description=None,
            total_cost_cents=s["total_cost_cents"],
        )
        log.info("finalize.complete",
                 document_id=s["document_id"],
                 node_count=s["node_count"],
                 cost_cents=s["total_cost_cents"])
        return {}

    g = StateGraph(State)
    g.add_node("verify", verify_all_ready)
    g.add_node("cost", aggregate_cost)
    g.add_node("mark", mark_ready)
    g.add_edge(START, "verify")
    g.add_edge("verify", "cost")
    g.add_edge("cost", "mark")
    g.add_edge("mark", END)
    return g.compile()


async def run_finalize(graph, *, document_id: str) -> dict:
    final = await graph.ainvoke({"document_id": document_id})
    return {
        "status": "ready",
        "node_count": final.get("node_count", 0),
        "total_cost_cents": final.get("total_cost_cents", 0),
    }
