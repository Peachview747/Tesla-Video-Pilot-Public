import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Library } from "./library.mjs";
import { createVideoPilotServer } from "./server.mjs";
import { PiTunnel } from "./tunnel.mjs";
import { PinLock } from "./pin-lock.mjs";
import { DeviceGate } from "./device-gate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const publicURL = process.env.VIDEO_PILOT_URL || "https://tv.jch76.workers.dev";
const secret = process.env.VIDEO_PILOT_SECRET;
if (!secret) throw new Error("VIDEO_PILOT_SECRET is required. Run: sudo video-pilot-configure");
const port = Number(process.env.VIDEO_PILOT_PORT || 5001);
const dataDir = process.env.VIDEO_PILOT_DATA || "/var/lib/video-pilot";
const library = await new Library({
  dataDir,
  ytDlp: process.env.YT_DLP || path.resolve(root, "pi-host/.venv/bin/yt-dlp"),
}).init();
const pinLock = await new PinLock({ dataDir }).load();
const gate = await new DeviceGate({ dataDir }).load();
// Shared with AI Room's local control API (portal AI Room and Pi Health).
const controlKey = await readFile(process.env.PI_CONTROL_KEY || "/opt/pi-control/key", "utf8").then(text => text.trim() || null, () => null);
let tunnel = null;
const http = createVideoPilotServer({ library, webRoot: path.resolve(root, "ios/Web"),
  decoderPath: path.resolve(root, "app/client/public/jsmpeg.min.js"), port, version: "0.1.40-pi", pinLock, gate,
  controlKey, airoomWeb: process.env.AIROOM_WEB || "/opt/ai-room/web", tunnelConnected: () => tunnel?.connected() ?? null,
  // The HTTPS front (Caddy) forwards here; always treated as outside.
  publicPort: process.env.VIDEO_PILOT_PUBLIC_PORT === "off" ? null : Number(process.env.VIDEO_PILOT_PUBLIC_PORT || 5101) });
await http.start();
library.drain();
library.warmQualities();
tunnel = new PiTunnel({ publicURL, secret, localURL: `http://127.0.0.1:${port}` });
const shutdown = async () => { tunnel.stop(); await http.stop(); process.exit(0); };
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
console.log(`Video Pilot Pi host listening on 127.0.0.1:${port}`);
await tunnel.run();
