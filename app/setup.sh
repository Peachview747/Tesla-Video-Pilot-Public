#!/usr/bin/env bash
set -euo pipefail

# Tesla Video Player - Server Setup Script
# Run this on your Oracle Cloud VM after copying the files.

PROJECT_DIR="/opt/tesla-video-player"
UPLOADS_DIR="${PROJECT_DIR}/uploads/videos"

echo "=== Tesla Video Player Server Setup ==="

# 1. Create necessary directories
echo "[1/6] Creating directories..."
sudo mkdir -p "${PROJECT_DIR}"
sudo mkdir -p "${UPLOADS_DIR}"
sudo chown -R "$(whoami):$(whoami)" "${PROJECT_DIR}"

# 2. Copy server files into the project directory (run from the tesla-server-files dir)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "[2/6] Copying files from ${SCRIPT_DIR} to ${PROJECT_DIR}..."
cp -r "${SCRIPT_DIR}/server" "${PROJECT_DIR}/"
cp -r "${SCRIPT_DIR}/drizzle" "${PROJECT_DIR}/"
cp -r "${SCRIPT_DIR}/shared" "${PROJECT_DIR}/"
cp -r "${SCRIPT_DIR}/telegram-bot" "${PROJECT_DIR}/"
cp "${SCRIPT_DIR}/drizzle.config.ts" "${PROJECT_DIR}/"

if [ -f "${SCRIPT_DIR}/.env" ]; then
  cp "${SCRIPT_DIR}/.env" "${PROJECT_DIR}/.env"
  echo "  Copied .env file"
elif [ -f "${SCRIPT_DIR}/.env.example" ]; then
  cp "${SCRIPT_DIR}/.env.example" "${PROJECT_DIR}/.env.example"
  echo "  Copied .env.example -- remember to create .env with real values!"
fi

# 3. Install npm dependencies
echo "[3/6] Installing Node.js dependencies..."
cd "${PROJECT_DIR}"

# Initialize package.json if it doesn't exist
if [ ! -f "package.json" ]; then
  npm init -y
fi

npm install express @trpc/server cookie-parser drizzle-orm postgres uuid cors dotenv zod
npm install -D typescript tsx drizzle-kit @types/express @types/cookie-parser @types/cors @types/uuid

# Add scripts to package.json
node -e "
const pkg = require('./package.json');
pkg.scripts = {
  ...pkg.scripts,
  'dev:server': 'tsx watch server/index.ts',
  'start': 'tsx server/index.ts',
  'db:push': 'drizzle-kit push',
  'db:generate': 'drizzle-kit generate',
  'db:studio': 'drizzle-kit studio'
};
require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# 4. Create tsconfig.json if missing
if [ ! -f "tsconfig.json" ]; then
  echo "[4/6] Creating tsconfig.json..."
  cat > tsconfig.json << 'TSCONFIG'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "outDir": "./build",
    "rootDir": ".",
    "resolveJsonModule": true,
    "declaration": true
  },
  "include": ["server/**/*", "drizzle/**/*", "shared/**/*"],
  "exclude": ["node_modules", "dist", "build"]
}
TSCONFIG
else
  echo "[4/6] tsconfig.json already exists, skipping."
fi

# 5. Push database schema
echo "[5/6] Pushing database schema..."
if [ -f ".env" ]; then
  set -a
  source .env
  set +a
  npx drizzle-kit push
else
  echo "  Skipping db:push -- no .env file found. Run 'npm run db:push' after creating .env"
fi

# 6. Set up Python environment for Telegram bot
echo "[6/6] Setting up Telegram bot Python environment..."
cd "${PROJECT_DIR}/telegram-bot"
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
deactivate

echo ""
echo "=== Setup complete! ==="
echo ""
echo "Next steps:"
echo "  1. Create/edit ${PROJECT_DIR}/.env with your actual credentials"
echo "  2. Copy your built frontend to ${PROJECT_DIR}/dist/"
echo "  3. Start the server:  cd ${PROJECT_DIR} && npm start"
echo "  4. Start the bot:     cd ${PROJECT_DIR}/telegram-bot && source venv/bin/activate && python bot.py"
echo ""
echo "For systemd services, create unit files for both the server and the bot."
