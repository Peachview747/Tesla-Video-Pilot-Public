# Tesla Video Pilot · Version 0.1.35 · Build 47

- **Library sorting.** The Tesla library has a Sort menu: Recently added, Release date · newest, Release date ·
  oldest, and Channel (grouped under channel headings, A–Z, newest first inside each). The choice is remembered in
  the browser. Videos without a release date (imports, or not yet filled in) sort last.
- **Channel and release date.** YouTubeKit's metadata has neither, so `YouTubeDetails` reads the channel from
  YouTube's public oEmbed endpoint and the release date from the watch page's structured data (no API key or
  Google sign-in). Fetched once after a video is prepared; existing library items are filled in at app launch.
  Stored as optional `channel` / `publishedAt` on `LibraryVideo`, so older `library.json` files still load.
- **Audio crackle.** JSMpeg decoded recorded audio only 0.25 s ahead of the speaker, so any main-thread stall
  longer than that (video decode on the Tesla CPU) left a gap between WebAudio chunks, heard as a click.
  `installRecordedAudioLead` keeps 0.75 s decoded ahead. Remaining gaps are counted and logged as
  `browser/audioUnderrun` (`underruns`, `gapMs`), at most once every 2 s.
