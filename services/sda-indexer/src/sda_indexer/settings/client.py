"""SettingsClient — resolve con scope cascade, cache + hot-reload via pg_notify.
Spec §5.5.4."""

import asyncio
import json
import structlog
from typing import Any
from .types import SettingDef

log = structlog.get_logger()


CASCADE_SQL = """
with candidates as (
  select value, case scope_type
    when 'document'   then 4
    when 'collection' then 3
    when 'doc_type'   then 2
    when 'global'     then 1
  end as priority
  from app_settings
  where deprecated_at is null and key = $1
    and (
      (scope_type='document'   and scope_value=$4) or
      (scope_type='collection' and scope_value=$3) or
      (scope_type='doc_type'   and scope_value=$2) or
      (scope_type='global')
    )
)
select value from candidates order by priority desc limit 1
"""


class SettingsClient:
    """Cliente para resolver settings con scope cascade.

    - Cache in-memory por (key, doc_type, collection_id, document_id)
    - Listener pg_notify invalida cache cuando una setting cambia en DB
    - Si no hay valor en DB, devuelve el default del registry
    """

    def __init__(self, db_pool, registry: list[SettingDef], *, start_listener: bool = True):
        self._pool = db_pool
        self._registry = {s.key: s for s in registry}
        self._cache: dict[tuple, Any] = {}
        self._listener_task: asyncio.Task | None = None
        if start_listener:
            self._listener_task = asyncio.create_task(self._listen_for_changes())

    async def resolve(
        self,
        key: str,
        *,
        doc_type: str | None = None,
        collection_id: str | None = None,
        document_id: str | None = None,
    ) -> Any:
        ctx = (key, doc_type, collection_id, document_id)
        if ctx in self._cache:
            return self._cache[ctx]
        row = await self._pool.fetchrow(
            CASCADE_SQL, key, doc_type, collection_id, document_id
        )
        if row is not None:
            value = row["value"]
        elif key in self._registry:
            value = self._registry[key].default
        else:
            raise KeyError(f"Unknown setting key: {key}")
        self._cache[ctx] = value
        return value

    async def _listen_for_changes(self) -> None:
        try:
            async with self._pool.acquire() as conn:
                await conn.add_listener("settings_changed", self._on_change)
                log.info("settings.listener.started")
                await asyncio.Event().wait()
        except Exception as e:
            log.error("settings.listener.error", error=str(e))

    def _on_change(self, conn, pid, channel: str, payload: str) -> None:
        try:
            evt = json.loads(payload)
            key = evt.get("key")
            invalidated = sum(1 for k in self._cache if k[0] == key)
            self._cache = {k: v for k, v in self._cache.items() if k[0] != key}
            log.info("settings.invalidated", key=key, count=invalidated)
        except Exception as e:
            log.error("settings.on_change.error", error=str(e), payload=payload)

    async def close(self) -> None:
        if self._listener_task:
            self._listener_task.cancel()
            try:
                await self._listener_task
            except asyncio.CancelledError:
                pass
