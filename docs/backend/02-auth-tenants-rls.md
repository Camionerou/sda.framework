# Auth, Tenants Y RLS

Este doc cubre login, invitaciones y forma del JWT. El detalle de RLS,
helpers `app.*`, visibilidad por workspace/collection y patrones para nuevas
tablas vive en [`12-rls-patterns.md`](./12-rls-patterns.md). El modelo de
workspaces/collections/groups vive en
[`11-workspaces-collections-groups.md`](./11-workspaces-collections-groups.md).

## Login

El login usa Supabase Auth con Google OAuth.

Piezas:

- `app/login/page.tsx`: pantalla de ingreso.
- `components/auth/google-login-button.tsx`: inicia OAuth.
- `app/auth/callback/route.ts`: intercambia `code` por sesion.
- `proxy.ts` + `lib/supabase/proxy.ts`: refrescan cookies de Supabase.
- `app/auth/sign-out/route.ts`: cierre de sesion.

La app es invite-only. Un usuario autenticado sin tenant puede existir, pero no
opera datos hasta aceptar una invitacion.

## Invitaciones

Superficie:

- UI: `app/app/invites/page.tsx`.
- Server actions: `app/app/invites/actions.ts`.
- RPCs publicas: `create_tenant_invite`, `accept_tenant_invite`, `revoke_tenant_invite`.
- Tabla: `tenant_invites`.

Reglas:

- Owners y admins crean invitaciones normales.
- Owner invites de bootstrap pueden salir con service role.
- El token raw solo viaja en el link; la DB guarda `token_hash`.
- Al aceptar una invitacion, el callback refresca la sesion para que el JWT
  tenga `tenant_id` y `tenant_role`.

## Claims

`lib/auth/session.ts` define la forma esperada:

```text
sub
email
tenant_id
tenant_role
tenant_slug
tenant_status
user_status
claims_version
active_workspace_id     -- v2, Tier 1
active_workspace_role   -- v2, Tier 1
```

Los claims pueden venir en raiz del JWT o en `app_metadata`. Por eso
`getClaimValue()` mira ambas ubicaciones. El hook v2 (migracion
`auth_jwt_claims_v2`) inyecta `claims_version=2` y los campos
`active_workspace_*`. Detalle en
[`11-workspaces-collections-groups.md`](./11-workspaces-collections-groups.md)
y [`12-rls-patterns.md`](./12-rls-patterns.md).

## RLS

La frontera de seguridad sigue siendo Postgres RLS. Helpers, politicas,
patrones de visibilidad triple (tenant + workspace + collection) y guia para
agregar tablas nuevas viven en [`12-rls-patterns.md`](./12-rls-patterns.md).

## Frontera de seguridad

Cliente autenticado:

- Usa anon/publishable key.
- Lee/escribe solo lo permitido por RLS.
- Ejecuta RPCs invoker/definer pensadas para usuario.

Backend confiable:

- Usa `SUPABASE_SERVICE_ROLE_KEY`.
- Solo en workers, scripts operativos o funciones server-side controladas.
- Escribe estados de indexacion, artefactos y cierres de corrida.

Regla practica: si el dato depende del tenant del usuario, preferir Supabase
con RLS antes que filtros manuales en memoria.
