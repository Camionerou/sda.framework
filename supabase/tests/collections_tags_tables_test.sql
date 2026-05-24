BEGIN;
SELECT plan(16);

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

SELECT * FROM finish();
ROLLBACK;
