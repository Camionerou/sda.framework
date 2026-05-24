begin;
select plan(8);

-- columnas nuevas
select has_column('public', 'documents', 'deleted_at',
  'documents.deleted_at existe');
select col_type_is('public', 'documents', 'deleted_at', 'timestamp with time zone',
  'documents.deleted_at es timestamptz');
select col_is_null('public', 'documents', 'deleted_at',
  'documents.deleted_at es nullable');
select has_column('public', 'documents', 'deleted_by',
  'documents.deleted_by existe');

-- indice partial
select has_index('public', 'documents', 'documents_deleted_at_idx',
  'indice partial sobre deleted_at existe');

-- RPCs nuevas declaradas (placeholder; se prueban en Paso 16)
select has_function('public', 'archive_document', array['uuid','jsonb'],
  'public.archive_document declarada');
select has_function('public', 'restore_document', array['uuid','jsonb'],
  'public.restore_document declarada');

-- cleanup_operational_data acepta nuevo parametro
select has_function('public', 'cleanup_operational_data',
  array['interval','interval','interval','interval'],
  'cleanup_operational_data acepta _soft_delete_retention');

select * from finish();
rollback;
