#!/usr/bin/env bash
#
# pull-from-vm.sh -- Copy the WORKING, patched source off the Oracle VM
#                    down to this Mac, ready to containerize.
#
# Run on the MAC:
#   chmod +x pull-from-vm.sh && ./pull-from-vm.sh
#
# The copies in ~/tesla-server-files are the pre-patch originals. The VM has
# every fix from the deployment session. This grabs the VM's version.
#

set -euo pipefail

VM="${VM:-Peachview@167.234.213.231}"
SRC="/opt/tesla-video-player"
DEST="$(cd "$(dirname "$0")" && pwd)/app"

echo "==> Pulling source from ${VM}"
mkdir -p "$DEST"

# Everything except the heavy/rebuildable stuff
rsync -av --progress \
  --exclude 'node_modules' \
  --exclude 'uploads' \
  --exclude '.git' \
  --exclude 'client/node_modules' \
  --exclude 'client/dist' \
  --exclude 'dist' \
  --exclude 'telegram-bot/venv' \
  "${VM}:${SRC}/" "$DEST/"

echo
echo "==> Pulling YouTube cookies (needed to defeat the bot check)"
scp "${VM}:${SRC}/telegram-bot/cookies.txt" "$DEST/telegram-bot/cookies.txt" \
  && chmod 600 "$DEST/telegram-bot/cookies.txt" \
  || echo "    WARNING: no cookies.txt found -- YouTube downloads will fail until you add one."

echo
echo "==> Done. Source is in: $DEST"
echo
echo "Sanity check -- these should all return a match:"
echo
grep -q "COOKIE_ARGS" "$DEST/telegram-bot/bot.py" \
  && echo "  [ok] bot.py has cookie support" \
  || echo "  [MISSING] bot.py cookie patch"
grep -q "import psycopg$" "$DEST/telegram-bot/bot.py" \
  && echo "  [ok] bot.py uses psycopg v3" \
  || echo "  [MISSING] psycopg v3 patch"
grep -q "process.cwd()" "$DEST/server/index.ts" \
  && echo "  [ok] server uses process.cwd()" \
  || echo "  [MISSING] __dirname fix"
grep -q "{\*path}" "$DEST/server/index.ts" \
  && echo "  [ok] server uses Express 5 wildcard" \
  || echo "  [MISSING] Express 5 route fix"
grep -q "Tesla_Video_bot" "$DEST/client/src/pages/Auth.tsx" \
  && echo "  [ok] correct bot username in Auth.tsx" \
  || echo "  [MISSING] bot username fix"
echo
