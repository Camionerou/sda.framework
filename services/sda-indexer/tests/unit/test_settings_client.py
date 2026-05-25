import asyncio
import json
import pytest
from unittest.mock import AsyncMock, MagicMock
from sda_indexer.settings.client import SettingsClient, CASCADE_SQL
from sda_indexer.settings.types import SettingDef


@pytest.fixture
def registry():
    return [
        SettingDef("test.k", "string", "default-val", "", ["global"]),
    ]


@pytest.fixture
def mock_pool():
    p = MagicMock()
    p.acquire = MagicMock()
    p.fetchrow = AsyncMock(return_value=None)
    return p


@pytest.mark.asyncio
async def test_resolve_falls_back_to_default(mock_pool, registry):
    client = SettingsClient(mock_pool, registry, start_listener=False)
    val = await client.resolve("test.k")
    assert val == "default-val"


@pytest.mark.asyncio
async def test_resolve_returns_db_value(mock_pool, registry):
    mock_pool.fetchrow = AsyncMock(return_value={"value": "db-val"})
    client = SettingsClient(mock_pool, registry, start_listener=False)
    val = await client.resolve("test.k")
    assert val == "db-val"


@pytest.mark.asyncio
async def test_resolve_cached(mock_pool, registry):
    mock_pool.fetchrow = AsyncMock(return_value={"value": "db-val"})
    client = SettingsClient(mock_pool, registry, start_listener=False)
    await client.resolve("test.k")
    await client.resolve("test.k")
    assert mock_pool.fetchrow.call_count == 1  # cached on 2nd


@pytest.mark.asyncio
async def test_on_change_invalidates_cache(mock_pool, registry):
    mock_pool.fetchrow = AsyncMock(return_value={"value": "v1"})
    client = SettingsClient(mock_pool, registry, start_listener=False)
    await client.resolve("test.k")  # cache populated
    payload = json.dumps({"key": "test.k", "scope_type": "global", "scope_value": None})
    client._on_change(None, 0, "settings_changed", payload)
    mock_pool.fetchrow = AsyncMock(return_value={"value": "v2"})
    val = await client.resolve("test.k")
    assert val == "v2"


def test_cascade_sql_includes_priority():
    assert "priority" in CASCADE_SQL
    assert "document" in CASCADE_SQL
