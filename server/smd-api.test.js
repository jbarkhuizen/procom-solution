import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import sharp from 'sharp';

process.env.UPLOADS_DIR = path.join(os.tmpdir(), 'procom-test-uploads');
process.env.DISABLE_BACKUPS = '1';
process.env.NO_IMAGE_WORKER = '1';
process.env.VAULT_KEY = 'test-vault-key-0123456789';

const { useMemoryDb } = await import('./db.js');
const catalog = await import('./catalog.js');
const orders = await import('./orders.js');
const smd = await import('./smd-api.js');
const { nextRunAt } = await import('./esquire.js');
const { storeProductImage } = await import('./images.js');

let db;
let smdId;
beforeEach(() => {
  db = useMemoryDb();
  smdId = db.prepare("SELECT id FROM suppliers WHERE name LIKE 'SMD%'").get().id;
  catalog.saveSupplier({ name: 'SMD (Warehouse)', apiToken: 'tok', apiKey: 'key' }, smdId, db);
});

// A fake SMD API: 2 rows per page; prices uses SMD's "numberOfPage" spelling.
function fakeSmd(data, seen = []) {
  return async (url, opts) => {
    seen.push({ url: String(url), headers: opts.headers });
    const ep = url.pathname.split('/').pop();
    const rows = data[ep] || [];
    const page = Number(url.searchParams.get('page'));
    const pages = Math.max(1, Math.ceil(rows.length / 2));
    return { ok: true, status: 200, json: async () => ({ data: rows.slice((page - 1) * 2, page * 2), [ep === 'prices' ? 'numberOfPage' : 'numberOfPages']: pages }) };
  };
}
const price = (Sku, excl, special = '0.00') => ({ Sku, ProductCode: Sku, PriceExcl: excl, PriceIncl: '0', PriceRRp: '9999.00', SpecialPriceExcl: special });
const prod = (Sku, extra = {}) => ({ Sku, Name: `Item ${Sku}`, ShortDescription: `Item ${Sku}`, LongDescription: `Long text for ${Sku}.`, Category: 'Electrical/Surge Protection', Brand: 'Ellies', ...extra });
const listed = (code, over = {}) => catalog.saveProduct({ name: `Item ${code}`, supplierId: smdId, supplierCode: code, costCents: 10000, ...over }, null, db);
const row = (code) => db.prepare('SELECT * FROM products WHERE supplier_code = ?').get(code);
const run = (data, opts = {}) => smd.syncSmd({ email: false, fetchImpl: fakeSmd(data), ...opts }, db);

test('fetch: sends both auth headers, follows every page (either page-count spelling), 404 explains itself', async () => {
  const seen = [];
  const cat = await smd.fetchSmdCatalogue({ db, fetchImpl: fakeSmd({ products: [prod('A'), prod('B'), prod('C')], prices: [price('A', '1.00'), price('B', '2.00'), price('C', '3.00')], stock: [], media: [] }, seen) });
  assert.equal(cat.products.size, 3);
  assert.equal(cat.prices.size, 3, 'page 2 of prices fetched although it says numberOfPage');
  assert.equal(seen[0].headers.Authorization, 'Bearer tok');
  assert.equal(seen[0].headers.ClientAccessKey, 'key');
  const r = await smd.syncSmd({ email: false, fetchImpl: async () => ({ ok: false, status: 404 }) }, db);
  assert.match(r.error, /404.*API token and Client access key/);
});

test('API access is stored encrypted and never listed', () => {
  const raw = db.prepare('SELECT api_token_enc FROM suppliers WHERE id = ?').get(smdId).api_token_enc;
  assert.match(raw, /^v1:/);
  const s = catalog.listSuppliers(db).find((x) => x.id === smdId);
  assert.equal(s.hasApiToken, true);
  assert.ok(!JSON.stringify(s).includes('tok'));
  assert.deepEqual(smd.smdAccess(db), { token: 'tok', key: 'key' });
});

test('a connection check reports but changes nothing', async () => {
  listed('A');
  const before = JSON.stringify(row('A'));
  const r = await run({ products: [prod('A'), prod('NEW')], prices: [price('A', '150.00'), price('NEW', '20.00')], stock: [{ Sku: 'A', SOH: 0 }], media: [] }, { check: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.stats.costUp, 1);
  assert.equal(r.stats.markedOut, 1);
  assert.equal(r.stats.newSkus, 1);
  assert.equal(JSON.stringify(row('A')), before);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM feed_items WHERE code = 'NEW'").get().n, 0);
});

test('costs, SMD specials shown as Sale, and the special ending', async () => {
  listed('A');
  let r = await run({ products: [prod('A')], prices: [price('A', '100.00', '80.00')], stock: [], media: [] });
  assert.equal(r.ok, true, r.error);
  let p = row('A');
  assert.equal(p.cost_cents, 8000, 'special cost is the cost');
  assert.equal(p.price_cents, 10200); // R80 x 1.15 x 1.10 = R101.20 -> R102
  assert.equal(p.compare_at_cents, 12700, 'normal price struck through');
  assert.equal(p.special_by_feed, 1);
  assert.deepEqual(r.changes.newSpecials.map((x) => [x.normalCents, x.specialCents]), [[12700, 10200]], 'report: went on special');
  assert.equal(r.changes.priceDown.length, 1, 'report: price reduced');
  r = await run({ products: [prod('A')], prices: [price('A', '100.00')], stock: [], media: [] });
  p = row('A');
  assert.equal(p.cost_cents, 10000);
  assert.equal(p.price_cents, 12700);
  assert.equal(p.compare_at_cents, null);
  assert.equal(r.stats.specialsEnded, 1);
});

test('stock: out at 0 or below the pack size, back when restocked, admin choice kept, "only N left", checkout limit', async () => {
  listed('A');
  listed('B');
  listed('PACK', { minOrderQty: 6 });
  catalog.saveProduct({ supplierInStock: false }, row('B').id, db); // admin: out (supplier phoned)
  const data = (a, b, pack) => ({ products: [], prices: [price('A', '100.00'), price('B', '100.00'), price('PACK', '10.00')], stock: [{ Sku: 'A', SOH: a }, { Sku: 'B', SOH: b }, { Sku: 'PACK', SOH: pack }], media: [] });
  await run(data(0, 50, 4));
  assert.equal(row('A').supplier_in_stock, 0);
  assert.equal(row('PACK').supplier_in_stock, 0, '4 left but sold in 6s');
  assert.equal(row('B').supplier_in_stock, 0, 'admin choice kept');
  await run(data(3, 50, 60));
  assert.equal(row('A').supplier_in_stock, 1);
  assert.equal(row('PACK').supplier_in_stock, 1);
  assert.equal(row('B').supplier_in_stock, 0);
  const pub = catalog.queryProducts({ q: 'Item A' }, db).items.find((x) => x.name === 'Item A');
  assert.equal(pub.stockLeft, 3);
  assert.equal(catalog.queryProducts({ q: 'PACK' }, db).items[0].stockLeft, null, '10 packs: plenty');
  assert.equal(catalog.queryProducts({ q: 'PACK' }, db).items[0].stockOnHand, 10, 'stock on hand in packs (60 units / 6)');
  assert.equal(catalog.queryProducts({ q: 'PACK' }, db).items[0].stockMax, 60, 'quantity box limit in units');
  assert.equal(pub.stockOnHand, 3);
  const customer = { firstName: 'Ann', lastName: 'Lee', email: 'ann@example.com', phone: '0821234567', addressLine1: '1 Main Rd', city: 'Pretoria', postalCode: '0081' };
  assert.throws(() => orders.createOrder({ customer, delivery: { [smdId]: 'courier' }, items: [{ productId: row('A').id, quantity: 4 }] }, db), /Only 3/);
});

test('descriptions fill blanks only; unknown SKUs go to Warehouse feed; categories never change', async () => {
  const cat = catalog.saveCategory({ name: 'Mine' }, null, db);
  listed('A', { categoryId: cat.id });
  listed('B', { description: 'My own words' });
  await run({ products: [prod('A'), prod('B'), prod('NEW')], prices: [price('A', '100.00'), price('B', '100.00'), price('NEW', '20.00')], stock: [], media: [] });
  assert.equal(row('A').description, 'Long text for A.');
  assert.equal(row('B').description, 'My own words');
  assert.equal(row('A').category_id, cat.id);
  const f = db.prepare("SELECT * FROM feed_items WHERE code = 'NEW'").get();
  assert.equal(f.source_file, smd.SMD_API_FILE);
  assert.equal(f.category, 'Electrical/Surge Protection');
  assert.equal(f.cost_cents, 2000);
});

test('pack size: listed products follow the SMD name ( Order in Qty of 12)', async () => {
  listed('MUG');
  listed('ONE');
  const r = await run({ products: [prod('MUG', { Name: 'Snappy Mug 473ml ( Order in Qty of 12)' }), prod('ONE')], prices: [price('MUG', '40.00'), price('ONE', '40.00')], stock: [{ Sku: 'MUG', SOH: 240 }, { Sku: 'ONE', SOH: 5 }], media: [] });
  assert.equal(r.stats.packSizes, 1);
  assert.equal(row('MUG').min_order_qty, 12);
  assert.equal(row('ONE').min_order_qty, 1, 'no pack in the name: unchanged');
});

test('products missing from the API are hidden (owner rule), shown again when back; very many missing are left alone', async () => {
  for (const c of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K']) listed(c);
  catalog.saveProduct({ active: false }, row('K').id, db); // admin hid K by hand
  const nine = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'].map((c) => price(c, '100.00'));
  let r = await run({ products: [], prices: nine, stock: [], media: [] });
  assert.equal(r.stats.hidden, 1, 'J not in the API: hidden (K was already hidden by the admin)');
  assert.equal(row('J').active, 0);
  assert.equal(row('J').hidden_by_feed, 1);
  assert.ok(!catalog.queryProducts({ q: 'Item J', pageSize: 100 }, db).items.some((p) => p.id === row('J').id), 'not on the shop');
  catalog.saveProduct({ name: 'Item J renamed' }, row('J').id, db);
  assert.equal(row('J').hidden_by_feed, 1, 'an unrelated admin edit keeps the feed hiding it');

  r = await run({ products: [], prices: [...nine, price('J', '100.00'), price('K', '100.00')], stock: [], media: [] });
  assert.equal(r.stats.unhidden, 1);
  assert.equal(row('J').active, 1, 'back in the API: shown again');
  assert.equal(row('K').active, 0, 'hidden by the admin: stays hidden');

  r = await run({ products: [], prices: ['A', 'B', 'C', 'D', 'E', 'F'].map((c) => price(c, '100.00')), stock: [], media: [] });
  assert.equal(r.stats.missingNotMarked, true, 'many more missing at once: API response looks incomplete');
  assert.equal(r.stats.hidden, 0);
  assert.equal(row('G').active, 1, 'left alone');
  r = await run({ products: [], prices: [price('A', '100.00')], stock: [], media: [] });
  assert.equal(r.ok, false, 'far fewer prices than last run: skipped');
});

test('photos: tiny spreadsheet thumbnails are replaced; admin photos never', async () => {
  const img = (px) => sharp({ create: { width: px, height: px, channels: 3, background: '#888' } }).png().toBuffer();
  const thumb = await storeProductImage(await img(110));
  const big = await storeProductImage(await img(800));
  listed('THUMB');
  listed('MINE');
  listed('EDITED');
  db.prepare('UPDATE products SET images = ? WHERE supplier_code = ?').run(JSON.stringify([thumb]), 'THUMB');
  db.prepare('UPDATE products SET images = ? WHERE supplier_code = ?').run(JSON.stringify([big]), 'MINE');
  catalog.saveProduct({ images: [big] }, row('EDITED').id, db); // admin changed photos -> images_from_feed = 0
  const media = ['THUMB', 'MINE', 'EDITED'].flatMap((s) => [{ Sku: s, Url: `https://nucleus.example/${s}/0.jpg`, Type: 'Image', OrderWeight: 1 }, { Sku: s, Url: `https://nucleus.example/${s}/1.jpg`, Type: 'Image', OrderWeight: 2 }]);
  const r = await run({ products: [], prices: ['THUMB', 'MINE', 'EDITED'].map((s) => price(s, '100.00')), stock: [], media });
  assert.equal(r.stats.photoSets, 2, 'EDITED is not even queued');
  const photo = await img(900);
  await smd.startMediaDownloads(db, { download: async () => photo });
  assert.equal(JSON.parse(row('THUMB').images).length, 2);
  assert.equal(row('THUMB').images_from_feed, 1);
  assert.deepEqual(JSON.parse(row('MINE').images), [big], 'unknown origin but full size: kept');
  assert.equal(row('MINE').images_from_feed, 0);
  assert.deepEqual(JSON.parse(row('EDITED').images), [big]);
  // Same photo set next run: nothing queued again.
  const again = await run({ products: [], prices: ['THUMB', 'MINE', 'EDITED'].map((s) => price(s, '100.00')), stock: [], media });
  assert.equal(again.stats.photoSets, 0);
});

test('SMD runs 30 minutes after Esquire', () => {
  const slots = [{ h: 6, m: 30 }, { h: 12, m: 30 }, { h: 18, m: 30 }];
  assert.equal(nextRunAt(new Date('2026-09-29T10:05:00Z'), slots).toISOString(), '2026-09-29T10:30:00.000Z'); // 12:05 SAST -> 12:30
  assert.equal(nextRunAt(new Date('2026-09-29T16:45:00Z'), slots).toISOString(), '2026-09-30T04:30:00.000Z'); // 18:45 -> 06:30
  assert.deepEqual(smd.syncTimes(), ['06:30', '12:30', '18:30']);
});

test('new SMD products: pack size from the name, listed only when auto-list is on, never once withdrawn', async () => {
  const { updateSettings } = await import('./settings.js');
  const data = (withB = true) => ({
    products: [prod('LNL-1', { Name: 'LocknLock Storage Box ( Order in Qty of 12 )', Category: 'Kitchen and Home/Storage' }), prod('B', { Category: 'Audio/Bluetooth Speakers' })].filter((p) => withB || p.Sku !== 'B'),
    prices: [price('LNL-1', '20.00'), ...(withB ? [price('B', '100.00')] : [])],
    stock: [],
    media: [],
  });
  let r = await run(data());
  assert.equal(db.prepare("SELECT min_order_qty m FROM feed_items WHERE code = 'LNL-1'").get().m, 12);
  assert.equal(r.autoListOn, false);
  assert.equal(r.autoList.summary.reduce((n, g) => n + g.newListings, 0), 2, 'report says what would be listed');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM products').get().n, 0);

  updateSettings({ smdApiAutoList: true }, db);
  r = await run(data(false)); // B withdrawn by SMD before auto-list was switched on
  assert.equal(r.autoList.created, 1);
  const p = row('LNL-1');
  assert.equal(p.name, 'LocknLock Storage Box', 'quantity note removed from the shop title');
  assert.equal(p.min_order_qty, 12);
  assert.equal(db.prepare('SELECT c.name FROM categories c WHERE c.id = ?').get(p.category_id).name, 'Food Storage & Drinkware');
  assert.equal(row('B'), undefined, 'withdrawn SKU not listed');
});

test('SMD API category rules: placement follows the earlier SMD decisions', async () => {
  const { classifyItem } = await import('./smd-autolist.js');
  const at = (category, name = 'x') => {
    const c = classifyItem('smdapi', { category, name });
    return c?.skip ? `skip` : c && `${c.parent} › ${c.sub}`;
  };
  assert.equal(at('Devices/Storage/SSD', 'ARES ARMOR DDR4 PC3200 16GB-DESKTOP'), 'Computers & Peripherals › PC Components');
  assert.equal(at('Devices/Storage/SSD', 'Kingston A400 480GB SSD'), 'Computers & Peripherals › Storage & Memory');
  assert.equal(at('Devices/3D Printers/Filament', 'SA Filament PETG Black 1kg'), '3D Printing › Filament – PETG');
  assert.equal(at('Furniture/Chairs/Gaming chairs'), 'Gaming › Gaming Chairs & Desks');
  assert.equal(at('Bags/Duffle Bags'), 'Luggage & Travel › Travel Bags & Accessories');
  assert.equal(at('Smart Home/Smart Cameras/Outdoor'), 'Smart Home & Lighting › Smart Home');
  assert.equal(at('Devices', 'MTP03HX/A iPhone 15 128GB'), 'Mobile & Wearables › Phones');
  assert.equal(at('Fashion and beauty/Sunglasses'), 'skip');
  assert.equal(at('Display Unit'), 'skip');
});

test('SMD specials appear on the Specials page, and leave it when the special ends', async () => {
  const { productsOnSpecial } = await import('./features/specials.js');
  listed('A');
  listed('B');
  await run({ products: [], prices: [price('A', '100.00', '80.00'), price('B', '100.00')], stock: [], media: [] });
  let sp = productsOnSpecial({}, db);
  assert.deepEqual(sp.rows, [row('A').id]);
  await run({ products: [], prices: [price('A', '100.00'), price('B', '100.00')], stock: [], media: [] });
  sp = productsOnSpecial({}, db);
  assert.equal(sp.total, 0);
});

test('Specials page quick filter: counts per top-level category, filter includes sub-categories', async () => {
  const { productsOnSpecial } = await import('./features/specials.js');
  const audio = catalog.saveCategory({ name: 'Audio Top' }, null, db);
  const buds = catalog.saveCategory({ name: 'Buds', parentId: audio.id }, null, db);
  const home = catalog.saveCategory({ name: 'Home Top' }, null, db);
  listed('A', { categoryId: buds.id });
  listed('B', { categoryId: buds.id });
  listed('C', { categoryId: home.id });
  await run({ products: [], prices: ['A', 'B', 'C'].map((c) => price(c, '100.00', '50.00')), stock: [], media: [] });
  const all = productsOnSpecial({}, db);
  assert.equal(all.total, 3);
  assert.deepEqual(all.categories.map((c) => [c.name, c.count]), [['Audio Top', 2], ['Home Top', 1]]);
  const onlyAudio = productsOnSpecial({ category: audio.slug }, db);
  assert.equal(onlyAudio.total, 2, 'parent includes its sub-categories');
  assert.equal(onlyAudio.allTotal, 3);
  assert.equal(onlyAudio.category.name, 'Audio Top');
  assert.equal(productsOnSpecial({ category: buds.slug }, db).total, 2);
});
