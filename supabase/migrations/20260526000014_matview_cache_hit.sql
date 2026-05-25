-- Wave 1: pull-forward de Wave 2 — sin esto D-1.4 no es verificable.
-- Spec §4.1.4 + §6.6.

-- NOTA: la columna real en llm_calls (migration 20260525000002) es `cached_tokens`,
-- NO `cache_hit_tokens` (el spec §4.1.4 usa el nombre viejo del draft). Verificado
-- contra schema actual antes de escribir esta migration.
create materialized view if not exists mv_cache_hit_ratio as
select
  date_trunc('hour', created_at) as hour,
  phase,
  sum(cached_tokens)::float / nullif(sum(prompt_tokens), 0) as hit_ratio,
  sum(prompt_tokens) as total_prompt_tokens,
  sum(cached_tokens) as total_cached_tokens,
  count(*) as call_count
from llm_calls
where created_at > now() - interval '7 days'
group by 1, 2;

create unique index if not exists mv_cache_hit_ratio_hour_phase_idx
  on mv_cache_hit_ratio(hour, phase);

comment on materialized view mv_cache_hit_ratio is
  'Wave 1: refresh */5min via cron. Validar D-1.4 (>0.75 para summarize)';

-- Daily costs view también (pull-forward parcial para D-1.5)
create materialized view if not exists mv_llm_costs_daily as
select
  date_trunc('day', created_at) as day,
  phase,
  model,
  sum(cost_cents) as cost_cents,
  count(*) as call_count
from llm_calls
where created_at > now() - interval '30 days'
group by 1, 2, 3;

create unique index if not exists mv_llm_costs_daily_idx
  on mv_llm_costs_daily(day, phase, model);

comment on materialized view mv_llm_costs_daily is
  'Wave 1: refresh */5min. Validar D-1.5 (Pro en TOC/structure, Flash en summary)';

select cron.schedule(
  'refresh-cache-hit-mv',
  '*/5 * * * *',
  $$refresh materialized view concurrently mv_cache_hit_ratio$$
);

select cron.schedule(
  'refresh-llm-costs-mv',
  '*/5 * * * *',
  $$refresh materialized view concurrently mv_llm_costs_daily$$
);
