# Invitaciones sin expiracion

Estado: implementado y migrado.

## Hecho

- `tenant_invites.expires_at` ahora puede ser `null`.
- La validacion de expiracion acepta:
  - fecha futura;
  - `null` para invitaciones sin vencimiento.
- `accept_tenant_invite` solo rechaza por vencimiento cuando `expires_at` tiene
  valor.
- `create_tenant_invite` mantiene default de 7 dias para roles normales cuando
  no se envia expiracion.
- Las invitaciones `owner` creadas por `service_role` quedan sin expiracion por
  default.
- Las invitaciones creadas desde una sesion `owner` quedan sin expiracion por
  default.
- La UI de invitaciones permite elegir `Sin expiración` y la muestra como
  default para owners.
- El script `bootstrap-owner-invite` crea invites owner sin expiracion por
  default.
- El login ya no muestra `NEXT_REDIRECT` cuando detecta una sesion activa; el
  redirect a `/app` queda fuera del `try/catch`.

## Verificacion

- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `supabase migration up --local`
- `supabase test db --local supabase/tests/invite_only_onboarding_test.sql`
- `supabase db push --linked --yes`

## Nota

`INVITE_TTL_HOURS` queda vacio en `.env.example` para owner bootstrap. Si se
quiere forzar vencimiento, usar un numero positivo de horas. Si se quiere dejar
sin vencimiento explicitamente, usar `never`, `none` o `null`.
