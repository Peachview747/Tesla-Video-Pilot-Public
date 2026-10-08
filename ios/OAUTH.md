# Video Pilot sign-in boundary

Video Pilot currently has two separate authentication layers:

- Face ID/device authentication authorizes the iPhone to start its local host.
- `TV_SECRET` authenticates the iPhone-to-Cloudflare relay. The Tesla browser
  does not receive that secret and does not have a browser PIN.

That is intentionally different from signing into a website. A generic
"sign in to any site" button would require storing arbitrary cookies and would
turn the Tesla browser into an unsafe credential proxy. Each provider needs its
own OAuth integration.

## YouTube OAuth plan

YouTube account features are feasible, but they need a Google Cloud project
and a one-time configuration before code can be enabled:

1. Create an iOS OAuth client in Google Cloud and configure the consent screen.
2. Request only the scopes we need, initially `youtube.readonly` for the
   account's subscriptions and playlists.
3. Start the flow from the iPhone with `ASWebAuthenticationSession` and PKCE.
   Do not use a `WKWebView` and do not put a client secret in the IPA or repo.
4. Store the refresh token in the iPhone Keychain. The Tesla browser only asks
   the iPhone for already-filtered search/feed results over the authenticated
   local relay; it never sees Google tokens.
5. Add a short-lived `/api/youtube/account` response and a Settings action to
   revoke/clear the token. Public builds contain only the client ID and
   redirect scheme, never a secret or refresh token.

The existing API-key search remains the safe fallback: it can search public
videos and trending results without account access. The YouTube Data API does
not provide a complete personalized Home feed, so “what is on my account”
would be implemented from subscriptions/playlists rather than scraping the
YouTube website.

## What is still required

OAuth should be enabled only after the playback fixes are verified and the
Google Cloud values are supplied. The implementation will need an iOS client
ID, the chosen redirect scheme, the exact scopes, and a decision about whether
account results are allowed through the public Cloudflare URL. No credentials
belong in source control, generated web assets, IPAs, or GitHub Actions logs.
