# Tesla Video Player — Bulletproof (Drive-mode)

This build is designed so **video cannot go black when you shift into Drive**.

## Why previous versions failed

Tesla’s browser hooks every HTML `<video>` element and forces `pause()` when the car leaves Park. Drawing a paused video onto a canvas produces a black frame. Fighting that with `play()` loops is best-effort and breaks on stricter firmware.

**WebCodecs is not available** on current Tesla Chromium, so pure WebCodecs players also fail.

## The bulletproof approach

```
Your laptop (ffmpeg)
    │  MPEG-TS  (mpeg1video + mp2, no B-frames)
    ▼
Cloudflare tunnel / permanent Worker URL
    │
    ▼
Tesla browser
    JSMpeg  →  WebGL / Canvas   (NO <video> element at all)
```

Tesla has nothing to pause. The picture keeps moving.

This is the same family of technique used by working open-source Tesla theater clients.

## What you get

| Piece | Role |
|-------|------|
| `/api/stream/:videoId.ts` | On-the-fly ffmpeg → MPEG-TS, authenticated by your login cookie |
| `BulletproofVideoPlayer` | JSMpeg player on a canvas; no `<video>` |
| `/jsmpeg.min.js` | Vendored decoder (served from the same origin) |
| Containerfile.web | Now installs `ffmpeg` |

Everything else (local Colima/`tesla.sh`, Cloudflare Worker permanent URL, Telegram bot, library, auth) is unchanged.

## How to run

```bash
# Rebuild the web image so ffmpeg is present (first time after this upgrade)
./tesla.sh stop
# force rebuild if your script caches images — e.g.:
colima --profile tesla nerdctl -- compose -p tesla -f compose.yml build --no-cache web
./tesla.sh
```

Open your permanent `TV_URL` in the Tesla browser, log in, pick a video.

### Usage tips

1. Start the video (works in Park or Drive — no special order required).
2. Debug panel (top-left) should show `State: playing` and advancing time.
3. Seeking is limited with progressive MPEG-TS; the Restart buttons re-request the stream from the beginning. Continuous playback is the priority.
4. Quality is capped at ~720p / 1.8 Mbps so hotspot links stay smooth. Edit the ffmpeg args in `server/index.ts` if you want higher/lower.

## Rebuild notes

- First start after upgrading **must** rebuild the `web` image (ffmpeg is new).
- Existing MP4s in the library do **not** need re-download; they are transcoded on the fly.
- Laptop CPU will work a bit harder while a stream is active (one ffmpeg process per viewer).


## Startup speed (updated)

The stream command no longer uses ffmpeg's `-re` flag, so the first frames are
produced as fast as the laptop can encode them. First-picture time should be
noticeably shorter than the original build. Drive-mode protection is unchanged
(still zero `<video>` elements).

## Safety

For **passenger** use only. Do not watch video while driving.

## If something still fails

1. On the laptop: `./tesla.sh logs` and look for `[ffmpeg]` lines.
2. Confirm `/jsmpeg.min.js` loads (open it in the Tesla browser address bar).
3. Confirm you are logged in (stream endpoint returns 401 otherwise).
4. Try a short video first.

This path has no `<video>` element for Tesla to kill. That is what makes it bulletproof.
