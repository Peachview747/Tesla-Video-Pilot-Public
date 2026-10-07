import { PhoneTunnel } from "./phone-relay.js";
export { PhoneTunnel };

// Permanent front door for the Tesla Video Player.
// The laptop's tunnel address changes every start; tesla.sh posts the new one
// to /__set, and this Worker proxies everything through to it. Because the
// browser only ever sees this address, the login cookie survives restarts.

const OFFLINE = `<!doctype html><meta name=viewport content="width=device-width">
<body style="font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1>MK8 host is offline</h1>
<p>Open MK8 on your iPhone and start hosting, or start your laptop host.</p></div>`;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/__iphone/")) {
      if (!["/__iphone/connect", "/__iphone/status"].includes(url.pathname)) return new Response("Not found", { status: 404 });
      if (!env.PHONE_TUNNEL) return Response.json({ error: "Deploy the iPhone Worker update" }, { status: 503 });
      const relay = env.PHONE_TUNNEL.get(env.PHONE_TUNNEL.idFromName("mk8-iphone"));
      return relay.fetch(req);
    }

    if (url.pathname === "/__set" && req.method === "POST") {
      if (!env.SECRET || req.headers.get("x-secret") !== env.SECRET) return new Response("no", { status: 403 });
      const target = (await req.text()).trim();
      if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(target) && target !== "")
        return new Response("bad target", { status: 400 });
      if (target === "") await env.KV.delete("target");
      else await env.KV.put("target", target);
      return new Response("ok");
    }

    // A connected iPhone owns the front door. Its errors must not accidentally
    // route browser pairing or media mutations to the laptop.
    if (env.PHONE_TUNNEL) {
      const relay = env.PHONE_TUNNEL.get(env.PHONE_TUNNEL.idFromName("mk8-iphone"));
      const response = await relay.fetch(req.clone());
      if (response.headers.get("x-mk8-phone") !== "offline") return response;
    }
    const target = await env.KV.get("target");
    if (!target) return new Response(OFFLINE, { status: 503, headers: { "content-type": "text/html" } });

    const upstream = new URL(url.pathname + url.search, target);
    const headers = new Headers(req.headers);
    headers.delete("origin");
    headers.delete("host");
    try {
      return await fetch(upstream, {
        method: req.method,
        headers,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
        redirect: "manual",
      });
    } catch (e) {
      return new Response(OFFLINE, { status: 502, headers: { "content-type": "text/html" } });
    }
  },
};
