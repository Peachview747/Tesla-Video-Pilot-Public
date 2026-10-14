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
    if (command === "yt-dlp") { await writeFile(args[args.indexOf("--output") + 1], "source"); return { stdout: "" }; }
    if (command === "ffmpeg") { await writeFile(args.at(-1), Buffer.alloc(188 * 10, 0x47)); return { stdout: "" }; }
    if (command === "ffprobe" && args.includes("json")) return {stdout:JSON.stringify({streams:[{width:1280,height:720}]})};
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

test("queue view lists the active video first in the shape the Downloads tab reads", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vp-queue-"));
  const library = await new Library({ dataDir }).init();
  library.videos.push({ id: "a", title: "A", youtubeID: "aaaaaaaaaaa", state: "preparing", message: "Preparing 720p for the Tesla browser…" },
    { id: "b", title: "B", youtubeID: "bbbbbbbbbbb", state: "preparing", message: "Waiting on the Raspberry Pi…" });
  library.active = "a"; library.queue = ["b"];
  assert.deepEqual(library.queueView(), { items: [
    { id: "a", title: "A", videoId: "aaaaaaaaaaa", stage: "transcoding" },
    { id: "b", title: "B", videoId: "bbbbbbbbbbb", stage: "queued" }] });
});

test("search suggestions come from YouTube autocomplete and are cached", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vp-suggest-"));
  const urls = [];
  const fetcher = async url => { urls.push(url); return { ok: true, json: async () => ["tesla mod", ["tesla model y", "tesla model 3", 7]] }; };
  const library = await new Library({ dataDir, fetcher }).init();
  assert.deepEqual(await library.suggest("Tesla Mod"), ["tesla model y", "tesla model 3"]);
  assert.deepEqual(await library.suggest("tesla mod"), ["tesla model y", "tesla model 3"]);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /ds=yt&q=tesla%20mod$/);
  assert.deepEqual(await library.suggest("t"), []);
});

test("library items gain their channel avatar after a background lookup", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vp-avatar-"));
  const calls = [];
  const runner = async (command, args) => {
    calls.push(args.at(-1));
    return { stdout: JSON.stringify({ channel: "Chan", channel_follower_count: 3820000, thumbnails: [
      { id: "banner_uncropped", url: "https://yt3.googleusercontent.com/banner=s0" },
      { id: "avatar_uncropped", url: "https://yt3.googleusercontent.com/ytc/abc=s0" }] }) };
  };
  const library = await new Library({ dataDir, runner }).init();
  library.videos.push({ id: "v", channelId: "UCtMVHI3AJD4Qk4hcbZnI9ZQ", state: "ready" }); await library.save();
  assert.equal(library.libraryView()[0].channelAvatar, undefined);
  await library.channelLookup;
  assert.equal(library.libraryView()[0].channelAvatar, "https://yt3.googleusercontent.com/ytc/abc=s176-c-k-c0x00ffffff-no-rj");
  assert.equal(library.channels.UCtMVHI3AJD4Qk4hcbZnI9ZQ.subscribers, "3.82M subscribers");
  assert.deepEqual(calls, ["https://www.youtube.com/channel/UCtMVHI3AJD4Qk4hcbZnI9ZQ"], "fresh entries are not looked up again");
  const restored = await new Library({ dataDir, runner }).init();
  assert.ok(restored.libraryView()[0].channelAvatar, "avatars persist across restarts");
});

test("subscriptions need sign-in cookies and then read the YouTube feed with them", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vp-subs-"));
  const calls = [];
  const runner = async (command, args) => {
    calls.push(args);
    if (args.at(-1).endsWith("/feed/channels")) return { stdout: JSON.stringify({ entries: [
      { id: "UCmKLlnlZn3dBFu2UdKxhTXQ", title: "Zed", channel_follower_count: 78300, thumbnails: [{ url: "//yt3.googleusercontent.com/a=s176-c" }] },
      { id: "UCOt5hVyS2-nbcJ3_FP41Ajg", title: "alpha", thumbnails: [{ url: "https://evil.example/x.png" }] }] }) };
    return { stdout: JSON.stringify({ entries: [{ id: "dQw4w9WgXcQ", title: "New upload", channel: "Chan" },
      { id: "aaaaaaaaaaa", title: "Old stream", live_status: "was_live" }, { id: "bbbbbbbbbbb", title: "On air", live_status: "is_live" }] }) };
  };
  const library = await new Library({ dataDir, runner }).init();
  assert.deepEqual(await library.subscriptions(), { signedIn: false, videos: [] });
  await assert.rejects(library.saveCookies(".youtube.com\tTRUE\t/\tTRUE\t0\tPREF\tx"), /not signed in/);
  await library.saveCookies(".youtube.com\tTRUE\t/\tTRUE\t0\tSAPISID\tabc");
  assert.equal(await library.signedIn(), true);
  const feed = await library.subscriptions();
  assert.equal(feed.videos[0].title, "New upload");
  assert.deepEqual(feed.videos.map(video => [video.id, video.stream || false]), [["dQw4w9WgXcQ", false], ["aaaaaaaaaaa", true]],
    "finished streams are kept and marked; live ones are left out");
  assert.ok(calls[0].includes(library.cookiesFile) && calls[0].includes("https://www.youtube.com/feed/subscriptions"));
  assert.deepEqual(feed.channels, [
    { id: "UCOt5hVyS2-nbcJ3_FP41Ajg", name: "alpha", avatar: null, subscribers: null },
    { id: "UCmKLlnlZn3dBFu2UdKxhTXQ", name: "Zed", avatar: "https://yt3.googleusercontent.com/a=s176-c", subscribers: "78.3K subscribers" }],
    "followed channels are sorted by name and only YouTube image hosts are kept");
  await library.subscriptions();
  assert.equal(calls.length, 2, "the feed is cached");
  const recommended = await library.recommended();
  assert.ok(calls.at(-1).includes(":ytrec") && calls.at(-1).includes(library.cookiesFile), "recommendations use the account's YouTube home");
  assert.deepEqual(recommended.map(video => video.id), ["dQw4w9WgXcQ", "aaaaaaaaaaa"], "live videos are left out");
  await library.clearCookies();
  assert.equal(await library.signedIn(), false);
  assert.equal(await library.recommended(), null);
});

test("upgrades stop at the source quality and downgrades keep the smaller copy", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vp-quality-"));
  const library = await new Library({ dataDir, runner: async () => ({ stdout: "" }) }).init();
  const id = "00000000-0000-4000-8000-000000000001";
  library.videos.push({ id: "00000000-0000-4000-8000-000000000002", state: "ready", quality: 720, sourceHeight: 720, youtubeID: "aaaaaaaaaaa" },
    { id, state: "ready", quality: 1080, mediaQuality: 1080, sourceHeight: 1080, qualities: [360, 540, 720, 1080], youtubeID: "bbbbbbbbbbb" });
  assert.equal(await library.upgrade("00000000-0000-4000-8000-000000000002", 1080), false, "YouTube only has 720p");
  for (const quality of [720, 1080]) {
    const files = library.paths(id, quality);
    await writeFile(files.media, "ts"); await writeFile(files.seek, "{}");
  }
  const big = library.paths(id, 1080), small = library.paths(id, 720);
  assert.equal(await library.downgrade(id, 720), true);
  const video = library.get(id);
  assert.deepEqual([video.quality, video.qualities], [720, [360, 540, 720]]);
  assert.equal(library.paths(id).media, small.media, "playback now uses the 720p file");
  await assert.rejects(readFile(big.media), "the 1080p file is deleted");
  assert.equal(await readFile(small.media, "utf8"), "ts");
  assert.equal(await library.downgrade(id, 720), false, "nothing to do at the target");
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

test("1080p upgrades preserve the playable 720p copy and create smaller local qualities", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "vp-quality-"));
  let downloads = 0;
  const runner = async (command, args) => {
    if (args.includes("--dump-single-json")) return {stdout:JSON.stringify({title:"Test",duration:30})};
    if (command === "yt-dlp") { downloads++; await writeFile(args[args.indexOf("--output")+1], "source"); return {stdout:""}; }
    if (command === "ffmpeg") { await writeFile(args.at(-1), "new encoded copy"); return {stdout:""}; }
    if (args.includes("json")) return {stdout:JSON.stringify({streams:[{height:1080}]})};
    return {stdout:"0,0,K_\n10,188,K_\n"};
  };
  const library = await new Library({dataDir,runner}).init();
  const video = {id:"00000000-0000-4000-8000-000000000001", youtubeID:"dQw4w9WgXcQ",state:"ready",quality:720};
  library.videos.push(video);
  const original = library.paths(video.id);
  await writeFile(original.media,"old playable video"); await writeFile(original.seek,'{"points":[{"time":0,"offset":0}]}');
  await library.setQuality("1080p");
  assert.equal(await library.upgrade(video.id),true);
  assert.equal(video.state,"ready"); assert.equal(video.quality,720);
  assert.equal(await library.upgrade(video.id),false, "an upgrade is queued only once");
  while(library.active || library.queue.length) await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(video.state,"ready"); assert.equal(video.quality,1080); assert.equal(video.upgrading,false);
  assert.equal((await library.qualityStatus(video.id,1080)).ready,true);
  assert.equal((await library.qualityStatus(video.id,720)).ready,true);
  assert.equal(await readFile(original.media,"utf8"),"old playable video");
  await library.requestQuality(video.id,360);
  while(!(await library.qualityStatus(video.id,360)).ready) await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(downloads,1, "lower qualities are prepared locally without another download");
  assert.notEqual(library.paths(video.id,360).seek,library.paths(video.id,1080).seek);
});

test("an unavailable 1080p source leaves the existing video ready", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(),"vp-quality-fail-"));
  const runner = async (command,args) => {
    if(args.includes("--dump-single-json")) return {stdout:'{"duration":30}'};
    if(command === "yt-dlp") {await writeFile(args[args.indexOf("--output")+1],"source"); return {stdout:""};}
    if(args.includes("json")) return {stdout:'{"streams":[{"height":720}]}'};
    throw new Error("Should not re-encode a low-resolution source as 1080p");
  };
  const library = await new Library({dataDir,runner}).init();
  const video={id:"00000000-0000-4000-8000-000000000002",youtubeID:"dQw4w9WgXcQ",state:"ready",quality:720};
  library.videos.push(video);
  const files=library.paths(video.id);
  await writeFile(files.media,"keep");await writeFile(files.seek,'{"points":[]}');
  await library.upgrade(video.id,1080);
  while(library.active || library.queue.length) await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(video.state,"ready");assert.equal(video.quality,720);
  assert.match(video.upgradeError,/only 720p/);
  assert.equal(await readFile(files.media,"utf8"),"keep");
});
