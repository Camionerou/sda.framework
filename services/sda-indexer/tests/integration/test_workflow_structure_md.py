import os
import hashlib
import pytest
from supabase import create_client
from sda_indexer.db.client import DB
from sda_indexer.workflows.structure import build_graph, run_structure

pytestmark = pytest.mark.asyncio


@pytest.fixture
async def db():
    dsn = os.getenv("SDA_DB_DSN", "postgresql://postgres:postgres@localhost:54322/postgres")
    d = DB(dsn=dsn)
    await d.start()
    yield d
    async with d.pool.acquire() as conn:
        await conn.execute("delete from documents where source_path like 'docs/test-st-%';")
        # Cleanup queue de summarize que se llena por triggers
        await conn.execute("select pgmq.purge_queue('q_summarize_node');")
    await d.close()


@pytest.fixture
def supabase():
    # Local Supabase service_role_key (default desde supabase start)
    url = os.getenv("SDA_SUPABASE_URL", "http://127.0.0.1:54321")
    key = os.getenv("SDA_SUPABASE_SERVICE_KEY")
    if not key:
        pytest.skip("SDA_SUPABASE_SERVICE_KEY required for storage test")
    return create_client(url, key)


@pytest.fixture
async def doc_with_provisional_sha(db, supabase, tmp_path):
    md_content = "# Cap 1\n\nTexto uno.\n\n## 1.1 Sub\n\nTexto sub.\n\n## 1.2 Otro\n\nMás texto.\n"
    md_path = "docs/test-st-1.md"
    file_path = tmp_path / "tmp.md"
    file_path.write_bytes(md_content.encode())
    # Upload (puede fallar si ya existe — upsert)
    try:
        supabase.storage.from_("docs").upload(md_path, str(file_path), {"upsert": "true"})
    except Exception:
        pass
    async with db.pool.acquire() as conn:
        doc_id = await conn.fetchval(
            "insert into documents (sha256, source_path, source_type) "
            "values ($1, $2, 'markdown') returning id",
            "provisional:test-st-1", md_path,
        )
    yield {"doc_id": str(doc_id), "md_content": md_content, "path": md_path}


async def test_structure_md_creates_nodes(db, supabase, doc_with_provisional_sha):
    graph = build_graph(db=db, supabase=supabase)
    result = await run_structure(graph, document_id=doc_with_provisional_sha["doc_id"])
    assert result["node_count"] >= 3
    async with db.pool.acquire() as conn:
        rows = await conn.fetch(
            "select node_id_str, structure_code, depth, title from tree_nodes "
            "where document_id=$1 order by structure_code",
            doc_with_provisional_sha["doc_id"],
        )
    titles = [r["title"] for r in rows]
    assert "Cap 1" in titles
    assert "1.1 Sub" in titles
