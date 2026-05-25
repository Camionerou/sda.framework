-- Wave 0 fix descubierto durante deploy a producción:
-- pg_cron en Supabase managed NO soporta schedules sub-minuto por default
-- (cron.use_background_workers=off). El schedule original '*/10 * * * * *'
-- (cada 10 seg, 6-field syntax) era ignorado y el cron solo corría cada
-- minuto de todas formas.
--
-- Cambio a '* * * * *' (every minute, 5-field standard) para hacer explícito
-- el comportamiento real. Latencia max de pickup: 1 min (era expected 10s).
-- Suficiente para Wave 0. Wave 2 puede optimizar con background workers
-- o moviendo dispatch a Edge Function con trigger directo.

-- cron.alter_job es la forma soportada de cambiar schedule (no se permite UPDATE directo
-- a cron.job en Supabase managed por permisos).
select cron.alter_job(
  (select jobid from cron.job where jobname = 'drain-queues-10s'),
  schedule := '* * * * *'
);

-- NOTA: cron.job.jobname NO se puede renombrar via UPDATE (permission denied). El nombre
-- queda como 'drain-queues-10s' pero el schedule efectivo es '* * * * *'. Documentado.
