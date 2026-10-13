import path from "node:path";
import { fileURLToPath } from "node:url";
import { Library } from "./library.mjs";
import { createVideoPilotServer } from "./server.mjs";
import { PiTunnel } from "./tunnel.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const publicURL = process.env.VIDEO_PILOT_URL || "https://tv.jch76.workers.dev";
const secret = process.env.VIDEO_PILOT_SECRET;
if (!secret) throw new Error("VIDEO_PILOT_SECRET is required. Run: sudo video-pilot-configure");
const port = Number(process.env.VIDEO_PILOT_PORT || 5001);
const library = await new Library({
  dataDir: process.env.VIDEO_PILOT_DATA || "/var/lib/video-pilot",
  ytDlp: process.env.YT_DLP || path.resolve(root, "pi-host/.venv/bin/yt-dlp"),
}).init();
const http = createVideoPilotServer({ library, webRoot: path.resolve(root, "ios/Web"),
  decoderPath: path.resolve(root, "app/client/public/jsmpeg.min.js"), port, version: "0.1.40-pi" });
await http.start();
library.warmQualities();
const tunnel = new PiTunnel({ publicURL, secret, localURL: `http://127.0.0.1:${port}` });
const shutdown = async () => { tunnel.stop(); await http.stop(); process.exit(0); };
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
console.log(`Video Pilot Pi host listening on 127.0.0.1:${port}`);
await tunnel.run();
