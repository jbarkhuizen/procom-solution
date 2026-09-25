# Procom Solutions

Online store for **www.procomsolutions.co.za**: computer equipment, tech and
more, run by Lapanza. Most products are dropshipped straight from the
supplier's warehouse (SMD). The storefront reuses lapanza3d.co.za's design
system (fonts, palette, layout, components).

**Stack:** Express 5 · better-sqlite3 · Vite + Tailwind CSS v4 · vanilla-JS admin SPA · Payfast · Gmail SMTP
**Hosting:** same VPS as lapanza3d (nginx vhost + systemd, port 8788). See [deploy/DEPLOY.md](deploy/DEPLOY.md).

## Run locally

```bash
npm install
npm run dev
```

| Service | URL |
|---|---|
| Storefront | http://localhost:5174 |
| Admin | http://localhost:5174/admin/ |
| API | http://127.0.0.1:8788 |

A fresh database shows a "create your admin account" screen on first visit
to the admin.

## How the catalogue works

- **Categories** are a tree (any depth). Empty categories stay hidden on the
  site until something is listed in them.
- **Products** are either *dropship* (warehouse ships to customer) or *own
  stock* (stock count decremented when an order is paid).
- **Pricing:** `retail = supplier cost excl VAT × 1.15 × (1 + markup)`,
  rounded up to the next rand. Markup comes from the product, else its
  nearest category, else the site default (10%). Change any of them and
  auto-priced products follow. Products can be switched to a manual price.
  The rounding rule is `roundRetail()` in `server/pricing.js`.
- **Warehouse feed:** upload SMD `.xlsx` pricelists (photos included) in
  admin, then pick items to list. Monthly re-uploads reprice listed products
  and mark discontinued ones out of stock. Items the supplier only sells in
  bulk ("order in qty of 36") are flagged and hidden by default.
- **Orders:** Payfast (card / Instant EFT). Each paid order gets a supplier
  order sheet to copy, email or WhatsApp to the warehouse.
- The storefront reads the catalogue **live** from the API. Unlike lapanza3d
  there is no "Publish" step.

## Commands

| Command | |
|---|---|
| `npm run dev` | API (watch mode) + Vite dev server |
| `npm run build` | Production build → `dist/` |
| `npm start` | API only (also serves `dist/` if built) |
| `npm test` | Server test suite (`node --test`) |

## Layout

```
server/        Express API, SQLite schema, pricing, feed import, orders, Payfast
admin/         Admin SPA (served at /admin, no build step)
src/js, src/styles   Storefront scripts + Tailwind (main.css from lapanza3d)
partials/      Header/sidebar/footer, included into pages at build time
*.html         Storefront pages
data/          procom.db, uploads/, backups/   (gitignored)
deploy/        nginx vhost, systemd unit, deploy script, runbook
```
