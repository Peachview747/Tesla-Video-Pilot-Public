#!/usr/bin/env bash
# Install tools for a disposable Linux development workspace. No production secrets needed.
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v node >/dev/null || ! node -e 'if(Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'; then
  echo 'Choose a Codex cloud runtime with Node.js 22 or newer.' >&2
  exit 1
fi
elevate=()
if [ "$(id -u)" -ne 0 ]; then elevate=(sudo); fi
"${elevate[@]}" apt-get update
"${elevate[@]}" apt-get install -y ffmpeg postgresql python3 python3-venv
cd app
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -r telegram-bot/requirements.txt -r telegram-bot/requirements-dev.txt
npm run check
npm test
npm run build
echo 'MK8 cloud dependencies ready. See CODEX_CLOUD.md to start an isolated preview database.'
