"""HTTP client al servicio sda-mineru-parser (en srv-ia-01 via Cloudflare Tunnel).

El indexer NUNCA toca el binario PDF. Manda payload con signed_url + sha256
y recibe markdown + metadata. Errores tipados mapean a indexing_failure_reason.
"""

from dataclasses import dataclass
from typing import Any

import httpx
import structlog

log = structlog.get_logger()


@dataclass(frozen=True)
class ParseRequest:
    doc_id: str
    signed_url: str
    expected_sha256: str
    force_path: str | None = None    # 'fast' | 'full' | None (auto)


@dataclass(frozen=True)
class ParseResponse:
    markdown: str
    metadata: dict[str, Any]


class MineruError(Exception):
    """Error tipado del mineru service. `failure_reason` matchea el enum
    indexing_failure_reason en Postgres."""
    def __init__(self, failure_reason: str, detail: str, status_code: int):
        super().__init__(f"{failure_reason}: {detail}")
        self.failure_reason = failure_reason
        self.detail = detail
        self.status_code = status_code


class MineruClient:
    def __init__(self, base_url: str, shared_secret: str, timeout: float = 600.0):
        self._base_url = base_url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {shared_secret}"}
        self._timeout = timeout

    async def parse(self, req: ParseRequest) -> ParseResponse:
        log.info(
            "mineru.client.parse.start",
            doc_id=req.doc_id, force_path=req.force_path,
        )
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.post(
                f"{self._base_url}/parse",
                headers=self._headers,
                json={
                    "doc_id": req.doc_id,
                    "signed_url": req.signed_url,
                    "expected_sha256": req.expected_sha256,
                    "force_path": req.force_path,
                },
            )
        if resp.status_code == 200:
            data = resp.json()
            log.info(
                "mineru.client.parse.ok",
                doc_id=req.doc_id,
                path_used=data["metadata"]["path_used"],
                page_count=data["metadata"]["page_count"],
                cache_hit=data["metadata"].get("cache_hit", False),
            )
            return ParseResponse(
                markdown=data["markdown"],
                metadata=data["metadata"],
            )

        # Error tipado: el service devuelve {failure_reason, detail}
        try:
            body = resp.json()
            if isinstance(body, dict) and "detail" in body and isinstance(body["detail"], dict):
                failure_reason = body["detail"].get("failure_reason", "unknown")
                detail = body["detail"].get("detail", str(body))
            else:
                failure_reason = "unknown"
                detail = str(body)
        except Exception:
            failure_reason = "unknown"
            detail = resp.text[:500]

        log.warning(
            "mineru.client.parse.fail",
            doc_id=req.doc_id, status=resp.status_code,
            failure_reason=failure_reason,
        )
        raise MineruError(failure_reason, detail, resp.status_code)

    async def healthz(self) -> dict:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{self._base_url}/healthz")
        resp.raise_for_status()
        return resp.json()
