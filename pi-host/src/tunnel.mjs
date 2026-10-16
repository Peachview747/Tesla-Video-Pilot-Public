import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

const MAX_CHUNK = 131056;
const MAX_WINDOW = 6;

function uuidBytes(id) { return Buffer.from(id.replaceAll("-", ""), "hex"); }
function websocketURL(publicURL) { const url = new URL("/__iphone/connect", publicURL); url.protocol = "wss:"; return url; }

export class PiTunnel {
  constructor({ publicURL, secret, localURL, WebSocketImpl = WebSocket, fetchImpl = fetch, logger = console, connectTimeoutMs = 15_000 }) {
    this.publicURL = publicURL; this.secret = secret; this.localURL = localURL;
    this.WebSocketImpl = WebSocketImpl; this.fetch = fetchImpl; this.logger = logger;
    this.socket = null; this.peers = new Map(); this.stopped = false;
    this.lastPong = 0; this.heartbeat = null;
    this.connectTimeoutMs = connectTimeoutMs;
  }

  async run() {
    let attempt = 0;
    while (!this.stopped) {
      try { await this.connect(); attempt = 0; }
      catch (error) { if (!this.stopped) this.logger.error(`Video Pilot tunnel: ${error.message || error}`); }
      if (!this.stopped) await delay(Math.min(30_000, 1_000 * 2 ** Math.min(attempt++, 5)));
    }
  }

  async check() {
    const response = await this.fetch(new URL("/__iphone/status", this.publicURL), { headers: { "x-secret": this.secret }, signal: AbortSignal.timeout(this.connectTimeoutMs) });
    if (response.status === 401) throw new Error("Cloudflare rejected VIDEO_PILOT_SECRET");
    if (!response.ok) throw new Error(`Cloudflare status check returned ${response.status}`);
    const body = await response.json();
    if (body.protocol !== "mk8-relay-v1" || !body.configured) throw new Error("Cloudflare relay is not configured");
  }

  async connect() {
    await this.check();
    return new Promise((resolve, reject) => {
      const socket = new this.WebSocketImpl(websocketURL(this.publicURL), { headers: { "x-secret": this.secret, "x-mk8-relay-window": String(MAX_WINDOW) }, handshakeTimeout: this.connectTimeoutMs });
      this.socket = socket;
      let opened = false;
      socket.on("open", () => {
        opened = true; this.lastPong = Date.now(); this.logger.log(`Video Pilot connected to ${this.publicURL}`);
        this.heartbeat = setInterval(() => {
          if (Date.now() - this.lastPong > 40_000) return this.closeWithError("Cloudflare heartbeat timed out");
          this.sendJSON({ type: "ping", id: randomUUID() });
        }, 5_000);
      });
      socket.on("message", (data, binary) => {
        if (binary) return this.closeWithError("Unexpected binary control frame");
        try { this.handle(JSON.parse(data.toString())).catch(error => this.closeWithError(error.message)); }
        catch (error) { this.closeWithError(error.message); }
      });
      socket.on("error", error => { if (!opened) reject(error); });
      socket.on("close", () => { clearInterval(this.heartbeat); this.heartbeat = null; this.cancelAll(); if (this.socket === socket) this.socket = null; resolve(); });
    });
  }

  async handle(message) {
    if (message.type === "hello") {
      if (message.protocol !== "mk8-relay-v1") throw new Error("Relay protocol mismatch");
      return;
    }
    if (message.type === "pong") { this.lastPong = Date.now(); return; }
    if (message.type === "request") return this.request(message);
    if (message.type === "pull") return this.pull(message);
    if (message.type === "cancel") return this.cancel(message.id);
    throw new Error("Unknown relay message");
  }

  async request(message) {
    if (!/^[0-9a-f-]{36}$/i.test(message.id) || !["GET", "POST"].includes(message.method)) throw new Error("Invalid relay request");
    const controller = new AbortController();
    const headers = { ...message.headers };
    delete headers.host; delete headers["content-length"];
    headers["x-video-pilot-relay"] = "1";
    const body = message.body ? Buffer.from(message.body, "base64") : undefined;
    let response, length;
    // One request that the Pi cannot answer fails alone; closing the tunnel
    // would also cut every other stream in flight.
    try {
      response = await this.fetch(new URL(message.target, this.localURL), {
        method: message.method, headers, body: body?.length ? body : undefined, signal: controller.signal,
      });
      length = Number(response.headers.get("content-length"));
      if (!Number.isSafeInteger(length) || length < 0) throw new Error("Local response omitted Content-Length");
    } catch (error) {
      controller.abort();
      this.logger.error(`Video Pilot tunnel: ${message.method} ${String(message.target).split("?")[0]} failed: ${error.message || error}`);
      this.sendJSON({ type: "error", id: message.id });
      return;
    }
    const responseHeaders = {};
    for (const [name, value] of response.headers) if (!["content-length", "connection", "transfer-encoding"].includes(name)) responseHeaders[name] = value;
    const peer = { controller, reader: response.body?.getReader() || null, pending: Buffer.alloc(0), remaining: length, sending: false, credits: 0 };
    this.peers.set(message.id, peer);
    this.sendJSON({ type: "response", id: message.id, status: response.status, headers: responseHeaders, length });
    if (length === 0) this.cancel(message.id, false);
  }

  async nextChunk(peer) {
    while (peer.pending.length === 0) {
      const result = await peer.reader.read();
      if (result.done) return null;
      peer.pending = Buffer.from(result.value);
    }
    const chunk = peer.pending.subarray(0, MAX_CHUNK);
    peer.pending = peer.pending.subarray(chunk.length);
    return chunk;
  }

  async pull(message) {
    const peer = this.peers.get(message.id);
    if (!peer) return;
    peer.credits = Math.min(MAX_WINDOW, peer.credits + Math.max(1, Math.min(MAX_WINDOW, Number(message.credits) || 1)));
    if (peer.sending) return;
    peer.sending = true;
    try {
      while (peer.credits > 0 && this.peers.get(message.id) === peer) {
        const chunk = await this.nextChunk(peer);
        if (!chunk) {
          if (peer.remaining !== 0) throw new Error("Local response ended early");
          this.sendJSON({ type: "end", id: message.id }); this.cancel(message.id, false); return;
        }
        peer.credits--; peer.remaining -= chunk.length;
        if (peer.remaining < 0) throw new Error("Local response exceeded Content-Length");
        this.socket.send(Buffer.concat([uuidBytes(message.id), chunk]), { binary: true });
        if (peer.remaining === 0) {
          this.sendJSON({ type: "end", id: message.id }); this.cancel(message.id, false); return;
        }
      }
    } catch {
      if (this.peers.get(message.id) === peer) { this.sendJSON({ type: "error", id: message.id }); this.cancel(message.id); }
    } finally { peer.sending = false; }
  }

  sendJSON(value) { if (this.socket?.readyState === this.WebSocketImpl.OPEN) this.socket.send(JSON.stringify(value)); }
  cancel(id, abort = true) { const peer = this.peers.get(id); if (!peer) return; this.peers.delete(id); if (abort) peer.controller.abort(); peer.reader?.cancel().catch(() => {}); }
  cancelAll() { for (const id of [...this.peers.keys()]) this.cancel(id); }
  closeWithError(reason) { this.logger.error(reason); this.socket?.terminate(); }
  stop() { this.stopped = true; clearInterval(this.heartbeat); this.heartbeat = null; this.cancelAll(); this.socket?.close(1000, "stopping"); }
}
