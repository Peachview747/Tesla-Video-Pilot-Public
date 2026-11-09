// Kamilla Cam: the family's Nanit camera, live in the car. Nanit has no public
// API; this follows the community integrations (ha-nanit / aionanit). The Pi
// signs in to the Nanit account once (password and texted code typed in the
// portal, never stored; only Nanit's tokens are kept), then while someone is
// watching it asks the camera, over Nanit's control socket, to push its live
// stream to Nanit's media server, reads that back with ffmpeg and re-encodes it
// into the same MPEG-TS the car's player uses for everything else.
import { spawn } from "node:child_process";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import WebSocket from "ws";

const API = "https://api.nanit.com";
// Nanit rejects logins without its API version, and may reject non-app agents.
const HEADERS = { "nanit-api-version": "1", "user-agent": "Nanit/767 CFNetwork/1498.700.2 Darwin/23.6.0" };
const MEDIA = "rtmps://media-secured.nanit.com/nanit";
// A stream URL carries the access token; give it most of an hour to live.
const STREAM_TOKEN_TTL = 50 * 60_000;
const SOCKET_KEEPALIVE_MS = 25_000;
const STREAM_REMINDER_MS = 5 * 60_000; // the camera stops pushing unless reminded
const MFA_WINDOW_MS = 10 * 60_000;
export const STREAM_LIMIT_STATUS = 403; // camera already serves its maximum of app streams; the cloud stream still plays

// ---- The few protobuf messages the control socket needs (nanit.proto) ----
const varint = value => {
  const out = []; let n = Number(value);
  while (n > 127) { out.push((n & 127) | 128); n = Math.floor(n / 128); }
  out.push(n); return Buffer.from(out);
};
const number = (field, value) => Buffer.concat([varint(field * 8), varint(value)]);
const bytes = (field, value) => {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return Buffer.concat([varint(field * 8 + 2), varint(data.length), data]);
};
const MESSAGE = { KEEPALIVE: 0, REQUEST: 1, RESPONSE: 2 };
const PUT_STREAMING = 2, MOBILE = 2;
export const STREAMING = { STARTED: 0, STOPPED: 1 };

export const keepaliveMessage = () => number(1, MESSAGE.KEEPALIVE);
export function streamingMessage(id, status, rtmpUrl) {
  const streaming = Buffer.concat([number(1, MOBILE), number(2, status), bytes(3, rtmpUrl)]);
  return Buffer.concat([number(1, MESSAGE.REQUEST), bytes(2, Buffer.concat([number(1, id), number(2, PUT_STREAMING), bytes(4, streaming)]))]);
}
function* fields(data) {
  let at = 0;
  const read = () => { let value = 0, scale = 1, byte; do { byte = data[at++]; value += (byte & 127) * scale; scale *= 128; } while (byte & 128 && at < data.length); return value; };
  while (at < data.length) {
    const key = read(), field = Math.floor(key / 8), wire = key & 7;
    if (wire === 0) yield [field, read()];
    else if (wire === 2) { const length = read(); yield [field, data.subarray(at, at + length)]; at += length; }
    else if (wire === 1) at += 8; else if (wire === 5) at += 4; else return;
  }
}
// The RESPONSE part of a control message, or null for anything else.
export function readResponse(data) {
  let type = null, response = null;
  for (const [field, value] of fields(Buffer.from(data))) {
    if (field === 1) type = value; else if (field === 3) response = value;
  }
  if (type !== MESSAGE.RESPONSE || !response) return null;
  const out = { requestId: null, statusCode: null, statusMessage: "" };
  for (const [field, value] of fields(response)) {
    if (field === 1) out.requestId = value; else if (field === 3) out.statusCode = value;
    else if (field === 4) out.statusMessage = value.toString("utf8");
  }
  return out;
}

function tokenExpiry(token) {
  try { return JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8")).exp * 1000 || null; } catch { return null; }
}

export class NanitCam {
  constructor({ dataDir, fetcher = globalThis.fetch, launch = spawn, connect = (url, options) => new WebSocket(url, options),
    now = Date.now, retryDelay = 2000, attempts = 4, bitrate = 2000 }) {
    this.file = path.join(dataDir, "nanit.json");
    this.fetcher = fetcher; this.launch = launch; this.connect = connect; this.now = now;
    this.retryDelay = retryDelay; this.attempts = attempts; this.bitrate = bitrate;
    this.auth = null; this.pending = null; this.babyInfo = null;
    this.socket = null; this.encoder = null; this.output = null; this.timers = [];
    this.requests = new Map(); this.nextRequest = 1;
    this.state = "idle"; this.message = "";
  }

  async load() {
    try { this.auth = JSON.parse(await readFile(this.file, "utf8")); } catch { this.auth = null; }
    return this;
  }

  status() {
    return { signedIn: Boolean(this.auth?.refreshToken), codeNeeded: Boolean(this.pending && this.pending.until > this.now()),
      baby: this.babyInfo?.name || this.auth?.babyName || null, streaming: Boolean(this.output), state: this.state, message: this.message };
  }

  async save() {
    const temp = `${this.file}.tmp`;
    await writeFile(temp, JSON.stringify(this.auth), { mode: 0o600 });
    await rename(temp, this.file);
  }

  async call(method, route, { body, token } = {}) {
    let response;
    try {
      response = await this.fetcher(API + route, { method, signal: AbortSignal.timeout(15_000),
        headers: { ...HEADERS, ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: token } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw Object.assign(new Error("Could not reach Nanit. Check the Pi's internet."), { status: 502 }); }
    const data = await response.json().catch(() => ({}));
    return { status: response.status, data };
  }

  async keepTokens(data) {
    if (!data?.access_token || !data?.refresh_token) throw new Error("Nanit did not sign in.");
    this.auth = { ...this.auth, accessToken: data.access_token, refreshToken: data.refresh_token,
      expiresAt: tokenExpiry(data.access_token) || this.now() + 60 * 60_000 };
    await this.save();
  }

  // Step 1: email and password. Nanit usually answers 482 and texts a code.
  async login(email, password) {
    email = String(email || "").trim(); password = String(password || "");
    if (!email || !password || email.length > 200 || password.length > 200) throw new Error("Enter the Nanit email and password.");
    const { status, data } = await this.call("POST", "/login", { body: { email, password } });
    if (data?.mfa_token) {
      this.pending = { email, password, mfaToken: data.mfa_token, until: this.now() + MFA_WINDOW_MS };
      return { ...this.status(), codeNeeded: true };
    }
    if (status === 401 || !data?.access_token) throw new Error(status === 401 ? "Nanit did not accept that email and password." : data?.message || "Nanit did not sign in.");
    this.auth = {}; await this.keepTokens(data);
    await this.baby(true);
    return this.status();
  }

  // Step 2: the code Nanit texted. The password is forgotten either way.
  async verify(code) {
    const pending = this.pending;
    if (!pending || pending.until < this.now()) { this.pending = null; throw new Error("Start again with the email and password."); }
    code = String(code || "").replace(/\s/g, "");
    if (!/^\d{4,8}$/.test(code)) throw new Error("Enter the code Nanit texted you.");
    const { status, data } = await this.call("POST", "/login", { body: { email: pending.email, password: pending.password, mfa_token: pending.mfaToken, mfa_code: code } });
    if (!data?.access_token) {
      if (status >= 500) throw new Error("Nanit is not answering; try the code again.");
      throw new Error(data?.message ? `Nanit: ${data.message}` : "Nanit did not accept that code.");
    }
    this.pending = null;
    this.auth = {}; await this.keepTokens(data);
    await this.baby(true);
    return this.status();
  }

  async signOut() {
    this.stop();
    this.auth = null; this.pending = null; this.babyInfo = null;
    await rm(this.file, { force: true });
    return this.status();
  }

  async accessToken(minimumMs = STREAM_TOKEN_TTL) {
    if (!this.auth?.refreshToken) throw Object.assign(new Error("Sign in to Nanit first."), { status: 401 });
    if (this.auth.accessToken && this.auth.expiresAt - this.now() > minimumMs) return this.auth.accessToken;
    const { status, data } = await this.call("POST", "/tokens/refresh", { body: { refresh_token: this.auth.refreshToken }, token: this.auth.accessToken });
    if (status === 404 || status === 401) {
      this.auth = null; await rm(this.file, { force: true });
      throw Object.assign(new Error("Nanit signed the Pi out. Sign in again."), { status: 401 });
    }
    if (!data?.access_token) throw new Error(`Nanit did not renew the sign-in (HTTP ${status}).`);
    await this.keepTokens(data);
    return this.auth.accessToken;
  }

  // The camera's baby (the first one with a camera on the account).
  async baby(refresh = false) {
    if (this.babyInfo && !refresh) return this.babyInfo;
    const token = await this.accessToken(5 * 60_000);
    const { status, data } = await this.call("GET", "/babies", { token });
    if (status === 401) { this.auth.expiresAt = 0; throw new Error("Nanit refused the sign-in; try again."); }
    const found = (Array.isArray(data?.babies) ? data.babies : []).find(baby => baby?.uid && baby?.camera_uid);
    if (!found) throw new Error("No Nanit camera was found on this account.");
    this.babyInfo = { uid: String(found.uid), cameraUid: String(found.camera_uid), name: String(found.name || "").slice(0, 60) || null };
    if (this.auth.babyName !== this.babyInfo.name) { this.auth.babyName = this.babyInfo.name; await this.save(); }
    return this.babyInfo;
  }

  openSocket(cameraUid, token) {
    return new Promise((resolve, reject) => {
      const socket = this.connect(`wss://api.nanit.com/focus/cameras/${cameraUid}/user_connect`, { headers: { Authorization: `Bearer ${token}` } });
      const fail = error => { cleanup(); reject(new Error(`Could not reach the camera through Nanit (${error?.message || error}).`)); };
      const opened = () => { cleanup(); resolve(socket); };
      const cleanup = () => { socket.off?.("open", opened); socket.off?.("error", fail); clearTimeout(timer); };
      const timer = setTimeout(() => { try { socket.terminate?.(); } catch {} fail("timed out"); }, 15_000);
      socket.on("open", opened); socket.on("error", fail);
      socket.on("message", data => {
        const response = readResponse(data);
        const waiter = response && this.requests.get(response.requestId);
        if (waiter) { this.requests.delete(response.requestId); waiter(response); }
      });
      socket.on("close", () => { if (this.socket === socket) this.socket = null; });
    });
  }

  request(status, rtmpUrl) {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error("The camera connection closed."));
    const id = this.nextRequest++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(id); reject(new Error("The camera did not answer.")); }, 10_000);
      this.requests.set(id, response => { clearTimeout(timer); resolve(response); });
      socket.send(streamingMessage(id, status, rtmpUrl));
    });
  }

  // One viewer at a time: a new stream replaces the old one. Returns a stream
  // of MPEG-TS that ends when the camera's picture stops.
  async stream() {
    this.stop();
    const output = new PassThrough();
    this.output = output; this.state = "connecting"; this.message = "Waking the camera…";
    try {
      const token = await this.accessToken();
      const baby = await this.baby();
      const socket = await this.openSocket(baby.cameraUid, token);
      if (this.output !== output) { socket.close(); throw new Error("Replaced by a newer viewer."); }
      this.socket = socket;
      const url = `${MEDIA}/${baby.uid}.${token}`;
      const answer = await this.request(STREAMING.STARTED, url);
      if (answer.statusCode !== 200 && answer.statusCode !== STREAM_LIMIT_STATUS)
        throw new Error(`The camera would not stream (${answer.statusCode}${answer.statusMessage ? `: ${answer.statusMessage}` : ""}).`);
      this.timers.push(setInterval(() => { try { socket.send(keepaliveMessage()); } catch {} }, SOCKET_KEEPALIVE_MS));
      this.timers.push(setInterval(() => { this.request(STREAMING.STARTED, url).catch(() => {}); }, STREAM_REMINDER_MS));
      this.url = url;
      this.encode(output, url, 1);
      return output;
    } catch (error) {
      if (this.output === output) this.stop("error", error.message);
      throw error;
    }
  }

  // The camera takes a moment to start pushing; until it does, Nanit's media
  // server has nothing to play and ffmpeg exits. Retry until data flows.
  encode(output, url, attempt) {
    if (this.output !== output) return;
    const encoder = this.launch("ffmpeg", ["-hide_banner", "-loglevel", "error", "-rw_timeout", "15000000", "-i", url,
      "-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale=1280:-2", "-r", "25",
      "-c:v", "mpeg1video", "-b:v", `${this.bitrate}k`, "-maxrate", `${Math.round(this.bitrate * 1.25)}k`, "-bufsize", `${this.bitrate}k`,
      "-bf", "0", "-g", "50", "-c:a", "mp2", "-b:a", "128k", "-ar", "44100", "-ac", "2",
      "-f", "mpegts", "-muxdelay", "0", "-flush_packets", "1", "pipe:1"], { stdio: ["ignore", "pipe", "ignore"] });
    this.encoder = encoder;
    let flowing = false;
    encoder.stdout.on("data", chunk => {
      if (!flowing) { flowing = true; this.state = "streaming"; this.message = ""; }
      if (this.output === output && !output.write(chunk)) { encoder.stdout.pause(); output.once("drain", () => encoder.stdout.resume()); }
    });
    encoder.once("exit", () => {
      if (this.encoder === encoder) this.encoder = null;
      if (this.output !== output) return;
      if (!flowing && attempt < this.attempts) { setTimeout(() => this.encode(output, url, attempt + 1), this.retryDelay); return; }
      this.stop(flowing ? "idle" : "error", flowing ? "The camera's picture stopped." : "The camera did not start its picture. Try again.");
    });
  }

  stop(state = "idle", message = "") {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    const socket = this.socket, encoder = this.encoder, output = this.output, url = this.url;
    this.socket = null; this.encoder = null; this.output = null; this.url = null;
    try { encoder?.kill("SIGKILL"); } catch {}
    try { output?.end(); } catch {}
    if (socket) {
      // Tell the camera to stop pushing, then hang up.
      try { if (url) socket.send(streamingMessage(this.nextRequest++, STREAMING.STOPPED, url)); } catch {}
      setTimeout(() => { try { socket.close(); } catch {} }, 500);
    }
    for (const waiter of this.requests.values()) waiter({ statusCode: null });
    this.requests.clear();
    this.state = state; this.message = message;
    return this.status();
  }
}
