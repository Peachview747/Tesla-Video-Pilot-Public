# Tesla Video Pilot · Version 0.1.32 · Build 44

Build 44 changes Video Pilot's production relay and Tesla browser address to:

`https://tv.jch76.workers.dev`

The iPhone app, relay tests, setup scripts, release instructions, distribution metadata, and legacy laptop publishing helpers now use the same address. The AI Room address is intentionally not used by Video Pilot.

The new Worker reports protocol `mk8-relay-v1`, is configured, and returns the expected disconnected status when the iPhone host is offline. Its root currently falls through to the configured laptop origin when no iPhone is connected; that origin returned a Cloudflare 530 during validation. This does not indicate failure of the iPhone relay endpoint, but visiting the root before the iPhone connects may show the fallback error page.

Build 43's experimental silent-audio keepalive and PiP test remain unchanged. No Worker code deployment is part of this source update.
