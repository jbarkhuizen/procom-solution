#!/usr/bin/env bash
# Run as the "deploy" user on the (already bootstrapped) Lapanza VPS.
# First run clones the repo; later runs pull, rebuild and restart.
#
#   ssh -i ~/.ssh/lapanza_vps_deploy deploy@<VPS_IP>
#   bash /opt/procomsolutions/app/deploy/deploy-app.sh

set -euo pipefail

REPO_URL="${PROCOM_REPO_URL:-https://github.com/jbarkhuizen/procom-solution.git}"
APP_DIR="/opt/procomsolutions/app"

if [ ! -d "$APP_DIR/.git" ]; then
  sudo mkdir -p /opt/procomsolutions && sudo chown deploy:deploy /opt/procomsolutions
  if [ -e "$APP_DIR" ]; then
    # e.g. the old placeholder page -- keep it, never delete.
    BACKUP="$APP_DIR.pre-store-$(date +%Y%m%d%H%M%S)"
    echo "==> Moving existing non-git $APP_DIR aside to $BACKUP"
    mv "$APP_DIR" "$BACKUP"
  fi
  echo "==> Cloning repo (first run)"
  git clone "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"

echo "==> Pulling latest main"
git fetch origin
git checkout main
git pull --ff-only origin main

echo "==> Installing dependencies"
npm ci

# Unlike lapanza3d there is no publish/generate step: the storefront reads
# the catalog live from the API, so a build never bakes in stale data.
echo "==> Building static site"
npm run build

echo "==> Running tests"
npm test

mkdir -p data/uploads data/backups
if [ ! -f .env ]; then
  echo "==> No .env found -- copying template. EDIT THIS BEFORE TAKING REAL ORDERS:"
  cp deploy/.env.production.template .env
  echo "    nano $APP_DIR/.env"
fi

echo "==> Installing/refreshing systemd service"
sudo cp deploy/procomsolutions-admin.service /etc/systemd/system/procomsolutions-admin.service
sudo systemctl daemon-reload
sudo systemctl enable procomsolutions-admin
sudo systemctl restart procomsolutions-admin

if [ ! -f /etc/nginx/conf.d/procomsolutions.conf ]; then
  echo "==> Installing nginx vhost (first run)"
  sudo cp deploy/nginx-procomsolutions.conf /etc/nginx/conf.d/procomsolutions.conf
  sudo nginx -t
  sudo systemctl reload nginx
else
  # certbot appends HTTPS blocks to the live file -- never overwrite it.
  echo "==> nginx vhost exists -- leaving /etc/nginx/conf.d/procomsolutions.conf as-is (certbot manages it)"
  sudo nginx -t
  sudo systemctl reload nginx
fi

sleep 2
echo ""
echo "==================================================================="
curl -fsS http://127.0.0.1:8788/api/health && echo "  <- API healthy"
echo "Status: sudo systemctl status procomsolutions-admin"
echo "Logs:   sudo journalctl -u procomsolutions-admin -n 100"
echo "==================================================================="
