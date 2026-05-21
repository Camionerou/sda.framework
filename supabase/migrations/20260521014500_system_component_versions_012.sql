insert into public.system_component_versions (component, version, description, metadata)
values
  ('app', '0.1.2', 'Next.js application shell and API routes.', '{}'::jsonb),
  ('indexing_pipeline', '0.1.2', 'End-to-end document indexing pipeline.', '{}'::jsonb),
  ('inngest_indexing_workflow', '0.1.2', 'Inngest orchestration for document indexing.', '{}'::jsonb)
on conflict (component) do update
set
  description = excluded.description,
  metadata = excluded.metadata,
  updated_at = now(),
  version = excluded.version;
