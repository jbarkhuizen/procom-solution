import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';

process.env.UPLOADS_DIR = path.join(os.tmpdir(), 'procom-test-uploads');
process.env.DISABLE_BACKUPS = '1';
delete process.env.GMAIL_USER;

const { useMemoryDb } = await import('./db.js');
const catalog = await import('./catalog.js');
const orders = await import('./orders.js');
const finance = await import('./features/finance.js');

let db;
beforeEach(() => {
  db = useMemoryDb();
});
const realLog = console.log;
console.log = (...args) => (String(args[0]).startsWith('[mail disabled]') ? undefined : realLog(...args));
after(() => (console.log = realLog));

const catId = (slug) => db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug).id;
const smdId = () => db.prepare("SELECT id FROM suppliers WHERE name LIKE 'SMD%'").get().id;
const courier = () => db.prepare("SELECT id FROM shipping_options WHERE name LIKE 'PUDO Small%'").get().id;
const customer = { firstName: 'Ann', lastName: 'Lee', email: 'ann@example.com', phone: '0821234567', addressLine1: '1 Main Rd', city: 'Pretoria', postalCode: '0081' };
let skuN = 0;
const product = (over = {}) => catalog.saveProduct({ name: 'Test Mouse', sku: `S${++skuN}`, costCents: 10000, categoryId: catId('keyboards-mice'), weightG: 100, ...over });
const stockProduct = (qty) => product({ fulfilment: 'stock', stockQty: qty });
const supplierProduct = (over = {}) => product({ supplierId: smdId(), ...over });
const stockOrder = (p, quantity) => orders.createOrder({ customer, shippingOptionId: courier(), items: [{ productId: p.id, quantity }] });
const qty = (p) => db.prepare('SELECT stock_qty FROM products WHERE id = ?').get(p.id).stock_qty;

test('cancelling a paid order puts own stock back, records the refund and the lost Payfast fee', () => {
  const p = stockProduct(5);
  const o = stockOrder(p, 2);
  orders.markOrderPaid(o.id, { pfPaymentId: 'pf1', feeCents: 1000 });
  assert.equal(qty(p), 3);
  assert.throws(() => orders.updateOrder(o.id, { status: 'cancelled' }), /Cancel and refund/);

  const c = orders.cancelOrder(o.id, { refundCents: o.totalCents, reason: 'supplier out of stock' });
  assert.equal(c.status, 'cancelled');
  assert.equal(qty(p), 5, 'the two units are back on the shelf');
  const r = db.prepare('SELECT * FROM order_refunds').get();
  assert.deepEqual([r.amount_cents, r.fee_lost_cents, r.reason], [o.totalCents, 1000, 'supplier out of stock']);
  assert.throws(() => orders.cancelOrder(o.id), /already cancelled/);
  assert.throws(() => orders.updateOrder(o.id, { status: 'shipped' }), /cannot be reopened/);

  // the fee Payfast kept is a cost; the order brings in no income
  const t = finance.financeTotals('2000-01-01', '2100-01-01', db);
  assert.deepEqual([t.orders, t.incomeCents, t.cancelledOrders, t.payfastFeesCents], [0, 0, 1, 1000]);
  // and the dashboard no longer counts it as revenue
  assert.equal(orders.dashboardStats(db).revenue30Cents, 0);
});

test('refund amount is checked; an unpaid order just cancels', () => {
  const p = stockProduct(5);
  const paid = stockOrder(p, 1);
  orders.markOrderPaid(paid.id, { pfPaymentId: 'x' });
  assert.throws(() => orders.cancelOrder(paid.id, { refundCents: paid.totalCents + 1 }), /between R0 and the order total/);
  assert.throws(() => orders.cancelOrder(paid.id, { refundCents: -5 }), /between R0/);
  const unpaid = stockOrder(p, 1);
  const c = orders.cancelOrder(unpaid.id);
  assert.equal(c.status, 'cancelled');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM order_refunds').get().n, 0, 'nothing was paid, nothing to refund');
  assert.equal(qty(p), 4, 'stock only left the shelf for the paid order');
});

test('paying for the last unit twice flags the second order; supplier stock goes down with each sale', () => {
  const p = stockProduct(1);
  const a = stockOrder(p, 1);
  const b = stockOrder(p, 1); // both pass the checkout check
  orders.markOrderPaid(a.id, { pfPaymentId: 'a' });
  assert.equal(orders.getOrder(a.id).attention, '');
  orders.markOrderPaid(b.id, { pfPaymentId: 'b' });
  assert.match(orders.getOrder(b.id).attention, /2 ordered|1 ordered but only 0 in stock/);
  assert.equal(orders.dashboardStats(db).ordersNeedingAttention, 1);
  orders.updateOrder(b.id, { attention: '' });
  assert.equal(orders.getOrder(b.id).attention, '');

  const s = supplierProduct();
  db.prepare('UPDATE products SET supplier_in_stock = 1, supplier_stock_qty = 3 WHERE id = ?').run(s.id);
  const smdOrder = orders.createOrder({ customer, delivery: { [smdId()]: 'courier' }, items: [{ productId: s.id, quantity: 2 }] });
  orders.markOrderPaid(smdOrder.id, { pfPaymentId: 'c' });
  assert.equal(db.prepare('SELECT supplier_stock_qty FROM products WHERE id = ?').get(s.id).supplier_stock_qty, 1);
  assert.equal(orders.getOrder(smdOrder.id).attention, '');
  // the supplier now shows 1; a new paid order for 2 is flagged
  const again = orders.createOrder({ customer, delivery: { [smdId()]: 'courier' }, items: [{ productId: s.id, quantity: 1 }] });
  db.prepare('UPDATE products SET supplier_in_stock = 0 WHERE id = ?').run(s.id);
  orders.markOrderPaid(again.id, { pfPaymentId: 'd' });
  assert.match(orders.getOrder(again.id).attention, /supplier showed it out of stock/);
});

test('an order cancelled before its payment arrives is flagged, not lost; flagging keeps earlier notes', () => {
  const p = stockProduct(5);
  const o = stockOrder(p, 1);
  orders.cancelOrder(o.id); // unpaid, cancelled
  const { changed, order } = orders.markOrderPaid(o.id, { pfPaymentId: 'late' });
  assert.equal(changed, true);
  assert.equal(order.status, 'cancelled', 'status is not silently reopened');
  assert.match(order.attention, /cancelled before the payment arrived/);
  orders.flagOrder(o.id, 'A second payment arrived');
  assert.match(orders.getOrder(o.id).attention, /cancelled before.*; A second payment arrived/);
});
