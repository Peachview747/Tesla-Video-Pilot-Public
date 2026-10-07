import { config } from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const appDir = path.resolve(import.meta.dirname, "..");
const workerDir = path.resolve(appDir, "../cloudflare");
const settings = config({ path: path.resolve(appDir, "../.env"), processEnv: {}, quiet: true }).parsed || {};
if (!settings.TV_SECRET) throw new Error("Set TV_SECRET in the root .env first.");
function wrangler(args, input) {
  const result = spawnSync(process.execPath, [path.join(appDir, "node_modules/wrangler/bin/wrangler.js"), ...args], {
    cwd: workerDir, windowsHide: true, env: { ...process.env, WRANGLER_SEND_METRICS: "false", ...(settings.CLOUDFLARE_API_TOKEN ? { CLOUDFLARE_API_TOKEN: settings.CLOUDFLARE_API_TOKEN } : {}), ...(settings.CLOUDFLARE_ACCOUNT_ID ? { CLOUDFLARE_ACCOUNT_ID: settings.CLOUDFLARE_ACCOUNT_ID } : {}) },
    ...(input ? { input, stdio: ["pipe", "inherit", "inherit"] } : { stdio: "inherit" }),
  });
  if (result.error || result.status !== 0) throw new Error("Cloudflare setup failed. Sign in with the Cloudflare login task and check the account.");
}
const workerConfig = JSON.parse(fs.readFileSync(path.join(workerDir, "wrangler.json"), "utf8"));
if (!workerConfig.kv_namespaces?.some(binding => binding.binding === "KV" && binding.id)) {
  wrangler(["kv", "namespace", "create", "MK8_TV_TARGET", "--binding", "KV", "--update-config"]);
}
wrangler(["deploy"]);
// Pass the secret on stdin rather than in the command line or a generated file.
wrangler(["secret", "put", "SECRET"], settings.TV_SECRET + "\n");
console.log("[MK8] Worker configured. Now run MK8: Push to main URL.");
