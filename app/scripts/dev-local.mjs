import "dotenv/config";
import EmbeddedPostgres from "embedded-postgres";
import postgres from "postgres";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const appDir = path.resolve(import.meta.dirname, "..");
process.chdir(appDir);
const children = [];
let database;
let stopping = false;

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null || !child.pid) continue;
    if (process.platform === "win32") {
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else child.kill();
  }
  if (database) await database.stop();
  process.exit(code);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

function run(args, cwd = appDir) {
  const child = spawn(process.execPath, args, { cwd, stdio: "inherit", windowsHide: true });
  children.push(child);
  return child;
}

try {
  if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL in app/.env first.");
  const url = new URL(process.env.DATABASE_URL);
  const probe = postgres(process.env.DATABASE_URL, { connect_timeout: 3, max: 1 });
  let reachable = false;
  try {
    await probe`SELECT 1`;
    reachable = true;
  } catch (error) {
    if (error.code !== "ECONNREFUSED") throw error;
  } finally {
    await probe.end({ timeout: 1 });
  }

  if (!reachable) {
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      throw new Error("Configured database is unavailable. Local startup only provisions a loopback database.");
    }
    const databaseDir = path.join(appDir, ".local", "postgres");
    database = new EmbeddedPostgres({
      databaseDir,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      port: Number(url.port || 5432),
      persistent: true,
      postgresFlags: ["-h", "127.0.0.1,::1"],
      onLog: () => {},
      onError: (message) => console.error("[database]", message),
    });
    if (!existsSync(path.join(databaseDir, "PG_VERSION"))) await database.initialise();
    await database.start();
    const name = decodeURIComponent(url.pathname.slice(1));
    const client = database.getPgClient();
    await client.connect();
    const result = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    await client.end();
    if (!result.rowCount) {
      await database.createDatabase(name);
      const migration = run(["node_modules/drizzle-kit/bin.cjs", "push", "--force"]);
      const code = await new Promise((resolve, reject) => {
        migration.once("error", reject);
        migration.once("exit", resolve);
      });
      if (code !== 0) throw new Error("Development database schema setup failed.");
    }
    console.log("[MK8] Local PostgreSQL ready; data persists in app/.local/postgres.");
  } else {
    console.log("[MK8] Using the configured running database.");
  }

  if (process.argv.includes("--database-only")) {
    console.log("[MK8] Database service ready.");
    setInterval(() => {}, 60000);
  } else for (const child of [
    run(["--import", "tsx", "--watch", "server/index.ts"]),
    run([path.join(appDir, "node_modules/vite/bin/vite.js")], path.join(appDir, "client")),
  ]) {
    child.once("error", (error) => { console.error(error.message); void stop(1); });
    child.once("exit", (code) => { if (!stopping) void stop(code || 1); });
  }
  if (!process.argv.includes("--database-only")) console.log("[MK8] Live editing: http://localhost:5173. Press Ctrl+C to stop.");
} catch (error) {
  console.error("[MK8]", error.message);
  await stop(1);
}
