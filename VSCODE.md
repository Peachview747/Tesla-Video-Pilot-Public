# MK8 in VS Code

Node.js and npm are installed. A portable Node.js runtime is also available in the parent folder's `.tools` directory; the VS Code tasks find it automatically.

## Live editing

Open <http://localhost:5173> while the development server is running. Save React, CSS, or TypeScript frontend files to see changes automatically. API source changes restart the backend automatically.

To start again, open `MK8.code-workspace` and select **Terminal > Run Task > MK8: Start development**. This starts PostgreSQL if the configured local database is offline, then starts the API and Vite. Stop a task you started with Ctrl+C in its terminal. Use **MK8: Stop background development** to stop the background instance started during setup before starting a new one.

The local database persists in `app/.local/postgres`. Tables are created automatically when a new development database is provisioned. Existing databases are left intact. Keep `DATABASE_URL` in `app/.env`; the existing root `.env` belongs to containers. Set `VITE_API_URL` empty to use Vite's same-origin API proxy. PostgreSQL listens only on loopback.

Background setup logs: `app/.local/dev.log` and `app/.local/dev-error.log`.

## Push to the main URL

The `tv` Worker is deployed in the account owning `jcruzhoovertesla.workers.dev`. Cloudflare credentials are stored in the ignored root `.env`; they are not included in release snapshots. **MK8: Set up Cloudflare Worker** can deploy the Worker again and securely update its `SECRET` from the root `TV_SECRET`. It uses `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` when configured. **MK8: Cloudflare login** is an alternative for signing in through the browser.

Use **Terminal > Run Task > MK8: Push to main URL** when local changes are ready. It builds a snapshot of the frontend and API, checks the new server, creates a Cloudflare tunnel, and updates the existing Worker using `TV_URL` and `TV_SECRET` from the root `.env`. The public address is <https://tv.jcruzhoovertesla.workers.dev>.

The public site serves a saved release with no file watcher. Source edits continue to appear only at <http://localhost:5173> until the next push. Development and main currently use the same local database and uploads; database changes affect both. The database runs independently of the editing servers.

Release metadata is in `app/.local/main.json`; release snapshots and logs are in `app/.local`. The prior release stays available briefly during the Worker destination change, then its processes are stopped. A rejected Worker update leaves the prior destination unchanged and stops the candidate processes.

This is hosted through this computer: the laptop, database, production server, and tunnel must remain running. The existing Worker uses temporary Quick Tunnel destinations. Cloudflare [recommends a named tunnel for production hosting](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

## Other tasks

- **MK8: Install dependencies** runs `npm ci`.
- **MK8: Build frontend** or **Ctrl+Shift+B** builds into `app/client/dist`.
- **MK8: Frontend** and **MK8: Backend** start each server individually, using the configured running database.
- **MK8: Debug frontend (Edge)** opens the local frontend with browser breakpoints.
- **MK8: Debug backend** starts the API with breakpoints. Stop the full development stack first, then start the database separately or use an already running PostgreSQL database and run the Frontend task.

If running commands manually in a terminal, restart VS Code to pick up the installed Node.js PATH. In `app`, `npm run dev:local` starts the same live-editing stack.

## Telegram QR login

The bot runs independently of development and production, using the same `app/.env` database. **MK8: Start Telegram bot** starts it in the background; **MK8: Stop Telegram bot** stops it. Bot logs are in `app/.local/bot.log` and `app/.local/bot-error.log`. If setting up again, install Python 3.12 and run **MK8: Install Telegram bot dependencies** first.

Refresh the browser to get a new QR code, scan it, and press **Start** in `@Tesla_Video_bot`. The QR link includes the login token. Typing `/start` alone opens the welcome message and does not authenticate a QR session. Codes expire after ten minutes.

FFmpeg and FFprobe are installed for video streaming, thumbnails, and download merging. Deno is installed for yt-dlp's YouTube JavaScript challenges. The task launcher refreshes PATH and adds the Python environment's executables before starting services. Linux `.sh` scripts require WSL or Linux.

Send a YouTube link to the bot to add it to your library. Downloads prefer H.264 video up to 720p, use the bot's own yt-dlp environment, and register only the completed output file. Downloads run outside the bot's event loop so QR login remains responsive. Check `app/.local/bot-error.log` for metadata, download, or merge failures; the bot also returns the final downloader error in Telegram. Existing YouTube cookies are used when present in `telegram-bot/cookies.txt`.

The player reads the generated MPEG-TS response incrementally without requesting byte ranges. FFmpeg paces the stream and preserves the source aspect ratio inside a 1280×720 frame. If FFmpeg was installed after a server was started, restart that server using the MK8 tasks so it picks up the updated PATH.

## Work from your phone with Codex

For initial phone setup, run **Terminal > Run Task > MK8: Open ChatGPT phone setup**. It opens the official desktop app or its installer. Sign in using the same account and workspace as your phone, then open **Settings > Connections > Control this PC > Set up / Add**. Scan the QR shown by the app and complete any verification on your phone. Then open **Codex** (or **Remote**) in the mobile app and choose this PC. Keep the PC awake and online while working remotely. See the [official Remote connections guide](https://learn.chatgpt.com/docs/remote-connections).

The complete Codex CLI is installed in the outer workspace's ignored `.tools/codex` directory. **MK8: Pair phone with Codex** creates an experimental CLI pairing QR and page in `app/.local`; these are not published to the MK8 site. The CLI host reporting connected does not prove that phone pairing has completed. If the phone reports a server error, use the desktop app's supported setup flow above rather than repeatedly scanning the CLI QR. Pairing requires you to finish the connection on your phone.

## Development tools

Installed: Git, Node.js/npm, Python 3.12, PostgreSQL, Cloudflared/Wrangler, FFmpeg/FFprobe, Deno, and yt-dlp. VS Code has Tailwind CSS, Python/Pylance, Ruff, and Prettier extensions. The workspace selects the Python virtual environment and configures formatters without changing files automatically.

**MK8: Check tools and services** checks the executables, Python dependencies, database connection, localhost, and public site. **MK8: TypeScript check** runs the compiler without emitting files. In `app`, `npm run check` does the same; `npm run test` checks the video stream source, and `npm run format` formats source files when requested. Vitest and Playwright are installed for unit/integration and browser tests. Playwright can use the installed Microsoft Edge browser with `channel: 'msedge'`.

Python development dependencies, including Ruff, can be restored with `.venv/Scripts/python.exe -m pip install -r telegram-bot/requirements-dev.txt`. Node dependencies and development tools are recorded in `package-lock.json` for `npm ci`.

If extensions have not appeared yet, run **Developer: Reload Window**. New VS Code terminals and MK8 tasks include the installed tools.

VS Code includes JavaScript and TypeScript support. Accept the recommended Tailwind CSS and Python extensions if needed, and select the workspace TypeScript version when prompted.

The local database runtime uses [embedded-postgres](https://github.com/leinelissen/embedded-postgres), which provides Windows PostgreSQL binaries.
