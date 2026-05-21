alter table public.doc_tree
  add column if not exists routing_summary text;

alter table public.chunks
  add column if not exists routing_summary text;

create index if not exists chunks_routing_summary_tsv_idx
  on public.chunks
  using gin (pg_catalog.to_tsvector('simple'::regconfig, coalesce(routing_summary, '')))
  where routing_summary is not null;
