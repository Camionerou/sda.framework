BEGIN;
SELECT plan(18);

SELECT has_type('public', 'collection_visibility', 'collection_visibility enum exists');

SELECT has_table('public', 'collections', 'collections table exists');
SELECT has_table('public', 'document_collections', 'document_collections table exists');
SELECT has_table('public', 'tags', 'tags table exists');
SELECT has_table('public', 'document_tags', 'document_tags table exists');

SELECT col_is_unique(
  'public', 'collections', ARRAY['tenant_id','id'],
  'collections has composite unique (tenant_id, id)'
);
SELECT col_is_unique(
  'public', 'collections', ARRAY['workspace_id','slug'],
  'collections enforces unique slug per workspace'
);

SELECT col_is_fk(
  'public', 'collections', ARRAY['tenant_id','workspace_id'],
  'collections has composite FK to workspaces'
);

SELECT col_is_fk(
  'public', 'document_collections', ARRAY['tenant_id','document_id'],
  'document_collections has composite FK to documents'
);
SELECT col_is_fk(
  'public', 'document_collections', ARRAY['tenant_id','collection_id'],
  'document_collections has composite FK to collections'
);

SELECT col_is_pk(
  'public', 'document_collections', ARRAY['document_id','collection_id'],
  'document_collections PK is (document_id, collection_id)'
);

SELECT col_is_unique(
  'public', 'tags', ARRAY['tenant_id','key'],
  'tags enforces unique key per tenant'
);

SELECT col_is_pk(
  'public', 'document_tags', ARRAY['document_id','tag_id'],
  'document_tags PK is (document_id, tag_id)'
);

SELECT col_is_fk(
  'public', 'document_tags', ARRAY['tenant_id','tag_id'],
  'document_tags has composite FK (tenant_id, tag_id) to tags'
);

-- collection_visibility valores — CAST ::text necesario porque enumlabel es type name
SELECT is(
  ARRAY(SELECT enumlabel::text FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'collection_visibility' ORDER BY e.enumsortorder),
  ARRAY['workspace_private','tenant_public']::text[],
  'collection_visibility has workspace_private and tenant_public'
);

-- RLS enabled
SELECT is(
  (select relrowsecurity from pg_class where oid = 'public.collections'::regclass),
  true,
  'collections has RLS enabled'
);
SELECT is(
  (select relrowsecurity from pg_class where oid = 'public.tags'::regclass),
  true,
  'tags has RLS enabled'
);

-- Setup cross-tenant fixtures
insert into public.tenants (id, slug, name) values
  ('00000000-0000-0000-0000-000000003601', 'ct-alpha', 'CT Alpha'),
  ('00000000-0000-0000-0000-000000003602', 'ct-beta', 'CT Beta');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000003611',
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'a@ct-alpha.test', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.users (id, tenant_id, email, role, status) values
  ('00000000-0000-0000-0000-000000003611',
   '00000000-0000-0000-0000-000000003601', 'a@ct-alpha.test', 'member', 'active');

-- Document en alpha (workspace default ya auto-creado por trigger 031.b)
insert into public.documents
  (id, tenant_id, workspace_id, created_by, filename, r2_key, status, uploaded_at)
values
  ('00000000-0000-0000-0000-000000003621',
   '00000000-0000-0000-0000-000000003601',
   (select id from public.workspaces where tenant_id='00000000-0000-0000-0000-000000003601' and slug='default'),
   '00000000-0000-0000-0000-000000003611',
   'a.pdf',
   '00000000-0000-0000-0000-000000003601/00000000-0000-0000-0000-000000003621/a.pdf',
   'uploaded', now());

-- Tag en beta (otro tenant)
insert into public.tags (id, tenant_id, key, label) values
  ('00000000-0000-0000-0000-000000003631',
   '00000000-0000-0000-0000-000000003602', 'foreign', 'Foreign Tag');

SELECT throws_ok(
  $$ insert into public.document_tags (tenant_id, document_id, tag_id)
     values ('00000000-0000-0000-0000-000000003601',
             '00000000-0000-0000-0000-000000003621',
             '00000000-0000-0000-0000-000000003631') $$,
  '23503',
  NULL,
  'document_tags rejects cross-tenant tag_id'
);

SELECT * FROM finish();
ROLLBACK;
