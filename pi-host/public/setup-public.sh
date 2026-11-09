#!/bin/bash
# The last setup step, after you have made a DuckDNS name and saved its token:
#   setup-public.sh <your-duckdns-name>      (the part before .duckdns.org)
# It picks a random secret host name under yours, points DuckDNS at this
# home, gets a wildcard HTTPS certificate (DNS challenge: no router changes
# needed yet), writes the Caddy config and starts it.
set -euo pipefail
DIR=/opt/pi-public
NAME=${1:?Usage: setup-public.sh <your-duckdns-name>}
[[ $NAME =~ ^[a-z0-9-]{3,40}$ ]] || { echo "The name should be lowercase letters, digits and dashes."; exit 1; }
[ -f $DIR/duckdns.env ] || { echo "First save your DuckDNS token in $DIR/duckdns.env (see README.md)."; exit 1; }
[ -f $DIR/label ] || head -c 9 /dev/urandom | base32 | tr -d '=' | tr 'A-Z' 'a-z' | head -c 12 > $DIR/label
HOST="$(cat $DIR/label).$NAME.duckdns.org"
printf 'PUBLIC_HOST=%s\nDUCKDNS_NAME=%s\n' "$HOST" "$NAME" > $DIR/public.env
$DIR/ddns.sh
set -a; . $DIR/duckdns.env; set +a
export DuckDNS_Token="$DUCKDNS_TOKEN"
ACME="$DIR/acme/acme.sh --home $DIR/acme"
# One wildcard certificate: the secret name never appears in public certificate logs.
$ACME --server letsencrypt --issue --dns dns_duckdns -d "*.$NAME.duckdns.org" --dnssleep 40 || [ $? = 2 ]
$ACME --install-cert -d "*.$NAME.duckdns.org" --key-file $DIR/certs/privkey.pem --fullchain-file $DIR/certs/fullchain.pem --reloadcmd "$DIR/after-cert.sh"
sed -e "s#__HOST__#$HOST#" -e "s#__CERT__#$DIR/certs/fullchain.pem#" -e "s#__KEY__#$DIR/certs/privkey.pem#" $DIR/Caddyfile.template > $DIR/Caddyfile
$DIR/bin/caddy validate --config $DIR/Caddyfile --adapter caddyfile
systemctl --user enable --now pi-public-caddy.service
echo
echo "Ready. Your address (keep it private): https://$HOST"
echo "Last step: in your router, forward external port 443 to this Pi's port 8443."
