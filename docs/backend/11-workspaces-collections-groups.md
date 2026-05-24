# Workspaces, Collections y Groups (Tier 1)

Tier 1 introduce la jerarquia organizacional encima del tenant. Antes el tenant
era el unico contenedor; ahora un tenant puede tener varios `workspaces`, cada
uno con sus `collections` y documentos. Los `groups` son transversales al
tenant y se usan para asignar permisos en bloque.

## Jerarquia

```text
tenant
  ├─ workspaces                       (contenedor de documentos)
  │    ├─ collections                  (carpeta logica dentro del workspace)
  │    │    └─ document_collections    (N:M document <-> collection)
  │    └─ documents                    (workspace_id NOT NULL)
  │
  └─ groups                            (transversal, sin jerarquia)
       └─ group_memberships            (user -> group)

workspace_memberships
  ├─ principal_kind = 'user'           (user directo)
  └─ principal_kind = 'group'          (grupo entero hereda el rol)
```

Notas clave:

- `documents.workspace_id` es **NOT NULL** desde la migracion 031.c. Todo doc
  vive en exactamente un workspace.
- Una collection pertenece a un solo workspace (`collections.workspace_id`).
- Un grupo no tiene rol propio: el rol vive en `workspace_memberships.role`
  cuando el grupo se asigna como principal de un workspace.

## Visibilidad de Collections

`collections.visibility` es un enum:

| Valor                | Quien la ve                                          |
| -------------------- | ---------------------------------------------------- |
| `workspace_private`  | (default) solo miembros del workspace + tenant admin |
| `tenant_public`      | todo el tenant la ve y puede leer sus documentos     |

La resolucion de acceso a un documento es OR de tres reglas (ver
`app.user_can_read_document` en `12-rls-patterns.md`):

1. El user es admin del tenant (`tenant_role in ('admin','owner')`).
2. El user es miembro del workspace home del documento (directo o via grupo).
3. El documento esta en al menos una collection con `visibility = 'tenant_public'`
   (la collection actua como puerta tenant-wide hacia ese documento).

La regla 3 es la unica forma de exponer un documento fuera de su workspace home
sin moverlo. Mover el documento (`public.move_document`) tampoco abre la
visibilidad: lo lleva a otro workspace home, y ahi vuelven a aplicar las
reglas.

## Roles en workspace

`public.workspace_role` es un enum **declarado low-to-high**:

```sql
create type public.workspace_role as enum (
  'workspace_viewer',
  'workspace_editor',
  'workspace_admin'
);
```

El orden de declaracion del enum define el orden de comparacion en Postgres.
Lo aprovechamos para resolver el "rol efectivo" cuando un user es miembro
directo **y** miembro via grupo en el mismo workspace:

```sql
select role
from (
  select role from workspace_memberships where principal_kind='user' and ...
  union all
  select role from workspace_memberships where principal_kind='group' and ...
) r
order by role desc
limit 1
```

Postgres no tiene `max(enum)`, asi que `order by role desc limit 1` cumple la
funcion. Esto vive en `app.user_workspace_role(_workspace_id)`.

Precedencia con `tenant_role`:

- `tenant_role` in (`admin`, `owner`) **bypassan** workspace membership. Un
  admin del tenant tiene acceso de lectura y edicion sobre todos los workspaces
  del tenant sin necesidad de aparecer en `workspace_memberships`. Esto se
  refleja en cada helper `app.user_can_*` con el `(select app.is_tenant_admin())`
  como primer check.
- Para el resto de los `tenant_role` (`member`, `viewer`, etc.), la unica via
  de acceso es ser miembro del workspace o ver la collection `tenant_public`.

## Groups y membership polimorfico

`workspace_memberships.principal_kind` puede valer `'user'` o `'group'`. El
identificador del principal vive en la misma columna (`principal_id uuid`),
sin FK declarada — Postgres no soporta FK polimorficas que apunten a tablas
distintas segun una discriminante.

Para evitar uuids fantasma o membresias cross-tenant, la migracion 030.c
instala el trigger:

```sql
create trigger check_workspace_membership_principal
before insert or update of principal_kind, principal_id, tenant_id
on public.workspace_memberships
for each row execute function app.check_workspace_membership_principal();
```

El trigger valida que:

1. Si `principal_kind = 'user'`: existe en `public.users` y `users.tenant_id`
   matchea con `workspace_memberships.tenant_id`.
2. Si `principal_kind = 'group'`: existe en `public.groups`, no esta
   soft-deleted, y `groups.tenant_id` matchea.

Sin este trigger se podria asignar un grupo de otro tenant como principal en
nuestro workspace. Es la red de seguridad obligatoria del modelo polimorfico.

## Documentos y workspaces

`documents.workspace_id NOT NULL` desde 031.c. Implicaciones:

- **Upload nuevo**: `public.create_document_upload` exige `_workspace_id`
  explicito y verifica `app.user_workspace_role(...) in ('editor','admin')`.
- **Mover documento**: `public.move_document(_document_id, _to_workspace_id, _collection_ids, _request_context)`
  requiere permiso de **edit en source** (`user_can_edit_document`) **Y**
  rol editor/admin en el **destination**. Si pasa una lista de
  `_collection_ids`, reemplaza la lista actual; si pasa `null`, las preserva.
- **Lineage de la pipeline de indexacion** (chunks, doc_tree, extractions,
  routing) **no cambia al mover**. Las policies de esas tablas filtran por
  `tenant_id` y joinean a `documents` para chequear visibilidad; mover el doc
  cambia el workspace home pero no rompe el lineage. La unica precaucion: si
  el destino esta en otro workspace donde el user no edita, perdera acceso a
  la pipeline en curso del documento (consistente con el modelo).

## Gotcha de `tenant_public`

Cambiar la visibility de una collection a `tenant_public` la abre a **todo el
tenant**, no a usuarios especificos. Cualquier documento que este en esa
collection se vuelve legible para cualquier miembro del tenant (con cualquier
`tenant_role`).

La RPC `public.set_collection_visibility(_collection_id, _new_visibility, _request_context)`
ya emite un audit_log con accion `collection.visibility_changed` (ver
`13-audit-log-conventions.md`). Ademas un trigger automatico
(`app.audit_collection_visibility_change`) duplica la entrada para que
cualquier UPDATE directo via service_role tambien quede registrado.

Requerimiento de UX:

- La UI debe pedir **confirmacion explicita** antes de cambiar a `tenant_public`
  mostrando el numero de documentos afectados y la lista de tenants viewers
  que ganaran acceso (basicamente: "este cambio abre N documentos a M personas
  fuera del workspace").
- El cambio en reverso (`tenant_public -> workspace_private`) tambien dispara
  el audit pero no requiere confirmacion equivalente (cierra acceso, no abre).

Para auditar quien abrio una collection y cuando:

```sql
select created_at, actor_id, metadata
from public.audit_log
where action = 'collection.visibility_changed'
  and resource_id = '<collection_id>'
order by created_at desc;
```

El payload incluye `from`, `to`, y `workspace_id` para que un dashboard pueda
filtrar por sensibilidad del cambio.
