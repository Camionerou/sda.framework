import os
import hashlib
import pytest
from sda_indexer.db.client import DB
from sda_indexer.db.documents import (
    get_document, update_sha256_post_load, mark_failed, mark_ready_meta,
)

pytestmark = pytest.mark.asyncio


@pytest.fixture
async def db():
    dsn = os.getenv("SDA_DB_DSN", "postgresql://postgres:postgres@localhost:54322/postgres")
    d = DB(dsn=dsn)
    await d.start()
    yield d
    async with d.pool.acquire() as conn:
        await conn.execute("delete from documents where source_path like 'docs/test-%';")
    await d.close()


async def test_get_document_returns_row(db):
    async with db.pool.acquire() as conn:
        doc_id = await conn.fetchval(
            "insert into documents (sha256, source_path, source_type) "
            "values ($1, $2, $3) returning id",
            "test-sha-1", "docs/test-1.md", "markdown",
        )
    row = await get_document(db.pool, doc_id)
    assert row["sha256"] == "test-sha-1"


async def test_update_sha256_post_load_succeeds(db):
    real_sha = hashlib.sha256(b"hello").hexdigest()
    async with db.pool.acquire() as conn:
        doc_id = await conn.fetchval(
            "insert into documents (sha256, source_path, source_type) "
            "values ($1, $2, $3) returning id",
            "provisional:abc", "docs/test-2.md", "markdown",
        )
    result = await update_sha256_post_load(db.pool, doc_id, real_sha)
    assert result == "updated"


async def test_update_sha256_post_load_detects_duplicate(db):
    real_sha = hashlib.sha256(b"world").hexdigest()
    async with db.pool.acquire() as conn:
        await conn.execute(
            "insert into documents (sha256, source_path, source_type) "
            "values ($1, $2, $3)",
            real_sha, "docs/test-3-original.md", "markdown",
        )
        dup_id = await conn.fetchval(
            "insert into documents (sha256, source_path, source_type) "
            "values ($1, $2, $3) returning id",
            "provisional:xyz", "docs/test-3-duplicate.md", "markdown",
        )
    result = await update_sha256_post_load(db.pool, dup_id, real_sha)
    assert result == "duplicate"
    async with db.pool.acquire() as conn:
        status = await conn.fetchval("select status from documents where id=$1", dup_id)
    assert status == "duplicate"
