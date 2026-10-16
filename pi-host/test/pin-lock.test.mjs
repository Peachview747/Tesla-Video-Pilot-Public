import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PinLock, deviceName } from "../src/pin-lock.mjs";
import { createVideoPilotServer } from "../src/server.mjs";

const TESLA = "Mozilla/5.0 (X11; GNU/Linux) AppleWebKit/537.36 (KHTML, like Gecko) Chromium/136.0 Chrome/136.0 Safari/537.36 Tesla/2026.32";
async function lock(clock = { now: 1_000_000 }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vp-pin-"));
  const pin = await new PinLock({ dataDir: dir, now: () => clock.now }).load();
  await pin.configure({ pin: "849590", question: "What is my old dog's name?", answer: "Olive" });
  return { pin, dir, clock };
}

test("a plain-text PIN from the old build is hashed on load", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vp-pin-"));
  await writeFile(path.join(dir, "pin-lock.json"), JSON.stringify({ pin: "849590", devices: {}, lockouts: {} }));
  const pin = await new PinLock({ dataDir: dir }).load();
  const saved = await readFile(path.join(dir, "pin-lock.json"), "utf8");
  assert.doesNotMatch(saved, /849590/);
  assert.ok((await pin.unlock("849590", TESLA)).key);
});

test("the right PIN trusts a device; its key opens every later request", async () => {
  const { pin } = await lock();
  assert.equal(pin.allows(""), false);
  const { key } = await pin.unlock("849590", TESLA);
  assert.equal(pin.allows(key), true);
  assert.equal(pin.allows(key + "x"), false);
  const list = await pin.devices("849590", key);
  assert.deepEqual(list.map(device => [device.name, device.current]), [["Tesla", true]]);
  assert.equal(deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"), "iPhone");
});

test("wrong PINs lock everyone out for a growing time, whatever the browser claims", async () => {
  const { pin, clock } = await lock();
  for (let i = 1; i <= 4; i++) await assert.rejects(pin.unlock("000000", TESLA), /Wrong PIN/);
  await assert.rejects(pin.unlock("000000", TESLA), error => error.status === 429 && /1 minute|60 seconds/.test(error.message));
  await assert.rejects(pin.unlock("849590", TESLA), /Too many/, "even the right PIN waits out the lockout");
  clock.now += 61_000;
  await assert.rejects(pin.unlock("111111", TESLA), /2 minutes|120 seconds/, "each lockout doubles");
  clock.now += 121_000;
  assert.ok((await pin.unlock("849590", TESLA)).key, "the right PIN works after the wait and clears the count");
  await assert.rejects(pin.unlock("000000", TESLA), /4 tries/);
});

test("guesses sent all at once still hit the lockout", async () => {
  const { pin } = await lock();
  const guesses = Array.from({ length: 12 }, (_, i) => pin.unlock(String(100000 + i), TESLA).then(() => "unlocked", error => error.status));
  const results = await Promise.all(guesses);
  assert.deepEqual(results.filter(status => status === 403).length, 4, "four wrong tries are free");
  assert.ok(results.slice(5).every(status => status === 429), "everything after the fifth is locked out");
});

test("the reset answer ignores case, sets a new PIN and signs every device out", async () => {
  const { pin } = await lock();
  const old = (await pin.unlock("849590", TESLA)).key;
  await assert.rejects(pin.reset("Rex", "1234", TESLA), /not the answer/);
  await assert.rejects(pin.reset("olive", "12", TESLA), /4 to 8 digits/);
  const { key } = await pin.reset("  oLiVe ", "2468", TESLA);
  assert.equal(pin.allows(old), false);
  assert.equal(pin.allows(key), true);
  await assert.rejects(pin.unlock("849590", TESLA), /Wrong PIN/);
  assert.ok((await pin.unlock("2468", TESLA)).key);
});

test("changing the PIN signs others out; removing a device forces it to enter the PIN again", async () => {
  const { pin } = await lock();
  const phone = (await pin.unlock("849590", "iPhone")).key;
  const car = (await pin.unlock("849590", TESLA)).key;
  const phoneId = (await pin.devices("849590", car)).find(device => device.name === "iPhone").id;
  assert.deepEqual(await pin.removeDevice("849590", phoneId), { removed: true });
  assert.equal(pin.allows(phone), false);
  assert.equal(pin.allows(car), true);
  const { key } = await pin.changePin("849590", "135790", TESLA);
  assert.equal(pin.allows(car), false);
  assert.equal(pin.allows(key), true);
  await assert.rejects(pin.devices("849590", key), /Wrong PIN/, "the device list always needs the PIN");
});

test("the server locks relayed requests, not the Pi itself or the page", async t => {
  const { pin } = await lock();
  const library = { queueView: () => ({ items: [] }) };
  const root = path.resolve(import.meta.dirname, "../..");
  const host = createVideoPilotServer({ library, webRoot: path.join(root, "ios/Web"), port: 0, pinLock: pin });
  await host.start(); t.after(() => host.stop());
  const origin = `http://127.0.0.1:${host.server.address().port}`;
  const relay = { "x-video-pilot-relay": "1" };
  assert.equal((await fetch(origin + "/", { headers: relay })).status, 200, "the page loads, then asks for the PIN");
  assert.equal((await fetch(origin + "/api/queue")).status, 200, "the Pi itself is not locked");
  const locked = await fetch(origin + "/api/queue", { headers: relay });
  assert.equal(locked.status, 401);
  assert.equal((await locked.json()).pinRequired, true);
  assert.equal((await fetch(origin + "/api/live/stream.ts", { headers: relay })).status, 401, "Netflix and Hulu too");
  const status = await (await fetch(origin + "/api/pin/status", { headers: relay })).json();
  assert.deepEqual([status.enabled, status.unlocked, status.question], [true, false, "What is my old dog's name?"]);
  const wrong = await fetch(origin + "/api/pin/unlock", { method: "POST", headers: relay, body: JSON.stringify({ pin: "1" }) });
  assert.equal(wrong.status, 403);
  const { key } = await (await fetch(origin + "/api/pin/unlock", { method: "POST", headers: { ...relay, "user-agent": TESLA }, body: JSON.stringify({ pin: "849590" }) })).json();
  assert.equal((await fetch(origin + "/api/queue", { headers: { ...relay, "x-vp-device": key } })).status, 200);
});
