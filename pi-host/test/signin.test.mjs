import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SignInSession } from "../src/signin-helper.mjs";

function fakeSession(syncOutput = "Firefox is not signed in to YouTube.") {
  const calls = [], launched = [];
  const exec = async (file, args) => {
    calls.push([path.basename(file), ...args]);
    if (args[0] === "search") return Buffer.from("42\n");
    if (path.basename(file) === "youtube-cookie-sync") return Buffer.from(fake.syncOutput);
    return Buffer.from("");
  };
  const launch = (file, args) => { const child = { file, args, killed: false, kill() { this.killed = true; } }; launched.push(child); return child; };
  const fake = { calls, launched, exec, launch, syncOutput };
  return fake;
}

test("a car sign-in starts from an empty profile and is wiped once Google signs in", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "vp-signin-"));
  const fake = fakeSession();
  const session = new SignInSession({ home, exec: fake.exec, launch: fake.launch, pollMs: 1e9 });
  await session.start();
  assert.equal(session.status().active, true);
  assert.deepEqual(fake.launched.map(child => path.basename(child.file)), ["Xvfb", "firefox"]);
  assert.match(await readFile(path.join(session.profile, "user.js"), "utf8"), /signon.rememberSignons", false/);
  await session.check();
  assert.equal(session.state, "open", "the window is fitted to the virtual screen");
  assert.ok(fake.calls.some(call => call.includes("windowsize")));

  await session.input({ type: "click", x: 450.4, y: 451 });
  await session.input({ type: "text", text: "me@example.com" });
  await session.input({ type: "key", key: "Return" });
  assert.deepEqual(fake.calls.slice(-3).map(call => call.slice(1, 4)),
    [["mousemove", "450", "451"], ["type", "--delay", "25"], ["key", "Return"]]);
  await assert.rejects(session.input({ type: "click", x: 5000, y: 1 }), /outside/);
  await assert.rejects(session.input({ type: "key", key: "ctrl+w" }), /not available/);

  fake.syncOutput = "YouTube sign-in synced to Video Pilot.";
  await session.check();
  assert.equal(session.state, "signed-in");
  assert.equal(session.status().active, false);
  assert.ok(fake.launched.every(child => child.killed));
  await assert.rejects(stat(session.profile), "the signed-in profile is deleted");
  await assert.rejects(session.input({ type: "key", key: "Return" }), /No sign-in/);
});
