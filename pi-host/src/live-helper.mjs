// Netflix and Hulu in the car. Their players only run in a real browser with
// Widevine, so this runs Chromium on a virtual screen (Xvfb) as the desktop
// user and streams that screen live to the car's player: ffmpeg grabs the
// picture and Chromium's sound (a PipeWire null sink) into the same MPEG-TS
// the recorded videos use. Taps and typing come back through xdotool. The
// profile is kept, so the user signs in once from the car. Nothing is
// downloaded or decrypted; it is the user's own session, watched remotely.
// Keep Chromium's own user agent: on Linux it already reads "X11; Linux
// x86_64", which Netflix plays. Disguising it as a Chromebook made Netflix
// refuse every title (E100), because the browser's other signals said Linux.
// Listens on loopback only; the Video Pilot server proxies to it.
import { spawn, execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

export const SCREEN = { width: 1280, height: 720 };
export const SERVICES = {
  netflix: { name: "Netflix", url: "https://www.netflix.com/browse" },
  hulu: { name: "Hulu", url: "https://www.hulu.com/hub/home" },
  // Signed in once here, the Pi can later send alert texts through it.
  textnow: { name: "TextNow", url: "https://www.textnow.com/messaging" },
};
const SINK = "video-pilot-live";
const KEYS = new Set(["Return", "BackSpace", "Tab", "Escape", "Up", "Down", "Left", "Right", "space", "f", "alt+Left"]);

function execTool(file, args, env) {
  return new Promise((resolve, reject) => execFile(file, args, { env, timeout: 10_000, encoding: "buffer", maxBuffer: 16 << 20 },
    (error, stdout) => error ? reject(error) : resolve(stdout)));
}

export class LiveSession {
  constructor({ tools = "/opt/pi-tools/usr", display = ":98", home = os.homedir(), exec = execTool, launch = spawn,
    widevine = "/opt/WidevineCdm", idleMs = 3 * 60_000, bitrate = 2000 } = {}) {
    this.display = display;
    this.profile = path.join(home, ".local/share/video-pilot-live/profile");
    this.widevine = widevine;
    this.shot = path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), "video-pilot-live.jpg");
    this.xvfb = path.join(tools, "bin/Xvfb");
    this.xdotool = path.join(tools, "bin/xdotool");
    this.env = { ...process.env, DISPLAY: display, PULSE_SINK: SINK,
      LD_LIBRARY_PATH: [path.join(tools, "lib/aarch64-linux-gnu"), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") };
    this.exec = exec; this.launch = launch; this.idleMs = idleMs; this.bitrate = bitrate;
    this.xserver = null; this.browser = null; this.encoder = null;
    this.service = ""; this.state = "idle"; this.message = "";
  }

  status() {
    return { active: Boolean(this.browser), service: this.service, state: this.state, message: this.message,
      streaming: Boolean(this.encoder), screen: SCREEN };
  }

  // Chromium's sound goes to its own silent sink; ffmpeg records its monitor.
  async ensureSink() {
    const nodes = String(await this.exec("pw-cli", ["ls", "Node"], this.env).catch(() => ""));
    if (nodes.includes(`"${SINK}"`)) return;
    await this.exec("pw-cli", ["create-node", "adapter", `{ factory.name=support.null-audio-sink node.name=${SINK} ` +
      `node.description="Video Pilot live" media.class=Audio/Sink audio.position=[FL FR] priority.session=0 object.linger=true }`], this.env);
  }

  // A new profile would have to download Widevine and restart before DRM
  // plays. Point it at the copy Raspberry Pi OS installs (libwidevinecdm0).
  async seedWidevine() {
    const hint = path.join(this.profile, "WidevineCdm/latest-component-updated-widevine-cdm");
    if (await stat(hint).then(() => true, () => false)) return;
    if (!await stat(path.join(this.widevine, "manifest.json")).then(() => true, () => false)) return;
    await mkdir(path.dirname(hint), { recursive: true });
    await writeFile(hint, JSON.stringify({ Path: this.widevine }));
  }

  async start(service) {
    const target = SERVICES[service];
    if (!target) throw new Error("Choose Netflix, Hulu or TextNow.");
    this.stopBrowser();
    await mkdir(this.profile, { recursive: true });
    await this.seedWidevine();
    await this.ensureSink().catch(() => {});
    if (!this.xserver) {
      this.xserver = this.launch(this.xvfb, [this.display, "-screen", "0", `${SCREEN.width}x${SCREEN.height}x24`, "-nolisten", "tcp"], { env: this.env, stdio: "ignore" });
      this.xserver.once?.("exit", () => { this.xserver = null; });
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    // Chromium can leave a lock behind when it is killed; it then refuses the profile.
    for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) await rm(path.join(this.profile, lock), { force: true });
    this.browser = this.launch("chromium", [`--user-data-dir=${this.profile}`, "--no-first-run", "--no-default-browser-check",
      "--password-store=basic", "--kiosk", `--window-size=${SCREEN.width},${SCREEN.height}`, "--window-position=0,0",
      "--autoplay-policy=no-user-gesture-required", "--disable-features=Translate,MediaRouter", "--disable-session-crashed-bubble",
      "--hide-crash-restore-bubble", target.url], { env: this.env, stdio: "ignore" });
    const browser = this.browser;
    browser.once?.("exit", () => { if (this.browser === browser) { this.browser = null; this.stopEncoder(); this.state = "idle"; } });
    this.service = service; this.state = "open"; this.message = `${target.name} is open on the Pi.`;
    this.touch();
    return this.status();
  }

  // Nobody watching for a while (the car closed the page or drove off): close it.
  touch() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => { if (!this.encoder) this.stop("idle", "Closed after no one was watching."); }, this.idleMs);
  }

  // One viewer at a time; a new stream replaces the old one.
  stream() {
    if (!this.browser) throw new Error("Open Netflix or Hulu first.");
    this.stopEncoder();
    const encoder = this.launch("ffmpeg", ["-hide_banner", "-loglevel", "error", "-fflags", "nobuffer",
      "-f", "x11grab", "-draw_mouse", "0", "-framerate", "25", "-video_size", `${SCREEN.width}x${SCREEN.height}`, "-i", this.display,
      "-f", "pulse", "-fragment_size", "4096", "-i", `${SINK}.monitor`,
      "-c:v", "mpeg1video", "-b:v", `${this.bitrate}k`, "-maxrate", `${Math.round(this.bitrate * 1.25)}k`, "-bufsize", `${this.bitrate}k`,
      "-bf", "0", "-g", "50", "-c:a", "mp2", "-b:a", "128k", "-ar", "44100", "-ac", "2",
      "-f", "mpegts", "-muxdelay", "0", "-flush_packets", "1", "pipe:1"], { env: this.env, stdio: ["ignore", "pipe", "ignore"] });
    this.encoder = encoder;
    encoder.once?.("exit", () => { if (this.encoder === encoder) { this.encoder = null; this.touch(); } });
    return encoder;
  }

  async screenshot() {
    if (!this.browser) throw new Error("Open Netflix or Hulu first.");
    await this.exec("scrot", ["-o", "-q", "70", this.shot], this.env);
    return readFile(this.shot);
  }

  async input({ type, x, y, text, key }) {
    if (!this.browser) throw new Error("Open Netflix or Hulu first.");
    this.touch();
    if (type === "click") {
      const px = Math.round(Number(x)), py = Math.round(Number(y));
      if (!(px >= 0 && px < SCREEN.width && py >= 0 && py < SCREEN.height)) throw new Error("Tap is outside the screen.");
      await this.exec(this.xdotool, ["mousemove", String(px), String(py), "click", "1"], this.env);
    } else if (type === "text") {
      const value = String(text || "");
      if (!value || value.length > 256) throw new Error("Type up to 256 characters at a time.");
      await this.exec(this.xdotool, ["type", "--delay", "25", "--", value], this.env);
    } else if (type === "key") {
      if (!KEYS.has(key)) throw new Error("That key is not available.");
      await this.exec(this.xdotool, ["key", key], this.env);
    } else if (type === "scroll") {
      const button = Number(y) < 0 ? "4" : "5";
      await this.exec(this.xdotool, ["click", "--repeat", "5", button], this.env);
    } else throw new Error("Unknown input.");
    return { ok: true };
  }

  stopEncoder() {
    const encoder = this.encoder; this.encoder = null;
    try { encoder?.kill("SIGKILL"); } catch {}
  }

  stopBrowser() {
    this.stopEncoder();
    const browser = this.browser; this.browser = null;
    try { browser?.kill("SIGTERM"); } catch {}
  }

  stop(state = "idle", message = "") {
    clearTimeout(this.idle);
    this.stopBrowser();
    try { this.xserver?.kill("SIGTERM"); } catch {}
    this.xserver = null;
    this.service = ""; this.state = state; this.message = message;
    return this.status();
  }
}

async function body(req) {
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > 4096) throw new Error("Request is too large."); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

// The relay needs a length up front; a live stream has none, so it claims a
// size it never reaches and simply stops when the viewer goes away.
export const LIVE_LENGTH = 64 * 1024 ** 3;

export function createLiveServer(session, { port = 5003, host = "127.0.0.1" } = {}) {
  return http.createServer(async (req, res) => {
    const reply = (status, value, type = "application/json") => {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
      res.writeHead(status, { "content-type": type, "content-length": bytes.length, "cache-control": "no-store" }); res.end(bytes);
    };
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/status" && req.method === "GET") return reply(200, session.status());
      if (url.pathname === "/start" && req.method === "POST") return reply(200, await session.start((await body(req)).service));
      if (url.pathname === "/stop" && req.method === "POST") return reply(200, session.stop("idle"));
      if (url.pathname === "/screen" && req.method === "GET") return reply(200, await session.screenshot(), "image/jpeg");
      if (url.pathname === "/input" && req.method === "POST") return reply(200, await session.input(await body(req)));
      if (url.pathname === "/stream.ts" && req.method === "GET") {
        const encoder = session.stream();
        res.writeHead(200, { "content-type": "video/mp2t", "content-length": LIVE_LENGTH, "cache-control": "no-store", "x-video-live": "1" });
        encoder.stdout.pipe(res);
        const end = () => { if (session.encoder === encoder) session.stopEncoder(); };
        res.once("close", end);
        encoder.once("exit", () => res.destroy());
        return;
      }
      return reply(404, { error: "Not found." });
    } catch (error) { if (!res.headersSent) reply(400, { error: String(error.message || error) }); else res.destroy(); }
  }).listen(port, host);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const session = new LiveSession();
  createLiveServer(session);
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { session.stop(); process.exit(0); });
  console.log("Video Pilot live helper on 127.0.0.1:5003");
}
