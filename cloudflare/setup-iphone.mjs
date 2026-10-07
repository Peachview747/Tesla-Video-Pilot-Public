import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { parse } from "dotenv";

const directory = path.dirname(fileURLToPath(import.meta.url));
const publicURL = "https://tv.jcruzhoovertesla.workers.dev";

function runWrangler(args, env, input, capture = false) {
  const result = spawnSync(process.execPath, [path.join(directory, "node_modules/wrangler/bin/wrangler.js"), ...args], {
    cwd: directory, env, windowsHide: true, encoding: "utf8",
    ...(capture ? { stdio: ["ignore", "pipe", "pipe"] } : input !== undefined
      ? { input, stdio: ["pipe", "inherit", "inherit"] } : { stdio: "inherit" }),
  });
  if (result.error) throw new Error("Could not start Cloudflare setup. Install Node.js 22 or newer and run npm ci in this folder.");
  if (result.status !== 0 && !capture) throw new Error("Cloudflare setup failed. Check the Cloudflare account shown above and retry.");
  return result;
}

async function checkKey(secret) {
  const response = await fetch(publicURL + "/__iphone/status", {
    headers: { "x-secret": secret }, signal: AbortSignal.timeout(15000),
  });
  if (response.status === 401) return "rejected";
  let result;
  try { result = await response.json(); } catch { return "not-ready"; }
  return response.ok && result.protocol === "mk8-relay-v1" && result.configured ? "valid" : "not-ready";
}

async function main() {
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Install Node.js 22 or newer first: https://nodejs.org/");
  let folder = process.argv[2];
  if (!folder) {
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try { folder = await input.question("Paste the original MK8 folder path (the folder containing .env): "); }
    finally { input.close(); }
  }
  folder = path.resolve(folder.trim().replace(/^"(.*)"$/, "$1"));
  const envPath = path.join(folder, ".env");
  if (!fs.existsSync(envPath)) throw new Error("No .env file was found in that folder. Use the original MK8 project folder.");
  const settings = parse(fs.readFileSync(envPath));
  const secret = settings.TV_SECRET?.trim();
  if (!secret || secret.length > 512 || /[\r\n]/.test(secret)) throw new Error("The original .env must contain a single-line TV_SECRET value.");
  const config = JSON.parse(fs.readFileSync(path.join(directory, "wrangler.json"), "utf8"));
  if (settings.CLOUDFLARE_ACCOUNT_ID && settings.CLOUDFLARE_ACCOUNT_ID !== config.account_id)
    throw new Error("The .env Cloudflare account differs from the account that owns your existing TV URL.");
  const env = { ...process.env, WRANGLER_SEND_METRICS: "false",
    ...(settings.CLOUDFLARE_API_TOKEN ? { CLOUDFLARE_API_TOKEN: settings.CLOUDFLARE_API_TOKEN } : {}),
    CLOUDFLARE_ACCOUNT_ID: config.account_id };
  console.log("Checking Cloudflare sign-in. Your TV_SECRET will not be printed or added to GitHub.");
  const identity = runWrangler(["whoami"], env, undefined, true);
  if (identity.status !== 0 || /not authenticated|not logged in/i.test(identity.stdout + identity.stderr)) {
    console.log("Sign into the Cloudflare account that owns your existing TV URL in the browser.");
    runWrangler(["login"], env);
  }
  console.log("Deploying the iPhone connection to your existing tv Worker. Laptop fallback is retained.");
  runWrangler(["deploy"], env);

  let synchronized = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    let result;
    try { result = await checkKey(secret); } catch { result = "not-ready"; }
    if (result === "valid") {
      console.log("KEY TEST PASSED. Your existing TV_SECRET works; no new key is needed.");
      console.log("On the iPhone: Settings > Cloudflare tunnel > paste only the TV_SECRET value > Save tunnel key.");
      console.log("Then Start hosting. Wait for Connected and open " + publicURL + " in the Tesla browser.");
      return;
    }
    if (result === "rejected" && !synchronized) {
      console.log("The local TV_SECRET did not match Cloudflare. Synchronizing your existing local key.");
      runWrangler(["secret", "put", "SECRET"], env, secret + "\n");
      synchronized = true;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error("The deployed relay has not passed its key test. Check your Cloudflare deployment and rerun this setup before connecting the app.");
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
