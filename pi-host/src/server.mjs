import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import {QUALITIES, parseQuality} from "./quality.mjs";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const ASSETS = new Set(["/", "/index.html", "/app.js", "/http-source.js", "/diagnostics.js", "/style.css", "/jsmpeg.min.js", "/apps-menu.js", "/apps-menu.css"]);

function send(res, status, body, type = "application/json; charset=utf-8", headers = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  res.writeHead(status, { "content-type": type, "content-length": bytes.length, "cache-control": "no-store", ...headers });
  res.end(bytes);
}

async function bodyJSON(req, limit = 16384) {
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > limit) throw new Error("Request is too large."); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

// A version for the deployed web files (their newest change time), so an open
// page in the car can tell it is out of date and reload itself.
const WEB_FILES = ["index.html", "app.js", "style.css", "http-source.js", "diagnostics.js", "apps-menu.js", "apps-menu.css"];
async function webVersion(webRoot) {
  const times = await Promise.all(WEB_FILES.map(name => stat(path.join(webRoot, name)).then(info => info.mtimeMs, () => 0)));
  return String(Math.floor(Math.max(...times)));
}

// AI Room (chat and voice with Claude) and Pi Health live inside the portal:
// their pages are served here and their requests go, behind the portal PIN,
// to AI Room's local control API, which holds the admin rights.
const AIROOM_FILES = { "/airoom/": "index.html", "/airoom/index.html": "index.html", "/airoom/app.js": "app.js", "/airoom/style.css": "style.css" };
const HEALTH_FILES = { "/health/": "health.html", "/health/health.js": "health.js", "/health/health.css": "health.css" };
const ROOM_ACTIONS = new Set(["state", "export", "send", "new", "refresh", "login", "stop", "voice", "speak", "hear"]);
const PAGE_HEADERS = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob: data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'";

export function createVideoPilotServer({ library, webRoot, decoderPath, port = 5001, host = "127.0.0.1", version = "Pi",
  signinURL = "http://127.0.0.1:5002", liveURL = "http://127.0.0.1:5003", pinLock = null,
  controlURL = "http://127.0.0.1:5020", controlKey = null, airoomWeb = null, tunnelConnected = () => null }) {
  const control = async (path, body = {}, timeout = 15_000) => {
    if (!controlKey) { const error = new Error("AI Room is not connected to the portal on this Pi."); error.status = 503; throw error; }
    let response;
    try {
      response = await fetch(`${controlURL}${path}`, { method: "POST", signal: AbortSignal.timeout(timeout),
        headers: { "content-type": "application/json", "x-pi-control-key": controlKey }, body: JSON.stringify(body) });
    } catch { const error = new Error("AI Room is not running on the Pi."); error.status = 503; throw error; }
    return { status: response.status, body: await response.json().catch(() => ({ error: "AI Room sent an unreadable answer." })) };
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (!["GET", "POST"].includes(req.method)) return send(res, 405, { error: "Method not allowed." });
      if (req.method === "GET" && (AIROOM_FILES[url.pathname] || HEALTH_FILES[url.pathname] || url.pathname === "/airoom" || url.pathname === "/health")) {
        if (url.pathname === "/airoom" || url.pathname === "/health") return send(res, 301, "", "text/plain", { location: url.pathname + "/" });
        const name = AIROOM_FILES[url.pathname] || HEALTH_FILES[url.pathname];
        const dir = AIROOM_FILES[url.pathname] ? airoomWeb : webRoot;
        if (!dir) return send(res, 404, { error: "AI Room is not installed for the portal." });
        let data = await readFile(path.join(dir, name));
        // The same AI Room page, told to use the portal's API and PIN.
        if (name === "index.html" && AIROOM_FILES[url.pathname])
          data = Buffer.from(String(data).replace("<head>", '<head><meta name="api-base" content="/api/airoom/"><meta name="in-portal" content="1"><base href="/airoom/"><link rel="stylesheet" href="/apps-menu.css"><script src="/apps-menu.js" defer></script>'));
        return send(res, 200, data, TYPES[path.extname(name)] || "application/octet-stream", { ...PAGE_HEADERS, "content-security-policy": PAGE_CSP });
      }
      if (ASSETS.has(url.pathname) && req.method === "GET") {
        const name = url.pathname === "/" ? "index.html" : path.basename(url.pathname);
        const file = name === "jsmpeg.min.js" && decoderPath ? decoderPath : path.join(webRoot, name);
        const data = await readFile(file);
        return send(res, 200, data, TYPES[path.extname(file)] || "application/octet-stream", {
          "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: https://i.ytimg.com https://yt3.ggpht.com https://yt3.googleusercontent.com; connect-src 'self'; object-src 'none'; frame-ancestors 'none'",
          "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
        });
      }
      // PIN lock: everything from the relay needs a device key, except the
      // lock's own calls. Requests made on the Pi itself are never locked.
      const deviceKey = String(req.headers["x-vp-device"] || "");
      const pinRoute = url.pathname.match(/^\/api\/pin\/(status|unlock|reset|change|devices|remove)$/);
      if (pinRoute && pinLock) {
        const name = pinRoute[1];
        if ((name === "status") !== (req.method === "GET")) return send(res, 405, { error: "Method not allowed." });
        try {
          if (name === "status") return send(res, 200, pinLock.status(deviceKey));
          const body = await bodyJSON(req, 2048), agent = req.headers["user-agent"];
          if (name === "unlock") return send(res, 200, await pinLock.unlock(String(body.pin || ""), agent));
          if (name === "reset") return send(res, 200, await pinLock.reset(body.answer, String(body.newPin || ""), agent));
          if (name === "change") return send(res, 200, await pinLock.changePin(String(body.pin || ""), String(body.newPin || ""), agent));
          if (name === "devices") return send(res, 200, { devices: await pinLock.devices(String(body.pin || ""), deviceKey) });
          return send(res, 200, await pinLock.removeDevice(String(body.pin || ""), String(body.id || "")));
        } catch (error) { return send(res, error.status || 400, { error: String(error.message || error) }); }
      }
      if (pinLock && req.headers["x-video-pilot-relay"] && !pinLock.allows(deviceKey))
        return send(res, 401, { error: "Enter the PIN.", pinRequired: true });
      const room = url.pathname.match(/^\/api\/airoom\/([a-z]+)$/);
      if (room) {
        if (!ROOM_ACTIONS.has(room[1])) return send(res, 404, { error: "Unknown room action." });
        const audio = room[1] === "voice" || room[1] === "hear";
        const body = req.method === "GET" ? { room: url.searchParams.get("room") || "" } : await bodyJSON(req, audio ? 3_500_000 : 65_536);
        const result = await control(`/room/${room[1]}`, body, ["send", "voice"].includes(room[1]) ? 610_000 : 60_000);
        return send(res, result.status, result.body);
      }
      if (url.pathname === "/api/health" && req.method === "GET") {
        const local = { tunnel: tunnelConnected(), ...library.statusView?.(),
          failed: library.videos.filter(video => ["failed", "paused"].includes(video.state)).length, videos: library.videos.length };
        try {
          const result = await control("/health", {}, 20_000);
          return send(res, result.status, { ...result.body, videoPilot: local });
        } catch (error) { return send(res, 200, { error: error.message, videoPilot: local }); }
      }
      if (url.pathname === "/api/health/actions" && req.method === "GET") {
        const result = await control("/actions").catch(() => ({ body: { actions: [] } }));
        return send(res, 200, { actions: [{ id: "retry-failed", label: "Retry failed downloads" }, ...(result.body.actions || [])] });
      }
      if (url.pathname === "/api/health/action" && req.method === "POST") {
        const body = await bodyJSON(req, 1024);
        if (body.id === "retry-failed") {
          const failed = library.videos.filter(video => ["failed", "paused"].includes(video.state));
          for (const video of failed) await library.retry(video.id).catch(() => {});
          return send(res, 200, { ok: true, output: failed.length ? `Retrying ${failed.length} download${failed.length === 1 ? "" : "s"}.` : "Nothing to retry." });
        }
        const result = await control("/action", { id: String(body.id || "") }, 200_000);
        return send(res, result.status, result.body);
      }
      if (url.pathname === "/api/status" && req.method === "GET") return send(res, 200, {
        webVersion: await webVersion(webRoot),
        hosting: true, publicAccess: true, authentication: "tunnel-key",
        youtubeSearch: true, youtubeExplore: true, youtubeSignedIn: await library.signedIn(), tunnel: "connected",
        version, build: "Pi", activeStreams: 0, diagnosticsEnabled: true, diagnosticsEventCount: 0,
        ...library.statusView(),
      });
      if (url.pathname === "/api/library" && req.method === "GET") return send(res, 200, library.libraryView());
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
      if (url.pathname === "/api/library/downgrade" && req.method === "POST") {
        const body = await bodyJSON(req);
        const targets = body.id ? [body.id] : library.videos.filter(video => video.state === "ready" && (video.quality || 0) > library.settings.quality).map(video => video.id);
        let changed = 0;
        for (const id of targets) changed += await library.downgrade(id, body.quality).catch(() => false) ? 1 : 0;
        return send(res, 200, { changed });
      }
      if (url.pathname === "/api/library/quality" && req.method === "POST") {
        const body = await bodyJSON(req);
        const status = await library.requestQuality(body.id, body.quality);
        return send(res, status.ready ? 200 : 202, status);
      }
      if (url.pathname === "/api/library/quality" && req.method === "GET")
        return send(res, 200, await library.qualityStatus(url.searchParams.get("id"), url.searchParams.get("quality")));
      if (url.pathname === "/api/diagnostics" && req.method === "POST") {
        const count = await library.recordDiagnostics((await bodyJSON(req, 256 * 1024)).events);
        return send(res, 200, { accepted: true, count });
      }
      if (url.pathname === "/api/diagnostics/export" && req.method === "GET")
        return send(res, 200, await library.diagnosticsText(), "text/plain; charset=utf-8");
      // Sign-in cookies are pushed by the Firefox sync on the Pi itself. The
      // relay marks every request it forwards, so the car link cannot set them.
      if (url.pathname === "/api/youtube/cookies" && req.method === "POST") {
        if (req.headers["x-video-pilot-relay"]) return send(res, 403, { error: "Sign in with Firefox on the Pi." });
        await library.saveCookies((await bodyJSON(req, 512 * 1024)).cookies); return send(res, 200, { saved: true });
      }
      // Car sign-in: the desktop user's helper runs Firefox on a virtual
      // screen; these calls pass through to it unchanged.
      const signin = url.pathname.match(/^\/api\/signin\/(status|screen|start|stop|input)$/);
      if (signin) {
        const name = signin[1], post = ["start", "stop", "input"].includes(name);
        if (post !== (req.method === "POST")) return send(res, 405, { error: "Method not allowed." });
        let response;
        try {
          response = await fetch(`${signinURL}/${name}`, { method: req.method, signal: AbortSignal.timeout(15_000),
            ...(post ? { headers: { "content-type": "application/json" }, body: JSON.stringify(await bodyJSON(req, 4096)) } : {}) });
        } catch { return send(res, 503, { error: "The sign-in helper is not running on the Pi." }); }
        return send(res, response.status, Buffer.from(await response.arrayBuffer()), response.headers.get("content-type") || "application/json");
      }
      // Netflix and Hulu: the desktop user's live helper runs Chromium on a
      // virtual screen; its control calls and live stream pass through.
      const live = url.pathname.match(/^\/api\/live\/(status|screen|start|stop|input|stream\.ts)$/);
      if (live) {
        const name = live[1], post = ["start", "stop", "input"].includes(name);
        if (post !== (req.method === "POST")) return send(res, 405, { error: "Method not allowed." });
        const controller = new AbortController();
        let response;
        try {
          if (name !== "stream.ts") setTimeout(() => controller.abort(), 20_000);
          response = await fetch(`${liveURL}/${name}`, { method: req.method, signal: controller.signal,
            ...(post ? { headers: { "content-type": "application/json" }, body: JSON.stringify(await bodyJSON(req, 4096)) } : {}) });
        } catch { return send(res, 503, { error: "The Netflix and Hulu helper is not running on the Pi." }); }
        if (name !== "stream.ts" || !response.ok)
          return send(res, response.status, Buffer.from(await response.arrayBuffer()), response.headers.get("content-type") || "application/json");
        res.writeHead(200, { "content-type": "video/mp2t", "content-length": response.headers.get("content-length"),
          "cache-control": "no-store", "x-video-live": "1" });
        res.once("close", () => controller.abort());
        const reader = response.body.getReader();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done || res.destroyed) break;
            if (!res.write(value)) await new Promise(resolve => { res.once("drain", resolve); res.once("close", resolve); });
          }
        } catch {}
        res.destroy();
        return;
      }
      if (url.pathname === "/api/youtube/signout" && req.method === "POST") { await library.clearCookies(); return send(res, 200, { signedOut: true }); }
      if (url.pathname === "/api/subscriptions/channels" && req.method === "GET")
        return send(res, 200, await library.followedChannels({ refresh: url.searchParams.get("refresh") === "1" }));
      if (url.pathname === "/api/subscriptions" && req.method === "GET")
        return send(res, 200, await library.subscriptions({ refresh: url.searchParams.get("refresh") === "1" }));
      if (url.pathname === "/api/suggest" && req.method === "GET") return send(res, 200, await library.suggest(url.searchParams.get("q")).catch(() => []));
      if (url.pathname === "/api/search" && req.method === "GET") {
        const query = url.searchParams.get("q");
        const [results, channels] = await Promise.all([library.search(query, 20, url.searchParams.get("filter") || "any"),
          library.searchChannels?.(query).catch(() => []) ?? Promise.resolve([])]);
        return send(res, 200, { results, channels, continuation: null });
      }
      if (url.pathname === "/api/explore" && req.method === "GET") return send(res, 200, await library.search("trending videos", 20));
      if (url.pathname === "/api/foryou" && req.method === "GET") {
        // Signed in: the account's own YouTube home feed plus new uploads from
        // subscriptions, like youtube.com. Otherwise (or if YouTube fails) trending.
        const refresh = url.searchParams.get("refresh") === "1";
        const [recommended, subscribed] = await Promise.allSettled([library.recommended?.({ refresh }) ?? Promise.resolve(null),
          library.subscriptions?.({ refresh }) ?? Promise.resolve(null)]);
        const forYou = recommended.status === "fulfilled" ? recommended.value : null;
        const newUploads = subscribed.status === "fulfilled" && subscribed.value?.signedIn
          ? subscribed.value.videos.slice(0, 20) : [];
        const videos = forYou?.length ? null : await library.search("trending videos", 20);
        const continuing = library.historyView(20).items
          .filter(item => item.inLibrary && item.position > 0 && item.progress < 0.95)
          .map(item => ({ id: item.libraryId, title: item.title, channel: item.channel, channelId: item.channelId,
            duration: item.duration, position: item.position, progress: item.progress, youtube: false,
            libraryId: item.libraryId, libraryState: item.state }));
        const rows = [];
        if (continuing.length) rows.push({ title: "Continue watching", kind: "continue", videos: continuing });
        if (forYou?.length) rows.push({ title: "Recommended for you", kind: "recommended", videos: forYou });
        if (newUploads.length) rows.push({ title: "New from your subscriptions", kind: "subscriptions", videos: newUploads });
        if (videos) rows.push({ title: "Trending now", kind: "trending", videos });
        const errors = recommended.status === "rejected" ? ["Your YouTube recommendations did not load; showing trending."] : [];
        return send(res, 200, { rows, errors });
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
          "x-video-seek-time": String(seekTime), "x-video-duration": String(video.duration || 0),
          // The relay streams in chunks and drops content-length; without a size
          // the player cannot tell a dropped connection from the end of the file.
          "x-video-bytes": String(info.size - offset) });
        const stream = createReadStream(files.media, { start: offset });
        res.once("close", () => stream.destroy());
        stream.once("error", () => res.destroy());
        stream.pipe(res);
        return;
      }
      return send(res, 404, { error: "Not found." });
    } catch (error) {
      if (!res.headersSent) send(res, error.status || (/valid|quality|waiting|large/i.test(error.message || "") ? 400 : 500), { error: String(error.message || error) });
      else res.destroy(error);
    }
  });
  return {
    server,
    start: () => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); }),
    stop: () => new Promise(resolve => server.close(resolve)),
  };
}
