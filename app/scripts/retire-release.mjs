import path from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

// Allow cached Worker destinations to keep reaching the prior release briefly.
await delay(120000);
const previous = JSON.parse(process.argv[2]);
const releasesDir = path.resolve(import.meta.dirname, "../.local/releases");
if (!path.resolve(previous.release).startsWith(releasesDir + path.sep)) throw new Error("Invalid release directory.");
for (const [pid, expected] of [
  [previous.serverPid, path.join(previous.release, "server/index.ts")],
  [previous.tunnelPid, `http://127.0.0.1:${previous.port}`],
]) {
  if (!Number.isInteger(pid) || pid <= 0) continue;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object CommandLine | ConvertTo-Json -Compress`], { encoding: "utf8", windowsHide: true });
  const processInfo = result.stdout.trim() ? JSON.parse(result.stdout) : null;
  if (processInfo?.CommandLine?.includes(expected)) {
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  }
}
