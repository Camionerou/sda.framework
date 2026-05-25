-- Wave 0 fix descubierto durante E2E (commit 3107b4c):
-- Migration 004 originalmente declaraba `unique (key, scope_type, scope_value)`,
-- pero Postgres por default trata NULLs como distintos. Para settings con
-- scope_type='global' y scope_value=NULL, cada sync_registry_to_db boot insertaba
-- filas duplicadas en vez de upsertear. Fix: agregar NULLS NOT DISTINCT.

alter table app_settings
  drop constraint app_settings_key_scope_type_scope_value_key;

alter table app_settings
  add constraint app_settings_key_scope_type_scope_value_key
  unique nulls not distinct (key, scope_type, scope_value);

-- Limpieza de duplicados acumulados antes de este fix:
-- Mantener la fila más nueva por (key, scope_type, scope_value) — usa updated_at desc.
with ranked as (
  select id,
         row_number() over (
           partition by key, scope_type, scope_value
           order by updated_at desc, id desc
         ) as rn
    from app_settings
   where scope_value is null
)
delete from app_settings
 where id in (select id from ranked where rn > 1);
