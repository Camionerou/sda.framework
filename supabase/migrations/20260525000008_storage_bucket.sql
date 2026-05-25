-- Wave 0: bucket 'docs' private + RLS abierta (sin multi-tenancy en Wave 0)
-- Spec ref: §4 Wave 0 deliverables

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'docs',
  'docs',
  false,
  524288000,  -- 500MB max
  array['application/pdf', 'text/markdown', 'text/plain']
)
on conflict (id) do nothing;

-- En Wave 0 sin auth: permitir todo a service_role (admin uploads).
-- RLS proper se agrega con spec multi-tenancy.
create policy "service_role full access to docs bucket"
  on storage.objects for all
  to service_role
  using (bucket_id = 'docs')
  with check (bucket_id = 'docs');
