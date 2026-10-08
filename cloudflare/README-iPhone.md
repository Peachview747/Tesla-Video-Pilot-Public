# iPhone connection for the existing MK8 URL

This update provides **iPhone → outbound TLS WebSocket → Cloudflare → Tesla browser**. The phone runs the media stack and keeps videos locally. Cloudflare relays requests and streams binary response chunks with browser-driven backpressure. This transport runs in the native app; it does not execute desktop `cloudflared`.

## One-time Windows setup

1. Install Node.js 22 or newer if the original MK8 setup did not already install it.
2. Extract `MK8iPhone-v0.1.4-Cloudflare-Setup.zip` into its own folder.
3. Double-click **Setup-iPhone-Tunnel.cmd**.
4. When asked, paste the path of your **original MK8 folder containing `.env`**, not the extracted setup folder. The setup reads `TV_SECRET` privately from that file.
5. Sign into the Cloudflare account that owns `tv.jcruzhoovertesla.workers.dev` if a browser opens. The setup deploys an update to that same `tv` Worker, adds a SQLite Durable Object, and preserves the existing KV/laptop route. Existing Cloudflare quotas/billing apply.
6. Wait for **KEY TEST PASSED**. The setup first tests the existing local key against the deployed Worker. If it does not match, the setup synchronizes Cloudflare's `SECRET` to the existing local `TV_SECRET` and tests again. Generating a new key is not required. The key is passed on stdin, never printed, committed, or included in downloads.

The setup needs permission to deploy Workers and create the Durable Object in the configured account. It reuses the original `.env` API token if one exists, or Wrangler browser login. The account and KV namespace in `wrangler.json` belong to the existing TV URL; do not change them for this setup.

Command-line alternative from this folder: `npm ci`, then `node setup-iphone.mjs "C:\path\to\original\MK8"`.

## Connect the iPhone

1. Sideload `MK8iPhone-v0.1.4-unsigned.ipa` using the same Apple ID as the existing app.
2. In the app, open **Settings → Cloudflare tunnel** and paste the **value** of `TV_SECRET` from the original `.env`. Leave out `TV_SECRET=` and any surrounding quotes. Tap **Save tunnel key**. The key is stored in Keychain.
3. Open **Host → Start hosting**. Wait for **Cloudflare tunnel: Connected**. A real Worker hello is required for this state; having the URL or an internet connection does not count.
4. In the Tesla browser, open **https://tv.jcruzhoovertesla.workers.dev** after Video Pilot has authorized hosting with Face ID. There is no browser PIN; anyone who obtains the address can use the host while the iPhone is running, so keep the address private.
5. Import a short video, wait until ready, and test playback, pause/resume, and stopping the player. Test Wi-Fi/cellular switching and reconnecting.

The phone and Tesla need internet access; they do not need to share a local network. Keep the iPhone app open for continuous playback. iOS only grants finite background time to the tunnel and server. Background downloads use a separate system URLSession and can continue after switching apps; the live tunnel does not get indefinite locked-screen runtime.

## Routing and testing

When a phone is connected, it owns the public route. Face ID protects host activation in the app, but the external Origin/Host is public while hosting is active; there is no browser pairing cookie or login gate. Phone errors cannot accidentally send browser mutations to the laptop. Once the phone disconnects, new requests use the existing laptop target if present. Connecting another phone using the same key replaces the first connection.

`GET /__iphone/status` reports protocol/configuration and connection state. Sending `x-secret` additionally checks the key (401 means rejected). `GET /__iphone/connect` is the authenticated WebSocket endpoint. Only browser-driven pulls authorize each video chunk; frames carry a 16-byte request UUID plus at most 128 KiB of payload. Concurrent requests are limited to eight. Browser cancellation closes the phone's file stream.

Run `npm test` for integration tests against Cloudflare's local workerd runtime: authentication, laptop fallback, exact binary playback bytes/backpressure, cookies/origin, multiplexing/cancellation, disconnects, and request bounds. Live account deployment and physical iPhone/Tesla tests are separate checks.
