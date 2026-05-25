"""POST /index/structure — dispara structure_workflow para un documento."""

from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel
from ..workflows.structure import run_structure

router = APIRouter()


class StructureIn(BaseModel):
    document_id: str
    idempotency_key: str | None = None
    trace_id: str | None = None


class StructureOut(BaseModel):
    node_count: int
    aborted: bool
    document_id: str


@router.post("/index/structure", response_model=StructureOut)
async def structure(payload: StructureIn, request: Request) -> StructureOut:
    graph = request.app.state.structure_graph
    try:
        result = await run_structure(graph, document_id=payload.document_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return StructureOut(
        node_count=result["node_count"],
        aborted=result["aborted"],
        document_id=payload.document_id,
    )
