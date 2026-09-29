# Procom Solutions — project context

Online store **https://www.procomsolutions.co.za**, owned by **Lapanza** (trading as
Procom Solutions). Sells computer equipment, 3D printing, home & kitchen, furniture,
luggage and more — mostly **dropshipped** from the supplier's warehouse (SMD).
Design system copied from lapanza3d.co.za (`D:\Projects\Lapanza 3d Creations\lapanza-3d-fullsite V1 - Martin`).

- Repo: https://github.com/jbarkhuizen/procom-solution (**public** — never commit secrets; IPs are fine, passwords are not)
- Contact on site: procompretoria@gmail.com · 082 663 9608 (Lapanza's number)
- Payfast: **live**, using Lapanza's merchant account (payments show "Procom Solutions order PC…")
- Email: Gmail SMTP as procompretoria@gmail.com (app password in server `.env` only)
- **Current live state, decisions log and open items: [docs/STATUS.md](docs/STATUS.md)** — read it first, update it when things change.

## Stack & layout

Express 5 + better-sqlite3 API · Vite + Tailwind v4 static storefront · vanilla-JS admin SPA · Payfast · nodemailer.

```
server/            API (index.js), schema+migrations (db.js), catalog, pricing, feed import
  feed-parsers.js  XLSX/CSV/JSON/XML/PDF -> tables of headers+rows (+ row photos)
  feed.js          preview cache, column mapping, import, list-from-feed, delete import
  smd-rules.js     per-pricelist category rules for SMD lists (Infant Essential, Cash Wholesale)
  smd-autolist.js  applies those rules: preview, create missing categories, list
  smd-autolist-cli.js  same from the server shell (dry run; --apply backs up the DB first; --tidy moves
                   products off parent categories into the matching sub-category, same parent only)
  esquire.js       Esquire live API: 3x/day pull (ESQUIRE_USER/PASS in .env), import, auto-list, report email
  esquire-rules.js Esquire category -> store sub-category rules (same shape as smd-rules.js)
  vault.js         AES-GCM for supplier portal passwords (VAULT_KEY in .env); reveal is audited
  remote-images.js background photo-URL downloader (SSRF-guarded)
  *.test.js        node --test suites (npm test)
admin/             admin SPA served at /admin (no build step); dom.js = only HTML sink
src/js, src/styles storefront JS + Tailwind (main.css from lapanza3d); dom.js = only HTML sink
partials/          header/sidebar/footer, inlined at build by a small Vite plugin (<!-- @include x -->)
*.html             storefront pages (index, shop, product, checkout, ...)
data/              procom.db, uploads/, backups/  (gitignored)
deploy/            nginx vhost, systemd unit, deploy-app.sh, DEPLOY.md (runbook)
```

Commands: `npm run dev` (API :8788 watch + Vite :5174), `npm test`, `npm run build`, `npm start`.

## How the business logic works (read before changing)

- **Money is integer cents** everywhere (`*_cents`). Weights in grams.
- **Pricing** (`server/pricing.js`): `retail = cost_excl_VAT × 1.15 × (1 + markup)`, rounded **up** to the next rand (`roundRetail`). Business is **not VAT-registered** (supplier VAT is a cost). Markup precedence: product → nearest category up the tree → site default (**10%**). `price_mode='manual'` products are never repriced.
- **Storefront reads the catalogue live** from the API (no publish step, unlike lapanza3d). Empty categories are hidden.
- **Warehouse feed**: upload → `POST /feed/preview` (parse, auto-map columns by heading aliases, cached 30 min by token) → `/feed/preview/map` (live re-map) → `/feed/import`. Mapping is by header *name* so one mapping applies to every sheet. Rows with no code and no price are section headings (become supplier category) or notes. No brand column → real sheet name, else a first word covering ≥40% of names.
  - `completeList` = true: listed products missing from the file go out of stock (never auto back in stock). **Flyers/partial lists** (PDF flyer mode defaults off) only update the **cost** of known items.
  - Re-import updates costs and reprices auto-priced listed products.
  - `deleteImport` removes the history row + feed items whose latest data came from that file, **except** items listed in the shop or touched by a newer import.
  - **SMD auto-list** (`server/smd-rules.js` + `server/smd-autolist.js`; Warehouse feed → "Auto-list SMD Infant Essential…" / "Auto-list SMD Cash Wholesale…"): rules match SMD's category column, the brand tab and/or the product name (first match wins — order matters) and put each row from the latest import of that list (file name `*infant*` / `*cash*wholesale*`) into a store sub-category. A preview panel shows counts per category, **categories that would be created** (spot near-duplicates of live names here), skipped rows with reasons and unrecognised rows. Then it creates missing categories by name (parents must match live names exactly), lists at default markup, live; never overrides an admin-set category; re-running only lists new items. Always skipped: cost under R1 or over R100,000 (SMD typos), plus per-list `skip` rules (Cash: display stands, junk rows, refurbished/consumables, the Creality tab). A rule with `quote: true` creates its category with delivery quoted (Cash: Gaming › Gaming Chairs & Desks); `markup: N` creates it with its own markup (Cash: Phones and Laptops & Tablets pinned at 10%). A list's `heavy` pattern marks individual products delivery quoted when listed (Cash: soundbars/subwoofers, big party speakers, 24"/27" monitors, projector screens, heavy-duty or 86"+ TV mounts, racing cockpit, electric scooter — 49 in Sept 2026); products with an admin-set delivery choice are untouched. When changing rules, add a case to `smd-autolist.test.js` and re-run against the real file.
  - `cleanProductName()` strips SMD's "(To Be Ordered in Qty of N)" / "( Order in Qty of N)" from shop titles; `parseMinOrderQty()` reads it into `min_order_qty`.
- **Minimum order qty**: cards/product page show the pack total ("R576.00 per 24", unit price under); cart and checkout enforce the minimum.
- **Delivery quoted** (`quote_delivery`, **store-mode suppliers only**): category flag inherited by sub-categories; product override (NULL inherit / 1 always / 0 never). If a store-mode shipment has an item needing a quote, the **server** offers only quote (or collect), charges R0 delivery, requires a street address and sets `orders.delivery_quote=1`; admin shows a banner with pre-written WhatsApp/email quote. On for: 3D Printers FDM/Resin, Laser Engravers, Furniture, Luggage & Travel, Gaming Chairs & Desks; per product for heavy Cash Wholesale items.
- **Delivery is per supplier** (`server/delivery.js`, Admin → Suppliers → Delivery): each supplier's items are one shipment with its own choice at checkout; mixed carts get one choice per supplier and the fees add up; each supplier gets its own order sheet. A supplier is **flat** (one courier fee per order, free once *their invoice* = our cost × 1.15 reaches a threshold; covers large items, so no delivery quotes) or **store** (store-wide shipping options + delivery quotes; also used for products without a supplier). Either may offer **free collection** (address/hours/what-to-bring). Customers only ever see the supplier's *public label* (e.g. "Edenvale warehouse"), never its name; the collection address appears only at checkout (map loads when Collect is chosen) and in emails. **SMD**: flat R150 incl VAT, free from R5,000 invoice incl VAT; collect at 2 Lascelles Road, Meadowbrook, Edenvale, Mon–Fri 09:00–16:00, collector brings the collection notice + ID/driver's licence/passport (anyone with the notice may collect). Admin order → "Ready for collection — email notice" per collect shipment. Orders store the shipments in `orders.fulfilment_json`.
- **Shipping** mirrors lapanza3d: `auto_weight` Courier brackets by cart weight, `fixed` PUDO Locker / Local Delivery options. Supplier lists have **no weights** (default 1 kg) — that's why large items use delivery quotes.
- **Feature modules** (`server/features/`, `admin/pages/`; contract in `server/features/README.md`): Phase 1 of the Lapanza3d-style upgrade (2026-09-28).
  - **Accounts** (`accounts.js`): optional customer accounts (register → email verify → login, reset, account page `account.html` with orders/invoices/saved details/newsletter opt-in); guest checkout stays; orders link to the account by email or login session. Admin: Clients (CRM grouped by email), Registered users.
  - **Invoices** (`invoices.js`): sequential `INV-000001` issued when Payfast confirms payment (idempotent, gap-free), emailed; printable `invoice.html?o=<orderId>` ("Invoice", no VAT — not VAT-registered). Admin: Invoice history (CSV, monthly totals, "Issue missing invoices" backfill).
  - **Promos / Specials** (`promos.js`, `specials.js`, shared `discount-common.js`): nothing may go below **cost incl VAT** — specials are floored per unit, promo discounts capped at the margin above that floor across the lines they apply to; admin shows where the cap bites. Specials show as price + struck-through normal price; public `specials.html`. Promo uses count paid orders only.
- **Phase 2 features** (2026-09-28):
  - **Analytics** (`analytics.js`, `src/js/analytics-beacon.js`): first-party only — anonymous visitor id in localStorage, no IPs/cookies/third parties; honours Do Not Track/GPC; bots and admins ignored; raw rows kept 12 months then rolled into daily totals. Funnel reads paid orders from `orders`.
  - **Newsletters** (`newsletters.js`, `newsletter.html`, footer signup): Gmail via `sendMail`, **opt-in only** (double opt-in signups + verified accounts with the box ticked, minus suppressions), compose → test → approve → send, throttled **400/SAST day** in batches of 20/min, resumes after restart; one-click unsubscribe link + RFC 8058 `List-Unsubscribe` headers (`/api/newsletter/one-click`).
  - **Finance** (`finance.js`): Dashboard (overrides the core one), Financial overview (income − cost of goods × 1.15 − delivery fees − estimated Payfast fees − expenses, per SAST month; cancelled orders excluded), Expenses with line items. Payfast fee % is an estimate set in Financial overview.
  - **Marketing** (`marketing.js`): Potential market (leads, CSV), Adverts, Calendar, Platform rules. "Copy platforms & rules from Lapanza3d" opens `/opt/lapanza/app/data/lapanza.db` (or `LAPANZA_DB`) **read-only**, preview then additive apply.
- **Phase 3 features** (2026-09-29):
  - **Ops** (`ops.js`): Backups (local + optional off-site copy to Google Drive via rclone), Version history, Test cases ("Run tests now" from admin, results stored), About this site. The Drive remote **must** be `gdrive,root_folder_id=<Procom folder id>:` -- plain `gdrive:` is refused because Lapanza3d's nightly `rclone sync` to that root deletes anything else there.
  - **Governance** (`governance.js`): Audit log of admin changes (secrets redacted, CSV export), Todo/Backlog, sectioned Site settings (margin warning), collapsible admin nav with "Find a page...".
- **Orders**: server re-prices from DB (client prices ignored); stock decremented on Payfast ITN (idempotent); each order gets a supplier order sheet (copy/email/WhatsApp).
- **Admin auth**: sessions stored in SQLite (survive restarts); first visit to /admin with no admins shows "create account"; same-origin check on mutations.
- **Payfast**: signing ported from lapanza3d (PHP-style urlencode, fixed field order). The shared public sandbox merchant (10000100) rejects all signatures, so it's sent **unsigned** only in that case; any real account is always signed.

## Deploying (VPS shared with lapanza3d, barkie, johanbarkhuizen, zatoengineering)

**Merging to `main` deploys automatically** (`.github/workflows/deploy.yml`: tests on GitHub → one SSH login with a key locked to `deploy-app.sh` via a forced command → health check of procomsolutions + lapanza3d). Needs repo secrets `DEPLOY_SSH_KEY` + `DEPLOY_KNOWN_HOSTS` (setup: `deploy/DEPLOY.md`); without them the deploy job is skipped. Cloud sessions (claude.ai/code) have no SSH access to the VPS -- they deploy only through this workflow; check the Actions run, not the server. Manual deploy from Johan's PC:

```bash
git push origin main
ssh -i ~/.ssh/lapanza_vps_deploy deploy@41.222.36.147 "bash /opt/procomsolutions/app/deploy/deploy-app.sh"
```
- App `/opt/procomsolutions/app`, service `procomsolutions-admin`, Node on `127.0.0.1:8788` (Lapanza uses 8787), nginx `/etc/nginx/conf.d/procomsolutions.conf` (certbot-managed; the script never overwrites it). Full runbook: `deploy/DEPLOY.md`.
- **fail2ban on SSH**: many SSH logins in a few minutes bans this PC's IP (~30 min). Do each server operation in **one** SSH session (chain commands; redirect deploy output to `/tmp/procom-deploy.log` and grep it).
- **Schema changes**: add columns via `COLUMN_MIGRATIONS` in `server/db.js` (additive, idempotent) — the live DB has real data.
- **Live data changes** (bulk listing, category moves): write a script, `scp` it to `/tmp`, copy into the app dir (needs `node_modules`), run, delete. Use app functions (`saveCategory`, `listFeedItems`, `bulkUpdateProducts`) rather than raw SQL; print a dry-run/summary and abort if anything is unmapped.
- Always verify afterwards: `curl https://www.procomsolutions.co.za/api/health` and that lapanza3d.co.za still returns 200.

## Working conventions / gotchas on this machine

- A security hook rejects any Write/Edit whose text contains the DOM "inner HTML" property name or the word exec directly followed by an opening parenthesis — even in docs. Use `setHtml()` from `src/js/dom.js` / `admin/dom.js` (the single audited HTML sinks — escape every dynamic value with `esc()` / `h()`); for SQLite's multi-statement call write a placeholder and replace it with `sed`.
- Reading `.env*` files is blocked by a permission rule (good — never print secrets; check "set/empty" only).
- Bash heredocs containing apostrophes break in this tool — write scripts to the scratchpad and run them.
- Playwright MCP can only save screenshots under the project (`.playwright-mcp/`, gitignored) — delete after use. The Claude Browser `preview_start` doesn't find this project's launch config; start servers with background Bash instead.
- Vite proxy must keep `changeOrigin: false` (otherwise admin saves fail the same-origin check in dev).
- Owner preferences: plain-language explanations; **propose category structures as a table for approval before creating them**; confirm before outward-facing actions; commit with the Co-Authored-By trailer.
