-- Wave 0: triggers del pipeline (storage upload, document insert,
-- tree_node insert, tree_node ready). Spec §2 Triggers core (con fix de self-review).

-- 1. Storage upload → INSERT documents (con hash provisorio)
create function on_storage_doc_uploaded() returns trigger language plpgsql security definer as $$
declare
  doc_sha_provisional text;
  doc_type text;
begin
  if new.bucket_id != 'docs' then return new; end if;
  doc_type := case
    when new.name like '%.pdf' then 'pdf'
    when new.name like '%.md' then 'markdown'
    else null
  end;
  if doc_type is null then return new; end if;
  doc_sha_provisional := 'provisional:' || encode(digest(new.name, 'sha256'), 'hex');
  insert into documents (sha256, source_path, source_type, trace_id)
    values (doc_sha_provisional, new.name, doc_type, gen_random_uuid()::text)
    on conflict (sha256) do nothing;
  return new;
end $$;
create trigger trg_storage_doc_uploaded after insert on storage.objects
  for each row execute function on_storage_doc_uploaded();

-- 2. Document insertado → enqueue extract_structure + audit en indexing_jobs
create function on_document_inserted() returns trigger language plpgsql security definer as $$
declare
  v_msg_id bigint;
begin
  v_msg_id := pgmq.send('q_extract_structure',
    jsonb_build_object(
      'document_id', new.id,
      'idempotency_key', 'extract:' || new.sha256,
      'trace_id', new.trace_id
    ));
  insert into indexing_jobs (msg_id, queue_name, document_id, job_type, payload, idempotency_key)
    values (v_msg_id, 'q_extract_structure',
            new.id, 'extract_structure',
            jsonb_build_object('document_id', new.id),
            'extract:' || new.sha256)
    on conflict (idempotency_key) do nothing;
  return new;
end $$;
create trigger trg_document_inserted after insert on documents
  for each row execute function on_document_inserted();

-- 3. Tree node creado → enqueue summarize
create function on_tree_node_inserted() returns trigger language plpgsql security definer as $$
begin
  perform pgmq.send('q_summarize_node',
    jsonb_build_object(
      'node_id', new.id,
      'document_id', new.document_id,
      'idempotency_key', 'sum:' || new.document_id || ':' || new.node_id_str
    ));
  return new;
end $$;
create trigger trg_tree_node_inserted after insert on tree_nodes
  for each row execute function on_tree_node_inserted();

-- 4. Tree node ready → check si todos listos → enqueue finalize (advisory lock)
create function on_tree_node_ready() returns trigger language plpgsql security definer as $$
declare
  pending_count int;
begin
  if new.status = 'ready' and (old.status is null or old.status != 'ready') then
    perform pg_advisory_xact_lock(hashtext(new.document_id::text));
    select count(*) into pending_count
      from tree_nodes
     where document_id = new.document_id and status != 'ready';
    if pending_count = 0 then
      perform pgmq.send('q_finalize',
        jsonb_build_object(
          'document_id', new.document_id,
          'idempotency_key', 'final:' || new.document_id
        ));
    end if;
  end if;
  return new;
end $$;
create trigger trg_tree_node_ready after update on tree_nodes
  for each row execute function on_tree_node_ready();
