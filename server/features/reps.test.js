import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';

process.env.UPLOADS_DIR = path.join(os.tmpdir(), 'procom-test-uploads');
process.env.DISABLE_BACKUPS = '1';

const { useMemoryDb } = await import('../db.js');
const catalog = await import('../catalog.js');
const orders = await import('../orders.js');
const reps = await import('./reps.js');
const promos = await import('./promos.js');
const finance = await import('./finance.js');

let db;
beforeEach(() => {
  db = useMemoryDb();
  // Payfast fees zeroed so the profit is easy to reason about; the fee path has its own check below.
  finance.updateFinanceSettings({ payfastFees: { methods: finance.DEFAULT_PAYFAST_METHODS.map((m) => ({ key: m.key, pct: 0, fixedCents: 0 })) } }, db);
});

const catId = (slug) => db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug).id;
const courierSmall = () => db.prepare("SELECT id FROM shipping_options WHERE name LIKE 'PUDO Small%'").get().id;
const customer = { firstName: 'Ann', lastName: 'Lee', email: 'ann@example.com', phone: '0821234567', addressLine1: '1 Main Rd', city: 'Pretoria', postalCode: '0081' };
const product = () => catalog.saveProduct({ name: 'Test Mouse', brand: 'Logi', costCents: 10000, categoryId: catId('keyboards-mice'), weightG: 200 });
const arnold = (over = {}) => reps.saveRep({ name: 'Arnold van Blerk', email: 'sales.3dbyted@gmail.com', percent: 50, code: '3DBYTED', ...over }, null, db);
const order = (p, over = {}, cust = customer) => orders.createOrder({ customer: cust, shippingOptionId: courierSmall(), items: [{ productId: p.id, quantity: 1 }], ...over }, db);
const paid = (o) => {
  orders.markOrderPaid(o.id, {}, db);
  return o;
};
const commissions = (repId) => db.prepare('SELECT * FROM rep_commissions WHERE rep_id = ? ORDER BY earned_at, rowid').all(repId);

test('a rep needs a name, a valid email and a free code', () => {
  assert.throws(() => reps.saveRep({ name: '', email: 'a@b.co' }, null, db), /name/);
  assert.throws(() => reps.saveRep({ name: 'X', email: 'nope' }, null, db), /email/);
  const r = arnold();
  assert.equal(r.codes[0].code, '3DBYTED');
  assert.match(r.codes[0].link, /\?ref=3DBYTED$/);
  assert.throws(() => arnold({ email: 'other@example.com' }), /already in use/);
  assert.throws(() => arnold({ email: 'third@example.com', code: 'x y' }), /A code is/);
  promos.savePromo({ code: 'SAVE5', kind: 'percent', percentOff: 5 });
  assert.throws(() => reps.addCode(r.id, { code: 'save5' }, db), /already in use/);
});

test('a rep code gives no discount and is not treated as a promo code', () => {
  const r = arnold();
  const p = product();
  const preview = promos.checkPromo({ code: '3dbyted', items: [{ productId: p.id, quantity: 1 }] }, db);
  assert.equal(preview.ok, true);
  assert.equal(preview.discountCents, 0);
  assert.equal(preview.partner, true);
  const o = order(p, { promoCode: '3dbyted' });
  assert.equal(o.discountCents, 0);
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id);
  assert.equal(row.rep_id, r.id);
  assert.equal(row.rep_code, '3DBYTED');
  assert.equal(row.promo_code, '');
});

test('commission is the rep share of the order profit, frozen at payment', () => {
  const r = arnold();
  const p = product();
  const o = paid(order(p, { promoCode: '3DBYTED' }));
  const fig = finance.orderProfit(o.id, db);
  assert.ok(fig.profitCents > 0);
  const [c] = commissions(r.id);
  assert.equal(c.kind, 'sale');
  assert.equal(c.profit_cents, fig.profitCents);
  assert.equal(c.commission_cents, Math.round(fig.profitCents / 2));
  assert.equal(c.status, 'pending');
  // R127 sold for R100 + 15% VAT cost: profit on the goods is R12 before delivery effects.
  assert.equal(fig.incomeCents - fig.cogsCents - fig.deliveryCostCents - fig.payfastFeesCents, fig.profitCents);
  // Changing the rep's rate or the prices later does not touch an earned commission.
  reps.saveRep({ name: r.name, email: r.email, percent: 10 }, r.id, db);
  db.prepare('UPDATE order_items SET unit_cost_cents = 99999').run();
  assert.equal(commissions(r.id)[0].commission_cents, Math.round(fig.profitCents / 2));
});

test('the Payfast fee comes off the profit before the split', () => {
  const r = arnold();
  const p = product();
  const o = order(p, { promoCode: '3DBYTED' });
  orders.markOrderPaid(o.id, { feeCents: 500 }, db);
  const fig = finance.orderProfit(o.id, db);
  assert.equal(fig.payfastFeesCents, 500);
  assert.equal(commissions(r.id)[0].commission_cents, Math.round(fig.profitCents / 2));
});

test('commission is never negative', () => {
  const r = arnold();
  const p = product();
  const o = order(p, { promoCode: '3DBYTED' });
  orders.markOrderPaid(o.id, { feeCents: 999999 }, db);
  assert.equal(commissions(r.id)[0].commission_cents, 0);
});

test('a customer stays with the rep for later orders; a typed code wins for that order', () => {
  const a = arnold();
  const b = reps.saveRep({ name: 'Bea', email: 'bea@example.com', percent: 30, code: 'BEA' }, null, db);
  const p = product();
  paid(order(p, { promoCode: '3DBYTED' }));
  // Same mailbox written differently, no code.
  const again = paid(order(p, {}, { ...customer, email: 'Ann+x@Example.com' }));
  assert.equal(db.prepare('SELECT rep_id FROM orders WHERE id = ?').get(again.id).rep_id, a.id);
  assert.equal(commissions(a.id).length, 2);
  // Typing Bea's code on a later order credits Bea for that order only.
  const viaBea = paid(order(p, { promoCode: 'bea' }));
  assert.equal(db.prepare('SELECT rep_id FROM orders WHERE id = ?').get(viaBea.id).rep_id, b.id);
  assert.equal(commissions(b.id).length, 1);
  assert.equal(commissions(a.id).length, 2);
  const next = paid(order(p, {}));
  assert.equal(db.prepare('SELECT rep_id FROM orders WHERE id = ?').get(next.id).rep_id, a.id);
});

test('an unpaid checkout does not claim the customer; a paused rep or code earns nothing', () => {
  const a = arnold();
  const p = product();
  order(p, { promoCode: '3DBYTED' }); // never paid
  assert.equal(db.prepare('SELECT COUNT(*) n FROM rep_customers').get().n, 0);
  paid(order(p, { promoCode: '3DBYTED' }));
  reps.saveRep({ name: a.name, email: a.email, percent: 50, active: false }, a.id, db);
  const o = order(p, {}, customer);
  assert.equal(db.prepare('SELECT rep_id FROM orders WHERE id = ?').get(o.id).rep_id, '');
  assert.equal(promos.checkPromo({ code: '3DBYTED', items: [{ productId: p.id, quantity: 1 }] }, db).ok, false);
});

test('commission becomes payable after the 48 hour hold', async () => {
  const r = arnold();
  const p = product();
  paid(order(p, { promoCode: '3DBYTED' }));
  const earned = new Date(commissions(r.id)[0].earned_at).getTime();
  let out = await reps.processReps({ now: new Date(earned + 47 * 3600_000), db });
  assert.equal(out.madePayable, 0);
  out = await reps.processReps({ now: new Date(earned + 49 * 3600_000), db });
  assert.equal(out.madePayable, 1);
  assert.equal(commissions(r.id)[0].status, 'payable');
  assert.equal(reps.payableFor(r.id, db).totalCents, commissions(r.id)[0].commission_cents);
});

test('cancel before payout reverses the commission', async () => {
  const r = arnold();
  const p = product();
  const o = paid(order(p, { promoCode: '3DBYTED' }));
  orders.cancelOrder(o.id, { reason: 'test' }, db);
  assert.equal(commissions(r.id)[0].status, 'reversed');
  const t = reps.getRep(r.id, {}, db).totals;
  assert.equal(t.orders, 0);
  assert.equal(t.owedCents, 0);
  assert.throws(() => reps.recordPayout(r.id, {}, db), /Nothing is payable/);
});

test('cancel after payout becomes a deduction on the next payout', async () => {
  const r = arnold();
  const p = product();
  const o1 = paid(order(p, { promoCode: '3DBYTED' }));
  await reps.processReps({ now: new Date(Date.now() + 49 * 3600_000), db });
  const first = reps.recordPayout(r.id, { reference: 'EFT1' }, db);
  const amount = first.payouts[0].amountCents;
  assert.ok(amount > 0);
  assert.equal(first.totals.paidCents, amount);
  orders.cancelOrder(o1.id, { reason: 'refund' }, db);
  const rows = commissions(r.id);
  assert.equal(rows.find((c) => c.kind === 'reversal').commission_cents, -amount);
  assert.equal(reps.payableFor(r.id, db).totalCents, -amount);
  // A new sale in the meantime is netted against the deduction.
  paid(order(p, { promoCode: '3DBYTED' }, { ...customer, email: 'bob@example.com' }));
  await reps.processReps({ now: new Date(Date.now() + 99 * 3600_000), db });
  assert.equal(reps.payableFor(r.id, db).totalCents, 0); // sale - deduction
  assert.throws(() => reps.recordPayout(r.id, {}, db), /Nothing is payable/);
});

test('minimum payout is enforced', async () => {
  const r = arnold();
  const p = product();
  paid(order(p, { promoCode: '3DBYTED' }));
  await reps.processReps({ now: new Date(Date.now() + 49 * 3600_000), db });
  reps.saveRepSettings({ minPayoutRand: 1000 }, db);
  assert.throws(() => reps.recordPayout(r.id, {}, db), /below the minimum/);
  reps.saveRepSettings({ minPayoutRand: 0 }, db);
  assert.ok(reps.recordPayout(r.id, {}, db).payouts.length === 1);
});

test('the report shows sales, commission and balances per rep, filtered by dates', () => {
  const r = arnold();
  const p = product();
  paid(order(p, { promoCode: '3DBYTED' }));
  paid(order(p, { promoCode: '3DBYTED' }, { ...customer, email: 'c@example.com' }));
  const all = reps.listReps({}, db);
  assert.equal(all.reps.length, 1);
  assert.equal(all.reps[0].totals.orders, 2);
  assert.equal(all.reps[0].totals.salesCents, 2 * db.prepare('SELECT total_cents FROM orders LIMIT 1').get().total_cents);
  assert.equal(all.total.owedCents, all.reps[0].totals.pendingCents);
  const detail = reps.getRep(r.id, { from: '2000-01-01', to: '2000-01-31' }, db);
  assert.equal(detail.commissions.length, 0);
  assert.equal(detail.totals.orders, 0);
  assert.equal(detail.totals.owedCents, all.reps[0].totals.owedCents); // balances ignore the dates
  assert.equal(reps.getRep(r.id, {}, db).commissions[0].customer, 'Ann Lee');
});

test('monthly statement goes out once, only when something happened', async () => {
  const r = arnold();
  const p = product();
  const o = paid(order(p, { promoCode: '3DBYTED' }));
  const when = new Date(db.prepare('SELECT paid_at FROM orders WHERE id = ?').get(o.id).paid_at);
  const sast = new Date(when.getTime() + 2 * 3600_000);
  const firstOfNext = new Date(Date.UTC(sast.getUTCFullYear(), sast.getUTCMonth() + 1, 1, 7, 0, 0)); // 09:00 SAST
  const out = await reps.processReps({ now: firstOfNext, db });
  assert.equal(out.statements, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM rep_statements WHERE rep_id = ?').get(r.id).n, 1);
  const again = await reps.processReps({ now: firstOfNext, db });
  assert.equal(again.statements, 0);
});
