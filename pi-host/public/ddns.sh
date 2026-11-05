#!/bin/bash
# Tells DuckDNS this home's current address. The token is read from a file
# only the owner can read and is never printed.
set -euo pipefail
. /opt/pi-public/public.env
. /opt/pi-public/duckdns.env
reply=$(curl -fsS -m 20 --get --data-urlencode "domains=$DUCKDNS_NAME" --data-urlencode "token=$DUCKDNS_TOKEN" --data-urlencode "ip=" https://www.duckdns.org/update) \
  || { echo "DuckDNS update failed"; exit 1; }
echo "DuckDNS: $reply"
[ "$reply" = OK ]
