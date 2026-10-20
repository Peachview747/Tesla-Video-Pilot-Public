#!/bin/bash
# Installs the pieces for the public HTTPS front under /opt/pi-public:
# Caddy (official release, checksum checked), acme.sh, the config templates
# and the user timers. Safe to run again. Nothing starts serving until
# setup-public.sh has run.
set -euo pipefail
DIR=/opt/pi-public
HERE=$(cd "$(dirname "$0")" && pwd)
sudo mkdir -p $DIR/bin $DIR/certs $DIR/caddy-data $DIR/caddy-config
sudo chown -R "$USER": $DIR
sudo chown nobody:nogroup $DIR/caddy-data $DIR/caddy-config
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
VERSION=$(curl -sSf https://api.github.com/repos/caddyserver/caddy/releases/latest | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"].lstrip("v"))')
BASE=https://github.com/caddyserver/caddy/releases/download/v$VERSION
curl -sSfLO "$BASE/caddy_${VERSION}_linux_arm64.tar.gz"
curl -sSfLO "$BASE/caddy_${VERSION}_checksums.txt"
grep " caddy_${VERSION}_linux_arm64.tar.gz\$" "caddy_${VERSION}_checksums.txt" | sha512sum -c -
tar xzf "caddy_${VERSION}_linux_arm64.tar.gz" caddy
install -m 755 caddy $DIR/bin/caddy
if [ ! -x $DIR/acme/acme.sh ]; then
  git clone --depth 1 https://github.com/acmesh-official/acme.sh.git acme-src
  (cd acme-src && ./acme.sh --install --home $DIR/acme --nocron --noprofile)
fi
cd "$HERE"
install -m 755 ddns.sh after-cert.sh setup-public.sh $DIR/
install -m 644 Caddyfile.template $DIR/
mkdir -p ~/.config/systemd/user
install -m 644 pi-public-*.service pi-public-*.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pi-public-ddns.timer pi-public-renew.timer
$DIR/bin/caddy version
