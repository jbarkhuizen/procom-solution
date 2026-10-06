import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';

process.env.UPLOADS_DIR = path.join(os.tmpdir(), 'procom-test-uploads');
process.env.DISABLE_BACKUPS = '1';

const { useMemoryDb } = await import('./db.js');
const catalog = await import('./catalog.js');
const report = await import('./sync-report.js');

let db;
beforeEach(() => {
  db = useMemoryDb();
});

const smdId = () => db.prepare("SELECT id FROM suppliers WHERE name LIKE 'SMD%'").get().id;
const mk = (sku, over = {}) => catalog.saveProduct({ name: `Item ${sku}`, sku, supplierId: smdId(), supplierCode: sku, costCents: 10000, ...over }, null, db);
const set = (sku, fields) => {
  const cols = Object.keys(fields);
  db.prepare(`UPDATE products SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE sku = @sku`).run({ ...fields, sku });
};

test('diff: went on special, price reduced, price increased, special ended, newly listed', () => {
  for (const s of ['SPEC', 'DOWN', 'UP', 'ENDED', 'SAME']) mk(s);
  set('ENDED', { price_cents: 10000, compare_at_cents: 12700 });
  const before = report.snapshotPrices(smdId(), db);

  set('SPEC', { price_cents: 10200, compare_at_cents: 12700 }); // R127 -> R102 on special
  set('DOWN', { price_cents: 11500 }); // cost came down
  set('UP', { price_cents: 13000 });
  set('ENDED', { price_cents: 12700, compare_at_cents: null });
  mk('NEW');
  const d = report.diffPrices(before, smdId(), db);

  assert.deepEqual(d.newSpecials.map((x) => [x.sku, x.normalCents, x.specialCents]), [['SPEC', 12700, 10200]]);
  assert.deepEqual(d.priceDown.map((x) => [x.sku, x.fromCents, x.toCents]).sort(), [['DOWN', 12700, 11500], ['SPEC', 12700, 10200]]);
  assert.equal(d.priceDown[0].sku, 'SPEC', 'biggest drop first');
  assert.equal(d.priceUp, 2, 'UP and ENDED (back to the normal price)');
  assert.equal(d.specialsEnded, 1);
  assert.equal(d.newlyListed, 1);
});

test('Word overview: a real .docx with the summary and both lists; file name in SA time', async () => {
  const buf = await report.buildSyncReportDocx({
    supplierLabel: 'SMD',
    startedAt: '2026-10-05T10:30:00.000Z',
    ok: true,
    summaryRows: [['Costs lowered', 3]],
    changes: { newSpecials: [{ sku: 'A1', name: 'Mouse', normalCents: 12700, specialCents: 10200 }], priceDown: [{ sku: 'B1', name: 'Cable', fromCents: 5000, toCents: 4500 }], priceUp: 0, specialsEnded: 0, newlyListed: 0 },
  });
  assert.ok(Buffer.isBuffer(buf) && buf.length > 2000);
  assert.equal(buf.subarray(0, 2).toString(), 'PK', 'docx is a zip');
  assert.match(buf.toString('latin1'), /word\/document\.xml/);
  assert.equal(report.reportFileName('SMD', '2026-10-05T10:30:00.000Z'), 'SMD-update-2026-10-05-1230.docx');
  const failed = await report.buildSyncReportDocx({ supplierLabel: 'Esquire', startedAt: '2026-10-05T04:00:00.000Z', ok: false, error: 'login failed' });
  assert.equal(failed.subarray(0, 2).toString(), 'PK');
});

test('diff: stock, hidden, shown, new products carry category and recent sales; special-ended rises are marked', () => {
  const cat = db.prepare("INSERT INTO categories (id, name, slug, created_at, updated_at) VALUES ('c1', 'Backpacks', 'backpacks', 'x', 'x')").run();
  assert.ok(cat);
  for (const s of ['OUT', 'BACK', 'HID', 'SHOW', 'ENDED']) mk(s, { categoryId: 'c1' });
  set('BACK', { supplier_in_stock: 0, supplier_stock_qty: 0 });
  set('SHOW', { active: 0 });
  set('OUT', { supplier_stock_qty: 7 });
  set('ENDED', { price_cents: 10000, compare_at_cents: 12700 });
  const before = report.snapshotPrices(smdId(), db);
  const ids = Object.fromEntries(db.prepare('SELECT sku, id FROM products').all().map((r) => [r.sku, r.id]));
  db.prepare("INSERT INTO orders (id, order_number, status, payment_status, payment_method, first_name, email, phone, paid_at, created_at, updated_at) VALUES ('o1', 'PC1', 'paid', 'paid', 'card', 'A', 'a@b.c', '1', ?, ?, ?)").run(new Date().toISOString(), 'x', 'x');
  for (const sku of ['OUT', 'HID']) db.prepare("INSERT INTO order_items (id, order_id, product_id, sku, name, fulfilment, unit_price_cents, quantity, line_total_cents) VALUES (?, 'o1', ?, ?, 'n', 'dropship', 100, 3, 300)").run(`i${sku}`, ids[sku], sku);

  set('OUT', { supplier_in_stock: 0 });
  set('BACK', { supplier_in_stock: 1, supplier_stock_qty: 40 });
  set('HID', { active: 0 });
  set('SHOW', { active: 1 });
  set('ENDED', { price_cents: 12700, compare_at_cents: null });
  mk('NEW', { categoryId: 'c1' });
  const d = report.diffPrices(before, smdId(), db);

  assert.deepEqual(d.outOfStock.map((x) => [x.sku, x.qty, x.sold30, x.category]), [['OUT', 7, 3, 'Backpacks']]);
  assert.deepEqual(d.backInStock.map((x) => [x.sku, x.qty]), [['BACK', 40]]);
  assert.deepEqual(d.hidden.map((x) => [x.sku, x.sold30]), [['HID', 3]]);
  assert.deepEqual(d.shown.map((x) => x.sku), ['SHOW']);
  assert.deepEqual(d.newProducts.map((x) => x.sku), ['NEW']);
  assert.equal(d.priceUpList[0].specialEnded, true);
  assert.equal(d.specialsEndedList[0].sku, 'ENDED');
});

test('attention: owner levels (drop over 50%, rise over 15%, hidden or out of stock with recent sales)', () => {
  const x = (sku, from, to, more = {}) => ({ sku, name: sku, fromCents: from, toCents: to, ...more });
  const c = {
    priceDown: [x('D1', 1000, 400), x('D2', 1000, 600)], // 60% (flag), 40% (fine)
    priceUpList: [x('U1', 1000, 1200), x('U2', 1000, 1100), x('U3', 1000, 1500, { specialEnded: true })], // 20% (flag), 10%, special ended
    hidden: [{ sku: 'H1', name: 'H1', sold30: 2 }, { sku: 'H2', name: 'H2', sold30: 0 }],
    outOfStock: [{ sku: 'O1', name: 'O1', sold30: 1 }, { sku: 'O2', name: 'O2', sold30: 0 }],
  };
  const a = report.buildAttention(c);
  assert.deepEqual(a.map((i) => i.level), ['red', 'amber', 'red', 'amber']);
  assert.match(a[0].text, /^1 shop price dropped by more than 50%/);
  assert.match(a[1].text, /^1 shop price rose by more than 15%/);
  assert.match(a[2].text, /^1 hidden product sold/);
  assert.match(a[3].text, /^1 product that sold/);
  assert.deepEqual(report.buildAttention(null), []);
  assert.deepEqual(report.buildAttention({ priceDown: [], priceUpList: [], hidden: [], outOfStock: [] }), []);
});

test('merge: products that flip out and back in during the day are marked; down then up nets out', () => {
  const p = (sku, o = {}) => ({ sku, name: sku, category: 'c', ...o });
  const run1 = { newSpecials: [], priceDown: [p('A', { fromCents: 100, toCents: 80 })], priceUp: 0, specialsEnded: 0, newlyListed: 0, priceUpList: [], outOfStock: [p('F', { qty: 5, sold30: 0 })], backInStock: [], hidden: [], shown: [], newProducts: [], specialsEndedList: [] };
  const run2 = { ...run1, priceDown: [], priceUp: 1, priceUpList: [p('A', { fromCents: 80, toCents: 100 })], outOfStock: [], backInStock: [p('F', { qty: 9 })] };
  const m = report.mergeChanges([run1, run2]);
  assert.deepEqual(m.unstable.map((x) => x.sku), ['F']);
  assert.equal(m.priceDown.length + m.priceUpList.length, 0);
  assert.equal(m.priceUp, 0);
});

test('Word report: attention box, last-run column, section headings, links; old runs without the new lists still build', async () => {
  const buf = await report.buildSyncReportDocx({
    supplierLabel: 'SMD', startedAt: '2026-10-06T04:30:00.000Z', ok: true, seconds: 4,
    summaryRows: [['Shop prices went up', 88]], previousRows: [['Shop prices went up', 12]],
    changes: { newSpecials: [], priceDown: [{ id: 'p1', sku: 'QT-1', name: 'Quest Bag', slug: 'quest-bag', category: 'Backpacks', fromCents: 39300, toCents: 12600 }], priceUp: 0, specialsEnded: 0, newlyListed: 0 },
    notListed: [['Audio', 1]], details: [['Started by', 'Schedule']],
  });
  const text = buf.toString('latin1');
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  const { default: JSZip } = await import('jszip');
  const xml = await (await JSZip.loadAsync(buf)).file('word/document.xml').async('string');
  for (const s of ['Needs your attention', 'dropped by more than 50%', 'Last run', 'Price changes', 'Stock', 'Listing changes', 'Run details', 'Supplier products not in the shop yet']) assert.ok(xml.includes(s), s);
  assert.ok(text.length > 1000);
  const rels = await (await JSZip.loadAsync(buf)).file('word/_rels/document.xml.rels').async('string');
  assert.match(rels, /product\.html\?p=quest-bag/);
  assert.match(rels, /admin\/#\/products\/p1/);
});
