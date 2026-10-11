import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createVideoPilotServer } from "../src/server.mjs";

test("serves the Tesla UI, library API, and indexed MPEG-TS seek", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vp-server-"));
  const web = path.join(root, "web"); await mkdir(web); await writeFile(path.join(web, "index.html"), "player");
  const media = path.join(root, "video.ts"); await writeFile(media, Buffer.alloc(188 * 20, 7));
  const seek = path.join(root, "video.seek.json"); await writeFile(seek, JSON.stringify({ points: [{ time: 10, offset: 1880 }] }));
  const item = { id: "00000000-0000-4000-8000-000000000000", state: "ready" };
  const library = {
    videos: [item], queue: [], active: null, settings: { quality: 720 }, history: [],
    get: id => id === item.id ? item : null, paths: () => ({ media, seek }), queueView: () => [],
    recordHistory: async value => { library.history.push({ libraryId: value.id }); },
  };
  const host = createVideoPilotServer({ library, webRoot: web, port: 0 });
  await host.start(); t.after(() => host.stop());
  const port = host.server.address().port;
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "player");
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/api/library`)).json(), [item]);
  const response = await fetch(`http://127.0.0.1:${port}/api/stream/${item.id}.ts?seek=12`);
  assert.equal(response.headers.get("x-mk8-seek-offset"), "1880");
  assert.equal((await response.arrayBuffer()).byteLength, 1880);
});
