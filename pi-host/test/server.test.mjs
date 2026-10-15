import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createVideoPilotServer } from "../src/server.mjs";

test("the installed web page serves all scripts including a working video decoder", async t => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const host = createVideoPilotServer({ library: {}, webRoot: path.join(root, "ios/Web"),
    decoderPath: path.join(root, "app/client/public/jsmpeg.min.js"), port: 0 });
  await host.start(); t.after(() => host.stop());
  const origin = `http://127.0.0.1:${host.server.address().port}`;
  const html = await (await fetch(origin)).text();
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match => match[1]);
  assert.ok(scripts.includes("/jsmpeg.min.js"));
  for (const script of [...scripts, "/http-source.js", "/diagnostics.js"]) {
    const response = await fetch(origin + script);
    assert.equal(response.status, 200, script);
    assert.match(response.headers.get("content-type"), /javascript/);
    if (script === "/jsmpeg.min.js") {
      const context = vm.createContext({ window: {}, document: {readyState:"loading", addEventListener() {}} });
      vm.runInContext(await response.text(), context);
      assert.equal(typeof context.JSMpeg.Player, "function");
    }
  }
});

test("serves the Tesla UI, library API, and indexed MPEG-TS seek", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vp-server-"));
  const web = path.join(root, "web"); await mkdir(web); await writeFile(path.join(web, "index.html"), "player");
  const media = path.join(root, "video.ts"); await writeFile(media, Buffer.alloc(188 * 20, 7));
  const seek = path.join(root, "video.seek.json"); await writeFile(seek, JSON.stringify({ points: [{ time: 10, offset: 1880 }] }));
  const item = { id: "00000000-0000-4000-8000-000000000000", state: "ready" };
  const library = {
    videos: [item], queue: [], active: null, settings: { quality: 720 }, history: [],
    get: id => id === item.id ? item : null, paths: () => ({ media, seek }), queueView: () => ({ items: [] }), libraryView: () => [item], signedIn: async () => false,
    saveCookies: async text => { library.savedCookies = text; },
    recordHistory: async value => { library.history.push({ libraryId: value.id }); },
  };
  const host = createVideoPilotServer({ library, webRoot: web, port: 0 });
  await host.start(); t.after(() => host.stop());
  const port = host.server.address().port;
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "player");
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/api/library`)).json(), [item]);
  const response = await fetch(`http://127.0.0.1:${port}/api/stream/${item.id}.ts?seek=12`);
  assert.equal(response.headers.get("x-mk8-seek-offset"), "1880");
  assert.equal(response.headers.get("x-video-bytes"), String(188 * 20 - 1880), "the size survives relays that drop content-length");
  assert.equal((await response.arrayBuffer()).byteLength, 1880);
});

test("only the Pi itself can save YouTube sign-in cookies", async t => {
  const library = { videos: [], queue: [], saveCookies: async text => { library.saved = text; } };
  const host = createVideoPilotServer({ library, webRoot: os.tmpdir(), port: 0 });
  await host.start(); t.after(() => host.stop());
  const url = `http://127.0.0.1:${host.server.address().port}/api/youtube/cookies`;
  const post = headers => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ cookies: "x" }) });
  assert.equal((await post({ "x-video-pilot-relay": "1" })).status, 403);
  assert.equal(library.saved, undefined);
  assert.equal((await post({})).status, 200);
  assert.equal(library.saved, "x");
});
