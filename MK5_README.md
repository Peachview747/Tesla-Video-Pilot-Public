# Tesla Video Player — MK5

**Goal:** Fix the classic “plays in Park → BLACK as soon as you shift to Drive” problem while keeping the same local-laptop + Cloudflare permanent URL workflow you already use.

## What was wrong in MK4

Tesla’s in-car browser (QtWebEngine / Chromium) **hooks every `<video>` element**. When the car leaves Park it calls `video.pause()` at a level the page cannot fully prevent.  
`canvas.drawImage(video, …)` then paints **black** (or a frozen last frame). That is exactly the symptom you reported.

`display:none` / `class="hidden"` makes it worse on some firmwares because the media pipeline may stop decoding entirely.

WebCodecs is **not available** on current Tesla Chromium (confirmed by public capability probes), so the pure-WebCodecs path in MK4 cannot be the primary player.

## What MK5 changes

### New default player: `DriveModeVideoPlayer`

| Mitigation | Purpose |
|------------|---------|
| 1×1 off-screen video (opacity 0.01), **never** `display:none` | Keeps the media element in the pipeline |
| Immediate `play()` on every `pause` event + `stopImmediatePropagation` | Counter Tesla’s OS-level pause |
| 250 ms watchdog that re-asserts `play()` while `shouldPlay` is true | Catches pauses the event misses |
| `visibilitychange` / `pageshow` / `focus` handlers | Tesla fires these on gear change |
| Audio routed through Web Audio API; media element itself muted | Volume stays under our control |
| Optional `requestVideoFrameCallback` when present | Tighter frame timing |
| Rich debug panel (force-play count, paused flag, last drawn time) | You can see in the car whether the defense is firing |

The old `NativeVideoPlayer` is still in the tree if you ever need it.

### Unchanged (as you requested)

- Local run on the laptop (Colima + nerdctl, `tesla.sh`)
- Cloudflare quick tunnel + permanent Worker URL (`TV_URL`) so the Tesla only ever sees a stable public HTTPS origin
- Telegram bot for downloading videos
- Same auth, library, and storage layout

## How to run (same as MK4)

```bash
cd tesla-video   # or whatever you named the folder
# edit .env if needed (TV_URL, TV_SECRET, TELEGRAM_BOT_TOKEN, …)
./tesla.sh       # start
./tesla.sh stop  # stop
```

Open the permanent `TV_URL` in the Tesla browser (the one that points at your Worker).

### Recommended usage for Drive

1. Start the video **while still in Park**.
2. Confirm the debug panel shows FPS > 0 and “Video paused: no”.
3. Shift to Drive. Watch the “Force-play count” — it should climb if Tesla is poking the element; the canvas should keep updating.
4. If it still blacks, press Play once more or reload while parked and try again (some firmware revisions are stricter).

## Debug panel (top-left)

- **Force-play count** — how many times we had to call `play()` because Tesla paused us. Rising numbers while driving = the defense is working.
- **Video paused** — should stay “no” while you intend to play.
- **Last drawn t** — should advance with the video.

## Limits & honesty

- This is still a **client-side** fight against a system-level policy. On some software versions Tesla’s pause is hard enough that even forced `play()` only recovers briefly.
- Completely bullet-proof approaches require **never using `<video>`** at all (e.g. server-side MPEG-TS → JSMpeg/WebGL, or MJPEG frame stream). Those are larger changes (re-encode pipeline + new decoder). MK5 keeps your existing MP4 library and local stack.
- Safety first: this is intended for **passenger** use. Do not watch video while driving.

## Files touched vs MK4

- **Added:** `app/client/src/components/DriveModeVideoPlayer.tsx`
- **Changed:** `app/client/src/pages/VideoLibrary.tsx` (uses the new player)
- Everything else (Cloudflare worker, `tesla.sh`, compose, bot, server) is the same architecture.

## If it still goes black

1. Confirm the debug panel is visible and force-play count is increasing after you shift.
2. Try a short, low-bitrate H.264/AAC MP4 (Tesla is happiest with baseline/main @ ≤1080p).
3. Make sure you started playback in Park and only then shifted.
4. As a last resort we can add a true no-`<video>` path (JSMpeg or server MJPEG) in a later mark — say the word and we can build it on top of this stack.

Enjoy the ride (from the passenger seat).
