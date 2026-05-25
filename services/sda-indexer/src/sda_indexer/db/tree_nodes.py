"""CRUD tree_nodes — bulk insert atómico + UPDATE de summary individual."""

import structlog

log = structlog.get_logger()


async def bulk_insert(pool, document_id: str, nodes: list[dict]) -> list[str]:
    """Inserta N tree_nodes en una transacción. Devuelve los UUIDs creados, en orden.

    Cada node dict debe tener: node_id_str, structure_code, depth, title,
    start_index, end_index. Opcionales: parent_id (UUID o None), text, node_type.
    """
    if not nodes:
        return []
    inserted_ids: list[str] = []
    async with pool.acquire() as conn:
        async with conn.transaction():
            for n in nodes:
                new_id = await conn.fetchval(
                    """insert into tree_nodes (
                        document_id, parent_id, node_id_str, structure_code,
                        depth, title, start_index, end_index, node_type, text
                       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                       returning id""",
                    document_id,
                    n.get("parent_id"),
                    n["node_id_str"],
                    n["structure_code"],
                    n["depth"],
                    n["title"],
                    n["start_index"],
                    n["end_index"],
                    n.get("node_type", "section"),
                    n.get("text"),
                )
                inserted_ids.append(str(new_id))
    log.info("tree_nodes.bulk_insert", count=len(inserted_ids), doc=document_id)
    return inserted_ids


async def get_node(pool, node_id: str) -> dict | None:
    async with pool.acquire() as conn:
        row = await conn.fetchrow("select * from tree_nodes where id=$1", node_id)
    return dict(row) if row else None


async def set_summary(pool, node_id: str, *, summary: str, model: str,
                      text_contextualized: str | None = None) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            """update tree_nodes set
                summary = $1,
                summary_model = $2,
                text_contextualized = coalesce($3, text_contextualized),
                status = 'ready',
                summarized_at = now()
              where id = $4""",
            summary, model, text_contextualized, node_id,
        )


async def mark_summarizing(pool, node_id: str) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            "update tree_nodes set status='summarizing', retry_count=retry_count+1 where id=$1",
            node_id,
        )


async def mark_failed(pool, node_id: str, error: str) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            "update tree_nodes set status='failed' where id=$1",
            node_id,
        )
        log.warning("tree_nodes.failed", node_id=node_id, error=error)
