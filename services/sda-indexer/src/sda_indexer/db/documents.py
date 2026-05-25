"""CRUD del documento — wrappers sobre las queries comunes."""

import structlog
from typing import Literal

log = structlog.get_logger()


async def get_document(pool, document_id: str) -> dict | None:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "select * from documents where id = $1", document_id
        )
    return dict(row) if row else None


async def update_sha256_post_load(
    pool, document_id: str, real_sha256: str
) -> Literal["updated", "duplicate"]:
    """Reemplaza el sha256 provisorio con el real.

    Si otra fila ya tiene ese sha256 (es un duplicado de contenido), marca
    esta fila como 'duplicate' y retorna 'duplicate'. Si no, hace UPDATE
    y retorna 'updated'.
    """
    async with pool.acquire() as conn:
        try:
            await conn.execute(
                "update documents set sha256 = $1, status = 'parsing' "
                "where id = $2 and sha256 like 'provisional:%'",
                real_sha256, document_id,
            )
            return "updated"
        except Exception as e:
            if "documents_sha256_key" in str(e):
                await conn.execute(
                    "update documents set status='duplicate', "
                    "error_message='Same content as existing document' "
                    "where id = $1",
                    document_id,
                )
                log.info("documents.duplicate_detected", document_id=document_id)
                return "duplicate"
            raise


async def mark_failed(pool, document_id: str, error: str) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            "update documents set status='failed', error_message=$1 where id=$2",
            error, document_id,
        )


async def mark_ready_meta(pool, document_id: str, *, node_count: int, page_count: int | None,
                          path_used: str, doc_description: str | None,
                          total_cost_cents: float) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            """update documents set
                status='ready',
                node_count=$1,
                page_count=$2,
                path_used=$3,
                doc_description=$4,
                total_cost_cents=$5,
                finalized_at=now()
               where id=$6""",
            node_count, page_count, path_used, doc_description, total_cost_cents, document_id,
        )
