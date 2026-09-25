import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';

process.env.UPLOADS_DIR = path.join(os.tmpdir(), 'procom-test-uploads');
process.env.DISABLE_BACKUPS = '1';

const { useMemoryDb } = await import('./db.js');
const { parseFeedFile, guessMapping, detectFormat, pdfAsCards, mergeFragments } = await import('./feed-parsers.js');
const feed = await import('./feed.js');
const catalog = await import('./catalog.js');
const { parseRandToCents } = await import('./util.js');
const { isPrivateAddress } = await import('./remote-images.js');

let db;
let supplierId;
beforeEach(() => {
  db = useMemoryDb();
  supplierId = db.prepare('SELECT id FROM suppliers').get().id;
});

const buf = (s) => Buffer.from(s, 'utf8');
const items = async (name, text, mapping, opts) => feed.itemsFromTables(await parseFeedFile(name, buf(text)), mapping, opts);

// ---------------------------------------------------------------- detection

test('detects formats by content and extension', () => {
  assert.equal(detectFormat('x.bin', buf('%PDF-1.7')), 'pdf');
  assert.equal(detectFormat('list', buf('[{"a":1}]')), 'json');
  assert.equal(detectFormat('list', buf('<?xml version="1.0"?><a/>')), 'xml');
  assert.equal(detectFormat('list.csv', buf('a,b')), 'csv');
  assert.throws(() => detectFormat('old.xls', buf('\xD0\xCF')), /Save As/);
});

test('auto-maps common supplier headings', () => {
  const m = guessMapping(['Picture', 'Product Code', 'Name', 'Brand', 'Category', 'COST EXCL VAT']);
  assert.deepEqual([m.code, m.name, m.brand, m.category, m.cost], ['Product Code', 'Name', 'Brand', 'Category', 'COST EXCL VAT']);
  const m2 = guessMapping(['SKU', 'Title', 'Manufacturer', 'Dealer Price', 'Image URL']);
  assert.deepEqual([m2.code, m2.name, m2.brand, m2.cost, m2.image], ['SKU', 'Title', 'Manufacturer', 'Dealer Price', 'Image URL']);
});

// ---------------------------------------------------------------- CSV

test('CSV: semicolons, quotes, decimal commas, title rows above the header', async () => {
  const csv = 'SUPPLIER PRICE LIST SEPT\n\nStock Code;Description;Brand;Unit Price\nAB-1;"Mouse; wireless";Logi;R 1 299,50\nAB-2;Keyboard;Logi;99,00\n';
  const { items: out } = await items('list.csv', csv);
  assert.equal(out.length, 2);
  assert.deepEqual([out[0].code, out[0].name, out[0].costCents], ['AB-1', 'Mouse; wireless', 129950]);
  assert.equal(out[1].costCents, 9900);
});

test('CSV: VAT-inclusive prices are converted to excl. VAT', async () => {
  const { items: out } = await items('l.csv', 'code,name,price\nX1,Thing,115.00\n', undefined, { pricesIncludeVat: true, vatRatePct: 15 });
  assert.equal(out[0].costCents, 10000);
});

test('CSV: rows missing code/name/price are counted, not imported', async () => {
  const { items: out, problems } = await items('l.csv', 'code,name,price\n,No code,10\nX2,,10\nX3,No price,\nX4,Good,10\n');
  assert.equal(out.length, 1);
  assert.deepEqual(problems, { noCode: 1, noName: 1, noCost: 1 });
});

test('manual mapping overrides auto-detection; blank mapping ignores a column', async () => {
  const csv = 'id,label,retail,trade\nZ1,Widget,500,300\n';
  const { items: out } = await items('l.csv', csv, { code: 'id', name: 'label', cost: 'trade', brand: '' });
  assert.equal(out[0].costCents, 30000);
});

// ---------------------------------------------------------------- JSON / XML

test('JSON: finds the product array anywhere and flattens nested fields', async () => {
  const json = JSON.stringify({ meta: { count: 2 }, data: { products: [
    { sku: 'J1', title: 'Router', pricing: { cost: '450.00' }, brand: { name: 'TP-Link' }, images: ['https://cdn.example.com/j1.jpg'] },
    { sku: 'J2', title: 'Switch', pricing: { cost: 300 }, brand: { name: 'TP-Link' } },
  ] } });
  const parsed = await parseFeedFile('feed.json', buf(json));
  const { items: out } = feed.itemsFromTables(parsed, { code: 'sku', name: 'title', cost: 'pricing.cost', brand: 'brand.name', image: 'images' });
  assert.equal(out.length, 2);
  assert.deepEqual([out[0].code, out[0].brand, out[0].costCents, out[0].imageUrl], ['J1', 'TP-Link', 45000, 'https://cdn.example.com/j1.jpg']);
  assert.equal(out[1].costCents, 30000);
});

test('XML: repeated elements and attributes become rows', async () => {
  const xml = `<?xml version="1.0"?><catalog><product code="X-1"><name>Headset</name><brand>Accutone</brand><price>399.00</price></product>
    <product code="X-2"><name>Cable</name><brand>Accutone</brand><price>49.99</price></product></catalog>`;
  const { items: out } = await items('feed.xml', xml);
  assert.deepEqual(out.map((i) => [i.code, i.name, i.costCents]), [['X-1', 'Headset', 39900], ['X-2', 'Cable', 4999]]);
});

test('XML: external entities are not resolved (no XXE)', async () => {
  const xml = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r><p><code>A1</code><name>&x;</name><price>1</price></p><p><code>A2</code><name>ok</name><price>1</price></p></r>`;
  const parsed = await parseFeedFile('x.xml', buf(xml)).catch((e) => ({ error: e.message }));
  const text = JSON.stringify(parsed);
  assert.ok(!/root:/.test(text), 'file contents must never appear');
});

// ---------------------------------------------------------------- PDF

test('PDF flyer: pairs each code with the price below it in the same column', () => {
  const seg = (x, y, s, w = s.length * 5) => ({ x, y, w, h: 10, s });
  const rows = pdfAsCards([
    seg(116, 3960, 'P1503CVA-C38512G0W'), seg(361, 3961, 'P1503CVA-C516512G0W'),
    seg(80, 3936, 'Asus ExpertBook P1503'), seg(327, 3937, 'Asus Expertbook P1503 Laptop'),
    seg(146, 3884, 'R8 299.00'), seg(390, 3885, 'R10 999.00'),
    seg(151, 3851, 'BUY NOW'), seg(398, 3852, 'BUY NOW'),
  ]);
  assert.deepEqual(rows, [
    ['P1503CVA-C516512G0W', 'Asus Expertbook P1503 Laptop', 'Asus', 'R10 999.00'],
    ['P1503CVA-C38512G0W', 'Asus ExpertBook P1503', 'Asus', 'R8 299.00'],
  ]);
  assert.equal(parseRandToCents('R10 999.00'), 1099900);
});

test('PDF text repair: split ligatures are rejoined', () => {
  const it = (x, s, w) => ({ x, y: 100, w, h: 10, s });
  const out = mergeFragments([it(0, 'Dallas Co', 45), it(45.5, 'ff', 6), it(51.8, 'ee Table', 35), it(200, 'Lotus Floa\u0000ng', 60)]);
  assert.deepEqual(out.map((s) => s.s).sort(), ['Dallas Coffee Table', 'Lotus Floating']);
});

// ---------------------------------------------------------------- import

test('import via preview token; flyer-style partial imports never mark products out', async () => {
  const full = 'code,name,price\nP1,One,100\nP2,Two,200\n';
  await feed.importFile({ supplierId, fileName: 'full.csv', buffer: buf(full) });
  const f2 = db.prepare("SELECT id FROM feed_items WHERE code='P2'").get().id;
  feed.listFeedItems({ feedIds: [f2] });
  // Partial list without P2, NOT marked complete -> P2 stays in stock.
  await feed.importFile({ supplierId, fileName: 'promo.csv', buffer: buf('code,name,price\nP1,One,90\n'), completeList: false });
  const p2 = db.prepare("SELECT supplier_in_stock FROM products WHERE supplier_code='P2'").get();
  assert.equal(p2.supplier_in_stock, 1);
  // Complete list without P2 -> out of stock.
  const r = await feed.importFile({ supplierId, fileName: 'full.csv', buffer: buf('code,name,price\nP1,One,90\n'), completeList: true });
  assert.equal(r.productsMarkedOut, 1);
});

test('partial (flyer) imports update only the cost of known items', async () => {
  await feed.importFile({ supplierId, fileName: 'full.csv', buffer: buf('code,name,brand,category,price\nF1,Lotus Floating Shelf,Fenda,Furniture,200\n') });
  await feed.importFile({ supplierId, fileName: 'flyer.csv', buffer: buf('code,name,brand,price\nF1,Lotus Floating Shelf - Set,Lotus,150\nF9,New Promo Item,Lotus,50\n'), completeList: false });
  const f1 = db.prepare("SELECT name, brand, category, cost_cents FROM feed_items WHERE code='F1'").get();
  assert.deepEqual(f1, { name: 'Lotus Floating Shelf', brand: 'Fenda', category: 'Furniture', cost_cents: 15000 });
  assert.ok(db.prepare("SELECT 1 FROM feed_items WHERE code='F9'").get(), 'new flyer items are still added');
});

test('deleting an import removes only its unlisted, untouched items', async () => {
  await feed.importFile({ supplierId, fileName: 'test.csv', buffer: buf('code,name,price\nD1,Listed,10\nD2,Unlisted,10\nD3,Updated later,10\n') });
  const imp = db.prepare("SELECT id FROM feed_imports WHERE file_name='test.csv'").get();
  feed.listFeedItems({ feedIds: [db.prepare("SELECT id FROM feed_items WHERE code='D1'").get().id] });
  await feed.importFile({ supplierId, fileName: 'other.csv', buffer: buf('code,name,price\nD3,Updated later,12\n') });
  const r = feed.deleteImport(imp.id);
  const codes = db.prepare('SELECT code FROM feed_items ORDER BY code').all().map((x) => x.code);
  assert.deepEqual(codes, ['D1', 'D3']); // D1 listed, D3 owned by the newer import
  assert.equal(r.itemsDeleted, 1);
  assert.equal(r.itemsKeptBecauseListed, 1);
  assert.ok(db.prepare("SELECT 1 FROM products WHERE supplier_code='D1'").get(), 'listed product untouched');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM feed_imports WHERE id = ?').get(imp.id).n, 0);
});

test('re-import reprices listed products from the new cost', async () => {
  await feed.importFile({ supplierId, fileName: 'a.csv', buffer: buf('code,name,price\nQ1,Thing,100\n') });
  feed.listFeedItems({ feedIds: [db.prepare("SELECT id FROM feed_items WHERE code='Q1'").get().id] });
  const before = db.prepare("SELECT price_cents FROM products WHERE supplier_code='Q1'").get().price_cents;
  const r = await feed.importFile({ supplierId, fileName: 'a.csv', buffer: buf('code,name,price\nQ1,Thing,200\n') });
  const after = db.prepare("SELECT price_cents FROM products WHERE supplier_code='Q1'").get().price_cents;
  assert.equal(r.priceChanges, 1);
  assert.equal(before, 12700);
  assert.equal(after, 25300); // 200 x 1.15 x 1.10 = 253
  assert.ok(catalog);
});

test('photo URLs are queued as pending downloads', async () => {
  process.env.NO_IMAGE_WORKER = '1';
  const r = await feed.importFile({ supplierId, fileName: 'a.csv', buffer: buf('code,name,price,image url\nI1,Thing,10,https://example.com/i1.jpg\nI2,Other,10,not-a-url\n') });
  assert.equal(r.imagesQueued, 1);
  const row = db.prepare("SELECT image_url FROM feed_items WHERE code='I1'").get();
  assert.equal(row.image_url, 'https://example.com/i1.jpg');
});

// ---------------------------------------------------------------- safety

test('image downloader refuses private and internal addresses', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fd00::1', '0.0.0.0']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['41.222.36.147', '8.8.8.8', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
});
