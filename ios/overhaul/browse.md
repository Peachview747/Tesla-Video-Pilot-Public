# browse progress log

- [x] 4. Version: HostModel.version/build read CFBundleShortVersionString/CFBundleVersion from Bundle.main (HostModel.swift). CSP img-src also allows https://yt3.ggpht.com and https://yt3.googleusercontent.com (channel avatars).
- [x] 1. GET /api/channel (id | name | video | continuation) — YouTubeBrowse.swift (InnerTube browse/next/resolve_url parsing, lockupViewModel + videoRenderer), YouTubeInnerTube.swift (shared `post`, `browseID`, search hits carry `channelId`, continuation token now taken only from continuationItemRenderer — search "Load more" could previously pick a filter-chip token).
- [x] 1b. Library items carry `channelId` (Library.swift, optional → old library.json still decodes). Filled lazily: up to 12 items per GET /api/library via InnerTube `next`; also learned whenever a channel/feed lookup sees the video; and POST /api/youtube accepts optional `channelId`/`channel` to set it immediately.
- [x] 2. Watch history on the phone (BrowseService in YouTubeBrowse.swift, persisted to Application Support/MK8/history.json, max 300). Play recorded on every GET /api/stream/<id>.ts; progress via new POST /api/history. GET /api/history, POST /api/history/remove, POST /api/history/clear.
- [x] 3. GET /api/foryou rows: Continue watching, Because you watched <X> (≤3 seeds), New from channels you watch (≤6 channels × 5 newest), Subscriptions (signed in). Remote rows cached 3 min (30 s if partial); per-row failure tolerant; subscriptions waited for ≤9 s from request start then cached 10 min.
- HostModel.swift: lazy `browse: BrowseService`, one insertion before the /api/library route (`browse.respond(...)`), one line in /api/youtube (`browse.adopt`).

## API contract

All JSON. Optional fields are OMITTED (not null) when unknown unless noted.
Errors: `{"error": "message"}` with 400 (bad input), 404 (not found), 503 (YouTube unreachable).
POST routes require same-origin (like every existing POST).

### Video object (used by /api/channel and /api/foryou)
```
{
  "id": "dQw4w9WgXcQ",          // YouTube ID; for a local import in "Continue watching" it is the library UUID
  "title": "…",
  "channel": "Rick Astley",     // optional (continuation pages of a channel usually omit it — use the page's channel name)
  "channelId": "UC…",           // optional; tap → /api/channel?id=
  "thumbnail": "https://i.ytimg.com/vi/<id>/mqdefault.jpg",  // optional for imports
  "duration": "3:33",           // optional display string ("1:02:03")
  "published": "6 days ago",    // optional relative text
  "views": "1.2M views",        // optional
  "youtube": true,              // false only for local imports (play via libraryId, cannot be added)
  "libraryId": "UUID",          // present when already in the phone library
  "libraryState": "ready",      // with libraryId: ready | preparing | failed | paused | importing
  "position": 123.4,            // optional seconds watched (from phone history)
  "progress": 0.42              // optional 0…1
}
```
To add a video: existing `POST /api/youtube {"url": "<id>", "channelId": "UC…"?, "channel": "name"?}` (the two new fields are optional).
To play a video with `libraryId` and `libraryState == "ready"`: existing `/api/stream/<libraryId>.ts`.

### GET /api/channel
Query (one of): `id=UC…` (24 chars) | `video=<YouTube ID or URL>` (channel of that video) | `name=@handle` or `name=Channel Name` (search best match).
Optional `refresh=1` bypasses the 10-min cache. More pages: `continuation=<token>` (alone).
```
{
  "channel": {"id": "UC…", "name": "MrBeast", "handle": "@MrBeast",          // handle optional
              "avatar": "https://yt3.googleusercontent.com/…=s176-…",        // optional
              "subscribers": "520M subscribers"},                            // optional
  "videos": [Video…],          // newest first, ~30 per page, live/upcoming excluded
  "continuation": "token"      // optional; absent = no more pages
}
```
Continuation responses have NO `channel` key, only `videos` (+ `continuation`).
Avatar hosts: yt3.ggpht.com / yt3.googleusercontent.com (CSP updated; app.js image allowlist around line 195 must allow them too).

### Watch history
- `POST /api/history {"id": "<library UUID>", "position": 123.4, "duration": 600?, "finished": false?}` → `{"recorded": true}`.
  Send every ~15 s while playing, on pause/seek/close (`finished: true` at the end). 404 if the item is gone.
  The phone already records a play when `/api/stream/<id>.ts` is requested (no position).
- `GET /api/history?limit=50` (1…300) → newest first:
```
{"items": [{"key": "dQw4w9WgXcQ"|"<uuid>", "libraryId": "UUID"?, "youtubeID": "…"?, "title": "…",
            "channel": "…"?, "channelId": "UC…"?, "thumbnail": "…"?, "position": 123.4, "duration": 600?,
            "progress": 0.2?, "watchedAt": "2026-10-10T05:00:00Z", "plays": 2,
            "inLibrary": true, "state": "ready"?}]}
```
  `libraryId`/`state` are present only while the item is still in the library.
- `POST /api/history/remove {"key": "…"}` or `{"id": "<library UUID>"}` → `{"removed": n}`.
- `POST /api/history/clear {}` → `{"cleared": true}`.

### GET /api/foryou
Optional `refresh=1`. Can take several seconds cold (≤ ~10 s); cached afterwards.
```
{
  "rows": [
    {"title": "Continue watching", "kind": "continue", "videos": [Video… with libraryId, position, progress]},
    {"title": "Because you watched <title>", "kind": "related", "seed": "<youtube id>", "subtitle": "<channel>"?, "videos": [...]},
    {"title": "New from channels you watch", "kind": "channels", "videos": [...]},
    {"title": "Subscriptions", "kind": "subscriptions", "videos": [...]},      // only when signed in
    {"title": "Because you watched <title>", "kind": "related", ...}            // up to 3 related rows total
  ],
  "errors": ["Subscriptions are still loading. Refresh in a moment.", …],   // informational, may be empty
  "generatedAt": "ISO-8601",
  "signedIn": false
}
```
Empty rows are omitted; `rows` can be `[]` for a brand-new install (show search / library instead).
Order: continue, first related, channels, subscriptions, remaining related. "Because you saved <title>"
rows (kind `related`) appear when history is short and seeds come from the library.

### Other changes
- `GET /api/library` items now may include `"channelId": "UC…"`.
- `GET /api/search` hits now may include `"channelId": "UC…"`.
- `/api/status` `version`/`build` now come from the bundle (no more stale "0.1.31 / 43").

## Remaining / notes
- No Swift compiler here: CI must compile YouTubeBrowse.swift.
- Worker: `/api/foryou` cold can approach the 15 s first-byte timeout on slow links (plan already notes raising it for API calls).
