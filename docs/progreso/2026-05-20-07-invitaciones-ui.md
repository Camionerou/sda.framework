# UI de Invitaciones

Estado: listo y visible en la app.

## Hecho

- Se agregó pantalla:

```text
/app/invites
```

- Permite a owner/admin:
  - listar invitaciones
  - crear invitación por email
  - elegir rol
  - elegir expiración
  - copiar link de invite
  - revocar invites pendientes
- La barra superior ahora navega entre consola e invitaciones.

## Archivos relevantes

- `app/app/invites/page.tsx`
- `app/app/invites/actions.ts`
- `components/invites/invite-create-form.tsx`
- `components/dashboard/app-topbar.tsx`

## Seguridad

- La UI usa los RPC públicos, que delegan a funciones seguras.
- RLS limita lectura de invites a admins/owners del tenant.
- El token raw no se guarda en DB.
