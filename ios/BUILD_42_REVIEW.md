# Tesla Video Pilot · Version 0.1.30 · Build 42

This is an experimental native Picture in Picture playback test, on top of Build 41's reliability fixes. It is not an always-on hosting guarantee and does not place the app dashboard in PiP.

## Test on iPhone

1. Install and personally sign the IPA. Enable Picture in Picture in iPhone Settings → General → Picture in Picture, if disabled.
2. Start hosting, and leave diagnostics enabled in Video Pilot Settings.
3. In Video Pilot Settings, open **Picture in Picture test → Choose movie**. Select a real H.264 MP4 or other iPhone-compatible movie from Files. The app makes a private cache copy; it does not upload this movie to the Tesla or add it to the preparation queue.
4. In the native player, tap the PiP button, then switch to Instagram. The player can also enter PiP automatically when supported by the device's settings.
5. Keep the movie playing and try Tesla playback for at least five minutes, including beyond the normal background grace period. Note the time of any Tesla stall.
6. Return to Video Pilot and export **app + received web log**. PiP events, foreground/background events, grace-period expiration, and tunnel state/RTT events let us compare the two paths. Missing intervals can indicate suspension but do not prove the precise cause.
7. Repeat with PiP closed as a comparison. Stop the test movie when finished.

## Behavior and limits

- Uses AVPlayerViewController with real playback and the audio background mode. No fake silent media, loops, timers, VPN extension, or private APIs.
- The host retains the native player independently of tab navigation. PiP restoration opens its player sheet; closing PiP while the sheet is dismissed stops hidden playback. Explicit Stop releases the player, cache file, and audio session.
- File copy and asset validation run before playback, with stale-operation guards and cleanup. Unsupported movies fail with a useful message. Tesla's MPEG-1 files are not natively compatible.
- PiP requires physical-device validation. iOS may stop playback or hosting, and another app's audio may interrupt the movie. It uses extra battery and disk space, and the selected video ends normally.
- No Worker code or settings change is required. Existing MAX_CHUNK=131056 and MAX_REQUESTS=8 remain compatible.

The public workflow runs source safety, browser/relay checks, Swift Core tests, native download/conversion checks, archive, and package verification before publishing. Those checks establish compile/package and existing playback regression coverage, not PiP or background tunnel survival on an iPhone.
