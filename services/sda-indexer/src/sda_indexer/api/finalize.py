"""POST /index/finalize — dispara finalize_workflow."""

from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel
from ..workflows.finalize import run_finalize

router = APIRouter()


class FinalizeIn(BaseModel):
    document_id: str
    idempotency_key: str | None = None


class FinalizeOut(BaseModel):
    document_id: str
    status: str
    node_count: int
    total_cost_cents: float


@router.post("/index/finalize", response_model=FinalizeOut)
async def finalize(payload: FinalizeIn, request: Request) -> FinalizeOut:
    graph = request.app.state.finalize_graph
    try:
        result = await run_finalize(graph, document_id=payload.document_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return FinalizeOut(
        document_id=payload.document_id,
        status=result["status"],
        node_count=result["node_count"],
        total_cost_cents=result["total_cost_cents"],
    )
