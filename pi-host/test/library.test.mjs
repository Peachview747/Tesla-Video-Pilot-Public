import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Library, parseYouTubeID } from "../src/library.mjs";

test("parses the supported YouTube link forms", () => {
  assert.equal(parseYouTubeID("dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(parseYouTubeID("https://youtu.be/dQw4w9WgXcQ?t=3"), "dQw4w9WgXcQ");
  assert.equal(parseYouTubeID("https://youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(parseYouTubeID("not a video"), null);
});

test("persists queue state and creates a seekable prepared item", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vp-library-"));
  let library;
  const runner = async (command, args) => {
    if (args.includes("--dump-single-json")) return { stdout: JSON.stringify({ title: "Test video", duration: 42, channel: "Channel", channel_id: "UC123", upload_date: "20260102" }) };
    if (command === "yt-dlp") { await writeFile(library.paths(library.active).source, "source"); return { stdout: "" }; }
    if (command === "ffmpeg") { await writeFile(library.paths(library.active).temporary, Buffer.alloc(188 * 10, 0x47)); return { stdout: "" }; }
    if (command === "ffprobe") return { stdout: "0.000000,0,K_\n10.000000,940,K_\n" };
    throw new Error(`unexpected ${command}`);
  };
  library = await new Library({ dataDir, runner, ytDlp: "yt-dlp", ffmpeg: "ffmpeg", ffprobe: "ffprobe" }).init();
  const video = await library.enqueue("dQw4w9WgXcQ");
  while (library.active || library.queue.length) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(library.get(video.id).state, "ready");
  assert.equal(library.get(video.id).title, "Test video");
  const index = JSON.parse(await readFile(library.paths(video.id).seek, "utf8"));
  assert.equal(index.points.length, 2);
  const restored = await new Library({ dataDir, runner }).init();
  assert.equal(restored.get(video.id).state, "ready");
});

test("turns interrupted preparation into a retryable item", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vp-restart-"));
  await writeFile(path.join(dataDir, "library.json"), JSON.stringify([{ id: "00000000-0000-4000-8000-000000000000", state: "preparing" }]));
  const library = await new Library({ dataDir }).init();
  assert.equal(library.videos[0].state, "paused");
});

test("maps yt-dlp search results for the existing Tesla cards", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vp-search-"));
  const runner = async () => ({ stdout: JSON.stringify({ entries: [
    { id: "dQw4w9WgXcQ", title: "Result", channel: "Channel", duration: 62 },
  ] }) });
  const library = await new Library({ dataDir, runner }).init();
  assert.deepEqual(await library.search("music"), [{ id: "dQw4w9WgXcQ", title: "Result", channel: "Channel",
    channelId: null, thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg",
    duration: "1:02", views: null, published: null }]);
});
