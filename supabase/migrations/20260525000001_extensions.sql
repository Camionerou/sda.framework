-- Wave 0: habilitar extensiones requeridas por el pipeline
-- Spec ref: §2 Schema de Supabase

create extension if not exists pgcrypto;                -- digest() para sha256
create extension if not exists pgmq;                    -- message queues
create extension if not exists pg_cron;                 -- scheduled jobs
create extension if not exists pg_net with schema extensions;  -- async HTTP from SQL
create extension if not exists supabase_vault;          -- secret storage (creates vault schema)
create extension if not exists vector;                  -- embeddings (Wave 3, pero schema ready)
