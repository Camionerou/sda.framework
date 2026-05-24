# SDA Framework

Plataforma multitenant en reconstruccion desde cero (2026-05-24).

## Estado

Wipe ejecutado segun spec `docs/superpowers/specs/2026-05-24-wipe-restart-design.md`.
Rollback tag: `pre-wipe-restart-2026-05-24`.

## Stack

- Next.js 16 (App Router, TypeScript, Tailwind 4, Turbopack)
- Supabase (Postgres + Auth + Storage), proyecto `anfawvxfepowsudlffnl`
- Inngest (event-driven workflows)
- Upstash Redis (cache + rate limit)
- Vercel (hosting + dominio sdaframework.com)
- srv-ia-01 (compute backend con MinerU + vllm)

## Setup

```bash
pnpm install
cp .env.example .env.local
# Editar .env.local con keys reales (ver Vercel env vars en sdaframework/sda-framework)
pnpm dev
```

## Conventions

- Reglas del proyecto en `CLAUDE.md`.
- Next.js 16 breaking-change notes en `AGENTS.md`.
