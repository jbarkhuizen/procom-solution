import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';

process.env.UPLOADS_DIR = path.join(os.tmpdir(), 'procom-test-uploads');
process.env.DISABLE_BACKUPS = '1';

const { useMemoryDb } = await import('../db.js');
const catalog = await import('../catalog.js');
const report = await import('../sync-report.js');
const pd = await import('./pricedrops.js');

let db;
beforeEach(() => {
  db = useMemoryDb();
});

const smdId = () => db.prepare("SELECT id FROM suppliers WHERE name LIKE 'SMD%'").get().id;
const mk = (sku, price, over = {}) => {
  const p = catalog.saveProduct({ name: `Item ${sku}`, sku, supplierId: smdId(), supplierCode: sku, costCents: Math.round(price / 1.265), ...over }, null, db);
  db.prepare('UPDATE products SET price_cents = ? WHERE id = ?').run(price, p.id);
  return p.id;
};
const set = (id, fields) => {
  const cols = Object.keys(fields);
  db.prepare(`UPDATE products SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`).run({ ...fields, id });
};
// One supplier sync: change something, diff it, record the drops.
function sync(change, at = Date.now()) {
  const before = report.snapshotPrices(smdId(), db);
  change();
  return pd.recordPriceDrops(report.diffPrices(before, smdId(), db), db, at);
}
const listed = () => pd.publicDrops({}, db).items.map((i) => i.sku);

test('a qualifying drop goes on the page; small drops (under 5% or under R10) do not', () => {
  const big = mk('BIG', 100000); // R1,000
  const smallPct = mk('PCT', 1000000); // R10,000: -R300 is 3%
  const smallRand = mk('RAND', 10000); // R100: -R6 is 6% but under R10
  const r = sync(() => {
    set(big, { price_cents: 90000 }); // -10%, -R100
    set(smallPct, { price_cents: 970000 });
    set(smallRand, { price_cents: 9400 });
  });
  assert.equal(r.added, 1);
  assert.deepEqual(listed(), ['BIG']);
  const item = pd.publicDrops({}, db).items[0];
  assert.deepEqual([item.drop.wasCents, item.drop.nowCents, item.drop.changeCents, item.drop.changePct], [100000, 90000, 10000, 10]);
});

test('the drop leaves the page the moment the price is back up (no sync needed) and a later drop starts fresh', () => {
  const id = mk('UP', 100000);
  sync(() => set(id, { price_cents: 90000 }));
  assert.deepEqual(listed(), ['UP']);
  set(id, { price_cents: 100000 }); // e.g. an admin edit between two API runs
  assert.deepEqual(listed(), [], 'gone at once');
  assert.deepEqual(pd.liveDropIds([id], db), new Set());
  // the next sync closes it; a new drop is a new row with the new "was"
  sync(() => set(id, { price_cents: 100000 }));
  assert.equal(db.prepare('SELECT ended_reason FROM price_drops').get().ended_reason, 'back_to_normal');
  sync(() => set(id, { price_cents: 80000 }));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM price_drops').get().n, 2);
  assert.equal(pd.publicDrops({}, db).items[0].drop.wasCents, 100000);
});

test('a drop that only partly recovers stays with the smaller drop; below the minimum it goes', () => {
  const id = mk('PART', 100000);
  sync(() => set(id, { price_cents: 90000 }));
  set(id, { price_cents: 94000 }); // -6%, -R60: still a drop
  assert.equal(pd.publicDrops({}, db).items[0].drop.changePct, 6);
  set(id, { price_cents: 97000 }); // -3%: below the minimum
  assert.deepEqual(listed(), []);
});

test('dropping again inside the window keeps the original price it was and restarts the window; after expiry it starts fresh', () => {
  const id = mk('TWICE', 100000);
  const threeDaysAgo = Date.now() - 3 * 86400_000;
  sync(() => set(id, { price_cents: 90000 }), threeDaysAgo);
  const r = sync(() => set(id, { price_cents: 80000 }));
  assert.deepEqual([r.updated, r.added], [1, 0]);
  let item = pd.publicDrops({}, db).items[0];
  assert.deepEqual([item.drop.wasCents, item.drop.nowCents], [100000, 80000]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM price_drops').get().n, 1);

  const other = mk('LATE', 100000);
  sync(() => set(other, { price_cents: 90000 }), Date.now() - 8 * 86400_000);
  assert.ok(!listed().includes('LATE'), 'an 8 day old drop is expired');
  const r2 = sync(() => set(other, { price_cents: 80000 }));
  assert.deepEqual([r2.closed, r2.added], [1, 1], 'the expired drop is closed and the new one starts from the price before it');
  item = pd.publicDrops({}, db).items.find((i) => i.sku === 'LATE');
  assert.deepEqual([item.drop.wasCents, item.drop.nowCents], [90000, 80000]);
});

test('expired drops go; pinned ones stay; hidden ones never show', () => {
  const a = mk('OLD', 100000);
  const b = mk('PIN', 100000);
  const c = mk('HID', 100000);
  const old = Date.now() - 8 * 86400_000;
  sync(() => [a, b, c].forEach((id) => set(id, { price_cents: 90000 })), old);
  assert.deepEqual(listed(), [], 'all three are 8 days old');
  const rows = db.prepare('SELECT id, product_id FROM price_drops').all();
  const rowOf = (pid) => rows.find((r) => r.product_id === pid).id;
  pd.setDropFlags(rowOf(b), { pinned: true }, db);
  assert.deepEqual(listed(), ['PIN']);
  pd.setDropFlags(rowOf(b), { hidden: true }, db);
  assert.deepEqual(listed(), []);
  assert.equal(pd.setDropFlags([rowOf(b)], { hidden: false }, db), 1);
  assert.deepEqual(listed(), ['PIN']);
  sync(() => {}); // a sync closes the expired ones for good
  assert.deepEqual(db.prepare('SELECT ended_reason FROM price_drops WHERE ended_at IS NOT NULL').all().map((r) => r.ended_reason), ['expired', 'expired']);
  void c;
});

test('sold-out drops stay on the page (greyed) after the in-stock ones; the cart only flags live ones', () => {
  const a = mk('IN', 100000);
  const b = mk('OUT', 100000);
  sync(() => {
    set(a, { price_cents: 90000 });
    set(b, { price_cents: 50000 });
  });
  set(b, { supplier_in_stock: 0 });
  const items = pd.publicDrops({}, db).items;
  assert.deepEqual(items.map((i) => [i.sku, i.drop.soldOut]), [['IN', false], ['OUT', true]], 'sold out comes last even with the bigger drop');
  assert.deepEqual([...pd.liveDropIds([a, b], db)], [a]);
});

test('the page can be switched off; settings are validated', () => {
  const id = mk('SW', 100000);
  sync(() => set(id, { price_cents: 90000 }));
  pd.saveDropSettings({ on: false }, db);
  const res = pd.publicDrops({}, db);
  assert.equal(res.on, false);
  assert.equal(res.items.length, 0);
  assert.deepEqual(pd.saveDropSettings({ on: true, minPct: 20, minRand: 50, days: 3 }, db), { on: true, minPct: 20, minRand: 50, days: 3 });
  assert.deepEqual(listed(), [], '10% is under the new 20% minimum');
  assert.throws(() => pd.saveDropSettings({ minPct: 'abc' }, db));
});

test('admin list: supplier prices next to mine, Payfast fee, profit, floor and history', () => {
  const id = mk('ADM', 1580000); // R15,800
  sync(() => set(id, { price_cents: 1404000, cost_cents: 1110000 }));
  const { items, settings } = pd.adminDrops(db);
  assert.equal(settings.days, 7);
  const r = items[0];
  assert.equal(r.state, 'live');
  assert.deepEqual([r.wasCents, r.nowCents, r.changeCents, r.changePct], [1580000, 1404000, -176000, -11]);
  assert.equal(r.costNowCents, 1110000);
  assert.equal(r.costNowIncVatCents, Math.round(1110000 * 1.15));
  assert.ok(r.costChangeCents < 0 && r.costWasCents > r.costNowCents);
  assert.ok(r.feeCents > 0);
  assert.equal(r.profitCents, r.nowCents - r.costNowIncVatCents - r.feeCents);
  assert.ok(r.floorCents > r.costNowIncVatCents && r.floorCents < r.nowCents, 'floor = cost incl VAT + Payfast fee');
  assert.ok(r.expiresAt > r.updatedAt);
  set(id, { price_cents: 1580000 });
  assert.equal(pd.adminDrops(db).items[0].state, 'back_to_normal', 'history shows why it ended');
});

test('a sync with no drops still closes the drops that ended', () => {
  const id = mk('CL', 100000);
  sync(() => set(id, { price_cents: 90000 }));
  set(id, { price_cents: 100000 });
  const r = pd.recordPriceDrops({ priceDown: [] }, db);
  assert.equal(r.closed, 1);
});
