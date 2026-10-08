# Video Pilot iPhone distribution — native prototype 0.1.28

This distribution lives in `ios/` on the `iphone-native` branch of the same Tesla Video Player repository. The iPhone is the origin server; the Tesla opens the served browser interface. It does not need Express, PostgreSQL, Python, Telegram, or a laptop at runtime.

**Status:** native prototype source, not a validated release. Native compilation runs in the iPhone GitHub workflow. Real iPhone/Tesla testing is required before calling the app usable. Version 0.1.4 implements a native outbound WebSocket relay through the existing Cloudflare Worker. A one-time Worker update and the existing TV_SECRET are required before the public URL reaches the phone. This build does not deploy your Cloudflare account automatically.

The user confirmed that v0.1.2 opens its GUI and began local media/YouTube testing. Version 0.1.3 adds a new dashboard, progress reporting, traffic measurements, a custom icon, and supported background transfers; those additions still need physical-device validation.

Version 0.1.28 build 33 carries the approved bright Video Pilot media-cockpit identity into the iPhone and Tesla web UI: a clean center-screen play surface, silver Tesla-inspired framing, graphite **Video Pilot** wordmark, and persistent light/dark appearance toggles. It intentionally has no red accent, rocket, or extra version text. The marketing version remains 1.28; the build number is the incrementing source/IPA revision.

## Implemented

- SwiftUI app starts/stops a native Network.framework HTTP server on port 5000 and shows network addresses plus the public Cloudflare address.
- Host, Videos, and Settings tabs provide hosting controls, copyable addresses, a clear public-access warning, video status cards, and background preferences. A custom opaque app icon is exported from the original artwork for the iPhone asset catalog.
- Download progress uses URLSession byte totals (an indeterminate indicator is used when the server provides no total). Processing progress uses FFmpeg's output timestamp and the input duration. Progress also appears in the Tesla browser.
- Network icons follow the phone's actual Wi-Fi/cellular/offline path and local listener/stream activity. Receiving/sending speeds and a 30-second graph measure app traffic in Mb/s. They do not measure modem signal strength or maximum link capacity. The Cloudflare indicator follows the actual relay handshake, reconnecting, rejected keys, and disconnects. The app reconnects after network interruptions and Wi-Fi/cellular changes.
- The app keeps its screen awake while hosting or preparing by default. Background URLSession downloads can continue after switching apps; persistent preparation jobs and task descriptions reconnect transfers after a system relaunch. Video processing waits for the app to be active. Explicitly force-quitting the app can cancel background transfers.
- Optional extra background time uses iOS's finite background-task allowance for existing hosting/processing. When that allowance expires, hosting pauses and resumes on reopening. This is not indefinite locked-screen hosting.
- The Tesla browser can pair, submit YouTube video URLs/IDs, search with an optional YouTube Data API key, see preparation progress, and play prepared videos.
- YouTubeKit performs extraction locally on the phone, without a remote extraction fallback. Combined streams or separate audio/video streams are downloaded with URLSession.
- An embedded FFmpeg library converts downloaded or imported MP4/MOV files into MPEG-TS with MPEG-1 video and MP2 audio. Conversion finishes before playback starts; this is not live conversion.
- The browser uses the repository's existing JSMpeg decoder, canvas rendering, and incremental HTTP transport. Pause pauses HTTP consumption, and closing the player aborts the stream.
- Prepared MPEG-TS files receive a timestamp/PAT seek sidecar. Seeks no longer use a variable-bitrate byte ratio, and decoder teardown is serialized so rapid forward/backward seeks do not overlap old and new buffers.
- Local metadata is stored in an atomic JSON index; no PostgreSQL service is needed. Files remain in the app sandbox. Preparation interrupted by app termination is marked failed on next launch.
- The tunnel key and YouTube search key are stored in Keychain. Face ID/device authentication is requested once when hosting first starts in each app session. There is no browser PIN or login gate after that: anyone who obtains the public URL can view the library, queue downloads, and stream while hosting is active. Browser writes still require a matching Origin/Host.
- Account sign-in is not a generic browser feature. The safe YouTube OAuth design, scopes, PKCE flow, and Google Cloud prerequisites are documented in [`OAUTH.md`](OAUTH.md); the current API-key search remains public-data-only.

## Install locally

### Update without a computer during routine use

The existing unsigned MK8 IPAs can be imported into **SideStore** on the iPhone for signing and installation over MK8. Set SideStore up once with a computer, then use **SideStore → My Apps → + → select the new IPA in Files** for each version. Wi-Fi and LocalDevVPN are required during installation/refresh. Use the same Apple Account and retain the existing MK8 app during the transfer to preserve its data. Seven-day signing refreshes also run on the phone; expired SideStore or invalid pairing can require a computer for recovery. See [the MK8 phone update guide](PHONE_UPDATES.md) for setup, current official downloads, and transfer instructions.

### GitHub build / sideload

1. Open the repository's [Releases page](https://github.com/Peachview747/Tesla-Video-Player/releases) in your regular browser while signed into GitHub. This is a private repository, so the browser needs repository access.
2. Open the newest iPhone prerelease, then download `Tesla-Video-Pilot-Ver-<version>-Build-<build>.ipa` from **Assets**. Select that IPA directly in Sideloadly. Version 0.1.1 selects only the ordinary arm64 device slice from bundled FFmpeg frameworks and prepares Apple ad-hoc signatures. The build signs, replaces signatures, and strictly verifies the app/frameworks before packaging. These template signatures do not authorize installation; your sideload tool still needs to perform personal Apple signing. GitHub's automatically generated Source code ZIP/TAR files contain the project sources. Workflow artifact ZIPs remain available as a fallback under **Actions → iPhone distribution** and must be extracted to obtain the inner IPA.
3. Sign and install it with Sideloadly or AltStore using your own Apple ID and their current instructions. Both standard routes need a computer for initial setup; GitHub alone cannot sign/install the app onto an iPhone. Never add your Apple ID password or signing material to this repository or chat.
   If the iPhone says **Untrusted Developer**, open **Settings → General → VPN & Device Management**, select your Apple ID under **Developer App**, and choose **Trust** (or **Trust & Restart**). If prompted, enable **Settings → Privacy & Security → Developer Mode**, restart, and confirm.
4. Free personal signing normally needs renewal every seven days and has app limits. Paid Apple developer signing offers different options. An unsigned IPA cannot install directly from Safari. This prototype has no TestFlight distribution yet.

Version 0.1.2 explicitly embeds the dynamic `FFmpeg-Kit.framework` wrapper required at launch, in addition to the eight FFmpeg binary frameworks. Version 0.1.1 omitted that wrapper. Packaging now rejects missing bundled dependencies before an IPA is published.

Version 0.1.3 enables **Background downloads**, **Allow extra background time**, and **Keep screen awake** by default under Settings. iOS controls background scheduling and runtime; continuous hosting still requires keeping MK8 open. Keep the app in the app switcher rather than swiping it away during downloads.

### Version commits and downloads

Each new version's code and build changes are committed to `iphone-native`. Before pushing a new version, update `ios/DISTRIBUTION.json`, `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` in `ios/project.yml`, and the reported version in `ios/App/HostModel.swift`. The iPhone workflow builds and validates the committed source, then publishes the compiled IPA as `Tesla-Video-Pilot-Ver-<version>-Build-<build>.ipa` to a matching `ios-v<version>` GitHub prerelease. Release publishing runs only from `iphone-native` after both build/check jobs pass. Pull-request checks do not publish.

Existing version assets are preserved. Bump the version before publishing a changed app. The IPA release assets are stored in the same GitHub project as the source commits. Direct IPA files can also be provided in chat for users who cannot sign into GitHub in their browser; chat download links may need to be refreshed after they expire.

### Mac with Xcode

Install Xcode and XcodeGen (`brew install xcodegen`), then from the repository:

```bash
python3 ios/scripts/prepare_web.py
bash ios/scripts/prepare_icon.sh
cd ios
xcodegen generate
open MK8iPhone.xcodeproj
```

Choose your signing team under Signing & Capabilities, choose a unique bundle identifier if necessary, select your connected iPhone, and run. Enable Developer Mode and trust your developer signing profile when iOS asks. The minimum target is iOS 17. `bash ios/scripts/build_unsigned.sh` builds an unsigned IPA on a Mac. Use Xcode 26 or later for the iOS 26 background API. CI selects Xcode 26.3.

## First device test

1. Join the iPhone and Tesla to the same Wi-Fi for the simplest network test. Personal Hotspot is a separate test; the app lists detected addresses, but Tesla-to-iPhone reachability has not been verified.
2. Start hosting and allow local network access on the phone. Keep the app in the foreground.
3. Open one of the displayed `http://<address>:5000` URLs in the Tesla browser after Face ID authorizes hosting. Local and public access are intentionally open while hosting is active; keep the address private.
4. Import a short local MP4/MOV in the iPhone app. Wait until it is ready, then play it in the Tesla browser. Verify audio, aspect ratio, pause/resume, restart, and end-of-file behavior.
5. Test a short YouTube URL. Extraction depends on YouTube's changing upstream behavior; blocked/unsupported videos display an error. No YouTube extraction has been verified on this phone yet.
6. Optionally configure a YouTube Data API v3 search key on the phone. Without one, the browser still supports video URL/ID submission and the local library.

Importing `.ts` bypasses conversion and only checks TS packet framing; use streams already encoded as MPEG-1 + MP2. Other TS codecs will not play in JSMpeg.

## Connect your existing Cloudflare URL

Version 0.1.4 runs **iPhone → outbound TLS WebSocket → Cloudflare Worker → Tesla browser**. It uses native URLSession code inside the app. The media stack and prepared videos remain on the iPhone. A Cloudflare Durable Object multiplexes browser requests and forwards binary response chunks. The external Origin/Host is preserved and the public URL is the access control. Browser credits bound queued relay payloads; HTTP/TCP and browser buffers can still prefetch data. Version 0.1.8 sends larger chunks without the earlier artificial delay, using the existing relay protocol. No desktop cloudflared executable runs on iOS.

1. Download and extract the matching **Cloudflare Setup ZIP** from the iPhone release.
2. On your Windows PC, run **Setup-iPhone-Tunnel.cmd** and give it the path of your original MK8 folder containing `.env`. Sign into the Cloudflare account that owns your TV URL if asked.
3. The setup updates the existing `tv` Worker, retains its KV target/laptop fallback, adds a SQLite Durable Object, and tests the existing `TV_SECRET`. If the local key differs from Cloudflare, it synchronizes the existing local key and retests. Wait for **KEY TEST PASSED**.
4. In the iPhone app, open **Settings → Cloudflare tunnel**, paste only the value of `TV_SECRET`, and tap **Save tunnel key**. The key stays in Keychain.
5. Tap **Start hosting** and approve Face ID once. Wait for **Cloudflare tunnel: Connected**, then open **https://tv.jcruzhoovertesla.workers.dev** in the Tesla browser. No browser code is required; keep the public address private.

The phone and Tesla each need internet access; shared Wi-Fi is optional. Keep MK8 foregrounded for continuous hosting. iOS's finite background allowance applies to the relay too. Background downloads use a separate system session and do not extend tunnel runtime.

A connected phone owns the public URL; its errors do not fall back to the laptop mid-request. When the phone disconnects, new requests use the existing laptop target if one exists. Another phone with the tunnel key can replace the current connection. Browser cancellation releases file handles. Concurrent relay requests are limited to eight; request bodies to 16 KiB; binary frames to a 16-byte UUID plus 32 KiB of payload. Cloudflare account quotas/billing apply. Details and Windows deployment instructions are in [cloudflare/README-iPhone.md](../cloudflare/README-iPhone.md).

## Validation and dependencies

Portable checks: `node --test ios/Web/tests/*.test.js`, `node --check ios/Web/app.js`, and `python3 ios/scripts/prepare_web.py`. Packaging checks: `python3 -m unittest discover -s ios/scripts -p 'test_*.py'` and `python3 ios/scripts/package_ipa.py --check <app.ipa>`. Core parsing/URL/argument, transfer-rate/progress, and persistent job recovery tests: `cd ios && swift test`. iPhone compilation and Apple signing verification: the GitHub workflow or Xcode on a Mac. Sideloadly acceptance and installation of this version still need device testing. Test background downloads by switching apps, waiting for completion, reopening MK8, and confirming processing resumes and playback works. Separately test system-driven relaunch and the expiry/resumption of background hosting time.

Dependencies are pinned in `project.yml`: YouTubeKit at `e5b7d0396ce12bf3444f0d209e8436c83373b7af` and the community FFmpegKit SPM package at `b3a2c365e89c5ec8fdc0debd7b7030152b572620`. The latter uses the full FFmpeg 5.1.2 binary assets with package checksums, including the required MPEG-1/MP2 encoders and MPEG-TS muxer; the upstream FFmpegKit project is retired and these binaries are old. They are suitable only for evaluating this prototype, not an assertion of ongoing maintenance. Replace with a maintained/reproducible native build and review dependency license obligations before distributing a release.

Cloudflare integration tests: `cd cloudflare && npm ci && npm test` (real workerd runtime plus direct reader-credit checks). These verify tunnel authentication, exact stream bytes, external header/cookie forwarding, multiplexing, cancellation, disconnects, laptop fallback, and bounds. The published setup ZIP explicitly excludes `.env`, login state, and tokens.

Remaining release checks: real YouTube extraction, iPhone encoding speed/temperature/storage use, Tesla playback compatibility, hotspot reachability, background transfer/relaunch behavior, live Cloudflare deployment, relay network handoff, and personal Apple signing. Processing starts/resumes in the foreground; downloads use the system background session when enabled. Continuous hosting still requires foreground use. Nothing is promised to run indefinitely with the phone locked.

## Version 0.1.6: media preparation and background work

The earlier reduced FFmpeg binary excluded MPEG-1 and MP2 encoders and the MPEG-TS muxer. This version pins the full FFmpeg 5.1.2 package. The build runs six real native conversions (three quality levels, combined/separate audio), probes the output codecs and decodes the output before packaging. These checks run on macOS with the same binary distribution; physical iPhone/Tesla validation remains necessary.

480p is the default to reduce transfer size and preparation time. Choose 360p for speed or 720p for detail. YouTube selection prefers H.264 video and AAC audio; supported large Googlevideo transfers use three concurrent 2 MiB range requests per track when a continued-processing job is active or background downloads are off. Ranges are validated against Content-Range and exact file sizes before assembly. Providers without advertised range support use a normal transfer. When iOS does not grant continued processing, a single background transfer avoids needing repeated app wakeups to schedule each chunk. Actual Wi-Fi/cellular speed depends on the video server and network; no device speed improvement has been measured yet.

The Videos tab shows download speed and estimated time remaining, offers Pause/Resume and Retry, and retains completed downloads and verified chunks after failures. Conversion errors can be shared using Error details. Delete a video to also delete its cached source and diagnostics. Previous versions deleted failed sources, so an old failed item may need to download once more.

On iOS 26, **Background preparation** requests a finite, user-started CPU/network task and reports real progress in the system interface. iOS can decline or expire that request; then background URLSession downloads remain supported, and conversion waits for MK8 to reopen. Force-quitting stops background work. Sources use protection that allows access after the first unlock, including subsequent screen locking. No GPU entitlement is requested, to preserve personal sideload signing.

This does not grant unlimited background hosting. After UIKit's hosting grace expires, the local server and Cloudflare socket stop; the Host tab reconnects on return. For uninterrupted Tesla playback while charging, keep **Keep screen awake** enabled and use **Dim screen for charging** on the Host tab. It lowers screen brightness while displaying status; returning restores the prior brightness. A charger does not override iOS suspension.

## Version 0.1.7: foreground download performance

Foreground downloads no longer require an iOS continued-processing grant to use the fast path. MK8 checks an actual one-byte range response, including servers that omit Accept-Ranges or return HTTP 200 with a valid Content-Range. If Range is ignored, the probe cancels at headers instead of buffering the full video; a normal transfer remains available. Up to four video and two audio requests use the foreground session, with 4 MiB chunks and high task priority. Completed chunks and verified transfer plans persist for retry/relaunch.

When the phone backgrounds without an ongoing processing grant, active foreground chunk requests are canceled and the contiguous verified prefix is retained. One background request fetches the remaining bytes; this avoids repeated background wakeups for each chunk. The persisted plan reconnects that remaining transfer after relaunch. Noncontiguous chunks beyond the prefix may be fetched again during this transition.

Download speed is displayed consistently in **MB/s** (decimal megabytes per second), alongside its **Mb/s** equivalent: 1 MB/s = 8 Mb/s. The progress card identifies Fast download versus Background download. These are observed media bytes, not a Wi-Fi speed test. This change removes app-side fallbacks; it does not guarantee a particular YouTube/server/network rate.

The build also compiles the production downloader into a native macOS HTTPS integration check. Its test-only constructor pins an exact temporary certificate to the loopback host/port; the app singleton keeps system TLS validation, and no system trust store is modified. The temporary private key is never packaged. The check verifies four concurrent foreground transfers, exact assembled source bytes and coalesced traffic totals, missing HEAD/Accept-Ranges support, HTTP 200 range compatibility, ignored-range fallback, malformed/truncated rejection, and background handoffs with/without a completed prefix. Physical iPhone scheduling and upstream YouTube throughput remain device tests.

## Version 0.1.8: prepared-video playback

The user's recording shows a prepared video reaching the phone browser through the public URL, with sending around 0.4 Mb/s. The earlier tunnel sent only 6,016 bytes per browser credit and added a 25 ms delay to each chunk. Every chunk also incurred a network roundtrip, so that rate could fall below the prepared video's bitrate and starve playback.

File responses now use 32,712-byte chunks (174 complete MPEG-TS packets), within the existing Worker's 32 KiB payload allowance, without the artificial delay. One queued pull can arrive while the preceding send completes; a serial drain preserves one chunk per credit and checks request/connection identity after awaits. Cancellation closes the file and cancels both preparation and transfer work. Local HTTP advances when the socket finishes processing its previous chunk. These changes do not require another Cloudflare deployment or a new tunnel key.

The browser stops reading ahead at six seconds of media headroom and resumes at three seconds. Manual Pause remains separate from this read-ahead wait; Close/Restart cancels the request. This limits network read-ahead, while the existing recorded JSMpeg decoder retains playback history. The status follows decoder stalls and successful frames, rather than declaring playback active on the first network chunk. Play/resume/unmute also retry browser audio activation.

Update the app, reopen the browser page, and play an existing ready video again; no new conversion is needed. For the intended Tesla test, keep MK8 open on the iPhone and open the public URL in the Tesla browser. Opening another browser on the same iPhone backgrounds MK8 and uses only iOS's finite hosting grace period. Large chunks reduce app-imposed overhead, but the existing one-credit relay still depends on network latency, so a particular speed or continuous locked-screen hosting is not guaranteed.


## Version 0.1.9: preparation speed

The user confirmed that 0.1.8 downloads and playback work, with preparation remaining slow. Preparation must still encode MPEG-1 video for the existing Tesla player. Version 0.1.9 requests Apple's VideoToolbox decoder for the source video and retries with software decoding if that attempt fails. Cancellation never starts a retry; downloaded sources remain available. Neither attempt needs a restricted GPU entitlement.

High-frame-rate video is capped at 30 fps before scaling and padding, avoiding resize work for frames the player will not use. Lower source rates stay unchanged until the final 30 fps output conversion. The existing 360p, 480p, and 720p dimensions and bitrates, MPEG-1 video/MP2 audio/MPEG-TS format, motion estimation, and encoder threading stay the same. This does not change the download or relay path. Hardware decoding helps only the decoding portion; MPEG-1 encoding remains on the CPU, and actual phone speed depends on source complexity, model, temperature, and iOS scheduling.

The preparation card and web browser show media seconds processed per elapsed second (for example, 2.0× real time) and an ETA measured separately from downloading. A short warmup and rolling measurement avoid reusing download speed or showing stale rates after a stall. Test with a new video or resume a cached unfinished video; existing ready videos do not need to be prepared again. Compare the same clip and quality on the phone before claiming an overall improvement.


## Version 0.1.10: real YouTube transfer requests

A user screenshot shows a 107.9 MB YouTube download at 0.30 MB/s (2.36 Mb/s) on 5G UC while Speedtest reports 232 Mb/s. The downloaded bytes and six-minute ETA agree with the slow transfer. Speedtest measures another server; a fast result does not establish Googlevideo throughput. The old Fast download label indicated four concurrent video requests, so this version calls it Parallel download.

MK8 adds Googlevideo URL query ranges, an alternate request form described in [YouTubeKit issue 17](https://github.com/alexeichhorn/YouTubeKit/issues/17) and used by yt-dlp's YouTube fragments. It verifies range behavior before selecting the alternate method, retains the header-range fallback, and preserves the existing signed query bytes and n parameter. Query requests use the URL range alone. Responses without Content-Range are accepted only after a nonzero byte slice matches an independently validated header-range response; completed chunks must then match their exact requested size under the saved, verified strategy. It does not change signed range parameters or use this method on unrelated HTTPS hosts. The chosen method is persisted through retry and background handoff. Chunk count, received bytes and framing remain validated before assembly. Older plans retain their original method and cached parts.

Share download details on the active progress card exports local request starts and completion metrics: CDN hostname, request method, range strategy, protocol, byte counts, elapsed time, time to first byte, and cellular status when available. The bounded local report omits full URLs, query values, cookies, credentials and IP addresses. Reports stay with unfinished jobs and are removed with the preparation job after success or deletion. A speed test on this build is still not a measurement of YouTube transfer speed.

Use a new download to exercise request negotiation, then compare the same video and quality on Wi-Fi and cellular. Existing unfinished plans keep their previous method. If the transfer remains near 2.5 Mb/s only on cellular, carrier video shaping is one possibility; the screenshot alone does not prove it. Native fixtures check request behavior and file integrity, not Googlevideo bandwidth or the user's carrier.
