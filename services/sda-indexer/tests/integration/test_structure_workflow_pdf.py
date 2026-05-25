"""Integration test del structure_workflow refactored. Requiere mineru service
+ DeepSeek + Supabase reales. Skip cuando no estén configurados. NO mocks."""

import os
import hashlib
import uuid
from pathlib import Path

import pytest

from sda_indexer.workflows.structure import build_graph, run_structure
from sda_indexer.db.client import DB
from sda_indexer.settings.client import SettingsClient
from sda_indexer.llm.client import LLMClient
from sda_indexer.pipeline.parser.pdf_mineru import MineruClient


pytestmark = pytest.mark.integration


@pytest.fixture
def env():
    needed = ["DEEPSEEK_API_KEY", "MINERU_URL", "MINERU_SHARED_SECRET",
              "SUPABASE_URL", "SUPABASE_SERVICE_KEY", "POSTGRES_URL"]
    missing = [k for k in needed if not os.environ.get(k)]
    if missing:
        pytest.skip(f"Missing env: {missing}")
    return {k: os.environ[k] for k in needed}


async def test_structure_workflow_pdf_end_to_end(env, tmp_path):
    """Sube un PDF chico, corre el workflow, valida tree_nodes."""
    from supabase import create_client
    sb = create_client(env["SUPABASE_URL"], env["SUPABASE_SERVICE_KEY"])
    test_pdf = tmp_path / "test_e2e.pdf"
    from reportlab.pdfgen import canvas
    c = canvas.Canvas(str(test_pdf))
    for i in range(3):
        c.drawString(100, 750, f"Section {i+1}")
        c.showPage()
    c.save()
    pdf_bytes = test_pdf.read_bytes()
    sha = hashlib.sha256(pdf_bytes).hexdigest()
    doc_id = str(uuid.uuid4())
    storage_path = f"test_e2e/{doc_id}.pdf"
    sb.storage.from_("docs").upload(storage_path, pdf_bytes)

    # Review-fix (B3): la API real es DB(dsn=..., min_size=, max_size=).start()
    db = DB(dsn=env["POSTGRES_URL"], min_size=1, max_size=4)
    await db.start()
    try:
        async with db.pool.acquire() as conn:
            await conn.execute(
                """insert into documents (id, source_path, source_type, status)
                   values ($1, $2, 'pdf', 'pending')""",
                doc_id, storage_path,
            )

        from sda_indexer.settings.registry import SETTINGS
        settings = SettingsClient(db.pool, SETTINGS, start_listener=False)
        llm = LLMClient(api_key=env["DEEPSEEK_API_KEY"], base_url="https://api.deepseek.com/v1")
        mineru = MineruClient(env["MINERU_URL"], env["MINERU_SHARED_SECRET"])

        graph = build_graph(db=db, supabase=sb, settings=settings, llm=llm, mineru=mineru)
        result = await run_structure(graph, document_id=doc_id)
        assert result["node_count"] >= 1
        async with db.pool.acquire() as conn:
            row = await conn.fetchrow(
                "select page_count, parser_used, path_used, doc_summary_short "
                "from documents where id=$1", doc_id,
            )
            assert row["page_count"] == 3
            assert row["parser_used"] in ("native", "mineru")
            assert row["path_used"] in ("fast", "full")
            assert row["doc_summary_short"]
    finally:
        async with db.pool.acquire() as conn:
            await conn.execute("delete from tree_nodes where document_id=$1", doc_id)
            await conn.execute("delete from documents where id=$1", doc_id)
        sb.storage.from_("docs").remove([storage_path])
        await db.close()
