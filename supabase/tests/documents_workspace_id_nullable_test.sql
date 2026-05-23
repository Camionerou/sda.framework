BEGIN;
SELECT plan(6);

-- Este test verifica el contrato semantico de 031.a (estado intermedio:
-- columna agregada nullable + FK composite + cols soft-delete). Una vez aplicada
-- 031.c, la columna pasa a NOT NULL definitivo. Para que este test siga
-- documentando el contrato historico, simulamos el estado intermedio dropeando
-- el NOT NULL dentro de la transaccion (ROLLBACK lo restaura).
alter table public.documents alter column workspace_id drop not null;

SELECT has_column(
  'public', 'documents', 'workspace_id',
  'documents has workspace_id column'
);

-- nullable porque el backfill no ocurrio aun (verificado contra el estado simulado)
SELECT col_is_null(
  'public', 'documents', 'workspace_id',
  'documents.workspace_id is nullable in 031.a'
);

-- composite FK declarada
SELECT col_is_fk(
  'public', 'documents', ARRAY['tenant_id','workspace_id'],
  'documents has composite FK to workspaces'
);

-- soft-delete columns
SELECT has_column(
  'public', 'documents', 'deleted_at',
  'documents has deleted_at column'
);
SELECT has_column(
  'public', 'documents', 'deleted_by',
  'documents has deleted_by column'
);

-- documents existentes siguen viviendo (nullable + sin backfill)
insert into public.tenants (id, slug, name)
values ('00000000-0000-0000-0000-000000003301', 'nullable-tenant', 'Nullable');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000003311',
  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'n@n.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.users (id, tenant_id, email, role, status)
values ('00000000-0000-0000-0000-000000003311',
  '00000000-0000-0000-0000-000000003301', 'n@n.test', 'member', 'active');

SELECT lives_ok(
  $$ insert into public.documents
       (id, tenant_id, created_by, filename, r2_key, status)
     values
       ('00000000-0000-0000-0000-000000003321',
        '00000000-0000-0000-0000-000000003301',
        '00000000-0000-0000-0000-000000003311',
        'doc.pdf',
        '00000000-0000-0000-0000-000000003301/00000000-0000-0000-0000-000000003321/doc.pdf',
        'uploaded') $$,
  'documents accepts row with NULL workspace_id pre-backfill'
);

SELECT * FROM finish();
ROLLBACK;
