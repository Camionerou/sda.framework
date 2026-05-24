# Wipe and restart sdaframework — design

| Campo | Valor |
|---|---|
| Fecha | 2026-05-24 |
| Autor | Enzo + Claude (brainstorming session) |
| Estado | Approved (pending execution plan) |
| Branch | `chore/wipe-restart` |
| Rollback tag | `pre-wipe-restart-2026-05-24` (a crear en §0 de la ejecucion) |

## 1. Resumen ejecutivo

Reiniciamos el proyecto SDA Framework desde cero, **conservando todas las conexiones a servicios externos** (Vercel, Supabase, Inngest, Upstash, srv-ia-01, GitHub, dominios, providers de LLM y embeddings) pero **borrando la totalidad del codigo, schemas, migrations, docs y memoria persistente** generados durante el Tier 1 Foundation.

El objetivo es empezar la implementacion desde un esqueleto Next.js + Supabase init limpio, sin arrastrar deuda tecnica acumulada ni patrones implicitos del trabajo previo.

## 2. Decisiones tomadas

Documentadas en orden de impacto. Cada una refleja una eleccion explicita del usuario durante el brainstorming, no una suposicion.

### 2.1 Alcance del wipe

- **Decision**: wipe total incluyendo `docs/`.
- **Implicancia**: el conocimiento de diseno (planes Tier 1/2/3, gotchas, arquitectura) se pierde como filesystem y queda solo accesible via `git log` y el tag `pre-wipe-restart-2026-05-24`.
- **Excepcion explicita**: este mismo documento (`docs/superpowers/specs/2026-05-24-wipe-restart-design.md`) se preserva. Toda otra ruta bajo `docs/` se borra.

### 2.2 Memoria persistente de Claude

- **Decision**: wipe total de las 11 entradas en `~/.claude/projects/-Users-enzo-sda-framework-sda-framework/memory/`.
- **Implicancia**: futuras sesiones empiezan sin contexto del proyecto. La memoria se reconstruye organicamente.

### 2.3 Estrategia git

- **Decision**: branch `chore/wipe-restart` desde main, PR con **squash merge** a main, branches viejas borradas ANTES de empezar.
- **Branches a eliminar**:
  - Locales: `pr1-ui-clean`, `pr2-ui-clean`, `feat/frontend-glass-workspace`.
  - Remotas: `feat/frontend-glass-workspace`, `feat/frontend-light-ui-polish`, `feat/frontend-shadcn-redesign`.

### 2.4 Supabase (proyecto `anfawvxfepowsudlffnl`, region us-east-1)

- **Decision**: drop schemas `public` + `app`, vaciar bucket `documents`, preservar bucket creado, borrar todos los `auth.users` excepto `enzosaldivia@gmail.com`, mantener proyecto (mismas URLs y keys).
- **pg_cron jobs activos a desactivar antes del drop** (descubierto en escaneo):
  - `sda-operational-cleanup` (daily 4am, llama `public.cleanup_operational_data()`).
  - `sda-indexing-health-refresh` (cada 5 min, llama `public.refresh_indexing_health_snapshot()`).
- **Extensions instaladas** (9): `citext`, `ltree`, `pg_cron`, `pg_stat_statements`, `pg_trgm`, `pgcrypto`, `supabase_vault`, `uuid-ossp`, `vector`. Todas viven en `extensions`/`vault`/`pg_catalog` — el drop de public/app **no las afecta**.

### 2.5 srv-ia-01

- **Decision**: stop + disable + rm de nuestros systemd units (`sda-compute-gateway.service`, `sda-tree-indexer.service`), borrar clones del repo + virtualenvs Python + logs/cache nuestros.
- **Preservar**: instalacion MinerU 3.x + mineru-api binarios, vllm container (apagado o prendido como este), modelos descargados, configuracion de red, usuarios del sistema.

### 2.6 Vercel (proyecto `sda-framework`, dominio `sdaframework.com`)

- **Decision**: preservar conexiones a servicios externos, borrar configs especificas que pierden sentido sin el codigo.
- **22 env vars que se preservan**: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SECRET_KEY`, `INNGEST_APP_ID`, `INNGEST_APP_URL`, `INNGEST_SIGNING_KEY`, `INNGEST_EVENT_KEY`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `UPSTASH_REDIS_KEY_PREFIX`, `OPENROUTER_API_KEY`, `SDA_EMBEDDING_API_KEY`, `SDA_EMBEDDING_BASE_URL`, `SDA_EMBEDDING_PROVIDER`, `SDA_EMBEDDING_MODEL`, `SDA_EMBEDDING_DIMENSIONS`, `SDA_EMBEDDING_BATCH_SIZE`, `SDA_EMBEDDING_MAX_INPUT_CHARS`, `SDA_EMBEDDING_TIMEOUT_SECONDS`.
- **5 env vars que se borran**: `COMPUTE_GATEWAY_URL`, `COMPUTE_GATEWAY_TOKEN`, `PDF_VIEWER_SIGNED_URL_TTL`, `NEXT_PUBLIC_APP_URL`, `APP_ORIGIN`.

### 2.7 Estado final del repo

- **Decision**: esqueleto Next.js fresco (`create-next-app@latest`, TS, app router, tailwind, eslint, sin src dir, turbopack) + `supabase init` vacio (`config.toml` preservado, `migrations/` vacio).
- **Archivos preservados explicitamente**: `.git/`, `.gitignore`, `.env.example` (renovado), `.env.local`, `.vercel/`, `.github/`, `.claude/`, `.firecrawl/`, `CLAUDE.md` (raiz), `README.md` (reescrito), `supabase/config.toml`, `docs/superpowers/specs/2026-05-24-wipe-restart-design.md`.

## 3. Inventario pre-wipe consolidado

Capturado el 2026-05-24 antes de iniciar la ejecucion.

### 3.1 Vercel

- Proyecto: `sda-framework`, dominio `sdaframework.com` (registrar Vercel, expira 2027-05-20).
- 27 env vars Production, ultimo deploy hace ~5h, Node 24.x.

### 3.2 Supabase

| Recurso | Cantidad |
|---|---|
| Schemas custom | `public` (25 tablas), `app` (0 tablas) |
| Auth users | 3 (incluye enzosaldivia@gmail.com) |
| Storage buckets | 1 (`documents`, private, file_size_limit 5GB) |
| Storage objects | 783 en bucket `documents` |
| Migrations tracked | 46 |
| pg_cron jobs activos | 2 |
| Extensions instaladas | 9 (todas en `extensions`/`vault`/`pg_catalog`) |

### 3.3 Inngest

- App registrada via signing key, functions definidas en `inngest/functions/`:
  - `process-document-index/` (modulo con index + claim + helpers + mineru + transitions + tree + types).
  - `reconcile-document-indexing.ts`.
  - `record-tree-graph-event.ts`.
- Cleanup post-wipe: archivado manual desde dashboard Inngest (cosmetico, no bloqueante).

### 3.4 Upstash Redis

- Instancia `direct-orca-75886.upstash.io`, prefix `sda:local`.
- DB size: **0 keys** — ya esta vacio, no requiere wipe.

### 3.5 srv-ia-01

- 2 systemd units a remover (`sda-compute-gateway`, `sda-tree-indexer`).
- Clones + venvs a identificar via `find` antes de borrar (no asumir paths).
- Servicios base intactos: MinerU 3.x, mineru-api, vllm container, modelos.

### 3.6 Estado git al momento del spec

- Branch actual: `chore/wipe-restart` (recien creada desde main).
- Tag rollback `pre-wipe-restart-2026-05-24` **aun no creado** (sera el paso §0 de la ejecucion).

## 4. Plan de ejecucion por fases

El plan detallado con tasks granulares se genera con el skill `writing-plans` despues del approval de este spec. Esta seccion es el contrato de alto nivel.

### Fase 0 — Pre-flight

- Crear tag `pre-wipe-restart-2026-05-24` en HEAD de main y push.
- Snapshot informativo `supabase db query --linked` → `/tmp/sda-snapshot-pre-wipe.json` (tablas, buckets, jobs, users).
- Confirmar conectividad: `gh auth status`, `supabase projects list` linked, `npx vercel whoami`, `ssh srv-ia-01 'hostname'`.

### Fase 1 — Wipe repo (branch chore/wipe-restart)

- Borrar: `app/`, `components/`, `lib/`, `inngest/`, `workers/`, `bin/`, `cli/`, `scripts/`, `supabase/migrations/*`, `supabase/snippets/`, `supabase/tests/`, `supabase/seed.sql`, `supabase/google-oauth.md`, `docs/backend/`, `docs/frontend/`, `docs/archivado/`, `docs/middleware/`, `docs/superpowers/plans/` (entera, incluido `_evidence/`), `docs/superpowers/specs/2026-05-21-mineru-gpu-tree-pipeline-acceleration-design.md`, `docs/superpowers/specs/2026-05-22-supabase-multitenant-audit-design.md`, `docs/README.md`, `docs/arquitectura.md`, `docs/db-extensions.md`, `docs/db-tuning.md`, `docs/gotchas.md`, `docs/pageindex-tree-builder-reference.md`, `docs/tree-indexer-pipeline.md`, `auth_jwt_claims_v2_test.sql/`, `rls_helpers_app_test.sql/`, `rpcs_workspaces_test.sql/`, `proxy.ts`, `components.json`, `next.config.mjs`, `eslint.config.mjs`, `postcss.config.mjs`, `tsconfig.json`, `tsconfig.tsbuildinfo`, `next-env.d.ts`, `package.json`, `package-lock.json`, `renovate.json`, `CHANGELOG.md`, `AGENT.md`, `CODEX.md`, `.next/`, `node_modules/`.
- Preservar: archivos listados en §2.7.
- Commit: `chore(wipe): remove tier1 codebase, migrations, docs and workers`.

### Fase 2 — Scaffold fresco

- `npx create-next-app@latest sda-scaffold --typescript --app --tailwind --eslint --no-src-dir --import-alias="@/*" --turbopack --no-install` en `/tmp`, mover archivos a raiz sin pisar preservados.
- `pnpm install`.
- Reescribir `README.md` minimo y `.env.example` con vars esenciales: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
- Commits: `chore(scaffold): next.js app fresh` y `chore(scaffold): supabase init clean`.

### Fase 3 — PR + merge

- `git push -u origin chore/wipe-restart`.
- `gh pr create --title "chore: wipe and restart sdaframework from zero"` con body extenso (decisiones, alcance, post-merge plan).
- `gh pr merge --squash --delete-branch`.

### Fase 4 — Supabase wipe (post-merge, **irreversible**)

SQL en orden estricto (ejecutado via `supabase db query --linked`):

```sql
-- 4.1 Desactivar pg_cron antes del drop
SELECT cron.unschedule(jobid) FROM cron.job
  WHERE jobname IN ('sda-operational-cleanup', 'sda-indexing-health-refresh');

-- 4.2 Vaciar 783 storage objects
DELETE FROM storage.objects WHERE bucket_id = 'documents';

-- 4.3 Drop schemas nuestros
DROP SCHEMA IF EXISTS app CASCADE;
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON SCHEMA public TO postgres, service_role;

-- 4.4 Reset migrations tracking
TRUNCATE supabase_migrations.schema_migrations;
```

Auth users: script Node con service_role llama `supabase.auth.admin.deleteUser()` para los 2 users que no son `enzosaldivia@gmail.com`.

### Fase 5 — Vercel env vars cleanup

`npx vercel env rm <NAME> production` para las 5 vars listadas en §2.6.

### Fase 6 — srv-ia-01 wipe (SSH, **irreversible**)

```bash
sudo systemctl stop sda-compute-gateway sda-tree-indexer
sudo systemctl disable sda-compute-gateway sda-tree-indexer
sudo rm -f /etc/systemd/system/sda-{compute-gateway,tree-indexer}.service
sudo systemctl daemon-reload

# Identificar antes de borrar:
find / -maxdepth 5 -path '/proc' -prune -o \
  \( -name 'sda*' -o -name 'compute-gateway*' -o -name 'tree-indexer*' \) \
  -print 2>/dev/null | grep -v '/proc/'

# Confirmar lista con el usuario, despues:
sudo rm -rf <paths confirmados>
```

### Fase 7 — Inngest cleanup (manual, cosmetico)

- Dashboard Inngest → archivar app vieja con functions stale. No bloquea.

### Fase 8 — Cleanup local final

```bash
git branch -D pr1-ui-clean pr2-ui-clean feat/frontend-glass-workspace
git push origin --delete feat/frontend-glass-workspace feat/frontend-light-ui-polish feat/frontend-shadcn-redesign
rm ~/.claude/projects/-Users-enzo-sda-framework-sda-framework/memory/*.md
echo "" > ~/.claude/projects/-Users-enzo-sda-framework-sda-framework/memory/MEMORY.md
```

## 5. Verificaciones post-fase

| Fase | Verificacion | Resultado esperado |
|---|---|---|
| §4 | `supabase db query --linked "SELECT count(*) FROM pg_tables WHERE schemaname IN ('public','app');"` | 0 |
| §4 | `supabase db query --linked "SELECT count(*) FROM storage.objects WHERE bucket_id='documents';"` | 0 |
| §4 | `supabase db query --linked "SELECT count(*) FROM cron.job;"` | 0 |
| §4 | `supabase db query --linked "SELECT count(*) FROM auth.users;"` | 1 (enzo) |
| §5 | `npx vercel env ls` | 22 vars (no las 5 borradas) |
| §6 | `ssh srv-ia-01 'systemctl list-units sda-*'` | vacio |
| §6 | `ssh srv-ia-01 'curl -fsS localhost:<mineru-port>/health'` | OK |
| §8 | `git branch -a` | solo `main` y remotes/origin/main |

## 6. Rollback y manejo de irreversibilidad

| Fase | Reversibilidad | Mecanismo |
|---|---|---|
| §0-§2 | Total | `git reset --hard pre-wipe-restart-2026-05-24` |
| §3 | Parcial | revert del squash commit + restore branches via reflog (30d) |
| §4 | **Irreversible** | Solo Supabase PITR (requiere plan pago). **Antes de §4 confirmamos al usuario** que entiende la irreversibilidad. |
| §5 | Total | `vercel env add` con valores de `.env.local` (las keys se preservan en local) |
| §6 | **Irreversible** | Redeploy desde scratch (alineado con el objetivo del wipe) |
| §7 | Total | No requiere |
| §8 | Parcial | Branches recuperables via reflog si existian localmente |

## 7. Lo que NO toca este wipe (out of scope)

- Proyecto Supabase como entidad (URLs, keys, project_id, region).
- Proyecto Vercel como entidad (project_id, dominio, deploy connection).
- Repo GitHub (mismo `Camionerou/sda.framework.git`).
- Hardware srv-ia-01 (GPU, OS, red, usuarios, MinerU, mineru-api, vllm container, modelos).
- Tu auth user en Supabase (`enzosaldivia@gmail.com`).
- Providers externos: OpenRouter, embedding provider, Google OAuth credentials.
- Upstash Redis (instancia, ya esta vacia).
- DNS, certificados, configuracion de dominio.

## 8. Post-conditions (estado esperado despues de la ejecucion)

- `main` tiene un commit squash unico (post-PR merge) representando el wipe completo.
- Repo contiene: `.git/`, `.gitignore`, `.env.example` minimo, `.env.local` intacto, `.vercel/` intacto, `.github/`, `.claude/`, `.firecrawl/`, `CLAUDE.md`, `README.md` minimo, esqueleto Next.js (app/, package.json, tsconfig.json, etc), `supabase/config.toml`, `supabase/migrations/` vacio, `docs/superpowers/specs/2026-05-24-wipe-restart-design.md`.
- Supabase: schemas `public` y `app` con 0 tablas, bucket `documents` con 0 objetos, 1 auth user, 0 pg_cron jobs, 0 migrations tracked, extensions intactas.
- Vercel: 22 env vars, mismo proyecto, mismo dominio.
- srv-ia-01: sin systemd units `sda-*`, sin clones nuestros, MinerU + vllm + modelos respondiendo.
- Memoria Claude: vacia.
- Tag git `pre-wipe-restart-2026-05-24` accesible para rollback durante 30+ dias.

## 9. Proximo paso

Invocar el skill `writing-plans` para generar el plan de ejecucion detallado con tasks granulares, dependencias entre fases y checkpoints de verificacion. El plan resultante se commiteara como `docs/superpowers/plans/2026-05-24-wipe-restart-plan.md` (excepcion adicional al wipe de `docs/`, mismo criterio que este spec).
