# Tesla Video Pilot · Version 0.1.37 · Build 49

Fixes from a multi-agent review of Build 48 (findings on library/search, Google sign-in, security, background lifecycle).

## Tesla page
- **Retry from the car.** Adding a video that is already in the library as failed or paused now retries it (or re-queues it
  when another video is preparing) instead of returning 409. New `POST /api/library/retry`; failed/paused library items show
  **Retry** and **Remove**, search results show **Retry download**.
- **Typed links.** `youtu.be/…`, `www.youtube.com/watch?v=…` and other links without `https://` are sent to the phone as the
  clean video ID. A bare 11-character word (e.g. `GTA6Trailer`) is searched; adding it as an ID is offered as a suggestion.
- **Buttons.** Search/feed buttons for the same video share state, show *Adding…* while the request runs and clear *Added ✓*
  once the library has the item. Library network actions disable themselves until they finish. Thumbnails are tappable
  everywhere (search results play or add). Feed cards follow library state.
- **Up next** lists the active item first, then the order the phone will prepare them (oldest added first).
- **Closing the player** returns to the tab and scroll position it was opened from.
- **Watched.** The last 30 s / 5 % of a video (end screens) counts as finished. Times over an hour show `h:mm:ss`.
- **Filter** keeps real episode numbers, counts and *Play next* from the whole channel.
- **Undated videos** (imports) keep the order they were added in.
- **Less work during playback.** The hidden library, queue and result buttons are no longer rebuilt every 2 s while a video
  plays (main-thread work competing with the JS decoder); they refresh when the player closes. *Up next* only re-renders when
  it changes.
- **Errors.** The red notice clears once the connection recovers or a search succeeds; network failures read “The iPhone did
  not respond…”; removal confirmations use the toast; feed errors stay inside the feed panel. User actions queue a follow-up
  refresh instead of being dropped while a poll is in flight.

## iPhone app
- **Google sign-in shows Google's reason** (`access_denied`, `invalid_client`, `invalid_grant`, sheet closed, …) on the Settings
  card, with guidance (e.g. add your account as a test user on the OAuth consent screen). Failures are logged as
  `youtube/oauthFailed` / `oauthRefreshFailed` with stage and error only (no codes or tokens). The button disables while
  signing in.
- **Background time.** The expiration handler now ends the background task synchronously (`MainActor.assumeIsolated`), so
  iOS does not terminate the app when background time runs out.

## Cloudflare Worker
- The laptop fallback joined paths with `new URL(path, target)`, so a `//other.host/…` request was proxied to any host. The
  upstream URL is now built from the target origin and checked.
