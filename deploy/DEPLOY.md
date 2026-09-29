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

**Automatic:** every merge/push to `main` deploys itself through GitHub
Actions (`.github/workflows/deploy.yml`): the tests run on GitHub, then it
logs in once and runs `deploy-app.sh`, then checks
`https://www.procomsolutions.co.za/api/health` and that lapanza3d.co.za still
answers. Watch it under the repo's **Actions** tab; a red run means the live
site was *not* updated (or a site check failed after it was). Needs the
one-time setup below; until then the deploy step is skipped.

**Manual** (still works; from Johan's PC, after pushing to GitHub):

```bash
ssh -i ~/.ssh/lapanza_vps_deploy deploy@41.222.36.147 "bash /opt/procomsolutions/app/deploy/deploy-app.sh"
```

This pulls `main`, installs dependencies, builds, runs the tests and restarts
the service. The database, photos and `.env` are never touched. New database
columns are added automatically on restart (`COLUMN_MIGRATIONS` in `server/db.js`).

**Log in as few times as possible.** The server runs fail2ban: many SSH logins
within a few minutes bans your IP for about 30 minutes (websites keep working,
only SSH is refused). Chain commands into one `ssh ... '...'` session.

## Automatic deploys: one-time setup (Johan)

A key used **only** by GitHub Actions. On the server it is pinned to the
deploy script, so even if it leaked it could only redeploy `main` -- no shell.

1. **On your PC (PowerShell)** -- make the key; press Enter twice when asked
   for a passphrase (Actions can't type one):

   ```powershell
   ssh-keygen -t ed25519 -f "$HOME\.ssh\procom_gh_deploy" -C "github-actions-procom"
   Get-Content "$HOME\.ssh\procom_gh_deploy.pub"
   ssh-keyscan -t ed25519 41.222.36.147
   ```

   Keep the two output lines (the `ssh-ed25519 AAAA… github-actions-procom`
   public key, and the `41.222.36.147 ssh-ed25519 AAAA…` host line).

2. **On the server** (`deploy@Lapanza` prompt) -- allow the key, locked to
   the deploy script. Paste the public key line where shown, inside the
   single quotes:

   ```bash
   echo 'command="bash /opt/procomsolutions/app/deploy/deploy-app.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty PASTE-PUBLIC-KEY-LINE-HERE' >> ~/.ssh/authorized_keys
   ```

3. **On GitHub** -- repo **Settings → Secrets and variables → Actions → New
   repository secret**, twice:
   - `DEPLOY_SSH_KEY`: the whole private key file. Copy it with
     `Get-Content "$HOME\.ssh\procom_gh_deploy" -Raw | Set-Clipboard`
     and paste (including the BEGIN/END lines).
   - `DEPLOY_KNOWN_HOSTS`: the `41.222.36.147 ssh-ed25519 …` host line.

4. **Test** -- repo **Actions → Deploy → Run workflow**. Green = deployed.
   Then delete the private key from your PC (GitHub keeps its own copy):
   `Remove-Item "$HOME\.ssh\procom_gh_deploy"`.

To revoke: delete that line from `~/.ssh/authorized_keys` on the server and
the two secrets on GitHub. Never paste the private key into chat or a file in
the repo -- the repo and its Actions logs are public.

## Bulk data changes on the live site

For one-off catalogue operations (listing a whole supplier file into
categories, moving products between categories) the pattern used so far is:

1. Write a small Node script that imports the app's own modules
   (`saveCategory`, `listFeedItems`, `bulkUpdateProducts`) — not raw SQL —
   prints a summary, and **aborts without changing anything** if an item
   doesn't map.
2. `scp` it to `/tmp`, copy it into `/opt/procomsolutions/app` (it needs
   `node_modules`), run it, delete it — all in one SSH session.
3. Verify via the public API, e.g.
   `curl https://www.procomsolutions.co.za/api/categories`.

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
   **SMD Infant Essential / Cash Wholesale:** after importing the file,
   click **Auto-list SMD Infant Essential…** or **Auto-list SMD Cash
   Wholesale…** (under Recent imports). A preview shows how many items go
   into each category, which categories will be created, and what is skipped
   and why. Click **List** to create the categories and list everything at
   the default markup. Safe to repeat each month; it only lists new items and
   never moves products you categorised yourself.

   The Cash Wholesale list can take over a minute on the live database --
   longer than nginx lets a browser request run. If the button times out,
   run it on the server instead (works from PowerShell as-is):

   ```bash
   ssh -i ~/.ssh/lapanza_vps_deploy deploy@41.222.36.147 "cd /opt/procomsolutions/app && node server/smd-autolist-cli.js"
   ssh -i ~/.ssh/lapanza_vps_deploy deploy@41.222.36.147 "cd /opt/procomsolutions/app && node server/smd-autolist-cli.js --apply"
   ```

   The first is a dry run (nothing changes); `--apply` saves a database
   backup to `data/backups/pre-autolist-*.db`, then lists.

   `--tidy` (with or without `--apply`) moves products that sit directly on
   a parent category (e.g. listed by hand onto "Gaming") into the
   sub-category the rules pick -- only within the same parent; anything
   else is listed and left alone.
3. Monthly: upload the new lists. Costs update, auto-priced products
   reprice, and discontinued items go out of stock.

## Backups

- Automatic daily SQLite snapshot to `data/backups/` (30 kept) and **Admin →
  Backups → Back up now**.
- Off-server copy to Google Drive: see the next section (set up in the admin,
  no cron job needed; remove any old `rclone` crontab line for Procom).

## Off-site backups (Google Drive)

The daily backups sit on the same disk as the live database, so they do not
survive the disk or the VPS failing. The app can copy them to Google Drive
with `rclone`, using the Google Drive remote Lapanza3d already set up on this
VPS (both apps run as the `deploy` user, so they share
`~deploy/.config/rclone/rclone.conf`).

What the app does (`server/features/ops.js`), after every **automatic** backup
(checked every 10 minutes) and on **Admin → Backups → Sync now**:

```text
rclone sync /opt/procomsolutions/app/data/backups  <remote>/backups   # mirror: Drive keeps the same latest 30
rclone copy /opt/procomsolutions/app/data/uploads  <remote>/uploads   # copy only: a photo deleted here stays on Drive
```

Each run is recorded (Admin → Backups → "Recent off-site copies", and "Last
copy to Google Drive" on About this site). A failed photo copy shows as
"Partly failed", never as a failed backup. If `rclone` is missing the page
says so; nothing else breaks.

### Choose a folder no other job mirrors into (important)

`rclone sync` makes the destination **identical** to the source, deleting
anything else in it. Lapanza3d syncs its own backups folder into whatever its
`BACKUP_RCLONE_REMOTE` points at. If that is the **root** of the remote
(e.g. `gdrive:`), Lapanza's nightly sync would delete a Procom folder placed
under the same root (`gdrive:procomsolutions`), and Procom's next copy would
put it back, so the off-site copy would keep disappearing.

Lapanza3d's own setup (its DEPLOY.md §9) is `BACKUP_RCLONE_REMOTE=gdrive:`, the
root, so **Procom must never use any path under plain `gdrive:`**. The app
refuses it. Instead, point the same Google login at a folder of Procom's own
with rclone's connection-string form; no rclone config change or SSH needed:

1. In Google Drive create a folder, e.g. "Procom backups" (**not** inside
   Lapanza's backup folder), open it and copy the last part of its web
   address (`https://drive.google.com/drive/folders/<FOLDER_ID>`).
2. Use `gdrive,root_folder_id=<FOLDER_ID>:` as Procom's remote.

(A separate `[gdrive-procom]` section in `~/.config/rclone/rclone.conf` with
its own `root_folder_id` works too; use `gdrive-procom:` then.)

Note for Lapanza3d (separate project): it copies its photos to `<remote>uploads`,
inside its own sync destination, so every nightly sync deleted that copy and
re-uploaded it. Changing its remote (e.g. `gdrive:backups`) would not help (the
photos move along to `backups/uploads`); the fix is `--exclude /uploads/**` on
its sync (Lapanza-3d-Creations PR #2, 2026-09-29).

### Switch it on

1. **Admin → Backups → Google Drive remote**: enter the remote (e.g.
   `gdrive,root_folder_id=<FOLDER_ID>:`) and **Save**. It is stored in the database
   (`ops_settings`). Blank = off.
   Alternatively set `BACKUP_RCLONE_REMOTE=gdrive,root_folder_id=<FOLDER_ID>:` in
   `/opt/procomsolutions/app/.env` and restart the service; the env value
   overrides the admin box (which then shows it read-only).
2. **Test connection** (runs `rclone lsd <remote>`). "Doesn't exist yet" is
   fine: the first sync creates the folder.
3. **Sync now**. The first run copies every product photo and can take
   several minutes; the page refreshes by itself. Check in Google Drive that
   `backups/` and `uploads/` appeared.

The remote must look like `name:`, `name:folder` or `name,root_folder_id=ID:` (validated; it can never
be a local path or an rclone flag). If Google stops accepting the token (the
`refresh_token` is revoked or rclone's shared client id is retired), both
sites' copies fail at the same time: redo Lapanza's DEPLOY.md §9 step 3–4
(`rclone authorize "drive"`) and press **Test connection**.

### Restoring from Google Drive

```bash
rclone lsf <remote>/backups | sort | tail -5                  # newest last
rclone copy <remote>/backups/<file>.db /tmp/                  # then follow "Restore" below with /tmp/<file>.db
rclone copy <remote>/uploads /opt/procomsolutions/app/data/uploads   # photos, if lost
```

Privacy: `privacy.html` (section 5) tells customers the backups are also kept
in Google Drive. Change it if this is ever switched off for good.

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
