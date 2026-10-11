import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const QUALITY = new Set([360, 540, 720]);

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
  constructor({ dataDir, ytDlp = "yt-dlp", ffmpeg = "ffmpeg", ffprobe = "ffprobe", runner = run }) {
    this.dataDir = dataDir;
    this.mediaDir = path.join(dataDir, "media");
    this.indexFile = path.join(dataDir, "library.json");
    this.settingsFile = path.join(dataDir, "settings.json");
    this.historyFile = path.join(dataDir, "history.json");
    this.ytDlp = ytDlp;
    this.ffmpeg = ffmpeg;
    this.ffprobe = ffprobe;
    this.runner = runner;
    this.videos = [];
    this.settings = { quality: 720 };
    this.history = [];
    this.queue = [];
    this.active = null;
    this.listeners = new Set();
  }

  async init() {
    await mkdir(this.mediaDir, { recursive: true });
    try { this.videos = JSON.parse(await readFile(this.indexFile, "utf8")); } catch { this.videos = []; }
    try { this.settings = { ...this.settings, ...JSON.parse(await readFile(this.settingsFile, "utf8")) }; } catch {}
    try { this.history = JSON.parse(await readFile(this.historyFile, "utf8")); } catch { this.history = []; }
    for (const video of this.videos) {
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
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, file);
  }
  async save() { await this.atomicJSON(this.indexFile, this.videos); this.notify(); }
  async saveSettings() { await this.atomicJSON(this.settingsFile, this.settings); this.notify(); }
  async saveHistory() { await this.atomicJSON(this.historyFile, this.history.slice(0, 300)); this.notify(); }

  get(id) { return this.videos.find(video => video.id.toLowerCase() === String(id).toLowerCase()); }
  paths(id) {
    const safe = String(id).toLowerCase();
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

  async upgrade(id) {
    const video = this.get(id);
    if (!video || video.state !== "ready") throw new Error("That video is not ready to upgrade.");
    if ((video.quality || 0) >= this.settings.quality) return false;
    video.state = "preparing";
    video.message = `Waiting to upgrade to ${this.settings.quality}p…`;
    this.queue.push(video.id);
    await this.save();
    this.drain();
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
    this.queue = this.queue.filter(item => item !== video.id);
    this.videos = this.videos.filter(item => item !== video);
    await Promise.all(Object.values(this.paths(video.id)).map(file => rm(file, { force: true })));
    await this.save();
    return true;
  }

  async setQuality(value) {
    const quality = Number(value);
    if (!QUALITY.has(quality)) throw new Error("Quality must be 360, 540, or 720.");
    this.settings.quality = quality;
    await this.saveSettings();
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
    const result = await this.runner(this.ytDlp, ["--flat-playlist", "--dump-single-json", `ytsearch${limit}:${text}`]);
    const object = JSON.parse(result.stdout);
    return mapEntries(object.entries);
  }

  async channel(id) {
    if (!/^UC[A-Za-z0-9_-]{20,30}$/.test(String(id || ""))) throw new Error("That channel could not be found.");
    const result = await this.runner(this.ytDlp, ["--flat-playlist", "--playlist-end", "30", "--dump-single-json",
      `https://www.youtube.com/channel/${id}/videos`]);
    const object = JSON.parse(result.stdout);
    return { channel: { id, name: object.channel || object.uploader || object.title || "YouTube channel",
      handle: object.channel_url || null, avatar: null, subscribers: null }, videos: mapEntries(object.entries), continuation: null };
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
    const files = this.paths(id);
    const url = `https://www.youtube.com/watch?v=${video.youtubeID}`;
    try {
      video.message = "Reading YouTube details…";
      await this.save();
      const metadataResult = await this.runner(this.ytDlp, ["--dump-single-json", "--no-playlist", url]);
      const metadata = JSON.parse(metadataResult.stdout);
      video.title = metadata.title || video.title;
      video.channel = metadata.channel || metadata.uploader || video.channel;
      video.channelId = metadata.channel_id || video.channelId;
      video.publishedAt = metadata.upload_date ? `${metadata.upload_date.slice(0,4)}-${metadata.upload_date.slice(4,6)}-${metadata.upload_date.slice(6,8)}` : null;
      video.duration = Number(metadata.duration) || null;
      video.message = "Downloading to the Raspberry Pi…";
      await this.save();
      const height = this.settings.quality;
      video.quality = height;
      const format = `bestvideo[height<=${height}][vcodec^=avc1]+bestaudio[ext=m4a]/best[height<=${height}][ext=mp4]/best[height<=${height}]`;
      await this.runner(this.ytDlp, ["--no-playlist", "--no-progress", "--format", format,
        "--merge-output-format", "mp4", "--output", files.source, url]);
      video.message = `Preparing ${height}p for the Tesla browser…`;
      await this.save();
      await rm(files.temporary, { force: true });
      await this.runner(this.ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", files.source,
        "-vf", `scale=${height === 360 ? 640 : height === 540 ? 960 : 1280}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${height === 360 ? 640 : height === 540 ? 960 : 1280}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
        "-r", "30", "-pix_fmt", "yuv420p", "-c:v", "mpeg1video", "-b:v", height === 720 ? "1500k" : "1000k",
        "-maxrate", height === 720 ? "1800k" : "1200k", "-bufsize", "800k", "-bf", "0", "-g", "30",
        "-c:a", "mp2", "-b:a", "128k", "-ar", "44100", "-ac", "2", "-muxdelay", "0.001",
        "-mpegts_flags", "+resend_headers", "-f", "mpegts", files.temporary]);
      await rename(files.temporary, files.media);
      await this.buildSeekIndex(video, files);
      await rm(files.source, { force: true });
      video.state = "ready";
      video.message = null;
      await this.save();
    } catch (error) {
      video.state = "failed";
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

  queueView() {
    return [this.active, ...this.queue].filter(Boolean).map((id, index) => {
      const video = this.get(id);
      return { id, title: video?.title || id, state: index === 0 && this.active ? "active" : "queued", api: true };
    });
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

function mapEntries(entries = []) {
  return entries.filter(entry => /^[A-Za-z0-9_-]{11}$/.test(entry.id || "")).map(entry => ({
    id: entry.id, title: entry.title || entry.id, channel: entry.channel || entry.uploader || "",
    channelId: entry.channel_id || null, thumbnail: `https://i.ytimg.com/vi/${entry.id}/mqdefault.jpg`,
    duration: formatDuration(entry.duration),
    views: entry.view_count ? Number(entry.view_count).toLocaleString("en-US") + " views" : null,
    published: null,
  }));
}
