# Audit Log Conventions (Tier 1)

`public.audit_log` es la tabla canonica para registrar acciones intencionales
sobre recursos del tenant. Tier 1 estandariza el namespace de `action`, el
patron de `request_context`, y la separacion entre triggers y RPCs.

## Schema

```sql
public.audit_log (
  id            uuid primary key,
  tenant_id     uuid references public.tenants(id),
  actor_id      uuid references auth.users(id),
  action        text not null,                  -- namespace dot-separated
  resource_type text,                            -- ej. 'document', 'workspace'
  resource_id   uuid,
  request_id    text,                            -- corr id del cliente
  ip_address    inet,
  user_agent    text,
  metadata      jsonb not null default '{}',     -- payload + request_context flatten
  created_at    timestamptz not null default now()
)
```

Columnas dedicadas (`request_id`, `ip_address`, `user_agent`) existen para
indexar y filtrar en dashboards sin tener que desempaquetar JSONB. El
contexto crudo igual queda en `metadata->'request_context'` para auditoria
forense.

## Namespace de `action`

Reglas:

- **Dot-separated**, lowercase, ASCII solamente.
- Patron `<recurso>.<verbo>` o `<recurso>.<verbo>_<modifier>`.
- El recurso es singular (`document`, no `documents`).
- El verbo es pasado (`created`, no `create`).

### Listado canonico Tier 1

**Documents**:

- `document.upload_created` — nuevo upload (deduplicacion fallo, blob nuevo).
- `document.upload_deduped` — upload aceptado pero reuso checksum existente.
- `document.archived` — soft-delete via `archive_document`.
- `document.restored` — restaurado desde soft-delete.
- `document.moved` — workspace_id cambio via `move_document`.
- `document.bulk_updated` — patch masivo via `bulk_update_documents`.
- `document.added_to_collection` — link en `document_collections`.
- `document.removed_from_collection` — unlink.
- `document.tagged` — link en `document_tags`.
- `document.untagged` — unlink.

**Workspaces y memberships**:

- `workspace.created`
- `workspace.updated`
- `workspace.archived`
- `workspace.deleted`
- `workspace.member_added` — RPC `add_workspace_member` (alta intencional).
- `workspace.member_removed` — RPC `remove_workspace_member`.
- `workspace.member_role_changed` — RPC `update_workspace_member_role`.
- `workspace.membership_inserted` — **trigger** sobre INSERT directo a
  `workspace_memberships`. Cubre el caso de service_role o migracion que
  bypassa la RPC.
- `workspace.membership_role_changed` — **trigger** sobre UPDATE de `role`.
- `workspace.membership_deleted` — **trigger** sobre DELETE.

Las acciones `workspace.member_*` (sin sufijo `ship_`) vienen de las RPCs:
incluyen `request_context` real. Las `workspace.membership_*` vienen del
trigger: solo tienen `actor_id` y metadata basica. Tener ambas permite
detectar discrepancias (RPC dispara member_added + trigger dispara
membership_inserted; si solo aparece el segundo, alguien escribio por fuera
de la RPC).

**Groups**:

- `group.created`
- `group.updated`
- `group.archived`
- `group.member_added`
- `group.member_removed`

**Collections**:

- `collection.created`
- `collection.updated`
- `collection.archived`
- `collection.visibility_changed` — emitido por la RPC
  `set_collection_visibility` Y por el trigger
  `app.audit_collection_visibility_change`. Misma logica que workspace
  memberships: RPC para acciones intencionales, trigger como red de
  seguridad.

**Tags**:

- `tag.created`
- `tag.updated`

## Pattern `_request_context`

Convencion:

- El cliente arma un objeto JSON con la traza del request actual:
  ```json
  {
    "request_id": "req_abc123",
    "session_id": "sess_xyz",
    "ip": "10.0.0.5",
    "user_agent": "Mozilla/5.0 ...",
    "workspace_id": "uuid-del-workspace-activo"
  }
  ```
- Cada RPC mutadora acepta este bag como ultimo parametro:
  ```sql
  public.archive_document(
    _document_id uuid,
    _request_context jsonb default '{}'::jsonb
  ) returns void
  ```
- Adentro, la RPC delega al helper:
  ```sql
  perform app.audit_with_context(
    'document.archived', 'document', _document_id,
    jsonb_build_object('reason', _reason),
    _request_context
  );
  ```

`app.audit_with_context(_action, _resource_type, _resource_id, _payload, _request_context)`
hace:

1. Mergea `_payload` + `_request_context` flatten en `metadata`.
2. Anida tambien `_request_context` completo bajo `metadata->'request_context'`
   para no perder llaves no canonicas.
3. Popula columnas dedicadas (`request_id`, `ip_address`, `user_agent`).
4. Si `ip` no parsea como `inet`, atrapa la excepcion y persiste el row
   con `metadata.ip_parse_error = true` para no abortar la RPC.

Asi `select metadata->>'request_id'` y `select request_id` devuelven lo
mismo, pero el query con columna dedicada usa indice.

## Triggers vs RPC inserts

Regla:

| Origen          | Cuando usar                                                                  | Limitacion                                                                |
| --------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **RPC**         | Accion intencional del usuario que pasa por un endpoint definido             | El que escribe la RPC debe acordarse de llamar `app.audit_with_context`    |
| **Trigger**     | Cambio detectable a nivel SQL (insert/update/delete columna critica)         | No tiene acceso al `request_context` del cliente, solo a `auth.uid()`     |

Triggers Tier 1 activos:

- `audit_workspace_membership_change` — sobre `workspace_memberships`, captura
  INSERT/UPDATE(role)/DELETE.
- `audit_collection_visibility_change` — sobre `collections`, dispara solo si
  `visibility` cambio.

Usar triggers como red de seguridad complementaria a la RPC, no como
reemplazo. La RPC da la entrada con contexto rico; el trigger detecta
mutaciones por afuera.

## Retention

`audit_log` retiene 2 anos por default. La limpieza la hace
`public.cleanup_operational_data(...)` (ver `14-retention-and-cleanup.md`)
con el argumento `_audit_log_retention interval default '2 years'`.

Para periodos mas largos (compliance), correr la funcion con un interval
mayor desde un cron operativo separado, o exportar mensualmente a object
storage antes del cleanup. Particionado por `created_at` queda diferido a
Tier 3 cuando la tabla crezca.

## Consulta tipica

Buscar todas las acciones sobre un documento:

```sql
select created_at, actor_id, action, request_id, metadata
from public.audit_log
where resource_type = 'document'
  and resource_id = '<doc_id>'
order by created_at desc;
```

Detectar cambios de visibilidad de collections que abrieron a `tenant_public`:

```sql
select created_at, actor_id, resource_id, metadata
from public.audit_log
where action = 'collection.visibility_changed'
  and metadata->>'to' = 'tenant_public'
order by created_at desc
limit 50;
```

Correlacionar por `request_id` de cliente (todas las filas del mismo request):

```sql
select created_at, action, resource_type, resource_id
from public.audit_log
where request_id = 'req_abc123'
order by created_at;
```
