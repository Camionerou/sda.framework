"""FastAPI app principal. Spec §5.1.

Endpoint:
  POST /parse — body ParseRequest, returns ParseResponse o error tipado
  GET /healthz — health check
"""

import os
import secrets
from contextlib import asynccontextmanager
from pathlib import Path

import structlog
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from .cache import LocalLRUCache
from .download import (
    DownloadConfig,
    DownloadError,
    DiskFullError,
    ExpiredSignedUrlError,
    Sha256MismatchError,
    download_with_resume,
)
from .healthz import HealthStatus, check_health
from .parser import ParseResult, parse_pdf

log = structlog.get_logger()


VERSION = "0.1.0"
CACHE_DIR = Path(os.environ.get("SDA_MINERU_CACHE_DIR", "/var/cache/sda-mineru"))
SHARED_SECRET = os.environ.get("MINERU_SHARED_SECRET", "")


class ParseRequest(BaseModel):
    doc_id: str
    signed_url: str
    expected_sha256: str = Field(min_length=64, max_length=64)
    force_path: str | None = Field(default=None, pattern="^(fast|full)$")


class HeuristicsOut(BaseModel):
    has_text_layer: bool
    has_toc: bool
    text_ratio: float
    confidence: float


class ParseMetadata(BaseModel):
    parser_used: str
    path_used: str
    page_count: int
    heuristics: HeuristicsOut
    elapsed_seconds: float
    cache_hit: bool


class ParseResponse(BaseModel):
    markdown: str
    metadata: ParseMetadata


@asynccontextmanager
async def lifespan(app: FastAPI):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    app.state.cache = LocalLRUCache(root=CACHE_DIR)
    log.info("mineru.startup", version=VERSION, cache_dir=str(CACHE_DIR))
    yield
    log.info("mineru.shutdown")


app = FastAPI(title="sda-mineru-parser", version=VERSION, lifespan=lifespan)


def require_auth(authorization: str = Header(default="")) -> None:
    if not SHARED_SECRET:
        raise HTTPException(503, "MINERU_SHARED_SECRET no configurado")
    expected = f"Bearer {SHARED_SECRET}"
    if not secrets.compare_digest(authorization, expected):
        raise HTTPException(401, "auth failed")


@app.get("/healthz", response_model=HealthStatus)
async def healthz():
    return check_health(CACHE_DIR, VERSION)


@app.post("/parse", response_model=ParseResponse, dependencies=[Depends(require_auth)])
async def parse(req: ParseRequest):
    cache: LocalLRUCache = app.state.cache
    cache_hit = False

    # Cache lookup
    pdf_path = cache.get(req.expected_sha256)
    if pdf_path:
        cache_hit = True
        log.info("mineru.cache_hit", sha256=req.expected_sha256[:8])
    else:
        # Download to temp, validate sha, then put in cache
        tmp = CACHE_DIR / f"_dl_{req.doc_id}.pdf"
        try:
            await download_with_resume(
                url=req.signed_url,
                expected_sha256=req.expected_sha256,
                dst_path=tmp,
                config=DownloadConfig(),
            )
            pdf_path = cache.put(req.expected_sha256, tmp)
        except ExpiredSignedUrlError as e:
            raise HTTPException(410, {"failure_reason": "expired_signed_url", "detail": str(e)})
        except Sha256MismatchError as e:
            raise HTTPException(422, {"failure_reason": "sha256_mismatch", "detail": str(e)})
        except DiskFullError as e:
            raise HTTPException(503, {"failure_reason": "disk_full", "detail": str(e)})
        except DownloadError as e:
            raise HTTPException(502, {"failure_reason": "download_failed", "detail": str(e)})
        finally:
            tmp.unlink(missing_ok=True)

    # Parse
    try:
        result: ParseResult = await parse_pdf(pdf_path, force_path=req.force_path)
    except MemoryError as e:
        raise HTTPException(500, {"failure_reason": "mineru_oom", "detail": str(e)})
    except TimeoutError as e:
        raise HTTPException(504, {"failure_reason": "mineru_timeout", "detail": str(e)})
    except Exception as e:
        raise HTTPException(500, {"failure_reason": "unknown", "detail": f"{type(e).__name__}: {e}"})

    return ParseResponse(
        markdown=result.markdown,
        metadata=ParseMetadata(
            parser_used=result.parser_used,
            path_used=result.path_used,
            page_count=result.page_count,
            heuristics=HeuristicsOut(
                has_text_layer=result.heuristics.has_text_layer,
                has_toc=result.heuristics.has_toc,
                text_ratio=result.heuristics.text_ratio,
                confidence=result.heuristics.confidence,
            ),
            elapsed_seconds=result.elapsed_seconds,
            cache_hit=cache_hit,
        ),
    )
