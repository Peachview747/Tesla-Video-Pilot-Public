#!/usr/bin/env bash
# Dedicated test database and local preview; never starts the production Telegram poller.
set -euo pipefail
cd "$(dirname "$0")/../app"
elevate=()
if [ "$(id -u)" -ne 0 ]; then elevate=(sudo); fi
"${elevate[@]}" service postgresql start
pg() { "${elevate[@]}" runuser -u postgres -- psql -v ON_ERROR_STOP=1 "$@"; }
mkdir -p .local
if [ ! -f .local/codex-cloud.env ]; then
  password=$(node -e 'console.log(require("node:crypto").randomBytes(24).toString("hex"))')
  # Refuse to reuse an existing role with unknown credentials.
  if [ "$(pg -Atc "SELECT 1 FROM pg_roles WHERE rolname='mk8_cloud_dev'")" = 1 ]; then
    echo 'mk8_cloud_dev already exists. Restore its .local/codex-cloud.env or use a fresh environment.' >&2
    exit 1
  fi
  pg <<SQL
CREATE ROLE mk8_cloud_dev LOGIN PASSWORD '$password';
CREATE DATABASE mk8_cloud_dev OWNER mk8_cloud_dev;
SQL
  umask 077
  printf 'DATABASE_URL=postgresql://mk8_cloud_dev:%s@127.0.0.1:5432/mk8_cloud_dev\nPORT=5000\nHOST=0.0.0.0\n' "$password" > .local/codex-cloud.env
fi
set -a
source .local/codex-cloud.env
set +a
export UPLOADS_DIR="$PWD/.local/cloud-uploads"
mkdir -p "$UPLOADS_DIR"
node node_modules/drizzle-kit/bin.cjs push --force
exec npm run dev:local
