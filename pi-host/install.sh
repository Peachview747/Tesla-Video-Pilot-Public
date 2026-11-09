#!/bin/sh
set -eu
if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo: sudo ./pi-host/install.sh" >&2; exit 1; fi
arch="$(dpkg --print-architecture)"
if [ "$arch" != "arm64" ]; then echo "Video Pilot requires 64-bit Raspberry Pi OS (arm64); found $arch." >&2; exit 1; fi
apt-get update
apt-get install -y ca-certificates curl ffmpeg python3-venv rsync
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'Number(process.versions.node.split(`.`)[0])' 2>/dev/null || echo 0)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sh -
  apt-get install -y nodejs
fi
id video-pilot >/dev/null 2>&1 || useradd --system --home /var/lib/video-pilot --shell /usr/sbin/nologin video-pilot
install -d -o video-pilot -g video-pilot -m 0700 /var/lib/video-pilot
install -d -m 0755 /opt/video-pilot
source_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
rsync -a --delete --exclude .git --exclude node_modules --exclude .venv "$source_root/" /opt/video-pilot/
python3 -m venv /opt/video-pilot/pi-host/.venv
/opt/video-pilot/pi-host/.venv/bin/pip install --upgrade pip yt-dlp yt-dlp-ejs
cd /opt/video-pilot/pi-host
npm ci --omit=dev --no-audit --no-fund
chown -R root:root /opt/video-pilot
install -m 0755 video-pilot-configure /usr/local/sbin/video-pilot-configure
install -m 0644 video-pilot.service /etc/systemd/system/video-pilot.service
install -m 0755 pi-hotspot-watch /usr/local/sbin/pi-hotspot-watch
install -m 0644 pi-hotspot-watch.service pi-hotspot-watch.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable video-pilot.service
systemctl enable --now pi-hotspot-watch.timer
if [ ! -f /etc/video-pilot.env ]; then
  echo "Installed. Finish once with: sudo video-pilot-configure"
else
  systemctl restart video-pilot.service
fi
