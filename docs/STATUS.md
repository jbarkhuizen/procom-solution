# Status & backlog

_Last updated: 2026-09-29_

## Live state

- **Site:** https://www.procomsolutions.co.za — live, taking real payments (Payfast **live**, Lapanza's merchant account)
- **Email:** working (Gmail SMTP as procompretoria@gmail.com); test email confirmed 2026-09-25
- **Admin account:** created by the owner
- **Live products:** 4,164 (2026-09-28, after the SMD auto-lists; was 1,397)
- **Delivery (per supplier, since 2026-09-28):** every live product is SMD's → courier **R150** incl VAT per order, **free** when SMD's invoice (our cost incl VAT, excluding our markup) is R5,000+, large items included; or **free collection** at SMD's Edenvale office (Mon–Fri 09:00–16:00, collection notice + ID). Store-wide courier brackets (0–3 kg R150, 3–10 kg R220, 10–25 kg R300) and delivery quotes now apply only to non-SMD suppliers and products without a supplier. PUDO + local delivery switched off.
- **Google:** site verified in Search Console, sitemap submitted 2026-09-28.
- **Deployed:** automatically on every merge to `main` via GitHub Actions (`.github/workflows/deploy.yml`) since 2026-09-28 -- first run 36403935284 green (server tests 49/49, health ok, lapanza3d 200). Check the Actions tab for the current live commit.
- **Admin upgrade (from Lapanza3d), all 21 items live 2026-09-29:** Phase 1 accounts/invoices/promos/specials, Phase 2 analytics/newsletters/finance/marketing, Phase 3 backups (off-site to a Procom-only Google Drive folder, syncing), version history, test cases, about, audit log, todo, settings, nav. 160 server tests.

The *Delivery* column is the category's quote flag. It only takes effect for non-SMD suppliers (SMD's flat R150 covers everything).

| Category | Live | Delivery |
|---|---|---|
| Computers & Peripherals (Keyboards & Mice 149, Headsets & Audio 119, Computer Accessories 82, Cables & Adaptors 23, Laptop & Monitor Stands 14, Webcams & Streaming 12, Laptops & Tablets 9 — 10% markup, PC Components 7, Storage & Memory 6, Monitors 3) | 424 | normal |
| Networking (Routers & Mesh 122, Wi-Fi Extenders & Adapters 68, Switches 62, Security Cameras 50, Business Switches & Access Points 35, Networking Accessories 15) | 352 | normal |
| Gaming (Gaming Mice & Keyboards 90, Gaming Headsets 26, Controllers & Racing 24, Gaming Chairs & Desks 11, Handheld & Retro Consoles 8, Mouse Pads & Accessories 4, Gaming Accessories 3) | 166 | Gaming Chairs & Desks quoted |
| Mobile & Wearables (Chargers & Cables 158, Smartwatches 84, Power Banks 35, Car Accessories 30, Smart Rings & Glasses 19, Phone Accessories 16, Trackers & Tags 10, Phones 3 — 10% markup) | 355 | normal |
| Audio (Earphones & Earbuds 155, Headphones 112, Speakers 76, Microphones & Karaoke 35, Soundbars & Hi-Fi 21, Audio Accessories 3) — new | 402 | heavy items quoted per product |
| Power & Electrical (Multiplugs & Surge Protection 110, Adaptors & Extension Leads 86, Switches, Sockets & Wiring 68, Batteries 19, Electrical Accessories 5) | 288 | normal |
| Home & Kitchen (Utensils & Gadgets 82, Food Storage & Drinkware 56, Cookware & Pans 37, Kitchen Appliances 35, Irons & Floor Care 27, Heating & Cooling 23, Home & Living 14) | 274 | normal |
| Baby & Toddler (Bottles & Teats 64, Feeding & Weaning 50, Dummies & Teethers 27, Maternity & Breastfeeding 26, Blankets & Swaddles 15, Wipes 15, Bath & Skin Care 14, Oral Care 13, Nappy & Changing Bags 12, Sterilising & Cleaning 12, Health & Safety 11, Baby Toys & Keepsakes 6, Hair Accessories 6) | 271 | normal |
| Bags & Laptop Cases (Laptop Bags & Backpacks 102, School & Everyday Backpacks 79, Lunch Bags & Bottles 33, Handbags, Purses & Wallets 20, Cable Organisers & Pouches 6) | 240 | normal |
| Smart Home & Lighting (Light Bulbs 92, Smart Home 51, Outdoor & Flood Lights 42, Lamps & Indoor Lighting 41) | 226 | normal |
| 3D Printing (13 sub-categories; Filament – PLA 189, – PETG 45, – ABS & ASA 27, – TPU & Specialist 21 incl. SA Filament) | 576 | quoted for FDM/Resin printers + Laser Engravers |
| Furniture (Desks & Office Chairs, Tables, Shelving & Storage, Seating & Living) | 186 | quoted |
| Luggage & Travel (Suitcases 88, Luggage Sets & Business Trolleys 16) | 104 | quoted |
| Cameras & Photography (360 & Action Cameras 41, Camera Accessories 37, Dash Cams 3) — new | 81 | normal |
| TV & Video (TV Cables & Accessories 32, TV Wall Mounts & Stands 32, Projectors & Screens 1) — new | 65 | heavy items quoted per product |
| Office & School (Calculators 45, Stationery 14, Label Printers 5) — new | 64 | normal |
| Health & Beauty (Hair Care 22, Personal Care & Wellness 25 incl. Lifree) | 47 | normal |
| Toys & Games (STEM & Building Toys 22, Outdoor & Bubble Toys 11, Games & Novelties 10) — new | 43 | normal |

**Suppliers:** SMD (Warehouse), Esquire, IDS, Huge PC, Dicspeed. All imports so far are SMD's
(Cash wholesale, Home and Beyond, Infant Essential, Creality list, two promo flyers).

**Imported files (all rows imported):**
- SMD Home and Beyond (609 rows, 11 brand tabs + Index): all 609 listed; 168 bulk items sold in their minimum quantity
- Creality wholesale list (474 usable of 475; 1 priced "TBC"): all listed under 3D Printing
- SMD Infant Essential September 2026 (286 rows, 6 brand tabs): all 286 listed by the auto-list on 2026-09-28
- SMD Cash Wholesale September 2026 (3,315 rows, 34 brand tabs): 2,481 listed by the auto-list on 2026-09-28 (44 marked delivery quoted); 647 already listed (Creality + hand-listed); 23 skipped (display stands, junk rows, refurbished/consumables, 2 mispriced TOSLINK cables). Backup before the run: `data/backups/pre-autolist-1790577475658.db`

## Esquire (API feed) -- live since 2026-09-29 (waiting for the login)

`server/esquire.js` pulls Esquire's DataFeed API at 06:00, 12:00, 18:00 SAST (login from Admin → Suppliers → Esquire → Supplier portal login; runs are skipped quietly until it is saved), imports it as a complete list, auto-lists new items (switch in Admin -> Warehouse feed -> Esquire live feed, off until switched on) and emails a report after every run. Rules: `server/esquire-rules.js`. Runbook: DEPLOY.md "Secrets".

Deployed: PR #36 (feed, delivery, vendor details, `233b7f2`) and PR #37 (login + password key from admin, `54cc283`), both green (tests + health + lapanza3d 200). No `.env` changes are needed; the password key file `.vault-key` is created by the server on first save.

## Decisions made

| Date | Decision |
|---|---|
| 2026-09-25 | Not VAT-registered; default markup 10%; price rounded up to next rand |
| 2026-09-25 | Domain procomsolutions.co.za (procompretoria.co.za is **not registered**) |
| 2026-09-25 | Shipping options copied from lapanza3d |
| 2026-09-25 | Payfast switched to live with Lapanza's credentials |
| 2026-09-27 | Large items: delivery quoted after order (printers, engravers, furniture, luggage) |
| 2026-09-27 | Bulk-only SMD items listed with their minimum qty; pack totals shown |
| 2026-09-27 | Creality items: supplier = SMD (SMD distributes Creality) |
| 2026-09-27 | Infant Essential: 13 Baby & Toddler sub-categories; Lifree and Loop & Co listed too; default markup; colour variants listed as separate products |
| 2026-09-27 | Cash Wholesale: category structure approved (4 new top-level categories); items already listed by hand keep their category; Creality tab skipped (listed from the Creality list); SA Filament listed under 3D Printing › Filament; laptops and phones listed; Gaming Chairs & Desks listed with delivery quoted |
| 2026-09-27 | Phones and Laptops & Tablets: markup pinned at 10% on the category (same as today's default, but stays 10% if the default changes). Heavy Cash Wholesale items (49: soundbars/subwoofers, big party speakers, 24"/27" monitors, projector screens, large TV mounts, racing cockpit, electric scooter) listed with delivery quoted |
| 2026-09-29 | Esquire delivery: collection in Samrand + customer's own courier (waybill + collection date emailed to us); TVs by courier carry Esquire's 3% insurance as a separate line (3% of the TV price). Supplier portal logins kept in Admin → Suppliers, password encrypted (key file `.vault-key` created by the server, never backed up), every reveal audited. The Esquire sync uses the Esquire supplier's portal login -- owner preferred admin over `.env`. |
| 2026-09-29 | **SMD live API** (spec: SMD API INFO PDF): API token + Client access key on Admin → Suppliers → SMD (encrypted); read-only "Check connection" first, then automatic sync at 06:30/12:30/18:30 (30 min after Esquire), off until switched on. Updates listed SMD products only (never categories): cost from PriceExcl, SMD specials lower our price and show as Sale (normal price struck through); stock from SOH (out at 0 / below pack size, back when restocked, admin's manual out kept, "Only N left" at ≤5, checkout can't exceed stock); SMD long descriptions fill blank descriptions; full-size photos replace SMD's ~113px spreadsheet thumbnails (admin-uploaded/changed photos never touched). RRP ignored (a struck-out price must be one we charged). New SMD SKUs appear in Warehouse feed (file smd-api.json). Safety: >20% of listed SMD products missing from the API = left alone and reported; far fewer prices than last run = run skipped. Monthly pricelists still supply pack sizes. |
| 2026-09-29 | Shop and Specials: **"Load more"** button (30 at a time, "Showing 60 of 412") instead of page numbers; Back from a product returns to the same list. Product cards and pages show a small **warehouse icon** next to "In stock" -- one colour per warehouse, tooltip "Ships from our Samrand/Edenvale warehouse" (public label only, supplier names never shown). |
| 2026-09-28 | Legal pages reuse Lapanza3d's reviewed wording, adapted to Procom. Site name stays Procom Solutions, contact procompretoria@gmail.com; procompretoria.co.za not registered. Bubble Buddy duplicate left as is |
| 2026-09-28 | SMD dispatches every SMD item straight to the customer, **courier only** (no PUDO, no local delivery). Site texts and legal pages say courier only; owner to switch off the PUDO Locker + Local Delivery options in Admin → Shipping options and add a courier bracket above 5 kg. The PUDO checkout code stays (dormant while no PUDO option is active). |
| 2026-09-28 | Courier-only shipping live (checked): auto by weight — Courier Small 0–3 kg R150, Medium 3.001–10 kg R220, Large 10.001–25 kg R300; carts over 25 kg are asked to WhatsApp. Prices are placeholders until SMD's courier charges are known. PUDO + local delivery options switched off. |
| 2026-09-28 | Google Search Console: site verified and https://www.procomsolutions.co.za/sitemap.xml submitted by owner. Sitemap lists static + legal pages, non-empty categories and live products with lastmod; category pages set their own canonical. If product pages aren't indexed after a few weeks, consider server-rendered product pages (content is filled in by JavaScript today). |
| 2026-09-28 | Free warehouse collection from SMD, 2 Lascelles Road, Meadowbrook, Edenvale (owner decisions: address + map only at checkout and in emails, SMD never named; free; large items may be collected instead of quoted; admin clicks "Ready for collection" to email the customer, typically 2–3 days after payment). Collection hours default "Weekdays during business hours" — owner to confirm exact times in Site settings. |
| 2026-09-28 | **Per-supplier delivery.** SMD: courier R150 incl VAT per order, free when SMD's invoice (our cost incl VAT) is R5,000+, covering large items (no more delivery quotes for SMD items); free collection at 2 Lascelles Road, Meadowbrook, Edenvale, Mon–Fri 09:00–16:00 with the collection notice + ID/driver's licence/passport (anyone with the notice may collect). Mixed-supplier carts: one delivery choice per supplier, fees add up. Other suppliers (e.g. Esquire) use the store-wide options until set up in Admin → Suppliers. The store-wide "Collection" shipping option was switched off (collection is per supplier). |
| 2026-09-28 | **Phase 1 upgrade (from Lapanza3d):** optional customer accounts (guest checkout stays), Clients + Registered users admin, sequential invoices (INV-000001, not a tax invoice) + Invoice history, promo codes + specials capped so nothing sells below cost incl VAT. Phase 2 next: Dashboard, Analytics, Financial overview, Expenses, Newsletters, Potential market, Adverts/Platform rules/Calendar. Phase 3: Version history, Backups, Test cases, About this site, Todo, Audit logs, Site settings. |
| 2026-09-28 | **Phase 2 upgrade:** own first-party analytics (no cookie banner), newsletters via Gmail (opt-in only, 400/day throttle, one-click unsubscribe), Dashboard + Financial overview + Expenses (Payfast fees estimated: card 3.2% + R2, EFT 2% min R2, + VAT — adjust to statement), Potential market, Adverts, Calendar, Platform rules with read-only copy from Lapanza3d's DB. |
| 2026-09-29 | **Phase 3 upgrade:** Backups with optional off-site copy to a Procom-only Google Drive folder (`gdrive,root_folder_id=<id>:`; plain `gdrive:` refused -- Lapanza3d syncs that root and would delete it), Version history, Test cases run from admin, About this site, Audit log, Todo/Backlog, tidied Site settings and admin nav. All 21 upgrade items done. |
| 2026-09-28 | Automatic deploys: GitHub Actions deploys `main` using a key locked to `deploy-app.sh` (forced command in `~deploy/.ssh/authorized_keys`, comment `github-actions-procom`); secrets DEPLOY_SSH_KEY + DEPLOY_KNOWN_HOSTS set on the repo |
| 2026-09-29 | **Esquire** via their live API (not file uploads): pulled 3x a day (06:00, 12:00, 18:00 SAST), complete list; feed prices include VAT (verified) and are stored excl VAT; `m=0` (Esquire's own markup) kept at 0; default 10% markup; listed items leaving the feed go out of stock and come back when they return (admin's manual out-of-stock is kept); status email to procompretoria@gmail.com after every run. Range: IT & electronics only -- old phone/iPad covers, candles/balloons, licensed characters, stationery are never imported. Same product from SMD and Esquire = two separate listings. Ordering: Esquire portal, dropshipped to the customer. |
| 2026-09-28 | Hand-listed products on Gaming, Networking and Smart Home & Lighting (148) moved into the matching sub-categories with `smd-autolist-cli.js --tidy --apply` (backup `pre-autolist-2026-09-28T07-22-28-578Z.db`). The two mispriced TOSLINK cables stay skipped. |

## Open items / backlog

**Needs the owner**
- ~~After the Phase 3 deploy~~ done 2026-09-29: Drive backups to a Procom-only folder synced; tests run from admin.
- **After the Phase 2 deploy:** Platform rules → "Copy platforms & rules from Lapanza3d" (check the preview, then apply). Financial overview → check the Payfast fee estimates against a Payfast statement.
- **Margins:** at the 10% default markup a special or promo of more than ~5% loses money once Payfast fees (~3–4%) are counted. Owner decided (2026-09-29): the cap stays at cost incl VAT, fees not included -- keep discounts small.
- **After the Phase 1 deploy:** Admin → Invoice history → **Issue missing invoices** once, so older paid orders (PC10002…) get invoice numbers before new ones.
- ~~First real test order~~ done: paid live, emails and collection notice arrived.
- **Legal pages — one open choice:** risk in transit passes to the customer *on delivery* (so courier losses are ours) — keep? (Drive backups are now in the Privacy Policy; address 23 Gladiator Rd confirmed.)
- **Esquire go-live:** deployed 2026-09-29. Owner: enter the Esquire portal username + (new) password in Admin → Suppliers → Esquire, then Warehouse feed → Esquire live feed → Sync now (auto-list off), check the email, Preview auto-list, switch auto-list on. No `.env` changes needed. **Change the Esquire password first** (shared in a chat).
- **Esquire delivery** (built, applied automatically on first start after deploy): Samrand warehouse collection (71 Landmarks Avenue, Kosmosdaal Ext 11, Samrand, 0157; Mon–Fri 09:00–16:00 · Sat 09:00–12:00), customer's own courier (free; customer emails waybill + collection date), otherwise store-wide courier brackets / quotes. **Still open: Esquire's courier fee** -- when known, set Admin → Suppliers → Esquire → "Flat courier fee". Televisions: 3% courier insurance as its own checkout line (category setting "Courier insurance %"), not charged on collection / own courier.
- **Vendor details** (Admin → Suppliers): address, order process, portal website, username and encrypted password (key file `.vault-key` on the server, created automatically -- owner may keep a copy of it).
- **SMD API go-live:** owner enters the token + key in Admin → Suppliers → SMD → Supplier API access, runs **Check connection** (Warehouse feed → SMD live API), reviews the email (match rate, cost changes, stock, photos, SKUs not sold yet), then switches the automatic sync on. First real sync queues full-size photo downloads for ~4,000 products (runs in the background for a while).
- **Photos** (owner investigating): SMD's embedded photos are ~113px; upload better photos for key products first.
- **Google Search Console** — check in 1–2 weeks: sitemap "Success", indexed pages rising. If product pages still aren't indexed after ~4 weeks, consider server-rendered product pages (their content is filled in by JavaScript).

**Routine**
- **Monthly SMD update:** import the new Infant Essential / Cash Wholesale files, then on the server `node server/smd-autolist-cli.js` (dry run) and `--apply` (see DEPLOY.md) — the browser button can time out on the Cash list. Everfurn Theo boxes are skipped by rule (deleted 2026-09-28).

**Low priority / known**
- **Lapanza3d offsite photos:** fixed 2026-09-29 (Lapanza-3d-Creations PR #2, deployed). Check its Drive `uploads` folder keeps its photos after the next nightly run.
- **Weights:** supplier lists have none (default 1 kg). No effect on SMD items (flat fee); matters only for store-mode suppliers.
- **Bubble Buddy** (Avalanche DB0008 / DB0009, same name and price): owner — leave as is. The two Ellies TOSLINK cables (~R1.08m) stay skipped.
