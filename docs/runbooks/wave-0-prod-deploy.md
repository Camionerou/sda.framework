# Runbook — Wave 0 Production Deploy

> **Objetivo:** deployar sda-indexer a srv-ia-01 detrás de **Cloudflare Tunnel** bajo `https://indexer.sdaframework.com`, conectado a Supabase remote (`anfawvxfepowsudlffnl`). Cierra Phase L de Wave 0 (Tasks 36-38).
>
> **Arquitectura final:**
> ```
> Internet
>   ↓
> sdaframework.com (Vercel, Next.js frontend) ────────────┐
>   ↓                                                     │
> indexer.sdaframework.com (CNAME → cfargotunnel.com)     │
>   ↓                                                     │
> Cloudflare edge (TLS + WAF + DDoS, gratis)              │
>   ↓                                                     │
> cloudflared (srv-ia-01, outbound-only)                  │
>   ↓                                                     │
> localhost:8000 (sda-indexer container)                  │
>   ↓                                                     │
> Supabase remoto (anfawvxfepowsudlffnl) ◄────────────────┘
>   ↑   ↑
>   │   └─ pg_cron → pg_net → indexer.sdaframework.com (loop)
>   └──── tu local (admin, deploys, tests)
> ```
>
> **Pre-reqs:** cuenta Cloudflare (ya tenés), acceso al dashboard de Vercel para `sdaframework.com`, tailscale SSH a srv-ia-01 funcionando, DB password remoto a mano.
>
> **Tiempo estimado:** 25-35 min, todo en una sentada.

---

## STEP 0 — Recolectá estos 3 valores antes de empezar

1. **`DB_PASSWORD`** del Supabase remote:
   - Supabase dashboard → tu project (anfawvxfepowsudlffnl) → Settings → Database → Connection string → **Session pooler** (port 5432) → URI
   - Copiá la parte entre `:` y `@` (es la password)

2. **`REGION`** del Supabase pooler: visible en la misma URI (ej: `us-east-1`)

3. **`SUPABASE_SERVICE_KEY_REMOTE`**: dashboard → Settings → API → `service_role` (eyJ...)

Tené los 3 anotados (no en el chat — pasalos por env vars).

---

## STEP 1 — Generar bearer + setear Vault remote (corre EN TU LOCAL)

```bash
cd /Users/enzo/sda.framework/sda.framework

# 1.1 Generar fresh bearer para producción
export PROD_BEARER=$(openssl rand -hex 32)
echo "PROD_BEARER guardado en env var (NO lo loguees a archivo)"

# 1.2 Pedir credenciales con prompt (NO logueadas en history)
read -s -p "DB password remoto: " DB_PASSWORD; echo
read -p "Region (ej us-east-1): " REGION
read -s -p "Service role key remoto: " SERVICE_KEY; echo

export REMOTE_DSN="postgresql://postgres.anfawvxfepowsudlffnl:${DB_PASSWORD}@aws-0-${REGION}.pooler.supabase.com:5432/postgres"

# 1.3 Smoke test la conexión
psql "$REMOTE_DSN" -c "select version();" 2>&1 | head -5
```

Expected: una línea con "PostgreSQL 17.x..." (o lo que sea la versión del remote).

```bash
# 1.4 Crear los 2 Vault secrets en remote
psql "$REMOTE_DSN" -v ON_ERROR_STOP=1 <<EOF
-- Limpiar si existen de tries anteriores
delete from vault.secrets where name in ('srv_ia_01_secret', 'srv_ia_01_url');

-- Bearer (lo conoce solo srv-ia-01 y la dispatcher function)
select vault.create_secret('${PROD_BEARER}', 'srv_ia_01_secret',
  'Bearer para auth pg_net → srv-ia-01');

-- URL pública del endpoint — placeholder hasta STEP 5
select vault.create_secret('https://placeholder.example/PLACEHOLDER', 'srv_ia_01_url',
  'URL pública de srv-ia-01 vía CF Tunnel — actualizar en STEP 5');

select name, created_at from vault.secrets
 where name in ('srv_ia_01_secret', 'srv_ia_01_url')
 order by name;
EOF
```

Expected: 2 rows (srv_ia_01_secret, srv_ia_01_url).

**Mantené `$PROD_BEARER` y `$REMOTE_DSN` en la sesión actual; los usamos varios pasos más.**

---

## STEP 2 — Clonar repo + crear /etc/sda-indexer.env (corre EN srv-ia-01)

SSH a srv-ia-01:
```bash
# Desde tu local
ssh srv-ia-01
```

EN srv-ia-01 ahora:

```bash
# 2.1 Clonar el repo (o pull si ya existe)
sudo mkdir -p /opt/sda-framework
sudo chown sistemas:sistemas /opt/sda-framework
if [[ -d /opt/sda-framework/.git ]]; then
  cd /opt/sda-framework
  git fetch && git checkout main && git pull
else
  git clone https://github.com/Camionerou/sda.framework.git /opt/sda-framework
  cd /opt/sda-framework
fi

# 2.2 Crear /etc/sda-indexer.env desde el template
sudo cp services/sda-indexer/.env.production.example /etc/sda-indexer.env
sudo chmod 600 /etc/sda-indexer.env
sudo chown root:root /etc/sda-indexer.env

# 2.3 Editar (nano o vim)
sudo nano /etc/sda-indexer.env
```

En el editor, reemplazar TODOS los `<PLACEHOLDERS>`:
- `SDA_SUPABASE_SERVICE_KEY` = el `SERVICE_KEY` del STEP 1
- `SDA_DB_DSN` = el `REMOTE_DSN` completo del STEP 1
- `SDA_DEEPSEEK_API_KEY` = `sk-3a6107657992412ba56b51cf651eea22` (o uno fresh si rotás)
- `SDA_SRV_IA_01_SECRET` = el `PROD_BEARER` del STEP 1 (EXACTAMENTE el mismo string)

Guardar (Ctrl+O, Enter, Ctrl+X en nano).

```bash
# 2.4 Validar que NO hay placeholders
sudo grep -E '^SDA_' /etc/sda-indexer.env | grep -c '<' && echo "ERROR: placeholders aún presentes" || echo "OK"
```

Expected: "OK".

---

## STEP 3 — Instalar y configurar Cloudflare Tunnel (EN srv-ia-01)

Tres formas: dashboard (GUI guided), CLI (más programmable), o connector via docker. Recomiendo **dashboard** porque es más visual y CF te da el comando exacto de install.

### 3.1 — Crear el tunnel en CF dashboard (en tu navegador local)

1. Abrí `https://one.dash.cloudflare.com` → Networks → Tunnels
2. **Create a tunnel** → seleccioná **Cloudflared** como tipo
3. Nombre: `sda-indexer-prod` → Save
4. CF te muestra una pantalla con un comando para instalar cloudflared en el servidor. Copiá el comando completo (es algo así):
   ```
   curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb && sudo dpkg -i cloudflared.deb && sudo cloudflared service install eyJh...<TOKEN_LARGO>...
   ```

### 3.2 — Pegar y ejecutar EN srv-ia-01

Pegá el comando que copiaste en la sesión SSH a srv-ia-01 y ejecutalo. Output esperado al final:
```
INF Created service successfully
INF systemctl enable cloudflared
INF systemctl start cloudflared
```

Verificar:
```bash
sudo systemctl status cloudflared --no-pager
sudo journalctl -u cloudflared -n 20 --no-pager
```

Expected: status `active (running)`, logs muestran `Registered tunnel connection` (4 connections esperables — uno por región CF cercana).

### 3.3 — Volver al dashboard CF y agregar public hostname

De vuelta en el dashboard CF, ahora estás en el wizard del tunnel:

1. **Public Hostnames** → **Add a public hostname**
2. Configurar:
   - **Subdomain:** `indexer`
   - **Domain:** `sdaframework.com` (CF te ofrece autocompletado si el dominio está en CF; **si NO está**, vas a ver "domain not in your account" — está bien, vas a meter el hostname manual y configurás el CNAME en Vercel)
   - **Path:** (dejar vacío)
   - **Type:** HTTP
   - **URL:** `http://localhost:8000`
3. Click **Save hostname**

CF te da el **CNAME target** que vas a necesitar en STEP 4. Es algo del tipo `<uuid>.cfargotunnel.com`. **Copialo.**

---

## STEP 4 — DNS CNAME en Vercel (EN TU NAVEGADOR)

1. Abrí `https://vercel.com/dashboard` → tu account → Domains → `sdaframework.com`
2. Records → **Add Record**
3. Configurar:
   - **Type:** CNAME
   - **Name:** `indexer`
   - **Value:** `<el UUID>.cfargotunnel.com` (el CNAME target del STEP 3.3)
   - **TTL:** Auto (60 o 300 segundos default está bien)
4. Save

Esperar 2-5 minutos para propagación DNS.

### Verificar DNS desde tu local

```bash
# Polling cada 5s hasta que resuelva
while ! dig +short indexer.sdaframework.com | grep -q .; do
  echo "still propagating..."
  sleep 5
done
dig +short indexer.sdaframework.com
```

Expected: una IP de Cloudflare (104.x.x.x, 172.x.x.x, etc).

---

## STEP 5 — Deploy del container sda-indexer (EN srv-ia-01)

EN srv-ia-01 (todavía en SSH session):

```bash
cd /opt/sda-framework/services/sda-indexer

# 5.1 Verificar permisos del helper script
chmod +x scripts/deploy_srv_ia_01.sh

# 5.2 Ejecutar deploy (build + up)
sudo bash scripts/deploy_srv_ia_01.sh
```

Expected final:
```
==> ✅ Deploy completo. Servicio reachable en localhost:8000 (DENTRO de srv-ia-01).
==> Próximo paso: configurar Tailscale Funnel para exponerlo público.
```

(Ignorá el mensaje sobre Tailscale Funnel — vos estás usando CF Tunnel, ya está configurado.)

### Verificar el health desde dentro de srv-ia-01

```bash
curl -fsS http://localhost:8000/health
```
Expected: `{"service":"sda-indexer","version":"0.1.0","db":true,"llm":true,"status":"ok"}`

### Verificar el health desde internet (vía el túnel)

```bash
curl -fsS https://indexer.sdaframework.com/health
```
Expected: la misma respuesta. Si timeout o 502, ver troubleshooting al final.

---

## STEP 6 — Actualizar Vault con la URL real (EN TU LOCAL)

Volvé a tu terminal local con las env vars del STEP 1 todavía cargadas:

```bash
# 6.1 Update el Vault secret srv_ia_01_url al valor real
psql "$REMOTE_DSN" -v ON_ERROR_STOP=1 <<EOF
update vault.secrets
   set secret = 'https://indexer.sdaframework.com'
 where name = 'srv_ia_01_url';

select name, updated_at from vault.secrets where name = 'srv_ia_01_url';
EOF
```

Expected: 1 row con updated_at = ahora.

### Smoke test desde Supabase remote

```bash
psql "$REMOTE_DSN" <<'EOF'
-- Llamar el endpoint desde dentro de Postgres remoto vía pg_net
select net.http_get(
  url := (select decrypted_secret from vault.decrypted_secrets where name='srv_ia_01_url') || '/health',
  timeout_milliseconds := 10000
) as request_id;

-- Esperar 3 segundos para que la response llegue
select pg_sleep(3);

-- Ver el resultado
select id, status_code, content::jsonb->>'status' as service_status,
       content::jsonb->>'db' as db_ok
  from net._http_response
 order by id desc
 limit 1;
EOF
```

Expected: 1 row con `status_code = 200`, `service_status = ok`, `db_ok = true`.

Si `status_code = 401`: el bearer no matchea. Re-chequear que `/etc/sda-indexer.env` SDA_SRV_IA_01_SECRET == Vault `srv_ia_01_secret`.

Si `status_code = NULL` o timeout: DNS no propagado o CF Tunnel down. Re-chequear STEP 3 + 4.

---

## STEP 7 — Verify D-0.x criteria EN PRODUCCIÓN (T38)

Todo corre EN TU LOCAL contra el Supabase remote.

### D-0.1 — Markdown end-to-end

```bash
cd /Users/enzo/sda.framework/sda.framework

# Helper Python para upload + esperar
cat > /tmp/prod_d01.py <<'PYEOF'
import os, time, hashlib, sys
from supabase import create_client
import psycopg

url = "https://anfawvxfepowsudlffnl.supabase.co"
key = os.environ["SERVICE_KEY"]
dsn = os.environ["REMOTE_DSN"]

sb = create_client(url, key)
sb.storage.from_("docs").upload(
    "docs/prod-test-tiny.md",
    open("services/sda-indexer/tests/fixtures/tiny.md", "rb").read(),
    {"upsert": "true", "content-type": "text/markdown"},
)
print("uploaded — esperando hasta 60s...")

start = time.time()
with psycopg.connect(dsn) as conn:
    while time.time() - start < 60:
        row = conn.execute(
            "select status, node_count from documents where source_path='docs/prod-test-tiny.md'"
        ).fetchone()
        if row and row[0] == "ready":
            print(f"D-0.1 ✅ status=ready, node_count={row[1]} en {time.time()-start:.1f}s")
            sys.exit(0)
        time.sleep(2)

with psycopg.connect(dsn) as conn:
    row = conn.execute("select status from documents where source_path='docs/prod-test-tiny.md'").fetchone()
print(f"D-0.1 ❌ TIMEOUT — status final: {row}")
sys.exit(1)
PYEOF

SERVICE_KEY="$SERVICE_KEY" REMOTE_DSN="$REMOTE_DSN" python3 /tmp/prod_d01.py
```

### D-0.2 — Idempotencia sha256

```bash
cat > /tmp/prod_d02.py <<'PYEOF'
import os, time, sys
from supabase import create_client
import psycopg

key = os.environ["SERVICE_KEY"]
dsn = os.environ["REMOTE_DSN"]
sb = create_client("https://anfawvxfepowsudlffnl.supabase.co", key)

content = open("services/sda-indexer/tests/fixtures/tiny.md", "rb").read()
sb.storage.from_("docs").upload("docs/prod-test-tiny-dup.md", content,
                                {"upsert": "true", "content-type": "text/markdown"})
print("dup uploaded, esperando 30s para reconcile sha256...")
time.sleep(30)

with psycopg.connect(dsn) as conn:
    rows = conn.execute("""
        select source_path, status from documents
         where source_path like 'docs/prod-test-tiny%'
         order by created_at
    """).fetchall()

statuses = {r[0]: r[1] for r in rows}
print("Statuses:", statuses)

if "ready" in statuses.values() and "duplicate" in statuses.values():
    print("D-0.2 ✅ idempotency works (one ready + one duplicate)")
else:
    print("D-0.2 ❌ unexpected statuses"); sys.exit(1)
PYEOF

SERVICE_KEY="$SERVICE_KEY" REMOTE_DSN="$REMOTE_DSN" python3 /tmp/prod_d02.py
```

### D-0.3 — Resiliencia (kill mid-summarize)

Subir un MD un poco más largo, después restartear el container EN srv-ia-01 mientras se procesa.

```bash
# 1. Subir nested.md (más nodos)
SERVICE_KEY="$SERVICE_KEY" python3 -c "
from supabase import create_client
sb = create_client('https://anfawvxfepowsudlffnl.supabase.co', '$SERVICE_KEY')
sb.storage.from_('docs').upload('docs/prod-test-nested.md',
  open('services/sda-indexer/tests/fixtures/nested.md','rb').read(),
  {'upsert':'true','content-type':'text/markdown'})
print('uploaded')
"

# 2. INMEDIATAMENTE en otra terminal (Tailscale SSH a srv-ia-01):
# ssh srv-ia-01 'sudo docker compose -f /opt/sda-framework/services/sda-indexer/docker-compose.yml -f /opt/sda-framework/services/sda-indexer/docker-compose.prod.yml restart sda-indexer'

# 3. Esperar y verificar que llega a ready
sleep 90
psql "$REMOTE_DSN" -c "
  select status, node_count from documents where source_path='docs/prod-test-nested.md';
"
```
Expected: status='ready'. Pgmq reentregó después del restart.

### D-0.4 — LangGraph checkpoints

```bash
psql "$REMOTE_DSN" -c "
  select count(*) as total_checkpoints,
         count(distinct thread_id) as distinct_threads
    from langgraph_checkpoints.checkpoints;
"
```
Expected: total > 30 (acumulado de los tests previos), distinct_threads > 5.

### D-0.5 — Test suite local (ya hecho, re-verify)

```bash
cd /Users/enzo/sda.framework/sda.framework/services/sda-indexer
uv run pytest --cov=src/sda_indexer/pipeline --cov-report=term-missing 2>&1 | tail -15
```
Expected: passed, coverage en pipeline visible.

### D-0.6 — Hot-reload setting

```bash
# Cambiar setting global
psql "$REMOTE_DSN" -c "
  update app_settings
     set value = '\"deepseek-chat\"'::jsonb, updated_by='prod-test-d06'
   where key='llm.model.summarize' and scope_type='global' and scope_value is null;
"

# Esperar 1s, después verificar logs en srv-ia-01
sleep 1
ssh srv-ia-01 'sudo docker compose -f /opt/sda-framework/services/sda-indexer/docker-compose.yml -f /opt/sda-framework/services/sda-indexer/docker-compose.prod.yml logs --tail 20 sda-indexer' | grep -E "settings\.(invalidated|listener)"
```
Expected: línea con `settings.invalidated key=llm.model.summarize count=N`.

---

## STEP 8 — Cleanup + tag release (EN TU LOCAL)

```bash
# Cleanup test docs de producción
psql "$REMOTE_DSN" -c "delete from documents where source_path like 'docs/prod-test-%';"

# Borrar los archivos de Storage (la api de Storage los borra, no SQL)
python3 -c "
from supabase import create_client
sb = create_client('https://anfawvxfepowsudlffnl.supabase.co', '$SERVICE_KEY')
for p in ['docs/prod-test-tiny.md','docs/prod-test-tiny-dup.md','docs/prod-test-nested.md']:
    try: sb.storage.from_('docs').remove([p])
    except: pass
print('cleaned')
"

# Verificar colas vacías
psql "$REMOTE_DSN" -c "select queue_name, queue_length from pgmq.metrics_all();"

# Tag release
cd /Users/enzo/sda.framework/sda.framework
git tag -a wave-0-foundation-complete -m "Wave 0 Foundation 38/38 complete

D-0.1..D-0.6 verificados contra producción:
  - Supabase remote anfawvxfepowsudlffnl (9 migrations)
  - srv-ia-01 con Docker (sda-indexer container)
  - Cloudflare Tunnel public hostname indexer.sdaframework.com
  - Vercel DNS CNAME al tunnel
  - Vault secrets srv_ia_01_secret + srv_ia_01_url en Supabase

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"

git push origin wave-0-foundation-complete
```

---

## Troubleshooting matrix

| Síntoma | Causa probable | Fix |
|---|---|---|
| `cloudflared service install` falla con "TOKEN invalid" | Copy paste cortado | Re-copiar el comando completo del dashboard |
| `systemctl status cloudflared` dice "failed" | Conn a CF edge fallida (firewall outbound) | Verificar outbound TCP 7844 y 443 abierto (ufw allow out 7844/tcp) |
| `curl https://indexer.sdaframework.com/health` → DNS error | CNAME no propagado | Esperar 2-5 min más. `dig indexer.sdaframework.com` debe devolver IP CF |
| Mismo curl → 502 Bad Gateway | sda-indexer container no escuchando en 8000 | `docker compose ps` + `curl localhost:8000/health` en srv-ia-01 |
| `/health` 200 público pero pg_net falla | Vault srv_ia_01_url no actualizado | STEP 6 — revisar `select decrypted_secret from vault.decrypted_secrets where name='srv_ia_01_url'` |
| Endpoints protegidos devuelven 401 con bearer correcto | Bearer mismatch /etc/sda-indexer.env vs Vault | Re-sincronizar: copiar SDA_SRV_IA_01_SECRET del env y reemplazar Vault `srv_ia_01_secret` |
| Doc queda en 'pending' >30s | Drainer cron no llega o pg_net rate limit | `select * from net._http_response order by id desc limit 5;` + `select * from cron.job_run_details order by start_time desc limit 5;` |
| `out of memory` en docker | Conflicto con MinerU/vllm | Bajar `SDA_DB_POOL_MAX_SIZE` en `/etc/sda-indexer.env`, restart container |

---

## Rollback rápido

EN srv-ia-01:
```bash
cd /opt/sda-framework
PREV=$(git log --skip 1 -1 --format=%H)
git checkout $PREV
cd services/sda-indexer
sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Para disable tunnel temporalmente: `sudo systemctl stop cloudflared` (la URL devuelve 502 hasta que lo levantes de nuevo).

---

## Definition of Done — Phase L = Wave 0 cerrada

- [ ] STEP 1: Vault tiene `srv_ia_01_secret` + `srv_ia_01_url` placeholder en remote ✓
- [ ] STEP 2: `/etc/sda-indexer.env` en srv-ia-01 con todos los valores reales ✓
- [ ] STEP 3: cloudflared instalado + service running + public hostname configured ✓
- [ ] STEP 4: CNAME `indexer.sdaframework.com` en Vercel DNS resuelve a CF ✓
- [ ] STEP 5: `docker compose ps` muestra `sda-indexer-prod` running healthy ✓
- [ ] STEP 6: Vault `srv_ia_01_url` actualizado, smoke test desde Supabase devuelve 200 ✓
- [ ] STEP 7: D-0.1 ... D-0.6 ✓
- [ ] STEP 8: Tag `wave-0-foundation-complete` creado y pusheado ✓

Cuando los 8 puntos están ✅, Wave 0 está 100% completa (**38/38 tasks done**). Bien hecho.
