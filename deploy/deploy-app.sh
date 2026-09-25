#!/usr/bin/env bash
# Run as the "deploy" user on the (already bootstrapped) Lapanza VPS.
# First run clones the repo; later runs pull, rebuild and restart.
#
#   ssh -i ~/.ssh/lapanza_vps_deploy deploy@<VPS_IP>
#   bash /opt/procom/app/deploy/deploy-app.sh

set -euo pipefail

REPO_URL="${PROCOM_REPO_URL:-https://github.com/jbarkhuizen/procom-solutions.git}"
APP_DIR="/opt/procom/app"

if [ ! -d "$APP_DIR/.git" ]; then
  echo "==> Cloning repo (first run)"
  sudo mkdir -p /opt/procom && sudo chown deploy:deploy /opt/procom
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
sudo cp deploy/procom-admin.service /etc/systemd/system/procom-admin.service
sudo systemctl daemon-reload
sudo systemctl enable procom-admin
sudo systemctl restart procom-admin

if [ ! -f /etc/nginx/conf.d/procom.conf ]; then
  echo "==> Installing nginx vhost (first run)"
  sudo cp deploy/nginx-procom.conf /etc/nginx/conf.d/procom.conf
  sudo nginx -t
  sudo systemctl reload nginx
else
  # certbot appends HTTPS blocks to the live file -- never overwrite it.
  echo "==> nginx vhost exists -- leaving /etc/nginx/conf.d/procom.conf as-is (certbot manages it)"
  sudo nginx -t
  sudo systemctl reload nginx
fi

sleep 2
echo ""
echo "==================================================================="
curl -fsS http://127.0.0.1:8788/api/health && echo "  <- API healthy"
echo "Status: sudo systemctl status procom-admin"
echo "Logs:   sudo journalctl -u procom-admin -n 100"
echo "==================================================================="
