// Trusted browsers for the public HTTPS address: a second lock in front of
// the PIN. A browser is let in once (enrolled) and gets a long random pass in
// a cookie; on the public port a request without a known pass is dropped
// before anything is served, so a stranger never even sees the PIN screen.
// New browsers can enroll only while a short window is open, opened from
// Pi Health by an already-unlocked visit (or from the Pi itself). Until the
// first browser enrolls the gate is off, so that first one can get in.
// Only hashes of the passes are stored.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const COOKIE = "vp_pass";
const COOKIE_MAX_AGE = 400 * 24 * 60 * 60;   // browsers cap cookies at 400 days
const WINDOW_MAX_MS = 30 * 60_000, SEEN_SAVE_MS = 10 * 60_000, REFRESH_MS = 7 * 24 * 60 * 60_000;
const hash = pass => createHash("sha256").update(String(pass)).digest("hex");
// Recovery keys: 20 letters and digits in groups of five, easy to write down
// (no 0/O or 1/I). About 100 bits, so they cannot be guessed.
const KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const normalizeKey = key => String(key || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
function newKey() {
  const bytes = randomBytes(20);
  return [...bytes].map(byte => KEY_ALPHABET[byte % 32]).join("").match(/.{5}/g).join("-");
}

export function readPass(cookieHeader = "") {
  for (const part of String(cookieHeader).split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=");
  }
  return "";
}
export const passCookie = pass => `${COOKIE}=${pass}; Max-Age=${COOKIE_MAX_AGE}; Path=/; Secure; HttpOnly; SameSite=Lax`;

export class DeviceGate {
  constructor({ dataDir, file = "device-gate.json", now = () => Date.now() } = {}) {
    this.file = path.join(dataDir, file);
    this.now = now;
    this.state = { enforced: false, devices: [], windowUntil: 0, recoveryHash: "", recoveryMade: 0 };
    this.lastSeenSave = 0;
  }
  async load() {
    try { this.state = { ...this.state, ...JSON.parse(await readFile(this.file, "utf8")) }; } catch {}
    return this;
  }
  // One save at a time (a "last seen" save can overlap a change).
  save() {
    const write = async () => {
      const temp = `${this.file}.tmp`;
      await writeFile(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      await rename(temp, this.file);
    };
    this.saving = (this.saving || Promise.resolve()).then(write, write);
    return this.saving;
  }
  windowOpen() { return this.state.windowUntil > this.now(); }
  device(pass) {
    if (!pass || pass.length < 40) return null;
    const wanted = hash(pass);
    return this.state.devices.find(device => device.hash === wanted) || null;
  }
  // Whether a public-port request may go on. Marks the browser as seen, and
  // says when its cookie should be sent again (so it never reaches 400 days).
  check(cookieHeader) {
    const device = this.device(readPass(cookieHeader));
    if (device) {
      const now = this.now(), refresh = now - (device.refreshed || 0) > REFRESH_MS;
      device.lastSeen = now;
      if (refresh) device.refreshed = now;
      if (refresh || now - this.lastSeenSave > SEEN_SAVE_MS) { this.lastSeenSave = now; this.save().catch(() => {}); }
      return { allowed: true, device, refresh: refresh ? readPass(cookieHeader) : null };
    }
    return { allowed: !this.state.enforced || this.windowOpen(), device: null, refresh: null };
  }
  async openWindow(minutes = 10) {
    const ms = Math.min(WINDOW_MAX_MS, Math.max(60_000, Number(minutes) * 60_000 || 600_000));
    this.state.windowUntil = this.now() + ms; await this.save();
    return this.status();
  }
  async closeWindow() { this.state.windowUntil = 0; await this.save(); return this.status(); }
  // Enroll the browser making the request. Allowed while the gate is still
  // off (the first browser) or while the window is open; closes the window.
  async enroll(name, cookieHeader) {
    if (this.device(readPass(cookieHeader))) { const error = new Error("This browser is already trusted."); error.status = 409; throw error; }
    if (this.state.enforced && !this.windowOpen()) { const error = new Error("Adding browsers is closed. Open it from Pi Health on a trusted browser."); error.status = 403; throw error; }
    const pass = randomBytes(32).toString("base64url"), now = this.now();
    const device = { id: randomUUID(), hash: hash(pass), name: String(name || "Browser").slice(0, 40), added: now, lastSeen: now, refreshed: now };
    this.state.devices.push(device);
    this.state.enforced = true; this.state.windowUntil = 0;
    await this.save();
    return { pass, device: view(device) };
  }
  // A new recovery key replaces the old one; it is shown once and only its
  // hash is kept.
  async makeRecoveryKey() {
    const key = newKey();
    this.state.recoveryHash = hash(normalizeKey(key)); this.state.recoveryMade = this.now();
    await this.save();
    return key;
  }
  // The right key opens the window for a new browser and is used up; a fresh
  // key is made and returned so the owner always holds one.
  async recover(key) {
    const given = normalizeKey(key);
    if (!this.state.recoveryHash || given.length !== 20 || hash(given) !== this.state.recoveryHash) return null;
    this.state.windowUntil = this.now() + 10 * 60_000;
    return { next: await this.makeRecoveryKey(), windowUntil: this.state.windowUntil };
  }
  async remove(id) {
    const before = this.state.devices.length;
    this.state.devices = this.state.devices.filter(device => device.id !== id);
    if (this.state.devices.length === before) { const error = new Error("That browser is not on the list."); error.status = 404; throw error; }
    await this.save(); return this.status();
  }
  async rename(id, name) {
    const device = this.state.devices.find(item => item.id === id);
    if (!device) { const error = new Error("That browser is not on the list."); error.status = 404; throw error; }
    device.name = String(name || device.name).slice(0, 40); await this.save(); return this.status();
  }
  status(current = null) {
    return { enforced: this.state.enforced, windowUntil: this.windowOpen() ? this.state.windowUntil : 0,
      recoveryMade: this.state.recoveryHash ? this.state.recoveryMade : 0,
      devices: this.state.devices.map(device => ({ ...view(device), current: current?.id === device.id })) };
  }
}
const view = ({ id, name, added, lastSeen }) => ({ id, name, added, lastSeen });
