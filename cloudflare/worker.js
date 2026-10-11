import { PhoneTunnel } from "./phone-relay.js";
export { PhoneTunnel };

// Permanent front door for the Tesla Video Pilot host.

const OFFLINE = `<!doctype html><meta name=viewport content="width=device-width">
<body style="font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1>Video Pilot is offline</h1>
<p>Check that the Raspberry Pi is powered on and connected to the internet.</p></div>`;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/__iphone/")) {
      if (!["/__iphone/connect", "/__iphone/status"].includes(url.pathname)) return new Response("Not found", { status: 404 });
      if (!env.PHONE_TUNNEL) return Response.json({ error: "Deploy the iPhone Worker update" }, { status: 503 });
      const relay = env.PHONE_TUNNEL.get(env.PHONE_TUNNEL.idFromName("mk8-iphone"));
      return relay.fetch(req);
    }

    // The Raspberry Pi uses the existing authenticated host tunnel. Internal
    // endpoint names remain stable so an iPhone build can still be used during
    // migration without changing the public URL.
    if (env.PHONE_TUNNEL) {
      const relay = env.PHONE_TUNNEL.get(env.PHONE_TUNNEL.idFromName("mk8-iphone"));
      const response = await relay.fetch(req.clone());
      if (response.headers.get("x-mk8-phone") !== "offline") return response;
    }
    return new Response(OFFLINE, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  },
};
