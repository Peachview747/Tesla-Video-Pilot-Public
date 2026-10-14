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

## Booting before the car hotspot is available

Both Pi hosts start as soon as NetworkManager starts, even without internet. They retry their cloud connections indefinitely, with a maximum 30-second retry delay. Connection checks have deadlines and unresponsive tunnel connections are terminated so hotspot outages can recover automatically.

Save your hotspot through NetworkManager under the connection name `car-hotspot`, enable autoconnect, and set `connection.autoconnect-retries` to `0` (forever). Use the exact SSID shown by the Wi-Fi scan, including its punctuation. Store the password only in NetworkManager's root-owned connection profile.

The installer also enables `pi-hotspot-watch.timer`. When Wi-Fi is disconnected, it searches for `car-hotspot` every 20 seconds after the preceding attempt finishes. It leaves an active Wi-Fi connection alone and respects a disabled Wi-Fi radio. The timer starts 10 seconds after boot. Check it with `systemctl status pi-hotspot-watch.timer`.

The player serves the repository's decoder from `app/client/public/jsmpeg.min.js`; it does not depend on an untracked copy inside `ios/Web`.

## Playback quality and hotspot data

Use the player's Quality menu to choose 360p, 540p, 720p, or 1080p. Switching resumes near the same timestamp and preserves pause, mute, and fullscreen. Lower resolutions use separately encoded lower-bitrate files and their own seek indexes, so changing quality reduces the bytes sent through the hotspot. The Pi prepares and caches smaller copies locally; the current stream continues while a missing copy is prepared.

Settings → Download quality controls the maximum resolution of future YouTube downloads. Selecting a player quality above the saved maximum queues an upgrade download and keeps the old copy playable until the new one is ready. The downloader checks the actual source resolution rather than labeling an upscaled low-resolution source as HD. Data saver defaults playback to 360p. The Default player choice otherwise uses the highest saved quality; it is not automatic bandwidth detection.

## YouTube sign-in (headless)

Sign in to youtube.com once in Firefox on the Pi (its screen or VNC). A user
timer copies that sign-in to Video Pilot every two minutes; it is used for
downloads and the Subscriptions tab and never leaves the Pi. Install it as the
desktop user, not root:

```sh
install -Dm755 pi-host/youtube-cookie-sync ~/.local/bin/youtube-cookie-sync
install -Dm644 -t ~/.config/systemd/user pi-host/youtube-cookie-sync.service pi-host/youtube-cookie-sync.timer
systemctl --user daemon-reload && systemctl --user enable --now youtube-cookie-sync.timer
```

The local API only accepts these cookies from the Pi itself; requests that
arrive through the car relay are refused.
