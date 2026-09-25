# Deploying Procom Solutions (procomsolutions.co.za)

Procom runs **alongside** lapanza3d.co.za, barkie.co.za and the other sites on
the shared AlmaLinux 10 VPS (`41.222.36.147`). The server is already
bootstrapped (Node 22, nginx, certbot, firewall, `deploy` user with
passwordless sudo, SSH key `~/.ssh/lapanza_vps_deploy` on Johan's PC).

| | Lapanza 3D | Procom Solutions |
|---|---|---|
| App directory | `/opt/lapanza/app` | `/opt/procomsolutions/app` |
| systemd service | `lapanza-admin` | `procomsolutions-admin` |
| Node port (localhost only) | 8787 | **8788** |
| nginx vhost | `conf.d/lapanza.conf` | `conf.d/procomsolutions.conf` |
| Database | `data/lapanza.db` | `data/procom.db` |
| Photos | `public/uploads/` | `data/uploads/` |

The sites share nothing at runtime. Deploying or restarting Procom never
touches Lapanza or the others.

- **Code:** https://github.com/jbarkhuizen/procom-solution (public; no secrets
  are in git; they live only in `.env` on the server)
- **DNS + HTTPS:** procomsolutions.co.za already points at the VPS, and its
  Let's Encrypt certificate auto-renews.
- **Contact:** procompretoria@gmail.com (editable in Admin → Site settings)

## Updating the live site (every time)

From Johan's PC, after pushing to GitHub:

```bash
ssh -i ~/.ssh/lapanza_vps_deploy deploy@41.222.36.147 "bash /opt/procomsolutions/app/deploy/deploy-app.sh"
```

This pulls `main`, installs dependencies, builds, runs the tests and restarts
the service. The database, photos and `.env` are never touched.

## Secrets (`.env` on the server): Johan does this

```bash
ssh -i ~/.ssh/lapanza_vps_deploy deploy@41.222.36.147
nano /opt/procomsolutions/app/.env
sudo systemctl restart procomsolutions-admin
```

- **Payfast:** `PAYFAST_MERCHANT_ID/KEY/PASSPHRASE` (the same Payfast account
  Lapanza uses works; payments show as "Procom Solutions order PC…"). Test
  with `PAYFAST_MODE=sandbox` and your own sandbox credentials first, then
  set `PAYFAST_MODE=live`.
- **Email:** `GMAIL_USER=procompretoria@gmail.com` and a Gmail **App
  Password** (Google Account → Security → 2-Step Verification → App
  passwords). Without it the site works, but no order/enquiry emails go out.

Never paste these values into chat or any AI tool.

## First admin account

Open https://www.procomsolutions.co.za/admin/. A fresh database shows
**Create your admin account**. There is no default password.

## Loading products

1. **Admin → Warehouse feed** → upload each SMD `.xlsx` pricelist.
2. Filter, tick items, choose a category, **List**. Price =
   `cost excl VAT × 1.15 × (1 + markup)`, rounded up to the next rand.
3. Monthly: upload the new lists. Costs update, auto-priced products
   reprice, and discontinued items go out of stock.

## Backups

- Automatic daily SQLite snapshot to `data/backups/` (30 kept) and **Admin →
  Backups → Back up now**.
- Off-server (optional, reuses Lapanza's rclone Google Drive remote):

  ```bash
  crontab -e
  30 2 * * * rclone sync /opt/procomsolutions/app/data/backups gdrive:procom-backups && rclone copy /opt/procomsolutions/app/data/uploads gdrive:procom-uploads
  ```

## Restore

```bash
sudo systemctl stop procomsolutions-admin
cd /opt/procomsolutions/app
cp data/procom.db data/procom.db.before-restore
cp data/backups/<file>.db data/procom.db
rm -f data/procom.db-wal data/procom.db-shm
sudo systemctl start procomsolutions-admin
```

## Troubleshooting

- Service status and logs: `sudo systemctl status procomsolutions-admin`,
  `sudo journalctl -u procomsolutions-admin -n 100`
- API health on the server: `curl -s http://127.0.0.1:8788/api/health`
- nginx: always `sudo nginx -t` before `sudo systemctl reload nginx`. A
  broken config would take down **every** site on the box.
- The old placeholder page was kept at `/opt/procomsolutions/app.pre-store-*`
  and the old nginx file at `/etc/nginx/procomsolutions.conf.pre-store`.
