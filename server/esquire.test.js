import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';

process.env.UPLOADS_DIR = path.join(os.tmpdir(), 'procom-test-uploads');
process.env.DISABLE_BACKUPS = '1';
process.env.NO_IMAGE_WORKER = '1';

const { useMemoryDb } = await import('./db.js');
const esquire = await import('./esquire.js');
const catalog = await import('./catalog.js');
const { classifyItem } = await import('./smd-autolist.js');
const { updateSettings } = await import('./settings.js');

let db;
let supplierId;
beforeEach(() => {
  db = useMemoryDb();
  supplierId = catalog.saveSupplier({ name: 'Esquire' }, null, db).id;
});

// Shaped like the real API rows; prices include VAT.
const rec = (code, price, extra = {}) => ({
  productName: `Product ${code}`,
  productCode: code,
  category: 'Cable: HDMI',
  productSummary: `Summary of ${code}, retail box.`,
  price,
  availableQty: 'yes',
  image: '',
  status: 1,
  ...extra,
});
const sync = (records) => esquire.syncEsquire({ records, email: false }, db);
const product = (code) => db.prepare('SELECT * FROM products WHERE supplier_code = ?').get(code);
const feedItem = (code) => db.prepare('SELECT * FROM feed_items WHERE code = ?').get(code);

test('only active rows with a code and a price are imported', () => {
  const rows = [rec('A', 115), rec('B', 50, { status: 0 }), rec('', 20), rec('C', 0), null];
  assert.deepEqual(esquire.sellableRecords(rows).map((r) => r.productCode), ['A']);
});

test('groups we never sell are left out of the import', async () => {
  const r = await sync([rec('A', 115), rec('K', 50, { category: 'Scented Candles' }), rec('F', 500, { category: 'Air Fryers' })]);
  assert.equal(feedItem('K'), undefined);
  assert.ok(feedItem('F'));
  assert.deepEqual(r.leftOut, [{ reason: 'Candles, balloons and party', n: 1 }]);
});

test('prices are stored excl VAT and the summary becomes the description when listed', async () => {
  const r = await sync([rec('A', 115), rec('B', 3.000005)]);
  assert.equal(r.ok, true, r.error);
  assert.equal(feedItem('A').cost_cents, 10000);
  assert.equal(feedItem('B').cost_cents, 261); // R2.6087 excl VAT
  assert.equal(feedItem('A').details, 'Summary of A, retail box.');
  // Auto-list is off by default: nothing listed, but the report says what would be.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM products').get().n, 0);
  assert.equal(r.autoList.summary.find((g) => g.category === 'Computers & Peripherals › Cables & Adaptors').newListings, 2);

  updateSettings({ esquireAutoList: true }, db);
  const r2 = await sync([rec('A', 115), rec('B', 3.000005)]);
  assert.equal(r2.autoList.created, 2);
  assert.equal(product('A').description, 'Summary of A, retail box.');
  assert.equal(product('A').price_cents, 12700); // R100 x 1.15 x 1.10 = R126.50 -> R127
});

test('items leaving the feed go out of stock and come back; an admin choice is kept', async () => {
  updateSettings({ esquireAutoList: true }, db);
  const others = ['D', 'E', 'F'].map((c) => rec(c, 115));
  await sync([rec('A', 115), rec('B', 115), rec('C', 115), ...others]);
  // Admin marks C out of stock by hand (supplier phoned).
  catalog.saveProduct({ supplierInStock: false }, product('C').id, db);

  const r = await sync([rec('C', 115), rec('B', 115, { status: 0 }), ...others]); // A gone, B inactive
  assert.equal(r.import.productsMarkedOut, 2);
  assert.equal(product('A').supplier_in_stock, 0);
  assert.equal(product('B').supplier_in_stock, 0);

  // An unrelated admin edit keeps the feed's claim on A.
  catalog.saveProduct({ name: 'Renamed A' }, product('A').id, db);

  const back = await sync([rec('A', 115), rec('B', 115), rec('C', 115), ...others]);
  assert.equal(back.import.productsBackInStock, 2);
  assert.equal(product('A').supplier_in_stock, 1);
  assert.equal(product('B').supplier_in_stock, 1);
  assert.equal(product('C').supplier_in_stock, 0, 'admin marked C out of stock -- stays out');
});

test('a feed far smaller than last time is refused without changing anything', async () => {
  updateSettings({ esquireAutoList: true }, db);
  await sync(['A', 'B', 'C', 'D'].map((c) => rec(c, 115)));
  const r = await sync([rec('A', 230)]);
  assert.equal(r.ok, false);
  assert.match(r.error, /only 1 products/);
  assert.equal(product('B').supplier_in_stock, 1);
  assert.equal(feedItem('A').cost_cents, 10000);
  assert.equal(esquire.esquireStatus(db).lastRun.ok, false);
});

test('a failed fetch is reported, never thrown, and hides the password', async () => {
  process.env.ESQUIRE_USER = 'someone@example.com';
  process.env.ESQUIRE_PASS = 'secret-pass';
  try {
    const r = await esquire.syncEsquire({ email: false, fetchImpl: async () => ({ ok: false, status: 401 }) }, db);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'Esquire answered HTTP 401');
    let calledWith = '';
    const r2 = await esquire.syncEsquire({ email: false, fetchImpl: async (url) => { calledWith = String(url); throw new TypeError('fetch failed'); } }, db);
    assert.match(calledWith, /p=secret-pass/);
    assert.match(calledWith, /m=0/, 'no Esquire-side markup');
    assert.equal(r2.error, 'Could not reach Esquire (fetch failed)');
  } finally {
    delete process.env.ESQUIRE_USER;
    delete process.env.ESQUIRE_PASS;
  }
});

test('the login comes from Admin -> Suppliers -> Esquire (encrypted); .env wins when set', async () => {
  process.env.VAULT_KEY = 'test-vault-key-0123456789';
  assert.equal(esquire.esquireConfigured(db), false);
  assert.equal(esquire.esquireLogin(db), null);
  const pw = `t-${Math.random().toString(36).slice(2)}`;
  catalog.saveSupplier({ name: 'Esquire', portalUsername: 'shop@example.com', portalPassword: pw }, supplierId, db);
  assert.equal(esquire.esquireConfigured(db), true);
  let url = '';
  await esquire.syncEsquire({ email: false, fetchImpl: async (u) => { url = String(u); return { ok: false, status: 401 }; } }, db);
  assert.equal(new URL(url).searchParams.get('u'), 'shop@example.com');
  assert.equal(new URL(url).searchParams.get('p'), pw);
  process.env.ESQUIRE_USER = 'env@example.com';
  process.env.ESQUIRE_PASS = 'env-pass';
  try {
    assert.equal(esquire.esquireLogin(db).source, 'env');
  } finally {
    delete process.env.ESQUIRE_USER;
    delete process.env.ESQUIRE_PASS;
  }
});

test('without a login a run says where to enter it', async () => {
  const r = await esquire.syncEsquire({ email: false }, db);
  assert.equal(r.ok, false);
  assert.match(r.error, /Admin → Suppliers → Esquire/);
});

test('soundbars are heavy (delivery quoted), also once already listed -- unless set by hand', async () => {
  const { ESQUIRE_LIST } = await import('./esquire-rules.js');
  const heavy = (n) => ESQUIRE_LIST.heavy.test(n);
  assert.ok(heavy('Hisense HS5100 540w 5.1ch Soundbar'));
  assert.ok(heavy('LG S40T 2.1ch 300w Soundbar with Wireless Subwoofer'));
  assert.ok(heavy('Hisense HT Saturn 4.1.2 Channel Home Theatre System'));
  assert.ok(!heavy('OBlanc SHELL Subwoofer Headphones with USB Charging'));
  assert.ok(!heavy('HTPNEO H80 4K FHD Smart Home Theatre Projector'));
  assert.ok(!heavy('Soundbar wall mount bracket'));

  updateSettings({ esquireAutoList: true }, db);
  const bars = ['S1', 'S2', 'S3'].map((c) => rec(c, 1150, { category: 'Bluetooth SoundBars', productName: `Brand ${c} 2.1 Channel Soundbar` }));
  await sync(bars);
  assert.equal(product('S1').quote_delivery, 1, 'new listing marked');
  // Listed before the rule existed (NULL) vs an admin's explicit "never quote" (0).
  db.prepare("UPDATE products SET quote_delivery = NULL WHERE supplier_code IN ('S1', 'S2')").run();
  db.prepare("UPDATE products SET quote_delivery = 0 WHERE supplier_code = 'S3'").run();
  const r = await sync(bars);
  assert.equal(r.autoList.quoted, 2);
  assert.equal(product('S1').quote_delivery, 1);
  assert.equal(product('S2').quote_delivery, 1);
  assert.equal(product('S3').quote_delivery, 0, 'admin choice kept');
});

test('next run is the earliest SAST slot after now', () => {
  const at = (iso) => esquire.nextRunAt(new Date(iso), [6, 12, 18]).toISOString();
  assert.equal(at('2026-09-29T03:00:00Z'), '2026-09-29T04:00:00.000Z'); // 05:00 SAST -> 06:00
  assert.equal(at('2026-09-29T10:00:00Z'), '2026-09-29T16:00:00.000Z'); // 12:00 SAST exactly -> 18:00
  assert.equal(at('2026-09-29T17:00:00Z'), '2026-09-30T04:00:00.000Z'); // 19:00 SAST -> next morning
  assert.equal(esquire.nextRunAt(new Date('2026-09-29T21:30:00Z'), [0, 12]).toISOString(), '2026-09-29T22:00:00.000Z'); // midnight SAST
});

test('Esquire categories map onto the store tree', () => {
  const c = (category, name = 'x') => classifyItem('esquire', { category, name });
  const where = (category) => {
    const r = c(category);
    return r?.skip ? `skip: ${r.skip}` : r && `${r.parent} › ${r.sub}`;
  };
  assert.equal(where('Cable: HDMI'), 'Computers & Peripherals › Cables & Adaptors');
  assert.equal(where('Business Range Notebook'), 'Computers & Peripherals › Laptops & Tablets');
  assert.equal(where('Notebook Bags and Cases'), 'Bags & Laptop Cases › Laptop Bags & Backpacks');
  assert.equal(where('Gaming Mice'), 'Gaming › Gaming Mice & Keyboards');
  assert.equal(where('Wireless Mouse'), 'Computers & Peripherals › Keyboards & Mice');
  assert.equal(where('Surface Switches'), 'Power & Electrical › Switches, Sockets & Wiring');
  assert.equal(where('Photo Paper A4'), 'Computers & Peripherals › Ink & Toner');
  assert.equal(where('Printer Ribbons'), 'Computers & Peripherals › Ink & Toner');
  assert.equal(where('Multi-Function Stylus Pen'), 'Computers & Peripherals › Computer Accessories');
  assert.equal(where('Monitor Brackets'), 'Computers & Peripherals › Laptop & Monitor Stands');
  assert.equal(where('CCTV (Dome Camera)'), 'Networking › Security Cameras');
  assert.equal(where('Hard Disk (Surveillance)'), 'Computers & Peripherals › Storage & Memory');
  assert.deepEqual(c('Televisions- Smart Ultra HD'), { parent: 'TV & Video', sub: 'Televisions', quote: true, insurance: 3 });
  assert.equal(where('Samsung S4 Covers'), 'skip: Old phone, iPad and iPod covers');
  assert.equal(where('Scented Candles'), 'skip: Candles, balloons and party');
  assert.equal(where('Ballpoint Pens'), 'skip: Stationery and art');
  assert.equal(where('Air Fryers'), 'Home & Kitchen › Kitchen Appliances');
  assert.deepEqual(c('Washing Machines'), { parent: 'Home & Kitchen', sub: 'Large Appliances', quote: true });
  assert.equal(where('Hair Dryers'), 'Health & Beauty › Hair Care');
  assert.equal(where('Chair Bags'), 'Home & Kitchen › Home & Living');
});
