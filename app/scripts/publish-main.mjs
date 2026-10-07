import { config } from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const appDir = path.resolve(import.meta.dirname, "..");
const projectDir = path.dirname(appDir);
config({ path: path.join(appDir, ".env"), quiet: true });
const rootEnv = config({ path: path.join(projectDir, ".env"), processEnv: {}, quiet: true }).parsed || {};
const workerUrl = rootEnv.TV_URL?.replace(/\/$/, "");
if (workerUrl !== "https://tv.jcruzhoovertesla.workers.dev" || !rootEnv.TV_SECRET) {
  throw new Error("Set the requested TV_URL and TV_SECRET in the root .env.");
}
const localDir = path.join(appDir, ".local");
const manifestPath = path.join(localDir, "main.json");
fs.mkdirSync(localDir, { recursive: true });
const old = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null;
const port = old ? old.port + 1 : 8080;
if (port > 65535) throw new Error("Production port range exhausted.");
const release = path.join(localDir, "releases", new Date().toISOString().replace(/[:.]/g, "-"));
fs.mkdirSync(release, { recursive: true });

function runNode(args, env = process.env) {
  const result = spawnSync(process.execPath, args, { cwd: appDir, env, stdio: "inherit", windowsHide: true });
  if (result.error || result.status !== 0) throw new Error("Release build failed; the current main version was left running.");
}
function background(exe, args, logName, env = process.env) {
  const out = fs.openSync(path.join(localDir, logName + ".log"), "a");
  const err = fs.openSync(path.join(localDir, logName + "-error.log"), "a");
  const child = spawn(exe, args, { cwd: appDir, env, detached: true, windowsHide: true, stdio: ["ignore", out, err] });
  child.unref();
  fs.closeSync(out);
  fs.closeSync(err);
  return child;
}
async function waitFor(url, test) {
  for (let attempt = 0; attempt < 45; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.ok && await test(response)) return;
    } catch {}
    await delay(1000);
  }
  throw new Error("Production endpoint did not become ready.");
}

console.log("[MK8] Building a production snapshot...");
const workerCheck = await fetch(workerUrl, { signal: AbortSignal.timeout(15000) });
if (workerCheck.status === 404) throw new Error("Cloudflare reports this Worker URL does not exist. Run the Cloudflare login and setup tasks first, or correct TV_URL.");
runNode(["scripts/ensure-database.mjs"]);
runNode(["node_modules/vite/bin/vite.js", "build", "--config", "client/vite.config.ts", "--outDir", path.join(release, "dist")], { ...process.env, VITE_API_URL: "" });
for (const folder of ["server", "shared", "drizzle"]) {
  fs.cpSync(path.join(appDir, folder), path.join(release, folder), { recursive: true });
}
fs.copyFileSync(path.join(appDir, "package.json"), path.join(release, "package.json"));

const cloudflared = [
  "C:/Program Files (x86)/cloudflared/cloudflared.exe",
  "C:/Program Files/cloudflared/cloudflared.exe",
  path.join(path.dirname(projectDir), ".tools", "cloudflared.exe"),
].find(file => fs.existsSync(file)) || "cloudflared.exe";
let server;
let tunnel;
let registered = false;
try {
  // Start the isolated release without a file watcher.
  server = background(process.execPath, ["--import", "tsx", path.join(release, "server/index.ts")], `main-${port}`, {
    ...process.env, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port), DIST_DIR: path.join(release, "dist"), RELEASE_ID: path.basename(release),
  });
  server.on("error", error => console.error("[server]", error.message));
  await waitFor(`http://127.0.0.1:${port}/`, async response => response.headers.get("X-MK8-Release") === path.basename(release) && !(await response.text()).includes("/@vite/client"));
  await waitFor(`http://127.0.0.1:${port}/auth`, async response => response.headers.get("X-MK8-Release") === path.basename(release) && (await response.text()).includes('<div id="root">'));
  await waitFor(`http://127.0.0.1:${port}/api/trpc/auth.me`, async () => true);
  const tunnelLog = `tunnel-${port}-${path.basename(release)}`;
  tunnel = background(cloudflared, ["tunnel", "--no-autoupdate", "--protocol", "http2", "--edge-ip-version", "4", "--url", `http://127.0.0.1:${port}`], tunnelLog);
  tunnel.on("error", error => console.error("[tunnel]", error.message));
  let target;
  for (let attempt = 0; attempt < 60; attempt++) {
    const log = fs.readFileSync(path.join(localDir, tunnelLog + "-error.log"), "utf8");
    target = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
    if (target && log.includes("Registered tunnel connection")) break;
    await delay(1000);
  }
  if (!target) throw new Error("Cloudflare tunnel failed to start; check app/.local/tunnel logs.");
  await waitFor(target, async response => response.headers.get("X-MK8-Release") === path.basename(release) && !(await response.text()).includes("/@vite/client"));
  const response = await fetch(workerUrl + "/__set", {
    method: "POST", headers: { "x-secret": rootEnv.TV_SECRET }, body: target, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok || (await response.text()).trim() !== "ok") throw new Error(`Worker rejected the tunnel update (HTTP ${response.status}). Check TV_SECRET in the root .env.`);
  registered = true;
  // Keep the prior server and tunnel available while Cloudflare KV caches expire.
  fs.writeFileSync(manifestPath, JSON.stringify({ port, release, serverPid: server.pid, tunnelPid: tunnel.pid, target, previous: old ? { port: old.port, release: old.release, serverPid: old.serverPid, tunnelPid: old.tunnelPid } : null }, null, 2));
  if (old) {
    background(process.execPath, ["scripts/retire-release.mjs", JSON.stringify({ port: old.port, release: old.release, serverPid: old.serverPid, tunnelPid: old.tunnelPid })], "release-cleanup");
  }
  console.log(`[MK8] Published production snapshot: ${workerUrl}`);
  console.log("[MK8] Local live editing remains at http://localhost:5173.");
  console.log("[MK8] This computer and its database must remain running.");
} catch (error) {
  if (!registered) {
    for (const child of [server, tunnel]) {
      if (child?.pid) spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    }
  }
  console.error("[MK8]", error.message);
  process.exitCode = 1;
}
