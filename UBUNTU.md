# Ubuntu / Surface setup (trunk or desk)

This tree ships with a **Docker Compose** launcher (`tesla.sh`). No Colima, no Mac-only tools.

## 1. Install Ubuntu on the Surface

- Dual-boot or replace Windows — your choice.
- After install, update and install Docker:

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-v2 curl
sudo usermod -aG docker "$USER"
newgrp docker   # or log out and back in
sudo systemctl enable --now docker
```

## 2. Copy the project + `.env`

Bring over this folder and your existing `.env` (TV_URL, TV_SECRET, TELEGRAM_BOT_TOKEN, POSTGRES_PASSWORD, WEB_PORT).

```bash
cd /path/to/TeslaVideoPlayerMk5
chmod +x tesla.sh
```

## 3. First start

```bash
./tesla.sh
```

First run **builds** the web and bot images (needs network; can take several minutes). Then it starts Postgres → web → bot → Cloudflare tunnel and prints your permanent `TV_URL`.

## 4. Everyday commands

```bash
./tesla.sh          # start everything
./tesla.sh stop     # stop containers + tunnel (data kept)
./tesla.sh status
./tesla.sh logs     # bot logs
./tesla.sh bot-off  # stop only Telegram bot
./tesla.sh doctor   # write doctor.txt
```

## 5. Trunk / laptop tips

- Disable suspend when on AC:  
  `sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target`  
  (or use GNOME power settings → when plugged in, never suspend)
- Prefer **plugged into car USB-C PD** so it doesn’t die on battery.
- Hotspot: phone or car; tunnel needs outbound HTTPS.

## 6. ARM vs x86 Surface

- Intel Surface → images build as `linux/amd64` (default).
- If you ever use ARM, Docker buildx may be needed; most Surfaces are Intel/AMD64.

## Troubleshooting

| Symptom | Check |
|--------|--------|
| `permission denied` docker | `sudo usermod -aG docker $USER` then re-login |
| web never comes up | `./tesla.sh logs` and `/tmp/tesla-up.log` |
| tunnel fails | `/tmp/tesla-tunnel.log`; try again on hotspot without work VPN |
| Worker update fails | TV_SECRET / TV_URL in `.env` |

