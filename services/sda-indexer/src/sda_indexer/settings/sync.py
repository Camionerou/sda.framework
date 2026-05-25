"""Boot-time sync del registry de código → tabla app_settings.

- Settings nuevas se insertan con default + deprecated_at=null.
- Settings que existen mantienen su `value` actual (no se piso), pero
  actualizan description/default_value/validation_schema desde el registry.
- Settings que ya no están en el registry se marcan deprecated_at=now()
  pero NO se borran (audit trail).
"""

import json
import structlog
from .types import SettingDef

log = structlog.get_logger()

UPSERT_SQL = """
insert into app_settings (
    key, scope_type, scope_value, value, value_type,
    description, default_value, validation_schema, is_secret, deprecated_at
) values ($1, 'global', null, $2::jsonb, $3, $4, $2::jsonb, $5::jsonb, $6, null)
on conflict (key, scope_type, scope_value)
do update set
    deprecated_at = null,
    description = excluded.description,
    default_value = excluded.default_value,
    validation_schema = excluded.validation_schema
"""

DEPRECATE_SQL = """
update app_settings
   set deprecated_at = now()
 where key != all($1::text[])
   and deprecated_at is null
"""


async def sync_registry_to_db(pool, registry: list[SettingDef]) -> dict:
    """Sincroniza registry → app_settings. Idempotente. Devuelve contadores."""
    inserted_or_updated = 0
    async with pool.acquire() as conn:
        # Registrar codec jsonb para que lectura/escritura usen JSON nativo
        # (de modo que `row["value"]` retorne el valor decodificado en vez del raw text).
        await conn.set_type_codec(
            "jsonb",
            encoder=json.dumps,
            decoder=json.loads,
            schema="pg_catalog",
        )
        async with conn.transaction():
            for s in registry:
                await conn.execute(
                    UPSERT_SQL,
                    s.key,
                    s.default,
                    s.value_type,
                    s.description,
                    s.validation,
                    s.is_secret,
                )
                inserted_or_updated += 1
            result = await conn.execute(
                DEPRECATE_SQL, [s.key for s in registry]
            )
            # result es "UPDATE N"
            deprecated_count = int(result.split()[-1]) if result.startswith("UPDATE") else 0

    log.info("settings.sync.complete",
             upserted=inserted_or_updated, deprecated=deprecated_count)
    return {"upserted": inserted_or_updated, "deprecated": deprecated_count}
