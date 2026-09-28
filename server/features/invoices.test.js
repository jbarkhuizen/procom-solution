import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';

process.env.UPLOADS_DIR = path.join(os.tmpdir(), 'procom-test-uploads');
process.env.DISABLE_BACKUPS = '1';
delete process.env.GMAIL_USER; // never send real mail from tests

const { useMemoryDb } = await import('../db.js');
const catalog = await import('../catalog.js');
const orders = await import('../orders.js');
const invoices = await import('./invoices.js');
const express = (await import('express')).default;
const rateLimit = (await import('express-rate-limit')).default;

let db;
beforeEach(() => {
  db = useMemoryDb();
});

// "[mail disabled] would send ..." lines are expected; keep test output tidy.
const realLog = console.log;
console.log = (...args) => (String(args[0]).startsWith('[mail disabled]') ? undefined : realLog(...args));
after(() => (console.log = realLog));

const catId = (slug) => db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug).id;
const courierSmall = () => db.prepare("SELECT id FROM shipping_options WHERE name LIKE 'PUDO Small%'").get().id;
const customer = { firstName: 'Ann', lastName: 'Lee', email: 'ann@example.com', phone: '0821234567', addressLine1: '1 Main Rd', city: 'Pretoria', postalCode: '0081' };
let skuN = 0;
const product = (over = {}) => catalog.saveProduct({ name: 'Test Mouse', sku: `T${++skuN}`, brand: 'Logi', costCents: 10000, categoryId: catId('keyboards-mice'), weightG: 500, ...over });
const newOrder = () => orders.createOrder({ customer, shippingOptionId: courierSmall(), items: [{ productId: product().id, quantity: 2 }] });
const paidOrder = () => orders.markOrderPaid(newOrder().id, { pfPaymentId: 'pf1' }).order;
const NO_VAT = /\bVAT\b|tax invoice/i;

test('paying an order issues sequential, zero-padded invoice numbers', () => {
  const a = paidOrder();
  const b = paidOrder();
  const c = paidOrder();
  assert.deepEqual([a.invoiceNumber, b.invoiceNumber, c.invoiceNumber], ['INV-000001', 'INV-000002', 'INV-000003']);
  assert.ok(a.invoicedAt);
  assert.match(a.events.map((e) => e.message).join('\n'), /Invoice INV-000001 issued/);
});

test('unpaid orders get no invoice number', () => {
  const o = newOrder();
  assert.equal(orders.getOrder(o.id).invoiceNumber, '');
  assert.throws(() => invoices.issueInvoice(o.id, { db }), /Only paid orders/);
  assert.equal(invoices.issueInvoice('no-such-order', { db }), null);
});

test('idempotent: re-running the hook or a repeated ITN never renumbers', () => {
  const a = paidOrder();
  invoices.onOrderPaid(a, db);
  orders.markOrderPaid(a.id, { pfPaymentId: 'pf1' }); // duplicate ITN
  assert.deepEqual(invoices.issueInvoice(a.id, { db }), { invoiceNumber: 'INV-000001', created: false });
  assert.equal(paidOrder().invoiceNumber, 'INV-000002'); // no number was burnt
});

test('numbering never reuses a number, even if an invoice is cleared by hand', () => {
  const a = paidOrder();
  paidOrder();
  db.prepare("UPDATE orders SET invoice_number = '' WHERE id = ?").run(a.id);
  assert.equal(invoices.issueInvoice(a.id, { db }).invoiceNumber, 'INV-000003');
  // Counter behind the orders (e.g. old backup): continues after the highest used.
  db.prepare('UPDATE invoice_counter SET last_number = 0').run();
  assert.equal(paidOrder().invoiceNumber, 'INV-000004');
});

test('numbering is safe inside an outer transaction (rolled back together)', () => {
  const a = orders.createOrder({ customer, shippingOptionId: courierSmall(), items: [{ productId: product().id, quantity: 1 }] });
  db.prepare("UPDATE orders SET payment_status = 'paid', status = 'paid' WHERE id = ?").run(a.id);
  assert.throws(() => db.transaction(() => {
    invoices.issueInvoice(a.id, { db });
    throw new Error('boom');
  })());
  assert.equal(orders.getOrder(a.id).invoiceNumber, '');
  assert.equal(invoices.issueInvoice(a.id, { db }).invoiceNumber, 'INV-000001'); // no gap
});

test('onOrderPaid never throws', () => {
  assert.doesNotThrow(() => invoices.onOrderPaid(null, db));
  assert.doesNotThrow(() => invoices.onOrderPaid({ id: 'missing' }, db));
  const o = newOrder(); // unpaid: issueInvoice throws internally, hook logs it
  const realErr = console.error;
  console.error = () => {};
  try {
    assert.doesNotThrow(() => invoices.onOrderPaid(o, db));
  } finally {
    console.error = realErr;
  }
});

test('backfill numbers old paid orders in payment order, skips unpaid and invoiced ones', () => {
  // Paid before the feature existed: payment recorded, no invoice.
  const mk = (paidAt) => {
    const o = newOrder();
    db.prepare("UPDATE orders SET payment_status = 'paid', status = 'paid', paid_at = ? WHERE id = ?").run(paidAt, o.id);
    return o;
  };
  const later = mk('2026-09-20T10:00:00.000Z');
  const earlier = mk('2026-09-10T10:00:00.000Z');
  newOrder(); // unpaid
  assert.equal(invoices.listInvoices({}, db).missing, 2);
  const { issued } = invoices.issueMissingInvoices({ db });
  assert.deepEqual(issued.map((i) => [i.orderId, i.invoiceNumber]), [[earlier.id, 'INV-000001'], [later.id, 'INV-000002']]);
  assert.equal(invoices.issueMissingInvoices({ db }).issued.length, 0);
  assert.equal(invoices.listInvoices({}, db).missing, 0);
  assert.equal(paidOrder().invoiceNumber, 'INV-000003');
});

test('public invoice: items, discount, delivery, payment; null when unpaid', () => {
  const o = newOrder();
  assert.equal(invoices.publicInvoice(o.id, db), null);
  db.prepare("UPDATE orders SET discount_cents = 500, promo_code = 'WELCOME', total_cents = total_cents - 500 WHERE id = ?").run(o.id);
  orders.markOrderPaid(o.id, { pfPaymentId: 'pf9' });
  const inv = invoices.publicInvoice(o.id, db);
  assert.equal(inv.invoiceNumber, 'INV-000001');
  assert.equal(inv.items.length, 1);
  assert.equal(inv.items[0].quantity, 2);
  assert.equal(inv.discountCents, 500);
  assert.equal(inv.promoCode, 'WELCOME');
  assert.equal(inv.shipments.length, 1);
  assert.equal(inv.subtotalCents - inv.discountCents + inv.deliveryCents, inv.totalCents);
  assert.equal(inv.payment.reference, 'pf9');
  assert.equal(inv.seller.name, 'Lapanza (trading as Procom Solutions)');
  assert.match(inv.seller.address, /Gladiator/);
  assert.equal(inv.customer.name, 'Ann Lee');
});

test('collect shipment: collection details shown, supplier named only by its label', () => {
  const smd = db.prepare("SELECT id, name, public_label FROM suppliers WHERE name LIKE 'SMD%'").get();
  const cable = product({ name: 'Cable', supplierId: smd.id, weightG: 100 });
  const o = orders.createOrder({ customer, delivery: { [smd.id]: 'collect' }, items: [{ productId: cable.id, quantity: 1 }] });
  orders.markOrderPaid(o.id);
  const inv = invoices.publicInvoice(o.id, db);
  assert.equal(inv.shipments[0].method, 'collect');
  assert.ok(inv.shipments[0].collection.address);
  assert.equal(inv.shipments[0].label, smd.public_label);
  const json = JSON.stringify(inv);
  assert.ok(!json.includes(smd.name), 'supplier name must not appear');
  assert.ok(!json.includes('supplierId'));
});

test('no VAT wording on the invoice data or the invoice email', () => {
  const o = paidOrder();
  assert.doesNotMatch(JSON.stringify(invoices.publicInvoice(o.id, db)), NO_VAT);
  const html = invoices.invoiceEmailHtml(orders.getOrder(o.id));
  assert.doesNotMatch(html, NO_VAT);
  assert.match(html, /INV-000001/);
  assert.match(html, /invoice\.html\?o=/);
});

test('admin list: search, date filter, monthly totals', () => {
  const a = paidOrder();
  const b = paidOrder();
  db.prepare("UPDATE orders SET invoiced_at = '2026-08-31T23:30:00.000Z' WHERE id = ?").run(a.id); // 01:30 on 1 Sept in SA
  db.prepare("UPDATE orders SET invoiced_at = '2026-08-15T10:00:00.000Z' WHERE id = ?").run(b.id);
  const all = invoices.listInvoices({}, db);
  assert.equal(all.total, 2);
  assert.deepEqual(all.months.map((m) => [m.month, m.count]), [['2026-09', 1], ['2026-08', 1]]);
  assert.equal(all.totalCents, a.totalCents + b.totalCents);
  assert.deepEqual(invoices.listInvoices({ from: '2026-09-01', to: '2026-09-30' }, db).items.map((i) => i.invoiceNumber), ['INV-000001']);
  assert.equal(invoices.listInvoices({ q: 'INV-000002' }, db).total, 1);
  assert.equal(invoices.listInvoices({ q: 'Ann Lee' }, db).total, 2);
  assert.equal(invoices.listInvoices({ q: 'nobody' }, db).total, 0);
});

test('GET /api/orders/:id/invoice: 200 when invoiced, 404 when unpaid or unknown', async () => {
  const app = express();
  app.use(express.json());
  const admin = express.Router();
  const wrap = (fn) => async (req, res) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  };
  invoices.register({ app, admin, wrap, rateLimit, express, siteUrl: 'https://example.test' });
  app.use('/api/admin', admin);
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const paid = paidOrder();
    const unpaid = newOrder();
    const ok = await fetch(`${base}/api/orders/${paid.id}/invoice`);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).invoiceNumber, 'INV-000001');
    assert.equal((await fetch(`${base}/api/orders/${unpaid.id}/invoice`)).status, 404);
    assert.equal((await fetch(`${base}/api/orders/nope/invoice`)).status, 404);
    assert.equal(invoices.invoiceUrl(paid.id), `https://example.test/invoice.html?o=${paid.id}`);
  } finally {
    server.close();
  }
});
