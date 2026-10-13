import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import {QUALITIES, parseQuality} from "./quality.mjs";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const ASSETS = new Set(["/", "/index.html", "/app.js", "/http-source.js", "/diagnostics.js", "/style.css", "/jsmpeg.min.js"]);

function send(res, status, body, type = "application/json; charset=utf-8", headers = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  res.writeHead(status, { "content-type": type, "content-length": bytes.length, "cache-control": "no-store", ...headers });
  res.end(bytes);
}

async function bodyJSON(req) {
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > 16384) throw new Error("Request is too large."); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export function createVideoPilotServer({ library, webRoot, decoderPath, port = 5001, host = "127.0.0.1", version = "Pi" }) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (!["GET", "POST"].includes(req.method)) return send(res, 405, { error: "Method not allowed." });
      if (ASSETS.has(url.pathname) && req.method === "GET") {
        const name = url.pathname === "/" ? "index.html" : path.basename(url.pathname);
        const file = name === "jsmpeg.min.js" && decoderPath ? decoderPath : path.join(webRoot, name);
        const data = await readFile(file);
        return send(res, 200, data, TYPES[path.extname(file)] || "application/octet-stream", {
          "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://i.ytimg.com https://yt3.ggpht.com https://yt3.googleusercontent.com; connect-src 'self'; object-src 'none'; frame-ancestors 'none'",
          "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
        });
      }
      if (url.pathname === "/api/status" && req.method === "GET") return send(res, 200, {
        hosting: true, busy: Boolean(library.active), publicAccess: true, authentication: "tunnel-key",
        youtubeSearch: true, youtubeExplore: true, youtubeSignedIn: false, tunnel: "connected",
        version, build: "Pi", activeStreams: 0, queuedCount: library.queue.length,
        preparationStage: library.active ? "processing" : "idle", preparationProgress: null,
        preparingID: library.active || "", diagnosticsEnabled: false, diagnosticsEventCount: 0,
      });
      if (url.pathname === "/api/library" && req.method === "GET") return send(res, 200, library.videos);
      if (url.pathname === "/api/queue" && req.method === "GET") return send(res, 200, library.queueView());
      if (url.pathname === "/api/queue/move" && req.method === "POST") {
        const body = await bodyJSON(req); await library.move(body.id, body.to); return send(res, 200, { moved: true });
      }
      if (url.pathname === "/api/queue/cancel" && req.method === "POST") {
        const body = await bodyJSON(req); await library.cancelQueued(body.id); return send(res, 200, { cancelled: true });
      }
      if (url.pathname === "/api/settings" && req.method === "GET") return send(res, 200, {...library.settings, playbackQualities:QUALITIES});
      if (url.pathname === "/api/settings" && req.method === "POST") {
        const body = await bodyJSON(req); await library.setQuality(body.quality); return send(res, 200, library.settings);
      }
      if (url.pathname === "/api/youtube" && req.method === "POST") {
        const body = await bodyJSON(req); const video = await library.enqueue(body.url, body); return send(res, 202, { id: video.id });
      }
      if (url.pathname === "/api/library/retry" && req.method === "POST") {
        const body = await bodyJSON(req); await library.retry(body.id); return send(res, 202, { queued: true });
      }
      if (url.pathname === "/api/library/remove" && req.method === "POST") {
        const body = await bodyJSON(req); return send(res, 200, { removed: await library.remove(body.id), pending: false });
      }
      if (url.pathname === "/api/library/upgrade" && req.method === "POST") {
        const body = await bodyJSON(req);
        if (body.id) return send(res, 202, { queued: await library.upgrade(body.id, body.quality) ? 1 : 0 });
        let queued = 0;
        for (const video of library.videos) {
          if (video.state === "ready" && (video.quality || 0) < library.settings.quality)
            queued += await library.upgrade(video.id) ? 1 : 0;
        }
        return send(res, 202, { queued });
      }
      if (url.pathname === "/api/library/quality" && req.method === "POST") {
        const body = await bodyJSON(req);
        const status = await library.requestQuality(body.id, body.quality);
        return send(res, status.ready ? 200 : 202, status);
      }
      if (url.pathname === "/api/library/quality" && req.method === "GET")
        return send(res, 200, await library.qualityStatus(url.searchParams.get("id"), url.searchParams.get("quality")));
      if (url.pathname === "/api/diagnostics" && req.method === "POST") return send(res, 200, { accepted: false, count: 0 });
      if (url.pathname === "/api/diagnostics/export" && req.method === "GET") return send(res, 404, { error: "Diagnostics are available in journalctl on the Pi." });
      if (url.pathname === "/api/suggest" && req.method === "GET") return send(res, 200, []);
      if (url.pathname === "/api/search" && req.method === "GET") return send(res, 200, { results: await library.search(url.searchParams.get("q")), continuation: null });
      if (url.pathname === "/api/explore" && req.method === "GET") return send(res, 200, await library.search("trending videos", 20));
      if (url.pathname === "/api/foryou" && req.method === "GET") {
        const videos = await library.search("trending videos", 20);
        const continuing = library.historyView(20).items
          .filter(item => item.inLibrary && item.position > 0 && item.progress < 0.95)
          .map(item => ({ id: item.libraryId, title: item.title, channel: item.channel, channelId: item.channelId,
            duration: item.duration, position: item.position, progress: item.progress, youtube: false,
            libraryId: item.libraryId, libraryState: item.state }));
        const rows = [];
        if (continuing.length) rows.push({ title: "Continue watching", kind: "continue", videos: continuing });
        rows.push({ title: "Trending now", kind: "trending", videos });
        return send(res, 200, { rows, errors: [] });
      }
      if (url.pathname === "/api/channel" && req.method === "GET")
        return send(res, 200, await library.channel(url.searchParams.get("id")));
      if (url.pathname === "/api/history" && req.method === "GET") return send(res, 200, library.historyView(Number(url.searchParams.get("limit")) || 50));
      if (url.pathname === "/api/history" && req.method === "POST") { await library.recordHistory(await bodyJSON(req)); return send(res, 200, { recorded: true }); }
      if (url.pathname === "/api/history/clear" && req.method === "POST") { library.history = []; await library.saveHistory(); return send(res, 200, { cleared: true }); }
      const match = url.pathname.match(/^\/api\/stream\/([0-9a-f-]{36})\.ts$/i);
      if (match && req.method === "GET") {
        const video = library.get(match[1]);
        if (!video || video.state !== "ready") return send(res, 404, { error: "Video is not ready or no longer exists." });
        const requestedQuality = url.searchParams.has("quality") ? parseQuality(url.searchParams.get("quality")) : null;
        if (requestedQuality !== null && !(await library.qualityStatus(video.id, requestedQuality)).ready)
          return send(res, 409, {error:"That quality is still being prepared. Keep playing the current quality."});
        const files = library.paths(video.id, requestedQuality);
        if (!library.history.some(item => item.libraryId === video.id)) await library.recordHistory({ id: video.id, position: 0 });
        const info = await stat(files.media);
        let offset = 0, seekTime = 0;
        const seek = Number(url.searchParams.get("seek"));
        if (Number.isFinite(seek) && seek > 0) {
          try {
            const index = JSON.parse(await readFile(files.seek, "utf8"));
            const point = index.points.filter(item => item.time <= seek).at(-1);
            if (point) { offset = Math.max(0, Math.min(info.size - 1, point.offset)); seekTime = point.time; }
          } catch {}
        }
        res.writeHead(200, { "content-type": "video/mp2t", "content-length": info.size - offset,
          "cache-control": "no-store", "accept-ranges": "none", "x-mk8-seek-offset": String(offset),
          "x-video-seek-time": String(seekTime), "x-video-duration": String(video.duration || 0) });
        const stream = createReadStream(files.media, { start: offset });
        res.once("close", () => stream.destroy());
        stream.once("error", () => res.destroy());
        stream.pipe(res);
        return;
      }
      return send(res, 404, { error: "Not found." });
    } catch (error) {
      if (!res.headersSent) send(res, /valid|quality|waiting|large/i.test(error.message || "") ? 400 : 500, { error: String(error.message || error) });
      else res.destroy(error);
    }
  });
  return {
    server,
    start: () => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); }),
    stop: () => new Promise(resolve => server.close(resolve)),
  };
}
