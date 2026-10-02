// One-off: applies the owner's pricing decisions of 2026-09-30 to the live DB.
//
//   node server/pricing-2026-09-30-cli.js            dry run (changes nothing)
//   node server/pricing-2026-09-30-cli.js --apply    backs up the DB, then applies
//
// 1. Delivery covers the Payfast fee: SMD courier R150 -> R157 (cost to us stays
//    R150); Esquire weight brackets R150/R220/R300 -> R157/R229/R313 (cost stays).
// 2. Minimum profit per item (Site settings, default R10): reprice every
//    auto-priced product so cheap items sell for at least cost incl VAT + R10.
// 3. Raise 20 products that were far cheaper than every competitor to 5% under
//    the next store (only where 2+ stores confirmed it, price check 2026-09-29),
//    by pinning each product's markup -- it stays auto-priced, so it still
//    follows SMD's cost changes.
import { getDb } from './db.js';
import { backupsDir } from './paths.js';
import { listSuppliers, saveSupplier, saveProduct, repriceProducts } from './catalog.js';
import { listShippingOptions, saveShippingOption } from './shipping.js';
import { getSettings } from './settings.js';

// SKU -> target price (rand): 5% under the next store, price check 2026-09-29.
const TARGETS = {
  "4008020067": 9499, // Creality Intelligent Dual Filter Air Pur (was R8728, next store R9999.9)
  "960-001437": 1219, // Brio 300 Full HD Webcam - Graphite (was R1051, next store R1284)
  "RE300": 569, // TP-Link RE300 AC1200 Wi-Fi Range Extende (was R488, next store R599)
  "3302020089": 574, // Creality LCD Resin 1Kg Grey (was R506, next store R605)
  "LS1008G": 350, // TP-Link LS1008G LiteWave 8-Port Gigabit  (was R304, next store R369)
  "VK-5600-BK": 1244, // Volkano 19.5" TN Monitor with HDMI/VGA,  (was R1201, next store R1309.62)
  "ARCHER-TX20UH": 616, // TP-Link Archer TX20UH AX1800 High Gain W (was R577, next store R649)
  "4007010251": 655, // Falcon Removable Build Plate For T1 (was R619, next store R690)
  "ZE-UB610MKII-ENC-RU": 916, // UB610MKII Binaural ENC Headset (was R885, next store R964.62)
  "3301010300": 308, // CR-PLA Filament Matte Strawberry Red, 1K (was R279, next store R325)
  "TL-WPA4221-KIT": 1000, // TP-Link TL-WPA4221 KIT AV600 Powerline W (was R977, next store R1053.35)
  "AM-10019-GR": 350, // Amplify Cuba 15.6" Laptop Backpack Grey (was R329, next store R369)
  "SAF-ABSPRE-A02": 246, // SA Filament ABS Premium Filament 1kg - B (was R228, next store R259)
  "SAF-ABSPRE-A10": 246, // SA Filament ABS Premium Filament 1kg - P (was R228, next store R259)
  "DF-DK352PLUS-BLACK": 1329, // darkFlash Computer Case DK352 Plus - Bla (was R1316, next store R1399)
  "CREALITY-HICOMBO": 9499, // Creality Hi Combo 260x260x300mm (was R9487, next store R9999)
  "910-005809": 322, // G102 Lightsync Gaming Mouse - White (was R310, next store R339)
  "3301010122": 236, // Ender PLA Black Filament 1Kg (was R228, next store R249)
  "3301020058": 308, // Creality Hyper ABS Filament Pink (was R304, next store R325)
  "3301010574": 407, // Hyper PLA RFID Stardust Sparkle Blue 1Kg (was R405, next store R429)
};

const apply = process.argv.includes('--apply');
const db = getDb();
const lines = [];
const say = (s) => lines.push(s);

async function main() {
  if (apply) {
    const file = `${backupsDir()}/pre-pricing-2026-09-30-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
    await db.backup(file);
    say(`Backup: ${file}`);
  }

  // 1a. SMD flat courier fee
  const smd = listSuppliers(db).find((s) => /^SMD/i.test(s.name));
  if (!smd) throw new Error('SMD supplier not found');
  say(`SMD courier: customer R${smd.deliveryFeeCents / 100} -> R157, cost to us R${(smd.deliveryCostCents ?? smd.deliveryFeeCents) / 100} -> R150`);
  if (apply) saveSupplier({ name: smd.name, deliveryFee: '157', deliveryCost: '150' }, smd.id, db);

  // 1b. Store-wide courier brackets (used by Esquire)
  const NEW = { 15000: 15700, 22000: 22900, 30000: 31300 };
  for (const o of listShippingOptions({}, db).filter((x) => x.active && x.optionType === 'auto_weight')) {
    const to = NEW[o.priceCents];
    if (!to) {
      say(`  bracket "${o.name}" R${o.priceCents / 100}: not R150/R220/R300 -- left alone`);
      continue;
    }
    say(`  bracket "${o.name}" ${o.minWeight}-${o.maxWeight ?? '∞'} g: R${o.priceCents / 100} -> R${to / 100} (cost to us R${o.priceCents / 100})`);
    if (apply) saveShippingOption({ price: String(to / 100), cost: String(o.priceCents / 100) }, o.id, db);
  }

  // 3. Raises (before the reprice so the reprice uses the pinned markups)
  const vat = 1 + (Number(getSettings(db).vatRatePct) || 15) / 100;
  let raised = 0;
  for (const [sku, target] of Object.entries(TARGETS)) {
    const p = db.prepare('SELECT * FROM products WHERE sku = ?').get(sku);
    if (!p) { say(`  raise ${sku}: not found -- skipped`); continue; }
    if (!p.active) { say(`  raise ${sku}: hidden -- skipped`); continue; }
    if (p.price_mode !== 'auto' || !(p.cost_cents > 0)) { say(`  raise ${sku}: manual price or no cost -- skipped`); continue; }
    // Largest markup whose rounded-up price does not pass the target.
    const markup = Math.floor(((target * 100) / (p.cost_cents * vat) - 1) * 10000) / 100;
    if (target * 100 <= p.price_cents) { say(`  raise ${sku}: already R${p.price_cents / 100} >= R${target} -- skipped`); continue; }
    say(`  raise ${p.name.slice(0, 46)}: R${p.price_cents / 100} -> about R${target} (markup ${markup}%)`);
    raised++;
    if (apply) saveProduct({ markupPct: markup }, p.id, db);
  }

  // 2. Minimum profit: reprice everything auto-priced
  const before = new Map(db.prepare("SELECT id, price_cents FROM products WHERE price_mode = 'auto'").all().map((r) => [r.id, r.price_cents]));
  let changed = 0;
  if (apply) {
    changed = repriceProducts({}, db);
  } else {
    const minCents = Math.round((Number(getSettings(db).minProfitRand) || 0) * 100);
    for (const r of db.prepare("SELECT id, cost_cents, price_cents FROM products WHERE price_mode = 'auto' AND cost_cents > 0").all()) {
      const floor = Math.ceil((r.cost_cents * vat + minCents) / 100) * 100;
      if (floor > r.price_cents) changed++;
    }
  }
  say(`Minimum profit R${getSettings(db).minProfitRand}: ${changed} auto-priced products ${apply ? 'repriced' : 'would go up'} (of ${before.size})`);
  say(`Raises: ${raised} products`);
  console.log((apply ? 'APPLIED\n' : 'DRY RUN (nothing changed)\n') + lines.join('\n'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
