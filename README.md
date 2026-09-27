# Procom Solutions

Online store for **www.procomsolutions.co.za** — computer equipment, 3D printing,
home & kitchen, furniture, luggage and more, run by Lapanza. Most products are
dropshipped straight from the supplier's warehouse (SMD). The storefront reuses
lapanza3d.co.za's design system (fonts, palette, layout, components).

**Stack:** Express 5 · better-sqlite3 · Vite + Tailwind CSS v4 · vanilla-JS admin SPA · Payfast · Gmail SMTP
**Hosting:** same VPS as lapanza3d (nginx vhost + systemd, port 8788). See [deploy/DEPLOY.md](deploy/DEPLOY.md).
**Working on this repo with Claude:** see [CLAUDE.md](CLAUDE.md) for architecture, conventions and gotchas.

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

A fresh database shows a "create your admin account" screen on first visit to the admin.

## Features

**Storefront**
- Category tree (any depth) in the sidebar; empty categories stay hidden
- Search, brand filter, sort, in-stock filter, paging; compact 5-per-row product grid
- Product pages with photo gallery (photos shown near their real resolution so small supplier photos stay sharp), specs, related products
- Items sold in minimum quantities show the pack total ("R576.00 per 24")
- Cart drawer, checkout with lapanza3d's shipping model (Courier by weight, PUDO Locker, Local Delivery)
- **Delivery quoted after order** for large items (3D printers, laser engravers, furniture, luggage)
- Payfast card / Instant EFT; order confirmation page that waits for payment confirmation
- Contact form, Terms / Privacy (POPIA) / Returns (CPA, ECTA) pages, sitemap, dark mode

**Admin** (`/admin`)
- Dashboard (orders to process, 30-day revenue and estimated profit, items needing attention)
- **Products**: cost excl VAT → VAT → purchase price → profit → selling price for every product; bulk actions (live/hide, feature, move category, set markup, supplier stock)
- **Product editor**: live price breakdown, photos, specs, fulfilment (dropship / own stock), min qty, delivery-quote override
- **Categories**: tree, markup per category (inherited), "delivery quoted" per category
- **Warehouse feed**: import supplier files in **XLSX, CSV, JSON, XML or PDF** (PDF pricelist tables or promo flyers) with an editable column-mapping preview; embedded XLSX photos and photo URLs imported; list items into categories; monthly re-imports update costs and reprice listed products; delete an import; one-click auto-list of SMD's Infant Essential list into Baby & Toddler sub-categories
- **Orders**: status workflow, tracking, supplier order sheet (copy / email / WhatsApp), delivery-quote banner with pre-written message
- Suppliers, shipping options, site settings, enquiries, admin users, backups

## Pricing

`selling price = supplier cost excl VAT × 1.15 × (1 + markup)`, rounded up to the next rand.
Markup comes from the product, else its nearest category, else the site default (10%).
Changing a markup or re-importing a pricelist reprices every auto-priced product; manual prices stay fixed.
The rounding rule is `roundRetail()` in `server/pricing.js`.

## Commands

| Command | |
|---|---|
| `npm run dev` | API (watch mode) + Vite dev server |
| `npm run build` | Production build → `dist/` |
| `npm start` | API only (also serves `dist/` if built) |
| `npm test` | Server test suites (`node --test`) |

## Layout

```
server/        Express API, SQLite schema + migrations, pricing, feed import, orders, Payfast
admin/         Admin SPA (served at /admin, no build step)
src/js, src/styles   Storefront scripts + Tailwind (main.css from lapanza3d)
partials/      Header/sidebar/footer, included into pages at build time
*.html         Storefront pages
data/          procom.db, uploads/, backups/   (gitignored)
deploy/        nginx vhost, systemd unit, deploy script, runbook
```
