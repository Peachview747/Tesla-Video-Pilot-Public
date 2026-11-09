import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { NanitCam, STREAMING, keepaliveMessage, readResponse, streamingMessage } from "../src/nanit.mjs";

const jwt = exp => `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;
const reply = (status, data) => ({ status, json: async () => data });
// Message{RESPONSE, Response{requestId, PUT_STREAMING, statusCode}}
const responseFor = (id, code) => { const body = Buffer.from([8, id, 16, 2, 24, code & 127 | 128, code >> 7]); return Buffer.from([8, 2, 26, body.length, ...body]); };

test("control messages match nanit.proto", () => {
  assert.deepEqual([...keepaliveMessage()], [8, 0], "KEEPALIVE must carry its zero type explicitly (proto2 required)");
  const message = streamingMessage(7, STREAMING.STARTED, "rtmps://x/y");
  // Message{type=REQUEST, request{id=7, type=PUT_STREAMING, streaming{id=MOBILE, status=STARTED, rtmpUrl}}}
  assert.deepEqual([...message.subarray(0, 8)], [8, 1, 18, message.length - 4, 8, 7, 16, 2]);
  assert.ok(message.includes(Buffer.from([8, 2, 16, 0, 26, 11])), "streaming id, explicit STARTED status and the URL");
  assert.deepEqual(readResponse(responseFor(7, 200)), { requestId: 7, statusCode: 200, statusMessage: "" });
  assert.equal(readResponse(keepaliveMessage()), null);
});

async function signedInCam(fetcher, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vp-nanit-"));
  return { dataDir, cam: await new NanitCam({ dataDir, fetcher, now: () => 1_000_000, ...options }).load() };
}

test("sign-in with the texted code keeps only Nanit's tokens", async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push([url, body, init.headers]);
    if (url.endsWith("/login") && !body.mfa_code) return reply(482, { mfa_token: "mfa1" });
    if (url.endsWith("/login")) return body.mfa_code === "123456" ? reply(201, { access_token: jwt(5000), refresh_token: "r1" }) : reply(401, { message: "Invalid code" });
    if (url.endsWith("/babies")) return reply(200, { babies: [{ uid: "baby1", name: "Kamilla", camera_uid: "cam1" }] });
    throw new Error(`unexpected ${url}`);
  };
  const { dataDir, cam } = await signedInCam(fetcher);
  assert.equal((await cam.login("me@example.com", "secret")).codeNeeded, true);
  assert.equal(calls[0][2]["nanit-api-version"], "1");
  await assert.rejects(cam.verify("111111"), /Invalid code/);
  const state = await cam.verify("123 456");
  assert.equal(state.signedIn, true); assert.equal(state.baby, "Kamilla"); assert.equal(state.codeNeeded, false);
  const saved = await readFile(path.join(dataDir, "nanit.json"), "utf8");
  assert.equal(JSON.parse(saved).refreshToken, "r1");
  assert.ok(!saved.includes("secret") && !saved.includes("me@example.com"), "the email and password are not stored");
  assert.equal((await stat(path.join(dataDir, "nanit.json"))).mode & 0o777, 0o600);
  assert.equal(calls.at(-1)[2].authorization, jwt(5000), "Nanit takes the bare token");
  await assert.rejects(cam.verify("123456"), /Start again/, "a code works once");
  await cam.signOut();
  assert.equal(cam.status().signedIn, false);
});

test("a refresh Nanit refuses signs the Pi out", async () => {
  const fetcher = async url => url.endsWith("/tokens/refresh") ? reply(404, {}) : reply(500, {});
  const { cam } = await signedInCam(fetcher);
  cam.auth = { accessToken: jwt(1), refreshToken: "old", expiresAt: 0 };
  await assert.rejects(cam.accessToken(), /Sign in again/);
  assert.equal(cam.status().signedIn, false);
});

test("watching wakes the camera, retries until the picture flows, and stops it after", async () => {
  const fetcher = async url => {
    if (url.endsWith("/tokens/refresh")) return reply(200, { access_token: jwt(9_000), refresh_token: "r2" });
    if (url.endsWith("/babies")) return reply(200, { babies: [{ uid: "baby1", name: "Kamilla", camera_uid: "cam1" }] });
    throw new Error(`unexpected ${url}`);
  };
  const sent = [], sockets = [], encoders = [];
  const connect = (url, options) => {
    const socket = new EventEmitter();
    Object.assign(socket, { url, options, closed: false,
      send(data) { sent.push(Buffer.from(data)); if (data[0] === 8 && data[1] === 1) setImmediate(() => socket.emit("message", responseFor(data[5], 200))); },
      close() { socket.closed = true; } });
    sockets.push(socket); setImmediate(() => socket.emit("open"));
    return socket;
  };
  const launch = (command, args) => {
    const encoder = new EventEmitter();
    Object.assign(encoder, { command, args, stdout: new PassThrough(), killed: false, kill() { encoder.killed = true; } });
    encoders.push(encoder);
    // The first try finds nothing published yet; the second plays.
    setImmediate(() => encoders.length === 1 ? encoder.emit("exit", 1) : encoder.stdout.write(Buffer.from("TS")));
    return encoder;
  };
  const { cam } = await signedInCam(fetcher, { connect, launch, retryDelay: 5 });
  cam.auth = { accessToken: jwt(1), refreshToken: "r1", expiresAt: 0 };
  const output = await cam.stream();
  assert.equal(sockets[0].url, "wss://api.nanit.com/focus/cameras/cam1/user_connect");
  assert.equal(sockets[0].options.headers.Authorization, `Bearer ${jwt(9_000)}`);
  const url = `rtmps://media-secured.nanit.com/nanit/baby1.${jwt(9_000)}`;
  assert.ok(sent[0].includes(Buffer.from(url)), "the camera is told where to push");
  const chunk = await new Promise(resolve => output.once("data", resolve));
  assert.equal(chunk.toString(), "TS");
  assert.equal(encoders.length, 2);
  assert.equal(encoders[1].args[encoders[1].args.indexOf("-i") + 1], url);
  assert.equal(cam.status().state, "streaming");
  cam.stop();
  assert.ok(encoders[1].killed);
  assert.ok(sent.at(-1).includes(Buffer.from([16, STREAMING.STOPPED])), "the camera is told to stop");
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.ok(sockets[0].closed);
});
