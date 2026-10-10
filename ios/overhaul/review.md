# review progress log

- [x] Relay: API requests (non-/api/stream/) get a 32 s first-byte timeout instead of 15 s; app.js waits 30 s for /api/foryou and /api/channel, which the 15 s relay cut-off made fail cold. Files: cloudflare/phone-relay.js
