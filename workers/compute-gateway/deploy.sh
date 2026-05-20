#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="${SDA_COMPUTE_GATEWAY_SSH_HOST:-sistemas@srv-ia-01}"
REMOTE_DIR="${SDA_COMPUTE_GATEWAY_REMOTE_DIR:-/home/sistemas/sda-compute-gateway}"
PORT="${SDA_COMPUTE_GATEWAY_PORT:-8787}"
DATA_DIR="${SDA_COMPUTE_GATEWAY_DATA_DIR:-/home/sistemas/sda-compute-gateway-data}"
CONCURRENCY="${SDA_COMPUTE_GATEWAY_CONCURRENCY:-1}"
MINERU_BACKEND="${SDA_MINERU_BACKEND:-pipeline}"
MINERU_BIN="${SDA_MINERU_BIN:-/home/sistemas/sda-mineru/.venv/bin/mineru}"
MINERU_LANG="${SDA_MINERU_LANG:-latin}"

if [[ -z "${SDA_COMPUTE_GATEWAY_TOKEN:-}" ]]; then
  SDA_COMPUTE_GATEWAY_TOKEN="$(
    ssh "$HOST" "if [[ -f '$REMOTE_DIR/.env' ]]; then awk -F= '/^SDA_COMPUTE_GATEWAY_TOKEN=/ {print substr(\$0, index(\$0,\"=\")+1); exit}' '$REMOTE_DIR/.env'; fi"
  )"
fi

if [[ -z "${SDA_COMPUTE_GATEWAY_TOKEN:-}" ]]; then
  echo "Falta SDA_COMPUTE_GATEWAY_TOKEN y no existe uno remoto para reutilizar." >&2
  exit 1
fi

rsync -av --delete \
  --exclude ".env" \
  "$SCRIPT_DIR/server.mjs" \
  "$SCRIPT_DIR/sda-compute-gateway.service" \
  "$HOST:$REMOTE_DIR/"

ssh "$HOST" "mkdir -p '$REMOTE_DIR' '$DATA_DIR' ~/.config/systemd/user"
ssh "$HOST" "cat > '$REMOTE_DIR/.env' <<'EOF'
PORT=$PORT
SDA_COMPUTE_GATEWAY_DATA_DIR=$DATA_DIR
SDA_COMPUTE_GATEWAY_TOKEN=$SDA_COMPUTE_GATEWAY_TOKEN
SDA_COMPUTE_GATEWAY_CONCURRENCY=$CONCURRENCY
SDA_MINERU_BIN=$MINERU_BIN
SDA_MINERU_BACKEND=$MINERU_BACKEND
SDA_MINERU_LANG=$MINERU_LANG
SUPABASE_URL=${SUPABASE_URL:-}
SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY:-}
EOF"
ssh "$HOST" "cp '$REMOTE_DIR/sda-compute-gateway.service' ~/.config/systemd/user/sda-compute-gateway.service"
ssh "$HOST" "if sudo -n true 2>/dev/null; then sudo loginctl enable-linger \"\$(whoami)\"; fi"
ssh "$HOST" "systemctl --user daemon-reload && systemctl --user enable sda-compute-gateway.service && systemctl --user restart sda-compute-gateway.service"
ssh "$HOST" "systemctl --user --no-pager --full status sda-compute-gateway.service"
