# Wipe and restart sdaframework — execution plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ejecutar el wipe total del codigo, schemas, migrations, docs y memoria persistente del proyecto SDA Framework, preservando todas las conexiones a servicios externos, segun el spec `docs/superpowers/specs/2026-05-24-wipe-restart-design.md`.

**Architecture:** Ejecucion secuencial en 9 fases (0–8) con tag git de rollback (`pre-wipe-restart-2026-05-24`) creado antes de tocar nada. Las fases 0–3 son reversibles (git). Las fases 4 (Supabase) y 6 (srv-ia-01) son irreversibles — cada paso destructivo tiene verificacion pre y post-estado, y un punto de confirmacion explicito con el usuario antes de ejecutar. La fase 5 (Vercel env vars) es reversible porque las keys viven en `.env.local`. Las fases 7–8 son cleanup cosmetico/local.

**Tech Stack:** `git` + `gh` CLI, `pnpm` + `node`, `supabase` CLI (v2.100.1+, Management API via `--linked`), `npx vercel`, `ssh` a srv-ia-01, `curl` para Upstash health check, scripts `bash` y `node` ad-hoc.

---

## Mapa de archivos/recursos afectados

### Filesystem local (repo)

- **Borrar (en commit de Fase 1)**: ver lista exhaustiva en spec §4 Fase 1.
- **Preservar**: `.git/`, `.gitignore`, `.env.example` (renovado en Fase 2), `.env.local`, `.vercel/`, `.github/`, `.claude/`, `.firecrawl/`, `CLAUDE.md`, `README.md` (reescrito en Fase 2), `supabase/config.toml`, `docs/superpowers/specs/2026-05-24-wipe-restart-design.md`, `docs/superpowers/plans/2026-05-24-wipe-restart-execution.md` (este archivo).
- **Crear (en Fase 2)**: archivos del scaffold Next.js (`app/page.tsx`, `app/layout.tsx`, `package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `tailwind.config.ts`, `eslint.config.mjs`, `next-env.d.ts`).

### Filesystem local (fuera del repo)

- **Borrar (en Fase 8)**: `~/.claude/projects/-Users-enzo-sda-framework-sda-framework/memory/*.md` (11 archivos + reset de MEMORY.md).
- **Crear temporales**: `/tmp/sda-snapshot-pre-wipe.json` (Fase 0), `/tmp/sda-scaffold/` (Fase 2), `/tmp/sda-auth-cleanup.mjs` (Fase 4), `/tmp/sda-upstash-check.sh` (Fase 0).

### Servicios externos

- **Supabase** (`anfawvxfepowsudlffnl`): SQL via `supabase db query --linked` (4 SQL files temporales en `/tmp/`), un script Node para borrar auth users.
- **Vercel** (`sda-framework`): `npx vercel env rm` x 5.
- **srv-ia-01**: SSH commands (systemctl + find + rm).
- **GitHub** (`Camionerou/sda.framework.git`): `gh pr create`, `gh pr merge --squash`, `git push --delete` x 3 branches.

---

## Fase 0 — Pre-flight

### Task 0.1: Confirmar working tree limpio en branch chore/wipe-restart

**Files:** ninguno (verificacion git)

- [ ] **Step 1: Verificar branch actual y working tree**

Run:
```bash
git status --short && echo "---" && git branch --show-current
```

Expected output:
```
?? docs/superpowers/plans/_evidence/
---
chore/wipe-restart
```

(El untracked `_evidence/` es esperado; se borra en Fase 1. Si aparecen otros untracked/modified, stashear con `git stash push -u -m "pre-execution-stash" -- <files>` antes de seguir.)

- [ ] **Step 2: Confirmar que el spec esta commiteado**

Run:
```bash
git log --oneline -1 docs/superpowers/specs/2026-05-24-wipe-restart-design.md
```

Expected: una linea con commit del spec.

### Task 0.2: Crear tag git de rollback

**Files:** ninguno (operacion git remota)

- [ ] **Step 1: Verificar que el tag no existe ya**

Run:
```bash
git tag -l 'pre-wipe-restart-2026-05-24'
```

Expected: salida vacia.

- [ ] **Step 2: Crear el tag apuntando al HEAD de main**

Run:
```bash
git tag -a pre-wipe-restart-2026-05-24 main -m "Rollback point antes del wipe total — spec docs/superpowers/specs/2026-05-24-wipe-restart-design.md"
```

Expected: sin output (exit 0).

- [ ] **Step 3: Push del tag al remote**

Run:
```bash
git push origin pre-wipe-restart-2026-05-24
```

Expected: `* [new tag]         pre-wipe-restart-2026-05-24 -> pre-wipe-restart-2026-05-24`.

- [ ] **Step 4: Verificar tag en remote**

Run:
```bash
git ls-remote --tags origin | grep pre-wipe-restart-2026-05-24
```

Expected: una linea con el SHA del tag.

### Task 0.3: Snapshot informativo del estado actual de Supabase

**Files:**
- Create: `/tmp/sda-snapshot-pre-wipe.json`

- [ ] **Step 1: Capturar inventario pre-wipe a JSON**

Run:
```bash
supabase db query --linked --output json "
WITH stats AS (
  SELECT 'tables_public' AS k, count(*)::text AS v FROM pg_tables WHERE schemaname='public'
  UNION ALL SELECT 'tables_app', count(*)::text FROM pg_tables WHERE schemaname='app'
  UNION ALL SELECT 'auth_users', count(*)::text FROM auth.users
  UNION ALL SELECT 'auth_user_enzo', count(*)::text FROM auth.users WHERE email='enzosaldivia@gmail.com'
  UNION ALL SELECT 'storage_buckets', count(*)::text FROM storage.buckets
  UNION ALL SELECT 'storage_objects', count(*)::text FROM storage.objects WHERE bucket_id='documents'
  UNION ALL SELECT 'cron_jobs', count(*)::text FROM cron.job
  UNION ALL SELECT 'migrations_tracked', count(*)::text FROM supabase_migrations.schema_migrations
  UNION ALL SELECT 'extensions_installed', count(*)::text FROM pg_extension WHERE extname <> 'plpgsql'
)
SELECT json_object_agg(k, v) AS snapshot FROM stats;
" > /tmp/sda-snapshot-pre-wipe.json
```

Expected: archivo creado con tamano > 0.

- [ ] **Step 2: Verificar contenido del snapshot**

Run:
```bash
cat /tmp/sda-snapshot-pre-wipe.json | tail -20
```

Expected: JSON con campos `tables_public=25`, `tables_app=0`, `auth_users=3`, `auth_user_enzo=1`, `storage_buckets=1`, `storage_objects=783`, `cron_jobs=2`, `migrations_tracked=46`, `extensions_installed=9`.

(Si los valores difieren significativamente, parar y reportar al usuario antes de seguir — el inventario del spec esta desactualizado.)

### Task 0.4: Verificar conectividad a los 4 servicios

**Files:** ninguno

- [ ] **Step 1: GitHub CLI**

Run:
```bash
gh auth status 2>&1 | head -5
```

Expected: `Logged in to github.com account Camionerou`.

- [ ] **Step 2: Supabase CLI linked**

Run:
```bash
supabase projects list 2>&1 | grep -E '●.*anfawvxfepowsudlffnl'
```

Expected: una linea con el proyecto linkeado.

- [ ] **Step 3: Vercel CLI**

Run:
```bash
npx -y vercel@latest whoami 2>&1
```

Expected: `enzosaldivia-1171` (o el usuario actual).

- [ ] **Step 4: SSH srv-ia-01**

Run:
```bash
ssh srv-ia-01 'hostname && systemctl list-units "sda-*" --no-pager --no-legend' 2>&1
```

Expected: hostname del server, seguido de las 2 lineas `sda-compute-gateway.service` y `sda-tree-indexer.service` con estado `active running` o `active`.

(Si SSH falla, parar — necesitamos acceso para Fase 6.)

---

## Fase 1 — Wipe repo (commit en chore/wipe-restart)

### Task 1.1: Borrar codigo de aplicacion (app/, components/, lib/, inngest/, workers/, bin/, cli/, scripts/)

**Files:**
- Delete: `app/`, `components/`, `lib/`, `inngest/`, `workers/`, `bin/`, `cli/`, `scripts/`

- [ ] **Step 1: Verificar que todos existen antes de borrar**

Run:
```bash
for d in app components lib inngest workers bin cli scripts; do
  [ -d "$d" ] && echo "$d: presente" || echo "$d: NO EXISTE"
done
```

Expected: todos `presente`.

- [ ] **Step 2: Borrar con git rm**

Run:
```bash
git rm -r app components lib inngest workers bin cli scripts 2>&1 | tail -5
```

Expected: linea final `rm '...'` por cada archivo borrado, sin errores.

- [ ] **Step 3: Verificar que git lo registro**

Run:
```bash
git status --short | grep '^D ' | wc -l
```

Expected: numero > 100 (cientos de archivos borrados).

### Task 1.2: Borrar contenido de supabase/ (preservar solo config.toml)

**Files:**
- Delete: `supabase/migrations/*`, `supabase/snippets/`, `supabase/tests/`, `supabase/seed.sql`, `supabase/google-oauth.md`
- Preserve: `supabase/config.toml`

- [ ] **Step 1: Verificar contenido actual**

Run:
```bash
ls supabase/
```

Expected: `config.toml google-oauth.md migrations seed.sql snippets tests`.

- [ ] **Step 2: Borrar todo menos config.toml**

Run:
```bash
git rm -r supabase/migrations supabase/snippets supabase/tests supabase/seed.sql supabase/google-oauth.md 2>&1 | tail -5
```

Expected: confirmacion de borrado.

- [ ] **Step 3: Verificar que solo queda config.toml**

Run:
```bash
ls supabase/
```

Expected: `config.toml` unicamente.

### Task 1.3: Borrar docs/ (preservar solo este plan y el spec)

**Files:**
- Delete: `docs/backend/`, `docs/frontend/`, `docs/archivado/`, `docs/middleware/`, `docs/superpowers/plans/2026-05-21-mineru-gpu-tree-pipeline-acceleration.md`, `docs/superpowers/plans/2026-05-22-supabase-multitenant-platform.md`, `docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier1-foundation.md`, `docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier2-multipliers.md`, `docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier3-enterprise.md`, `docs/superpowers/plans/2026-05-24-db-extensions-tier2-tier3-restructure.md`, `docs/superpowers/plans/_evidence/`, `docs/superpowers/specs/2026-05-21-mineru-gpu-tree-pipeline-acceleration-design.md`, `docs/superpowers/specs/2026-05-22-supabase-multitenant-audit-design.md`, `docs/README.md`, `docs/arquitectura.md`, `docs/db-extensions.md`, `docs/db-tuning.md`, `docs/gotchas.md`, `docs/pageindex-tree-builder-reference.md`, `docs/tree-indexer-pipeline.md`
- Preserve: `docs/superpowers/specs/2026-05-24-wipe-restart-design.md`, `docs/superpowers/plans/2026-05-24-wipe-restart-execution.md`

- [ ] **Step 1: Borrar carpetas grandes de docs**

Run:
```bash
git rm -r docs/backend docs/frontend docs/archivado docs/middleware 2>&1 | tail -3
```

Expected: confirmacion de borrado.

- [ ] **Step 2: Borrar planes y specs viejos (preservar 2026-05-24-*)**

Run:
```bash
git rm docs/superpowers/plans/2026-05-21-mineru-gpu-tree-pipeline-acceleration.md \
       docs/superpowers/plans/2026-05-22-supabase-multitenant-platform.md \
       docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier1-foundation.md \
       docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier2-multipliers.md \
       docs/superpowers/plans/2026-05-22-supabase-multitenant-platform-tier3-enterprise.md \
       docs/superpowers/plans/2026-05-24-db-extensions-tier2-tier3-restructure.md \
       docs/superpowers/specs/2026-05-21-mineru-gpu-tree-pipeline-acceleration-design.md \
       docs/superpowers/specs/2026-05-22-supabase-multitenant-audit-design.md
```

Expected: confirmacion `rm '...'` por cada archivo.

- [ ] **Step 3: Borrar `_evidence/` untracked**

Run:
```bash
rm -rf docs/superpowers/plans/_evidence
```

Expected: sin output, exit 0.

- [ ] **Step 4: Borrar archivos sueltos en docs/ raiz**

Run:
```bash
git rm docs/README.md docs/arquitectura.md docs/db-extensions.md docs/db-tuning.md \
       docs/gotchas.md docs/pageindex-tree-builder-reference.md docs/tree-indexer-pipeline.md
```

Expected: confirmacion `rm '...'`.

- [ ] **Step 5: Verificar que docs/ solo tiene los 2 archivos preservados**

Run:
```bash
find docs -type f
```

Expected exactamente:
```
docs/superpowers/specs/2026-05-24-wipe-restart-design.md
docs/superpowers/plans/2026-05-24-wipe-restart-execution.md
```

### Task 1.4: Borrar carpetas raras en raiz, archivos config viejos y caches

**Files:**
- Delete: `auth_jwt_claims_v2_test.sql/`, `rls_helpers_app_test.sql/`, `rpcs_workspaces_test.sql/`, `proxy.ts`, `components.json`, `next.config.mjs`, `eslint.config.mjs`, `postcss.config.mjs`, `tsconfig.json`, `tsconfig.tsbuildinfo`, `next-env.d.ts`, `package.json`, `package-lock.json`, `renovate.json`, `CHANGELOG.md`, `AGENT.md`, `CODEX.md`, `.next/`, `node_modules/`

- [ ] **Step 1: Borrar carpetas test-named en raiz**

Run:
```bash
rm -rf auth_jwt_claims_v2_test.sql rls_helpers_app_test.sql rpcs_workspaces_test.sql
```

Expected: sin output.

- [ ] **Step 2: Borrar archivos config y metadata trackeados**

Run:
```bash
git rm proxy.ts components.json next.config.mjs eslint.config.mjs postcss.config.mjs \
       tsconfig.json next-env.d.ts package.json package-lock.json renovate.json \
       CHANGELOG.md AGENT.md
```

Expected: confirmacion `rm '...'`.

- [ ] **Step 3: Borrar archivos untracked en raiz**

Run:
```bash
rm -f tsconfig.tsbuildinfo CODEX.md CLAUDE.md
```

(NOTA: el `CLAUDE.md` de la raiz es untracked pero esta listado como "preservar". Si tiene contenido custom, parar y preguntar al usuario. Si solo replica el contenido de `/Users/enzo/sda.framework/sda.framework/CLAUDE.md` que ya conocemos del system prompt, se regenera al hacer Write en Fase 2.)

Run para chequear:
```bash
diff -q CLAUDE.md /dev/stdin <<'EOF'
nunca hacer mocks
nunca hacer demos
nunca hacer archivos monoliticos, si encuentras uno ten la iniciativa y propone descomponerlo en subs
filosofia de codigo LEAN
amamos las deps, nos ayudan a simplificar trabajo, confiamos en que no tengan downtime ciegamente, son plataformas serias y reliable
generar memorias con gotchas
aprender siempre de las sesiones
EOF
```

Expected: sin output (los archivos son identicos, seguro borrar).

Si difieren: hacer `cp CLAUDE.md /tmp/CLAUDE-backup.md` antes del rm.

- [ ] **Step 4: Borrar caches/builds**

Run:
```bash
rm -rf .next node_modules
```

Expected: sin output.

- [ ] **Step 5: Verificar estado del repo**

Run:
```bash
ls -la | grep -v '^total' | awk '{print $NF}' | sort
```

Expected (lo que debe quedar):
```
.
..
.claude
.env.example
.env.local
.firecrawl
.git
.github
.gitignore
.vercel
README.md
docs
supabase
```

### Task 1.5: Commit del wipe

**Files:** ninguno (commit)

- [ ] **Step 1: Verificar staging area**

Run:
```bash
git status --short | head -20
```

Expected: muchos archivos con estado `D` (deleted), ninguno `M` o `??` (excepto archivos que vamos a crear en Fase 2).

- [ ] **Step 2: Crear commit del wipe**

Run:
```bash
git commit -m "$(cat <<'EOF'
chore(wipe): remove tier1 codebase, migrations, docs and workers

Per spec docs/superpowers/specs/2026-05-24-wipe-restart-design.md.

Deleted:
- App code: app/, components/, lib/, inngest/, workers/, bin/, cli/, scripts/
- Supabase: 46 migrations, snippets/, tests/, seed.sql, google-oauth.md
- Docs: backend/, frontend/, archivado/, middleware/, all plans+specs except 2026-05-24
- Root configs: package.json, tsconfig*, next.config, eslint, postcss, components.json
- Root metadata: CHANGELOG, AGENT.md, CODEX.md, renovate.json
- Test folders: auth_jwt_claims_v2_test.sql/, rls_helpers_app_test.sql/, rpcs_workspaces_test.sql/
- Caches: .next/, node_modules/, tsconfig.tsbuildinfo

Preserved:
- supabase/config.toml (project link)
- .env.local, .env.example, .vercel/, .github/, .claude/, .firecrawl/, .gitignore
- README.md (to be rewritten in Phase 2)
- CLAUDE.md (to be rewritten in Phase 2)
- docs/superpowers/specs/2026-05-24-wipe-restart-design.md
- docs/superpowers/plans/2026-05-24-wipe-restart-execution.md
EOF
)"
```

Expected: `[chore/wipe-restart <sha>] chore(wipe): remove tier1 codebase...` con linea de stats.

---

## Fase 2 — Scaffold fresco

### Task 2.1: Generar scaffold Next.js en /tmp

**Files:**
- Create: `/tmp/sda-scaffold/` (descartable, solo source para mover)

- [ ] **Step 1: Limpiar /tmp/sda-scaffold/ si existe**

Run:
```bash
rm -rf /tmp/sda-scaffold
```

Expected: sin output.

- [ ] **Step 2: Correr create-next-app sin install**

Run:
```bash
cd /tmp && npx -y create-next-app@latest sda-scaffold \
  --typescript --app --tailwind --eslint \
  --no-src-dir --import-alias='@/*' \
  --turbopack --no-install --use-pnpm \
  --skip-install 2>&1 | tail -20
```

Expected: lineas tipo `Creating a new Next.js app in /tmp/sda-scaffold.` seguido de archivos creados. Sin install (rapido).

- [ ] **Step 3: Verificar archivos generados**

Run:
```bash
ls /tmp/sda-scaffold/
```

Expected (depende de la version de next pero algo asi):
```
app  eslint.config.mjs  next-env.d.ts  next.config.ts  package.json  postcss.config.mjs  README.md  tsconfig.json
```

### Task 2.2: Mover scaffold a la raiz del repo

**Files:**
- Create: archivos del scaffold en raiz del repo
- Preserve: archivos listados en Mapa de archivos/recursos afectados → Filesystem local (repo) → Preservar

- [ ] **Step 1: Volver a la raiz del repo y borrar README del scaffold**

Run:
```bash
cd /Users/enzo/sda.framework/sda.framework
rm /tmp/sda-scaffold/README.md
```

(El scaffold genera su propio README. Vamos a escribir uno custom en Task 2.4.)

- [ ] **Step 2: Mover archivos del scaffold a raiz**

Run:
```bash
cp -r /tmp/sda-scaffold/. /Users/enzo/sda.framework/sda.framework/
```

Expected: sin output, exit 0.

- [ ] **Step 3: Verificar archivos en raiz**

Run:
```bash
ls -la
```

Expected (debe aparecer): `app/`, `eslint.config.mjs`, `next-env.d.ts`, `next.config.ts`, `package.json`, `postcss.config.mjs`, `tsconfig.json`. Sumado a lo preservado de Fase 1.

- [ ] **Step 4: Limpiar /tmp**

Run:
```bash
rm -rf /tmp/sda-scaffold
```

### Task 2.3: Instalar dependencias

**Files:** ninguno (modifica `node_modules/` no trackeado y `pnpm-lock.yaml`)

- [ ] **Step 1: Verificar que pnpm-lock.yaml no existe aun**

Run:
```bash
ls pnpm-lock.yaml package-lock.json 2>&1
```

Expected: ambos "No such file or directory".

- [ ] **Step 2: pnpm install**

Run:
```bash
pnpm install 2>&1 | tail -10
```

Expected: `Done in <X>s` o equivalente. Sin warnings criticos. `pnpm-lock.yaml` creado.

- [ ] **Step 3: Smoke test del scaffold**

Run:
```bash
pnpm run build 2>&1 | tail -15
```

Expected: build exitoso, output tipo `Compiled successfully` con tabla de routes (al menos `/` ruta indexada).

(Si el build falla, parar y debuggear. No commitear scaffold roto.)

### Task 2.4: Reescribir README.md y .env.example minimos

**Files:**
- Modify: `README.md`
- Modify: `.env.example`

- [ ] **Step 1: Escribir README minimo**

Crear contenido en `README.md`:

```markdown
# SDA Framework

Plataforma multitenant en reconstruccion desde cero (2026-05-24).

## Estado

Wipe ejecutado segun spec `docs/superpowers/specs/2026-05-24-wipe-restart-design.md`.
Rollback tag: `pre-wipe-restart-2026-05-24`.

## Stack

- Next.js 15 (App Router, TypeScript, Tailwind)
- Supabase (Postgres + Auth + Storage)
- Inngest (event-driven workflows)
- Upstash Redis (cache + rate limit)
- Vercel (hosting)
- srv-ia-01 (compute backend con MinerU + vllm)

## Setup

```bash
pnpm install
cp .env.example .env.local
# Editar .env.local con keys reales (ver Vercel env vars en sdaframework/sda-framework)
pnpm dev
```
```

- [ ] **Step 2: Escribir .env.example minimo**

Crear contenido en `.env.example`:

```
# Supabase (proyecto: anfawvxfepowsudlffnl)
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
```

- [ ] **Step 3: Verificar archivos creados**

Run:
```bash
wc -l README.md .env.example
```

Expected: README ~25 lineas, .env.example ~5 lineas.

### Task 2.5: Reescribir CLAUDE.md raiz

**Files:**
- Create: `CLAUDE.md`

- [ ] **Step 1: Crear CLAUDE.md con las reglas del proyecto**

Crear contenido en `CLAUDE.md`:

```
nunca hacer mocks
nunca hacer demos
nunca hacer archivos monoliticos, si encuentras uno ten la iniciativa y propone descomponerlo en subs
filosofia de codigo LEAN
amamos las deps, nos ayudan a simplificar trabajo, confiamos en que no tengan downtime ciegamente, son plataformas serias y reliable
generar memorias con gotchas
aprender siempre de las sesiones
```

Expected: archivo creado.

### Task 2.6: Commits del scaffold

**Files:** ninguno (commits)

- [ ] **Step 1: Stage del scaffold Next.js**

Run:
```bash
git add app eslint.config.mjs next-env.d.ts next.config.ts package.json \
        pnpm-lock.yaml postcss.config.mjs tsconfig.json
```

(Si el scaffold genero archivos adicionales como `public/` o `.gitignore` modificado, agregarlos tambien con `git add -A` para los cambios scaffold-relacionados. Verificar con `git status` antes de commit.)

- [ ] **Step 2: Commit del scaffold Next.js**

Run:
```bash
git commit -m "chore(scaffold): next.js 15 app router fresh setup"
```

Expected: `[chore/wipe-restart <sha>]`.

- [ ] **Step 3: Stage del README, .env.example, CLAUDE.md**

Run:
```bash
git add README.md .env.example CLAUDE.md
```

- [ ] **Step 4: Commit del setup minimo**

Run:
```bash
git commit -m "chore(scaffold): minimal README, .env.example and CLAUDE.md"
```

Expected: `[chore/wipe-restart <sha>]`.

---

## Fase 3 — PR + merge a main

### Task 3.1: Push de la branch a remote

**Files:** ninguno

- [ ] **Step 1: Push de la branch chore/wipe-restart**

Run:
```bash
git push -u origin chore/wipe-restart 2>&1 | tail -5
```

Expected: `* [new branch]      chore/wipe-restart -> chore/wipe-restart` y `Branch 'chore/wipe-restart' set up to track remote branch 'chore/wipe-restart' from 'origin'.`

### Task 3.2: Crear PR a main

**Files:** ninguno (operacion GitHub)

- [ ] **Step 1: Crear PR con body extenso**

Run:
```bash
gh pr create --title "chore: wipe and restart sdaframework from zero" --body "$(cat <<'EOF'
## Summary

Wipe total del codebase Tier 1 segun spec aprobado.

- Spec: `docs/superpowers/specs/2026-05-24-wipe-restart-design.md`
- Plan de ejecucion: `docs/superpowers/plans/2026-05-24-wipe-restart-execution.md`
- Rollback tag: `pre-wipe-restart-2026-05-24`

## Que se borra en este PR

- Codigo app (Next.js + workers Node y Python)
- 46 migraciones Supabase + seed + tests pgTAP
- Docs Tier 1 (backend, frontend, planes Tier 1/2/3, gotchas, arquitectura, etc)
- Configs viejos (package.json, tsconfig, next.config, eslint, postcss, components.json)
- Metadata (CHANGELOG, AGENT.md, CODEX.md, renovate.json)
- Caches (.next, node_modules)

## Que se preserva

- `.git/`, `.gitignore`, `.env.local`, `.env.example` (renovado), `.vercel/`, `.github/`, `.claude/`, `.firecrawl/`
- `supabase/config.toml` (project link a `anfawvxfepowsudlffnl`)
- `docs/superpowers/specs/2026-05-24-wipe-restart-design.md`
- `docs/superpowers/plans/2026-05-24-wipe-restart-execution.md`
- `CLAUDE.md` (raiz, reglas del proyecto)
- `README.md` (reescrito minimo)
- Esqueleto Next.js 15 fresco (app router, TS, Tailwind, eslint, turbopack)

## Que NO toca este PR (queda para fases post-merge)

- Supabase schemas + storage + auth users (Fase 4 del plan)
- Vercel env vars cleanup (Fase 5)
- srv-ia-01 services + clones (Fase 6)
- Inngest dashboard cleanup (Fase 7, manual)
- Memoria Claude persistente + branches viejas (Fase 8)

## Estrategia de merge

Squash merge → un solo commit en `main` que representa el wipe completo.
Las decisiones detalladas viven en el spec; el commit history granular vive solo en esta branch antes del squash.

## Test plan

- [ ] Build local: `pnpm run build` → exitoso (verificado en Task 2.3).
- [ ] CI checks de GitHub: que pasen (si hay).
- [ ] Manual: revisar diff completo del PR para confirmar que nada importante quedo borrado por accidente.
EOF
)" 2>&1 | tail -3
```

Expected: URL del PR creado, tipo `https://github.com/Camionerou/sda.framework/pull/<N>`.

- [ ] **Step 2: Guardar el numero del PR para los siguientes pasos**

Run:
```bash
PR_NUM=$(gh pr list --head chore/wipe-restart --json number --jq '.[0].number')
echo "PR number: $PR_NUM"
```

Expected: numero del PR (entero).

### Task 3.3: Squash merge a main

**Files:** ninguno (operacion GitHub)

- [ ] **Step 1: Esperar/verificar checks de CI (si hay)**

Run:
```bash
gh pr checks chore/wipe-restart 2>&1 | head -10
```

Expected: `no checks reported on the 'chore/wipe-restart' branch` o lista de checks. Si hay checks corriendo, esperar a que terminen antes de merge.

- [ ] **Step 2: Squash merge con auto-delete de branch**

Run:
```bash
gh pr merge chore/wipe-restart --squash --delete-branch 2>&1
```

Expected: `✓ Squashed and merged pull request #<N>` seguido de `✓ Deleted branch chore/wipe-restart`.

- [ ] **Step 3: Volver a main local y pull**

Run:
```bash
git checkout main && git pull origin main 2>&1 | tail -5
```

Expected: `Fast-forward` o `Already up to date` luego del fetch.

- [ ] **Step 4: Verificar el squash commit en main**

Run:
```bash
git log --oneline -3
```

Expected: primer linea es el squash commit con titulo `chore: wipe and restart sdaframework from zero (#<N>)`.

- [ ] **Step 5: Limpiar branch local borrada**

Run:
```bash
git branch -d chore/wipe-restart 2>&1
```

Expected: `Deleted branch chore/wipe-restart (was <sha>)` o `error: branch 'chore/wipe-restart' not found` (si ya se borro automaticamente).

---

## Fase 4 — Supabase wipe (post-merge, **IRREVERSIBLE**)

### Task 4.1: Confirmacion explicita de irreversibilidad con el usuario

**Files:** ninguno (gate de confirmacion)

- [ ] **Step 1: Mostrar al usuario el snapshot pre-wipe y pedir confirmacion explicita**

Display al usuario:
```
PROXIMA FASE: SUPABASE WIPE (IRREVERSIBLE).

Sobre el proyecto anfawvxfepowsudlffnl se ejecutara:
  1. Drop de 2 pg_cron jobs (sda-operational-cleanup, sda-indexing-health-refresh)
  2. DELETE de 783 storage objects en bucket 'documents'
  3. DROP SCHEMA app CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;
  4. TRUNCATE supabase_migrations.schema_migrations (borra tracking de 46 migrations)
  5. Borrado de 2 auth.users (preservando enzosaldivia@gmail.com)

Despues de esto solo recuperable via Supabase PITR (Point-In-Time Recovery, requiere plan pago).

Tag git de rollback existe (pre-wipe-restart-2026-05-24) pero NO recupera la DB.

Confirmas continuar? (yes/no)
```

Si la respuesta no es un YES explicito, parar y reportar.

### Task 4.2: Desactivar pg_cron jobs

**Files:** ninguno (SQL via Management API)

- [ ] **Step 1: Verificar estado pre-execucion**

Run:
```bash
supabase db query --linked --output json "SELECT jobid, jobname, active FROM cron.job ORDER BY jobid;" 2>&1 | tail -20
```

Expected: 2 rows con `active: true`.

- [ ] **Step 2: Unschedule de los 2 jobs**

Run:
```bash
supabase db query --linked "
SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname IN ('sda-operational-cleanup', 'sda-indexing-health-refresh');
" 2>&1 | tail -10
```

Expected: 2 rows devueltas, sin errores.

- [ ] **Step 3: Verificar que cron.job esta vacio**

Run:
```bash
supabase db query --linked --output json "SELECT count(*) AS jobs FROM cron.job;" 2>&1 | tail -10
```

Expected: `"jobs": 0`.

### Task 4.3: Vaciar storage objects del bucket documents

**Files:** ninguno (SQL via Management API)

- [ ] **Step 1: Verificar count pre-delete**

Run:
```bash
supabase db query --linked --output json "SELECT count(*) AS objs FROM storage.objects WHERE bucket_id='documents';" 2>&1 | tail -10
```

Expected: `"objs": 783` (o el numero del snapshot pre-wipe).

- [ ] **Step 2: Delete masivo**

Run:
```bash
supabase db query --linked "DELETE FROM storage.objects WHERE bucket_id='documents';" 2>&1 | tail -5
```

Expected: respuesta del Management API confirmando el statement.

- [ ] **Step 3: Verificar count post-delete**

Run:
```bash
supabase db query --linked --output json "SELECT count(*) AS objs FROM storage.objects WHERE bucket_id='documents';" 2>&1 | tail -10
```

Expected: `"objs": 0`.

- [ ] **Step 4: Verificar que el bucket sigue existiendo (vacio)**

Run:
```bash
supabase db query --linked --output json "SELECT id, name, public::text FROM storage.buckets;" 2>&1 | tail -10
```

Expected: 1 row con `id: documents, name: documents, public: false`.

### Task 4.4: Drop schemas public + app y recrear public vacio

**Files:** ninguno (SQL via Management API)

- [ ] **Step 1: Verificar count pre-drop**

Run:
```bash
supabase db query --linked --output json "
SELECT 'public_tables' AS k, count(*)::text AS v FROM pg_tables WHERE schemaname='public'
UNION ALL SELECT 'app_tables', count(*)::text FROM pg_tables WHERE schemaname='app';
" 2>&1 | tail -10
```

Expected: `public_tables: 25, app_tables: 0`.

- [ ] **Step 2: Drop + recreate**

Run:
```bash
supabase db query --linked "
DROP SCHEMA IF EXISTS app CASCADE;
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON SCHEMA public TO postgres, service_role;
" 2>&1 | tail -10
```

Expected: respuesta sin errores. (Puede demorar varios segundos por el CASCADE).

- [ ] **Step 3: Verificar schemas pos-drop**

Run:
```bash
supabase db query --linked --output json "
SELECT nspname FROM pg_namespace
WHERE nspname IN ('public', 'app')
ORDER BY nspname;
" 2>&1 | tail -10
```

Expected: 1 row con `nspname: public` (app no existe).

- [ ] **Step 4: Verificar que public esta vacio**

Run:
```bash
supabase db query --linked --output json "
SELECT count(*) AS tables FROM pg_tables WHERE schemaname='public';
" 2>&1 | tail -10
```

Expected: `"tables": 0`.

- [ ] **Step 5: Verificar que extensions sobrevivieron**

Run:
```bash
supabase db query --linked --output json "
SELECT count(*) AS exts FROM pg_extension WHERE extname <> 'plpgsql';
" 2>&1 | tail -10
```

Expected: `"exts": 9` (mismo numero del snapshot).

### Task 4.5: Reset del tracking de migrations

**Files:** ninguno (SQL via Management API)

- [ ] **Step 1: Verificar count pre-truncate**

Run:
```bash
supabase db query --linked --output json "SELECT count(*) AS migs FROM supabase_migrations.schema_migrations;" 2>&1 | tail -10
```

Expected: `"migs": 46`.

- [ ] **Step 2: Truncate**

Run:
```bash
supabase db query --linked "TRUNCATE supabase_migrations.schema_migrations;" 2>&1 | tail -5
```

Expected: respuesta sin errores.

- [ ] **Step 3: Verificar count post-truncate**

Run:
```bash
supabase db query --linked --output json "SELECT count(*) AS migs FROM supabase_migrations.schema_migrations;" 2>&1 | tail -10
```

Expected: `"migs": 0`.

### Task 4.6: Borrar auth users excepto enzo

**Files:**
- Create: `/tmp/sda-auth-cleanup.mjs`

- [ ] **Step 1: Verificar count pre-delete + listar emails**

Run:
```bash
supabase db query --linked --output json "
SELECT json_build_object(
  'total', count(*),
  'enzo', count(*) FILTER (WHERE email='enzosaldivia@gmail.com'),
  'other_emails', array_agg(email) FILTER (WHERE email<>'enzosaldivia@gmail.com')
) AS result FROM auth.users;
" 2>&1 | tail -15
```

Expected: `total: 3, enzo: 1, other_emails: ["<email1>", "<email2>"]`.

- [ ] **Step 2: Escribir script Node de cleanup**

Crear contenido en `/tmp/sda-auth-cleanup.mjs`:

```javascript
import { createClient } from "/Users/enzo/sda.framework/sda.framework/node_modules/@supabase/supabase-js/dist/index.mjs";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync("/Users/enzo/sda.framework/sda.framework/.env.local", "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const idx = l.indexOf("=");
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim().replace(/^["']|["']$/g, "")];
    })
);

const url = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false } });
const PRESERVE_EMAIL = "enzosaldivia@gmail.com";

const { data, error } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
if (error) {
  console.error("listUsers error:", error.message);
  process.exit(1);
}

const toDelete = data.users.filter((u) => u.email !== PRESERVE_EMAIL);
console.log(`Found ${data.users.length} users, will delete ${toDelete.length}, preserving ${PRESERVE_EMAIL}`);

for (const user of toDelete) {
  console.log(`Deleting ${user.email} (${user.id})...`);
  const { error: delErr } = await sb.auth.admin.deleteUser(user.id);
  if (delErr) {
    console.error(`  FAILED: ${delErr.message}`);
    process.exit(1);
  }
  console.log(`  OK`);
}

// Re-verify
const { data: after } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
console.log(`Remaining users: ${after.users.length}`);
console.log(`Enzo present: ${after.users.some((u) => u.email === PRESERVE_EMAIL)}`);
```

(NOTA: el path a `node_modules` apunta al repo. Despues de Fase 1, `node_modules/` se reinstalo en Fase 2.3, asi que el path sigue valido. Si por alguna razon no existe, instalar el SDK en /tmp con `cd /tmp && npm init -y && npm i @supabase/supabase-js` y ajustar el import path.)

- [ ] **Step 3: Ejecutar el script**

Run:
```bash
node /tmp/sda-auth-cleanup.mjs 2>&1
```

Expected:
```
Found 3 users, will delete 2, preserving enzosaldivia@gmail.com
Deleting <email1> (<uuid>)...
  OK
Deleting <email2> (<uuid>)...
  OK
Remaining users: 1
Enzo present: true
```

- [ ] **Step 4: Verificar via SQL**

Run:
```bash
supabase db query --linked --output json "
SELECT count(*) AS users, count(*) FILTER (WHERE email='enzosaldivia@gmail.com') AS enzo FROM auth.users;
" 2>&1 | tail -10
```

Expected: `users: 1, enzo: 1`.

### Task 4.7: Verificacion final consolidada de Fase 4

**Files:** ninguno

- [ ] **Step 1: Capturar snapshot post-wipe y comparar contra pre-wipe**

Run:
```bash
supabase db query --linked --output json "
SELECT json_build_object(
  'public_tables', (SELECT count(*) FROM pg_tables WHERE schemaname='public'),
  'app_schema_exists', (SELECT count(*) FROM pg_namespace WHERE nspname='app'),
  'storage_objects', (SELECT count(*) FROM storage.objects WHERE bucket_id='documents'),
  'storage_buckets', (SELECT count(*) FROM storage.buckets),
  'cron_jobs', (SELECT count(*) FROM cron.job),
  'auth_users', (SELECT count(*) FROM auth.users),
  'migrations_tracked', (SELECT count(*) FROM supabase_migrations.schema_migrations),
  'extensions_installed', (SELECT count(*) FROM pg_extension WHERE extname<>'plpgsql')
) AS result;
" > /tmp/sda-snapshot-post-wipe.json
cat /tmp/sda-snapshot-post-wipe.json | tail -15
```

Expected exactamente:
- `public_tables: 0`
- `app_schema_exists: 0`
- `storage_objects: 0`
- `storage_buckets: 1`
- `cron_jobs: 0`
- `auth_users: 1`
- `migrations_tracked: 0`
- `extensions_installed: 9`

Si algun valor difiere, parar y reportar al usuario.

---

## Fase 5 — Vercel env vars cleanup

### Task 5.1: Verificar estado pre-cleanup

**Files:** ninguno

- [ ] **Step 1: Listar env vars actuales**

Run:
```bash
npx -y vercel@latest env ls 2>&1 | grep -E '^\s+(COMPUTE_GATEWAY|PDF_VIEWER|NEXT_PUBLIC_APP_URL|APP_ORIGIN)' | wc -l
```

Expected: `5` (las 5 vars a borrar estan presentes).

### Task 5.2: Borrar las 5 env vars obsoletas

**Files:** ninguno

- [ ] **Step 1: Borrar COMPUTE_GATEWAY_URL**

Run:
```bash
npx -y vercel@latest env rm COMPUTE_GATEWAY_URL production --yes 2>&1 | tail -3
```

Expected: confirmacion `Removed Environment Variable COMPUTE_GATEWAY_URL from Project sda-framework`.

- [ ] **Step 2: Borrar COMPUTE_GATEWAY_TOKEN**

Run:
```bash
npx -y vercel@latest env rm COMPUTE_GATEWAY_TOKEN production --yes 2>&1 | tail -3
```

Expected: confirmacion analoga.

- [ ] **Step 3: Borrar PDF_VIEWER_SIGNED_URL_TTL**

Run:
```bash
npx -y vercel@latest env rm PDF_VIEWER_SIGNED_URL_TTL production --yes 2>&1 | tail -3
```

Expected: confirmacion.

- [ ] **Step 4: Borrar NEXT_PUBLIC_APP_URL**

Run:
```bash
npx -y vercel@latest env rm NEXT_PUBLIC_APP_URL production --yes 2>&1 | tail -3
```

Expected: confirmacion.

- [ ] **Step 5: Borrar APP_ORIGIN**

Run:
```bash
npx -y vercel@latest env rm APP_ORIGIN production --yes 2>&1 | tail -3
```

Expected: confirmacion.

### Task 5.3: Verificar count final

**Files:** ninguno

- [ ] **Step 1: Listar env vars y contar**

Run:
```bash
npx -y vercel@latest env ls 2>&1 | grep -E '^\s+[A-Z_]+\s+Encrypted' | wc -l
```

Expected: `22` (27 originales - 5 borradas).

- [ ] **Step 2: Verificar que ninguna de las 5 borradas sigue presente**

Run:
```bash
npx -y vercel@latest env ls 2>&1 | grep -E '^(\s+)?(COMPUTE_GATEWAY|PDF_VIEWER_SIGNED_URL_TTL|NEXT_PUBLIC_APP_URL|APP_ORIGIN)' | wc -l
```

Expected: `0`.

---

## Fase 6 — srv-ia-01 wipe (SSH, **IRREVERSIBLE**)

### Task 6.1: Confirmacion explicita de irreversibilidad

**Files:** ninguno (gate)

- [ ] **Step 1: Mostrar al usuario qué se va a tocar y pedir confirmacion**

Display al usuario:
```
PROXIMA FASE: srv-ia-01 WIPE (IRREVERSIBLE).

Sobre el servidor srv-ia-01 se ejecutara via SSH:
  1. systemctl stop sda-compute-gateway sda-tree-indexer
  2. systemctl disable sda-compute-gateway sda-tree-indexer
  3. rm /etc/systemd/system/sda-{compute-gateway,tree-indexer}.service
  4. find / -name 'sda*' -o -name 'compute-gateway*' -o -name 'tree-indexer*'
     (mostrar resultado, esperar confirmacion del usuario, despues sudo rm -rf paths)

NO se tocara:
  - MinerU 3.x + mineru-api
  - vllm container (queda como este)
  - Modelos descargados
  - OS, usuarios, red

Confirmas continuar? (yes/no)
```

Si la respuesta no es YES explicito, parar.

### Task 6.2: Stop + disable + rm systemd units

**Files:** ninguno (SSH)

- [ ] **Step 1: Verificar estado de los units pre-stop**

Run:
```bash
ssh srv-ia-01 'systemctl list-units "sda-*" --no-pager --no-legend' 2>&1
```

Expected: 2 lineas con `sda-compute-gateway.service` y `sda-tree-indexer.service`.

- [ ] **Step 2: Stop**

Run:
```bash
ssh srv-ia-01 'sudo systemctl stop sda-compute-gateway sda-tree-indexer' 2>&1
```

Expected: sin output, exit 0. (Si pide password sudo: el usuario lo introduce manualmente).

- [ ] **Step 3: Disable**

Run:
```bash
ssh srv-ia-01 'sudo systemctl disable sda-compute-gateway sda-tree-indexer' 2>&1
```

Expected: lineas tipo `Removed /etc/systemd/system/multi-user.target.wants/sda-*.service`.

- [ ] **Step 4: Remove unit files**

Run:
```bash
ssh srv-ia-01 'sudo rm -f /etc/systemd/system/sda-compute-gateway.service /etc/systemd/system/sda-tree-indexer.service && sudo systemctl daemon-reload' 2>&1
```

Expected: sin output, exit 0.

- [ ] **Step 5: Verificar que ya no hay units sda-***

Run:
```bash
ssh srv-ia-01 'systemctl list-units "sda-*" --no-pager --no-legend ; systemctl list-unit-files "sda-*" --no-pager --no-legend' 2>&1
```

Expected: salida vacia (ningun unit sda-*).

### Task 6.3: Inventariar clones + venvs + archivos nuestros

**Files:** ninguno (SSH)

- [ ] **Step 1: Buscar todo lo que parece nuestro**

Run:
```bash
ssh srv-ia-01 "sudo find / -maxdepth 5 \\( -path /proc -o -path /sys -o -path /snap \\) -prune -o \\( -name 'sda*' -o -name 'compute-gateway*' -o -name 'tree-indexer*' \\) -print 2>/dev/null | grep -vE '^/(proc|sys|snap)/'" 2>&1 | tee /tmp/sda-srv-paths.txt
```

Expected: lista de paths. Probable contenido:
- `/opt/sda*` o `/srv/sda*` (clones del repo)
- `~/sda*` o `/home/<user>/sda*` (venvs Python)
- `/var/log/sda*` (logs)
- `/etc/sda*` (configs, si hubiere)
- algun cache

- [ ] **Step 2: Mostrar al usuario la lista y pedir confirmacion individual o bulk**

Display al usuario:
```
Paths candidatos para borrado en srv-ia-01:
<contenido de /tmp/sda-srv-paths.txt>

Opciones:
  (a) borrar TODOS estos paths con sudo rm -rf
  (b) borrar SUBCONJUNTO — yo proporciono lista filtrada
  (c) cancelar Fase 6 (mantener archivos)

Decision?
```

Esperar respuesta del usuario antes de Task 6.4.

### Task 6.4: Borrar paths confirmados

**Files:** ninguno (SSH)

- [ ] **Step 1: Ejecutar rm -rf de cada path confirmado**

Run (sustituir `<path_N>` por cada path confirmado en Task 6.3):
```bash
ssh srv-ia-01 'sudo rm -rf <path_1> <path_2> ... <path_N>' 2>&1
```

Expected: sin output, exit 0.

- [ ] **Step 2: Verificar que los paths ya no existen**

Run:
```bash
ssh srv-ia-01 "sudo find / -maxdepth 5 \\( -path /proc -o -path /sys -o -path /snap \\) -prune -o \\( -name 'sda*' -o -name 'compute-gateway*' -o -name 'tree-indexer*' \\) -print 2>/dev/null | grep -vE '^/(proc|sys|snap)/'" 2>&1
```

Expected: salida vacia (todos los paths fueron eliminados).

### Task 6.5: Verificar que MinerU + mineru-api + vllm siguen funcionales

**Files:** ninguno (SSH)

- [ ] **Step 1: MinerU instalado**

Run:
```bash
ssh srv-ia-01 'which mineru || which mineru-api || ls /opt/mineru* 2>/dev/null' 2>&1
```

Expected: al menos uno de los paths/binarios responde.

- [ ] **Step 2: vllm container (puede estar prendido o apagado segun preferencia del usuario)**

Run:
```bash
ssh srv-ia-01 'docker ps -a --filter "name=vllm" --format "{{.Names}}\t{{.Status}}"' 2>&1
```

Expected: al menos 1 fila con un container `vllm*` (status puede ser `Up X minutes` o `Exited`).

- [ ] **Step 3: Modelos siguen en disco (path tipico)**

Run:
```bash
ssh srv-ia-01 'du -sh ~/models /opt/models /srv/models 2>/dev/null | head -3' 2>&1
```

Expected: al menos un path con tamanio > 0.

---

## Fase 7 — Inngest cleanup (manual, cosmetico)

### Task 7.1: Archivar app vieja en dashboard Inngest

**Files:** ninguno (operacion manual via web UI)

- [ ] **Step 1: Login en Inngest dashboard**

Display al usuario:
```
ABRIR EN BROWSER: https://app.inngest.com/

Login con la cuenta asociada al proyecto SDA Framework.

Buscar la app registrada (sera la que tenga functions con nombres
'process-document-index', 'reconcile-document-indexing', 'record-tree-graph-event').

Esa app ahora tiene functions stale (el codigo que las definia se borro).

Accion: archivar la app o sus functions desde el UI.
Esto es cosmetico — al hacer el primer deploy del codigo nuevo,
Inngest registra functions nuevas automaticamente.

Cuando termines (o si decidis no hacerlo y dejarlo para despues), confirmar para
seguir a Fase 8.
```

Esperar confirmacion del usuario.

---

## Fase 8 — Cleanup local final

### Task 8.1: Borrar branches locales viejas

**Files:** ninguno (git local)

- [ ] **Step 1: Verificar branches locales**

Run:
```bash
git branch --list 2>&1
```

Expected: incluye `main` (current) y al menos `pr1-ui-clean`, `pr2-ui-clean`, `feat/frontend-glass-workspace`.

- [ ] **Step 2: Borrar las 3 branches con -D (force delete)**

Run:
```bash
git branch -D pr1-ui-clean pr2-ui-clean feat/frontend-glass-workspace 2>&1
```

Expected: 3 lineas `Deleted branch <name> (was <sha>).`

- [ ] **Step 3: Verificar que solo queda main**

Run:
```bash
git branch --list 2>&1
```

Expected: solo `* main`.

### Task 8.2: Borrar branches remotas viejas

**Files:** ninguno (git remote)

- [ ] **Step 1: Listar branches remotas pre-cleanup**

Run:
```bash
git branch -r 2>&1
```

Expected: `origin/HEAD`, `origin/main`, y al menos `origin/feat/frontend-glass-workspace`, `origin/feat/frontend-light-ui-polish`, `origin/feat/frontend-shadcn-redesign`.

- [ ] **Step 2: Push --delete las 3 branches remotas**

Run:
```bash
git push origin --delete feat/frontend-glass-workspace feat/frontend-light-ui-polish feat/frontend-shadcn-redesign 2>&1 | tail -10
```

Expected: 3 lineas `- [deleted]         feat/frontend-*`.

- [ ] **Step 3: Prune referencias locales obsoletas**

Run:
```bash
git remote prune origin 2>&1
```

Expected: lineas `* [pruned] origin/feat/frontend-*`.

- [ ] **Step 4: Verificar branches remotas finales**

Run:
```bash
git branch -r 2>&1
```

Expected: solo `origin/HEAD -> origin/main` y `origin/main`.

### Task 8.3: Wipe memoria persistente de Claude

**Files:**
- Delete: `~/.claude/projects/-Users-enzo-sda-framework-sda-framework/memory/*.md`
- Modify: `~/.claude/projects/-Users-enzo-sda-framework-sda-framework/memory/MEMORY.md` → vacio

- [ ] **Step 1: Listar archivos a borrar**

Run:
```bash
ls ~/.claude/projects/-Users-enzo-sda-framework-sda-framework/memory/*.md 2>&1
```

Expected: 12 archivos `.md` (los 11 listados en el spec + MEMORY.md).

- [ ] **Step 2: Borrar todos los .md de memoria**

Run:
```bash
rm ~/.claude/projects/-Users-enzo-sda-framework-sda-framework/memory/*.md
```

Expected: sin output.

- [ ] **Step 3: Recrear MEMORY.md vacio (sistema lo requiere)**

Run:
```bash
echo "" > ~/.claude/projects/-Users-enzo-sda-framework-sda-framework/memory/MEMORY.md
```

Expected: archivo creado con 1 linea vacia.

- [ ] **Step 4: Verificar estado de memoria**

Run:
```bash
ls -la ~/.claude/projects/-Users-enzo-sda-framework-sda-framework/memory/
```

Expected: solo `MEMORY.md` (tamano 1 byte = 1 newline).

### Task 8.4: Cleanup de archivos temporales

**Files:**
- Delete: `/tmp/sda-snapshot-pre-wipe.json`, `/tmp/sda-snapshot-post-wipe.json`, `/tmp/sda-auth-cleanup.mjs`, `/tmp/sda-srv-paths.txt`

- [ ] **Step 1: Borrar temporales del wipe**

Run:
```bash
rm -f /tmp/sda-snapshot-pre-wipe.json /tmp/sda-snapshot-post-wipe.json /tmp/sda-auth-cleanup.mjs /tmp/sda-srv-paths.txt /tmp/sda-scan.mjs
```

Expected: sin output.

### Task 8.5: Verificacion final consolidada

**Files:** ninguno

- [ ] **Step 1: Estado del repo**

Run:
```bash
git status --short && git branch -a && git log --oneline -3
```

Expected:
- `git status --short`: vacio o solo cambios untracked esperados (`pnpm-lock.yaml` si surgio algo).
- `git branch -a`: solo `* main` local y `origin/main` + `origin/HEAD -> origin/main`.
- `git log --oneline -3`: HEAD es el squash commit del wipe.

- [ ] **Step 2: Build del repo funciona**

Run:
```bash
pnpm run build 2>&1 | tail -10
```

Expected: build exitoso (mismo que Task 2.3, confirmando que post-merge sigue funcional).

- [ ] **Step 3: Memoria vacia**

Run:
```bash
wc -c ~/.claude/projects/-Users-enzo-sda-framework-sda-framework/memory/MEMORY.md
```

Expected: `1 ~/.claude/projects/...MEMORY.md` (solo el newline).

- [ ] **Step 4: Tag de rollback sigue disponible**

Run:
```bash
git ls-remote --tags origin | grep pre-wipe-restart-2026-05-24
```

Expected: una linea con el SHA del tag.

---

## Post-conditions finales

Cuando este plan se completa exitosamente:

- `main` tiene un solo commit squash representando el wipe.
- Working tree contiene el esqueleto Next.js + supabase init vacio + spec + plan + CLAUDE.md + README minimo.
- Supabase: `public` vacio, `app` no existe, bucket `documents` vacio, 1 auth user (enzo), 0 cron jobs, 0 migrations tracked, 9 extensions vivas.
- Vercel: 22 env vars Production (las 5 obsoletas borradas).
- srv-ia-01: sin systemd units `sda-*`, sin clones nuestros, MinerU + vllm + modelos respondiendo.
- Inngest: app vieja archivada (o pendiente manual).
- Memoria Claude: 1 archivo MEMORY.md vacio.
- Tag `pre-wipe-restart-2026-05-24` disponible en `origin` para rollback durante 30+ dias (rollback del repo unicamente — Supabase y srv-ia-01 son irreversibles sin PITR).

El proximo paso del proyecto (fuera del scope de este plan): empezar a implementar las features Tier 1 desde el esqueleto Next.js, segun la nueva direccion que decidas.
