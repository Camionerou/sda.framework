import os
import json
import pytest
from sda_indexer.db.client import DB


pytestmark = pytest.mark.asyncio


@pytest.fixture
async def db():
    dsn = os.getenv("SDA_DB_DSN", "postgresql://postgres:postgres@localhost:54322/postgres")
    d = DB(dsn=dsn, min_size=1, max_size=2)
    await d.start()
    yield d
    await d.close()


async def test_pool_executes(db):
    async with db.pool.acquire() as conn:
        row = await conn.fetchrow("select 1 as n")
    assert row["n"] == 1


async def test_health_check(db):
    ok = await db.health()
    assert ok is True


async def test_jsonb_codec_decodes(db):
    """Cualquier conn del pool debe auto-decodificar jsonb."""
    async with db.pool.acquire() as conn:
        row = await conn.fetchrow("select '{\"k\": \"v\", \"n\": 42}'::jsonb as obj")
    assert isinstance(row["obj"], dict)
    assert row["obj"] == {"k": "v", "n": 42}


async def test_jsonb_codec_encodes(db):
    """Pasar dict como param → asyncpg lo serializa como jsonb."""
    async with db.pool.acquire() as conn:
        row = await conn.fetchrow("select $1::jsonb as obj", {"hello": "world"})
    assert row["obj"] == {"hello": "world"}
