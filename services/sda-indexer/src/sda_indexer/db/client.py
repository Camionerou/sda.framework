"""DB client — asyncpg pool con jsonb codec registrado al init.

El codec hace que asyncpg auto-decodifique columnas jsonb a dict/list de Python
(en vez de strings JSON crudos), y serialice dicts/listas pasados como params.
"""

import json
import asyncpg
import structlog

log = structlog.get_logger()


async def _setup_codecs(conn: asyncpg.Connection) -> None:
    """Init callback que corre al acquire de cada conexión nueva.

    Registra el codec jsonb (asyncpg no lo hace por default — devuelve strings).
    """
    await conn.set_type_codec(
        "jsonb",
        encoder=json.dumps,
        decoder=json.loads,
        schema="pg_catalog",
    )
    # Opcionalmente también json (algunas columnas usan json en vez de jsonb)
    await conn.set_type_codec(
        "json",
        encoder=json.dumps,
        decoder=json.loads,
        schema="pg_catalog",
    )


class DB:
    def __init__(self, dsn: str, *, min_size: int = 2, max_size: int = 20):
        self._dsn = dsn
        self._min_size = min_size
        self._max_size = max_size
        self.pool: asyncpg.Pool | None = None

    async def start(self) -> None:
        self.pool = await asyncpg.create_pool(
            self._dsn,
            min_size=self._min_size,
            max_size=self._max_size,
            command_timeout=60,
            init=_setup_codecs,
        )
        log.info("db.pool.started", min=self._min_size, max=self._max_size)

    async def close(self) -> None:
        if self.pool:
            await self.pool.close()
            log.info("db.pool.closed")

    async def health(self) -> bool:
        try:
            async with self.pool.acquire() as conn:
                await conn.fetchval("select 1")
            return True
        except Exception as e:
            log.error("db.health.fail", error=str(e))
            return False
