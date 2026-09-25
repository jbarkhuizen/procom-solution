import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';

process.env.UPLOADS_DIR = path.join(os.tmpdir(), 'procom-test-uploads');
process.env.DISABLE_BACKUPS = '1';

const { useMemoryDb } = await import('./db.js');
const { computeRetailCents, effectiveMarkupPct, marginCents, roundRetail } = await import('./pricing.js');
const catalog = await import('./catalog.js');
const orders = await import('./orders.js');
const shipping = await import('./shipping.js');
const { parseMinOrderQty } = await import('./feed.js');
const { updateSettings } = await import('./settings.js');
const { buildSignature } = await import('./payfast.js');
const auth = await import('./auth.js');
const { parseRandToCents } = await import('./util.js');

let db;
beforeEach(() => {
  db = useMemoryDb();
});

const catId = (slug) => db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug).id;
const courierSmall = () => db.prepare("SELECT id FROM shipping_options WHERE name LIKE 'PUDO Small%'").get().id;
const customer = { firstName: 'Ann', lastName: 'Lee', email: 'ann@example.com', phone: '0821234567', addressLine1: '1 Main Rd', city: 'Pretoria', postalCode: '0081' };

function product(over = {}) {
  return catalog.saveProduct({ name: 'Test Mouse', brand: 'Logi', costCents: 10000, categoryId: catId('keyboards-mice'), weightG: 500, ...over });
}

// ------------------------------------------------------------------ pricing

test('retail = cost × 1.15 VAT × (1 + markup), rounded up to whole rand', () => {
  assert.equal(computeRetailCents(7342, 10), 9300); // R73.42 -> R92.87 -> R93
  assert.equal(computeRetailCents(10000, 10), 12700); // R100 -> R126.50 -> R127
  assert.equal(computeRetailCents(10000, 0), 11500);
  assert.equal(roundRetail(12600), 12600); // already whole rand stays
});

test('markup precedence: product > nearest category > site default', () => {
  assert.equal(effectiveMarkupPct({ productMarkup: 25, categoryChain: [{ markup_pct: 15 }], defaultMarkup: 10 }), 25);
  assert.equal(effectiveMarkupPct({ productMarkup: null, categoryChain: [{ markup_pct: null }, { markup_pct: 15 }], defaultMarkup: 10 }), 15);
  assert.equal(effectiveMarkupPct({ productMarkup: '', categoryChain: [], defaultMarkup: 10 }), 10);
});

test('margin accounts for absorbed VAT when not VAT-registered', () => {
  assert.equal(marginCents(12700, 10000), 12700 - 11500);
  assert.equal(marginCents(11500, 10000, { vatRegistered: true }), 0);
});

test('product auto-price follows category markup changes', () => {
  const p = product();
  assert.equal(p.priceCents, 12700); // default 10%
  catalog.saveCategory({ name: 'Keyboards & Mice', parentId: db.prepare("SELECT parent_id p FROM categories WHERE slug='keyboards-mice'").get().p, markupPct: 20 }, catId('keyboards-mice'));
  assert.equal(catalog.getProduct(p.id).priceCents, 13800); // 100 × 1.15 × 1.2 = 138
});

test('changing the site default markup reprices inheriting products only', () => {
  const inherit = product();
  const own = product({ name: 'Own markup', sku: 'X2', markupPct: 50 });
  updateSettings({ defaultMarkupPct: 30 });
  catalog.repriceProducts();
  assert.equal(catalog.getProduct(inherit.id).priceCents, 15000); // 115 × 1.3 = 149.5 -> 150
  assert.equal(catalog.getProduct(own.id).priceCents, own.priceCents);
});

test('manual price mode is never overwritten by repricing', () => {
  const p = product({ priceMode: 'manual', price: '199.99' });
  catalog.repriceProducts();
  assert.equal(catalog.getProduct(p.id).priceCents, 19999);
});

test('active product must have a price', () => {
  assert.throws(() => catalog.saveProduct({ name: 'Free thing', costCents: 0 }), /price above R0/);
});

test('parses rand strings from pricelists', () => {
  assert.equal(parseRandToCents('R1,299.00'), 129900);
  assert.equal(parseRandToCents(6.03), 603);
  assert.equal(parseRandToCents('n/a'), null);
});

test('reads supplier minimum order quantities from names', () => {
  assert.equal(parseMinOrderQty('Avalanche Double Bubble - Maze (To Be Ordered in Qty of 36)'), 36);
  assert.equal(parseMinOrderQty('Logitech MX Keys'), 1);
});

test('category cannot become its own descendant', () => {
  const parent = catId('computers-peripherals');
  assert.throws(() => catalog.saveCategory({ name: 'Computers', parentId: catId('keyboards-mice') }, parent), /inside itself/);
});

// ------------------------------------------------------------------ orders

test('checkout prices from the DB, ignoring any client-sent price', () => {
  const p = product();
  const o = orders.createOrder({ customer, shippingOptionId: courierSmall(), items: [{ productId: p.id, quantity: 2, priceCents: 1 }] });
  assert.equal(o.subtotalCents, 25400);
  assert.equal(o.shippingCents, 8000);
  assert.equal(o.totalCents, 33400);
  assert.equal(o.status, 'pending_payment');
  assert.match(o.orderNumber, /^PC\d+$/);
});

test('courier bracket must match cart weight', () => {
  const p = product({ weightG: 2000 }); // 2kg > PUDO Small's 1.5kg
  assert.throws(() => orders.createOrder({ customer, shippingOptionId: courierSmall(), items: [{ productId: p.id, quantity: 1 }] }), /does not cover the weight/);
});

test('PUDO locker option requires a locker; locker-to-door also needs an address', () => {
  const p = product();
  const locker = db.prepare("SELECT id FROM shipping_options WHERE name LIKE 'PUDO Locker to Locker (Small)%'").get().id;
  const door = db.prepare("SELECT id FROM shipping_options WHERE name LIKE 'PUDO Locker to Door (Small)%'").get().id;
  const noAddr = { firstName: 'Ann', email: 'ann@example.com', phone: '0821234567' };
  assert.throws(() => orders.createOrder({ customer: noAddr, shippingOptionId: locker, items: [{ productId: p.id, quantity: 1 }] }), /PUDO locker/);
  assert.ok(orders.createOrder({ customer: { ...noAddr, pudoLocker: 'Menlyn' }, shippingOptionId: locker, items: [{ productId: p.id, quantity: 1 }] }));
  assert.throws(() => orders.createOrder({ customer: { ...noAddr, pudoLocker: 'Menlyn' }, shippingOptionId: door, items: [{ productId: p.id, quantity: 1 }] }), /delivery address/);
});

test('rejects out-of-stock, hidden and below-MOQ items', () => {
  const out = product({ supplierInStock: false });
  const hidden = product({ sku: 'H1', name: 'Hidden', active: false });
  const moq = product({ sku: 'M1', name: 'Bulk', minOrderQty: 6 });
  const ship = courierSmall();
  assert.throws(() => orders.createOrder({ customer, shippingOptionId: ship, items: [{ productId: out.id, quantity: 1 }] }), /out of stock/);
  assert.throws(() => orders.createOrder({ customer, shippingOptionId: ship, items: [{ productId: hidden.id, quantity: 1 }] }), /no longer available/);
  assert.throws(() => orders.createOrder({ customer, shippingOptionId: ship, items: [{ productId: moq.id, quantity: 2 }] }), /minimum order quantity of 6/);
});

test('marking paid is idempotent and decrements own stock once', () => {
  const p = product({ fulfilment: 'stock', stockQty: 5, weightG: 100 });
  const o = orders.createOrder({ customer, shippingOptionId: courierSmall(), items: [{ productId: p.id, quantity: 2 }] });
  assert.equal(orders.markOrderPaid(o.id, { pfPaymentId: '123' }).changed, true);
  assert.equal(orders.markOrderPaid(o.id, { pfPaymentId: '123' }).changed, false);
  assert.equal(catalog.getProduct(p.id).stockQty, 3);
  assert.equal(orders.getOrder(o.id).status, 'paid');
});

test('unpaid orders cannot be moved into fulfilment', () => {
  const o = orders.createOrder({ customer, shippingOptionId: courierSmall(), items: [{ productId: product().id, quantity: 1 }] });
  assert.throws(() => orders.updateOrder(o.id, { status: 'shipped' }), /not been paid/);
  assert.ok(orders.updateOrder(o.id, { status: 'cancelled' }));
});

test('supplier sheet lists supplier codes and ships to the customer', () => {
  const sup = db.prepare('SELECT id FROM suppliers').get().id;
  const p = product({ supplierId: sup, supplierCode: 'AM-10001-BK' });
  const o = orders.createOrder({ customer, shippingOptionId: courierSmall(), items: [{ productId: p.id, quantity: 1 }] });
  const [sheet] = orders.supplierOrderSheet(orders.getOrder(o.id));
  assert.match(sheet.text, /1 x AM-10001-BK/);
  assert.match(sheet.text, /1 Main Rd/);
});

test('auto-weight shipping brackets may not overlap', () => {
  assert.throws(() => shipping.saveShippingOption({ name: 'Overlap', optionType: 'auto_weight', minWeight: 1000, maxWeight: 2000, price: 90 }), /overlaps/);
});

// ------------------------------------------------------------------ security

test('admin sessions persist and die on password reset', () => {
  const a = auth.createAdmin({ username: 'owner', password: 'a-long-password' });
  const token = auth.createSession(a.id);
  assert.equal(auth.getSession(token).username, 'owner');
  auth.resetAdminPassword(a.id, 'another-long-password');
  assert.equal(auth.getSession(token), null);
  assert.equal(auth.verifyLogin('owner', 'a-long-password'), null);
  assert.ok(auth.verifyLogin('OWNER', 'another-long-password'));
});

test('short admin passwords are rejected', () => {
  assert.throws(() => auth.createAdmin({ username: 'x1x', password: 'short' }), /at least 10/);
});

test('Payfast signature uses PHP-style encoding (space as +)', async () => {
  // Regression guard: encodeURIComponent-style %20 produces a different hash.
  const { createHash } = await import('crypto');
  const md5 = (s) => createHash('md5').update(s).digest('hex');
  assert.equal(buildSignature([['item_name', "a b!"], ['url', 'https://x.co/?a=1']], 'pass word'), md5('item_name=a+b%21&url=https%3A%2F%2Fx.co%2F%3Fa%3D1&passphrase=pass+word'));
  assert.equal(buildSignature([['a', '1'], ['b', '']], ''), md5('a=1'));
  assert.equal(buildSignature([['a', '1'], ['b', '']], '', { skipEmpty: false }), md5('a=1&b='));
});
