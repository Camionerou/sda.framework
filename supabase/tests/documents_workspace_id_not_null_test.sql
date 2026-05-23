BEGIN;
SELECT plan(5);

SELECT col_not_null(
  'public', 'documents', 'workspace_id',
  'documents.workspace_id is now NOT NULL'
);

-- FK validada (no `not valid`)
SELECT is(
  (select convalidated from pg_constraint
   where conname = 'documents_workspace_fk'),
  true,
  'documents_workspace_fk is validated'
);

-- Indice de hot path en (tenant_id, workspace_id, status, created_at desc)
SELECT has_index(
  'public', 'documents', 'documents_workspace_status_idx',
  'documents has composite hot-path index'
);

-- Indice de soft-delete
SELECT has_index(
  'public', 'documents', 'documents_deleted_at_idx',
  'documents has deleted_at partial index'
);

-- Insertar un documento sin workspace_id falla
insert into public.tenants (id, slug, name)
values ('00000000-0000-0000-0000-000000003501', 'nn-tenant', 'NN Tenant');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000003511',
  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'nn@nn.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.users (id, tenant_id, email, role, status)
values ('00000000-0000-0000-0000-000000003511',
  '00000000-0000-0000-0000-000000003501', 'nn@nn.test', 'member', 'active');

SELECT throws_ok(
  $$ insert into public.documents (id, tenant_id, created_by, filename, r2_key, status)
       values ('00000000-0000-0000-0000-000000003521',
               '00000000-0000-0000-0000-000000003501',
               '00000000-0000-0000-0000-000000003511',
               'nn.pdf',
               '00000000-0000-0000-0000-000000003501/00000000-0000-0000-0000-000000003521/nn.pdf',
               'uploaded') $$,
  '23502',
  NULL,
  'documents rejects NULL workspace_id after 031.c'
);

SELECT * FROM finish();
ROLLBACK;
