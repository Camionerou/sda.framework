# JWT Claims Hook

Estado: listo y testeado.

## Hecho

- Se agregó custom access token hook en Supabase Auth.
- El hook lee `public.users` y `public.tenants`.
- El JWT ahora puede incluir:
  - `tenant_id`
  - `tenant_role`
  - `tenant_slug`
  - `tenant_status`
  - `user_status`
  - `claims_version`
- Los mismos datos se reflejan en `app_metadata`.
- Si el usuario no tiene tenant activo, el hook limpia claims stale.

## Archivos relevantes

- `supabase/migrations/20260520150959_auth_jwt_claims.sql`
- `supabase/tests/auth_claims_rls_test.sql`

## Verificación

- pgTAP cubre hook, claims y RLS base.
- El login real del owner confirmó claims con tenant después de aceptar invite.
