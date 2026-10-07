#!/usr/bin/env bash
#
# tesla.sh -- Ubuntu / Linux (Docker Compose) launcher for Tesla Video Player
#
#   ./tesla.sh          start stack + Cloudflare tunnel, print TV_URL
#   ./tesla.sh stop     stop containers + tunnel (data kept)
#   ./tesla.sh status   what's running
#   ./tesla.sh logs     recent bot logs
#   ./tesla.sh doctor   network/health dump -> doctor.txt
#   ./tesla.sh ip       show permanent URL again
#   ./tesla.sh bot-off  stop only the Telegram bot
#
# Requires: docker (compose v2 plugin), curl, cloudflared (auto-downloaded if missing)
#
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

PORT=$(grep -E '^WEB_PORT=' .env 2>/dev/null | cut -d= -f2); PORT="${PORT:-8080}"
TV_URL=$(grep -E '^TV_URL=' .env 2>/dev/null | cut -d= -f2-)
TV_SECRET=$(grep -E '^TV_SECRET=' .env 2>/dev/null | cut -d= -f2-)
TUNNEL_PID=/tmp/tesla-tunnel.pid
TUNNEL_LOG=/tmp/tesla-tunnel.log

red()  { printf '\033[0;31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[0;33m%s\033[0m\n' "$*"; }

# ---------------------------------------------------------------------------
# Docker Compose (native — no Colima)
# ---------------------------------------------------------------------------
dc() {
  docker compose -p tesla --project-directory "$DIR" -f "$DIR/compose.yml" "$@"
}

need_docker() {
  command -v docker >/dev/null 2>&1 || {
    red "Docker not found. On Ubuntu:"
    echo "  sudo apt update && sudo apt install -y docker.io docker-compose-v2"
    echo "  sudo usermod -aG docker \"\$USER\" && newgrp docker"
    exit 1
  }
  docker info >/dev/null 2>&1 || {
    red "Docker daemon not running or permission denied."
    echo "  sudo systemctl start docker"
    echo "  # if permission denied: sudo usermod -aG docker \$USER && newgrp docker"
    exit 1
  }
}

# ---------------------------------------------------------------------------
# cloudflared
# ---------------------------------------------------------------------------
ensure_cloudflared() {
  command -v cloudflared >/dev/null && return 0
  ylw "Installing cloudflared..."
  local arch url tmp
  arch=$(uname -m)
  case "$arch" in
    x86_64|amd64) url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" ;;
    aarch64|arm64) url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64" ;;
    *) red "Unsupported arch: $arch"; return 1 ;;
  esac
  tmp=$(mktemp)
  if curl -fsSL "$url" -o "$tmp"; then
    chmod +x "$tmp"
    mkdir -p "$HOME/.local/bin"
    mv "$tmp" "$HOME/.local/bin/cloudflared"
    export PATH="$HOME/.local/bin:$PATH"
    command -v cloudflared >/dev/null
  else
    rm -f "$tmp"
    return 1
  fi
}

stop_tunnel() {
  if [ -f "$TUNNEL_PID" ]; then
    kill "$(cat "$TUNNEL_PID")" 2>/dev/null || true
    rm -f "$TUNNEL_PID"
  fi
  # also kill strays from earlier runs
  pkill -f "cloudflared tunnel --no-autoupdate" 2>/dev/null || true
}

set_worker() {
  [ -n "$TV_URL" ] && [ -n "$TV_SECRET" ] || return 1
  [ "$(curl -s -m 10 -X POST -H "x-secret: $TV_SECRET" --data "$1" "$TV_URL/__set")" = "ok" ]
}

start_tunnel() {
  local attempt url=""
  for attempt in "--protocol http2 --edge-ip-version 4" "--protocol http2" ""; do
    stop_tunnel
    : > "$TUNNEL_LOG"
    # shellcheck disable=SC2086
    nohup cloudflared tunnel --no-autoupdate $attempt --url "http://127.0.0.1:${PORT}" \
      >"$TUNNEL_LOG" 2>&1 &
    echo $! > "$TUNNEL_PID"
    url=""
    for _ in $(seq 1 40); do
      kill -0 "$(cat "$TUNNEL_PID")" 2>/dev/null || break
      if grep -q 'Registered tunnel connection' "$TUNNEL_LOG" 2>/dev/null; then
        url=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -1)
      fi
      [ -n "$url" ] && break
      sleep 1
    done
    [ -n "$url" ] && break
    ylw "  Tunnel attempt failed (${attempt:-defaults}), trying another way..."
  done
  [ -n "$url" ] || return 1
  for _ in $(seq 1 20); do
    [ "$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$url/")" = "200" ] && break
    sleep 2
  done
  set_worker "$url" || {
    red "Tunnel is up, but the Worker refused the update (check TV_SECRET in .env)."
    return 2
  }
}

# ---------------------------------------------------------------------------
# Health helpers
# ---------------------------------------------------------------------------
http_ok() {
  local host="${1:-127.0.0.1}"
  local code
  code=$(curl -s -o /dev/null -m 3 -w '%{http_code}' "http://${host}:${PORT}/" 2>/dev/null || echo 000)
  [ "$code" = "200" ] || [ "$code" = "302" ] || [ "$code" = "301" ]
}

wait_for_db() {
  echo -n "Waiting for database"
  for _ in $(seq 1 60); do
    if dc exec -T db pg_isready -U tesla >/dev/null 2>&1; then
      echo
      return 0
    fi
    echo -n "."
    sleep 1
  done
  echo
  red "Database never became ready."
  return 1
}

ensure_schema() {
  # Best-effort: push drizzle schema if the tool is available inside web image
  dc exec -T web sh -c 'command -v npm >/dev/null && npm run db:push' >/tmp/tesla-schema.log 2>&1 || true
}

show_address() {
  local url="$1"
  echo
  printf '\033[1;42;30m%-52s\033[0m\n' ""
  printf '\033[1;42;30m%-52s\033[0m\n' "   TESLA / PHONE BROWSER ADDRESS:"
  printf '\033[1;42;30m   %-49s\033[0m\n' "$url"
  printf '\033[1;42;30m%-52s\033[0m\n' ""
  echo
  grn "Stack is up. Open that URL in the Tesla browser (or phone)."
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------
cmd_start() {
  need_docker
  [ -f .env ] || { red "Missing .env — copy from your Mac project or create one."; exit 1; }
  ensure_cloudflared || { red "Couldn't install cloudflared."; exit 1; }

  echo "Starting containers (first run builds images — a few minutes)..."
  dc up -d db >/tmp/tesla-up.log 2>&1 || {
    red "Database failed:"; tail -30 /tmp/tesla-up.log; exit 1
  }
  wait_for_db || exit 1

  if ! dc up -d --build >>/tmp/tesla-up.log 2>&1; then
    red "Startup failed:"; tail -40 /tmp/tesla-up.log; exit 1
  fi
  ensure_schema

  echo -n "Waiting for web server"
  for _ in $(seq 1 60); do
    http_ok 127.0.0.1 && break
    echo -n "."
    sleep 1
  done
  echo
  http_ok 127.0.0.1 || {
    red "Web server isn't answering on localhost:${PORT}. See /tmp/tesla-up.log"
    exit 1
  }
  grn "Web server is up."

  # Bot health (best-effort)
  echo -n "Checking the bot"
  BOT_OK=""
  for _ in $(seq 1 12); do
    LAST=$(dc logs --tail 30 bot 2>/dev/null | grep -E "CERTIFICATE_VERIFY_FAILED|(getMe|getUpdates).*200|Bot started|Application started" | tail -1 || true)
    case "$LAST" in
      *CERTIFICATE_VERIFY_FAILED*) BOT_OK="tls"; break ;;
      ?*) BOT_OK="yes"; break ;;
    esac
    echo -n "."; sleep 2
  done
  echo
  case "$BOT_OK" in
    yes) grn "Bot looks connected." ;;
    tls) ylw "Bot may have TLS issues (VPN/proxy?). Web player still works." ;;
    *) ylw "Bot status unclear — try: ./tesla.sh logs" ;;
  esac

  echo "Opening the public Cloudflare tunnel..."
  start_tunnel; TUN_RC=$?
  if [ "$TUN_RC" -eq 2 ]; then
    exit 1
  elif [ "$TUN_RC" -ne 0 ]; then
    red "Couldn't open the public tunnel. Last lines of $TUNNEL_LOG:"
    tail -8 "$TUNNEL_LOG"
    exit 1
  fi

  if [ -n "$TV_URL" ]; then
    show_address "$TV_URL"
  else
    ylw "TV_URL not set in .env — tunnel is up but permanent Worker URL unknown."
  fi
}

cmd_stop() {
  need_docker
  echo "Stopping tunnel..."
  stop_tunnel
  set_worker "" 2>/dev/null || true
  echo "Stopping containers..."
  dc down >/dev/null 2>&1 || true
  grn "Stopped. Database and videos are kept in Docker volumes."
}

cmd_status() {
  need_docker
  echo "=== containers ==="
  dc ps 2>/dev/null || echo "(compose project not running)"
  echo
  echo "=== tunnel ==="
  if [ -f "$TUNNEL_PID" ] && kill -0 "$(cat "$TUNNEL_PID")" 2>/dev/null; then
    grn "cloudflared running (pid $(cat "$TUNNEL_PID"))"
    grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1 || true
  else
    ylw "tunnel not running"
  fi
  echo
  echo "=== local web ==="
  if http_ok 127.0.0.1; then grn "http://127.0.0.1:${PORT}/ OK"; else red "localhost:${PORT} not answering"; fi
  [ -n "$TV_URL" ] && echo "Permanent URL: $TV_URL"
}

cmd_logs() {
  need_docker
  dc logs --tail 80 bot
}

cmd_bot_off() {
  need_docker
  dc stop bot
  grn "Bot stopped. Web + db still running."
}

cmd_ip() {
  if [ -n "$TV_URL" ]; then
    show_address "$TV_URL"
  else
    red "TV_URL not set in .env"
  fi
}

cmd_doctor() {
  need_docker
  {
    echo "=== tesla doctor $(date -Iseconds) ==="
    echo "hostname: $(hostname)"
    echo "uname: $(uname -a)"
    echo "PORT=$PORT TV_URL=$TV_URL"
    echo
    echo "=== docker ==="
    docker version 2>&1 | head -20
    echo
    dc ps 2>&1
    echo
    echo "=== tunnel log (tail) ==="
    tail -30 "$TUNNEL_LOG" 2>/dev/null || echo "(no tunnel log)"
    echo
    echo "=== localhost curl ==="
    curl -sI -m 5 "http://127.0.0.1:${PORT}/" 2>&1 | head -15
    echo
    echo "=== routes ==="
    ip -4 route 2>/dev/null || route -n 2>/dev/null
    echo
    echo "=== disk ==="
    df -h "$DIR" 2>/dev/null
  } | tee doctor.txt
  grn "Wrote doctor.txt"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
case "${1:-start}" in
  start|"") cmd_start ;;
  stop)     cmd_stop ;;
  status)   cmd_status ;;
  logs)     cmd_logs ;;
  bot-off)  cmd_bot_off ;;
  ip)       cmd_ip ;;
  doctor)   cmd_doctor ;;
  *)
    echo "Usage: $0 {start|stop|status|logs|bot-off|ip|doctor}"
    exit 1
    ;;
esac
