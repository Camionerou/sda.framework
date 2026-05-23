# Supabase Multitenant AI Platform — Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This master plan is a roadmap; per-tier detail vive en los 3 plans hijos referenciados abajo.

**Goal:** Llevar SDA Framework de "pipeline de indexacion documental" a "plataforma SaaS multi-tenant de IA empresarial" implementando las 27 capacidades del spec en 3 tiers, cada tier shippeable de forma independiente.

**Architecture:** El plan se descompone en 3 planes hijos (uno por tier) porque cada tier produce software funcional y testable por si solo (regla del skill `writing-plans`) y porque violar la regla LEAN del proyecto ("nunca hacer archivos monoliticos") al escribir un unico plan de >5000 LOC no se justifica.

**Tech Stack:** Supabase (Postgres 17, RLS, Storage, Realtime, Auth con custom JWT hook, pg_cron, pgvector, ltree, pg_trgm, citext), Next.js 16, Inngest, Upstash Redis, Stripe (mirror minimal), Google Drive API + Microsoft Graph API (M365), Supabase Vault para OAuth secrets, pgTAP para tests SQL, pytest para workers Python, node --test para CLI.

**Reference spec:** `docs/superpowers/specs/2026-05-22-supabase-multitenant-audit-design.md` (2093 LOC, commit `e93d375`).

---

## Plans hijos

| Tier | Plan | Capacidades | Shippeable porque |
|---|---|---|---|
| Tier 1 | [`2026-05-22-supabase-multitenant-platform-tier1-foundation.md`](./2026-05-22-supabase-multitenant-platform-tier1-foundation.md) | workspaces, memberships, groups, tags, collections, RLS helpers, JWT hook v2, soft-delete, docs.workspace_id backfill | Despues de Tier 1 los users pueden organizar contenido en workspaces, ver colecciones, y la jerarquia de acceso funciona. Sin Tier 2 las features de retencion (annotations, bookmarks, sharing, notifs) faltan pero la base es solida. |
| Tier 2 | [`2026-05-22-supabase-multitenant-platform-tier2-multipliers.md`](./2026-05-22-supabase-multitenant-platform-tier2-multipliers.md) | message_feedback, message_citations, user_bookmarks, shared_links, document_annotations + replies, notifications + preferences, document_views, document_issues, document_lineage, access_requests, saved_queries, audit_log enriquecido | Despues de Tier 2 hay loops de retencion reales: feedback al agente, sharing, anotaciones, inbox de notificaciones, busquedas guardadas. Sin Tier 3 los connectors y billing usage no estan, pero el producto es vendible. |
| Tier 3 | [`2026-05-22-supabase-multitenant-platform-tier3-enterprise.md`](./2026-05-22-supabase-multitenant-platform-tier3-enterprise.md) | connectors Drive/M365 + tenant_oauth_credentials, usage_records + aggregates, mirror Stripe, data_exports, particionado tablas hot, halfvec migration | Despues de Tier 3 el producto es "enterprise-ready" para SaaS multi-tenant centralizado: ingesta automatica desde Drive/M365, billing usage-puro funcional, export GDPR-friendly, escalabilidad de tablas hot. |

### Cifras del paquete

| Plan | LOC | Pasos | Tasks | Commits | Migraciones SQL |
|---|---:|---:|---:|---:|---:|
| Tier 1 Foundation | 5267 | 22 | ~30 | ~25 | 13 |
| Tier 2 Multipliers | 6119 | 18 | 44 | 27 | 14 |
| Tier 3 Enterprise | 5407 | 8 | 51 | 39 | 19 |
| **Total** | **16960** | **48** | **~125** | **~91** | **46** |

### Gaps conocidos documentados en los plans hijos

Los plans documentan estos gaps explicitamente. El ejecutor debe tenerlos
presentes al arrancar cada tier:

**Tier 1**:
- El test `documents_upload_flow_test.sql` existente puede romper porque la
  signature de `create_document_upload` cambia (Paso 16). El plan incluye
  task para actualizarlo en el mismo commit.

**Tier 2**:
- Tests de migracion 042 (`shared_links`) y 043 (`annotations`) tienen
  asserts contra `notifications` que solo pasan despues de 044. El plan lo
  marca como partial-pass esperado y propone comentar/descomentar.
- `consume_shared_link_token` exige JWT (no soporta consumo anonimo). Es
  desviacion deliberada del spec literal, mas segura, documentada.
- `update_document_issue` y `assign_document_issue` requieren
  `documents.workspace_id` poblado (Tier 1 pre-flight Task 1.1 lo cubre).

**Tier 3**:
- Test e2e connector flow OAuth->sync->indexed requiere credenciales reales;
  queda como smoke manual en Task 8.10.
- `pg_net` no garantizado en Supabase managed: dispatch DB-side de
  `data_export.requested` cae al cron sweep cada 5 min como fallback.
- Email channel (`notification_preferences.channel='email'`) NO se
  implementa todavia — sigue siendo deuda del spec.
- Drive shared drives (`drive_id != root`): config soportada pero
  `listChanges` actual usa changes endpoint global; mejora menor pendiente.
- `dumpScope` (data export) carga todo a memoria via JSZip; tenants con >1
  GB de data requieren streaming v2.
- Migracion 7.4 (halfvec) enumera explicitamente solo
  `search_tree_nodes_by_embedding`; `search_chunks` debe actualizarse en
  paralelo (inferible pero podria ser mas firme en el plan).

---

## Orden de ejecucion y dependencias

```text
Tier 1 (foundation)
  │
  ├─ Tier 2 (multipliers) — depende de workspaces/collections/RLS helpers de Tier 1
  │
  └─ Tier 3 (enterprise) — depende de Tier 1 (workspaces para connectors) y Tier 2 (notifications para alertas de usage)
```

**Regla**: no arrancar Tier 2 antes de tener Tier 1 mergeado a `main` con todos los tests en verde y al menos un tenant real probado en staging con un workspace `Default` backfilled. No arrancar Tier 3 antes de Tier 2 por la misma razon.

**Excepcion controlada**: `agent_tasks` esta diferido (no en ningun tier). Si despues de Tier 2 el feedback de usuarios pide tasks del agente, se hace un mini-plan especifico.

---

## Decisiones que NO se re-discuten en los plans hijos

Estas vienen del spec y aplican a todos los tiers. Si un plan hijo parece contradecirlas, es un bug del plan:

1. **Deploy**: SaaS multi-tenant centralizado.
2. **LLM**: centralizado (sin BYO key).
3. **Billing**: usage-puro, sin caps/plans/overage. App emite alerts via `notifications.kind = 'usage.threshold_crossed'` pero no bloquea.
4. **Compliance**: liviano. Data export + soft-delete + audit enriquecido. Sin SAML/SCIM/retention configurable.
5. **Jerarquia**: `tenant -> workspaces -> collections`. `groups` a nivel tenant. Comparticion entre workspaces solo via `collections.visibility = 'tenant_public'`. ACL granular per-row descartada.
6. **JWT**: `active_workspace_id` y `active_workspace_role` son **hints para UI**, no autoridad. RLS y helpers siempre re-verifican `workspace_memberships` en runtime.
7. **Connectors**: solo Drive + M365 en este corte. Notion/Slack diferidos.
8. **API externa**: nada. Sin API keys / webhooks salientes / service accounts.
9. **`agent_tasks`**: diferido hasta tener journey con pull real.

---

## Convenciones transversales (aplican a los 3 tiers)

### Composite FK pattern

Toda tabla nueva que referencie `documents`, `workspaces`, `collections`, `conversations`, `indexing_runs` usa FK compuesto `(tenant_id, foreign_id)` contra el `unique (tenant_id, id)` de la tabla padre. Es la defensa en profundidad que ya usa el resto del codebase. **No omitir** aunque RLS lo cubra; es belt-and-suspenders.

```sql
foreign key (tenant_id, document_id)
  references public.documents(tenant_id, id) on delete cascade
```

### RLS por tabla

Toda tabla nueva DEBE tener:

```sql
alter table public.<nueva_tabla> enable row level security;

create policy <nombre_descriptivo> on public.<nueva_tabla>
  for select to authenticated
  using (tenant_id = (select app.current_tenant_id()) and ...);
```

Si una migracion crea una tabla sin enable RLS, los tests pgTAP del plan deben fallarla. Lock-in del patron via test.

### Write boundary pattern

`documents`, `indexing_runs`, `document_extractions` ya estan: `revoke insert, update, delete from authenticated`, escritura solo via RPCs `security definer` que validan tenant manualmente y emiten `audit_log`. Las tablas nuevas siguen el mismo patron salvo casos justificados (ej. `user_bookmarks` puede tener insert directo via policy porque la dedupe es local al user y el set de filas que el user puede crear es limitado).

### Audit context pattern

RPCs sensibles aceptan `_request_context jsonb` opcional con
`{request_id, session_id, ip, user_agent, workspace_id}`. Implementadas via helper `app.audit_with_context(_action text, _resource_type text, _resource_id uuid, _payload jsonb, _request_context jsonb)`. Single source of insert a `audit_log` desde RPCs nuevas. Las 4 funciones `app.audit_*_change` existentes (triggers) siguen funcionando pero el plan agrega para que tambien consuman context cuando esta disponible via `current_setting('app.request_context', true)`.

### Soft-delete pattern

Aplicable a `documents`, `conversations`, `collections`, `workspaces`, `groups`, `tags`. Columna `deleted_at timestamptz` (null = vivo). Las RLS policies excluyen filas con `deleted_at` no nulo. Hard-delete diferido via `cleanup_operational_data` extendido (retention default 30 dias).

### Realtime publication

Toda tabla nueva con UI live correspondiente debe agregarse a la publication `supabase_realtime` con el patron `do $$ ... if not exists ... alter publication ... add table ... end $$`. Patron ya usado en migraciones existentes.

### Test SQL (pgTAP)

Cada migracion lleva test en `supabase/tests/<migration_name>_test.sql`. Patron del proyecto:
- Setup: crear tenant ficticio + user con role definido + JWT mock con `set_config('request.jwt.claims', '{...}', true)`.
- Escenarios positivos: el user con role correcto puede leer/escribir su recurso.
- Escenarios negativos: cross-tenant blocked, user sin role no puede mutar, soft-deleted no aparece.
- Cleanup: rollback de la transaccion del test.

Tests corren con `npm run test:db` (alias `supabase test db`).

### Commit cadence

Frecuente. Cada migracion + su test = 1 commit minimo. Si la migracion toca docs adicionalmente, mismo commit. Mensajes en formato `tipo(scope): mensaje` ya establecido en el repo (`feat(...)`, `docs(...)`, `test(...)`, `refactor(...)`).

### Branch strategy

Default: trabajar en `main` por simplicidad (sin worktree salvo riesgo de conflicto con trabajo paralelo). Si el agente que ejecuta el plan tiene riesgo de paralelizar con otro flujo, usar el skill `using-git-worktrees` para crear worktree por tier.

---

## Estados de salida por tier

Cada tier termina con:

- `npm run lint` verde.
- `npm run typecheck` verde.
- `npm run test:db` verde.
- `npm run test:tree-indexer` verde (si el tier toca Python).
- `npm run test:cli` verde.
- `npm run indexing:health` verde.
- `npm run secrets:scan` sin findings.
- Migraciones aplicadas a remoto via `supabase db push` exitoso.
- Types regenerados via `npm run types:gen` y committeados.
- `CHANGELOG.md` actualizado con la entrada del tier.
- Docs nuevos/actualizados del tier mergeados.

Cada plan hijo tiene su propia seccion "Estados de salida" con los detalles especificos.

---

## Riesgo cross-tier: orden de migraciones globales

Los 3 tiers introducen migraciones numeradas conceptualmente 030-058. El proyecto usa nombres por timestamp (`YYYYMMDDHHMMSS_<nombre>.sql`). El plan asigna timestamps al momento de crear la migracion (cada plan hijo lo aclara). Para evitar colisiones:

- Tier 1: timestamps `20260522HHMMSS_*` (HH = 21-22 inicio).
- Tier 2: timestamps `2026MMDD*` siguientes; cada migracion respeta el orden secuencial.
- Tier 3: idem.

Si Tier 2 arranca semanas despues de Tier 1, sus timestamps deben ser estrictamente superiores a la ultima migracion de Tier 1 mergeada. El plan hijo del tier referencia el timestamp de la ultima migracion conocida al momento de generarlo.

---

## Self-review del master plan

- **Coverage**: el master no implementa nada; delega 100% a los 3 plans hijos. La coverage se valida en cada plan hijo (cada uno tiene su seccion de self-review contra el spec).
- **Placeholders**: ningun "TBD"/"TODO" en este documento.
- **Type consistency**: el master no define tipos. Los plans hijos comparten tipos del spec referenciado.
- **Dependencias inter-tier**: explicitadas en la seccion "Orden de ejecucion".

---

## Execution Handoff

Cada plan hijo termina con su propio handoff. Recomendacion para esta sesion:

1. Si vas a ejecutar **ahora**: arrancar por Tier 1 con `superpowers:subagent-driven-development` (fresh subagent per task + review entre tasks). Es el flow mas seguro para una migracion grande.
2. Si solo querias el plan **escrito** y lo vas a ejecutar despues: queda commit-eado y listo, sin estado pendiente.

El master plan no se ejecuta por si solo.
