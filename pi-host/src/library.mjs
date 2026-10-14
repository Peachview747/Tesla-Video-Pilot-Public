import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {QUALITIES, parseQuality, encodeArgs} from "./quality.mjs";

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout?.on("data", chunk => { stdout += chunk; });
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
    for (const video of this.videos) {
      if (video.upgrading) { video.upgrading = false; video.upgradeError = "Upgrade interrupted. Select the quality again to retry."; }
      if (video.state === "preparing") {
        video.state = "paused";
        video.message = "The Pi restarted before preparation finished. Tap Retry.";
      }
    }
    await this.save();
    return this;
  }

  onChange(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  notify() { for (const listener of this.listeners) listener(); }

  async atomicJSON(file, value) {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, file);
  }
  async save() { await this.atomicJSON(this.indexFile, this.videos); this.notify(); }
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
    this.subscriptionCache = null;
    this.notify();
  }

  async clearCookies() {
    await unlink(this.cookiesFile).catch(() => {});
    this.subscriptionCache = null;
    this.notify();
  }

  // Newest uploads from subscribed channels; cached briefly because each
  // fetch is a full YouTube page load on the Pi.
  async subscriptions({ refresh = false } = {}) {
    if (!await this.signedIn()) return { signedIn: false, videos: [] };
    if (!refresh && this.subscriptionCache && Date.now() - this.subscriptionCache.at < 10 * 60_000) return this.subscriptionCache.value;
    const feed = (url, end) => this.runner(this.ytDlp, [...this.ytArgs(), "--flat-playlist", "--playlist-end", end, "--dump-single-json", url]);
    // The channel list is a nicety; the feed still shows if it fails.
    const [uploads, following] = await Promise.all([feed("https://www.youtube.com/feed/subscriptions", "60"),
      feed("https://www.youtube.com/feed/channels", "500").catch(() => null)]);
    const channels = (following ? JSON.parse(following.stdout).entries || [] : [])
      .filter(entry => /^UC[A-Za-z0-9_-]{20,30}$/.test(entry.channel_id || entry.id || ""))
      .map(entry => {
        const followers = Number(entry.channel_follower_count);
        const thumb = (entry.thumbnails || []).at(-1)?.url || "";
        return { id: entry.channel_id || entry.id, name: entry.title || entry.channel || "YouTube channel",
          avatar: /^(https:)?\/\/yt3\.(googleusercontent|ggpht)\.com\//.test(thumb) ? thumb.replace(/^\/\//, "https://") : null,
          subscribers: followers > 0 ? `${compactCount(followers)} subscribers` : null };
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    const value = { signedIn: true, channels, videos: mapEntries(JSON.parse(uploads.stdout).entries) };
    this.subscriptionCache = { at: Date.now(), value };
    return value;
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

  async upgrade(id, requested = this.settings.quality) {
    const video = this.get(id);
    if (!video || video.state !== "ready") throw new Error("That video is not ready to upgrade.");
    const quality = parseQuality(requested);
    if ((video.quality || 0) >= quality || video.upgrading) return false;
    video.upgrading = true; video.upgradeQuality = quality; video.upgradeError = null;
    video.message = `Waiting to upgrade to ${quality}p…`;
    this.queue.push(video.id);
    await this.save();
    this.drain();
    return true;
    return true;
  }

  async move(id, to) {
    const index = this.queue.indexOf(id);
    if (index < 0) throw new Error("That item is no longer queued.");
    const [item] = this.queue.splice(index, 1);
    this.queue.splice(Math.max(0, Math.min(this.queue.length, Number(to) || 0)), 0, item);
    this.notify();
  }

  async cancelQueued(id) {
    const index = this.queue.indexOf(id);
    if (index < 0) throw new Error("Only a waiting item can be cancelled.");
    this.queue.splice(index, 1);
    const video = this.get(id);
    if (video) {
      video.state = "paused";
      video.message = "Preparation paused. Tap Retry when ready.";
      await this.save();
    }
  }

  async remove(id) {
    const video = this.get(id);
    if (!video) return false;
    if (this.active === video.id) throw new Error("Wait for preparation to finish before removing this video.");
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

  mediaTask(task) {
    const promise = this.mediaWork.then(task);
    this.mediaWork = promise.catch(() => {});
    return promise;
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

  async search(query, limit = 20) {
    const text = String(query || "").trim();
    if (!text || text.length > 200) throw new Error("Enter a search of up to 200 characters.");
    const result = await this.runner(this.ytDlp, [...this.ytArgs(), "--flat-playlist", "--dump-single-json", `ytsearch${limit}:${text}`]);
    const object = JSON.parse(result.stdout);
    return mapEntries(object.entries);
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
    this.active = id;
    this.prepare(id).catch(() => {}).finally(() => { this.active = null; this.drain(); });
  }

  async prepare(id) {
    const video = this.get(id);
    if (!video) return;
    const targetQuality = video.upgradeQuality || video.quality || this.settings.quality;
    const previousQuality = video.quality, previousMediaQuality = video.mediaQuality;
    const wasReady = video.state === "ready";
    let files = this.paths(id, targetQuality);
    const url = `https://www.youtube.com/watch?v=${video.youtubeID}`;
    try {
      video.message = "Reading YouTube details…";
      await this.save();
      const metadataResult = await this.runner(this.ytDlp, [...this.ytArgs(), "--dump-single-json", "--no-playlist", url]);
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
      await this.runner(this.ytDlp, [...this.ytArgs(), "--no-playlist", "--no-progress", "--format", format,
        "--merge-output-format", "mp4", "--output", files.source, url]);
      const source = files.source;
      const probe = await this.runner(this.ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", source]);
      const sourceHeight = Number(JSON.parse(probe.stdout).streams?.[0]?.height);
      if (!Number.isFinite(sourceHeight) || sourceHeight <= 0) throw new Error("Unable to read the downloaded video's resolution.");
      if (sourceHeight < height) {
        if (wasReady) throw new Error(`This source is only ${sourceHeight}p. The current ${previousQuality}p copy is still available.`);
        height = QUALITIES.filter(value => value <= sourceHeight).at(-1) || 360;
        files = this.paths(id, height);
      }
      video.sourceHeight = sourceHeight;
      video.message = `Preparing ${height}p for the Tesla browser…`;
      await this.save();
      await rm(files.temporary, { force: true });
      await this.mediaTask(async () => {
        await this.runner(this.ffmpeg, encodeArgs(source, files.temporary, height));
        await rename(files.temporary, files.media);
        await this.buildSeekIndex(video, files);
      });
      await rm(source, { force: true });
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
      video.state = wasReady ? "ready" : "failed";
      video.quality = previousQuality; video.mediaQuality = previousMediaQuality;
      video.upgrading = false; video.upgradeQuality = null;
      if (wasReady) video.upgradeError = String(error.message || error).slice(0,500);
      video.message = String(error.message || error).slice(0, 500);
      await rm(files.temporary, { force: true });
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
      return { id, title: video?.title || id, videoId: video?.youtubeID || null, stage };
    });
    return { items };
  }
}

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

function mapEntries(entries = []) {
  return entries.filter(entry => /^[A-Za-z0-9_-]{11}$/.test(entry.id || "")).map(entry => ({
    id: entry.id, title: entry.title || entry.id, channel: entry.channel || entry.uploader || "",
    channelId: entry.channel_id || null, thumbnail: `https://i.ytimg.com/vi/${entry.id}/mqdefault.jpg`,
    duration: formatDuration(entry.duration),
    views: entry.view_count ? Number(entry.view_count).toLocaleString("en-US") + " views" : null,
    published: null,
    // "live" cannot be downloaded until it ends; "stream" is a finished broadcast.
    ...(["is_live", "is_upcoming"].includes(entry.live_status) ? { live: entry.live_status } : {}),
    ...(entry.live_status === "was_live" ? { stream: true } : {}),
  }));
}
