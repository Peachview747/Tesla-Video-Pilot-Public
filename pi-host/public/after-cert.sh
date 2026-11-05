#!/bin/bash
# Run by acme.sh after it installs a new certificate: let Caddy (which runs
# as "nobody") read it, then reload Caddy if it is running.
set -e
sudo -n chgrp nogroup /opt/pi-public/certs/privkey.pem /opt/pi-public/certs/fullchain.pem
chmod 640 /opt/pi-public/certs/privkey.pem
chmod 644 /opt/pi-public/certs/fullchain.pem
systemctl --user try-restart pi-public-caddy.service || true
