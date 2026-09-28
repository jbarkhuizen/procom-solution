# Status & backlog

_Last updated: 2026-09-28_

## Live state

- **Site:** https://www.procomsolutions.co.za — live, taking real payments (Payfast **live**, Lapanza's merchant account)
- **Email:** working (Gmail SMTP as procompretoria@gmail.com); test email confirmed 2026-09-25
- **Admin account:** created by the owner
- **Live products:** 4,164 (2026-09-28, after the SMD auto-lists; was 1,397)
- **Deployed:** automatically on every merge to `main` via GitHub Actions (`.github/workflows/deploy.yml`) since 2026-09-28 -- first run 36403935284 green (server tests 49/49, health ok, lapanza3d 200). Check the Actions tab for the current live commit.

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
| Toys & Games (STEM & Building Toys 22, Outdoor & Bubble Toys 11, Toys & Games 10) — new | 43 | normal |

**Suppliers:** SMD (Warehouse), Esquire, IDS, Huge PC, Dicspeed. All imports so far are SMD's
(Cash wholesale, Home and Beyond, Infant Essential, Creality list, two promo flyers).

**Imported files (all rows imported):**
- SMD Home and Beyond (609 rows, 11 brand tabs + Index): all 609 listed; 168 bulk items sold in their minimum quantity
- Creality wholesale list (474 usable of 475; 1 priced "TBC"): all listed under 3D Printing
- SMD Infant Essential September 2026 (286 rows, 6 brand tabs): all 286 listed by the auto-list on 2026-09-28
- SMD Cash Wholesale September 2026 (3,315 rows, 34 brand tabs): 2,481 listed by the auto-list on 2026-09-28 (44 marked delivery quoted); 647 already listed (Creality + hand-listed); 23 skipped (display stands, junk rows, refurbished/consumables, 2 mispriced TOSLINK cables). Backup before the run: `data/backups/pre-autolist-1790577475658.db`

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
| 2026-09-28 | Legal pages reuse Lapanza3d's reviewed wording, adapted to Procom. Site name stays Procom Solutions, contact procompretoria@gmail.com; procompretoria.co.za not registered. Bubble Buddy duplicate left as is |
| 2026-09-28 | SMD dispatches every SMD item straight to the customer, **courier only** (no PUDO, no local delivery). Site texts and legal pages say courier only; owner to switch off the PUDO Locker + Local Delivery options in Admin → Shipping options and add a courier bracket above 5 kg. The PUDO checkout code stays (dormant while no PUDO option is active). |
| 2026-09-28 | Automatic deploys: GitHub Actions deploys `main` using a key locked to `deploy-app.sh` (forced command in `~deploy/.ssh/authorized_keys`, comment `github-actions-procom`); secrets DEPLOY_SSH_KEY + DEPLOY_KNOWN_HOSTS set on the repo |
| 2026-09-28 | Hand-listed products on Gaming, Networking and Smart Home & Lighting (148) moved into the matching sub-categories with `smd-autolist-cli.js --tidy --apply` (backup `pre-autolist-2026-09-28T07-22-28-578Z.db`). The two mispriced TOSLINK cables stay skipped. |

## Open items / backlog

- **Shipping options set up wrong (seen live 2026-09-28)** — the 3 active courier options (Small 0-3kg R150, Medium 3-10kg R220, "PUDO Small (10-25kg)" R300) are type **"Customer picks"** with no weight range, so checkout lists all three and a customer can pick R150 for any cart. Fix in Admin → Shipping options: type **Auto by weight**, ranges 0–3000 g / 3001–10000 g / 10001–25000 g, rename the third to "Courier Large (10-25kg)". Carts over 25 kg then get "WhatsApp us" at checkout.
- **Toys category rename still wrong (seen live 2026-09-28)** — top level is "Games & Novelties" (slug toys-games) with a sub "Toys & Games" (toys-games-2). Should be top level **Toys & Games** › sub **Games & Novelties** (what smd-rules.js expects); otherwise the next Cash auto-list creates duplicates.
- **SMD courier charges unknown** (2026-09-28) — owner to find out how SMD bills delivery to customers (flat, by weight/size, per parcel, free over a value, remote-area surcharge) and whether it's billed per order or monthly. Until then checkout courier prices are the Lapanza3d defaults and may not cover SMD's cost. All stock is SMD dropship — no local stock.
- **Everfurn Theo Dining Table (White)** — Box 1 of 2 and Box 2 of 2 (hidden, R65,219.99 each from SMD): owner decided 2026-09-28 to **remove** them. The Cash Wholesale rules now skip "Everfurn Theo" so a re-run never re-lists them; owner to delete both in Admin → Products (search "Theo").
- **First real test order** (cheap item + refund) to prove ITN → Paid → emails end to end in live mode — not yet confirmed.
- **Photos** (owner investigating): SMD's embedded photos are ~113px; better photos should be uploaded for key products.
- **Weights** (owner investigating): supplier lists have none (default 1 kg). Heavy categories use delivery quotes; other large one-offs (e.g. filament maker, 10-roll filament dryer in 3D Upgrades) may need the per-product "delivery quoted" override.
- **Legal pages** — replaced 2026-09-28 with Lapanza3d.co.za's reviewed Terms/Privacy/Returns, adapted to Procom: dropship ready stock (7-day cooling-off on everything), delivery quoted for large items, guest checkout only, warehouse supplier + couriers listed as recipients of delivery details, risk passes on delivery. Physical address shown: 23 Gladiator Rd, Pierre van Ryneveld (same partnership as Lapanza) — confirmed by owner 2026-09-28.
- **SMD auto-lists done 2026-09-28** (Infant Essential 286, Cash Wholesale 2,481). Next month: import the new files, then run `node server/smd-autolist-cli.js` on the server (dry run) and `--apply` (see DEPLOY.md) -- the browser button can time out on the Cash list.
- **Sub-category named like its parent**: Toys & Games › Toys & Games (10 items) — rename to exactly **Games & Novelties** in Admin → Categories (the Cash Wholesale rule now uses that name; any other name makes the next auto-list recreate "Toys & Games").
- **Bubble Buddy** (Avalanche DB0008 / DB0009, same name and price): owner — leave as is. The two Ellies TOSLINK cables (~R1.08m) stay skipped.
- **Heavy items**: 44 Cash Wholesale products marked delivery quoted (5 more heavy ones were already hand-listed and keep their setting). Medium items (20-30 m extension reels, single 8" party speakers, metal desk lamps), Totes Babe bags and the R3,900 Loop & Co display box still ship at the default 1 kg.
