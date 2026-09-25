# Deploying Procom Solutions to the existing Lapanza VPS

Procom runs **alongside** lapanza3d.co.za on the same AlmaLinux 10 VPS. The
VPS is already bootstrapped (Node 22, nginx, certbot, firewall, `deploy`
user, SSH key `~/.ssh/lapanza_vps_deploy`), so there is no bootstrap step.

| | Lapanza 3D | Procom Solutions |
|---|---|---|
| App directory | `/opt/lapanza/app` | `/opt/procom/app` |
| systemd service | `lapanza-admin` | `procom-admin` |
| Node port (localhost only) | 8787 | **8788** |
| nginx vhost | `/etc/nginx/conf.d/lapanza.conf` | `/etc/nginx/conf.d/procom.conf` |
| Database | `data/lapanza.db` | `data/procom.db` |
| Photos | `public/uploads/` | `data/uploads/` |

The two sites share nothing at runtime: separate processes, databases, ports
and nginx server blocks. Deploying or restarting one never touches the other.

## 1. Put the code on GitHub

Repo: `jbarkhuizen/procom-solution` (public -- no secrets are in git),
then from this machine:

```bash
git remote add origin https://github.com/jbarkhuizen/procom-solution.git
git push -u origin main
```

If you use a different repo name, set `PROCOM_REPO_URL` when running the
deploy script (step 3).

## 2. Point DNS at the VPS

Wherever procompretoria.co.za is registered, set:

- `A` record `@` → `<VPS_IP>`
- `A` record `www` → `<VPS_IP>`

(Same IP as lapanza3d.co.za.) Until the procom vhost is installed, nginx
would answer procompretoria.co.za with its *default* server (Lapanza), so
do step 3 soon after DNS changes, or before.

## 3. First deploy

```bash
ssh -i ~/.ssh/lapanza_vps_deploy deploy@<VPS_IP>
sudo mkdir -p /opt/procom && sudo chown deploy:deploy /opt/procom
git clone https://github.com/jbarkhuizen/procom-solution.git /opt/procom/app
bash /opt/procom/app/deploy/deploy-app.sh
```

This installs dependencies, builds `dist/`, runs the test suite, creates
`.env` from the template, installs + starts `procom-admin`, and adds the
nginx vhost.

A private repo needs credentials on the VPS for `git clone` (a GitHub
fine-grained token with read access to that one repo, or a deploy key).

## 4. Secrets

```bash
nano /opt/procom/app/.env
sudo systemctl restart procom-admin
```

- **Payfast:** the same merchant account Lapanza uses works fine; payments
  will show `Procom Solutions order PC…` as the item name. Start with
  `PAYFAST_MODE=sandbox` and your *own* sandbox credentials, place one test
  order, then fill the live values and set `PAYFAST_MODE=live`.
- **Gmail:** same App Password approach as Lapanza (can be the same Gmail
  account). Without it, the site works but no order/enquiry emails go out.

Never paste these values into chat or any AI tool.

## 5. HTTPS

Once `procompretoria.co.za` resolves to the VPS:

```bash
sudo certbot --nginx -d procompretoria.co.za -d www.procompretoria.co.za
```

Choose "redirect HTTP → HTTPS". Renewal is automatic (the certbot timer
already installed for Lapanza covers every certificate on the box).

## 6. First admin account

Open `https://www.procompretoria.co.za/admin/`. A fresh database shows a
**Create your admin account** screen. There is no default password.

## 7. Load the catalogue

1. **Admin → Warehouse feed** → upload each SMD `.xlsx` pricelist
   (Cash wholesale, Home and Beyond, Infant Essential).
2. Filter, tick the items you want to sell, choose a storefront category,
   and click **List**. Prices are calculated automatically:
   `cost excl VAT × 1.15 × (1 + markup)`, rounded up to the next rand.
3. Each month, upload the new pricelists. Costs update, auto-priced
   products are repriced, and listed items missing from the new list are
   marked out of stock.

## 8. Smoke test

- `https://www.procompretoria.co.za/`: home page shows categories and products
- `curl -s http://127.0.0.1:8788/api/health` on the VPS returns `{"ok":true,...}`
- Admin login works; import a pricelist; list an item; it appears on the shop
- Sandbox order end to end; the order shows as **Paid** in admin
- `https://www.lapanza3d.co.za/` still works (sanity check for the neighbour)

## Future deploys

```bash
ssh -i ~/.ssh/lapanza_vps_deploy deploy@<VPS_IP>
bash /opt/procom/app/deploy/deploy-app.sh
```

## Backups

- Automatic: daily SQLite snapshot to `data/backups/` (30 kept), plus one on
  startup if the last is over a day old. **Admin → Backups** also has a
  "Back up now" button.
- Off-server: reuse Lapanza's rclone Google Drive remote. Add a nightly cron
  for the deploy user:

  ```bash
  crontab -e
  # 02:30 every night
  30 2 * * * rclone sync /opt/procom/app/data/backups gdrive:procom-backups && rclone copy /opt/procom/app/data/uploads gdrive:procom-uploads
  ```

  `copy` (not `sync`) for uploads, for the same reason as Lapanza: an
  accidental local delete must not propagate offsite.

## Restore

```bash
sudo systemctl stop procom-admin
cd /opt/procom/app
cp data/procom.db data/procom.db.before-restore
cp data/backups/<file>.db data/procom.db
rm -f data/procom.db-wal data/procom.db-shm
sudo systemctl start procom-admin
```
