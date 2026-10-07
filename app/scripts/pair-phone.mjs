import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import QRCode from "qrcode";

const appDir = path.resolve(import.meta.dirname, "..");
const workspaceDir = path.resolve(appDir, "../..");
const cli = path.join(workspaceDir, ".tools/codex/node_modules/@openai/codex/bin/codex.js");
const localDir = path.join(appDir, ".local");
if (!fs.existsSync(cli)) throw new Error("Install the packaged @openai/codex CLI in the workspace .tools/codex directory first.");

function remote(command) {
  const result = spawnSync(process.execPath, [cli, "remote-control", command, "--json"], {
    cwd: workspaceDir, encoding: "utf8", windowsHide: true, timeout: 120000,
  });
  if (result.error || result.status !== 0) throw new Error(result.stderr?.trim() || result.error?.message || "Codex remote control failed.");
  return JSON.parse(result.stdout.trim());
}

const host = remote("start");
if (host.status !== "connected") throw new Error("Codex remote control did not connect. Check your ChatGPT sign-in and network.");
const pairing = remote("pair");
if (!pairing.pairingCode || !Number.isFinite(pairing.expiresAt)) throw new Error("Codex returned an incomplete pairing code.");
// This is the URL format used by the installed Codex mobile setup dialog.
const url = new URL("https://chatgpt.com/codex/pair");
url.searchParams.set("pairing_code", pairing.pairingCode);
fs.mkdirSync(localDir, { recursive: true });
await QRCode.toFile(path.join(localDir, "codex-phone-qr.png"), url.toString(), {
  width: 600, margin: 4, errorCorrectionLevel: "M",
});
const expires = new Date(pairing.expiresAt * 1000).toLocaleString("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "short" });
const escape = value => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const hostName = host.serverName || "This PC";
fs.writeFileSync(path.join(localDir, "codex-phone-pairing.html"), `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect your phone to Codex</title>
<style>body{font-family:system-ui;background:#f4f5f7;color:#172026;max-width:680px;margin:40px auto;padding:24px;text-align:center}img{display:block;width:min(100%,480px);margin:auto}p{line-height:1.6}code{font-size:22px}</style>
<h1>Connect your phone to ${escape(hostName)}</h1>
<p>Scan this QR code with your phone and finish setup in ChatGPT using the same account and workspace.</p>
<img src="codex-phone-qr.png" alt="Codex phone pairing QR code">
<p><a href="${escape(url.toString())}">Open pairing link</a></p>
<p>Pairing code: <code>${escape(pairing.manualPairingCode)}</code><br>Expires ${escape(expires)}</p>
<p>After pairing, open Codex (or Remote) on your phone and choose ${escape(hostName)}. Keep this PC awake and online.</p>
<p>If the code expires, run the VS Code task <b>MK8: Pair phone with Codex</b> again.</p></html>`);
console.log(`Codex host: ${hostName}. Scan app/.local/codex-phone-qr.png to connect your phone.`);
console.log(`Pairing expires: ${expires}. Phone connection must still be completed in ChatGPT.`);
