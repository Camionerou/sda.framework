#!/usr/bin/env bash
set -euo pipefail

HOST="${SDA_COMPUTE_GATEWAY_SSH_HOST:-sistemas@srv-ia-01}"
REMOTE_DIR="${SDA_COMPUTE_GATEWAY_REMOTE_DIR:-/home/sistemas/sda-compute-gateway}"
PORT="${SDA_COMPUTE_GATEWAY_PORT:-8787}"
DATA_DIR="${SDA_COMPUTE_GATEWAY_DATA_DIR:-/home/sistemas/sda-compute-gateway-data}"

if [[ -z "${SDA_COMPUTE_GATEWAY_TOKEN:-}" ]]; then
  echo "Falta SDA_COMPUTE_GATEWAY_TOKEN." >&2
  exit 1
fi

rsync -av --delete \
  --exclude ".env" \
  server.mjs \
  sda-compute-gateway.service \
  "$HOST:$REMOTE_DIR/"

ssh "$HOST" "mkdir -p '$REMOTE_DIR' '$DATA_DIR' ~/.config/systemd/user"
ssh "$HOST" "cat > '$REMOTE_DIR/.env' <<'EOF'
PORT=$PORT
SDA_COMPUTE_GATEWAY_DATA_DIR=$DATA_DIR
SDA_COMPUTE_GATEWAY_TOKEN=$SDA_COMPUTE_GATEWAY_TOKEN
EOF"
ssh "$HOST" "cp '$REMOTE_DIR/sda-compute-gateway.service' ~/.config/systemd/user/sda-compute-gateway.service"
ssh "$HOST" "if sudo -n true 2>/dev/null; then sudo loginctl enable-linger \"\$(whoami)\"; fi"
ssh "$HOST" "systemctl --user daemon-reload && systemctl --user enable --now sda-compute-gateway.service"
ssh "$HOST" "systemctl --user --no-pager --full status sda-compute-gateway.service"
