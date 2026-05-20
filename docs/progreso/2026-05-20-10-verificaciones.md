# Verificaciones

Estado: registro acumulado.

## Checks ejecutados durante el avance

Frontend:

```bash
npm run typecheck
npm run lint
npm run build
npm audit --omit=dev
```

Supabase local:

```bash
supabase db reset --local
supabase db lint --local --schema public --fail-on warning
supabase test db --local supabase/tests/auth_claims_rls_test.sql
supabase test db --local supabase/tests/invite_only_onboarding_test.sql
supabase test db --local supabase/tests/documents_upload_flow_test.sql
```

Supabase remoto:

```bash
supabase db push
supabase migration list
```

## Estado de migraciones remotas

Aplicadas en remoto:

- `20260520145128_initial_remote_schema.sql`
- `20260520145604_core_multitenant_schema.sql`
- `20260520150959_auth_jwt_claims.sql`
- `20260520155323_invite_only_onboarding.sql`
- `20260520160911_public_invite_rpc_wrappers.sql`
- `20260520164528_documents_upload_flow.sql`

## Observaciones

- Los warnings de env vars Google en comandos locales aparecen porque mi proceso
  de shell no tiene esos valores exportados. No bloquean tests ni migraciones.
- `.env.local` tiene secrets locales y no debe commitearse.
- El Browser plugin no expuso `node_repl`; para UI se usó Playwright local como fallback.
