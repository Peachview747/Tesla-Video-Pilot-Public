# Video Pilot on Raspberry Pi 5

The Raspberry Pi replaces the iPhone as Video Pilot's always-on media host. The Tesla browser remains the playback screen at <https://tv.jch76.workers.dev>.

## Install on Raspberry Pi OS 64-bit

```bash
git clone https://github.com/Peachview747/Tesla-Video-Pilot-Public.git
cd Tesla-Video-Pilot-Public
git switch master-integration
sudo ./pi-host/install.sh
sudo video-pilot-configure
```

Enter the same tunnel key already configured as the Cloudflare Worker `SECRET`. The key is written only to `/etc/video-pilot.env` with root-only permissions. The service stores its library in `/var/lib/video-pilot`, starts at boot, reconnects after network outages, downloads with `yt-dlp`, and prepares MPEG-TS video with FFmpeg for the existing JSMpeg Tesla player.

Useful checks:

```bash
systemctl status video-pilot
journalctl -u video-pilot -f
curl http://127.0.0.1:5001/api/status
```

Open `https://tv.jch76.workers.dev` in the Tesla browser. Paste a YouTube link, wait for the library item to show Ready, and press Play.
