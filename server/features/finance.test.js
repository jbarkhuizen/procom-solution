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
const promos = await import('./promos.js');
const finance = await import('./finance.js');

let db;
beforeEach(() => {
  db = useMemoryDb();
});

const realLog = console.log;
console.log = (...args) => (String(args[0]).startsWith('[mail disabled]') ? undefined : realLog(...args));
after(() => (console.log = realLog));

const catId = (slug) => db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug).id;
const smdId = () => db.prepare("SELECT id FROM suppliers WHERE name LIKE 'SMD%'").get().id;
const courierSmall = () => db.prepare("SELECT id FROM shipping_options WHERE name LIKE 'PUDO Small%'").get().id;
const customer = { firstName: 'Ann', lastName: 'Lee', email: 'ann@example.com', phone: '0821234567', addressLine1: '1 Main Rd', city: 'Pretoria', postalCode: '0081' };
let skuN = 0;
// Cost R100 excl VAT, default 10% markup -> R127.
const product = (over = {}) => catalog.saveProduct({ name: 'Test Mouse', sku: `F${++skuN}`, costCents: 10000, categoryId: catId('keyboards-mice'), weightG: 500, ...over });
const smdProduct = (over = {}) => product({ supplierId: smdId(), ...over });

// Creates, pays and back-dates an order (paid_at in UTC ISO).
function paid(input, paidAt = '2026-09-10T08:00:00.000Z') {
  const o = orders.createOrder({ customer, ...input });
  orders.markOrderPaid(o.id, { pfPaymentId: 'pf' });
  db.prepare('UPDATE orders SET paid_at = ? WHERE id = ?').run(paidAt, o.id);
  return orders.getOrder(o.id);
}
const SEPT = { from: '2026-09-01', to: '2026-09-30' };
const totals = (range = SEPT) => finance.financeTotals(range.from, range.to, db);

test('cost of goods includes the supplier VAT we pay; income = goods + delivery', () => {
  const o = paid({ delivery: { [smdId()]: 'courier' }, items: [{ productId: smdProduct().id, quantity: 2 }] });
  const t = totals();
  assert.equal(t.orders, 1);
  assert.equal(t.goodsCents, 25400); // 2 x R127
  assert.equal(t.deliveryChargedCents, 15000);
  assert.equal(t.incomeCents, o.totalCents);
  assert.equal(t.incomeCents, 40400);
  assert.equal(t.cogsCents, 23000); // 2 x R100 x 1.15
  assert.equal(t.grossProfitCents, 2400);
  assert.equal(t.grossMarginPct, 9.4);
});

test('VAT rate comes from settings', () => {
  db.prepare("UPDATE settings SET value = '10' WHERE key = 'vatRatePct'").run();
  paid({ delivery: { [smdId()]: 'collect' }, items: [{ productId: smdProduct({ priceMode: 'manual', priceCents: 20000 }).id, quantity: 1 }] });
  assert.equal(totals().cogsCents, 11000);
});

test('discounts reduce goods income (subtotal - discount)', () => {
  promos.savePromo({ code: 'SAVE20', kind: 'percent', percentOff: 20 });
  const o = paid({ promoCode: 'SAVE20', delivery: { [smdId()]: 'collect' }, items: [{ productId: smdProduct().id, quantity: 2 }] });
  assert.ok(o.discountCents > 0);
  const t = totals();
  assert.equal(t.discountCents, o.discountCents);
  assert.equal(t.goodsCents, o.subtotalCents - o.discountCents);
  assert.equal(t.incomeCents, o.totalCents);
  assert.equal(t.deliveryCostCents, 0); // collection costs nothing
});

test('delivery cost rule: SMD courier = fee charged, free order = R0, collect = R0, store option = fee', () => {
  const smd = smdId();
  paid({ delivery: { [smd]: 'courier' }, items: [{ productId: smdProduct().id, quantity: 1 }] });
  assert.equal(totals().deliveryCostCents, 15000);

  db = useMemoryDb();
  // R1,000 x 5 x 1.15 = R5,750 SMD invoice: free delivery for the customer, and SMD charges us nothing.
  const free = paid({ delivery: { [smdId()]: 'courier' }, items: [{ productId: smdProduct({ costCents: 100000 }).id, quantity: 5 }] });
  assert.equal(free.shippingCents, 0);
  assert.equal(totals().deliveryCostCents, 0);

  db = useMemoryDb();
  paid({ delivery: { [smdId()]: 'collect' }, items: [{ productId: smdProduct().id, quantity: 1 }] });
  assert.equal(totals().deliveryCostCents, 0);

  db = useMemoryDb();
  const store = paid({ shippingOptionId: courierSmall(), items: [{ productId: product().id, quantity: 1 }] }); // no supplier: store-wide options
  assert.equal(store.shippingCents, 8000);
  assert.equal(totals().deliveryCostCents, 8000);

  // Per-order override wins; clearing it goes back to the rule.
  finance.setDeliveryCost(store.orderNumber, { costCents: 9500, note: 'Courier invoice' }, db);
  assert.equal(totals().deliveryCostCents, 9500);
  assert.equal(finance.listDeliveryCostOverrides(db)[0].ruleCostCents, 8000);
  finance.setDeliveryCost(store.id, { costCents: null }, db);
  assert.equal(totals().deliveryCostCents, 8000);
  assert.throws(() => finance.setDeliveryCost('PC99999', { costCents: 1 }, db), /No order/);
});

test('delivery cost uses what the courier costs us, not the higher fee the customer pays', () => {
  const smd = smdId();
  const name = catalog.listSuppliers(db).find((s) => s.id === smd).name;
  catalog.saveSupplier({ name, deliveryFee: '157', deliveryCost: '150' }, smd, db);
  const o = paid({ delivery: { [smd]: 'courier' }, items: [{ productId: smdProduct().id, quantity: 1 }] });
  assert.equal(o.shippingCents, 15700, 'customer pays R157');
  assert.equal(totals().deliveryChargedCents, 15700);
  assert.equal(totals().deliveryCostCents, 15000, 'SMD charges us R150');
  catalog.saveSupplier({ name, deliveryCost: '' }, smd, db);
  assert.equal(catalog.listSuppliers(db).find((s) => s.id === smd).deliveryCostCents, null, 'blank = same as the fee');
});

test('legacy orders without fulfilment_json use the old shipping fields', () => {
  const o = paid({ shippingOptionId: courierSmall(), items: [{ productId: product().id, quantity: 1 }] });
  db.prepare("UPDATE orders SET fulfilment_json = '' WHERE id = ?").run(o.id);
  assert.equal(totals().deliveryCostCents, 8000);
  db.prepare('UPDATE orders SET collection = 1 WHERE id = ?').run(o.id);
  assert.equal(totals().deliveryCostCents, 0);
});

test('Payfast method table: defaults from the dashboard, estimates per checkout method, VAT on the fee', () => {
  const fees = finance.getFinanceSettings(db).payfastFees;
  assert.equal(fees.methods.length, 15);
  assert.equal(fees.card.name, 'Credit Card');
  assert.deepEqual([fees.card.pct, fees.card.fixedCents], [3.2, 200]);
  assert.equal(fees.eft.enabled, false, 'Instant EFT is off in Payfast');
  assert.equal(fees.pricing.name, 'Debit Card', 'dearest switched-on method (3.5% + R2) drives the margin check');
  assert.equal(finance.estimatePayfastFee(100000, 'payfast_card', fees, 15), 3910); // (R32 + R2) x 1.15 = R39.10
  assert.equal(finance.estimatePayfastFee(40400, 'payfast_card', fees, 15), 1717); // (R12.928 + R2) x 1.15
  assert.equal(finance.estimatePayfastFee(40400, 'payfast_eft', fees, 15), 929); // R8.08 x 1.15
  assert.equal(finance.estimatePayfastFee(0, 'payfast_card', fees, 15), 0);
  assert.equal(finance.feeForRule(100000, fees.pricing, true, 15), 4255); // (R35 + R2) x 1.15

  // Switch Instant EFT on; an EFT order is estimated with the EFT row.
  let s = finance.updateFinanceSettings({ payfastFees: { methods: [{ key: 'instant_eft', enabled: true }] } }, db);
  assert.equal(s.payfastFees.eft.enabled, true);
  assert.equal(s.payfastFees.methods.find((m) => m.key === 'debit_card').pct, 3.5, 'untouched rows keep their values');
  paid({ paymentMethod: 'payfast_eft', delivery: { [smdId()]: 'courier' }, items: [{ productId: smdProduct().id, quantity: 2 }] });
  assert.equal(totals().payfastFeesCents, 929);

  s = finance.updateFinanceSettings({ payfastFees: { methods: [{ key: 'instant_eft', pct: 1.5, fixedCents: 100 }], addVat: false } }, db);
  assert.equal(s.payfastFees.card.pct, 3.2); // untouched
  assert.equal(totals().payfastFeesCents, 706); // 404 x 1.5% = 606 + 100, no VAT
  assert.throws(() => finance.updateFinanceSettings({ payfastFees: { methods: [{ key: 'zapper', minCents: 5000, maxCents: 100 }] } }, db), /maximum amount/);
  assert.throws(() => finance.updateFinanceSettings({ payfastFees: { cardMethod: 'bitcoin' } }, db), /Unknown/);
  s = finance.updateFinanceSettings({ payfastFees: { methods: [{ key: 'zapper', pct: 99 }] } }, db);
  assert.equal(s.payfastFees.methods.find((m) => m.key === 'zapper').pct, 20, 'percent capped at 20');
});

test('the actual fee Payfast reports on the payment replaces the estimate', () => {
  const o = orders.createOrder({ customer, delivery: { [smdId()]: 'courier' }, items: [{ productId: smdProduct().id, quantity: 1 }] });
  orders.markOrderPaid(o.id, { pfPaymentId: 'pf', feeCents: 1234 });
  db.prepare("UPDATE orders SET paid_at = '2026-09-10T08:00:00.000Z' WHERE id = ?").run(o.id);
  assert.equal(totals().payfastFeesCents, 1234);
  assert.equal(finance.getFinancialOverview(SEPT, db).assumptions.actualFeeOrders, 1);
});

test('Instant EFT is refused while it is switched off, or outside its order limits', () => {
  const order = (qty = 1) => orders.createOrder({ customer, paymentMethod: 'payfast_eft', delivery: { [smdId()]: 'collect' }, items: [{ productId: smdProduct().id, quantity: qty }] });
  assert.throws(() => order(), /Instant EFT is not available/);
  assert.deepEqual(finance.publicPaymentOptions(db), { eft: { enabled: false, minCents: 500, maxCents: 1000000 } });
  finance.updateFinanceSettings({ payfastFees: { methods: [{ key: 'instant_eft', enabled: true, maxCents: 20000 }] } }, db);
  assert.equal(order(1).paymentMethod, 'payfast_eft'); // R127
  assert.throws(() => order(2), /only available for orders from R5.00 to R200.00/); // R254
  assert.equal(orders.createOrder({ customer, delivery: { [smdId()]: 'collect' }, items: [{ productId: smdProduct().id, quantity: 2 }] }).paymentMethod, 'payfast_card');
});

test('cancelled orders are excluded even when paid, and reported separately', () => {
  const keep = paid({ delivery: { [smdId()]: 'courier' }, items: [{ productId: smdProduct().id, quantity: 1 }] });
  const gone = paid({ delivery: { [smdId()]: 'courier' }, items: [{ productId: smdProduct().id, quantity: 3 }] });
  orders.cancelOrder(gone.id);
  orders.createOrder({ customer, delivery: { [smdId()]: 'courier' }, items: [{ productId: smdProduct().id, quantity: 1 }] }); // never paid
  const t = totals();
  assert.equal(t.orders, 1);
  assert.equal(t.incomeCents, keep.totalCents);
  assert.equal(t.cancelledOrders, 1);
  assert.equal(t.cancelledCents, gone.totalCents);
  const ov = finance.getFinancialOverview({ ...SEPT, now: new Date('2026-09-28T10:00:00Z') }, db);
  assert.equal(ov.cancelled.length, 1);
  assert.equal(ov.cancelled[0].orderNumber, gone.orderNumber);
});

test('expenses: line items, validation, totals by month and category, and profit', () => {
  assert.throws(() => finance.saveExpense({ date: '2026-09-01', items: [{ description: 'Ads', unitCents: 100 }] }, null, db), /who you paid/);
  assert.throws(() => finance.saveExpense({ payee: 'Google', date: '2026-02-31', amountCents: 100 }, null, db), /date/);
  assert.throws(() => finance.saveExpense({ payee: 'Google', date: '2026-09-01', items: [] }, null, db), /at least one line/);
  assert.throws(() => finance.saveExpense({ payee: 'Google', date: '2026-09-01', items: [{ description: 'Free', unitCents: 0 }] }, null, db), /more than R0/);

  const aug = finance.saveExpense({ payee: 'Afrihost', date: '2026-08-15', items: [{ description: 'Domain', category: 'Hosting & domain', quantity: 1, unitCents: 9900 }] }, null, db);
  const sep = finance.saveExpense({
    payee: 'Google',
    date: '2026-09-02',
    reference: 'INV-77',
    items: [
      { description: 'Search ads', category: 'Advertising', quantity: 2, unitCents: 25000 },
      { description: 'Workspace', category: 'Software', quantity: 1.5, unitCents: 10001 },
    ],
  }, null, db);
  assert.equal(sep.totalCents, 50000 + 15002);
  const quick = finance.saveExpense({ payee: 'FNB', date: '2026-09-30', category: 'Bank charges', amountCents: 6500 }, null, db);
  assert.equal(quick.items[0].description, 'Bank charges');

  // Edit replaces the lines; delete removes them.
  const edited = finance.saveExpense({ items: [{ description: 'Domain + hosting', category: 'Hosting & domain', quantity: 1, unitCents: 19900 }] }, aug.id, db);
  assert.equal(edited.totalCents, 19900);
  assert.equal(edited.payee, 'Afrihost');
  assert.equal(finance.saveExpense({ payee: 'x', amountCents: 1 }, 'nope', db), null);

  const all = finance.listExpenses({}, db);
  assert.equal(all.total, 3);
  assert.equal(all.totalCents, 19900 + 65002 + 6500);
  assert.deepEqual(all.byMonth, [{ month: '2026-09', totalCents: 71502 }, { month: '2026-08', totalCents: 19900 }]);
  assert.equal(all.byCategory[0].category, 'Advertising');
  const ads = finance.listExpenses({ category: 'Advertising' }, db);
  assert.equal(ads.total, 1);
  assert.equal(ads.totalCents, 50000); // only that category's lines
  assert.equal(finance.listExpenses({ q: 'inv-77' }, db).total, 1);
  assert.equal(finance.listExpenses({ from: '2026-09-01', to: '2026-09-29' }, db).total, 1);

  // Orders: one paid 23:30 on 31 Aug UTC = 01:30 on 1 Sept in South Africa.
  paid({ delivery: { [smdId()]: 'courier' }, items: [{ productId: smdProduct().id, quantity: 2 }] }, '2026-08-31T23:30:00.000Z');
  paid({ delivery: { [smdId()]: 'collect' }, items: [{ productId: smdProduct().id, quantity: 1 }] }, '2026-08-20T10:00:00.000Z');
  const ov = finance.getFinancialOverview({ from: '2026-08-01', to: '2026-09-30', now: new Date('2026-09-28T10:00:00Z') }, db);
  assert.deepEqual(ov.months.map((m) => m.month), ['2026-08', '2026-09']);
  const [m8, m9] = ov.months;
  assert.equal(m8.orders, 1);
  assert.equal(m9.orders, 1);
  assert.equal(m8.expensesCents, 19900);
  assert.equal(m9.expensesCents, 71502);
  for (const m of [m8, m9, ov.totals]) {
    assert.equal(m.profitCents, m.incomeCents - m.cogsCents - m.deliveryCostCents - m.payfastFeesCents - m.expensesCents);
  }
  assert.equal(m9.incomeCents, 40400);
  assert.equal(ov.totals.expensesCents, 91402);
  assert.deepEqual(ov.expensesByCategory.map((c) => c.category), ['Advertising', 'Hosting & domain', 'Software', 'Bank charges']);
  assert.equal(ov.compare.thisMonth.label, '2026-09');
  assert.equal(ov.compare.lastMonth.to, '2026-08-31');
  assert.equal(ov.compare.lastMonth.orders, 1);
  assert.equal(ov.ytd.taxYear.from, '2026-03-01');
  assert.equal(ov.ytd.calendar.orders, 2);

  assert.ok(finance.deleteExpense(quick.id, db));
  assert.equal(finance.listExpenses({}, db).total, 2);
});

test('expense categories are an editable list', () => {
  assert.ok(finance.getFinanceSettings(db).expenseCategories.includes('Advertising'));
  const s = finance.updateFinanceSettings({ expenseCategories: ['Advertising', ' advertising ', 'Packaging', ''] }, db);
  assert.deepEqual(s.expenseCategories, ['Advertising', 'Packaging']);
  assert.throws(() => finance.updateFinanceSettings({ expenseCategories: [] }, db), /at least one/);
});

test('dashboard: sales windows, work queues, low-margin products and top sellers', () => {
  const now = new Date('2026-09-28T10:00:00Z');
  const smd = smdId();
  const mouse = smdProduct({ name: 'Mouse' });
  const collect = paid({ delivery: { [smd]: 'collect' }, items: [{ productId: mouse.id, quantity: 3 }] }, '2026-09-28T07:00:00.000Z');
  paid({ delivery: { [smd]: 'courier' }, items: [{ productId: smdProduct({ name: 'Cable' }).id, quantity: 1 }] }, '2026-09-24T07:00:00.000Z');
  paid({ delivery: { [smd]: 'courier' }, items: [{ productId: mouse.id, quantity: 1 }] }, '2026-09-05T07:00:00.000Z');
  const old = paid({ delivery: { [smd]: 'courier' }, items: [{ productId: mouse.id, quantity: 9 }] }, '2026-07-01T07:00:00.000Z');
  orders.updateOrder(old.id, { status: 'ordered' });
  const cancelled = paid({ delivery: { [smd]: 'collect' }, items: [{ productId: mouse.id, quantity: 1 }] }, '2026-09-28T08:00:00.000Z');
  orders.cancelOrder(cancelled.id);
  const quote = paid({ items: [{ productId: product({ name: 'Printer', quoteDelivery: '1' }).id, quantity: 1 }] }, '2026-09-27T07:00:00.000Z');
  assert.equal(quote.deliveryQuote, true);
  // Priced by hand below cost incl VAT (R100 x 1.15 = R115).
  const cheap = product({ name: 'Too cheap', priceMode: 'manual', priceCents: 11000 });

  const d = finance.getDashboard({ now }, db);
  assert.equal(d.today, '2026-09-28');
  assert.equal(d.sales.today.orders, 1); // cancelled one excluded
  assert.equal(d.sales.today.totalCents, collect.totalCents);
  assert.equal(d.sales.days7.orders, 3);
  assert.equal(d.sales.days30.orders, 4);
  assert.equal(d.series30.length, 30);
  assert.equal(d.series30.at(-1).totalCents, collect.totalCents);
  assert.equal(d.ordersToProcess.count, 4); // paid, not yet ordered (not the 'ordered' or cancelled one)
  assert.equal(d.collectionsWaiting.count, 1);
  assert.equal(d.collectionsWaiting.items[0].orderNumber, collect.orderNumber);
  assert.equal(d.deliveryQuotesPending.count, 1);
  assert.equal(d.lowMargin.count, 1);
  assert.equal(d.lowMargin.items[0].id, cheap.id);
  assert.equal(d.lowMargin.items[0].costInclVatCents, 11500);
  assert.equal(d.topProducts[0].name, 'Mouse');
  assert.equal(d.topProducts[0].quantity, 4); // last 30 days only, cancelled excluded
  assert.ok(d.latestOrders.length >= 5);

  orders.markCollectionReady(collect.id);
  assert.equal(finance.getDashboard({ now }, db).collectionsWaiting.count, 0);
});
