# Auth, Tenants Y RLS

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

`lib/session.ts` define la forma esperada:

```text
sub
email
tenant_id
tenant_role
tenant_slug
tenant_status
user_status
claims_version
```

Los claims pueden venir en raiz del JWT o en `app_metadata`. Por eso
`getClaimValue()` mira ambas ubicaciones.

## RLS

Las funciones base viven en las migraciones:

```text
app.current_tenant_id()
app.current_tenant_role()
app.is_tenant_admin()
```

Las politicas filtran por tenant en:

- `tenants`
- `roles`
- `users`
- `documents`
- `doc_tree`
- `chunks`
- `conversations`
- `messages`
- `langgraph_checkpoints`
- `audit_log`
- `tenant_invites`
- `indexing_runs`
- `indexing_events`
- `document_extractions`
- `document_extraction_artifacts`

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

