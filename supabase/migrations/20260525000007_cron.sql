-- Wave 0: pg_cron jobs + dispatcher helper para drenar pgmq → srv-ia-01
-- Spec ref: §2 pg_cron jobs (con dispatch_pgmq_to_srv_ia agregado en self-review)

-- URL de srv-ia-01: se lee desde Vault (name='srv_ia_01_url') con fallback
-- al default local-dev (host.docker.internal:8000). En prod se settea con:
--   select vault.create_secret('https://srv-ia-01.internal', 'srv_ia_01_url');
-- Vault evita necesitar superuser (alter database) y centraliza secrets+config.

-- Helper para incrementar rate limit counter
create function increment_rate_limit(p_provider text) returns void language plpgsql as $$
begin
  update rate_limits
     set in_flight = in_flight + 1,
         updated_at = now()
   where provider = p_provider;
end $$;

create function decrement_rate_limit(p_provider text) returns void language plpgsql as $$
begin
  update rate_limits
     set in_flight = greatest(0, in_flight - 1),
         updated_at = now()
   where provider = p_provider;
end $$;

-- Dispatcher: drena queue y dispara HTTP a srv-ia-01
create function dispatch_pgmq_to_srv_ia(
  p_queue_name text,
  p_endpoint_path text,
  p_max_messages int
) returns int language plpgsql security definer as $$
declare
  msg record;
  count_dispatched int := 0;
  srv_url text;
  bearer text;
begin
  if p_max_messages <= 0 then return 0; end if;
  select decrypted_secret into srv_url from vault.decrypted_secrets where name = 'srv_ia_01_url';
  srv_url := coalesce(srv_url, 'http://host.docker.internal:8000');
  select decrypted_secret into bearer from vault.decrypted_secrets where name = 'srv_ia_01_secret';
  if bearer is null then
    raise notice 'srv_ia_01_secret not found in Vault, skipping dispatch';
    return 0;
  end if;
  for msg in
    select * from pgmq.read(p_queue_name, 600, p_max_messages)
  loop
    perform net.http_post(
      url := srv_url || p_endpoint_path,
      body := msg.message,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || bearer
      ),
      timeout_milliseconds := 120000
    );
    update indexing_jobs set status = 'in_flight', attempts = attempts + 1
      where msg_id = msg.msg_id;
    perform increment_rate_limit('deepseek');
    count_dispatched := count_dispatched + 1;
  end loop;
  return count_dispatched;
end $$;

-- Tick cada 10s — drena las 3 queues activas respetando backpressure
select cron.schedule('drain-queues-10s', '*/10 * * * * *', $$
  with capacity as (
    select greatest(0, max_concurrent - in_flight) as slots
      from rate_limits where provider='deepseek'
  )
  select
    dispatch_pgmq_to_srv_ia('q_extract_structure', '/index/structure', least((select slots from capacity), 5)),
    dispatch_pgmq_to_srv_ia('q_summarize_node',    '/index/summarize', least((select slots from capacity), 20)),
    dispatch_pgmq_to_srv_ia('q_finalize',          '/index/finalize',  least((select slots from capacity), 5));
$$);

-- GC de LangGraph checkpoints viejos (default 7 días, configurable después)
select cron.schedule('gc-langgraph-checkpoints', '0 3 * * *', $$
  delete from langgraph_checkpoints.checkpoints
   where ts < now() - interval '7 days';
$$);
