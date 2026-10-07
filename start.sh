#!/usr/bin/env bash
#
# start.sh -- Build and launch the Tesla Video Player stack on this Mac.
#
#   cd ~/tesla-docker && ./start.sh
#
set -euo pipefail

cd "$(dirname "$0")"

command -v docker >/dev/null || {
  echo "Docker not found. Install Docker Desktop:"
  echo "  brew install --cask docker"
  echo "Then launch it once from Applications before re-running this."
  exit 1
}

docker info >/dev/null 2>&1 || {
  echo "Docker Desktop isn't running. Start it, wait for the whale icon, then re-run."
  exit 1
}

[ -f app/telegram-bot/cookies.txt ] \
  || echo "WARNING: no cookies.txt -- YouTube will block downloads. Run pull-from-vm.sh."

echo "==> Building (first run pulls base images; give it a few minutes)"
docker compose build

echo "==> Starting database"
docker compose up -d db
until docker compose exec -T db pg_isready -U tesla -d tesla_video >/dev/null 2>&1; do
  sleep 1
done

echo "==> Creating database schema"
docker compose run --rm \
  -e DATABASE_URL="postgresql://tesla:${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD}@db:5432/tesla_video" \
  web npx drizzle-kit push --force

echo "==> Starting web + bot"
docker compose up -d

PORT=$(grep -E '^WEB_PORT=' .env | cut -d= -f2)
PORT="${PORT:-8080}"

echo
echo "======================================================"
echo " Running: http://localhost:${PORT}"
echo "======================================================"
echo
echo "  Logs:    docker compose logs -f"
echo "  Stop:    docker compose down"
echo "  Restart: docker compose restart"
echo
echo "To reach it from the Tesla on your hotspot, find your Mac's IP:"
echo "  ipconfig getifaddr en0"
echo "then add http://<that-ip>:${PORT} to ALLOWED_ORIGINS in .env and"
echo "run: docker compose up -d"
echo
