// Authenticated outbound iPhone connection. Video stays on the phone and is
// forwarded in bounded binary chunks only when the browser asks for more.
export const PROTOCOL = "mk8-relay-v1";
// Match the native 128 KiB WebSocket frame budget (16 bytes are reserved for
// the request UUID). Fewer browser-driven round trips keep cellular playback
// ahead without allowing unbounded buffering.
const MAX_CHUNK = 131056;
const MAX_REQUESTS = 8;
// Windowed pulls: a phone that advertises x-mk8-relay-window may keep this
// many frames in flight per response, so throughput is no longer one 128 KiB
// frame per phone<->Cloudflare round trip. Still bounded: at most WINDOW
// frames are queued ahead of the browser's reader per stream.
const WINDOW = 6;
const STALL_MS = 12000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PLAYER = /^[A-Za-z0-9_-]{8,128}$/;
const HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-encoding"]);

const json = (value, status = 200, headers = {}) => Response.json(value, { status, headers: { "cache-control": "no-store", ...headers } });

export function authorized(request, env) {
  return Boolean(env.SECRET) && request.headers.get("x-secret") === env.SECRET;
}

function binaryID(bytes) {
  const hex = [...bytes.subarray(0, 16)].map(n => n.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function boundedBody(request) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) { await reader.cancel(); throw new Error("Request body is too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

export class PhoneTunnel {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.pending = new Map();
    this.phone = ctx.getWebSockets("phone").find(socket => socket.readyState === 1) ?? null;
    // Hibernation rebuilds this object; the phone's capability rides on its socket.
    this.window = 1;
    try { this.window = this.phone?.deserializeAttachment?.()?.window ?? 1; } catch { this.window = 1; }
  }

  connected() { return this.phone?.readyState === 1; }
  send(value) { this.phone.send(JSON.stringify(value)); }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__iphone/status") {
      if (request.headers.has("x-secret") && !authorized(request, this.env)) return json({ error: "Incorrect tunnel key" }, 401);
      return json({ protocol: PROTOCOL, configured: Boolean(this.env.SECRET), connected: this.connected() });
    }
    if (url.pathname === "/__iphone/connect") {
      if (!authorized(request, this.env)) return json({ error: "Incorrect tunnel key" }, 401);
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "WebSocket required" }, 426);
      this.disconnect(this.phone, "A new iPhone connection replaced this connection");
      const [client, phone] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(phone, ["phone"]);
      this.phone = phone;
      const advertised = Number.parseInt(request.headers.get("x-mk8-relay-window") ?? "", 10);
      this.window = Number.isSafeInteger(advertised) && advertised > 1 ? Math.min(WINDOW, advertised) : 1;
      try { phone.serializeAttachment?.({ window: this.window }); } catch { /* not hibernatable */ }
      this.send({ type: "hello", protocol: PROTOCOL, window: this.window });
      return new Response(null, { status: 101, webSocket: client });
    }
    if (!this.connected()) return json({ error: "iPhone is disconnected" }, 503, { "x-mk8-phone": "offline" });
    if (!["GET", "POST"].includes(request.method)) return json({ error: "Method not allowed" }, 405);
    if (request.headers.has("origin") && request.headers.get("origin") !== url.origin)
      return json({ error: "Use this page to submit requests" }, 403);
    if (url.pathname.length + url.search.length > 4096) return json({ error: "Request target is too large" }, 414);
    const client = request.headers.get("x-mk8-player");
    if (client && !PLAYER.test(client)) return json({ error: "Invalid player session" }, 400);
    // A seek replaces the page's only active media stream. Do this before the
    // global limit check so a delayed browser abort cannot strand the relay at
    // its eight-request ceiling.
    if (client) this.cancelClient(client);
    if (this.pending.size >= MAX_REQUESTS) return json({ error: "iPhone is busy. Close another player and retry." }, 429);

    let body;
    try { body = await boundedBody(request); }
    catch { return json({ error: "Request body is too large" }, 413); }
    // Recheck after awaiting the body; disconnects and simultaneous requests can race.
    if (!this.connected()) return json({ error: "iPhone is disconnected" }, 503, { "x-mk8-phone": "offline" });
    if (this.pending.size >= MAX_REQUESTS) return json({ error: "iPhone is busy" }, 429);
    if (request.signal.aborted) return json({ error: "Request cancelled" }, 499);
    const id = crypto.randomUUID();
    const headers = {};
    for (const [key, value] of request.headers) {
      if (!HOP_HEADERS.has(key) && !["host", "x-secret", "content-length", "accept-encoding", "x-mk8-player"].includes(key)) headers[key] = value;
    }
    headers.host = url.host;
    headers["x-forwarded-proto"] = url.protocol.slice(0, -1);
    if (Object.keys(headers).length > 60 || new TextEncoder().encode(JSON.stringify(headers)).length > 12000)
      return json({ error: "Request headers are too large" }, 431);
    const phone = this.phone;
    return new Promise(resolve => {
      const window = this.window;
      const entry = { resolve, phone, client, controller: null, pullResolve: null, remaining: null, waiting: false, timer: null, signal: request.signal, abort: null,
        window, outstanding: 0 };
      const stream = window > 1 ? new ReadableStream({
        start: controller => { entry.controller = controller; },
        // The queue holds at most `window` frames. Each reader pull tops the
        // phone's credit back up to the free queue space, then waits for the
        // next frame so the runtime does not spin on an unchanged queue.
        pull: () => new Promise(pulled => {
          entry.pullResolve = pulled;
          if (!this.pending.has(id)) { pulled(); return; }
          this.topUp(id);
        }),
        cancel: () => this.cleanup(id, true),
      }, { highWaterMark: window }) : new ReadableStream({
        start: controller => { entry.controller = controller; },
        pull: () => new Promise(pulled => {
          entry.pullResolve = pulled;
          if (!this.pending.has(id)) { pulled(); return; }
          entry.waiting = true;
          // A video chunk normally arrives within a few seconds. Reap stale
          // seek/player requests quickly so rapid seeking cannot exhaust the
          // bounded relay request pool.
          entry.timer = setTimeout(() => this.fail(id, "iPhone stream timed out"), 12000);
          try { this.send({ type: "pull", id }); } catch { this.fail(id, "iPhone disconnected"); }
        }),
        cancel: () => this.cleanup(id, true),
      }, { highWaterMark: 0 });
      entry.stream = stream;
      entry.abort = () => this.fail(id, "Browser disconnected");
      this.pending.set(id, entry);
      request.signal.addEventListener("abort", entry.abort, { once: true });
      entry.timer = setTimeout(() => this.fail(id, "iPhone did not respond"), 15000);
      try {
        this.send({ type: "request", id, method: request.method, target: url.pathname + url.search,
          headers, body: btoa(String.fromCharCode(...body)) });
      } catch { this.fail(id, "iPhone disconnected"); }
    });
  }

  // Grant the phone enough credits to fill the stream's free queue space.
  topUp(id) {
    const entry = this.pending.get(id);
    if (!entry || entry.window <= 1 || entry.remaining === null || entry.remaining <= 0) return;
    const room = Math.max(0, entry.controller.desiredSize ?? 0) - entry.outstanding;
    if (room <= 0) return;
    entry.outstanding += room;
    entry.waiting = true;
    if (!entry.timer) entry.timer = setTimeout(() => this.fail(id, "iPhone stream timed out"), STALL_MS);
    try { this.send({ type: "pull", id, credits: room }); } catch { this.fail(id, "iPhone disconnected"); }
  }

  cleanup(id, notify = false) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.signal.removeEventListener("abort", entry.abort);
    entry.waiting = false;
    const pullResolve = entry.pullResolve;
    entry.pullResolve = null;
    pullResolve?.();
    if (notify && this.connected() && entry.phone === this.phone) {
      try { this.send({ type: "cancel", id }); } catch { /* socket already closed */ }
    }
  }

  fail(id, message) {
    const entry = this.pending.get(id);
    if (!entry) return;
    if (entry.remaining === null) entry.resolve(json({ error: message }, 502));
    // After headers, the advertised length and player's completeness check
    // detect interruption. Close cleanly across the Worker/DO stream boundary.
    else { try { entry.controller.close(); } catch { /* reader cancelled */ } }
    this.cleanup(id, true);
  }

  cancelClient(client) {
    for (const [id, entry] of [...this.pending]) {
      if (entry.client === client) this.fail(id, "Playback replaced");
    }
  }

  disconnect(socket, reason) {
    if (!socket) return;
    if (socket === this.phone) {
      this.phone = null;
      for (const id of [...this.pending.keys()]) this.fail(id, reason);
    }
    try { socket.close(1000, reason.slice(0, 120)); } catch { /* socket already closed */ }
  }

  webSocketMessage(socket, message) {
    if (socket !== this.phone) return;
    try {
      if (typeof message === "string") {
        if (message.length > 32768) throw new Error("Oversized control message");
        const value = JSON.parse(message);
        if (value.type === "ping") { this.send({ type: "pong", id: value.id }); return; }
        if (!UUID.test(value.id)) throw new Error("Invalid request ID");
        const entry = this.pending.get(value.id);
        if (!entry) return; // cancelled or already completed
        if (value.type === "response") {
          if (entry.remaining !== null || !Number.isSafeInteger(value.length) || value.length < 0 ||
              !Number.isInteger(value.status) || value.status < 200 || value.status > 599 ||
              !value.headers || typeof value.headers !== "object" || Object.keys(value.headers).length > 64)
            throw new Error("Invalid response metadata");
          const headers = new Headers();
          for (const [name, header] of Object.entries(value.headers)) {
            if (typeof header !== "string") throw new Error("Invalid response header");
            if (!HOP_HEADERS.has(name.toLowerCase()) && name.toLowerCase() !== "content-length") headers.set(name, header);
          }
          headers.set("content-length", String(value.length));
          headers.set("cache-control", "no-store");
          headers.set("x-mk8-source", "iphone");
          const response = new Response(value.length ? entry.stream : null, { status: value.status, headers });
          clearTimeout(entry.timer);
          entry.timer = null;
          entry.remaining = value.length;
          entry.resolve(response);
          if (!value.length) this.cleanup(value.id, true);
          // Windowed: start the first frames now instead of waiting a round trip
          // for the browser's first read.
          else this.topUp(value.id);
        } else if (value.type === "end") {
          if (entry.remaining !== 0) { this.fail(value.id, "Incomplete iPhone response"); return; }
          entry.controller.close();
          this.cleanup(value.id);
        } else if (value.type === "error") this.fail(value.id, "iPhone could not serve this request");
        else throw new Error("Unknown message");
      } else {
        const bytes = new Uint8Array(message);
        if (bytes.length <= 16 || bytes.length > MAX_CHUNK + 16) throw new Error("Invalid chunk size");
        const id = binaryID(bytes);
        const entry = this.pending.get(id);
        if (!entry) return;
        const payload = bytes.subarray(16);
        if (!entry.waiting || entry.remaining === null || payload.length > entry.remaining)
          throw new Error("Unrequested or oversized chunk");
        clearTimeout(entry.timer);
        entry.timer = null;
        if (entry.window > 1) {
          entry.outstanding -= 1;
          entry.waiting = entry.outstanding > 0;
          if (entry.waiting) entry.timer = setTimeout(() => this.fail(id, "iPhone stream timed out"), STALL_MS);
        } else entry.waiting = false;
        entry.remaining -= payload.length;
        entry.controller.enqueue(payload);
        entry.pullResolve?.();
        entry.pullResolve = null;
        if (!entry.remaining) { entry.controller.close(); this.cleanup(id); }
      }
    } catch { this.disconnect(socket, "Invalid relay protocol"); }
  }

  webSocketClose(socket) { this.disconnect(socket, "iPhone disconnected"); }
  webSocketError(socket) { this.disconnect(socket, "iPhone connection failed"); }
}
