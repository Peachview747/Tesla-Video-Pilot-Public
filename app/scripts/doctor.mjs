import { spawnSync } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import { config } from "dotenv";
import postgres from "postgres";

const appDir = path.resolve(import.meta.dirname, "..");
config({ path: path.join(appDir, ".env"), quiet: true });
let failed = false;
function check(label, exe, args) {
  const result = spawnSync(exe, args, { encoding: "utf8", windowsHide: true });
  const ok = !result.error && result.status === 0;
  console.log(`${ok ? "OK" : "MISSING"}: ${label}${ok ? " — " + (result.stdout || result.stderr).trim().split(/\r?\n/)[0] : ""}`);
  if (!ok) failed = true;
}
check("Node.js", process.execPath, ["--version"]);
check("npm", process.execPath, [path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"), "--version"]);
check("Git", "git.exe", ["--version"]);
check("FFmpeg", "ffmpeg.exe", ["-version"]);
check("FFprobe", "ffprobe.exe", ["-version"]);
check("Deno", "deno.exe", ["--version"]);
const python = path.join(appDir, ".venv/Scripts/python.exe");
check("Python", python, ["--version"]);
check("Bot Python dependencies", python, ["-m", "pip", "check"]);
check("yt-dlp", python, ["-m", "yt_dlp", "--version"]);
check("Ruff", python, ["-m", "ruff", "--version"]);
check("TypeScript", process.execPath, [path.join(appDir, "node_modules/typescript/bin/tsc"), "--version"]);
check("Prettier", process.execPath, [path.join(appDir, "node_modules/prettier/bin/prettier.cjs"), "--version"]);
check("Vitest", process.execPath, [path.join(appDir, "node_modules/vitest/vitest.mjs"), "--version"]);
check("Playwright", process.execPath, [path.join(appDir, "node_modules/@playwright/test/cli.js"), "--version"]);
const cloudflared = ["C:/Program Files (x86)/cloudflared/cloudflared.exe", "C:/Program Files/cloudflared/cloudflared.exe"].find(existsSync) || "cloudflared.exe";
check("Cloudflared", cloudflared, ["--version"]);
try {
  const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 3 });
  try { await sql`SELECT 1`; console.log("OK: PostgreSQL connection"); }
  finally { await sql.end({ timeout: 1 }); }
} catch { console.log("UNAVAILABLE: PostgreSQL connection"); failed = true; }
for (const [label, url] of [["Local live editing", "http://localhost:5173"], ["Production site", "https://tv.jcruzhoovertesla.workers.dev"]]) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error();
    console.log(`OK: ${label} (HTTP ${response.status})`);
  } catch { console.log(`UNAVAILABLE: ${label}`); failed = true; }
}
process.exitCode = failed ? 1 : 0;
