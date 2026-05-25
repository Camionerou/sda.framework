# Runbook — Wave 0 + Wave 1 prod deploy (Fly.io indexer + srv-ia-01 MinerU)

**Última actualización:** 2026-05-25 (refactored para Wave 1 — MinerU en srv-ia-01)

> **Objetivo:** dejar el stack productivo end-to-end:
> 1. `sda-indexer-prod` corriendo en Fly.io (Wave 0, ya deployado).
> 2. `sda-mineru-parser` corriendo en srv-ia-01 detrás de Cloudflare Tunnel bajo `https://mineru.sdaframework.com` (Wave 1).
> 3. Supabase remote `anfawvxfepowsudlffnl` orquestando vía pgmq + pg_cron + pg_net.
>
> **Por qué este split:** el ISP de srv-ia-01 (Cooperativa Telefónica V.G.G., Santa Fe) bloquea outbound TCP a 5432/6543, por lo que el indexer no puede vivir ahí (necesita ir a Supabase managed). Fly.io free tier resuelve eso. Pero MinerU necesita GPU local — esa sí está en srv-ia-01. Solución: indexer en Fly y MinerU en srv-ia-01, hablados por HTTP saliente desde Fly al tunnel.
>
> **Pre-reqs:** cuenta Fly.io (`flyctl auth login` ok), cuenta Cloudflare (zone para MinerU o subdomain CNAME hacia cfargotunnel), acceso al dashboard Vercel para `sdaframework.com`, tailscale SSH a srv-ia-01 funcionando, DB password remoto a mano, `psql` instalado local.

---

## Sección 1 — Arquitectura real

```
                                              ┌─────────────────────────────────┐
                                              │     Internet (HTTPS only)       │
                                              └─────────────────────────────────┘
                                                            │
       ┌──────────────────────────┬───────────────────────────────────────┐
       ▼                          ▼                                       ▼
┌───────────────┐    ┌───────────────────────────┐         ┌────────────────────────┐
│ sdaframework  │    │ sda-indexer-prod.fly.dev  │         │ mineru.sdaframework.com│
│ .com (Vercel) │    │  (Fly.io, region iad,     │         │ (Cloudflare CNAME →    │
│ Next.js front │    │   shared-cpu-1x 512MB×2)  │         │  <uuid>.cfargotunnel)  │
└───────────────┘    └───────────────────────────┘         └────────────────────────┘
                              │                                       │
                              │ /index/{structure,summarize,finalize} │ /parse/{native,mineru}
                              ▼                                       ▼
                   ┌───────────────────────┐               ┌────────────────────────┐
                   │  asyncpg pool         │               │  cloudflared (outbound │
                   │  pg_net responses     │               │   only TCP/7844)       │
                   │  LangGraph checkpoints│               │  localhost:8001        │
                   └───────────────────────┘               │  (sda-mineru-parser)   │
                              │                            │  + magic-pdf + GPU     │
                              ▼                            └────────────────────────┘
                ┌──────────────────────────┐                          ▲
                │   Supabase remote        │                          │
                │   anfawvxfepowsudlffnl   │── pg_net (HTTPS) ───────┘
                │                          │   (descarga PDF firmado
                │ • Storage bucket `docs`  │    desde Storage)
                │ • pgmq queues × 3        │
                │ • pg_cron 'drain-queues' │
                │ • Vault srv_ia_01_*      │
                │ • Vault mineru_shared_* │  ← agregado en Wave 1
                └──────────────────────────┘
```

**Flujo end-to-end de un PDF (Wave 1):**

1. Upload a Supabase Storage `docs/<path>.pdf`.
2. Trigger `on_storage_doc_uploaded` → insert en `documents` (status=pending).
3. Trigger `on_document_inserted` → `pgmq.send` a `q_extract_structure`.
4. `pg_cron drain-queues` (cada 1min, ver gotcha #3) → `dispatch_pgmq_to_srv_ia` → `pg_net.http_post(https://sda-indexer-prod.fly.dev/index/structure, ...)`.
5. Indexer Fly recibe → detecta `media_type=pdf` → llama a `https://mineru.sdaframework.com/parse/...` con `Authorization: Bearer $MINERU_SHARED_SECRET` y `signed_url` de Storage.
6. MinerU en srv-ia-01 descarga el PDF, parsea (native pypdf fast-path o magic-pdf full), responde JSON con structure.
7. Indexer guarda `tree_nodes`, encolа `q_summarize_node` por nodo.
8. Loop normal de summarize → finalize → `documents.status='ready'`.

---

## Sección 2 — Deploy del indexer a Fly.io (Wave 0, ya en prod)

### 2.1 Login y selección de app

```bash
cd /Users/enzo/sda.framework/sda.framework/services/sda-indexer
flyctl auth whoami        # verificar que estás logueado
flyctl apps list | grep sda-indexer-prod
```

Expected: `sda-indexer-prod` listado en region `iad`. Si no existe, `flyctl launch --no-deploy --copy-config` con el `fly.toml` actual.

### 2.2 Setear secrets (la única acción imperativa)

Los env vars con prefijo `SDA_` los lee `pydantic-settings` (ver `services/sda-indexer/src/sda_indexer/config.py`). Los valores no-secretos viven en `fly.toml` `[env]`. Los secretos van por `fly secrets set` (cifrados en Fly Vault).

```bash
# 2.2.1 Recolectar valores (NO los loguees a archivos)
read -s -p "DEEPSEEK_API_KEY: " DEEPSEEK_KEY; echo
read -s -p "SUPABASE_SERVICE_KEY (service_role JWT): " SUPABASE_KEY; echo
read -s -p "DB_DSN completo (postgresql://...): " DB_DSN; echo
read -s -p "SRV_IA_01_SECRET (bearer pg_net → Fly): " SRV_BEARER; echo
read -s -p "MINERU_SHARED_SECRET (bearer Fly → MinerU): " MINERU_SECRET; echo

# 2.2.2 Batch set con --stage (no deploya todavía)
flyctl secrets set --stage \
  SDA_DEEPSEEK_API_KEY="$DEEPSEEK_KEY" \
  SDA_SUPABASE_URL="https://anfawvxfepowsudlffnl.supabase.co" \
  SDA_SUPABASE_SERVICE_KEY="$SUPABASE_KEY" \
  SDA_DB_DSN="$DB_DSN" \
  SDA_SRV_IA_01_SECRET="$SRV_BEARER" \
  SDA_MINERU_SHARED_SECRET="$MINERU_SECRET" \
  --app sda-indexer-prod

# 2.2.3 Limpiar de la shell
unset DEEPSEEK_KEY SUPABASE_KEY DB_DSN SRV_BEARER MINERU_SECRET
```

Verificar (solo lista keys, nunca los values):

```bash
flyctl secrets list --app sda-indexer-prod
```

Expected: 6 keys con `digest` y `created_at`.

### 2.3 Deploy

```bash
flyctl deploy --remote-only --app sda-indexer-prod
```

`--remote-only` builda en Fly (evita depender de Docker local). El deploy hace rolling sobre 2 machines (HA, ver gotcha #7).

### 2.4 Verificar

```bash
flyctl status --app sda-indexer-prod
flyctl logs --app sda-indexer-prod | head -40
curl -fsS https://sda-indexer-prod.fly.dev/health | jq
```

Expected `/health`: `{"service":"sda-indexer","version":"...","db":true,"llm":true,"status":"ok"}`.

Si `db:false` → revisar `SDA_DB_DSN` (pooler hostname `aws-1-*` para este project, NO `aws-0-*`, ver gotcha #2).

---

## Sección 3 — Setup Cloudflare Tunnel en srv-ia-01 PARA MinerU

Wave 1 introduce el servicio `sda-mineru-parser` en `services/sda-mineru-parser/` que corre LOCAL en srv-ia-01 escuchando en `localhost:8001`. Para que el indexer Fly lo alcance sin abrir puertos en el ISP residencial, usamos un Cloudflare Tunnel outbound-only (mismo patrón que el spec original de Wave 0, pero ahora aplicado al servicio que realmente necesita estar en srv-ia-01).

### 3.1 Crear el tunnel en CF dashboard (en tu navegador local)

1. `https://one.dash.cloudflare.com` → Networks → Tunnels.
2. **Create a tunnel** → tipo **Cloudflared**.
3. Nombre: `sda-mineru-prod` → Save.
4. CF te muestra un comando de install para Linux. Copialo (incluye el token largo `eyJ...`).

### 3.2 Instalar cloudflared EN srv-ia-01

```bash
ssh srv-ia-01
# Pegar el comando que copiaste del dashboard. Algo así:
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb \
  && sudo dpkg -i cloudflared.deb \
  && sudo cloudflared service install eyJh...<TOKEN_LARGO_DEL_DASHBOARD>...
```

Output esperado al final:
```
INF Created service successfully
INF systemctl enable cloudflared
INF systemctl start cloudflared
```

Verificar:

```bash
sudo systemctl status cloudflared --no-pager
sudo journalctl -u cloudflared -n 30 --no-pager | grep -i "registered tunnel connection"
```

Expected: `active (running)`, 4 conexiones a CF edge registradas (una por POP cercano).

### 3.3 Public hostname → localhost:8001 (sda-mineru-parser)

De vuelta en el dashboard CF, dentro del wizard del tunnel `sda-mineru-prod`:

1. **Public Hostnames** → **Add a public hostname**.
2. Configurar:
   - **Subdomain:** `mineru`
   - **Domain:** `sdaframework.com` (si el dominio NO está en tu zona CF, dejá el campo vacío; CF te dará un `<uuid>.cfargotunnel.com` para hacer CNAME desde Vercel — ver Sección 4)
   - **Path:** (vacío)
   - **Type:** HTTP
   - **URL:** `http://localhost:8001`
3. **Additional application settings** → **HTTP Settings**:
   - **HTTP Host Header:** `mineru.sdaframework.com` (importante para FastAPI host validation)
   - **Disable Chunked Encoding:** off
4. Save hostname.

Anotá el **CNAME target** (`<uuid>.cfargotunnel.com`) que muestra CF — lo usamos en Sección 4.

### 3.4 Verificación intermedia (con sda-mineru-parser ya deployado — Tasks 13-14 de Wave 1)

```bash
# EN srv-ia-01
curl -fsS http://localhost:8001/healthz
# Expected: {"service":"sda-mineru-parser","gpu":true,"magic_pdf":"ok",...}
```

Si MinerU todavía no está deployado, este check va a fallar — pasar a Sección 4 igual y volver acá cuando los Tasks 13-14 de Wave 1 estén done.

---

## Sección 4 — DNS `mineru.sdaframework.com` en Vercel

Vercel gestiona `sdaframework.com`. Agregamos un CNAME al target Cloudflare del tunnel.

### 4.1 Crear el CNAME

1. `https://vercel.com/dashboard` → Domains → `sdaframework.com` → Records.
2. **Add Record**:
   - **Type:** CNAME
   - **Name:** `mineru`
   - **Value:** `<uuid>.cfargotunnel.com` (el del paso 3.3)
   - **TTL:** Auto (60s default).
3. Save.

### 4.2 Esperar propagación + verificar

```bash
# Polling hasta que resuelva
until dig +short mineru.sdaframework.com | grep -q .; do
  echo "still propagating..."; sleep 5
done
dig +short mineru.sdaframework.com
```

Expected: una IP de Cloudflare (104.x.x.x, 172.x.x.x).

### 4.3 Smoke test público (cuando MinerU ya está running)

```bash
curl -fsS https://mineru.sdaframework.com/healthz \
  -H "Authorization: Bearer $MINERU_SHARED_SECRET" | jq
```

Expected: 200 con el mismo JSON que el `/healthz` local. Si 502 → cloudflared down o MinerU no escuchando en 8001. Si 403 → bearer mismatch. Si timeout → CNAME no propagado.

---

## Sección 5 — Variables de entorno y secrets

### 5.1 Indexer Fly.io — secrets via `fly secrets set` (ver §2.2)

| Key | Origen | Notas |
|---|---|---|
| `SDA_DEEPSEEK_API_KEY` | DeepSeek dashboard → API Keys | Rotable. Formato `sk-...` |
| `SDA_SUPABASE_URL` | `https://anfawvxfepowsudlffnl.supabase.co` | Hardcoded por project |
| `SDA_SUPABASE_SERVICE_KEY` | Supabase dashboard → Settings → API → `service_role` | JWT largo `eyJ...` |
| `SDA_DB_DSN` | Supabase dashboard → Settings → Database → Session pooler URI | **Hostname `aws-1-*`, no `aws-0-*`** (gotcha #2) |
| `SDA_SRV_IA_01_SECRET` | `openssl rand -hex 32` | Bearer pg_net → Fly indexer. Debe matchear Vault `srv_ia_01_secret` |
| `SDA_MINERU_SHARED_SECRET` | `openssl rand -hex 32` | Bearer Fly indexer → MinerU service. Debe matchear `/etc/sda-mineru.env` en srv-ia-01 |

Env vars NO secretos viven en `fly.toml` `[env]`: `SDA_ENV=production`, `SDA_LOG_LEVEL=INFO`, `SDA_HOST=0.0.0.0`, `SDA_PORT=8000`, `SDA_DB_POOL_MIN_SIZE=2`, `SDA_DB_POOL_MAX_SIZE=10`.

### 5.2 MinerU service en srv-ia-01 — `/etc/sda-mineru.env`

Creado por el systemd unit (Task 13 de Wave 1). Variables consumidas por `sda_mineru.config`:

| Key | Origen | Notas |
|---|---|---|
| `MINERU_HOST` | `127.0.0.1` | Solo accesible vía tunnel, no expongas en LAN |
| `MINERU_PORT` | `8001` | Matchea la URL del tunnel |
| `MINERU_SHARED_SECRET` | `openssl rand -hex 32` | **Mismo valor que `SDA_MINERU_SHARED_SECRET` en Fly** |
| `SUPABASE_URL` | `https://anfawvxfepowsudlffnl.supabase.co` | Para generar signed URLs de descarga |
| `SUPABASE_SERVICE_KEY` | service_role JWT | Misma key que el indexer |
| `MINERU_CACHE_DIR` | `/var/cache/sda-mineru` | LRU local de PDFs ya parseados |
| `MINERU_MAX_CACHE_GB` | `20` | Cap del LRU |
| `MAGIC_PDF_CONFIG` | `/opt/sda-framework/services/sda-mineru-parser/magic-pdf.json` | Config de magic-pdf (modelos, device=cuda) |

Setear permisos: `sudo chmod 600 /etc/sda-mineru.env && sudo chown root:root /etc/sda-mineru.env`.

### 5.3 Supabase Vault — secrets que lee `dispatch_pgmq_to_srv_ia`

Ver `supabase/migrations/20260525000007_cron.sql`. Vault stora 2 secrets que pg_net necesita:

| Vault `name` | Valor | Cómo se usa |
|---|---|---|
| `srv_ia_01_url` | `https://sda-indexer-prod.fly.dev` | Base URL del indexer. Concatenado con `/index/<path>` |
| `srv_ia_01_secret` | mismo bearer que `SDA_SRV_IA_01_SECRET` | Authorization header del HTTP call |

**Patrón de UPDATE seguro** (gotcha #4 — `update vault.secrets` directo falla):

```sql
do $$
declare v_id uuid;
begin
  select id into v_id from vault.secrets where name='srv_ia_01_url';
  perform vault.update_secret(v_id, 'https://sda-indexer-prod.fly.dev', 'srv_ia_01_url',
                              'URL del indexer Fly (Wave 0 prod)');
end $$;
```

Wave 1 puede agregar un Vault secret extra para el MinerU bearer si en algún momento Supabase necesita llamarlo directo (por ahora NO — el flow es Supabase → Fly → MinerU).

---

## Sección 6 — Smoke tests post-deploy

### 6.1 Healthchecks individuales

```bash
# Indexer Fly
curl -fsS https://sda-indexer-prod.fly.dev/health | jq
# Expected: db=true, llm=true

# MinerU srv-ia-01 (vía tunnel)
curl -fsS https://mineru.sdaframework.com/healthz \
  -H "Authorization: Bearer $MINERU_SHARED_SECRET" | jq
# Expected: gpu=true, magic_pdf=ok
```

### 6.2 End-to-end Markdown (Wave 0 sanity check)

```bash
cd /Users/enzo/sda.framework/sda.framework/services/sda-indexer
export SERVICE_KEY="<service_role>"
export REMOTE_DSN="postgresql://postgres.anfawvxfepowsudlffnl:<pass>@aws-1-us-east-1.pooler.supabase.com:5432/postgres"

# Upload fixture vía REST API (evita supabase-py, gotcha #5)
curl -X POST \
  -H "Authorization: Bearer $SERVICE_KEY" \
  -H "Content-Type: text/markdown" \
  -H "x-upsert: true" \
  --data-binary @tests/fixtures/tiny.md \
  "https://anfawvxfepowsudlffnl.supabase.co/storage/v1/object/docs/docs/smoke-md.md"

# Esperar 90s (cron tick + processing) y verificar
sleep 90
psql "$REMOTE_DSN" -c "
  select source_path, status, node_count, last_error
    from documents where source_path='docs/smoke-md.md';
"
```

Expected: `status=ready`, `node_count > 0`, `last_error=null`.

### 6.3 End-to-end PDF (Wave 1, post-MinerU deploy)

```bash
# Subir un PDF pequeño (5-10 páginas)
curl -X POST \
  -H "Authorization: Bearer $SERVICE_KEY" \
  -H "Content-Type: application/pdf" \
  -H "x-upsert: true" \
  --data-binary @tests/fixtures/sample-5pg.pdf \
  "https://anfawvxfepowsudlffnl.supabase.co/storage/v1/object/docs/docs/smoke-pdf.pdf"

sleep 180  # PDFs tardan más (parser + chunk + summarize x N)
psql "$REMOTE_DSN" -c "
  select source_path, status, node_count, parser_used, last_error
    from documents where source_path='docs/smoke-pdf.pdf';
"
```

Expected: `status=ready`, `parser_used in ('native','mineru')`, `node_count > 0`.

### 6.4 Verificar pg_net dispatch funciona

```bash
psql "$REMOTE_DSN" -c "
  select id, status_code,
         content::jsonb->>'service' as service,
         created
    from net._http_response
    order by id desc limit 5;
"
```

Expected: filas recientes con `status_code=200` apuntando al indexer Fly.

### 6.5 Verificar pgmq queues no acumulan backlog

```bash
psql "$REMOTE_DSN" -c "select queue_name, queue_length from pgmq.metrics_all();"
```

Expected: todas las queues en 0 o ≤ rate limit slots.

---

## Sección 7 — Rollback procedures

### 7.1 Rollback del indexer Fly.io (release anterior)

`fly releases` lista todas las releases con su image tag:

```bash
flyctl releases --app sda-indexer-prod | head -10
```

Output ejemplo:
```
VERSION  STATUS    DESCRIPTION         USER             DATE
v42      complete  Deploy image        enzo@...         2026-05-25T18:00:00Z
v41      complete  Deploy image        enzo@...         2026-05-25T16:30:00Z
v40      complete  Deploy image        enzo@...         2026-05-25T14:00:00Z
```

Cada release apunta a una image en el registry interno de Fly: `registry.fly.io/sda-indexer-prod:deployment-<id>`.

```bash
# Listar deployment images con sus IDs reales
flyctl image show --app sda-indexer-prod
# o
flyctl releases --app sda-indexer-prod --image
```

**Rollback a la release anterior:**

```bash
flyctl deploy --image registry.fly.io/sda-indexer-prod:deployment-01HXXX... \
  --app sda-indexer-prod
```

Verificar:

```bash
flyctl status --app sda-indexer-prod
curl -fsS https://sda-indexer-prod.fly.dev/health | jq
```

### 7.2 Rollback de secrets (si rotaste y rompiste algo)

`fly secrets set` no tiene `undo` nativo — re-setear el valor previo:

```bash
flyctl secrets set --stage SDA_DEEPSEEK_API_KEY="<previous_key>" --app sda-indexer-prod
flyctl deploy --app sda-indexer-prod  # forzar pickup
```

### 7.3 Rollback del MinerU service (srv-ia-01)

```bash
ssh srv-ia-01
cd /opt/sda-framework
PREV=$(git log --skip 1 -1 --format=%H -- services/sda-mineru-parser/)
git checkout $PREV -- services/sda-mineru-parser/
sudo systemctl restart sda-mineru
sudo journalctl -u sda-mineru -n 50 --no-pager
```

### 7.4 Disable temporal del MinerU tunnel (cortar tráfico sin tirar el servicio)

```bash
ssh srv-ia-01 'sudo systemctl stop cloudflared'
# El indexer Fly va a ver `502 Bad Gateway` en `mineru.sdaframework.com`
# Los PDFs caen en retry → eventualmente status='failed' con last_error='mineru_timeout'
# Restablecer: sudo systemctl start cloudflared
```

### 7.5 Pausar el pipeline entero (kill switch)

Si todo está en llamas, desactivar el cron es la manera más rápida de parar dispatching:

```sql
-- EN Supabase remote
update cron.job set active = false where jobname = 'drain-queues-10s';
```

Los uploads siguen entrando a `documents` y `pgmq` pero nadie los drena. Re-enable con `set active = true` cuando esté resuelto.

---

## Sección 8 — Gotchas conocidos

Toda la lista de problemas operacionales descubiertos durante deploys está documentada en:

- **Memoria principal:** `~/.claude/projects/-Users-enzo-sda-framework-sda-framework/memory/wave_0_prod_gotchas.md`
- **Memoria complementaria:** `~/.claude/projects/-Users-enzo-sda-framework-sda-framework/memory/wave_0_prod_deploy.md`
- **Migrations:** `~/.claude/projects/-Users-enzo-sda-framework-sda-framework/memory/supabase_migrations_gotchas.md`

Resumen accionable para este runbook (numeración alineada con `wave_0_prod_gotchas.md`):

1. **ISP residencial bloquea 5432/6543** — por eso el indexer está en Fly y no en srv-ia-01. NO intentar revertir sin antes confirmar con `nc -zvw5 aws-1-us-east-1.pooler.supabase.com 5432` desde srv-ia-01.
2. **Pooler hostname `aws-1-*`** para este project, NO `aws-0-*`. Síntoma con hostname mal: `FATAL: Tenant or user not found` (parece error de password pero no lo es). Source-of-truth: dashboard → Settings → Database → Session pooler URI, o `supabase/.temp/pooler-url`.
3. **pg_cron managed NO corre sub-minuto** por default. Schedule `*/10 * * * * *` se ignora silenciosamente. Migration 010 ya fixea a `* * * * *`. Para latencia sub-minuto futura, considerar pg_notify-based dispatch o Edge Function.
4. **`update vault.secrets` directo falla** con `permission denied`. Usar `vault.update_secret(id, new_secret, name, description)`. Ver §5.3 para el patrón.
5. **supabase-py no en system Python.** Para scripts ad-hoc usar `curl` al REST API de Storage (ver §6.2) o `uv run python` desde el service dir.
6. **Bash tool isolation de Claude Code** — env vars exportados en Terminal del user NO llegan al asistente. Pasar secretos vía Keychain o `/tmp/file chmod 600`.
7. **Fly machines en HA = 2 instances** con `min_machines_running=1`. Es esperado, no es un bug. Si querés 1 sola: `min_machines_running=0 + auto_start_machines=false + auto_stop_machines=true` y arrancar manual.
8. **`fly secrets set --stage`** sólo guarda sin deployar — usar para batch + 1 deploy final (ver §2.2).

Wave 1 va a agregar gotchas específicos de MinerU (descarga signed URLs, OOM handling, cache LRU). Cuando aparezcan, documentarlos en una memoria nueva `wave_1_mineru_gotchas.md` y referenciarla acá.

---

## Definition of Done

- [ ] §2: `sda-indexer-prod.fly.dev/health` responde 200 con `db=true, llm=true`.
- [ ] §3: `cloudflared` en srv-ia-01 corriendo, 4 conexiones a CF edge.
- [ ] §4: `dig mineru.sdaframework.com` resuelve a IP CF.
- [ ] §5: Fly secrets list muestra las 6 keys, `/etc/sda-mineru.env` con permisos 600.
- [ ] §6.1-6.2: Markdown end-to-end llega a `status=ready`.
- [ ] §6.3: PDF end-to-end llega a `status=ready` con `parser_used` populated (post Wave 1 deploy).
- [ ] §6.4-6.5: `net._http_response` muestra 200s recientes, queues sin backlog.

Cuando los 7 puntos están ✅, el stack productivo (Wave 0 + Wave 1) está operativo end-to-end.
