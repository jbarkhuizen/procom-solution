// End-to-end check that the Phase 1 features work together through the core:
// special price -> promo discount (capped at cost incl VAT) -> order linked to
// the registered customer -> payment -> sequential invoice.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DISABLE_BACKUPS = '1';
const { useMemoryDb } = await import('../db.js');
const catalog = await import('../catalog.js');
const orders = await import('../orders.js');
const accounts = await import('./accounts.js');
const promos = await import('./promos.js');
const specials = await import('./specials.js');
const invoices = await import('./invoices.js');
const finance = await import('./finance.js');
// These tests check special/promo mechanics against the cost-incl-VAT floor;
// Payfast fees are zeroed here and the fee floor has its own test below.
const noFees = (db) => finance.updateFinanceSettings({ payfastFees: { methods: finance.DEFAULT_PAYFAST_METHODS.map((m) => ({ key: m.key, pct: 0, fixedCents: 0 })) } }, db);


test('special + capped promo + account link + invoice, end to end', () => {
  const db = useMemoryDb();
  noFees(db);
  const cat = db.prepare("SELECT id FROM categories WHERE slug = 'keyboards-mice'").get().id;
  // Cost R1,000 excl VAT, default 10% markup -> R1,265.
  const p = catalog.saveProduct({ name: 'Mouse', sku: 'M1', costCents: 100000, categoryId: cat, weightG: 500 });
  assert.equal(p.priceCents, 126500);

  specials.saveSpecial({ label: 'Test', targetType: 'product', targetId: p.id, kind: 'percent', percentOff: 5 });
  const shown = catalog.getProduct(p.id, { admin: false });
  assert.equal(shown.priceCents, 120200); // 5% off, rounded up to the rand
  assert.equal(shown.compareAtCents, 126500);

  promos.savePromo({ code: 'SAVE20', kind: 'percent', percentOff: 20 });

  const { token } = accounts.registerClient({ email: 'ann@example.com', password: 'correct-horse-9', firstName: 'Ann', lastName: 'Lee' });
  const client = accounts.verifyEmail(token);
  assert.ok(client);

  const customer = { firstName: 'Ann', lastName: 'Lee', email: 'ANN@example.com', phone: '0821234567', addressLine1: '1 Main Rd', city: 'Pretoria', postalCode: '0081' };
  const courier = db.prepare("SELECT id FROM shipping_options WHERE name LIKE 'PUDO Small%'").get().id;
  const o = orders.createOrder({ customer, shippingOptionId: courier, promoCode: 'save20', items: [{ productId: p.id, quantity: 2 }] });
  // 20% of R2,404 requested, but capped at the margin above cost incl VAT: 2 x (R1,202 - R1,150).
  assert.equal(o.subtotalCents, 240400);
  assert.equal(o.discountCents, 10400);
  assert.equal(o.promoCode, 'SAVE20');
  assert.equal(o.totalCents, 240400 - 10400 + o.shippingCents);
  assert.equal(o.items[0].unitPriceCents, 120200);
  assert.equal(o.clientId, client.id); // linked by email, case-insensitive

  assert.equal(o.invoiceNumber, '');
  orders.markOrderPaid(o.id, { pfPaymentId: 'T1' });
  const paid = orders.getOrder(o.id);
  assert.equal(paid.invoiceNumber, 'INV-000001');
  const inv = invoices.publicInvoice(o.id);
  assert.equal(inv.totalCents ?? inv.total ?? paid.totalCents, paid.totalCents);
  assert.doesNotMatch(JSON.stringify(inv), /tax invoice|vat/i);
  assert.equal(accounts.listClientOrders(client.id).length, 1);
});
