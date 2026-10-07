import "dotenv/config";
import postgres from "postgres";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const appDir = path.resolve(import.meta.dirname, "..");
async function ready() {
  const client = postgres(process.env.DATABASE_URL, { connect_timeout: 2, max: 1 });
  try { await client`SELECT 1`; return true; }
  catch (error) { if (error.code !== "ECONNREFUSED") throw error; return false; }
  finally { await client.end({ timeout: 1 }); }
}
if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL in app/.env.");
if (!await ready()) {
  const url = new URL(process.env.DATABASE_URL);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Configured database is unavailable.");
  const localDir = path.join(appDir, ".local");
  fs.mkdirSync(localDir, { recursive: true });
  const out = fs.openSync(path.join(localDir, "database.log"), "a");
  const err = fs.openSync(path.join(localDir, "database-error.log"), "a");
  const child = spawn(process.execPath, ["scripts/dev-local.mjs", "--database-only"], {
    cwd: appDir, detached: true, windowsHide: true, stdio: ["ignore", out, err],
  });
  child.unref();
  fs.closeSync(out);
  fs.closeSync(err);
  fs.writeFileSync(path.join(localDir, "database.pid"), String(child.pid));
  let connected = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await ready()) { connected = true; break; }
    await delay(1000);
  }
  if (!connected) throw new Error("Database did not start. Check app/.local/database-error.log.");
}
console.log("[MK8] Database ready; it stays running when editing servers stop.");
