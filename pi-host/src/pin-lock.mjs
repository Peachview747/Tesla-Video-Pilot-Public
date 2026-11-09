// PIN lock for everything the car reaches through the relay: YouTube,
// Netflix, Hulu, Claude and Pi Health. The Pi itself (requests that did not
// come through the relay) is never locked. A browser that enters the PIN gets
// a random key for that visit, kept in the tab and sent on every request (the
// relay cannot carry cookies, and a MAC address never reaches the Pi through
// Cloudflare). Only hashes of the PIN, the reset answer and the keys are
// stored. Wrong guesses lock everyone out for a growing time, so the PIN
// cannot be worked out by trying; the lockout is shared, not per browser,
// because a browser can claim to be anyone.
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
// Wrong guesses are counted per visitor (5 free, then a growing lockout for
// that visitor only) and across everyone (a generous backstop), so a stranger
// guessing from the internet is shut out without locking the owner out.
const VISITOR_FREE = 5, GLOBAL_FREE = { pin: 30, answer: 10 }, MAX_VISITORS = 2000;
const MAX_LOCK_MS = 60 * 60_000;
const SEEN_SAVE_MS = 10 * 60_000;
// An unlock lasts one visit: it ends after 30 minutes with no requests (a
// playing video keeps polling, so it counts as use) and after 12 hours at most.
export const IDLE_MS = 30 * 60_000, MAX_MS = 12 * 60 * 60_000;

// Who is guessing, for the limits above: an IPv4 address, or an IPv6 /64 (one
// home or phone owns millions of addresses in its /64).
export function visitorKey(ip) {
  const text = String(ip || "").trim().toLowerCase().replace(/^::ffff:/, "");
  if (!text) return "unknown";
  if (!text.includes(":")) return text;
  const [head, tail = ""] = text.split("::");
  const a = head ? head.split(":") : [], b = tail ? tail.split(":") : [];
  const groups = text.includes("::") ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill("0"), ...b] : a;
  return groups.slice(0, 4).map(group => group.padStart(4, "0")).join(":") + "::/64";
}

export const validPin = pin => typeof pin === "string" && /^\d{4,8}$/.test(pin);
const normalizeAnswer = answer => String(answer || "").trim().toLowerCase().replace(/\s+/g, " ");
const keyHash = key => createHash("sha256").update(String(key)).digest("hex");

async function hashSecret(secret) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(secret, salt, 32);
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

async function matches(secret, stored) {
  const [kind, salt, hash] = String(stored || "").split(":");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const actual = await scryptAsync(secret, Buffer.from(salt, "hex"), 32);
  return timingSafeEqual(actual, Buffer.from(hash, "hex"));
}

// "Tesla", "iPhone" and so on, from the browser's user agent.
export function deviceName(userAgent = "") {
  const ua = String(userAgent);
  if (/Tesla/i.test(ua)) return "Tesla";
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return "Android";
  if (/Macintosh/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows";
  if (/CrOS/i.test(ua)) return "Chromebook";
  if (/Linux/i.test(ua)) return "Linux";
  return "Browser";
}

export class PinLock {
  constructor({ dataDir, file = "pin-lock.json", now = () => Date.now() } = {}) {
    this.file = path.join(dataDir, file);
    this.now = now;
    this.state = { pinHash: "", question: "", answerHash: "", devices: [], pinFailures: 0, pinLockedUntil: 0, answerFailures: 0, answerLockedUntil: 0 };
    this.lastSeenSave = 0;
    this.checking = Promise.resolve();
    this.visitors = new Map();
  }

  get enabled() { return Boolean(this.state.pinHash); }

  async load() {
    let saved = {};
    try { saved = JSON.parse(await readFile(this.file, "utf8")); } catch {}
    this.state = { ...this.state, ...saved, devices: Array.isArray(saved.devices) ? saved.devices : [] };
    // An older build kept the PIN in plain text; hash it.
    if (typeof saved.pin === "string" && validPin(saved.pin) && !this.state.pinHash) this.state.pinHash = await hashSecret(saved.pin);
    this.expire();
    if ("pin" in this.state || "lockouts" in this.state || "backup" in this.state) {
      delete this.state.pin; delete this.state.lockouts; delete this.state.backup;
      await this.save();
    }
    return this;
  }

  async save() {
    const temp = `${this.file}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    await rename(temp, this.file);
  }

  async configure({ pin, question, answer }) {
    if (!validPin(pin)) throw new Error("The PIN must be 4 to 8 digits.");
    this.state.pinHash = await hashSecret(pin);
    if (question && answer) { this.state.question = String(question); this.state.answerHash = await hashSecret(normalizeAnswer(answer)); }
    this.state.devices = [];
    this.state.pinFailures = 0; this.state.pinLockedUntil = 0; this.state.answerFailures = 0; this.state.answerLockedUntil = 0;
    await this.save();
  }

  // The device behind a key, or null. Expired unlocks are forgotten.
  device(key) {
    if (!key) return null;
    this.expire();
    const hash = keyHash(key);
    return this.state.devices.find(device => device.keyHash === hash) || null;
  }

  expire() {
    const now = this.now(), before = this.state.devices.length;
    this.state.devices = this.state.devices.filter(device =>
      now - (device.lastSeen || device.addedAt || 0) < IDLE_MS && now - (device.addedAt || 0) < MAX_MS);
    if (this.state.devices.length !== before) void this.save().catch(() => {});
  }

  // Every request from the relay comes through here.
  allows(key) {
    if (!this.enabled) return true;
    const device = this.device(key);
    if (!device) return false;
    device.lastSeen = this.now();
    if (this.now() - this.lastSeenSave > SEEN_SAVE_MS) { this.lastSeenSave = this.now(); void this.save().catch(() => {}); }
    return true;
  }

  status(key) {
    return { enabled: this.enabled, unlocked: !this.enabled || Boolean(this.device(key)), question: this.state.question || "",
      lockedForSeconds: Math.max(0, Math.ceil((this.state.pinLockedUntil - this.now()) / 1000)) };
  }

  lockError(until) {
    const seconds = Math.ceil((until - this.now()) / 1000);
    const wait = seconds >= 120 ? `${Math.ceil(seconds / 60)} minutes` : `${seconds} seconds`;
    const error = new Error(`Too many wrong tries. Try again in ${wait}.`);
    error.status = 429;
    return error;
  }

  // Checks a guess against the PIN or the reset answer. Each visitor gets
  // VISITOR_FREE wrong guesses, then a lockout of 1 minute doubling up to an
  // hour; everyone together gets GLOBAL_FREE before a shared lockout.
  // One guess at a time: guesses sent together would all pass the lockout
  // check before any of them counted.
  verify(kind, guess, who = "local") {
    const check = this.checking.then(() => this.verifyOne(kind, guess, who));
    this.checking = check.catch(() => {});
    return check;
  }

  visitor(who, kind) {
    const now = this.now(), key = `${kind}:${who}`;
    let entry = this.visitors.get(key);
    if (!entry) {
      if (this.visitors.size >= MAX_VISITORS) {
        for (const [k, v] of this.visitors) if (v.lockedUntil < now && now - v.at > MAX_LOCK_MS) this.visitors.delete(k);
        if (this.visitors.size >= MAX_VISITORS) for (const k of [...this.visitors.keys()].slice(0, MAX_VISITORS / 4)) this.visitors.delete(k);
      }
      entry = { failures: 0, lockedUntil: 0, at: now }; this.visitors.set(key, entry);
    } else if (entry.lockedUntil < now && now - entry.at > MAX_LOCK_MS) entry.failures = 0;
    return entry;
  }

  async verifyOne(kind, guess, who) {
    const failures = `${kind}Failures`, lockedUntil = `${kind}LockedUntil`, visitor = this.visitor(who, kind);
    if (visitor.lockedUntil > this.now()) throw this.lockError(visitor.lockedUntil);
    if (this.state[lockedUntil] > this.now()) throw this.lockError(this.state[lockedUntil]);
    const stored = kind === "pin" ? this.state.pinHash : this.state.answerHash;
    const ok = kind === "pin" ? validPin(guess) && await matches(guess, stored) : await matches(normalizeAnswer(guess), stored);
    if (ok) {
      visitor.failures = 0; visitor.lockedUntil = 0;
      if (this.state[failures]) { this.state[failures] = 0; this.state[lockedUntil] = 0; await this.save(); }
      return;
    }
    visitor.failures += 1; visitor.at = this.now();
    const visitorOver = visitor.failures - VISITOR_FREE;
    if (visitorOver >= 0) visitor.lockedUntil = this.now() + Math.min(MAX_LOCK_MS, 60_000 * 2 ** visitorOver);
    this.state[failures] += 1;
    const over = this.state[failures] - GLOBAL_FREE[kind];
    if (over >= 0) this.state[lockedUntil] = this.now() + Math.min(MAX_LOCK_MS, 60_000 * 2 ** over);
    await this.save();
    if (visitorOver >= 0) throw this.lockError(visitor.lockedUntil);
    if (over >= 0) throw this.lockError(this.state[lockedUntil]);
    const left = VISITOR_FREE - visitor.failures;
    const error = new Error(kind === "pin" ? `Wrong PIN. ${left} ${left === 1 ? "try" : "tries"} before a lockout.` : `That is not the answer. ${left} ${left === 1 ? "try" : "tries"} left.`);
    error.status = 403;
    throw error;
  }

  async addDevice(userAgent) {
    const key = randomBytes(32).toString("base64url");
    const at = this.now();
    this.state.devices.push({ id: randomBytes(8).toString("hex"), keyHash: keyHash(key), name: deviceName(userAgent), addedAt: at, lastSeen: at });
    await this.save();
    return key;
  }

  async unlock(pin, userAgent, who) {
    if (!this.enabled) throw new Error("No PIN is set.");
    await this.verify("pin", pin, who);
    return { key: await this.addDevice(userAgent) };
  }

  // Forgot the PIN: the reset answer sets a new one and signs every device out.
  async reset(answer, newPin, userAgent, who) {
    if (!this.state.answerHash) throw new Error("No reset question is set.");
    if (!validPin(newPin)) throw new Error("The new PIN must be 4 to 8 digits.");
    await this.verify("answer", answer, who);
    this.state.pinHash = await hashSecret(newPin);
    this.state.devices = []; this.state.pinFailures = 0; this.state.pinLockedUntil = 0;
    return { key: await this.addDevice(userAgent) };
  }

  // A new PIN signs every device out; the one that changed it gets a fresh key.
  async changePin(pin, newPin, userAgent, who) {
    if (!validPin(newPin)) throw new Error("The new PIN must be 4 to 8 digits.");
    await this.verify("pin", pin, who);
    this.state.pinHash = await hashSecret(newPin);
    this.state.devices = [];
    return { key: await this.addDevice(userAgent) };
  }

  async devices(pin, key, who) {
    await this.verify("pin", pin, who);
    const current = this.device(key);
    return this.state.devices.map(({ id, name, addedAt, lastSeen }) => ({ id, name, addedAt, lastSeen, current: current?.id === id }));
  }

  async removeDevice(pin, id, who) {
    await this.verify("pin", pin, who);
    const before = this.state.devices.length;
    this.state.devices = this.state.devices.filter(device => device.id !== id);
    await this.save();
    return { removed: before !== this.state.devices.length };
  }
}
