# Build 50 overhaul — task schedule

Each track has an owner agent and a progress log under `ios/overhaul/<track>.md`.
An agent starting (or resuming) a track MUST read its progress log first, skip
items already checked off, and append to the log after every finished item so
work survives a stop for usage limits.

## Order

| Slot | Track | Starts | Depends on |
|------|-------|--------|------------|
| 1 | `perf` — processing speed, data efficiency, delivery | immediately | — |
| 2 | `browse` — phone API for channel pages + "for you" feed | immediately | — |
| 2 | `web` — Tesla web app overhaul (items 1–6) | after `browse` | `browse` API contract |
| 1 | `app` — iPhone app UI overhaul | after `perf` | — |
| — | review — adversarial review of every track, fixes | after all | all |
| — | build — CI IPA build 50, Worker deploy, send IPA | last | review |

Only two agents run at once (4-CPU container).

## File ownership (avoid edit collisions)

- `perf`: `MediaDownloader.swift`, `MediaConverter.swift`, `MediaPipeline.swift`,
  `BackgroundPreparation.swift`, `PhoneTunnel.swift`, `HTTPServer.swift`,
  `ios/Web/http-source.js` (+ its tests), `cloudflare/**`.
- `browse`: new `YouTubeBrowse.swift`, `YouTubeInnerTube.swift`, `Library.swift`
  (watch-history fields only), route additions in `HostModel.swift`.
- `web`: `ios/Web/app.js`, `index.html`, `style.css`, `diagnostics.js`, web tests.
- `app`: `MK8App.swift`, new SwiftUI view files.
- `HostModel.swift` is shared: small, anchored edits only; re-read before each edit.

## Tracks

### perf (user item 7)
- Measure where time goes: download vs transcode vs relay; add timing diagnostics.
- Faster download: parallel ranged chunks, best itag for hardware decode, reuse sessions.
- Faster transcode: VideoToolbox decode, thread counts, encoder settings, fps/size
  tuned for the Tesla screen; start streaming while transcoding where possible.
- Data efficiency: right-sized bitrate for MPEG-1 at Tesla resolution, fewer relay
  round-trips, bigger/fewer tunnel frames, cache headers, Worker streaming without buffering.
- Background: keep work running while locked (already proven), avoid throttling.

### browse (user items 1, 2)
- `GET /api/channel?id=|name=` → channel header + recent uploads (InnerTube browse, keyless).
- Library items carry `channelId` so the web can open a channel page.
- Watch history on the phone (what was played, progress, when).
- `GET /api/foryou` → feed built from recent watch history (related videos of recently
  watched + recent uploads from watched channels), subscriptions mixed in when signed in.
- Fix hardcoded `version = "0.1.31"` in `HostModel.swift` (read from the bundle).

### web (user items 1–6)
1. Tap a channel name anywhere → channel page with all recent uploads, add-to-library.
2. Home feed "For you" from watch history, YouTube-style rows (Continue watching,
   For you, From channels you watch, Subscriptions).
3. Replace the Home/Library/Settings dropdown with a proper nav (tab bar / side rail);
   remove the circle hero decoration.
4. Home overhaul: compact header, search front and center, rows instead of a hero card.
5. Settings rebuilt: real controls (theme, playback quality, data saver, cache/storage,
   connection status, diagnostics with live stats, export log), fix stale version.
6. Overall design pass: consistent spacing/typography, readable in a car, big touch targets,
   diagnostics panel (tunnel latency, throughput, buffer health).

### app (user item 6)
- SwiftUI redesign: clearer dashboard (host status, tunnel, queue with progress/speeds),
  library management, settings grouped, diagnostics screen with live stats.

## Status
See `ios/overhaul/*.md`.

## Added after launch (user request): 1080p, upgrade old videos, queue list

Track `quality` runs after `perf` finishes (same files). Web and app tracks build the UI
against this contract now and hide the controls gracefully if an endpoint returns 404.

### API contract (phone)
- `GET /api/settings` → `{quality: "720p"|"1080p", ...}`; `POST /api/settings` `{quality}`.
  Default `1080p`. Applies to new downloads/transcodes.
- Library items gain `quality` (e.g. `"1080p"`) and `height` (int, may be missing on old items;
  treat missing as below the current setting → upgradable).
- `POST /api/library/upgrade` `{id}` or `{all: true}` → re-queues at the current quality
  setting; the old file keeps playing until the new one is ready, then it is replaced.
  Returns `{queued: n}`.
- `GET /api/queue` → `{items: [{id, videoId, title, thumbnail, stage, progress, speedBps,
  etaSec, quality, upgrade, error}]}` in processing order.
  `stage`: `"queued"|"downloading"|"transcoding"|"ready"|"failed"|"paused"`, `progress` 0–1.
- `POST /api/queue/cancel` `{id}`, `POST /api/queue/move` `{id, to}` (0 = next up).

### quality track (phone)
- Pick 1080p source formats (H.264 first for hardware decode) and transcode 1080p MPEG-1
  with a bitrate that looks good but stays efficient; verify the JSMpeg decoder in the
  Tesla browser can keep up (fall back to 720p setting if it measurably can't — log decode
  timing from the web side).
- Implement settings, upgrade, queue endpoints above; keep old file until replacement is ready.

### web/app UI
- Queue page/panel: live list with stage, progress bar, speed, ETA, cancel, move to top.
- Settings: Quality picker (720p / 1080p).
- Library: "Upgrade to 1080p" per video and "Upgrade all" (only shown for lower-quality items).
