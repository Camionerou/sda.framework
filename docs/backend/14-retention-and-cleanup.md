# Retention Policies y Cleanup Operacional (Tier 1)

Las tablas operacionales (audit, events, soft-deletes, invitaciones revocadas)
crecen indefinidamente si nadie las poda. Tier 1 centraliza la retencion en
una sola funcion `public.cleanup_operational_data(...)` que se corre por cron
diario. Este documento lista que se podan, con que ventana, y como ajustarlo
sin redeploy.

## Tablas con retention

| Tabla                                           | Politica                                | Retention default | Mecanismo                       |
| ----------------------------------------------- | --------------------------------------- | ----------------- | ------------------------------- |
| `tenant_invites` (`status = 'revoked'`)         | hard-delete si `updated_at` antiguo     | 90 dias           | `cleanup_operational_data`      |
| `indexing_events`                               | hard-delete si `created_at` antiguo     | 6 meses           | `cleanup_operational_data`      |
| `audit_log`                                     | hard-delete si `created_at` antiguo     | 2 anos            | `cleanup_operational_data`      |
| `documents` (con `deleted_at not null`)         | hard-delete si soft-deleted hace tiempo | 30 dias           | `cleanup_operational_data`      |
| `workspaces` (con `deleted_at not null`)        | hard-delete                             | 30 dias           | `cleanup_operational_data`      |
| `collections` (con `deleted_at not null`)       | hard-delete                             | 30 dias           | `cleanup_operational_data`      |
| `groups` (con `deleted_at not null`)            | hard-delete                             | 30 dias           | `cleanup_operational_data`      |
| `tags` (con `deleted_at not null`)              | hard-delete                             | 30 dias           | `cleanup_operational_data`      |

Las invitaciones `revoked` se podan porque son ruido operacional; las
`pending` o `accepted` se conservan (la fila documenta la relacion). Para
`indexing_events` los 6 meses son suficientes para auditoria de pipeline; el
analisis a largo plazo va via dashboards externos que ya consumen los eventos.

## `cleanup_operational_data` signature

```sql
public.cleanup_operational_data(
  _revoked_invites_retention interval default '90 days'::interval,
  _indexing_events_retention interval default '6 months'::interval,
  _audit_log_retention       interval default '2 years'::interval,
  _soft_delete_retention     interval default '30 days'::interval
) returns jsonb
```

Cualquiera puede correrla; el `revoke all from anon, authenticated, public` +
`grant execute to service_role` la restringe a workers / cron / Supabase
service role.

El return es un `jsonb` con contadores:

```json
{
  "audit_log_deleted": 1234,
  "indexing_events_deleted": 4567,
  "revoked_invites_deleted": 8,
  "documents_hard_deleted": 12,
  "workspaces_hard_deleted": 0,
  "collections_hard_deleted": 2,
  "groups_hard_deleted": 0,
  "tags_hard_deleted": 5
}
```

Util para logs / dashboards / alertas (si un contador queda en 0 por
demasiados dias, puede indicar que el cron no esta corriendo).

Internamente la funcion es lineal: 8 DELETE consecutivos en una sola
transaccion implicita, con `get diagnostics row_count` para acumular el
contador y un `jsonb_build_object` final. Sin paginacion: las cantidades
diarias son chicas y los indices parciales sobre `deleted_at not null`
hacen los DELETE eficientes.

## Schedule

Cron diario via `pg_cron`:

```text
0 4 * * *   -- 4 AM UTC, fuera de horas pico
```

Se llama:

```sql
select public.cleanup_operational_data();
```

Sin argumentos para usar defaults. La migracion que lo instala via
`cron.schedule(...)` queda como deuda menor de Tier 1; mientras tanto la
funcion se puede correr a mano desde una sesion service_role o desde un job
Inngest scheduled. **Pendiente**: agregar migracion
`schedule_cleanup_operational_data.sql` con el `cron.schedule`.

## Soft-delete pattern

Tablas que soportan soft-delete (todas con columna `deleted_at timestamptz`):

- `public.documents`
- `public.workspaces`
- `public.collections`
- `public.groups`
- `public.tags`

Reglas:

1. **RLS excluye `deleted_at not null`** del SELECT. Una fila soft-deleted es
   invisible para el cliente, incluso si es admin (para que reapparezca,
   pasar por la RPC `restore_*`).
2. **Helpers `app.user_can_*`** filtran tambien `deleted_at is null`, asi el
   permiso evalua false para filas borradas.
3. **Mutacion**: las RPCs `archive_*` / `delete_*` setean `deleted_at = now()`
   y `deleted_by = auth.uid()`. La fila queda en la tabla, fuera de la
   visibilidad del cliente, hasta que el cron la hard-deletee tras los 30
   dias default.
4. **Restore**: la RPC `restore_*` setea `deleted_at = null` y `deleted_by = null`.
   Si pasaron mas de 30 dias y el cron ya corrio, la fila no existe y el
   restore falla con NOT FOUND — comportamiento esperado.
5. **Cascadas**: los FKs cascadean en hard-delete. Mientras la fila esta
   soft-deleted las FKs siguen apuntando, asi que un documento soft-deleted
   con sus `document_collections` queda completo en la DB hasta el hard-delete.

Aplicable a tablas Tier 2/3 nuevas: cualquier recurso editable por el usuario
final deberia tener `deleted_at` + RPC archive/restore + entrada en
`cleanup_operational_data` con el mismo retention de 30 dias.

## Ajustar retention sin redeploy

La funcion acepta override por argumento. Ejemplos:

```sql
-- pasada agresiva una sola vez (purgar todo el ruido viejo)
select public.cleanup_operational_data(
  interval '60 days',     -- invites revoked
  interval '3 months',    -- indexing_events
  interval '1 year',      -- audit_log
  interval '7 days'       -- soft-deletes
);

-- conservar audit log por compliance extra largo
select public.cleanup_operational_data(
  interval '90 days',
  interval '6 months',
  interval '7 years',
  interval '30 days'
);
```

Si el cambio es permanente, modificar el cron entry para pasar los argumentos
fijos. Si es transicional (purga puntual), correrla a mano. **No hay que
redeployar la funcion**; los defaults son hint, los argumentos mandan.

## Particionado pendiente (Tier 3)

Las tablas append-only y de alto volumen seran particionadas por `created_at`
cuando la carga lo justifique:

- `public.audit_log` — particionado mensual (12 particiones rolling + cold).
- `public.indexing_events` — particionado mensual.
- `public.document_views` (Tier 2/3) — particionado diario o semanal.
- `public.usage_records` (Tier 3, billing) — particionado mensual.
- `public.notifications` (Tier 2) — particionado mensual con drop por
  retention.

Mientras tanto, `cleanup_operational_data` mantiene el tamano acotado con
DELETE + autovacuum. El movimiento a particionado es transparente para el
cliente: misma tabla, misma policy, mismas RPCs.

## Verificacion operativa

Despues de cada corrida del cron, queda registro en los logs de Postgres. Para
verificar el ultimo run desde una consola:

```sql
-- contadores actuales (cuanto material hay para podar)
select
  (select count(*) from public.audit_log
    where created_at < now() - interval '2 years') as audit_log_to_purge,
  (select count(*) from public.indexing_events
    where created_at < now() - interval '6 months') as indexing_events_to_purge,
  (select count(*) from public.documents
    where deleted_at is not null
      and deleted_at < now() - interval '30 days') as documents_to_purge;
```

Si los contadores nunca bajan, el cron no esta corriendo. Si bajan mas de lo
esperado, alguien corrio `cleanup_operational_data` con args mas agresivos
(buscar en `pg_stat_statements`).
