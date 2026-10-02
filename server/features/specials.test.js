import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';

process.env.UPLOADS_DIR = path.join(os.tmpdir(), 'procom-test-uploads');
process.env.DISABLE_BACKUPS = '1';

const { useMemoryDb } = await import('../db.js');
const catalog = await import('../catalog.js');
const orders = await import('../orders.js');
const { updateSettings } = await import('../settings.js');
const specials = await import('./specials.js');
const { floorCents, floorContext, todaySast } = await import('./discount-common.js');
const finance = await import('./finance.js');
// These tests check special/promo mechanics against the cost-incl-VAT floor;
// Payfast fees are zeroed here and the fee floor has its own test below.
const noFees = (db) => finance.updateFinanceSettings({ payfastFees: { methods: finance.DEFAULT_PAYFAST_METHODS.map((m) => ({ key: m.key, pct: 0, fixedCents: 0 })) } }, db);


let db;
beforeEach(() => {
  db = useMemoryDb();
  noFees(db);
});

const catId = (slug) => db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug).id;
const parentOf = (slug) => db.prepare('SELECT parent_id p FROM categories WHERE slug = ?').get(slug).p;
const courierSmall = () => db.prepare("SELECT id FROM shipping_options WHERE name LIKE 'PUDO Small%'").get().id;
const customer = { firstName: 'Ann', lastName: 'Lee', email: 'ann@example.com', phone: '0821234567', addressLine1: '1 Main Rd', city: 'Pretoria', postalCode: '0081' };
const row = (id) => db.prepare('SELECT * FROM products WHERE id = ?').get(id);
const day = (offset) => todaySast(Date.now() + offset * 86400_000);

// Cost R100 excl VAT -> floor R115, price R127 at the default 10% markup.
function product(over = {}) {
  return catalog.saveProduct({ name: 'Test Mouse', brand: 'Logi', costCents: 10000, categoryId: catId('keyboards-mice'), weightG: 500, ...over });
}

test('cost floor is ceil(cost × 1.15) and follows the VAT setting', () => {
  assert.equal(floorCents(10000, 15), 11500);
  assert.equal(floorCents(7342, 15), 8444); // 8443.3 -> up
  updateSettings({ vatRatePct: 10 });
  const p = product();
  specials.saveSpecial({ targetType: 'product', targetId: p.id, kind: 'percent', percentOff: 50 });
  assert.equal(specials.specialPriceCents(row(p.id)), 11000);
});

test('percentage special rounds up to the rand and shows on the storefront', () => {
  const p = product();
  specials.saveSpecial({ label: 'Month-end special', targetType: 'product', targetId: p.id, kind: 'percent', percentOff: 5 });
  assert.equal(specials.specialPriceCents(row(p.id)), 12100); // 127 × 0.95 = 120.65 -> 121
  const pub = catalog.getProduct(p.id, { admin: false });
  assert.equal(pub.priceCents, 12100);
  assert.equal(pub.compareAtCents, 12700);
  assert.equal(pub.onSpecial, true);
  assert.equal(catalog.getProduct(p.id).priceCents, 12700, 'admin sees the normal price');
});

test('with Payfast fees on (default), the floor also covers the dearest fee', () => {
  db = useMemoryDb(); // fees as in the Payfast dashboard: dearest switched on = Debit Card 3.5% + R2, + VAT
  const ctx = floorContext(db);
  assert.equal(ctx.fee.name, 'Debit Card');
  // (R115 + R2.30) / (1 - 4.025%) = R122.22 -> 12222 cents
  assert.equal(floorCents(10000, ctx), 12222);
  assert.equal(floorCents(0, ctx), 0);
  const p = product(); // R127
  specials.saveSpecial({ label: 'Deep', targetType: 'product', targetId: p.id, kind: 'percent', percentOff: 20 });
  const sp = specials.specialPriceCents(row(p.id));
  assert.equal(sp, 12222, 'capped at the fee floor');
  const fee = Math.round((sp * 0.035 + 200) * 1.15);
  assert.ok(sp - fee >= 11500, 'after the Payfast fee the sale still covers cost incl VAT');
});

test('special never goes below cost incl VAT', () => {
  const p = product();
  specials.saveSpecial({ targetType: 'product', targetId: p.id, kind: 'percent', percentOff: 50 });
  assert.equal(specials.specialPriceCents(row(p.id)), 11500);
  const fixed = product({ sku: 'F1', name: 'Fixed' });
  specials.saveSpecial({ targetType: 'product', targetId: fixed.id, kind: 'price', price: '99' });
  assert.equal(specials.specialPriceCents(row(fixed.id)), 11500);
  const d = specials.specialDetails(row(fixed.id));
  assert.equal(d.capped, true);
  assert.equal(d.rawCents, 9900);
});

test('a special that would not lower the price is ignored (no price rise)', () => {
  const p = product();
  specials.saveSpecial({ targetType: 'product', targetId: p.id, kind: 'price', price: '150' });
  assert.equal(specials.specialPriceCents(row(p.id)), null);
  // Manual price below the floor: the floor would be a rise, so no special.
  const cheap = product({ sku: 'C1', name: 'Loss leader', priceMode: 'manual', price: '110' });
  specials.saveSpecial({ targetType: 'product', targetId: cheap.id, kind: 'percent', percentOff: 10 });
  assert.equal(specials.specialPriceCents(row(cheap.id)), null);
});

test('category special covers sub-categories; brand special matches case-insensitively', () => {
  const p = product();
  const other = product({ sku: 'O1', name: 'Other brand', brand: 'Acme', categoryId: catId('keyboards-mice') });
  specials.saveSpecial({ targetType: 'category', targetId: parentOf('keyboards-mice'), kind: 'percent', percentOff: 5 });
  assert.equal(specials.specialPriceCents(row(p.id)), 12100);
  assert.equal(specials.specialPriceCents(row(other.id)), 12100);
  db.prepare('DELETE FROM specials').run();
  specials.invalidateSpecials();
  specials.saveSpecial({ targetType: 'brand', targetId: 'logi', kind: 'percent', percentOff: 5 });
  assert.equal(specials.specialPriceCents(row(p.id)), 12100);
  assert.equal(specials.specialPriceCents(row(other.id)), null);
  assert.throws(() => specials.saveSpecial({ targetType: 'brand', targetId: 'Logi', kind: 'price', price: '100' }), /only possible for a single product/);
});

test('the best (lowest) running special wins', () => {
  const p = product({ costCents: 5000 }); // price 64, floor 57.50
  specials.saveSpecial({ targetType: 'brand', targetId: 'Logi', kind: 'percent', percentOff: 5 }); // 60.80 -> 61
  specials.saveSpecial({ targetType: 'product', targetId: p.id, kind: 'price', price: '60' });
  specials.saveSpecial({ targetType: 'category', targetId: catId('keyboards-mice'), kind: 'percent', percentOff: 2 });
  assert.equal(specials.specialPriceCents(row(p.id)), 6000);
});

test('date window and active flag', () => {
  const p = product();
  const s = specials.saveSpecial({ targetType: 'product', targetId: p.id, kind: 'percent', percentOff: 5, endsAt: day(-1) });
  assert.equal(s.state, 'ended');
  assert.equal(specials.specialPriceCents(row(p.id)), null);
  specials.saveSpecial({ targetType: 'product', targetId: p.id, kind: 'percent', percentOff: 5, startsAt: day(1) }, s.id);
  assert.equal(specials.specialPriceCents(row(p.id)), null);
  specials.saveSpecial({ targetType: 'product', targetId: p.id, kind: 'percent', percentOff: 5, startsAt: day(0), endsAt: day(0) }, s.id);
  assert.equal(specials.specialPriceCents(row(p.id)), 12100, 'start and end dates are inclusive');
  specials.saveSpecial({ targetType: 'product', targetId: p.id, kind: 'percent', percentOff: 5, active: false }, s.id);
  assert.equal(specials.specialPriceCents(row(p.id)), null);
  assert.throws(() => specials.saveSpecial({ targetType: 'product', targetId: p.id, kind: 'percent', percentOff: 5, startsAt: day(2), endsAt: day(1) }), /before the start/);
});

test('cache is reused between saves and invalidated on save/delete', () => {
  const p = product();
  const s = specials.saveSpecial({ targetType: 'product', targetId: p.id, kind: 'percent', percentOff: 5 });
  assert.equal(specials.specialPriceCents(row(p.id)), 12100);
  // A change behind the module's back is not seen until the cache refreshes...
  db.prepare('UPDATE specials SET percent_off = 8').run();
  assert.equal(specials.specialPriceCents(row(p.id)), 12100);
  // ...but saving through the module is seen immediately.
  specials.saveSpecial({ targetType: 'product', targetId: p.id, kind: 'percent', percentOff: 8 }, s.id);
  assert.equal(specials.specialPriceCents(row(p.id)), 11700); // 116.84 -> 117
  specials.deleteSpecial(s.id);
  assert.equal(specials.specialPriceCents(row(p.id)), null);
});

test('createOrder charges the special price', () => {
  const p = product();
  specials.saveSpecial({ targetType: 'product', targetId: p.id, kind: 'percent', percentOff: 5 });
  const o = orders.createOrder({ customer, shippingOptionId: courierSmall(), items: [{ productId: p.id, quantity: 2 }] });
  assert.equal(o.subtotalCents, 24200);
  assert.equal(o.totalCents, 24200 + o.shippingCents);
  assert.equal(o.items[0].unitPriceCents, 12100);
});

test('admin list counts affected and floor-capped products; preview shows prices', () => {
  const a = product(); // 127, floor 115
  product({ sku: 'B1', name: 'Thin margin', costCents: 11000 }); // 140, floor 126.50
  product({ sku: 'W1', name: 'Wide margin', markupPct: 40 }); // 161, floor 115
  const s = specials.saveSpecial({ targetType: 'brand', targetId: 'Logi', kind: 'percent', percentOff: 12 });
  const listed = specials.listSpecials().find((x) => x.id === s.id);
  assert.equal(listed.products, 3);
  assert.equal(listed.affected, 3);
  assert.equal(listed.capped, 2); // 127 -> 112 and 140 -> 124 are below their floors; 161 -> 142 is fine
  const prev = specials.specialImpact(db.prepare('SELECT * FROM specials WHERE id = ?').get(s.id), db);
  const item = prev.items.find((i) => i.id === a.id);
  assert.deepEqual([item.normalCents, item.requestedCents, item.floorCents, item.specialCents, item.capped], [12700, 11200, 11500, 11500, true]);
});

test('public list returns products on special, biggest saving first', () => {
  const small = product({ sku: 'S1', name: 'Small saving' });
  const big = product({ sku: 'B1', name: 'Big saving', costCents: 5000, markupPct: 40 });
  product({ sku: 'N1', name: 'Not on special', brand: 'Acme' });
  specials.saveSpecial({ targetType: 'product', targetId: small.id, kind: 'percent', percentOff: 3 });
  specials.saveSpecial({ targetType: 'product', targetId: big.id, kind: 'percent', percentOff: 20 });
  const res = specials.productsOnSpecial();
  assert.equal(res.total, 2);
  assert.deepEqual(res.rows, [big.id, small.id]);
});
