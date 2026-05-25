#!/usr/bin/env bash
#
# deploy_srv_ia_01.sh — Helper script para correr EN srv-ia-01 (no en local).
# Asume:
#   - Repo clonado en /opt/sda-framework
#   - /etc/sda-indexer.env existe (chmod 600) con todos los SDA_* completos
#   - Docker + docker compose instalados
#
# Uso:
#   ssh srv-ia-01
#   sudo bash /opt/sda-framework/services/sda-indexer/scripts/deploy_srv_ia_01.sh
#
# El script es idempotente — re-correrlo es seguro y hace pull/build + restart.

set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/sda-framework}"
ENV_FILE="${ENV_FILE:-/etc/sda-indexer.env}"
SERVICE_DIR="${REPO_DIR}/services/sda-indexer"

echo "==> Pre-flight checks"
[[ -d "$REPO_DIR" ]]    || { echo "ERROR: $REPO_DIR no existe. Clonar el repo primero."; exit 1; }
[[ -f "$ENV_FILE" ]]    || { echo "ERROR: $ENV_FILE no existe. Crear desde .env.production.example."; exit 1; }
[[ -d "$SERVICE_DIR" ]] || { echo "ERROR: $SERVICE_DIR no existe. Repo está desactualizado."; exit 1; }
command -v docker >/dev/null || { echo "ERROR: docker no instalado."; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "ERROR: docker compose v2 no instalado."; exit 1; }

ENV_PERMS=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE")
if [[ "$ENV_PERMS" != "600" ]]; then
  echo "WARNING: $ENV_FILE permisos $ENV_PERMS — fijando 600"
  chmod 600 "$ENV_FILE"
fi

echo "==> Verificar SDA_* críticos en env"
for var in SDA_SUPABASE_URL SDA_SUPABASE_SERVICE_KEY SDA_DEEPSEEK_API_KEY SDA_SRV_IA_01_SECRET SDA_DB_DSN; do
  if ! grep -q "^${var}=" "$ENV_FILE"; then
    echo "ERROR: ${var} ausente en $ENV_FILE"
    exit 1
  fi
  val=$(grep "^${var}=" "$ENV_FILE" | head -1 | cut -d= -f2-)
  if [[ -z "$val" ]] || [[ "$val" == *"<"* ]]; then
    echo "ERROR: ${var} sin valor o aún con placeholder en $ENV_FILE"
    exit 1
  fi
done
echo "    OK: las 5 vars críticas presentes y no-placeholders"

echo "==> git pull (mantenerse en main)"
cd "$REPO_DIR"
git fetch origin
LOCAL_SHA=$(git rev-parse HEAD)
REMOTE_SHA=$(git rev-parse origin/main)
if [[ "$LOCAL_SHA" != "$REMOTE_SHA" ]]; then
  echo "    update disponible: $LOCAL_SHA → $REMOTE_SHA"
  git checkout main
  git pull --ff-only origin main
else
  echo "    ya en HEAD ($LOCAL_SHA)"
fi

echo "==> docker compose down (cleanup container anterior si existe)"
cd "$SERVICE_DIR"
docker compose -f docker-compose.yml -f docker-compose.prod.yml down --remove-orphans || true

echo "==> docker compose build (puede tardar ~3-5 min en primera build)"
docker compose -f docker-compose.yml -f docker-compose.prod.yml build --pull

echo "==> docker compose up -d"
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

echo "==> Esperar healthcheck (max 60s)"
for i in {1..30}; do
  if curl -fsS http://localhost:8000/health >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

echo "==> Verificar /health"
HEALTH=$(curl -fsS http://localhost:8000/health)
echo "    $HEALTH"
if ! echo "$HEALTH" | grep -q '"status":"ok"'; then
  echo "ERROR: health no devuelve ok"
  docker compose -f docker-compose.yml -f docker-compose.prod.yml logs --tail 50 sda-indexer
  exit 1
fi

echo "==> Logs últimas líneas:"
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs --tail 20 sda-indexer

echo ""
echo "==> ✅ Deploy completo. Servicio reachable en localhost:8000 (DENTRO de srv-ia-01)."
echo "==> Próximo paso: configurar Tailscale Funnel para exponerlo público."
