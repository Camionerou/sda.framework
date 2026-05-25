"""E2E tests: full pipeline contra los 8 PDFs canonicales. Valida D-1.x.

Requiere todos los servicios en pie (Supabase + mineru + indexer + DeepSeek).
"""

import asyncio
import os
import time
import uuid

import pytest


pytestmark = pytest.mark.e2e


def _f1_score(predicted: list[str], expected: list[str]) -> float:
    """F1 case-insensitive whitespace-normalized title matching."""
    def norm(t: str) -> str:
        return " ".join(t.lower().split())
    p = {norm(t) for t in predicted}
    e = {norm(t) for t in expected}
    if not e:
        return 1.0 if not p else 0.0
    tp = len(p & e)
    if tp == 0:
        return 0.0
    prec = tp / len(p)
    rec = tp / len(e)
    return 2 * prec * rec / (prec + rec)


@pytest.fixture
def env():
    needed = ["SUPABASE_URL", "SUPABASE_SERVICE_KEY", "POSTGRES_URL"]
    missing = [k for k in needed if not os.environ.get(k)]
    if missing:
        pytest.skip(f"Missing env: {missing}")
    return {k: os.environ[k] for k in needed}


async def _upload_and_enqueue(env, local_pdf, doc_id):
    """Sube PDF a Storage + insert documents + enqueue. Devuelve storage_path."""
    from supabase import create_client
    import asyncpg
    sb = create_client(env["SUPABASE_URL"], env["SUPABASE_SERVICE_KEY"])
    storage_path = f"e2e/{doc_id}.pdf"
    sb.storage.from_("docs").upload(storage_path, local_pdf.read_bytes(), {"upsert": "true"})
    conn = await asyncpg.connect(env["POSTGRES_URL"])
    try:
        await conn.execute(
            """insert into documents (id, source_path, source_type, status)
               values ($1, $2, 'pdf', 'pending')""",
            doc_id, storage_path,
        )
        await conn.execute(
            "select pgmq.send('q_extract_structure', $1::jsonb)",
            f'{{"document_id":"{doc_id}"}}',
        )
    finally:
        await conn.close()
    return storage_path


async def _wait_for_ready(env, doc_id, timeout):
    """Poll documents.status hasta 'ready' o 'failed' o timeout."""
    import asyncpg
    deadline = time.monotonic() + timeout
    conn = await asyncpg.connect(env["POSTGRES_URL"])
    try:
        while time.monotonic() < deadline:
            row = await conn.fetchrow(
                """select status, page_count, parser_used, path_used,
                          doc_summary_short
                     from documents where id=$1""",
                doc_id,
            )
            if row and row["status"] in ("ready", "failed"):
                return dict(row)
            await asyncio.sleep(3)
        raise TimeoutError(f"doc {doc_id} not ready after {timeout}s")
    finally:
        await conn.close()


async def _measure(env, doc_id):
    """Devuelve metrics post-procesamiento."""
    import asyncpg
    conn = await asyncpg.connect(env["POSTGRES_URL"])
    try:
        cnt_calls = await conn.fetchval(
            "select count(*) from llm_calls where document_id=$1", doc_id,
        )
        sum_cost = await conn.fetchval(
            "select coalesce(sum(cost_cents), 0) from llm_calls where document_id=$1",
            doc_id,
        )
        sum_cached = await conn.fetchval(
            "select coalesce(sum(cached_tokens),0)::float / "
            "nullif(sum(prompt_tokens),0) "
            "from llm_calls where document_id=$1", doc_id,
        )
        titles = await conn.fetch(
            """select title from tree_nodes
                where document_id=$1 and depth=1
                order by structure_code""",
            doc_id,
        )
        contextualized = await conn.fetchval(
            "select count(*) from tree_nodes "
            "where document_id=$1 and text_contextualized is not null",
            doc_id,
        )
        return {
            "llm_calls": cnt_calls,
            "cost_cents": float(sum_cost),
            "cache_hit_ratio": float(sum_cached or 0),
            "top_titles": [r["title"] for r in titles],
            "contextualized_count": contextualized,
        }
    finally:
        await conn.close()


@pytest.mark.parametrize("pdf_id", [
    "tech_manual_50p",
    "scan_legal_50p_es",
    "contract_30p",
    "book_300p",
])
async def test_canonical_pdf_meets_criteria(corpus_by_id, env, pdf_id):
    if pdf_id not in corpus_by_id:
        pytest.skip(f"{pdf_id} no en corpus (URL no anotada)")
    entry = corpus_by_id[pdf_id]
    doc_id = str(uuid.uuid4())

    await _upload_and_enqueue(env, entry.local_path, doc_id)
    t0 = time.monotonic()
    final = await _wait_for_ready(env, doc_id, entry.expected.get("duration_seconds_max", 600))
    elapsed = time.monotonic() - t0

    assert final["status"] == "ready", f"doc failed: {final}"
    if "page_count" in entry.expected:
        assert final["page_count"] == entry.expected["page_count"]
    if "path_used" in entry.expected:
        assert final["path_used"] == entry.expected["path_used"]

    metrics = await _measure(env, doc_id)
    assert metrics["llm_calls"] <= entry.expected.get("llm_calls_max", 10**9)
    assert metrics["cost_cents"] <= entry.expected.get("cost_cents_max", 10**9)

    expected_titles = entry.expected.get("toc_nodes_titles_expected", [])
    if expected_titles and "f1_threshold" in entry.expected:
        f1 = _f1_score(metrics["top_titles"], expected_titles)
        assert f1 >= entry.expected["f1_threshold"], (
            f"F1 {f1:.2f} below threshold {entry.expected['f1_threshold']}"
        )

    if entry.expected.get("validates_d16"):
        assert metrics["contextualized_count"] > 0
