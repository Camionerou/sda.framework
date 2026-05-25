import os
import pytest
from sda_indexer.db.client import DB
from sda_indexer.db.tree_nodes import bulk_insert, get_node, set_summary

pytestmark = pytest.mark.asyncio


@pytest.fixture
async def db():
    dsn = os.getenv("SDA_DB_DSN", "postgresql://postgres:postgres@localhost:54322/postgres")
    d = DB(dsn=dsn)
    await d.start()
    yield d
    async with d.pool.acquire() as conn:
        await conn.execute("delete from documents where source_path like 'docs/test-tn-%';")
    await d.close()


@pytest.fixture
async def doc_id(db):
    async with db.pool.acquire() as conn:
        return await conn.fetchval(
            "insert into documents (sha256, source_path, source_type) "
            "values ('test-tn-sha', 'docs/test-tn-1.md', 'markdown') returning id"
        )


async def test_bulk_insert_creates_nodes(db, doc_id):
    nodes = [
        {"node_id_str": "n_1", "structure_code": "1", "depth": 1,
         "title": "Cap 1", "start_index": 1, "end_index": 5, "text": "hola"},
        {"node_id_str": "n_2", "structure_code": "2", "depth": 1,
         "title": "Cap 2", "start_index": 6, "end_index": 10, "text": "mundo"},
    ]
    ids = await bulk_insert(db.pool, doc_id, nodes)
    assert len(ids) == 2


async def test_set_summary_marks_ready(db, doc_id):
    nodes = [{"node_id_str": "n_3", "structure_code": "3", "depth": 1,
              "title": "X", "start_index": 1, "end_index": 1, "text": "t"}]
    ids = await bulk_insert(db.pool, doc_id, nodes)
    await set_summary(db.pool, ids[0], summary="resumen", model="deepseek-chat")
    n = await get_node(db.pool, ids[0])
    assert n["status"] == "ready"
    assert n["summary"] == "resumen"
