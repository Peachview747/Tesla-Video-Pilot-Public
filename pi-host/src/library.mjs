import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {QUALITIES, parseQuality, encodeArgs} from "./quality.mjs";

// onLine receives stdout line by line (progress readers) instead of keeping it.
// signal cancels the whole process group, so yt-dlp's own ffmpeg (merging
// video and audio) stops with it instead of writing on after a cancel.
export function run(command, args, { onLine, signal, ...options } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const child = spawn(command, args, { ...options, detached: Boolean(signal), stdio: ["ignore", "pipe", "pipe"] });
    const abort = () => { try { process.kill(-child.pid, "SIGTERM"); } catch {} reject(signal.reason); };
    signal?.addEventListener("abort", abort, { once: true });
    child.once("close", () => signal?.removeEventListener("abort", abort));
    let stdout = "", stderr = "", partial = "";
    child.stdout?.on("data", chunk => {
      if (!onLine) { stdout += chunk; return; }
      const lines = (partial + chunk).split("\n"); partial = lines.pop();
      for (const line of lines) onLine(line);
    });
    child.stderr?.on("data", chunk => { stderr = (stderr + chunk).slice(-32_000); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve({ stdout, stderr })
      : reject(new Error(`${command} exited ${code}: ${stderr.trim()}`)));
  });
}

export class Library {
  constructor({ dataDir, ytDlp = "yt-dlp", ffmpeg = "ffmpeg", ffprobe = "ffprobe", runner = run, fetcher = globalThis.fetch }) {
    this.dataDir = dataDir;
    this.mediaDir = path.join(dataDir, "media");
    this.indexFile = path.join(dataDir, "library.json");
    this.settingsFile = path.join(dataDir, "settings.json");
    this.historyFile = path.join(dataDir, "history.json");
    this.channelsFile = path.join(dataDir, "channels.json");
    this.cookiesFile = path.join(dataDir, "youtube-cookies.txt");
    this.diagnosticsFile = path.join(dataDir, "diagnostics.jsonl");
    this.queueFile = path.join(dataDir, "queue.json");
    this.ytDlp = ytDlp;
    this.ffmpeg = ffmpeg;
    this.ffprobe = ffprobe;
    this.runner = runner;
    this.fetcher = fetcher;
    this.suggestCache = new Map();
    this.subscriptionCache = null;
    this.videos = [];
    this.settings = { quality: 720 };
    this.history = [];
    this.channels = {};
    this.channelLookups = new Set();
    this.queue = [];
    this.active = null;
    this.activeJob = null;
    this.progress = null;
    this.lastPreparation = null;
    this.revision = 0;
    this.listeners = new Set();
    this.variantJobs = new Map();
    this.mediaWork = Promise.resolve();
  }

  async init() {
    await mkdir(this.mediaDir, { recursive: true });
    try { this.videos = JSON.parse(await readFile(this.indexFile, "utf8")); } catch { this.videos = []; }
    try { this.settings = { ...this.settings, ...JSON.parse(await readFile(this.settingsFile, "utf8")) }; } catch {}
    try { this.history = JSON.parse(await readFile(this.historyFile, "utf8")); } catch { this.history = []; }
    try { this.channels = JSON.parse(await readFile(this.channelsFile, "utf8")) || {}; } catch { this.channels = {}; }
    // A restart (or a deploy) picks the queue up where it stopped; drain()
    // starts it once the server is listening.
    let savedQueue = [];
    try { savedQueue = JSON.parse(await readFile(this.queueFile, "utf8")); } catch {}
    const waiting = [];
    for (const video of this.videos) {
      // sourceLimit (one day old) was set from height alone, so widescreen
      // films looked low-resolution; sourceMax replaces it.
      delete video.sourceLimit;
      if (video.upgrading && !video.upgradeQuality) video.upgrading = false;
      if (video.upgrading) { video.message = `Waiting to upgrade to ${video.upgradeQuality}p…`; waiting.push(video.id); }
      if (video.state === "preparing") { video.message = "Waiting on the Raspberry Pi…"; waiting.push(video.id); }
    }
    const order = id => { const index = Array.isArray(savedQueue) ? savedQueue.indexOf(id) : -1; return index < 0 ? Infinity : index; };
    this.queue = waiting.reverse().sort((a, b) => order(a) - order(b));
    await this.removeLeftovers(name => /\.source\.|\.working\.ts$/.test(name));
    await this.save();
    return this;
  }

  // Partial downloads (yt-dlp's .part and per-format files) and unfinished
  // encodes; a failed or cancelled job must not leave gigabytes behind.
  async removeLeftovers(match) {
    const names = await readdir(this.mediaDir).catch(() => []);
    await Promise.all(names.filter(match).map(name => rm(path.join(this.mediaDir, name), { force: true })));
  }

  onChange(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  notify() { this.revision++; for (const listener of this.listeners) listener(); }

  async atomicJSON(file, value) {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, file);
  }
  async save() {
    await this.atomicJSON(this.indexFile, this.videos);
    await this.atomicJSON(this.queueFile, [this.active, ...this.queue].filter(Boolean));
    this.notify();
  }
  async saveSettings() { await this.atomicJSON(this.settingsFile, this.settings); this.notify(); }
  async saveHistory() { await this.atomicJSON(this.historyFile, this.history.slice(0, 300)); this.notify(); }

  // Every yt-dlp call: Node solves YouTube's JavaScript challenges (without a
  // runtime many formats 403), and the signed-in cookies are used when present.
  ytArgs() {
    return ["--js-runtimes", `node:${process.execPath}`, ...(existsSync(this.cookiesFile) ? ["--cookies", this.cookiesFile] : [])];
  }

  async signedIn() {
    try { return /\t(SAPISID|__Secure-3PSID)\t/.test(await readFile(this.cookiesFile, "utf8")); } catch { return false; }
  }

  async saveCookies(text) {
    const cookies = String(text || "").trim();
    if (!/\t(SAPISID|__Secure-3PSID)\t/.test(cookies)) throw new Error("Those cookies are not signed in to YouTube.");
    await writeFile(this.cookiesFile, cookies + "\n", { mode: 0o600 });
    this.subscriptionCache = null; this.recommendedCache = null; this.channelListCache = null;
    this.notify();
  }

  async clearCookies() {
    await unlink(this.cookiesFile).catch(() => {});
    this.subscriptionCache = null; this.recommendedCache = null; this.channelListCache = null;
    this.notify();
  }

  // Newest uploads from subscribed channels; cached briefly because each
  // fetch is a full YouTube page load on the Pi.
  async subscriptions({ refresh = false } = {}) {
    if (!await this.signedIn()) return { signedIn: false, videos: [] };
    if (!refresh && this.subscriptionCache && Date.now() - this.subscriptionCache.at < 10 * 60_000) return this.subscriptionCache.value;
    const result = await this.runner(this.ytDlp, [...this.ytArgs(), "--flat-playlist", "--playlist-end", "60", "--dump-single-json",
      "https://www.youtube.com/feed/subscriptions"]);
    const value = { signedIn: true, videos: mapEntries(JSON.parse(result.stdout).entries) };
    this.subscriptionCache = { at: Date.now(), value };
    return value;
  }

  // Every channel the account follows, A to Z: the Subscriptions tab is a
  // directory for finding someone, so there is no cap.
  async followedChannels({ refresh = false } = {}) {
    if (!await this.signedIn()) return { signedIn: false, channels: [] };
    if (!refresh && this.channelListCache && Date.now() - this.channelListCache.at < 30 * 60_000) return this.channelListCache.value;
    const result = await this.runner(this.ytDlp, [...this.ytArgs(), "--flat-playlist", "--playlist-end", "5000", "--dump-single-json",
      "https://www.youtube.com/feed/channels"]);
    const channels = mapChannels(JSON.parse(result.stdout).entries)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    const value = { signedIn: true, channels };
    this.channelListCache = { at: Date.now(), value };
    return value;
  }

  // The signed-in account's YouTube home feed (what youtube.com recommends
  // from watch history), cached like the subscriptions feed.
  async recommended({ refresh = false } = {}) {
    if (!await this.signedIn()) return null;
    if (!refresh && this.recommendedCache && Date.now() - this.recommendedCache.at < 15 * 60_000) return this.recommendedCache.videos;
    const result = await this.runner(this.ytDlp, [...this.ytArgs(), "--flat-playlist", "--playlist-end", "40", "--dump-single-json", ":ytrec"]);
    const videos = mapEntries(JSON.parse(result.stdout).entries);
    this.recommendedCache = { at: Date.now(), videos };
    return videos;
  }

  get(id) { return this.videos.find(video => video.id.toLowerCase() === String(id).toLowerCase()); }
  paths(id, quality = null) {
    const video = this.get(id);
    const selected = quality === null ? video?.mediaQuality : parseQuality(quality);
    const legacy = selected === video?.legacyQuality || (!video?.mediaQuality && selected === video?.quality);
    const safe = String(id).toLowerCase() + (selected && !legacy ? `.${selected}` : "");
    return {
      source: path.join(this.mediaDir, `${safe}.source.mp4`),
      temporary: path.join(this.mediaDir, `${safe}.working.ts`),
      media: path.join(this.mediaDir, `${safe}.ts`),
      seek: path.join(this.mediaDir, `${safe}.seek.json`),
    };
  }

  async enqueue(input, details = {}) {
    const id = randomUUID();
    const youtubeID = parseYouTubeID(input);
    if (!youtubeID) throw new Error("Enter a valid YouTube URL or video ID.");
    const existing = this.videos.find(item => item.youtubeID === youtubeID);
    if (existing) {
      if (["failed", "paused"].includes(existing.state)) await this.retry(existing.id);
      return existing;
    }
    const video = {
      id, title: details.title || `YouTube ${youtubeID}`, youtubeID, state: "preparing",
      message: "Waiting on the Raspberry Pi…", duration: null, createdAt: new Date().toISOString(),
      channel: details.channel || null, publishedAt: null, channelId: details.channelId || null,
      quality: this.settings.quality,
    };
    this.videos.unshift(video);
    this.queue.push(id);
    await this.save();
    this.drain();
    return video;
  }

  async retry(id) {
    const video = this.get(id);
    if (!video || !["failed", "paused"].includes(video.state)) throw new Error("That video is not waiting for a retry.");
    video.state = "preparing";
    video.message = "Waiting on the Raspberry Pi…";
    this.queue.push(video.id);
    await this.save();
    this.drain();
  }

  // The best a video can reach is capped by what YouTube offers for it.
  // sourceHeight is only the downloaded file's height (the format request
  // caps it), so only sourceMax, set when YouTube came back short, caps.
  reachable(video, quality) {
    const source = Number(video.sourceMax);
    return source > 0 ? Math.min(quality, QUALITIES.filter(value => value <= source).at(-1) || QUALITIES[0]) : quality;
  }

  async upgrade(id, requested = this.settings.quality) {
    const video = this.get(id);
    if (!video || video.state !== "ready") throw new Error("That video is not ready to upgrade.");
    const quality = this.reachable(video, parseQuality(requested));
    if ((video.quality || 0) >= quality || video.upgrading) return false;
    video.upgrading = true; video.upgradeQuality = quality; video.upgradeError = null;
    video.message = `Waiting to upgrade to ${quality}p…`;
    this.queue.push(video.id);
    await this.save();
    this.drain();
    return true;
  }

  // Keep the smaller copy (prepared in the background after every download)
  // and delete the larger files to free space. Upgrading again re-downloads.
  async downgrade(id, requested = this.settings.quality) {
    const video = this.get(id);
    if (!video || video.state !== "ready") throw new Error("That video is not ready.");
    const quality = parseQuality(requested);
    if ((video.quality || 0) <= quality || video.upgrading || this.active === video.id) return false;
    let status = await this.qualityStatus(video.id, quality);
    if (!status.ready) {
      await this.requestQuality(video.id, quality);
      await this.variantJobs.get(`${video.id}:${quality}`)?.promise;
      status = await this.qualityStatus(video.id, quality);
      if (!status.ready) throw new Error(`The ${quality}p copy could not be prepared.`);
    }
    const larger = QUALITIES.filter(value => value > quality).flatMap(value => Object.values(this.paths(video.id, value)));
    const keep = new Set(Object.values(this.paths(video.id, quality)));
    video.quality = quality; video.mediaQuality = quality;
    if (video.legacyQuality > quality) delete video.legacyQuality;
    video.qualities = (video.qualities || []).filter(value => value <= quality);
    await this.save();
    await Promise.all([...new Set(larger)].filter(file => !keep.has(file)).map(file => rm(file, { force: true })));
    return true;
  }

  async move(id, to) {
    const index = this.queue.indexOf(id);
    if (index < 0) throw new Error("That item is no longer queued.");
    const [item] = this.queue.splice(index, 1);
    this.queue.splice(Math.max(0, Math.min(this.queue.length, Number(to) || 0)), 0, item);
    await this.save();
  }

  // Cancel stops the running download or encode too. A cancelled upgrade
  // leaves the video as it was: ready, at its current quality.
  async cancelQueued(id) {
    const video = this.get(id);
    if (video && this.active === video.id) { await this.stopActive(); return; }
    const index = this.queue.indexOf(video?.id ?? id);
    if (index < 0) throw new Error("That item is no longer queued.");
    this.queue.splice(index, 1);
    if (video?.upgrading) { video.upgrading = false; video.upgradeQuality = null; video.message = null; }
    else if (video) { video.state = "paused"; video.message = "Preparation paused. Tap Retry when ready."; }
    await this.save();
  }

  async stopActive() {
    const job = this.activeJob;
    if (!job) return;
    job.controller.abort();
    await job.done;
  }

  async remove(id) {
    const video = this.get(id);
    if (!video) return false;
    if (this.active === video.id) await this.stopActive();
    if ([...this.variantJobs.entries()].some(([key, job]) => key.startsWith(video.id + ":") && job.state === "preparing")) throw new Error("Wait for quality preparation to finish before removing this video.");
    const files = [...Object.values(this.paths(video.id)), ...QUALITIES.flatMap(quality => Object.values(this.paths(video.id, quality)))];
    this.queue = this.queue.filter(item => item !== video.id);
    this.videos = this.videos.filter(item => item !== video);
    await Promise.all([...new Set(files)].map(file => rm(file, { force: true })));
    await this.save();
    return true;
  }

  async setQuality(value) {
    const quality = parseQuality(value);
    this.settings.quality = quality;
    await this.saveSettings();
  }

  // One encode at a time. A cancelled job leaves the line at once instead of
  // waiting for the encodes ahead of it.
  mediaTask(task, signal) {
    const promise = this.mediaWork.then(() => { signal?.throwIfAborted(); return task(); });
    this.mediaWork = promise.catch(() => {});
    if (!signal) return promise;
    return Promise.race([promise, new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })]);
  }

  async qualityStatus(id, value) {
    const video = this.get(id), quality = parseQuality(value);
    if (!video || video.state !== "ready") throw new Error("Video is not ready.");
    const job = this.variantJobs.get(`${video.id}:${quality}`);
    const files = this.paths(video.id, quality);
    const ready = quality <= video.quality && await Promise.all([stat(files.media), stat(files.seek)]).then(() => true, () => false);
    return {quality, ready, maximum:video.quality, upgrading:Boolean(video.upgrading),
      error:job?.error || (quality > video.quality ? video.upgradeError : null) || null,
      requiresDownload:quality > video.quality};
  }

  async requestQuality(id, value) {
    const video = this.get(id), status = await this.qualityStatus(id, value);
    if (status.ready) return status;
    if (status.requiresDownload) {
      await this.upgrade(id, status.quality);
      return {...status, upgrading:true, error:null};
    }
    const key = `${video.id}:${status.quality}`;
    if (this.variantJobs.get(key)?.state === "preparing") return status;
    const job = {state:"preparing", error:null}; this.variantJobs.set(key, job);
    const input = this.paths(video.id).media, files = this.paths(video.id, status.quality);
    job.promise = this.mediaTask(async () => {
      await this.runner(this.ffmpeg, encodeArgs(input, files.temporary, status.quality));
      await rename(files.temporary, files.media);
      await this.buildSeekIndex(video, files);
      job.state = "ready";
      video.qualities = [...new Set([...(video.qualities || []), video.quality, status.quality])].sort((a,b) => a-b);
      await this.save();
    }).catch(async error => {
      job.state = "failed"; job.error = String(error.message || error).slice(0,500);
      await rm(files.temporary, {force:true});
    });
    return {...status, error:null};
  }

  warmQualities() {
    for (const video of this.videos.filter(item => item.state === "ready")) {
      for (const quality of QUALITIES.filter(value => value < video.quality)) this.requestQuality(video.id, quality).catch(() => {});
    }
  }

  async recordHistory({ id, position, duration, finished }) {
    const video = this.get(id);
    if (!video) throw new Error("That library item no longer exists.");
    const key = video.youtubeID || video.id;
    const previous = this.history.find(item => item.key === key);
    this.history = this.history.filter(item => item.key !== key);
    const length = Number(duration) > 0 ? Number(duration) : video.duration;
    const place = finished && length ? length : Math.max(0, Number(position) || 0);
    this.history.unshift({ key, libraryId: video.id, youtubeID: video.youtubeID, title: video.title,
      channel: video.channel, channelId: video.channelId, position: place, duration: length,
      watchedAt: new Date().toISOString(), plays: (previous?.plays || 0) + (previous ? 0 : 1) });
    await this.saveHistory();
  }

  historyView(limit = 50) {
    return { items: this.history.slice(0, Math.max(1, Math.min(300, limit))).map(item => {
      const video = this.get(item.libraryId);
      return { ...item, libraryId: video?.id || null,
        thumbnail: item.youtubeID ? `https://i.ytimg.com/vi/${item.youtubeID}/mqdefault.jpg` : null,
        progress: item.duration ? Math.min(1, item.position / item.duration) : null,
        inLibrary: Boolean(video), state: video?.state || null };
    }) };
  }

  // filter: the Home search chips (length, this week, newest), as YouTube's
  // own results-page filters.
  async search(query, limit = 20, filter = "any") {
    const text = String(query || "").trim();
    if (!text || text.length > 200) throw new Error("Enter a search of up to 200 characters.");
    const sp = SEARCH_FILTERS[filter];
    const target = sp ? ["--playlist-end", String(limit), `https://www.youtube.com/results?${new URLSearchParams({ search_query: text, sp })}`]
      : [`ytsearch${limit}:${text}`];
    const result = await this.runner(this.ytDlp, [...this.ytArgs(), "--flat-playlist", "--dump-single-json", ...target]);
    const object = JSON.parse(result.stdout);
    return mapEntries(object.entries);
  }

  // Channels for a search, in YouTube's relevance order (closest match first),
  // so searching a creator's name can lead straight to their channel.
  async searchChannels(query, limit = 4) {
    const text = String(query || "").trim();
    if (!text || text.length > 200) return [];
    const params = new URLSearchParams({ search_query: text, sp: "EgIQAg==" }); // YouTube's "Channels" filter
    const result = await this.runner(this.ytDlp, [...this.ytArgs(), "--flat-playlist", "--playlist-end", String(limit), "--dump-single-json",
      `https://www.youtube.com/results?${params}`]);
    return mapChannels(JSON.parse(result.stdout).entries).slice(0, limit);
  }

  // Playback events from the car's browser (stream received, completed,
  // ended, positions), kept so car-only bugs can be read on the Pi. Capped:
  // past 2 MB only the newer half is kept.
  async recordDiagnostics(events) {
    const list = (Array.isArray(events) ? events : []).slice(0, 200);
    const received = new Date().toISOString();
    const lines = list.map(event => JSON.stringify({ received, ...event }).slice(0, 4000)).join("\n");
    if (lines) await appendFile(this.diagnosticsFile, lines + "\n", { mode: 0o600 });
    const size = await stat(this.diagnosticsFile).then(info => info.size, () => 0);
    if (size > 2 * 1024 * 1024) {
      const text = await readFile(this.diagnosticsFile, "utf8");
      await writeFile(this.diagnosticsFile, text.slice(text.indexOf("\n", text.length / 2) + 1), { mode: 0o600 });
    }
    return list.length;
  }

  async diagnosticsText(limit = 500) {
    const text = await readFile(this.diagnosticsFile, "utf8").catch(() => "");
    return text.trim().split("\n").filter(Boolean).slice(-limit).join("\n");
  }

  // YouTube's own autocomplete, so the car never needs to paste a link.
  async suggest(query) {
    const text = String(query || "").trim().toLowerCase();
    if (text.length < 2 || text.length > 100) return [];
    if (this.suggestCache.has(text)) return this.suggestCache.get(text);
    const url = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(text)}`;
    const response = await this.fetcher(url, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return [];
    const body = await response.json();
    const items = Array.isArray(body?.[1]) ? body[1].filter(item => typeof item === "string").slice(0, 8) : [];
    if (this.suggestCache.size > 200) this.suggestCache.delete(this.suggestCache.keys().next().value);
    this.suggestCache.set(text, items);
    return items;
  }

  async channel(id) {
    if (!/^UC[A-Za-z0-9_-]{20,30}$/.test(String(id || ""))) throw new Error("That channel could not be found.");
    const result = await this.runner(this.ytDlp, [...this.ytArgs(), "--flat-playlist", "--playlist-end", "30", "--dump-single-json",
      `https://www.youtube.com/channel/${id}/videos`]);
    const object = JSON.parse(result.stdout);
    const info = await this.rememberChannel(id, object);
    return { channel: { id, name: info.name || "YouTube channel", handle: object.uploader_id || object.channel_url || null,
      avatar: info.avatar, subscribers: info.subscribers }, videos: mapEntries(object.entries), continuation: null };
  }

  async rememberChannel(id, object) {
    const followers = Number(object.channel_follower_count);
    const info = { name: object.channel || object.uploader || object.title || null, avatar: channelAvatar(object.thumbnails),
      subscribers: followers > 0 ? `${compactCount(followers)} subscribers` : null, fetchedAt: Date.now() };
    this.channels[id] = info;
    await this.atomicJSON(this.channelsFile, this.channels);
    return info;
  }

  // Library items carry their channel's avatar. Missing or week-old entries
  // are looked up one at a time in the background so the list never waits.
  libraryView() {
    const stale = Date.now() - 7 * 86_400_000;
    for (const id of new Set(this.videos.map(video => video.channelId).filter(Boolean))) {
      if (!this.channels[id] || this.channels[id].fetchedAt < stale) this.channelLookups.add(id);
    }
    this.lookUpChannels();
    return this.videos.map(video => {
      const avatar = video.channelId ? this.channels[video.channelId]?.avatar : null;
      return avatar ? { ...video, channelAvatar: avatar } : video;
    });
  }

  lookUpChannels() {
    if (this.channelLookup || !this.channelLookups.size) return;
    const id = this.channelLookups.values().next().value;
    this.channelLookups.delete(id);
    this.channelLookup = this.runner(this.ytDlp, [...this.ytArgs(), "--flat-playlist", "--playlist-end", "1", "--dump-single-json",
      `https://www.youtube.com/channel/${id}`])
      .then(result => this.rememberChannel(id, JSON.parse(result.stdout)))
      .catch(() => { this.channels[id] = { ...this.channels[id], fetchedAt: Date.now() }; })
      .finally(() => { this.channelLookup = null; this.lookUpChannels(); });
  }

  drain() {
    if (this.active || this.queue.length === 0) return;
    const id = this.queue.shift();
    const controller = new AbortController();
    this.active = id;
    const job = { id, controller };
    job.done = this.prepare(id, controller.signal).catch(() => {})
      .finally(() => { this.active = null; this.activeJob = null; this.progress = null; this.drain(); });
    this.activeJob = job;
  }

  async prepare(id, signal) {
    const video = this.get(id);
    if (!video) return;
    const targetQuality = video.upgradeQuality || video.quality || this.settings.quality;
    const previousQuality = video.quality, previousMediaQuality = video.mediaQuality;
    const wasReady = video.state === "ready";
    let files = this.paths(id, targetQuality);
    const source = files.source;
    const url = `https://www.youtube.com/watch?v=${video.youtubeID}`;
    const stats = { quality: null };
    this.progress = { id: video.id, stage: "downloading", fraction: null, speed: null, remaining: null };
    try {
      video.message = "Reading YouTube details…";
      await this.save();
      const metadataResult = await this.runner(this.ytDlp, [...this.ytArgs(), "--dump-single-json", "--no-playlist", url], { signal });
      const metadata = JSON.parse(metadataResult.stdout);
      video.title = metadata.title || video.title;
      video.channel = metadata.channel || metadata.uploader || video.channel;
      video.channelId = metadata.channel_id || video.channelId;
      video.publishedAt = metadata.upload_date ? `${metadata.upload_date.slice(0,4)}-${metadata.upload_date.slice(4,6)}-${metadata.upload_date.slice(6,8)}` : null;
      video.duration = Number(metadata.duration) || null;
      video.message = "Downloading to the Raspberry Pi…";
      await this.save();
      let height = parseQuality(targetQuality);
      const format = `bestvideo[height<=${height}][vcodec^=avc1]+bestaudio[ext=m4a]/best[height<=${height}][ext=mp4]/best[height<=${height}]`;
      const downloadStarted = Date.now();
      // Per file: video and audio download one after the other.
      await this.runner(this.ytDlp, [...this.ytArgs(), "--no-playlist", "--newline", "--progress-template", DOWNLOAD_PROGRESS,
        "--format", format, "--merge-output-format", "mp4", "--output", source, url], { signal, onLine: line => {
        const match = line.match(/^VPP (\S+) (\S+) (\S+)/);
        if (!match) return;
        const done = Number(match[1]), total = Number(match[2]) || Number(match[3]);
        if (done >= 0 && total > 0) this.progress.fraction = Math.min(1, done / total);
      } });
      stats.downloadSeconds = Math.max(1, Math.round((Date.now() - downloadStarted) / 1000));
      const sourceBytes = await stat(source).then(info => info.size, () => 0);
      if (sourceBytes) stats.downloadMbps = sourceBytes * 8 / stats.downloadSeconds / 1e6;
      const probe = await this.runner(this.ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", source], { signal });
      const stream = JSON.parse(probe.stdout).streams?.[0] || {};
      const sourceHeight = Number(stream.height), sourceWidth = Number(stream.width);
      if (!Number.isFinite(sourceHeight) || sourceHeight <= 0) throw new Error("Unable to read the downloaded video's resolution.");
      // Widescreen films are short for their class: 1920x800 is 1080p.
      const sourceClass = Math.max(sourceHeight, sourceWidth > 0 ? Math.round(sourceWidth * 9 / 16) : 0);
      if (sourceClass + 16 < height) {
        video.sourceMax = sourceClass;
        if (wasReady) throw new Error(`This source is only ${sourceClass}p. The current ${previousQuality}p copy is still available.`);
        height = QUALITIES.filter(value => value <= sourceClass + 16).at(-1) || 360;
        files = this.paths(id, height);
      }
      video.sourceHeight = sourceHeight;
      video.message = `Preparing ${height}p for the Tesla browser…`;
      Object.assign(this.progress, { stage: "processing", fraction: 0 });
      await this.save();
      await rm(files.temporary, { force: true });
      const processingStarted = Date.now();
      await this.mediaTask(async () => {
        await this.runner(this.ffmpeg, ["-progress", "pipe:1", "-nostats", ...encodeArgs(source, files.temporary, height)], { signal, onLine: line => {
          const [key, value] = line.split("=");
          const seconds = Number(value) / 1e6;
          if (key === "out_time_us" && seconds >= 0 && video.duration) this.progress.fraction = Math.min(1, seconds / video.duration);
          if (key === "speed" && parseFloat(value) > 0) this.progress.speed = parseFloat(value);
          if (this.progress.speed && video.duration && this.progress.fraction !== null)
            this.progress.remaining = video.duration * (1 - this.progress.fraction) / this.progress.speed;
        } });
        await rename(files.temporary, files.media);
        await this.buildSeekIndex(video, files);
      }, signal);
      stats.processingSeconds = Math.max(1, Math.round((Date.now() - processingStarted) / 1000));
      if (video.duration) stats.processingSpeed = video.duration / stats.processingSeconds;
      const outputBytes = await stat(files.media).then(info => info.size, () => 0);
      if (outputBytes && video.duration) stats.outputKbps = outputBytes * 8 / video.duration / 1000;
      stats.quality = height; stats.hardwareDecode = false;
      this.lastPreparation = stats;
      await this.removeLeftovers(name => name.startsWith(path.basename(source).replace(/mp4$/, "")));
      video.state = "ready";
      video.quality = height;
      video.mediaQuality = files.media === this.paths(id).media && !previousMediaQuality ? undefined : height;
      if (wasReady && !previousMediaQuality) video.legacyQuality = previousQuality;
      video.qualities = [...new Set([...(video.qualities || []), ...(wasReady ? [previousQuality] : []), height])].sort((a,b)=>a-b);
      video.upgrading = false; video.upgradeQuality = null; video.upgradeError = null;
      video.message = null;
      await this.save();
      this.warmQualities();
    } catch (error) {
      const cancelled = Boolean(signal?.aborted);
      const message = cancelled ? (wasReady ? "Upgrade cancelled." : "Cancelled. Tap Retry when ready.") : String(error.message || error).slice(0, 500);
      video.state = wasReady ? "ready" : (cancelled ? "paused" : "failed");
      video.quality = previousQuality; video.mediaQuality = previousMediaQuality;
      video.upgrading = false; video.upgradeQuality = null;
      if (wasReady) video.upgradeError = cancelled ? null : message;
      video.message = wasReady ? null : message;
      await rm(files.temporary, { force: true });
      await this.removeLeftovers(name => name.startsWith(path.basename(source).replace(/mp4$/, "")));
      await this.save();
      throw error;
    }
  }

  async buildSeekIndex(video, files) {
    const result = await this.runner(this.ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_packets",
      "-show_entries", "packet=pts_time,pos,flags", "-of", "csv=p=0", files.media]);
    const points = [];
    for (const line of result.stdout.split("\n")) {
      const parts = line.split(",");
      if (parts.length < 3) continue;
      const time = Number(parts[0]), position = Number(parts[1]);
      if (!Number.isFinite(time) || !Number.isSafeInteger(position) || !parts.slice(2).join(",").includes("K")) continue;
      const context = Math.max(0, position - 188 * 40);
      points.push({ time, offset: context - context % 188 });
    }
    if (points.length === 0) points.push({ time: 0, offset: 0 });
    const size = (await stat(files.media)).size;
    await this.atomicJSON(files.seek, { duration: video.duration, size, points });
  }

  // Shape the web app's Downloads tab expects: {items:[{id,title,videoId,stage}]}.
  queueView() {
    const items = [this.active, ...this.queue].filter(Boolean).map((id, index) => {
      const video = this.get(id);
      const active = index === 0 && Boolean(this.active);
      const stage = !active ? "queued" : (/^Preparing/.test(video?.message || "") ? "transcoding" : "downloading");
      const quality = video?.upgradeQuality || video?.quality;
      const progress = active && Number.isFinite(this.progress?.fraction) ? this.progress.fraction : null;
      return { id, title: video?.title || id, videoId: video?.youtubeID || null, stage,
        ...(quality ? { quality: `${quality}p` } : {}), ...(video?.upgrading ? { upgrade: true } : {}),
        ...(progress !== null ? { progress } : {}),
        ...(active && stage === "transcoding" && this.progress?.remaining >= 0 ? { etaSec: Math.round(this.progress.remaining) } : {}) };
    });
    return { items };
  }

  // The preparation fields of /api/status.
  statusView() {
    const progress = this.active && this.progress?.id === this.active ? this.progress : null;
    return { busy: Boolean(this.active), queuedCount: this.queue.length, preparingID: this.active || "",
      preparationStage: !this.active ? "idle" : progress?.stage || "downloading",
      preparationProgress: Number.isFinite(progress?.fraction) ? progress.fraction : null,
      processingSpeed: progress?.stage === "processing" ? progress.speed : null,
      preparationSecondsRemaining: progress?.stage === "processing" && progress.remaining >= 0 ? progress.remaining : null,
      lastPreparation: this.lastPreparation, libraryRevision: this.revision };
  }
}

const DOWNLOAD_PROGRESS = "download:VPP %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s";
const SEARCH_FILTERS = { short: "EgIYAQ==", medium: "EgIYAw==", long: "EgIYAg==", week: "EgIIAw==", newest: "CAI=" };

export function parseYouTubeID(value) {
  const text = String(value || "").trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(text)) return text;
  try {
    const url = new URL(text);
    const id = url.hostname === "youtu.be" ? url.pathname.split("/")[1]
      : url.pathname.startsWith("/shorts/") ? url.pathname.split("/")[2] : url.searchParams.get("v");
    return /^[A-Za-z0-9_-]{11}$/.test(id || "") ? id : null;
  } catch { return null; }
}

function formatDuration(value) {
  const seconds = Math.round(Number(value));
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const parts = [Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60), seconds % 60];
  if (parts[0] === 0) parts.shift();
  return parts.map((part, index) => index ? String(part).padStart(2, "0") : String(part)).join(":");
}

function mapChannels(entries = []) {
  return (entries || []).filter(entry => /^UC[A-Za-z0-9_-]{20,30}$/.test(entry.channel_id || entry.id || "")).map(entry => {
    const followers = Number(entry.channel_follower_count);
    const thumb = (entry.thumbnails || []).at(-1)?.url || "";
    return { id: entry.channel_id || entry.id, name: entry.title || entry.channel || "YouTube channel",
      avatar: /^(https:)?\/\/yt3\.(googleusercontent|ggpht)\.com\//.test(thumb) ? thumb.replace(/^\/\//, "https://") : null,
      subscribers: followers > 0 ? `${compactCount(followers)} subscribers` : null };
  });
}

// yt-dlp lists a channel's banner and avatar together; the avatar is the
// "avatar_uncropped" entry. Ask the image CDN for a small square.
function channelAvatar(thumbnails = []) {
  const url = thumbnails.find(item => item?.id === "avatar_uncropped")?.url;
  if (!url || !/^https:\/\/yt3\.(googleusercontent|ggpht)\.com\//.test(url)) return null;
  return url.replace(/=[^/=]*$/, "") + "=s176-c-k-c0x00ffffff-no-rj";
}

function compactCount(value) {
  // YouTube style: three significant digits (78.3K, 943K, 3.82M).
  const [unit, scale] = value >= 1e9 ? ["B", 1e9] : value >= 1e6 ? ["M", 1e6] : value >= 1e3 ? ["K", 1e3] : ["", 1];
  return `${+(value / scale).toPrecision(3)}${unit}`;
}

// Live and upcoming broadcasts cannot be downloaded until they end, so they
// are left out of every list (search, Home, Subscriptions, channel pages).
// Finished broadcasts stay and are marked as streams.
function mapEntries(entries = []) {
  return entries.filter(entry => /^[A-Za-z0-9_-]{11}$/.test(entry.id || "") && !["is_live", "is_upcoming"].includes(entry.live_status)).map(entry => ({
    id: entry.id, title: entry.title || entry.id, channel: entry.channel || entry.uploader || "",
    channelId: entry.channel_id || null, thumbnail: `https://i.ytimg.com/vi/${entry.id}/mqdefault.jpg`,
    duration: formatDuration(entry.duration),
    views: entry.view_count ? Number(entry.view_count).toLocaleString("en-US") + " views" : null,
    published: null,
    // A finished broadcast: watchable, but often hours long.
    ...(entry.live_status === "was_live" ? { stream: true } : {}),
  }));
}
