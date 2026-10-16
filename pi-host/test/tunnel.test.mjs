import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PiTunnel } from "../src/tunnel.mjs";

class Socket extends EventEmitter {
  static OPEN = 1;
  constructor() { super(); this.readyState = 1; this.sent = []; }
  send(value) { this.sent.push(value); }
  close() { this.readyState = 3; this.emit("close"); }
}

test("a stalled cloud check times out so offline startup can retry", async () => {
  const tunnel = new PiTunnel({ publicURL: "https://tv.example", secret: "test", connectTimeoutMs: 10,
    fetchImpl: async (url, {signal}) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {once:true});
    }) });
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(tunnel.check(), {name:"TimeoutError"}); }
  finally { clearTimeout(keepAlive); }
});

test("answers relay requests in bounded binary frames", async () => {
  const tunnel = new PiTunnel({ publicURL: "https://tv.example", secret: "test", localURL: "http://127.0.0.1:1",
    WebSocketImpl: Socket, fetchImpl: async () => new Response(Buffer.alloc(200000, 5), { headers: { "content-length": "200000", "content-type": "video/mp2t" } }), logger: { log() {}, error() {} } });
  const socket = new Socket(); tunnel.socket = socket;
  const id = "00000000-0000-4000-8000-000000000000";
  await tunnel.handle({ type: "request", id, method: "GET", target: "/video", headers: {}, body: "" });
  await tunnel.handle({ type: "pull", id, credits: 6 });
  const control = socket.sent.filter(value => typeof value === "string").map(value => JSON.parse(value));
  const frames = socket.sent.filter(Buffer.isBuffer);
  assert.equal(control[0].type, "response");
  assert.equal(control.at(-1).type, "end");
  assert.equal(frames.reduce((sum, frame) => sum + frame.length - 16, 0), 200000);
  assert.ok(frames.every(frame => frame.length <= 131056 + 16));
});

test("a request the Pi cannot serve fails alone and the tunnel stays up", async () => {
  const errors = [];
  const tunnel = new PiTunnel({ publicURL: "https://tv.example", secret: "test", localURL: "http://127.0.0.1:1",
    WebSocketImpl: Socket, fetchImpl: async () => { throw new Error("connect ECONNREFUSED"); }, logger: { log() {}, error: line => errors.push(line) } });
  const socket = new Socket(); tunnel.socket = socket;
  let closed = false; socket.terminate = () => { closed = true; };
  const id = "00000000-0000-4000-8000-000000000001";
  await tunnel.handle({ type: "request", id, method: "GET", target: "/api/status?x=1", headers: {}, body: "" });
  assert.deepEqual(socket.sent.map(value => JSON.parse(value)), [{ type: "error", id }]);
  assert.equal(closed, false);
  assert.match(errors[0], /GET \/api\/status failed/);
});
