"""POST /index/summarize — dispara summarize_workflow para un nodo."""

from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel
from ..workflows.summarize import run_summarize

router = APIRouter()


class SummarizeIn(BaseModel):
    node_id: str
    document_id: str
    idempotency_key: str | None = None


class SummarizeOut(BaseModel):
    node_id: str
    summary: str
    model: str
    tokens_in: int
    tokens_out: int
    cached_tokens: int


@router.post("/index/summarize", response_model=SummarizeOut)
async def summarize(payload: SummarizeIn, request: Request) -> SummarizeOut:
    graph = request.app.state.summarize_graph
    try:
        result = await run_summarize(
            graph, node_id=payload.node_id, document_id=payload.document_id,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return SummarizeOut(
        node_id=payload.node_id,
        summary=result["summary"],
        model=result["selected_model"],
        tokens_in=result["tokens_in"],
        tokens_out=result["tokens_out"],
        cached_tokens=result["cached_tokens"],
    )
