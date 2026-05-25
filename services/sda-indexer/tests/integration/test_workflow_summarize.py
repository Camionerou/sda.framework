import os
import pytest
from unittest.mock import AsyncMock, patch
from sda_indexer.db.client import DB
from sda_indexer.settings.client import SettingsClient
from sda_indexer.settings.registry import SETTINGS
from sda_indexer.workflows.summarize import build_graph, run_summarize
from sda_indexer.llm.client import LLMResult

pytestmark = pytest.mark.asyncio


@pytest.fixture
async def db():
    dsn = os.getenv("SDA_DB_DSN", "postgresql://postgres:postgres@localhost:54322/postgres")
    d = DB(dsn=dsn)
    await d.start()
    yield d
    async with d.pool.acquire() as conn:
        await conn.execute("delete from documents where source_path like 'docs/test-wf-%';")
    await d.close()


@pytest.fixture
async def settings_client(db):
    sc = SettingsClient(db.pool, SETTINGS, start_listener=False)
    yield sc
    await sc.close()


async def test_summarize_workflow_updates_node(db, settings_client):
    async with db.pool.acquire() as conn:
        doc_id = await conn.fetchval(
            "insert into documents (sha256, source_path, source_type, doc_description) "
            "values ('test-wf-1','docs/test-wf-1.md','markdown','desc test') returning id"
        )
        node_id = await conn.fetchval(
            "insert into tree_nodes (document_id, node_id_str, structure_code, depth, "
            "title, start_index, end_index, text) "
            "values ($1, 'n_1', '1', 1, 'Cap 1', 1, 10, 'Texto del nodo a resumir') "
            "returning id",
            doc_id,
        )

    fake_llm = AsyncMock()
    fake_llm.complete = AsyncMock(return_value=LLMResult(
        text="Resumen del cap 1.",
        tokens_in=50, tokens_out=8, cached_tokens=40,
        model="deepseek-chat",
    ))
    graph = build_graph(db=db, settings=settings_client, llm=fake_llm)
    final = await run_summarize(graph, node_id=str(node_id), document_id=str(doc_id))

    assert final["summary"] == "Resumen del cap 1."
    async with db.pool.acquire() as conn:
        row = await conn.fetchrow("select status, summary from tree_nodes where id=$1", node_id)
    assert row["status"] == "ready"
    assert row["summary"] == "Resumen del cap 1."
