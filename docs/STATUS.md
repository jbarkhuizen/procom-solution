# Status & backlog

_Last updated: 2026-09-27_

## Live state

- **Site:** https://www.procomsolutions.co.za — live, taking real payments (Payfast **live**, Lapanza's merchant account)
- **Email:** working (Gmail SMTP as procompretoria@gmail.com); test email confirmed 2026-09-25
- **Admin account:** created by the owner
- **Live products:** 1,397

| Category | Live | Delivery |
|---|---|---|
| Computers & Peripherals | 168 | normal |
| Networking | 50 | normal |
| Gaming | 50 | normal |
| Smart Home & Lighting | 48 | normal |
| Mobile & Wearables (Trackers & Tags) | 4 | normal |
| Home & Kitchen (Kitchen Appliances 35, Cookware & Pans 37, Utensils & Gadgets 82, Food Storage & Drinkware 55, Heating & Cooling 20, Irons & Floor Care 27, Home & Living 14) | 270 | normal |
| 3D Printing (13 sub-categories: printers, scanners, engravers, filament, resin, parts) | 474 | quoted for FDM/Resin printers + Laser Engravers |
| Furniture (Desks & Office Chairs, Tables, Shelving & Storage, Seating & Living) | 186 | quoted |
| Luggage & Travel (Suitcases, Luggage Sets & Business Trolleys) | 103 | quoted |
| Health & Beauty (Hair Care, Personal Care & Wellness) | 44 | normal |
| Baby & Toddler (13 sub-categories) + Toys & Games, Health & Wellness | _pending: run the Infant Essential auto-list after deploy (286 items)_ | normal |
| Cash Wholesale: Audio, Cameras & Photography, TV & Video, Office & School (new) + sub-categories under existing categories | _pending: run the Cash Wholesale auto-list after deploy (up to 2,791 items, minus those already listed)_ | Gaming Chairs & Desks quoted; 49 heavy items quoted per product |

**Suppliers:** SMD (Warehouse), Esquire, IDS, Huge PC, Dicspeed. All imports so far are SMD's
(Cash wholesale, Home and Beyond, Infant Essential, Creality list, two promo flyers).

**Imported files (all rows imported):**
- SMD Home and Beyond (609 rows, 11 brand tabs + Index): all 609 listed; 168 bulk items sold in their minimum quantity
- Creality wholesale list (474 usable of 475; 1 priced "TBC"): all listed under 3D Printing
- SMD Infant Essential September 2026 (286 rows, 6 brand tabs): auto-list button merged (PR #1); run it on live after deploy

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
- **Infant Essential**: after deploying, re-import the September file if needed, then Warehouse feed → Auto-list SMD Infant Essential. Check: Avalanche DB0008 and DB0009 are both "Bubble Buddy" at the same price (ask SMD what differs); Totes Babe bags and the R3,900 Loop & Co display box use the default 1 kg weight.
- **Cash wholesale** (September 2026: 3,315 rows, 34 brand tabs): after deploying, import the file and run Auto-list SMD Cash Wholesale. In the preview, check the "categories that will be created" list against the live tree (especially 3D Printing › Filament). 23 rows are always skipped: 7 display stands at R0.01, 2 Ellies TOSLINK cables priced ~R1.08m (ask SMD), 8 junk rows, 6 refurbished printers/consumables.
- **Heavy items**: 49 Cash Wholesale items are marked delivery quoted automatically. Medium items (e.g. 20-30 m extension reels, single 8" party speakers, desk lamps) still ship at the default 1 kg; adjust per product if couriers charge more.
- **Hand-listed products** keep their existing delivery setting; the auto-list doesn't mark them heavy.
- Optional: register procompretoria.co.za and point it at the same site.
