"""Test integration — requiere Supabase local corriendo + migraciones aplicadas.

Usage:
  supabase start  # en otra terminal
  uv run pytest tests/integration/test_settings_sync.py -v
"""
import os
import pytest
import asyncpg
from sda_indexer.settings.sync import sync_registry_to_db
from sda_indexer.settings.types import SettingDef


pytestmark = pytest.mark.asyncio


@pytest.fixture
async def pool():
    dsn = os.getenv("SDA_DB_DSN", "postgresql://postgres:postgres@localhost:54322/postgres")
    p = await asyncpg.create_pool(dsn, min_size=1, max_size=2)
    yield p
    await p.close()


@pytest.fixture
async def clean_settings(pool):
    async with pool.acquire() as conn:
        await conn.execute("delete from app_settings where key like 'sync-test.%';")
    yield
    async with pool.acquire() as conn:
        await conn.execute("delete from app_settings where key like 'sync-test.%';")


async def test_sync_inserts_missing(pool, clean_settings):
    reg = [SettingDef("sync-test.k1", "string", "v1", "test", ["global"])]
    await sync_registry_to_db(pool, reg)
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "select value, default_value from app_settings where key='sync-test.k1';"
        )
    assert row["value"] == "v1"
    assert row["default_value"] == "v1"


async def test_sync_marks_removed_as_deprecated(pool, clean_settings):
    reg_v1 = [
        SettingDef("sync-test.keep", "string", "k", "test", ["global"]),
        SettingDef("sync-test.remove", "string", "r", "test", ["global"]),
    ]
    await sync_registry_to_db(pool, reg_v1)
    reg_v2 = [SettingDef("sync-test.keep", "string", "k", "test", ["global"])]
    await sync_registry_to_db(pool, reg_v2)
    async with pool.acquire() as conn:
        removed = await conn.fetchrow(
            "select deprecated_at from app_settings where key='sync-test.remove';"
        )
        kept = await conn.fetchrow(
            "select deprecated_at from app_settings where key='sync-test.keep';"
        )
    assert removed["deprecated_at"] is not None
    assert kept["deprecated_at"] is None
