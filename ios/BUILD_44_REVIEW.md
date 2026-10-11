# Tesla Video Pilot · Version 0.1.32 · Build 44

Fixes from the Build 43 device log.

- **Tunnel no longer restarts on every return to the foreground.** `foregrounded()` now calls
  `connectTunnel(force: false)`, which leaves a connected/connecting/reconnecting tunnel alone.
  Previously each keepalive stop (= foreground) tore down the socket and every active stream.
- **Locked phone no longer kills the tunnel.** The tunnel key was stored `WhenUnlockedThisDeviceOnly`, so a
  network-path change while locked read an empty key, stopped the tunnel and marked it "not configured"
  until unlock (about 42 minutes in the Build 43 log). The key is now
  `AfterFirstUnlockThisDeviceOnly` (existing installs are migrated at launch) and `connectTunnel` falls back
  to the in-memory key if the Keychain read fails.
- **HTTP 429 ("iPhone is busy") is retried in the web player** with 300 ms to 3 s backoff, up to 5 times,
  logged as `playerBusyRetry`. Seek debounce is 350 ms with a 150 ms grace after tearing down the old stream.

Not changed: the Worker's 8-request limit. What held the other pending requests during the 429 burst at
04:27:54 is still unknown; check `playerBusyRetry` counts in the next log.
