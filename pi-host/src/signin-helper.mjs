// YouTube sign-in from the car. Google only signs in real browsers, so this
// runs Firefox on a virtual screen (Xvfb) as the desktop user and lets the
// Video Pilot page drive it: the page shows screenshots and sends taps and
// typing back through xdotool. Each session starts from an empty profile, so
// nobody who opens the page later finds a signed-in browser; once Google sets
// the YouTube login cookies they are handed to Video Pilot and the session is
// wiped. Listens on loopback only; the Video Pilot server proxies to it.
import { spawn, execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

export const SCREEN = { width: 900, height: 1000 };
const SIGN_IN_URL = "https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F";
const KEYS = new Set(["Return", "BackSpace", "Tab", "Escape", "Up", "Down", "Left", "Right", "space"]);
// Quieter first run: no password manager, passkey or telemetry prompts.
const PREFS = [
  ["signon.rememberSignons", false], ["signon.autofillForms", false], ["security.webauth.webauthn", false],
  ["browser.shell.checkDefaultBrowser", false], ["datareporting.policy.dataSubmissionEnabled", false],
  ["browser.aboutwelcome.enabled", false], ["toolkit.telemetry.reportingpolicy.firstRun", false],
  ["browser.startup.homepage_override.mstone", "ignore"], ["browser.sessionstore.resume_from_crash", false],
];

function execTool(file, args, env) {
  return new Promise((resolve, reject) => execFile(file, args, { env, timeout: 10_000, encoding: "buffer", maxBuffer: 16 << 20 },
    (error, stdout) => error ? reject(error) : resolve(stdout)));
}

export class SignInSession {
  constructor({ tools = "/opt/pi-tools/usr", display = ":99", home = os.homedir(), syncCommand,
    exec = execTool, launch = spawn, timeoutMs = 10 * 60_000, pollMs = 3000 } = {}) {
    this.display = display;
    this.profile = path.join(home, ".local/share/video-pilot-signin/profile");
    this.shot = path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), "video-pilot-signin.jpg");
    this.xvfb = path.join(tools, "bin/Xvfb");
    this.xdotool = path.join(tools, "bin/xdotool");
    this.env = { ...process.env, DISPLAY: display, MOZ_ENABLE_WAYLAND: "0",
      LD_LIBRARY_PATH: [path.join(tools, "lib/aarch64-linux-gnu"), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") };
    this.syncCommand = syncCommand || path.join(home, ".local/bin/youtube-cookie-sync");
    this.exec = exec; this.launch = launch; this.timeoutMs = timeoutMs; this.pollMs = pollMs;
    this.processes = []; this.active = false; this.state = "idle"; this.message = "";
  }

  status() { return { active: this.active, state: this.state, message: this.message, screen: SCREEN }; }

  async start() {
    await this.stop("idle");
    await rm(this.profile, { recursive: true, force: true });
    await mkdir(this.profile, { recursive: true });
    await writeFile(path.join(this.profile, "user.js"), PREFS.map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join("\n") + "\n");
    this.active = true; this.state = "starting"; this.message = "Opening Google sign-in on the Pi…";
    this.processes.push(this.launch(this.xvfb, [this.display, "-screen", "0", `${SCREEN.width}x${SCREEN.height}x24`, "-nolisten", "tcp"], { env: this.env, stdio: "ignore" }));
    await new Promise(resolve => setTimeout(resolve, 1500));
    this.processes.push(this.launch("firefox", ["--no-remote", "--profile", this.profile, "--kiosk", SIGN_IN_URL], { env: this.env, stdio: "ignore" }));
    this.deadline = setTimeout(() => void this.stop("expired", "Sign-in timed out. Start again when ready."), this.timeoutMs);
    this.watch = setInterval(() => void this.check(), this.pollMs);
    return this.status();
  }

  // Firefox has no window manager here; size its window to the whole screen.
  async fitWindow() {
    try {
      const ids = String(await this.exec(this.xdotool, ["search", "--onlyvisible", "--class", "firefox"], this.env)).trim().split(/\s+/);
      if (ids[0]) await this.exec(this.xdotool, ["windowmove", ids[0], "0", "0", "windowsize", ids[0], String(SCREEN.width), String(SCREEN.height)], this.env);
      return Boolean(ids[0]);
    } catch { return false; }
  }

  async check() {
    if (!this.active) return;
    if (this.state === "starting" && await this.fitWindow()) { this.state = "open"; this.message = "Sign in to your Google account."; }
    try {
      const output = String(await this.exec(this.syncCommand, ["--profile", this.profile, "--force"], this.env));
      if (/synced/i.test(output)) await this.stop("signed-in", "Signed in. Video Pilot now uses your YouTube account.");
    } catch {}
  }

  async screenshot() {
    if (!this.active) throw new Error("No sign-in is open.");
    await this.exec("scrot", ["-o", "-q", "70", this.shot], this.env);
    return readFile(this.shot);
  }

  async input({ type, x, y, text, key }) {
    if (!this.active) throw new Error("No sign-in is open.");
    if (type === "click") {
      const px = Math.round(Number(x)), py = Math.round(Number(y));
      if (!(px >= 0 && px < SCREEN.width && py >= 0 && py < SCREEN.height)) throw new Error("Tap is outside the sign-in screen.");
      await this.exec(this.xdotool, ["mousemove", String(px), String(py), "click", "1"], this.env);
    } else if (type === "text") {
      const value = String(text || "");
      if (!value || value.length > 256) throw new Error("Type up to 256 characters at a time.");
      await this.exec(this.xdotool, ["type", "--delay", "25", "--", value], this.env);
    } else if (type === "key") {
      if (!KEYS.has(key)) throw new Error("That key is not available.");
      await this.exec(this.xdotool, ["key", key], this.env);
    } else if (type === "scroll") {
      await this.exec(this.xdotool, ["click", Number(y) < 0 ? "4" : "5"], this.env);
    } else throw new Error("Unknown input.");
    return { ok: true };
  }

  async stop(state = "idle", message = "") {
    clearTimeout(this.deadline); clearInterval(this.watch);
    for (const child of this.processes.reverse()) { try { child.kill("SIGTERM"); } catch {} }
    this.processes = [];
    const wasActive = this.active;
    this.active = false; this.state = state; this.message = message;
    if (wasActive) {
      await new Promise(resolve => setTimeout(resolve, 500));
      await rm(this.profile, { recursive: true, force: true });
      await rm(this.shot, { force: true });
    }
    return this.status();
  }
}

async function body(req) {
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > 4096) throw new Error("Request is too large."); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export function createSignInServer(session, { port = 5002, host = "127.0.0.1" } = {}) {
  return http.createServer(async (req, res) => {
    const reply = (status, value, type = "application/json") => {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
      res.writeHead(status, { "content-type": type, "content-length": bytes.length, "cache-control": "no-store" }); res.end(bytes);
    };
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/status" && req.method === "GET") return reply(200, session.status());
      if (url.pathname === "/start" && req.method === "POST") return reply(200, await session.start());
      if (url.pathname === "/stop" && req.method === "POST") return reply(200, await session.stop("idle"));
      if (url.pathname === "/screen" && req.method === "GET") return reply(200, await session.screenshot(), "image/jpeg");
      if (url.pathname === "/input" && req.method === "POST") return reply(200, await session.input(await body(req)));
      return reply(404, { error: "Not found." });
    } catch (error) { reply(400, { error: String(error.message || error) }); }
  }).listen(port, host);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const session = new SignInSession();
  createSignInServer(session);
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => session.stop().finally(() => process.exit(0)));
  console.log("Video Pilot sign-in helper on 127.0.0.1:5002");
}
