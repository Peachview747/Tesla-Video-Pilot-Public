import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { PhoneTunnel } from "../phone-relay.js";

const ORIGIN = "https://tv.jcruzhoovertesla.workers.dev";
const SECRET = "test-secret-not-a-production-credential";
const tick = () => new Promise(resolve => setTimeout(resolve, 25));

async function fixture(t) {
  const upstream = [];
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: ["worker.js", "phone-relay.js"].map(name => ({ type: "ESModule", path: fileURLToPath(new URL("../" + name, import.meta.url)) })),
    compatibilityDate: "2026-10-03", bindings: { SECRET }, kvNamespaces: ["KV"],
    durableObjects: { PHONE_TUNNEL: { className: "PhoneTunnel", useSQLite: true } },
    outboundService: request => {
      upstream.push(request.url);
      return new Response("laptop response", { headers: { "x-source": "laptop" } });
    },
  }));
  t.after(() => mf.dispose());
  const fetch = (path, init) => mf.dispatchFetch(ORIGIN + path, init);
  const connect = async (key = SECRET) => {
    const response = await fetch("/__iphone/connect", { headers: { upgrade: "websocket", "x-secret": key } });
    if (!response.webSocket) return { response, socket: null };
    const socket = response.webSocket;
    socket.accept();
    t.after(() => { try { socket.close(); } catch {} });
    return { response, socket };
  };
  return { mf, fetch, connect, upstream };
}

function phone(socket, respond) {
  const requests = new Map();
  const observed = [];
  let pulls = 0, cancels = 0;
  socket.addEventListener("message", event => {
    if (socket.readyState !== 1) return;
    const message = JSON.parse(event.data);
    if (message.type === "hello") return;
    if (message.type === "ping") { socket.send(JSON.stringify({ type: "pong", id: message.id })); return; }
    if (message.type === "request") {
      observed.push(message);
      const value = respond(message);
      const body = Buffer.from(value.body ?? "");
      requests.set(message.id, { body, offset: 0, chunks: 0, holdAfter: value.holdAfter ?? Infinity });
      socket.send(JSON.stringify({ type: "response", id: message.id, status: value.status ?? 200,
        headers: value.headers ?? { "content-type": "video/mp2t" }, length: body.length }));
    }
    if (message.type === "pull") {
      pulls++;
      const pending = requests.get(message.id);
      if (!pending) return;
      if (pending.chunks++ >= pending.holdAfter) return;
      const chunk = pending.body.subarray(pending.offset, pending.offset + 32768);
      pending.offset += chunk.length;
      const identity = Buffer.from(message.id.replaceAll("-", ""), "hex");
      socket.send(Buffer.concat([identity, chunk]));
      if (pending.offset === pending.body.length) {
        socket.send(JSON.stringify({ type: "end", id: message.id }));
        requests.delete(message.id);
      }
    }
    if (message.type === "cancel") { cancels++; requests.delete(message.id); }
  });
  return { observed, get pulls() { return pulls; }, get cancels() { return cancels; } };
}

test("rejects an incorrect key and exposes an authenticated setup check", async t => {
  const f = await fixture(t);
  const { response } = await f.connect("incorrect");
  assert.equal(response.status, 401);
  assert.equal((await f.fetch("/__iphone/status", { headers: { "x-secret": "incorrect" } })).status, 401);
  const valid = await f.fetch("/__iphone/status", { headers: { "x-secret": SECRET } });
  assert.deepEqual(await valid.json(), { protocol: "mk8-relay-v1", configured: true, connected: false });
});

test("keeps laptop routing and target updates when the phone is absent", async t => {
  const f = await fixture(t);
  assert.equal((await f.fetch("/")).status, 503);
  assert.equal((await f.fetch("/__set", { method: "POST", headers: { "x-secret": "wrong" }, body: "https://example.trycloudflare.com" })).status, 403);
  assert.equal((await f.fetch("/__set", { method: "POST", headers: { "x-secret": SECRET }, body: "https://example.trycloudflare.com" })).status, 200);
  const response = await f.fetch("/api/library");
  assert.equal(await response.text(), "laptop response");
  assert.equal(f.upstream.at(-1), "https://example.trycloudflare.com/api/library");
});

test("streams exact binary bytes through the real Worker runtime", async t => {
  const f = await fixture(t);
  const { socket } = await f.connect();
  const ts = Buffer.alloc(188 * 1500);
  for (let i = 0; i < ts.length; i++) ts[i] = i % 188 === 0 ? 0x47 : i % 251;
  const p = phone(socket, () => ({ body: ts }));
  const response = await f.fetch("/api/stream/test.ts", { headers: { cookie: "video-pilot-test=1" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-mk8-source"), "iphone");
  const reader = response.body.getReader();
  const chunks = [];
  const first = await reader.read();
  chunks.push(Buffer.from(first.value));
  for (;;) { const { value, done } = await reader.read(); if (done) break; chunks.push(Buffer.from(value)); }
  assert.deepEqual(Buffer.concat(chunks), ts);
  assert.equal(p.observed[0].headers.cookie, "video-pilot-test=1");
});

test("relay grants one chunk per reader pull and holds video while the reader pauses", async () => {
  const messages = [];
  const socket = { readyState: 1, send: text => messages.push(JSON.parse(text)) };
  const relay = new PhoneTunnel({ getWebSockets: () => [] }, { SECRET });
  relay.phone = socket;
  const responsePromise = relay.fetch(new Request(ORIGIN + "/video"));
  await tick();
  const id = messages[0].id;
  relay.webSocketMessage(socket, JSON.stringify({ type: "response", id, status: 200, headers: {}, length: 4 }));
  const response = await responsePromise;
  assert.equal(messages.filter(m => m.type === "pull").length, 0);
  const reader = response.body.getReader();
  const first = reader.read();
  await tick();
  assert.equal(messages.filter(m => m.type === "pull").length, 1);
  const identity = Buffer.from(id.replaceAll("-", ""), "hex");
  relay.webSocketMessage(socket, Buffer.concat([identity, Buffer.from([0x47, 1])]));
  assert.deepEqual([...((await first).value)], [0x47, 1]);
  await tick();
  assert.equal(messages.filter(m => m.type === "pull").length, 1);
  const next = reader.read();
  await tick();
  assert.equal(messages.filter(m => m.type === "pull").length, 2);
  relay.webSocketMessage(socket, Buffer.concat([identity, Buffer.from([2, 3])]));
  assert.deepEqual([...((await next).value)], [2, 3]);
  assert.equal((await reader.read()).done, true);
  assert.equal(relay.pending.size, 0);
  messages.length = 0;
  const cancelledPromise = relay.fetch(new Request(ORIGIN + "/cancelled"));
  await tick();
  const cancelledID = messages[0].id;
  relay.webSocketMessage(socket, JSON.stringify({ type: "response", id: cancelledID, status: 200, headers: {}, length: 10 }));
  const cancelled = await cancelledPromise;
  await cancelled.body.cancel();
  assert.equal(relay.pending.size, 0);
  assert.ok(messages.some(m => m.type === "cancel" && m.id === cancelledID));
});

test("a new player stream evicts its stale predecessor before the request limit", async t => {
  const messages = [];
  const socket = { readyState: 1, send: value => messages.push(JSON.parse(value)) };
  const relay = new PhoneTunnel({ getWebSockets: () => [] }, { SECRET });
  relay.phone = socket;
  const headers = { "x-mk8-player": "vp-stable-player" };
  const firstPromise = relay.fetch(new Request(ORIGIN + "/old.ts", { headers }));
  await tick();
  const firstID = messages.find(message => message.type === "request").id;
  messages.length = 0;
  const secondPromise = relay.fetch(new Request(ORIGIN + "/new.ts", { headers }));
  await tick();
  const secondRequest = messages.find(message => message.type === "request");
  assert.ok(messages.some(message => message.type === "cancel" && message.id === firstID));
  assert.equal(relay.pending.size, 1);
  relay.webSocketMessage(socket, JSON.stringify({ type: "response", id: secondRequest.id,
    status: 200, headers: {}, length: 0 }));
  const second = await secondPromise;
  assert.equal(second.status, 200);
  assert.equal((await firstPromise).status, 502);
  assert.equal(relay.pending.size, 0);
  t.after(() => relay.disconnect(socket, "test complete"));
});

test("preserves public Host/Origin, request body, and secure cookie without forwarding the tunnel key", async t => {
  const f = await fixture(t);
  const { socket } = await f.connect();
  const p = phone(socket, () => ({ body: '{"ok":true}', headers: { "content-type": "application/json", "Set-Cookie": "video-pilot-session=abc; Path=/; HttpOnly; SameSite=Strict; Secure" } }));
  const response = await f.fetch("/api/youtube", { method: "POST", headers: { origin: ORIGIN, "x-secret": "must-not-reach-phone", "content-type": "application/json" }, body: '{"url":"dQw4w9WgXcQ"}' });
  assert.equal(await response.text(), '{"ok":true}');
  assert.match(response.headers.get("set-cookie"), /HttpOnly; SameSite=Strict; Secure/);
  assert.equal(p.observed[0].headers.host, new URL(ORIGIN).host);
  assert.equal(p.observed[0].headers.origin, ORIGIN);
  assert.equal(p.observed[0].headers["x-secret"], undefined);
  assert.equal(Buffer.from(p.observed[0].body, "base64").toString(), '{"url":"dQw4w9WgXcQ"}');
  const count = p.observed.length;
  assert.equal((await f.fetch("/api/youtube", { method: "POST", headers: { origin: "https://other.test" }, body: "{}" })).status, 403);
  assert.equal(p.observed.length, count);
});

test("multiplexes two streams without mixing payloads", async t => {
  const f = await fixture(t);
  const { socket } = await f.connect();
  const p = phone(socket, request => ({ body: Buffer.alloc(100000, request.target === "/a" ? 1 : 2),
    holdAfter: request.target === "/cancelled" ? 1 : Infinity }));
  const [a, b] = await Promise.all([f.fetch("/a"), f.fetch("/b")]);
  const [bytesA, bytesB] = await Promise.all([a.arrayBuffer(), b.arrayBuffer()]);
  assert.deepEqual(Buffer.from(bytesA), Buffer.alloc(100000, 1));
  assert.deepEqual(Buffer.from(bytesB), Buffer.alloc(100000, 2));
  const after = await f.fetch("/after");
  assert.equal((await after.arrayBuffer()).byteLength, 100000);
});

test("disconnect terminates active streams and falls back to the laptop for new requests", async t => {
  const f = await fixture(t);
  await f.fetch("/__set", { method: "POST", headers: { "x-secret": SECRET }, body: "https://example.trycloudflare.com" });
  const { socket } = await f.connect();
  phone(socket, () => ({ body: Buffer.alloc(100000, 3), holdAfter: 1 }));
  const active = await f.fetch("/video");
  const reader = active.body.getReader();
  await reader.read();
  socket.close(1000, "stopping");
  await tick();
  let received = 32768;
  try { for (;;) { const value = await reader.read(); if (value.done) break; received += value.value.length; } } catch {}
  assert.ok(received < 100000, "a disconnected stream must not appear complete");
  assert.equal((await (await f.fetch("/__iphone/status")).json()).connected, false);
  assert.equal(await (await f.fetch("/")).text(), "laptop response");
});

test("bounds request bodies and active requests, and replaces a stale phone cleanly", async t => {
  const f = await fixture(t);
  const first = await f.connect();
  const p = phone(first.socket, () => ({ body: Buffer.alloc(100000, 4), holdAfter: 1 }));
  assert.equal((await f.fetch("/api/youtube", { method: "POST", body: "x".repeat(16385) })).status, 413);
  assert.equal(p.observed.length, 0);
  const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => f.fetch(`/held${i}`)));
  assert.equal((await f.fetch("/ninth")).status, 429);
  const second = await f.connect();
  phone(second.socket, () => ({ body: "new phone" }));
  for (const response of responses) {
    try { assert.ok((await response.arrayBuffer()).byteLength < 100000); }
    catch (error) { if (error.code === "ERR_ASSERTION") throw error; }
  }
  assert.equal(await (await f.fetch("/new")).text(), "new phone");
});
