# RLS Patterns y Helpers (Tier 1)

Toda decision de visibilidad en SDA vive en RLS. Las RPCs `security definer`
existen para mutaciones controladas, pero el SELECT del cliente con anon key
pasa por las policies — si la policy esta floja, el dato se filtra. Este
documento fija el patron canonico y cataloga los helpers `app.*` disponibles.

## Pattern canonico

```sql
alter table public.foo enable row level security;

create policy foo_select_visible on public.foo
  for select to authenticated
  using (
    tenant_id = (select app.current_tenant_id())
    and deleted_at is null
    and (
      (select app.is_tenant_admin())
      or (select app.user_belongs_to_workspace(workspace_id))
    )
  );
```

Detalles importantes:

- **`(select fn())` en lugar de `fn()`**: Postgres reescribe `(select fn())`
  como un init-plan que se evalua **una vez por query**, no una vez por fila.
  Sin el `select`, en tablas grandes con secuencias largas vemos N llamadas a
  `auth.jwt()` o N joins en helpers `security definer`. El subquery convierte
  el costo de O(N) en O(1).
- **`to authenticated`** explicito: las policies sin role aplican a todos,
  incluido `anon`. Limitar a `authenticated` es defensa en profundidad.
- **`tenant_id = ...` siempre primero**: el primer predicado debe podar por
  tenant para usar el indice compuesto y evitar evaluar helpers en filas de
  otros tenants.
- **`deleted_at is null`** explicito en SELECT: los helpers `user_can_*` ya
  filtran soft-deletes, pero replicarlo en la policy del SELECT permite al
  planner usar el indice parcial `where deleted_at is null` y deja la
  invariante visible.

## Catalogo de helpers `app.*`

Todos los helpers viven en el esquema `app`, son `stable`, y los que tocan
tablas con RLS son `security definer` con `search_path = ''`. Las RPCs
`public.*` los invocan; las policies tambien (de ahi el `security definer`,
para evitar recursion al evaluar la policy de la propia tabla que el helper
consulta).

### Lectura de contexto

| Funcion                              | Devuelve              | Proposito                                   |
| ------------------------------------ | --------------------- | ------------------------------------------- |
| `app.current_tenant_id()`            | `uuid`                | lee `auth.jwt() ->> 'tenant_id'`            |
| `app.current_tenant_role()`          | `public.role_key`     | lee `auth.jwt() ->> 'tenant_role'`          |
| `app.current_workspace_id()`         | `uuid`                | lee `active_workspace_id` (hint UI)         |
| `app.is_tenant_admin()`              | `boolean`             | true si `tenant_role in ('admin','owner')`  |

`current_tenant_id` y `current_tenant_role` son `stable language sql`. No
necesitan definer porque solo leen el JWT.

### Resolucion de membership

| Funcion                                                  | Devuelve                | Proposito                                                                                       |
| -------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------- |
| `app.user_belongs_to_workspace(_workspace_id uuid)`      | `boolean`               | true si el user es miembro directo o via grupo                                                  |
| `app.user_workspace_role(_workspace_id uuid)`            | `public.workspace_role` | rol efectivo (max entre directo y via grupos)                                                   |
| `app.user_shares_group(_group_id uuid)`                  | `boolean`               | auxiliar para la policy de `group_memberships` (evita recursion al consultar la propia tabla)   |

`user_workspace_role` aprovecha que el enum `workspace_role` se declaro
low-to-high y resuelve via `order by role desc limit 1` sobre el `UNION ALL`
de membership directo + membership via grupo. Ver `11-workspaces-collections-groups.md`.

### Permisos por documento

| Funcion                                       | Devuelve   | Proposito                                                                |
| --------------------------------------------- | ---------- | ------------------------------------------------------------------------ |
| `app.user_can_read_document(_document_id uuid)` | `boolean`  | admin tenant OR miembro workspace OR documento en collection `tenant_public` |
| `app.user_can_edit_document(_document_id uuid)` | `boolean`  | admin tenant OR `workspace_role in ('editor','admin')`                   |

`user_can_read_document` es la formalizacion de la "regla triple" de
visibilidad de Tier 1. Filtra `deleted_at is null` internamente.

### Permisos por conversacion (legacy)

| Funcion                                              | Devuelve  | Proposito                                                                |
| ---------------------------------------------------- | --------- | ------------------------------------------------------------------------ |
| `app.can_access_conversation(_conversation_id uuid)` | `boolean` | mismo patron de combinacion para el schema legacy de conversations       |

Se conserva por compatibilidad con el chat agent. Patron identico (tenant + dueno).

## Construir una policy nueva

Checklist obligatoria al agregar una tabla con datos sensibles:

1. **Habilitar RLS** primero, sin policies. Esto hace que `select` retorne 0
   filas hasta que las policies existan. Es la base segura.
   ```sql
   alter table public.nueva enable row level security;
   ```
2. **Policy `for select to authenticated`** con `tenant_id = (select app.current_tenant_id())`
   como primer predicado.
3. **Combinar visibilidad con helpers** segun el modelo (workspace, collection,
   document, etc.). Reusar `app.user_*` antes de inline SQL.
4. **Wrappear cada llamada a helper en `(select ...)`** para forzar init-plan.
5. **Mutaciones via RPC `security definer`**: no escribir `for insert/update/delete`
   policies a menos que sea estrictamente necesario. El patron en SDA es
   revoke INSERT/UPDATE/DELETE a `authenticated` y exponer una RPC.
6. **Tests pgTAP** con al menos 4 escenarios:
   - **Positivo**: user autorizado ve la fila.
   - **Negativo**: user del mismo tenant sin permiso no la ve.
   - **Cross-tenant**: user de otro tenant no la ve.
   - **Soft-delete**: con `deleted_at not null` no aparece, incluso para admin.

## JWT como hint, no autoridad

El JWT trae estos claims (ver `lib/auth/session.ts`):

```text
sub, email
tenant_id, tenant_role, tenant_slug, tenant_status
user_status, claims_version
active_workspace_id, active_workspace_role    -- v2, Tier 1
```

`active_workspace_id` y `active_workspace_role` los inyecta el hook
`app.custom_access_token_hook` cuando el cliente setea
`user_metadata.active_workspace_id` via `supabase.auth.updateUser({ data: { ... } })`.
El hook valida que el user es realmente miembro del workspace antes de
escribir el claim — si el cliente miente, el claim sale ausente.

**Pero**: ese claim **no es autoridad**. Las policies y los helpers nunca
confian en `active_workspace_role`. Para cada query:

- La policy llama a `app.user_belongs_to_workspace(workspace_id)`.
- El helper joinea contra `workspace_memberships` y `group_memberships` en
  vivo, no contra el JWT.

Consecuencia: si entre dos requests el admin del tenant quita al user del
workspace, el siguiente request **falla** aunque el JWT siga diciendo
`active_workspace_role = 'workspace_editor'`. El JWT no se invalida hasta el
refresh, y eso esta bien — la verificacion real esta en RLS.

`active_workspace_role` en el JWT existe solo para que la UI muestre el badge
correcto sin un round-trip extra. Si la UI necesita la verdad fresca, llama
a la RPC correspondiente o relee la tabla.

## Tests pgTAP por policy

Patron general:

```sql
-- 1) preparar dos tenants, dos users, workspace en cada uno
insert into public.tenants ...;
insert into public.users ...;
insert into public.workspaces ...;
insert into public.workspace_memberships ...;

-- 2) levantar JWT mock para user A
select set_config('request.jwt.claims',
  jsonb_build_object(
    'sub', '<uuid-A>',
    'tenant_id', '<tenant-A>',
    'tenant_role', 'member',
    'active_workspace_id', '<ws-A>'
  )::text,
  true
);
set local role authenticated;

-- 3) caso positivo
select results_eq(
  $$ select count(*) from public.documents where id = '<doc-A>' $$,
  $$ values (1::bigint) $$,
  'user A ve su documento'
);

-- 4) caso negativo cross-tenant (cambiar JWT)
select set_config('request.jwt.claims',
  jsonb_build_object('sub','<uuid-B>','tenant_id','<tenant-B>','tenant_role','member')::text,
  true
);
select is_empty(
  $$ select id from public.documents where id = '<doc-A>' $$,
  'user B no ve el doc del tenant A'
);
```

Tests de referencia ya existentes en `supabase/tests/`:

- `auth_claims_rls_test.sql` — claims base + tenant isolation.
- `auth_jwt_claims_v2_test.sql` — hook v2 con `active_workspace_id`.
- `documents_rls_visibility_test.sql` — triple regla de visibilidad para
  documents (admin, member, tenant_public).
- `workspaces_groups_rls_baseline_test.sql` — policies de workspaces +
  memberships.
- `rls_helpers_app_test.sql` — coverage de todos los helpers `app.*`.

Cuando agregues una tabla nueva, copiar el shape de uno de estos archivos.
Mantenelos chiquitos y enfocados: un archivo de test = una migracion.

## Gotchas frecuentes

- **Loop infinito al usar un helper que consulta la propia tabla**: si la
  policy de `foo` llama a un helper que hace `select from foo`, sin
  `security definer` se cuelga (la subquery reevalua la policy). Solucion:
  marcar el helper `security definer` + `set search_path = ''`.
- **`(select fn())` se evalua una vez por query**: si necesitas el valor por
  fila (raro), usar `fn()` directo. Pero el 99% de los casos en SDA quieren
  init-plan.
- **Olvidar `deleted_at is null`**: aparece en queries de listado donde la UI
  pide "todos los X visibles". Si la policy no filtra soft-deletes, el
  service_role los ve pero el cliente no — inconsistencia entre dashboards y
  jobs. Replicarlo siempre.
- **Cambiar el JWT en una sola conexion pgTAP**: usar
  `set_config('request.jwt.claims', ..., true)` con el flag `true` para
  hacerlo `local` a la transaccion. Sin el `true`, el setting persiste y
  rompe tests posteriores.
- **`set local role authenticated`**: imprescindible despues del JWT mock.
  Sin esto la query corre como `postgres` y bypassa RLS completamente.
