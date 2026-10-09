# Tesla Video Pilot · Version 0.1.33 · Build 45

Follow-up to Build 44 after checking the deployed Worker.

- **Root cause of the 429 burst at 04:27:54 (Build 43 log).** The deployed `tv` Worker predated
  `cloudflare/phone-relay.js`'s player-session reaping (`x-mk8-player` / `cancelClient`). Cloudflare does not
  reliably forward Tesla browser aborts, so each abandoned seek stream kept one of the Worker's 8 request
  slots until the tunnel reconnected. The phone received zero `cancel` messages in builds 38–43.
- **Why Build 44 alone could make it worse.** Build 43 restarted the tunnel on every return to the
  foreground, which accidentally released the leaked slots. Build 44 stops that restart.
- **Fix (works with old and new Workers).** The phone's 5 s heartbeat now fails any relay stream that has had
  no pull for 45 s, logged as `tunnel/peerReaped`. The `error` frame makes the Worker free the slot.
- **Long pause.** Paused players stop pulling, so Play after more than 30 s paused reopens at the same position
  instead of resuming a stream the phone may have released.

Still recommended: redeploy the Worker from `cloudflare/` (`npm ci && npx wrangler deploy`).
