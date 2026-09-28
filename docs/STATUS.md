# Status & backlog

_Last updated: 2026-09-28_

## Live state

- **Site:** https://www.procomsolutions.co.za — live, taking real payments (Payfast **live**, Lapanza's merchant account)
- **Email:** working (Gmail SMTP as procompretoria@gmail.com); test email confirmed 2026-09-25
- **Admin account:** created by the owner
- **Live products:** 4,164 (2026-09-28, after the SMD auto-lists; was 1,397)
- **Deployed:** main @ `007c1fe` (2026-09-28). Later merges (.gitignore for `.env` backups, `server/smd-autolist-cli.js`) go live on the next deploy.

| Category | Live | Delivery |
|---|---|---|
| Computers & Peripherals (Keyboards & Mice 149, Headsets & Audio 119, Computer Accessories 82, Cables & Adaptors 23, Laptop & Monitor Stands 14, Webcams & Streaming 12, Laptops & Tablets 9 — 10% markup, PC Components 7, Storage & Memory 6, Monitors 3) | 424 | normal |
| Networking (Routers & Mesh 102, Wi-Fi Extenders & Adapters 57, Switches 54, Security Cameras 50, Business Switches & Access Points 24, Networking Accessories 15; 50 hand-listed on the parent) | 352 | normal |
| Gaming (Gaming Mice & Keyboards 57, Gaming Headsets 19, Controllers & Racing 16, Gaming Chairs & Desks 11, Handheld & Retro Consoles 8, Gaming Accessories 3, Mouse Pads & Accessories 2; 50 hand-listed on the parent) | 166 | Gaming Chairs & Desks quoted |
| Mobile & Wearables (Chargers & Cables 158, Smartwatches 84, Power Banks 35, Car Accessories 30, Smart Rings & Glasses 19, Phone Accessories 16, Trackers & Tags 10, Phones 3 — 10% markup) | 355 | normal |
| Audio (Earphones & Earbuds 155, Headphones 112, Speakers 76, Microphones & Karaoke 35, Soundbars & Hi-Fi 21, Audio Accessories 3) — new | 402 | heavy items quoted per product |
| Power & Electrical (Multiplugs & Surge Protection 110, Adaptors & Extension Leads 86, Switches, Sockets & Wiring 68, Batteries 19, Electrical Accessories 5) | 288 | normal |
| Home & Kitchen (Utensils & Gadgets 82, Food Storage & Drinkware 56, Cookware & Pans 37, Kitchen Appliances 35, Irons & Floor Care 27, Heating & Cooling 23, Home & Living 14) | 274 | normal |
| Baby & Toddler (Bottles & Teats 64, Feeding & Weaning 50, Dummies & Teethers 27, Maternity & Breastfeeding 26, Blankets & Swaddles 15, Wipes 15, Bath & Skin Care 14, Oral Care 13, Nappy & Changing Bags 12, Sterilising & Cleaning 12, Health & Safety 11, Baby Toys & Keepsakes 6, Hair Accessories 6) | 271 | normal |
| Bags & Laptop Cases (Laptop Bags & Backpacks 102, School & Everyday Backpacks 79, Lunch Bags & Bottles 33, Handbags, Purses & Wallets 20, Cable Organisers & Pouches 6) | 240 | normal |
| Smart Home & Lighting (Light Bulbs 92, Outdoor & Flood Lights 42, Lamps & Indoor Lighting 41, Smart Home 3; 48 hand-listed on the parent) | 226 | normal |
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

## Open items / backlog

- **Everfurn Theo Dining Table (White)** — Box 1 of 2 and Box 2 of 2 are **hidden**; each costs R65,219.99 from SMD. Owner to confirm the price with SMD; if genuine, merge into one product.
- **First real test order** (cheap item + refund) to prove ITN → Paid → emails end to end in live mode — not yet confirmed.
- **Photos**: SMD's embedded photos are ~113px; better photos should be uploaded for key products.
- **Weights**: supplier lists have none (default 1 kg). Heavy categories use delivery quotes; other large one-offs (e.g. filament maker, 10-roll filament dryer in 3D Upgrades) may need the per-product "delivery quoted" override.
- **Filament overlap with lapanza3d.co.za** — decided 2026-09-27: Procom lists SA Filament too.
- **Legal pages** (Terms, Privacy, Returns) written for SA law — should get a quick legal review.
- **SMD auto-lists done 2026-09-28** (Infant Essential 286, Cash Wholesale 2,481). Next month: import the new files, then run `node server/smd-autolist-cli.js` on the server (dry run) and `--apply` (see DEPLOY.md) -- the browser button can time out on the Cash list.
- **148 hand-listed products sit on parent categories** (Gaming 50, Networking 50, Smart Home & Lighting 48). Owner asked (2026-09-28) to move them into sub-categories: deploy, then `node server/smd-autolist-cli.js --tidy` (dry run) and `--tidy --apply`. Products the rules place under a different parent are reported and stay put.
- **3 products misfiled in Power & Electrical › Batteries** by the first Cash run (battery rule fixed since): ELL-6000-WT and ELL-6001-WT (Ellies wireless doorbells → Switches, Sockets & Wiring) and VK-50022-MMN (Volkano Mini Moon mood light → Smart Home & Lighting › Lamps & Indoor Lighting). Move by hand in Products.
- **Sub-category named like its parent**: Toys & Games › Toys & Games (10 items, slug `toys-games-2`) -- consider renaming (e.g. "Games & Novelties") in Admin → Categories.
- **Ask SMD**: Avalanche DB0008 and DB0009 are both "Bubble Buddy" at the same price. (The two Ellies TOSLINK cables priced ~R1.08m stay skipped -- owner: ignore.)
- **Heavy items**: 44 Cash Wholesale products marked delivery quoted (5 more heavy ones were already hand-listed and keep their setting). Medium items (20-30 m extension reels, single 8" party speakers, metal desk lamps), Totes Babe bags and the R3,900 Loop & Co display box still ship at the default 1 kg.
- **Server housekeeping**: `.env.bak-20260925*` files sit in the app directory; now gitignored (next deploy) but better moved out or deleted.
- Optional: register procompretoria.co.za and point it at the same site.
