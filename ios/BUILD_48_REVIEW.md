# Tesla Video Pilot · Version 0.1.36 · Build 48

## Softer look (iPhone and Tesla)
- **Tesla page.** New theme tokens: no pure-white panels in light mode (soft grey surfaces, `#2b353c` text, muted slate
  buttons) and a dim charcoal dark mode (`#161b1f` background, `#d2d9de` text) instead of near-black with near-white
  text. Hard-coded white panels from earlier builds now use the tokens. With no saved choice the page follows the
  browser's light/dark preference.
- **iPhone app.** `MK8Theme` softened the same way (dark-mode accent is now a muted steel blue rather than near-white).
  Settings → Appearance is a Match iPhone / Light / Dark picker; new installs default to Match iPhone.

## Library
- **Channels view (default).** One row per channel with avatar, video count, unwatched count and latest release.
  Tap to expand: videos in sequential release order, numbered #1, #2…, with thumbnail, duration, watched progress,
  and Play / Resume / Watch again. A **Play next** button resumes the first unfinished video; the order can be
  flipped (Oldest first / Newest first). Open channels are remembered.
- **All videos view** keeps the Build 47 sort menu.
- **Continue watching** row for partly watched videos, most recent first. Finished videos are marked watched.
- **Filter** box matches title or channel and opens matching channels.

## Search
- **Keyless.** `/api/search` uses YouTube's InnerTube search (no API key, no daily quota), returning duration, views
  and age plus a continuation token. The Data API (key or Google account) remains a fallback, and its HTML-escaped
  titles are now decoded.
- **Suggestions** as you type (`/api/suggest`), **filters** (Under 4 min, 4–20 min, Over 20 min, This week,
  Newest), **Load more**, **recent searches**, tap a channel name for more from that channel, and pasted links add
  the video directly. Result buttons show whether a video is already in the library or preparing.

## Diagnostics
- `playerStalled` is limited to one entry per second (Build 44 log: 316 entries in ~70 s during a network drop).
