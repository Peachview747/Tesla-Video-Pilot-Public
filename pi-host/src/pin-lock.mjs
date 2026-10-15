// PIN lock for the Video Pilot portal: one PIN protects all services
// (YouTube, Netflix, Hulu). Trusted devices skip it via a random token
// in localStorage. A PIN request includes the device token; the server
// marks it as trusted or locks it out after repeated wrong attempts.
// PIN changes invalidate all tokens. The Devices list always requires the PIN.
import { randomUUID } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export class PinLock {
  constructor({ dataDir, pinFile = "pin-lock.json" } = {}) {
    this.file = path.join(dataDir, pinFile);
    this.state = { pin: "", devices: {}, lockouts: {} };
    this.changed = null;
  }

  async load() {
    try {
      const raw = await readFile(this.file, "utf8");
      this.state = JSON.parse(raw);
    } catch {
      await this.save();
    }
  }

  async save() {
    await writeFile(this.file, JSON.stringify(this.state, null, 2));
  }

  // Generate or reset: no PIN set → return a setup token. The page uses it to set one.
  async setup() {
    const token = randomUUID();
    return { setup: token, pinIsSet: Boolean(this.state.pin) };
  }

  // Set PIN once (setup). Requires the setup token returned by setup().
  async setPin(token, newPin, setupToken) {
    if (this.state.pin) throw new Error("PIN is already set. Use changePin.");
    if (token !== setupToken) throw new Error("Setup token is invalid.");
    if (!newPin || newPin.length < 4 || newPin.length > 8 || !/^\d+$/.test(newPin))
      throw new Error("PIN must be 4–8 digits.");
    this.state.pin = newPin;
    this.state.devices = {};
    this.state.lockouts = {};
    await this.save();
    return { ok: true };
  }

  // Change PIN (requires old PIN). Invalidates all device tokens.
  async changePin(oldPin, newPin) {
    if (oldPin !== this.state.pin) throw new Error("Old PIN is incorrect.");
    if (!newPin || newPin.length < 4 || newPin.length > 8 || !/^\d+$/.test(newPin))
      throw new Error("PIN must be 4–8 digits.");
    this.state.pin = newPin;
    this.state.devices = {};
    this.state.lockouts = {};
    await this.save();
    return { ok: true };
  }

  // Check device PIN: returns deviceId and token if correct.
  // On wrong attempts, tracks lockouts and blocks after 5 failures.
  async checkPin(pin, deviceId) {
    if (!this.state.pin) throw new Error("PIN is not set. Use setup.");
    const now = Date.now();
    const lock = this.state.lockouts[deviceId];
    if (lock?.until > now) {
      const remainingSecs = Math.ceil((lock.until - now) / 1000);
      throw new Error(`Too many wrong attempts. Try again in ${remainingSecs}s.`);
    }
    if (pin !== this.state.pin) {
      this.state.lockouts[deviceId] = { attempts: (lock?.attempts || 0) + 1, until: now + 60_000 };
      if (this.state.lockouts[deviceId].attempts >= 5) this.state.lockouts[deviceId].until = now + 900_000;
      await this.save();
      throw new Error("PIN is incorrect.");
    }
    delete this.state.lockouts[deviceId];
    const token = randomUUID();
    this.state.devices[deviceId] = { token, trustedAt: now };
    await this.save();
    return { deviceId, token, ok: true };
  }

  // Verify device token: returns true if valid and trusted.
  isDeviceTrusted(deviceId, token) {
    if (!this.state.pin) return false;
    const device = this.state.devices[deviceId];
    return device?.token === token;
  }

  // Forget a device (requires PIN). The device must sign in again.
  async removeDevice(pin, deviceId) {
    if (pin !== this.state.pin) throw new Error("PIN is incorrect.");
    delete this.state.devices[deviceId];
    await this.save();
    return { ok: true };
  }

  // List all trusted devices (requires PIN).
  async listDevices(pin) {
    if (pin !== this.state.pin) throw new Error("PIN is incorrect.");
    const now = Date.now();
    return {
      devices: Object.entries(this.state.devices).map(([id, device]) => ({
        id,
        trustedAt: new Date(device.trustedAt).toISOString(),
      })),
    };
  }
}
