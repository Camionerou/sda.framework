-- Wave 1: cierra D-0.3 pendiente de Wave 0 — GC de jobs stuck in_flight.
-- Spec §4.1.3. PDFs grandes pueden colgar jobs por OOM o crash del worker,
-- visibility timeout de pgmq sólo reentrega el mensaje pero indexing_jobs
-- queda en in_flight forever sin GC.
--
-- Review-fix (B2+I5): el schema Wave 0 NO tiene started_at en indexing_jobs
-- (solo completed_at + attempts). Esta migration:
--   1. Agrega started_at timestamptz
--   2. Re-define dispatch_pgmq_to_srv_ia (originalmente en 20260525000007_cron.sql)
--      para popular started_at = now() al marcar in_flight
--   3. Define gc_stuck_jobs() usando started_at + completed_at

alter table indexing_jobs
  add column if not exists started_at timestamptz;

-- Re-define dispatcher para que pople started_at. Resto del cuerpo
-- copiado intacto de 20260525000007_cron.sql + 1 línea agregada.
create or replace function dispatch_pgmq_to_srv_ia(
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
    -- Wave 1 patch: popular started_at para que gc_stuck_jobs pueda detectar stuck.
    update indexing_jobs
       set status = 'in_flight',
           attempts = attempts + 1,
           started_at = coalesce(started_at, now())
      where msg_id = msg.msg_id;
    perform increment_rate_limit('deepseek');
    count_dispatched := count_dispatched + 1;
  end loop;
  return count_dispatched;
end $$;

create or replace function gc_stuck_jobs() returns int
language plpgsql as $$
declare n int;
begin
  with reclaimed as (
    update indexing_jobs
       set status='failed',
           failure_reason='unknown',
           failure_detail='stuck in_flight >30 min, GC reclaimed',
           completed_at=now()
     where status='in_flight'
       and started_at is not null
       and started_at < now() - interval '30 minutes'
    returning 1
  )
  select count(*) into n from reclaimed;
  return coalesce(n, 0);
end $$;

comment on function gc_stuck_jobs is 'Wave 1 D-0.3: reclaim indexing_jobs stuck in_flight >30min como failed';

select cron.schedule(
  'gc-stuck-jobs',
  '*/5 * * * *',
  $$select gc_stuck_jobs()$$
);
