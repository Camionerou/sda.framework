"""GET /health — chequeo de dependencias (DB, LLM client reachable)."""

from fastapi import APIRouter, Request

router = APIRouter()


@router.get("/health")
async def health(request: Request) -> dict:
    db_ok = await request.app.state.db.health()
    return {
        "service": "sda-indexer",
        "version": "0.1.0",
        "db": db_ok,
        "llm": True,    # Wave 0: no hacemos ping al provider en cada health
        "status": "ok" if db_ok else "degraded",
    }
