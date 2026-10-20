# Public HTTPS front (optional)

Serves the portal straight from the Pi on your own web address instead of
through Cloudflare's relay: about 200 ms less per request.

    internet -> router :443 -> Pi :8443 (Caddy, runs as "nobody")
             -> 127.0.0.1:5101 (Video Pilot's public port, always PIN-locked)

Video Pilot treats everything on that port as outside traffic, whatever
headers it carries, and counts wrong PINs per visitor (5 tries, then a
growing lockout) as well as across everyone (a backstop).

1. `./install.sh` (Caddy, acme.sh, templates, timers).
2. Make a free name at duckdns.org. Save its token without echoing it:
   `read -rsp "DuckDNS token: " T; echo; printf 'DUCKDNS_TOKEN=%s\n' "$T" > /opt/pi-public/duckdns.env; chmod 600 /opt/pi-public/duckdns.env; unset T`
3. `/opt/pi-public/setup-public.sh <your-duckdns-name>` prints your private address.
4. Router: forward external port 443 to the Pi's port 8443. Never forward 22.

The certificate is a wildcard (`*.yourname.duckdns.org`) and the portal lives
on a random name under it, so the portal's name does not appear in public
certificate logs. Anything that reaches Caddy with a different name gets the
connection dropped.
