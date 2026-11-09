import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LiveSession } from "../src/live-helper.mjs";

function fakes() {
  const calls = [], launched = [];
  const exec = async (file, args) => { calls.push([path.basename(file), ...args]); return Buffer.from(""); };
  const launch = (file, args) => { const child = { file, args, killed: false, kill() { this.killed = true; } }; launched.push(child); return child; };
  return { calls, launched, exec, launch };
}

test("Netflix opens in a kept Chromium profile with Widevine, and taps stay on screen", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "vp-live-"));
  const widevine = path.join(home, "WidevineCdm");
  await mkdir(widevine); await writeFile(path.join(widevine, "manifest.json"), "{}");
  const fake = fakes();
  const session = new LiveSession({ home, widevine, exec: fake.exec, launch: fake.launch, idleMs: 1e9 });
  await assert.rejects(session.start("disney"), /Netflix or Hulu/);
  await session.start("netflix");
  assert.deepEqual(fake.launched.map(child => path.basename(child.file)), ["Xvfb", "chromium"]);
  assert.ok(fake.launched[1].args.includes("https://www.netflix.com/browse"));
  assert.ok(!fake.launched[1].args.some(arg => arg.startsWith("--user-agent=")), "Netflix refuses a disguised user agent");
  assert.deepEqual(JSON.parse(await readFile(path.join(session.profile, "WidevineCdm/latest-component-updated-widevine-cdm"), "utf8")), { Path: widevine });
  assert.ok(fake.calls.some(call => call[0] === "pw-cli" && call[1] === "create-node"), "the capture sink is created");

  await session.input({ type: "click", x: 640.4, y: 100 });
  assert.deepEqual(fake.calls.at(-1).slice(1, 4), ["mousemove", "640", "100"]);
  await assert.rejects(session.input({ type: "click", x: 1280, y: 1 }), /outside/);
  await assert.rejects(session.input({ type: "key", key: "ctrl+w" }), /not available/);

  const encoder = session.stream();
  assert.equal(path.basename(encoder.file), "ffmpeg");
  assert.ok(encoder.args.includes("mpeg1video") && encoder.args.includes("video-pilot-live.monitor"));

  await session.start("hulu");
  assert.ok(encoder.killed && fake.launched[1].killed, "switching service replaces the browser and its stream");
  assert.equal(fake.launched.filter(child => path.basename(child.file) === "Xvfb").length, 1, "the screen is reused");
  session.stop();
  assert.equal(session.status().active, false);
  assert.ok(fake.launched.every(child => child.killed));
  await assert.rejects(session.input({ type: "key", key: "Return" }), /first/);
});
