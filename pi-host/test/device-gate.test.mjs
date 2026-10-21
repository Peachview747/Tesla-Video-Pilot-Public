import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DeviceGate, readPass } from "../src/device-gate.mjs";
import { PinLock } from "../src/pin-lock.mjs";
import { createVideoPilotServer } from "../src/server.mjs";

const dir = () => mkdtemp(path.join(os.tmpdir(), "vp-gate-"));

test("the gate is off until the first browser is trusted, then only trusted passes get in", async () => {
  const clock = { now: 1_000_000 };
  const gate = await new DeviceGate({ dataDir: await dir(), now: () => clock.now }).load();
  assert.equal(gate.check("").allowed, true, "off at first so the first browser can reach the PIN");
  const { pass, device } = await gate.enroll("Tesla", "");
  assert.equal(device.name, "Tesla");
  assert.equal(gate.check("").allowed, false);
  assert.equal(gate.check(`a=1; vp_pass=${pass}`).allowed, true);
  assert.equal(gate.check(`vp_pass=${pass}x`).allowed, false);
  await assert.rejects(gate.enroll("Phone", ""), error => error.status === 403, "adding is closed after the first");
  await gate.openWindow(10);
  assert.equal(gate.check("").allowed, true, "the window lets a new browser reach the PIN");
  const phone = await gate.enroll("Phone", "");
  assert.equal(gate.windowOpen(), false, "enrolling closes the window");
  await gate.openWindow(10); clock.now += 11 * 60_000;
  assert.equal(gate.check("").allowed, false, "the window times out");
  await gate.remove(phone.device.id);
  assert.equal(gate.check(`vp_pass=${phone.pass}`).allowed, false, "a removed browser is out");
  assert.equal(gate.check(`vp_pass=${pass}`).allowed, true);
});

test("only hashes are stored, and the state survives a restart", async () => {
  const dataDir = await dir();
  const gate = await new DeviceGate({ dataDir }).load();
  const { pass } = await gate.enroll("Tesla", "");
  const saved = await readFile(path.join(dataDir, "device-gate.json"), "utf8");
  assert.doesNotMatch(saved, new RegExp(pass));
  const again = await new DeviceGate({ dataDir }).load();
  assert.equal(again.check(`vp_pass=${pass}`).allowed, true);
  assert.equal(again.check("").allowed, false);
  assert.equal(readPass("x=1; vp_pass=abc=; y=2"), "abc=");
});

test("on the public port an untrusted browser gets nothing; enrolling needs the PIN and sets the cookie", async t => {
  const dataDir = await dir();
  const pin = await new PinLock({ dataDir }).load();
  await pin.configure({ pin: "135790", question: "q?", answer: "a" });
  const gate = await new DeviceGate({ dataDir }).load();
  const library = { queueView: () => ({ items: [] }) };
  const root = path.resolve(import.meta.dirname, "../..");
  const host = createVideoPilotServer({ library, webRoot: path.join(root, "ios/Web"), port: 0, publicPort: 0, pinLock: pin, gate });
  await host.start(); t.after(() => host.stop());
  const local = `http://127.0.0.1:${host.server.address().port}`, outside = `http://127.0.0.1:${host.publicServer.address().port}`;
  const unlock = async () => (await (await fetch(outside + "/api/pin/unlock", { method: "POST", body: JSON.stringify({ pin: "135790" }) })).json()).key;

  assert.equal((await fetch(outside + "/")).status, 200, "gate off: the page loads");
  assert.equal((await fetch(outside + "/api/gate/enroll", { method: "POST", body: "{}" })).status, 401, "enrolling needs the PIN");
  const key = await unlock();
  const enrolled = await fetch(outside + "/api/gate/enroll", { method: "POST", headers: { "x-vp-device": key }, body: JSON.stringify({ name: "Tesla" }) });
  assert.equal(enrolled.status, 200);
  const cookie = enrolled.headers.get("set-cookie");
  assert.match(cookie, /^vp_pass=[\w-]{43}; Max-Age=\d+; Path=\/; Secure; HttpOnly; SameSite=Lax$/);
  const pass = cookie.split(";")[0];

  const stranger = await fetch(outside + "/");
  assert.equal(stranger.status, 404); assert.equal(stranger.headers.get("x-gate"), "deny");
  assert.equal((await fetch(outside + "/api/pin/unlock", { method: "POST", body: JSON.stringify({ pin: "135790" }) })).headers.get("x-gate"), "deny", "not even the PIN check");
  assert.equal((await fetch(outside + "/", { headers: { cookie: pass } })).status, 200, "the trusted browser loads the page");
  assert.equal((await fetch(outside + "/api/queue", { headers: { cookie: pass } })).status, 401, "and still needs the PIN");
  assert.equal((await fetch(outside + "/api/queue", { headers: { cookie: pass, "x-vp-device": key } })).status, 200);
  const status = await (await fetch(outside + "/api/gate", { headers: { cookie: pass, "x-vp-device": key } })).json();
  assert.deepEqual([status.enforced, status.here, status.devices.map(d => [d.name, d.current])], [true, "trusted", [["Tesla", true]]]);

  assert.equal((await fetch(local + "/api/queue")).status, 200, "the Pi itself is unaffected");
  assert.equal((await fetch(local + "/api/gate/enroll", { method: "POST", body: "{}" })).status, 400, "enrolling only happens on the public address");
  await fetch(local + "/api/gate/open", { method: "POST", body: JSON.stringify({ minutes: 10 }) });
  assert.equal((await fetch(outside + "/")).status, 200, "an open window lets a new browser reach the PIN");
});
