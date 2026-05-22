from __future__ import annotations

import asyncio
import json
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .embeddings import is_embedding_configured
from .events import publish_inngest_event
from .http_client import close_clients
from .llm import is_tree_llm_configured
from .pageindex_style import content_list_to_labeled_pages, source_blocks_from_mineru_middle
from .supabase_io import download_storage_json, list_extraction_artifacts, persist_tree_index
from .tree_graph import TREE_INDEXER_VERSION, is_checkpointing_configured, run_tree_index_graph
from .versions import INDEXING_VERSION_COLUMNS, TREE_PROMPT_VERSION

DATA_DIR = Path(os.getenv("SDA_TREE_INDEXER_DATA_DIR", "/var/lib/sda-tree-indexer"))
TOKEN = os.getenv("SDA_TREE_INDEXER_TOKEN") or os.getenv("SDA_COMPUTE_GATEWAY_TOKEN")

if not TOKEN:
    raise RuntimeError("SDA_TREE_INDEXER_TOKEN is required.")


def positive_int_env(name: str, fallback: int) -> int:
    try:
        value = int(os.getenv(name, str(fallback)))
    except ValueError:
        return fallback
    return value if value > 0 else fallback


MAX_CONCURRENT_JOBS = positive_int_env("SDA_TREE_INDEXER_CONCURRENCY", 1)
MAX_REQUEST_BODY_BYTES = positive_int_env("SDA_TREE_INDEXER_MAX_BODY_BYTES", 1_048_576)


class RequestBodyTooLargeError(RuntimeError):
    pass


class RequestBodyLimitMiddleware:
    def __init__(self, app: ASGIApp, max_body_bytes: int) -> None:
        self.app = app
        self.max_body_bytes = max_body_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers") or [])
        content_length = headers.get(b"content-length")
        if content_length:
            try:
                if int(content_length) > self.max_body_bytes:
                    await self._reject(scope, receive, send)
                    return
            except ValueError:
                pass

        received = 0

        async def limited_receive() -> Message:
            nonlocal received
            message = await receive()

            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_body_bytes:
                    raise RequestBodyTooLargeError

            return message

        try:
            await self.app(scope, limited_receive, send)
        except RequestBodyTooLargeError:
            await self._reject(scope, receive, send)

    async def _reject(self, scope: Scope, receive: Receive, send: Send) -> None:
        response = JSONResponse(
            {
                "detail": "Request body too large.",
                "max_body_bytes": self.max_body_bytes,
            },
            status_code=413,
        )
        await response(scope, receive, send)

app = FastAPI(title="SDA Tree Indexer", version=TREE_INDEXER_VERSION)
app.add_middleware(RequestBodyLimitMiddleware, max_body_bytes=MAX_REQUEST_BODY_BYTES)
job_semaphore = asyncio.Semaphore(MAX_CONCURRENT_JOBS if MAX_CONCURRENT_JOBS > 0 else 1)


@app.on_event("shutdown")
async def _on_shutdown() -> None:
    await close_clients()


class TreeIndexJobRequest(BaseModel):
    document_id: str = Field(min_length=1)
    document_title: str | None = None
    extraction_id: str = Field(min_length=1)
    filename: str | None = None
    run_id: str = Field(min_length=1)
    source: str = "unknown"
    tenant_id: str = Field(min_length=1)
    versions: dict[str, str] = Field(default_factory=dict)


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def job_dir(job_id: str) -> Path:
    return DATA_DIR / "jobs" / job_id


def job_path(job_id: str) -> Path:
    return job_dir(job_id) / "job.json"


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def read_job(job_id: str) -> dict[str, Any] | None:
    path = job_path(job_id)
    return read_json(path) if path.exists() else None


def write_job(job: dict[str, Any]) -> None:
    write_json(job_path(job["job_id"]), job)


def patch_job(job_id: str, patch: dict[str, Any]) -> dict[str, Any]:
    current = read_job(job_id)
    if not current:
        raise RuntimeError(f"Job {job_id} no encontrado.")
    next_job = {**current, **patch, "updated_at": now_iso()}
    write_job(next_job)
    return next_job


async def require_auth(authorization: str | None = Header(default=None)) -> None:
    if not TOKEN:
        raise HTTPException(status_code=503, detail="Worker auth token is not configured.")
    if authorization == f"Bearer {TOKEN}":
        return
    raise HTTPException(status_code=401, detail="Unauthorized")


def pick_content_list_artifact(artifacts: list[dict[str, Any]]) -> dict[str, Any]:
    artifact = pick_artifact(artifacts, "content_list")
    if artifact:
        return artifact
    raise RuntimeError("No se encontro content_list de MinerU para construir el arbol.")


def pick_artifact(artifacts: list[dict[str, Any]], artifact_type: str) -> dict[str, Any] | None:
    for artifact in artifacts:
        if artifact.get("artifact_type") == artifact_type:
            return artifact
    return None


async def process_tree_job(job_id: str, payload: TreeIndexJobRequest) -> None:
    async with job_semaphore:
        try:
            patch_job(
                job_id,
                {
                    "message": "Loading MinerU artifacts from Supabase.",
                    "progress": 10,
                    "stage": "loading_artifacts",
                    "status": "running",
                    "started_at": now_iso(),
                },
            )

            artifacts = await list_extraction_artifacts(
                tenant_id=payload.tenant_id,
                document_id=payload.document_id,
                extraction_id=payload.extraction_id,
            )
            content_list_artifact = pick_content_list_artifact(artifacts)
            content_list = await download_storage_json(
                content_list_artifact["storage_bucket"],
                content_list_artifact["storage_path"],
            )
            pages = content_list_to_labeled_pages(content_list)
            middle_json_artifact = pick_artifact(artifacts, "middle_json")
            middle_json = (
                await download_storage_json(
                    middle_json_artifact["storage_bucket"],
                    middle_json_artifact["storage_path"],
                )
                if middle_json_artifact
                else None
            )
            source_blocks = source_blocks_from_mineru_middle(middle_json)

            if not pages:
                raise RuntimeError("MinerU content_list no contiene paginas utilizables.")

            write_json(job_dir(job_id) / "pages.json", pages)
            patch_job(
                job_id,
                {
                    "artifact_count": len(artifacts),
                    "content_list_path": content_list_artifact["storage_path"],
                    "message": "MinerU pages prepared for PageIndex-style tree builder.",
                    "middle_json_path": middle_json_artifact.get("storage_path") if middle_json_artifact else None,
                    "page_count": len(pages),
                    "progress": 35,
                    "source_block_count": len(source_blocks),
                    "stage": "pages_prepared",
                    "status": "running",
                },
            )

            if not is_tree_llm_configured():
                terminal_job = patch_job(
                    job_id,
                    {
                        "error": "Tree LLM no configurado; paginas MinerU listas.",
                        "failed_at": now_iso(),
                        "message": "Tree LLM missing.",
                        "progress": 35,
                        "stage": "llm_missing",
                        "status": "failed",
                    },
                )
                await publish_inngest_event("compute/tree.completed", terminal_job)
                return

            terminal_job = patch_job(
                job_id,
                {
                    "message": "Running LangGraph PageIndex-style Tree Indexer.",
                    "progress": 45,
                    "stage": "structuring",
                    "status": "running",
                },
            )

            result = await run_tree_index_graph(
                payload.document_title or payload.filename or payload.document_id,
                pages,
                source_blocks,
                document_id=payload.document_id,
                job_id=job_id,
                run_id=payload.run_id,
                tenant_id=payload.tenant_id,
            )
            result = {
                **result,
                "artifact_count": len(artifacts),
                "content_list_path": content_list_artifact["storage_path"],
                "middle_json_path": middle_json_artifact.get("storage_path") if middle_json_artifact else None,
                "page_count": len(pages),
                "source_block_count": len(source_blocks),
            }
            write_json(job_dir(job_id) / "tree.json", result["tree_for_storage"])
            write_json(job_dir(job_id) / "chunks.json", result["chunks"])

            patch_job(
                job_id,
                {
                    "chunk_count": len(result["chunks"]),
                    "message": "Persisting Tree Index in Supabase.",
                    "progress": 85,
                    "stage": "persisting_tree",
                    "status": "running",
                },
            )
            persistence = await persist_tree_index(
                document_id=payload.document_id,
                extraction_id=payload.extraction_id,
                result=result,
                run_id=payload.run_id,
                tenant_id=payload.tenant_id,
                versions=payload.versions,
            )
            result = {
                **result,
                "persistence": persistence,
                "persisted_at": now_iso(),
                "versions": payload.versions,
            }
            write_json(job_dir(job_id) / "result.json", result)

            terminal_job = patch_job(
                job_id,
                {
                    "chunk_count": len(result["chunks"]),
                    "completed_at": now_iso(),
                    "doc_summary": result["doc_summary"],
                    "document_type": result["document_type"],
                    "embedding_count": result["metrics"].get("embedding_count"),
                    "embedding_model": result["metrics"].get("embedding_model"),
                    "message": "Tree Index built.",
                    "metrics": result["metrics"],
                    "model": result["model"],
                    "persisted_at": result["persisted_at"],
                    "progress": 100,
                    "provider": result["provider"],
                    "routing_summary": result.get("routing_summary"),
                    "stage": "tree_indexed",
                    "status": "succeeded",
                    "tree_path": str(job_dir(job_id) / "tree.json"),
                    "tree_indexer_version": INDEXING_VERSION_COLUMNS["tree_indexer_version"],
                    "tree_prompt_version": TREE_PROMPT_VERSION,
                    "version": result["version"],
                },
            )
            await publish_inngest_event("compute/tree.completed", terminal_job)
        except Exception as error:
            terminal_job = patch_job(
                job_id,
                {
                    "error": str(error),
                    "failed_at": now_iso(),
                    "message": "Tree Indexer failed.",
                    "progress": 100,
                    "stage": "failed",
                    "status": "failed",
                },
            )
            await publish_inngest_event("compute/tree.completed", terminal_job)


@app.get("/v1/health", dependencies=[Depends(require_auth)])
async def health() -> dict[str, Any]:
    return {
        "auth_configured": bool(TOKEN),
        "checkpointing_configured": is_checkpointing_configured(),
        "concurrency": MAX_CONCURRENT_JOBS,
        "embedding_configured": is_embedding_configured(),
        "llm_configured": is_tree_llm_configured(),
        "ok": True,
        "request_body_limit_bytes": MAX_REQUEST_BODY_BYTES,
        "service": "sda-tree-indexer",
        "version": TREE_INDEXER_VERSION,
    }


@app.post("/v1/tree-index-jobs", dependencies=[Depends(require_auth)], status_code=202)
async def create_tree_index_job(
    payload: TreeIndexJobRequest,
    background_tasks: BackgroundTasks,
) -> dict[str, Any]:
    job_id = str(uuid4())
    job = {
        "created_at": now_iso(),
        "document_id": payload.document_id,
        "extraction_id": payload.extraction_id,
        "job_id": job_id,
        "progress": 0,
        "run_id": payload.run_id,
        "source": payload.source,
        "stage": "queued",
        "status": "queued",
        "tenant_id": payload.tenant_id,
        "updated_at": now_iso(),
        "versions": payload.versions,
        "version": TREE_INDEXER_VERSION,
    }
    write_job(job)
    background_tasks.add_task(process_tree_job, job_id, payload)
    return {
        "job_id": job_id,
        "stage": job["stage"],
        "status": job["status"],
    }


@app.get("/v1/tree-index-jobs/{job_id}", dependencies=[Depends(require_auth)])
async def get_tree_index_job(job_id: str) -> dict[str, Any]:
    job = read_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    return job


@app.get("/v1/tree-index-jobs/{job_id}/result", dependencies=[Depends(require_auth)])
async def get_tree_index_job_result(job_id: str) -> dict[str, Any]:
    path = job_dir(job_id) / "result.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Result not found.")
    return read_json(path)
