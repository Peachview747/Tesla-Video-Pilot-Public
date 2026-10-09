# Tesla Video Pilot · Version 0.1.29 · Build 41

## Playback and audio

- Removed Build 40's unsafe decoder EVICT mode and disabled timestamp collection. Recorded playback now preserves PTS initialization, unread data, and a short audible rewind window while compacting consumed bytes.
- Added an explicit decoder-memory cap with a recoverable error instead of unrestricted growth. Large PES writes reserve sufficient space before the shipped BitBuffer writes them.
- Pausing cancels queued WebAudio sources and captures the audible position before resetting the scheduling clock. Resume replays the correct samples rather than overlapping an old tail.
- A fragmented seek header cannot block reading before a decoder establishes its clock. Late callbacks cannot update a replaced player. Ended videos restart from zero.
- Recovery respects manual pause and rearms on resume. Terminal stream failures stop decoding and offer Retry.
- Corrected reversed fullscreen button visibility and placed Exit full screen directly in the player shell, at the upper right. Controls and diagnostics text have legible light/dark contrast.

## Hosting and preparation

- Temporary Worker 5xx, throttling, and invalid availability responses remain retryable. Rejected credentials and missing protocol configuration still produce actionable errors.
- Stale listener and Face ID callbacks cannot restart a stopped host. Local stalled writes time out, and valid relay control messages use a sufficient bounded envelope.
- Queued Files imports own a durable local copy before entering the preparation queue. Import staging is invisible to resumable-job discovery.
- Queue ordering is oldest first. Pending YouTube jobs survive relaunch. Duplicate IDs use case-sensitive comparison, as YouTube requires.
- Active preparation can be cancelled and removed after teardown. Cancelled legacy-index tasks cannot recreate deleted files or replace a newer index.
- Downloads reject empty cached files and overlapping continuation registration. Failed/cancelled conversion removes partial output. Whole transport-stream validation rejects corrupt tails.
- Conversion pads short audio and ends with the video to avoid an audio-only tail. Processing waits are cancellation-aware, and corrupt range plans cannot allocate unlimited chunk arrays.

## Diagnostics and account access

- Browser evidence keeps event IDs and occurrence times locally after acknowledgement. ACKs apply to exact IDs, preventing ring-buffer rollover from erasing unrelated events.
- Local exports remain usable when disconnected. Combined exports merge all retained browser events with the app journal and remove duplicate event IDs. Full response-body reads have timeouts.
- Logs redact URLs, credentials, and email-like values before browser storage. Batches respect the host's request-size limit; frame diagnostics are throttled.
- Native journal rotation checks file metadata first, rotates with headroom, and reports retained counts. Settings shares the journal without writing snapshots during every view refresh.
- Concurrent OAuth refreshes share one operation; sign-out prevents stale token saves. YouTube requests retry one unauthorized response, and revoked refresh credentials require a new sign-in.
- Subscription feed requests include up to 50 channels. Upload-fetch errors are surfaced rather than silently becoming an empty feed. Empty/error feeds have an automatic retry cooldown so the two-second status poll cannot burn search quota.

## Verification and limits

Browser tests exercise the actual shipped JSMpeg library for long-video buffering, timestamp preservation, large PES writes, pause rewind, and scheduled-source cleanup, as well as UI lifecycle and diagnostics regressions. Relay tests use the real Worker runtime. Packaging tests and macOS Core/downloader/converter checks run before distribution.

An additional Chromium run uses real MPEG-1/MP2 media with a nonzero PTS baseline and exercises playback, pause/resume, repeated forward/backward seeking, fullscreen exit placement, and diagnostic export. This is browser integration evidence, not an on-car test.

Physical iPhone/Tesla audio, sustained cellular playback, iOS suspension, and carrier behavior still require device testing. YouTube OAuth does not expose the private YouTube Home recommendation algorithm. The app cannot grant unlimited iOS background hosting. Existing Worker code with MAX_CHUNK=131056 and MAX_REQUESTS=8 is compatible; this release does not require another Worker deployment.

The unsigned/re-signable IPA contains the compiled app. The accompanying source ZIP and this note are the useful inputs for a Grok source review.
