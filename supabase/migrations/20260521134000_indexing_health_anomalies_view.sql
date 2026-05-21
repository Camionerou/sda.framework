create or replace view public.indexing_health_anomalies
with (security_invoker = true) as
select
  'uploaded_without_active_run'::text as anomaly,
  d.tenant_id,
  d.id as document_id,
  null::uuid as run_id,
  d.filename,
  d.status as document_status,
  null::text as run_status,
  null::text as stage,
  null::integer as progress,
  'Documento uploaded sin corrida activa'::text as message,
  jsonb_build_object(
    'uploaded_at', d.uploaded_at,
    'updated_at', d.updated_at
  ) as metadata,
  d.updated_at
from public.documents d
where d.status = 'uploaded'
  and d.uploaded_at is not null
  and not exists (
    select 1
    from public.indexing_runs r
    where r.tenant_id = d.tenant_id
      and r.document_id = d.id
      and r.status in ('queued', 'running')
  )

union all

select
  'nonterminal_without_active_run'::text as anomaly,
  d.tenant_id,
  d.id as document_id,
  null::uuid as run_id,
  d.filename,
  d.status as document_status,
  null::text as run_status,
  null::text as stage,
  null::integer as progress,
  'Documento no terminal sin corrida activa'::text as message,
  jsonb_build_object(
    'uploaded_at', d.uploaded_at,
    'updated_at', d.updated_at
  ) as metadata,
  d.updated_at
from public.documents d
where d.status in ('queued', 'parsing', 'structuring')
  and d.uploaded_at is not null
  and not exists (
    select 1
    from public.indexing_runs r
    where r.tenant_id = d.tenant_id
      and r.document_id = d.id
      and r.status in ('queued', 'running')
  )

union all

select
  'active_run_without_uploaded_at'::text as anomaly,
  r.tenant_id,
  r.document_id,
  r.id as run_id,
  d.filename,
  d.status as document_status,
  r.status as run_status,
  r.stage,
  r.progress,
  'Corrida activa sobre documento sin uploaded_at'::text as message,
  jsonb_build_object(
    'run_updated_at', r.updated_at,
    'document_updated_at', d.updated_at
  ) as metadata,
  greatest(r.updated_at, d.updated_at) as updated_at
from public.indexing_runs r
join public.documents d
  on d.tenant_id = r.tenant_id
 and d.id = r.document_id
where r.status in ('queued', 'running')
  and d.uploaded_at is null

union all

select
  'indexed_without_tree'::text as anomaly,
  d.tenant_id,
  d.id as document_id,
  null::uuid as run_id,
  d.filename,
  d.status as document_status,
  null::text as run_status,
  null::text as stage,
  null::integer as progress,
  'Documento indexed sin doc_tree'::text as message,
  jsonb_build_object('indexed_at', d.indexed_at) as metadata,
  d.updated_at
from public.documents d
where d.status = 'indexed'
  and not exists (
    select 1
    from public.doc_tree t
    where t.tenant_id = d.tenant_id
      and t.document_id = d.id
  )

union all

select
  'indexed_without_chunks'::text as anomaly,
  d.tenant_id,
  d.id as document_id,
  null::uuid as run_id,
  d.filename,
  d.status as document_status,
  null::text as run_status,
  null::text as stage,
  null::integer as progress,
  'Documento indexed sin chunks'::text as message,
  jsonb_build_object('indexed_at', d.indexed_at) as metadata,
  d.updated_at
from public.documents d
where d.status = 'indexed'
  and not exists (
    select 1
    from public.chunks c
    where c.tenant_id = d.tenant_id
      and c.document_id = d.id
  )

union all

select
  'running_with_persisted_tree'::text as anomaly,
  r.tenant_id,
  r.document_id,
  r.id as run_id,
  d.filename,
  d.status as document_status,
  r.status as run_status,
  r.stage,
  r.progress,
  'Corrida activa aunque el arbol/chunks ya existen'::text as message,
  jsonb_build_object(
    'run_updated_at', r.updated_at,
    'document_updated_at', d.updated_at
  ) as metadata,
  greatest(r.updated_at, d.updated_at) as updated_at
from public.indexing_runs r
join public.documents d
  on d.tenant_id = r.tenant_id
 and d.id = r.document_id
where r.status in ('queued', 'running')
  and exists (
    select 1
    from public.doc_tree t
    where t.tenant_id = r.tenant_id
      and t.document_id = r.document_id
  )
  and exists (
    select 1
    from public.chunks c
    where c.tenant_id = r.tenant_id
      and c.document_id = r.document_id
  );

grant select on public.indexing_health_anomalies to authenticated;
grant select on public.indexing_health_anomalies to service_role;
