create extension if not exists "ltree" with schema "extensions";
create extension if not exists "pg_trgm" with schema "extensions";

create or replace function app.stable_doc_tree_node_id(
  _tenant_id uuid,
  _document_id uuid,
  _node_id text
)
returns uuid
language sql
immutable
strict
set search_path = ''
as $$
  select (
    substr(hash_value, 1, 8) || '-' ||
    substr(hash_value, 9, 4) || '-' ||
    substr(hash_value, 13, 4) || '-' ||
    substr(hash_value, 17, 4) || '-' ||
    substr(hash_value, 21, 12)
  )::uuid
  from (
    select md5(_tenant_id::text || ':' || _document_id::text || ':' || _node_id) as hash_value
  ) hashed;
$$;

create or replace function app.doc_tree_ltree_label(_value text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select left(
    'n' || coalesce(
      nullif(regexp_replace(lower(_value), '[^a-z0-9_]+', '_', 'g'), ''),
      'node'
    ),
    240
  );
$$;

create table if not exists public.doc_tree_nodes (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  document_id uuid not null,
  parent_id uuid references public.doc_tree_nodes(id) on delete cascade,
  node_id text not null,
  node_path extensions.ltree not null,
  node_type text not null default 'section',
  title text not null,
  summary text,
  routing_summary text,
  page_start integer not null check (page_start > 0),
  page_end integer not null check (page_end >= page_start),
  confidence numeric(3,2) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  origin text check (origin is null or origin in ('explicit', 'visual', 'inferred', 'fallback')),
  embedding extensions.vector(1536),
  embedding_model text,
  embedding_pipeline_version text,
  indexing_pipeline_version text,
  tree_indexer_version text,
  tree_prompt_version text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, document_id)
    references public.documents(tenant_id, id)
    on delete cascade,
  unique (tenant_id, document_id, node_id)
);

drop trigger if exists set_doc_tree_nodes_updated_at on public.doc_tree_nodes;

create trigger set_doc_tree_nodes_updated_at
before update on public.doc_tree_nodes
for each row execute function app.set_updated_at();

alter table public.doc_tree_nodes enable row level security;

drop policy if exists doc_tree_nodes_select_tenant on public.doc_tree_nodes;

create policy doc_tree_nodes_select_tenant on public.doc_tree_nodes
  for select to authenticated
  using (tenant_id = (select app.current_tenant_id()));

create index if not exists doc_tree_nodes_tenant_document_idx
  on public.doc_tree_nodes (tenant_id, document_id);

create index if not exists doc_tree_nodes_tenant_node_type_idx
  on public.doc_tree_nodes (tenant_id, node_type);

create index if not exists doc_tree_nodes_path_idx
  on public.doc_tree_nodes using gist (node_path);

create index if not exists doc_tree_nodes_metadata_gin_idx
  on public.doc_tree_nodes using gin (metadata jsonb_path_ops);

create index if not exists doc_tree_nodes_routing_summary_tsv_idx
  on public.doc_tree_nodes
  using gin (pg_catalog.to_tsvector('simple'::regconfig, coalesce(routing_summary, '')))
  where routing_summary is not null;

create index if not exists doc_tree_nodes_embedding_hnsw_idx
  on public.doc_tree_nodes
  using hnsw (embedding extensions.vector_cosine_ops)
  where embedding is not null;

with recursive tree_nodes as (
  select
    dt.tenant_id,
    dt.document_id,
    dt.indexing_pipeline_version,
    dt.tree_indexer_version,
    dt.tree_prompt_version,
    (dt.tree ->> 'document_type') as document_type,
    null::text as parent_node_id,
    node.value as node,
    array[(node.ordinality - 1)::integer] as ordinal_path,
    (app.doc_tree_ltree_label(
      coalesce(nullif(node.value ->> 'node_id', ''), (node.ordinality - 1)::text)
    ))::extensions.ltree as node_path
  from public.doc_tree dt
  cross join lateral jsonb_array_elements(coalesce(dt.tree -> 'nodes', '[]'::jsonb))
    with ordinality as node(value, ordinality)

  union all

  select
    tree_nodes.tenant_id,
    tree_nodes.document_id,
    tree_nodes.indexing_pipeline_version,
    tree_nodes.tree_indexer_version,
    tree_nodes.tree_prompt_version,
    tree_nodes.document_type,
    coalesce(nullif(tree_nodes.node ->> 'node_id', ''), array_to_string(tree_nodes.ordinal_path, '.')),
    child.value,
    tree_nodes.ordinal_path || (child.ordinality - 1)::integer,
    (
      tree_nodes.node_path::text || '.' ||
      app.doc_tree_ltree_label(
        coalesce(nullif(child.value ->> 'node_id', ''), (child.ordinality - 1)::text)
      )
    )::extensions.ltree
  from tree_nodes
  cross join lateral jsonb_array_elements(coalesce(tree_nodes.node -> 'nodes', '[]'::jsonb))
    with ordinality as child(value, ordinality)
),
normalized_nodes as (
  select
    app.stable_doc_tree_node_id(
      tenant_id,
      document_id,
      coalesce(nullif(node ->> 'node_id', ''), array_to_string(ordinal_path, '.'))
    ) as id,
    tenant_id,
    document_id,
    case
      when parent_node_id is null then null::uuid
      else app.stable_doc_tree_node_id(tenant_id, document_id, parent_node_id)
    end as parent_id,
    coalesce(nullif(node ->> 'node_id', ''), array_to_string(ordinal_path, '.')) as node_id,
    node_path,
    case
      when parent_node_id is null then 'root'
      when jsonb_array_length(coalesce(node -> 'nodes', '[]'::jsonb)) > 0 then 'section'
      else 'leaf'
    end as node_type,
    coalesce(nullif(node ->> 'title', ''), 'Untitled section') as title,
    nullif(node ->> 'summary', '') as summary,
    nullif(node ->> 'routing_summary', '') as routing_summary,
    (node ->> 'start_index')::integer as page_start,
    (node ->> 'end_index')::integer as page_end,
    case
      when nullif(node ->> 'confidence', '') ~ '^(0([.][0-9]+)?|1([.]0+)?)$'
        then nullif(node ->> 'confidence', '')::numeric(3,2)
      else null
    end as confidence,
    case
      when nullif(node ->> 'origin', '') in ('explicit', 'visual', 'inferred', 'fallback')
        then nullif(node ->> 'origin', '')
      else null
    end as origin,
    indexing_pipeline_version,
    tree_indexer_version,
    tree_prompt_version,
    document_type,
    node
  from tree_nodes
  where (node ->> 'start_index') ~ '^[0-9]+$'
    and (node ->> 'end_index') ~ '^[0-9]+$'
    and (node ->> 'start_index')::integer > 0
    and (node ->> 'end_index')::integer >= (node ->> 'start_index')::integer
)
insert into public.doc_tree_nodes (
  id,
  tenant_id,
  document_id,
  parent_id,
  node_id,
  node_path,
  node_type,
  title,
  summary,
  routing_summary,
  page_start,
  page_end,
  confidence,
  origin,
  embedding,
  embedding_model,
  embedding_pipeline_version,
  indexing_pipeline_version,
  tree_indexer_version,
  tree_prompt_version,
  metadata
)
select
  normalized_nodes.id,
  normalized_nodes.tenant_id,
  normalized_nodes.document_id,
  normalized_nodes.parent_id,
  normalized_nodes.node_id,
  normalized_nodes.node_path,
  normalized_nodes.node_type,
  normalized_nodes.title,
  normalized_nodes.summary,
  normalized_nodes.routing_summary,
  normalized_nodes.page_start,
  normalized_nodes.page_end,
  normalized_nodes.confidence,
  normalized_nodes.origin,
  chunks.embedding,
  chunks.embedding_model,
  chunks.embedding_pipeline_version,
  normalized_nodes.indexing_pipeline_version,
  normalized_nodes.tree_indexer_version,
  normalized_nodes.tree_prompt_version,
  coalesce(chunks.metadata, '{}'::jsonb) ||
    jsonb_strip_nulls(
      jsonb_build_object(
        'document_type', normalized_nodes.document_type,
        'page_range', jsonb_build_array(normalized_nodes.page_start, normalized_nodes.page_end),
        'source', 'pageindex_style_python_tree',
        'source_blocks', normalized_nodes.node -> 'source_blocks',
        'source_blocks_coordinate_system',
          case
            when normalized_nodes.node ? 'source_blocks'
              then 'normalized_page_bbox_top_left_v1'
            else null
          end
      )
    )
from normalized_nodes
left join public.chunks
  on chunks.tenant_id = normalized_nodes.tenant_id
 and chunks.document_id = normalized_nodes.document_id
 and chunks.node_id = normalized_nodes.node_id
on conflict (tenant_id, document_id, node_id) do update
set
  embedding = excluded.embedding,
  embedding_model = excluded.embedding_model,
  embedding_pipeline_version = excluded.embedding_pipeline_version,
  indexing_pipeline_version = excluded.indexing_pipeline_version,
  metadata = excluded.metadata,
  node_path = excluded.node_path,
  node_type = excluded.node_type,
  origin = excluded.origin,
  page_end = excluded.page_end,
  page_start = excluded.page_start,
  parent_id = excluded.parent_id,
  routing_summary = excluded.routing_summary,
  summary = excluded.summary,
  title = excluded.title,
  tree_indexer_version = excluded.tree_indexer_version,
  tree_prompt_version = excluded.tree_prompt_version,
  updated_at = now();

create index if not exists documents_tenant_created_idx
  on public.documents (tenant_id, created_at desc);

create index if not exists indexing_events_metadata_gin_idx
  on public.indexing_events using gin (metadata jsonb_path_ops);

create index if not exists chunks_node_path_gin_idx
  on public.chunks using gin (node_path);

create index if not exists chunks_content_trgm_idx
  on public.chunks using gin (content extensions.gin_trgm_ops);

create index if not exists chunks_tenant_document_type_idx
  on public.chunks (tenant_id, ((metadata ->> 'document_type')))
  where metadata ? 'document_type';

grant select on public.doc_tree_nodes to authenticated;
grant all on public.doc_tree_nodes to service_role;
revoke insert, update, delete on public.doc_tree_nodes from anon, authenticated, public;

create materialized view if not exists public.indexing_health_snapshot as
select
  true as singleton,
  now() as refreshed_at,
  jsonb_build_object(
    'counts',
      jsonb_build_object(
        'chunks', (select count(*) from public.chunks),
        'doc_tree', (select count(*) from public.doc_tree),
        'doc_tree_nodes', (select count(*) from public.doc_tree_nodes),
        'documents', (select count(*) from public.documents),
        'indexing_events', (select count(*) from public.indexing_events),
        'indexing_runs', (select count(*) from public.indexing_runs)
      ),
    'documents_by_status',
      coalesce(
        (
          select jsonb_object_agg(status, total)
          from (
            select status::text, count(*) as total
            from public.documents
            group by status
          ) status_counts
        ),
        '{}'::jsonb
      ),
    'runs_by_status',
      coalesce(
        (
          select jsonb_object_agg(status, total)
          from (
            select status, count(*) as total
            from public.indexing_runs
            group by status
          ) status_counts
        ),
        '{}'::jsonb
      ),
    'anomalies',
      coalesce(
        (
          select jsonb_agg(to_jsonb(anomaly_rows) order by anomaly_rows.updated_at desc)
          from (
            select *
            from public.indexing_health_anomalies
            order by updated_at desc
            limit 1000
          ) anomaly_rows
        ),
        '[]'::jsonb
      )
  ) as data;

create unique index if not exists indexing_health_snapshot_singleton_idx
  on public.indexing_health_snapshot (singleton);

revoke all on public.indexing_health_snapshot from anon, authenticated, public;
grant select on public.indexing_health_snapshot to service_role;

create or replace function public.refresh_indexing_health_snapshot()
returns table (
  refreshed_at timestamptz,
  data jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  refresh materialized view public.indexing_health_snapshot;

  return query
  select snapshot.refreshed_at, snapshot.data
  from public.indexing_health_snapshot snapshot
  limit 1;
end;
$$;

revoke all on function public.refresh_indexing_health_snapshot() from anon, authenticated, public;
grant execute on function public.refresh_indexing_health_snapshot() to service_role;

create or replace function public.cleanup_operational_data(
  _revoked_invites_retention interval default '90 days'::interval,
  _indexing_events_retention interval default '6 months'::interval,
  _audit_log_retention interval default '2 years'::interval
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  revoked_invites_deleted integer := 0;
  indexing_events_deleted integer := 0;
  audit_log_deleted integer := 0;
begin
  delete from public.tenant_invites
  where status = 'revoked'
    and updated_at < now() - _revoked_invites_retention;
  get diagnostics revoked_invites_deleted = row_count;

  delete from public.indexing_events
  where created_at < now() - _indexing_events_retention;
  get diagnostics indexing_events_deleted = row_count;

  delete from public.audit_log
  where created_at < now() - _audit_log_retention;
  get diagnostics audit_log_deleted = row_count;

  return jsonb_build_object(
    'audit_log_deleted', audit_log_deleted,
    'indexing_events_deleted', indexing_events_deleted,
    'revoked_invites_deleted', revoked_invites_deleted
  );
end;
$$;

revoke all on function public.cleanup_operational_data(interval, interval, interval)
  from anon, authenticated, public;
grant execute on function public.cleanup_operational_data(interval, interval, interval)
  to service_role;

do $$
declare
  cron_schema text;
begin
  select namespace.nspname
  into cron_schema
  from pg_namespace namespace
  where namespace.nspname in ('cron', 'extensions', 'pg_catalog')
    and to_regprocedure(format('%I.schedule(text,text,text)', namespace.nspname)) is not null
  order by case namespace.nspname
    when 'cron' then 1
    when 'extensions' then 2
    else 3
  end
  limit 1;

  if cron_schema is null and exists (
    select 1
    from pg_available_extensions
    where name = 'pg_cron'
  ) then
    begin
      execute 'create extension if not exists pg_cron';

      select namespace.nspname
      into cron_schema
      from pg_namespace namespace
      where namespace.nspname in ('cron', 'extensions', 'pg_catalog')
        and to_regprocedure(format('%I.schedule(text,text,text)', namespace.nspname)) is not null
      order by case namespace.nspname
        when 'cron' then 1
        when 'extensions' then 2
        else 3
      end
      limit 1;
    exception
      when insufficient_privilege or undefined_file or feature_not_supported then
        raise notice 'pg_cron no esta disponible para este proyecto: %', sqlerrm;
      when others then
        raise notice 'pg_cron no se pudo habilitar automaticamente: %', sqlerrm;
    end;
  end if;

  if cron_schema is not null then
    begin
      execute format('select %I.unschedule(%L)', cron_schema, 'sda-operational-cleanup');
    exception
      when others then
        null;
    end;

    begin
      execute format(
        'select %I.schedule(%L, %L, %L)',
        cron_schema,
        'sda-operational-cleanup',
        '0 4 * * *',
        'select public.cleanup_operational_data();'
      );
    exception
      when others then
        raise notice 'No se pudo programar cleanup_operational_data: %', sqlerrm;
    end;

    begin
      execute format('select %I.unschedule(%L)', cron_schema, 'sda-indexing-health-refresh');
    exception
      when others then
        null;
    end;

    begin
      execute format(
        'select %I.schedule(%L, %L, %L)',
        cron_schema,
        'sda-indexing-health-refresh',
        '*/5 * * * *',
        'select public.refresh_indexing_health_snapshot();'
      );
    exception
      when others then
        raise notice 'No se pudo programar refresh_indexing_health_snapshot: %', sqlerrm;
    end;
  end if;
end;
$$;
