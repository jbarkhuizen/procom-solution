import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';

process.env.UPLOADS_DIR = path.join(os.tmpdir(), 'procom-test-uploads');
process.env.DISABLE_BACKUPS = '1';

const { useMemoryDb } = await import('../db.js');
const catalog = await import('../catalog.js');
const orders = await import('../orders.js');
const promos = await import('./promos.js');
const specials = await import('./specials.js');
const { todaySast } = await import('./discount-common.js');

let db;
beforeEach(() => {
  db = useMemoryDb();
});

const catId = (slug) => db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug).id;
const courierSmall = () => db.prepare("SELECT id FROM shipping_options WHERE name LIKE 'PUDO Small%'").get().id;
const customer = { firstName: 'Ann', lastName: 'Lee', email: 'ann@example.com', phone: '0821234567', addressLine1: '1 Main Rd', city: 'Pretoria', postalCode: '0081' };
const day = (offset) => todaySast(Date.now() + offset * 86400_000);

// Cost R100 excl VAT -> floor R115, price R127 at the default 10% markup.
function product(over = {}) {
  return catalog.saveProduct({ name: 'Test Mouse', brand: 'Logi', costCents: 10000, categoryId: catId('keyboards-mice'), weightG: 200, ...over });
}
const code = (over = {}) => promos.savePromo({ code: 'save5', kind: 'percent', percentOff: 5, ...over });
const order = (items, over = {}) => orders.createOrder({ customer, shippingOptionId: courierSmall(), items, ...over });
const paidOrder = (items, over = {}) => {
  const o = order(items, over);
  orders.markOrderPaid(o.id);
  return o;
};
const check = (c, items, email) => promos.checkPromo({ code: c, items, email });

test('empty code changes nothing', () => {
  assert.deepEqual(promos.priceAdjustments({ items: [], subtotalCents: 0, promoCode: '' }), { discountCents: 0, promoCode: '' });
});

test('percent code: case-insensitive, normalised, and createOrder total reflects it', () => {
  const p = product();
  const saved = code();
  assert.equal(saved.code, 'SAVE5');
  const o = order([{ productId: p.id, quantity: 2 }], { promoCode: ' Save5 ' });
  assert.equal(o.subtotalCents, 25400);
  assert.equal(o.discountCents, 1270); // 5% of 254
  assert.equal(o.promoCode, 'SAVE5');
  assert.equal(o.totalCents, 25400 - 1270 + o.shippingCents);
});

test('margin guard: discount capped at (price − cost incl VAT) × qty', () => {
  const p = product(); // R12 headroom per unit
  code({ code: 'BIG20', percentOff: 20 });
  const r = check('big20', [{ productId: p.id, quantity: 3 }]);
  assert.equal(r.ok, true);
  assert.equal(r.discountCents, 3 * 1200); // not 20% of 381 = 76.20
  assert.match(r.message, /lowest price/);
  const o = order([{ productId: p.id, quantity: 3 }], { promoCode: 'BIG20' });
  assert.equal(o.discountCents, 3600);
  // Fixed rand codes are capped the same way.
  code({ code: 'R50', kind: 'fixed', amount: '50' });
  assert.equal(check('R50', [{ productId: p.id, quantity: 1 }]).discountCents, 1200);
  assert.equal(check('R50', [{ productId: p.id, quantity: 5 }]).discountCents, 5000);
});

test('code on top of a special only uses the margin the special left', () => {
  const p = product();
  specials.saveSpecial({ targetType: 'product', targetId: p.id, kind: 'percent', percentOff: 5 }); // 127 -> 121, headroom R6
  code({ code: 'BIG20', percentOff: 20 });
  const o = order([{ productId: p.id, quantity: 2 }], { promoCode: 'BIG20' });
  assert.equal(o.subtotalCents, 24200);
  assert.equal(o.discountCents, 1200);
  assert.equal(o.totalCents, 24200 - 1200 + o.shippingCents);
  // Already at the floor: nothing to give, the preview refuses politely, the order still goes through.
  specials.saveSpecial({ targetType: 'product', targetId: p.id, kind: 'percent', percentOff: 50 });
  const r = check('BIG20', [{ productId: p.id, quantity: 1 }]);
  assert.equal(r.ok, false);
  assert.equal(r.discountCents, 0);
  const o2 = order([{ productId: p.id, quantity: 1 }], { promoCode: 'BIG20' });
  assert.equal(o2.discountCents, 0);
  assert.equal(o2.promoCode, '');
});

test('invalid, inactive, not yet started and expired codes are refused with a friendly message', () => {
  const p = product();
  const items = [{ productId: p.id, quantity: 1 }];
  assert.throws(() => order(items, { promoCode: 'NOPE' }), /not valid/);
  code({ code: 'OFF', active: false });
  code({ code: 'LATER', startsAt: day(1) });
  code({ code: 'OLD', endsAt: day(-1) });
  code({ code: 'TODAY', startsAt: day(0), endsAt: day(0) });
  assert.match(check('OFF', items).message, /not valid/);
  assert.match(check('LATER', items).message, /not active yet/);
  assert.match(check('OLD', items).message, /expired/);
  assert.throws(() => order(items, { promoCode: 'OLD' }), /expired/);
  assert.equal(check('TODAY', items).ok, true);
});

test('minimum order subtotal', () => {
  const p = product();
  code({ code: 'MIN300', minSubtotal: '300' });
  assert.match(check('MIN300', [{ productId: p.id, quantity: 2 }]).message, /minimum order of R300/);
  assert.equal(check('MIN300', [{ productId: p.id, quantity: 3 }]).ok, true);
});

test('max total uses count paid orders only', () => {
  const p = product();
  code({ code: 'ONCE', maxUses: 1 });
  const items = [{ productId: p.id, quantity: 1 }];
  order(items, { promoCode: 'ONCE' }); // unpaid: doesn't count
  assert.equal(check('ONCE', items).ok, true);
  paidOrder(items, { promoCode: 'ONCE' });
  assert.equal(promos.promoUses('once'), 1);
  assert.match(check('ONCE', items).message, /fully redeemed/);
  assert.throws(() => order(items, { promoCode: 'ONCE' }), /fully redeemed/);
});

test('max uses per customer email (case-insensitive)', () => {
  const p = product();
  code({ code: 'WELCOME', maxUsesPerEmail: 1 });
  const items = [{ productId: p.id, quantity: 1 }];
  paidOrder(items, { promoCode: 'WELCOME' });
  assert.match(check('WELCOME', items, 'ANN@example.com').message, /already used/);
  assert.throws(() => order(items, { promoCode: 'WELCOME' }), /already used/);
  assert.equal(check('WELCOME', items, 'bob@example.com').ok, true);
  assert.ok(order(items, { promoCode: 'WELCOME', customer: { ...customer, email: 'bob@example.com' } }).discountCents > 0);
});

test('category restriction (incl. sub-categories) and brand restriction only discount matching lines', () => {
  const mouse = product({ markupPct: 50 }); // 173, floor 115
  const other = product({ sku: 'X1', name: 'Router', brand: 'TP', costCents: 10000, markupPct: 50, categoryId: catId('routers-mesh') });
  const parent = db.prepare("SELECT parent_id p FROM categories WHERE slug = 'keyboards-mice'").get().p;
  code({ code: 'PERIPH', percentOff: 10, categoryId: parent });
  const both = [{ productId: mouse.id, quantity: 1 }, { productId: other.id, quantity: 1 }];
  assert.equal(check('PERIPH', both).discountCents, 1730); // 10% of the mouse only
  assert.match(check('PERIPH', [{ productId: other.id, quantity: 1 }]).message, /does not apply/);
  code({ code: 'TPONLY', percentOff: 10, brand: 'tp' });
  assert.equal(check('TPONLY', both).discountCents, 1730);
  const o = order(both, { promoCode: 'periph' });
  assert.equal(o.discountCents, 1730);
});

test('admin: unique codes, rename blocked once used, usage and floor stats', () => {
  const p = product();
  const c = code({ code: 'BIG20', percentOff: 20 });
  assert.throws(() => code({ code: 'big20' }), /already exists/);
  const o = paidOrder([{ productId: p.id, quantity: 2 }], { promoCode: 'BIG20' });
  assert.throws(() => promos.savePromo({ code: 'OTHER', kind: 'percent', percentOff: 20 }, c.id), /can't be renamed/);
  const listed = promos.listPromos().find((x) => x.id === c.id);
  assert.equal(listed.uses, 1);
  assert.equal(listed.discountGivenCents, 2400);
  assert.equal(listed.revenueCents, o.totalCents);
  assert.equal(listed.floor.capped, 1); // the product's ~9.4% margin is below 20%
  assert.equal(listed.floor.lowestCap, 9.4);
  assert.throws(() => code({ code: 'X', percentOff: 5 }), /2–40/);
  assert.throws(() => code({ code: 'TOOMUCH', percentOff: 95 }), /between 0 and 90/);
});
