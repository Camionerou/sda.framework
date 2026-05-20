# Sign-out prefetch fix

Estado: corregido.

## Problema

Al entrar a secciones como invitaciones, la app podia terminar en `/login`.
Los logs de Vercel mostraron requests a:

```text
GET /auth/sign-out
```

justo antes de volver a login.

## Causa

El topbar usaba `next/link` para la accion `Salir`. Esa ruta tiene efecto de
cerrar sesion por GET. En produccion, `next/link` puede prefetch/navegar links
visibles y eso no es seguro para una ruta con side effects.

## Fix

- `Salir` ahora usa `<a href="/auth/sign-out">` en vez de `next/link`.
- `next/link` queda reservado para navegacion segura.
- Gotcha documentado en `docs/gotchas.md`.

## Verificacion esperada

- Entrar a `/app`.
- Clickear `Invitaciones`.
- La app debe permanecer autenticada y mostrar la pantalla de invitaciones o
  permisos insuficientes, no `/login`.
