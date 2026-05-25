-- Wave 1: columnas para PDF parsing tracking + contextual chunking
-- Spec §4.1.1. Wave 0 ya pre-creó page_count/path_used/text_contextualized/
-- summary_model (verificado en 20260525000002_tables_core.sql). Esta migration
-- solo agrega las realmente nuevas + corrige tipo de appear_start.

-- documents: solo parser_used + doc_summary_short (las otras 2 ya existen)
alter table documents
  add column if not exists parser_used text check (parser_used in ('native', 'mineru')),
  add column if not exists doc_summary_short text;

comment on column documents.parser_used is 'Wave 1: native (pypdf) | mineru (full pipeline)';
comment on column documents.doc_summary_short is 'Wave 1: ~200 toks resumen del doc completo, prefix cacheable per-doc para summarize calls';

-- tree_nodes: recrear appear_start (boolean → int) + agregar appear_end
-- DROP+ADD es seguro porque appear_start boolean no se usa en código actual
-- (verificado con grep -rn appear_start services/sda-indexer/src/).
alter table tree_nodes drop column if exists appear_start;
alter table tree_nodes
  add column appear_start int,
  add column if not exists appear_end int;

comment on column tree_nodes.appear_start is 'Wave 1: página inicio del nodo en el PDF';
comment on column tree_nodes.appear_end is 'Wave 1: página fin del nodo';

create index if not exists tree_nodes_appear_start_idx
  on tree_nodes(document_id, appear_start);
