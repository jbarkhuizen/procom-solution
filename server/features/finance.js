// Finance feature (Phase 2): Financial overview, Expenses and the admin
// Dashboard's numbers. Ported from Lapanza3d's expenses.js / finance
// overview, adapted to Procom (integer cents, not VAT-registered, dropship).
//
// Owner decision (2026-09-28): automatic figures from the orders + expenses
// captured by hand, per month (South African time) and for any date range.
//
// How each number is worked out (also shown on the admin page):
//   Income         paid orders (payment_status 'paid'), dated by paid_at in
//                  SAST. Cancelled orders are left out even if paid, and
//                  reported on their own line (they are normally refunded).
//     goods          subtotal - discount
//     delivery       shipping_cents (what the customer paid for delivery)
//     total          total_cents (= goods + delivery)
//   Cost of goods  sum(order_items.unit_cost_cents x quantity) x (1 + VAT):
//                  supplier costs are excl VAT and, as Procom is not
//                  VAT-registered, the supplier's VAT is a cost to us.
//   Delivery cost  per shipment in orders.fulfilment_json: courier = its
//                  feeCents (SMD charges us what we charge the customer, and
//                  nothing when the order qualified for free delivery);
//                  store-wide options = the fee charged; collection and
//                  delivery quotes = R0. An admin override per order
//                  (finance_delivery_costs) wins when set.
//   Payfast fees   ESTIMATE per order: total x % + fixed amount (with a
//                  minimum), per payment method (card / Instant EFT), plus
//                  VAT on the fee when "Payfast adds VAT" is on. Adjust to the
//                  Payfast statement in the finance settings.
//   Expenses       captured by hand, dated by the expense date.
//   Profit         income - cost of goods - delivery cost - Payfast fees -
//                  expenses.
//   Gross margin   (goods - cost of goods) / goods.
import { randomUUID } from 'crypto';
import { getDb } from '../db.js';
import { getSettings } from '../settings.js';

// ------------------------------------------------------------ settings

// Payfast's published aggregation pricing (payfast.io/fees, checked
// 2026-09-28): card 3.2% + R2.00, Instant EFT 2% (minimum R2.00), both
// excluding VAT. Only an estimate -- the owner adjusts it to the statement.
export const DEFAULT_FINANCE_SETTINGS = {
  payfastFees: {
    card: { pct: 3.2, fixedCents: 200, minCents: 0 },
    eft: { pct: 2, fixedCents: 0, minCents: 200 },
    addVat: true,
  },
  expenseCategories: ['Advertising', 'Hosting & domain', 'Software', 'Bank charges', 'Delivery', 'Stock / samples', 'Other'],
  expensePaymentMethods: ['Business account', 'Credit card', 'Cash'],
};

const num = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const cleanText = (v, max) => String(v ?? '').trim().slice(0, max);

function cleanFeeRule(r, fallback) {
  const src = r && typeof r === 'object' ? r : {};
  return {
    pct: Math.round(num(src.pct, 0, 20, fallback.pct) * 1000) / 1000,
    fixedCents: Math.round(num(src.fixedCents, 0, 100000, fallback.fixedCents)),
    minCents: Math.round(num(src.minCents, 0, 100000, fallback.minCents)),
  };
}

function cleanList(list, fallback, max = 40) {
  if (!Array.isArray(list)) return fallback;
  const seen = new Set();
  const out = [];
  for (const v of list) {
    const s = cleanText(v, 60);
    if (s && !seen.has(s.toLowerCase())) {
      seen.add(s.toLowerCase());
      out.push(s);
    }
  }
  return out.slice(0, max);
}

export function getFinanceSettings(db = getDb()) {
  const stored = {};
  for (const row of db.prepare('SELECT key, value FROM finance_settings').all()) {
    try {
      stored[row.key] = JSON.parse(row.value);
    } catch { /* ignore a corrupt value -> default */ }
  }
  const d = DEFAULT_FINANCE_SETTINGS;
  const fees = stored.payfastFees || {};
  return {
    payfastFees: {
      card: cleanFeeRule(fees.card, d.payfastFees.card),
      eft: cleanFeeRule(fees.eft, d.payfastFees.eft),
      addVat: typeof fees.addVat === 'boolean' ? fees.addVat : d.payfastFees.addVat,
    },
    expenseCategories: stored.expenseCategories ? cleanList(stored.expenseCategories, d.expenseCategories) : [...d.expenseCategories],
    expensePaymentMethods: stored.expensePaymentMethods ? cleanList(stored.expensePaymentMethods, d.expensePaymentMethods) : [...d.expensePaymentMethods],
  };
}

export function updateFinanceSettings(patch = {}, db = getDb()) {
  const cur = getFinanceSettings(db);
  const next = { ...cur };
  if (patch.payfastFees && typeof patch.payfastFees === 'object') {
    next.payfastFees = {
      card: cleanFeeRule(patch.payfastFees.card, cur.payfastFees.card),
      eft: cleanFeeRule(patch.payfastFees.eft, cur.payfastFees.eft),
      addVat: patch.payfastFees.addVat === undefined ? cur.payfastFees.addVat : Boolean(patch.payfastFees.addVat),
    };
  }
  if (patch.expenseCategories !== undefined) {
    next.expenseCategories = cleanList(patch.expenseCategories, cur.expenseCategories);
    if (!next.expenseCategories.length) throw new Error('Keep at least one expense category');
  }
  if (patch.expensePaymentMethods !== undefined) next.expensePaymentMethods = cleanList(patch.expensePaymentMethods, cur.expensePaymentMethods);
  const up = db.prepare('INSERT INTO finance_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  db.transaction(() => {
    for (const k of ['payfastFees', 'expenseCategories', 'expensePaymentMethods']) up.run(k, JSON.stringify(next[k]));
  })();
  return getFinanceSettings(db);
}

// ------------------------------------------------------------ dates (SAST)

// South Africa is UTC+2 all year (no daylight saving).
const SAST_MS = 2 * 3600 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const sastDate = (iso) => new Date(Date.parse(iso) + SAST_MS).toISOString().slice(0, 10);
export const todaySast = (now = new Date()) => sastDate(now.toISOString());
const utcStartOf = (ymd) => new Date(Date.parse(`${ymd}T00:00:00Z`) - SAST_MS).toISOString();
export function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
const isDate = (s) => DATE_RE.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const monthEnd = (ym) => addDays(`${addMonths(ym, 1)}-01`, -1);
// SA tax year: 1 March to end of February.
const taxYearStart = (ymd) => {
  const [y, m] = ymd.split('-').map(Number);
  return `${m >= 3 ? y : y - 1}-03-01`;
};

// SQL expression for "when the order was paid" (paid_at is always set by
// markOrderPaid; created_at is a fallback for hand-edited rows).
const PAID_AT = "COALESCE(NULLIF(o.paid_at, ''), o.created_at)";

// ------------------------------------------------------------ per-order figures

function parseShipments(row) {
  try {
    const v = JSON.parse(row.fulfilment_json || 'null');
    if (Array.isArray(v)) return v;
  } catch { /* legacy order */ }
  // Orders from before per-supplier delivery: one shipment from the old fields
  // (same fallback as orders.js).
  return [{ method: row.collection ? 'collect' : row.delivery_quote ? 'quote' : 'store', feeCents: row.shipping_cents, readyAt: row.collection_ready_at || '' }];
}

// What delivery cost us for this order, by the documented rule.
export function deliveryCostCents(row) {
  if (row.override_cost_cents != null) return row.override_cost_cents;
  return parseShipments(row).reduce((t, sh) => t + (sh.method === 'courier' || sh.method === 'store' ? Math.max(0, Number(sh.feeCents) || 0) : 0), 0);
}

export function estimatePayfastFee(totalCents, paymentMethod, fees, vatRatePct = 15) {
  if (!(totalCents > 0)) return 0;
  const rule = paymentMethod === 'payfast_eft' ? fees.eft : fees.card;
  const base = Math.max((totalCents * rule.pct) / 100 + rule.fixedCents, rule.minCents);
  return Math.round(fees.addVat ? base * (1 + vatRatePct / 100) : base);
}

function context(db) {
  const s = getSettings(db);
  const vatRatePct = Number(s.vatRatePct) || 0;
  return { vatRatePct, vat: 1 + vatRatePct / 100, fees: getFinanceSettings(db).payfastFees };
}

function orderFigures(row, ctx) {
  const goods = row.subtotal_cents - (row.discount_cents || 0);
  return {
    goodsCents: goods,
    discountCents: row.discount_cents || 0,
    deliveryChargedCents: row.shipping_cents,
    incomeCents: row.total_cents,
    cogsCents: Math.round((row.cost_excl_cents || 0) * ctx.vat),
    deliveryCostCents: deliveryCostCents(row),
    payfastFeesCents: estimatePayfastFee(row.total_cents, row.payment_method, ctx.fees, ctx.vatRatePct),
  };
}

// Paid orders whose payment falls in [fromYmd, toYmd] (SAST, inclusive),
// cancelled ones included (callers split them out).
function paidOrders(fromYmd, toYmd, db) {
  return db.prepare(`SELECT o.*, ${PAID_AT} AS paid_when,
      (SELECT COALESCE(SUM(unit_cost_cents * quantity), 0) FROM order_items WHERE order_id = o.id) AS cost_excl_cents,
      fdc.cost_cents AS override_cost_cents
    FROM orders o LEFT JOIN finance_delivery_costs fdc ON fdc.order_id = o.id
    WHERE o.payment_status = 'paid' AND ${PAID_AT} >= ? AND ${PAID_AT} < ?
    ORDER BY paid_when`).all(utcStartOf(fromYmd), utcStartOf(addDays(toYmd, 1)));
}

function expenseRows(fromYmd, toYmd, db) {
  return db.prepare('SELECT * FROM finance_expenses WHERE expense_date >= ? AND expense_date <= ? ORDER BY expense_date').all(fromYmd, toYmd);
}

const FIELDS = ['goodsCents', 'discountCents', 'deliveryChargedCents', 'incomeCents', 'cogsCents', 'deliveryCostCents', 'payfastFeesCents'];

function emptyTotals() {
  const t = { orders: 0, expensesCents: 0, cancelledOrders: 0, cancelledCents: 0 };
  for (const f of FIELDS) t[f] = 0;
  return t;
}

function addOrder(t, row, ctx) {
  if (row.status === 'cancelled') {
    t.cancelledOrders += 1;
    t.cancelledCents += row.total_cents;
    return;
  }
  const f = orderFigures(row, ctx);
  t.orders += 1;
  for (const k of FIELDS) t[k] += f[k];
}

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

function finish(t) {
  t.grossProfitCents = t.goodsCents - t.cogsCents;
  t.grossMarginPct = pct(t.grossProfitCents, t.goodsCents);
  t.profitCents = t.incomeCents - t.cogsCents - t.deliveryCostCents - t.payfastFeesCents - t.expensesCents;
  t.profitMarginPct = pct(t.profitCents, t.incomeCents);
  return t;
}

// Totals for [fromYmd, toYmd] inclusive (SAST dates).
export function financeTotals(fromYmd, toYmd, db = getDb()) {
  const ctx = context(db);
  const t = emptyTotals();
  for (const row of paidOrders(fromYmd, toYmd, db)) addOrder(t, row, ctx);
  for (const e of expenseRows(fromYmd, toYmd, db)) t.expensesCents += e.total_cents;
  return finish(t);
}

function cleanRange(from, to, now) {
  const today = todaySast(now);
  let toYmd = isDate(to) ? to : today;
  let fromYmd = isDate(from) ? from : `${addMonths(toYmd.slice(0, 7), -11)}-01`;
  if (fromYmd > toYmd) [fromYmd, toYmd] = [toYmd, fromYmd];
  // At most ~10 years of monthly buckets.
  if (Date.parse(toYmd) - Date.parse(fromYmd) > 3660 * 86400000) fromYmd = addDays(toYmd, -3660);
  return { fromYmd, toYmd, today };
}

// The Financial overview: totals + month-by-month for a date range (default:
// the last 12 months), this month vs last month, year-to-date summaries, and
// expenses by category.
export function getFinancialOverview({ from, to, now = new Date() } = {}, db = getDb()) {
  const { fromYmd, toYmd, today } = cleanRange(from, to, now);
  const ctx = context(db);

  const months = [];
  for (let ym = fromYmd.slice(0, 7); ym <= toYmd.slice(0, 7); ym = addMonths(ym, 1)) months.push({ month: ym, ...emptyTotals() });
  const byMonth = new Map(months.map((m) => [m.month, m]));
  const totals = emptyTotals();
  const cancelled = [];
  for (const row of paidOrders(fromYmd, toYmd, db)) {
    const m = byMonth.get(sastDate(row.paid_when).slice(0, 7));
    addOrder(totals, row, ctx);
    if (m) addOrder(m, row, ctx);
    if (row.status === 'cancelled') cancelled.push({ id: row.id, orderNumber: row.order_number, paidAt: row.paid_when, totalCents: row.total_cents });
  }
  for (const e of expenseRows(fromYmd, toYmd, db)) {
    totals.expensesCents += e.total_cents;
    const m = byMonth.get(e.expense_date.slice(0, 7));
    if (m) m.expensesCents += e.total_cents;
  }
  months.forEach(finish);
  finish(totals);

  const expensesByCategory = db.prepare(`SELECT CASE WHEN i.category = '' THEN 'Uncategorised' ELSE i.category END AS category, SUM(i.line_cents) AS totalCents
    FROM finance_expense_items i JOIN finance_expenses e ON e.id = i.expense_id
    WHERE e.expense_date >= ? AND e.expense_date <= ? GROUP BY 1 ORDER BY totalCents DESC`).all(fromYmd, toYmd);

  const thisMonth = today.slice(0, 7);
  const lastMonth = addMonths(thisMonth, -1);
  const taxFrom = taxYearStart(today);
  const settings = getFinanceSettings(db);
  return {
    from: fromYmd,
    to: toYmd,
    today,
    totals,
    months,
    cancelled,
    expensesByCategory,
    compare: {
      thisMonth: { label: thisMonth, from: `${thisMonth}-01`, to: today, ...financeTotals(`${thisMonth}-01`, today, db) },
      lastMonth: { label: lastMonth, from: `${lastMonth}-01`, to: monthEnd(lastMonth), ...financeTotals(`${lastMonth}-01`, monthEnd(lastMonth), db) },
    },
    ytd: {
      calendar: { label: `${today.slice(0, 4)} to date`, from: `${today.slice(0, 4)}-01-01`, to: today, ...financeTotals(`${today.slice(0, 4)}-01-01`, today, db) },
      taxYear: { label: `Tax year ${taxFrom.slice(0, 4)}/${String(Number(taxFrom.slice(0, 4)) + 1).slice(2)} to date`, from: taxFrom, to: today, ...financeTotals(taxFrom, today, db) },
    },
    assumptions: {
      vatRatePct: ctx.vatRatePct,
      payfastFees: settings.payfastFees,
      deliveryOverrides: db.prepare('SELECT COUNT(*) n FROM finance_delivery_costs').get().n,
    },
  };
}

// ------------------------------------------------------------ expenses

function rowToExpense(r, items = []) {
  return {
    id: r.id,
    payee: r.payee,
    date: r.expense_date,
    reference: r.reference,
    paymentMethod: r.payment_method,
    notes: r.notes,
    totalCents: r.total_cents,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    items: items.map((i) => ({ id: i.id, description: i.description, category: i.category, quantity: i.quantity, unitCents: i.unit_cents, lineCents: i.line_cents })),
  };
}

// Accepts line items ({description, category, quantity, unitCents}) or, for
// a quick capture, one amount ({amountCents, category}).
function normalizeItems(data) {
  let list = Array.isArray(data.items) ? data.items : [];
  if (!list.length && data.amountCents != null) {
    list = [{ description: cleanText(data.description, 300) || cleanText(data.category, 100) || 'Expense', category: data.category, quantity: 1, unitCents: data.amountCents }];
  }
  const items = list
    .slice(0, 100)
    .map((i) => {
      const quantity = Math.round(num(i.quantity ?? 1, 0.01, 100000, 1) * 100) / 100;
      const unitCents = Math.round(num(i.unitCents, 0, 1e11, NaN));
      return { description: cleanText(i.description, 300), category: cleanText(i.category, 60), quantity, unitCents, lineCents: Math.round(quantity * unitCents) };
    })
    .filter((i) => i.description || i.unitCents);
  if (!items.length) throw new Error('Add at least one line with a description and an amount');
  for (const i of items) {
    if (!i.description) throw new Error('Every line needs a description');
    if (!Number.isFinite(i.unitCents)) throw new Error(`Enter an amount for “${i.description}”`);
  }
  if (!items.some((i) => i.lineCents > 0)) throw new Error('The expense total must be more than R0');
  return items;
}

export function getExpense(id, db = getDb()) {
  const r = db.prepare('SELECT * FROM finance_expenses WHERE id = ?').get(id);
  if (!r) return null;
  return rowToExpense(r, db.prepare('SELECT * FROM finance_expense_items WHERE expense_id = ? ORDER BY position').all(id));
}

export function saveExpense(data = {}, id = null, db = getDb()) {
  const existing = id ? getExpense(id, db) : null;
  if (id && !existing) return null;
  const payee = cleanText(data.payee ?? existing?.payee, 200);
  if (!payee) throw new Error('Enter who you paid (supplier / payee)');
  const date = String(data.date ?? existing?.date ?? todaySast());
  if (!isDate(date)) throw new Error('Enter the expense date');
  const items = data.items === undefined && data.amountCents == null && existing ? normalizeItems({ items: existing.items }) : normalizeItems(data);
  const total = items.reduce((t, i) => t + i.lineCents, 0);
  const ts = new Date().toISOString();
  const expenseId = id || randomUUID();
  const fields = {
    id: expenseId,
    payee,
    date,
    reference: cleanText(data.reference ?? existing?.reference, 100),
    paymentMethod: cleanText(data.paymentMethod ?? existing?.paymentMethod, 100),
    notes: cleanText(data.notes ?? existing?.notes, 2000),
    total,
    ts,
  };
  db.transaction(() => {
    if (existing) {
      db.prepare('UPDATE finance_expenses SET payee = @payee, expense_date = @date, reference = @reference, payment_method = @paymentMethod, notes = @notes, total_cents = @total, updated_at = @ts WHERE id = @id').run(fields);
      db.prepare('DELETE FROM finance_expense_items WHERE expense_id = ?').run(expenseId);
    } else {
      db.prepare('INSERT INTO finance_expenses (id, payee, expense_date, reference, payment_method, notes, total_cents, created_at, updated_at) VALUES (@id, @payee, @date, @reference, @paymentMethod, @notes, @total, @ts, @ts)').run(fields);
    }
    const ins = db.prepare('INSERT INTO finance_expense_items (id, expense_id, position, description, category, quantity, unit_cents, line_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    items.forEach((i, n) => ins.run(randomUUID(), expenseId, n, i.description, i.category, i.quantity, i.unitCents, i.lineCents));
  })();
  return getExpense(expenseId, db);
}

export function deleteExpense(id, db = getDb()) {
  return db.prepare('DELETE FROM finance_expenses WHERE id = ?').run(id).changes > 0;
}

export function listExpenses({ q, category, from, to } = {}, db = getDb()) {
  const where = [];
  const params = {};
  if (isDate(from)) { where.push('expense_date >= @from'); params.from = from; }
  if (isDate(to)) { where.push('expense_date <= @to'); params.to = to; }
  const rows = db.prepare(`SELECT * FROM finance_expenses ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY expense_date DESC, created_at DESC`).all(params);
  const itemsBy = new Map();
  if (rows.length) {
    for (const i of db.prepare(`SELECT i.* FROM finance_expense_items i JOIN finance_expenses e ON e.id = i.expense_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY i.position`).all(params)) {
      if (!itemsBy.has(i.expense_id)) itemsBy.set(i.expense_id, []);
      itemsBy.get(i.expense_id).push(i);
    }
  }
  let list = rows.map((r) => rowToExpense(r, itemsBy.get(r.id) || []));
  const cat = cleanText(category, 60);
  if (cat) list = list.filter((e) => e.items.some((i) => (i.category || 'Uncategorised') === cat));
  const needle = cleanText(q, 100).toLowerCase();
  if (needle) {
    list = list.filter((e) => [e.payee, e.reference, e.paymentMethod, e.notes, ...e.items.map((i) => `${i.description} ${i.category}`)].some((v) => String(v || '').toLowerCase().includes(needle)));
  }
  // With a category filter, totals count only that category's lines.
  const lineIn = (i) => !cat || (i.category || 'Uncategorised') === cat;
  const byCategory = new Map();
  const byMonth = new Map();
  let totalCents = 0;
  for (const e of list) {
    for (const i of e.items.filter(lineIn)) {
      const c = i.category || 'Uncategorised';
      byCategory.set(c, (byCategory.get(c) || 0) + i.lineCents);
      byMonth.set(e.date.slice(0, 7), (byMonth.get(e.date.slice(0, 7)) || 0) + i.lineCents);
      totalCents += i.lineCents;
    }
  }
  return {
    items: list,
    total: list.length,
    totalCents,
    byCategory: [...byCategory].map(([category, cents]) => ({ category, totalCents: cents })).sort((a, b) => b.totalCents - a.totalCents),
    byMonth: [...byMonth].map(([month, cents]) => ({ month, totalCents: cents })).sort((a, b) => b.month.localeCompare(a.month)),
  };
}

// ------------------------------------------------------------ delivery cost overrides

function findOrder(ref, db) {
  const s = cleanText(ref, 80);
  return db.prepare('SELECT * FROM orders WHERE id = ? OR UPPER(order_number) = UPPER(?)').get(s, s);
}

export function listDeliveryCostOverrides(db = getDb()) {
  return db.prepare(`SELECT o.id, o.order_number, o.shipping_cents, o.fulfilment_json, o.collection, o.delivery_quote, f.cost_cents, f.note, f.updated_at
    FROM finance_delivery_costs f JOIN orders o ON o.id = f.order_id ORDER BY f.updated_at DESC`).all()
    .map((r) => ({ orderId: r.id, orderNumber: r.order_number, deliveryChargedCents: r.shipping_cents, ruleCostCents: deliveryCostCents({ ...r, override_cost_cents: null }), costCents: r.cost_cents, note: r.note, updatedAt: r.updated_at }));
}

// costCents null/'' removes the override (back to the rule).
export function setDeliveryCost(orderRef, { costCents, note } = {}, db = getDb()) {
  const o = findOrder(orderRef, db);
  if (!o) throw Object.assign(new Error('No order with that number'), { status: 404 });
  if (costCents === null || costCents === undefined || costCents === '') {
    db.prepare('DELETE FROM finance_delivery_costs WHERE order_id = ?').run(o.id);
    return { orderId: o.id, orderNumber: o.order_number, removed: true };
  }
  const cents = Math.round(Number(costCents));
  if (!Number.isFinite(cents) || cents < 0 || cents > 1e9) throw new Error('Enter the delivery cost in rand (0 or more)');
  db.prepare(`INSERT INTO finance_delivery_costs (order_id, cost_cents, note, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(order_id) DO UPDATE SET cost_cents = excluded.cost_cents, note = excluded.note, updated_at = excluded.updated_at`).run(o.id, cents, cleanText(note, 300), new Date().toISOString());
  return { orderId: o.id, orderNumber: o.order_number, costCents: cents };
}

// ------------------------------------------------------------ dashboard

export function getDashboard({ now = new Date() } = {}, db = getDb()) {
  const today = todaySast(now);
  const from30 = addDays(today, -29);
  const ctx = context(db);
  const rows = paidOrders(from30, today, db).filter((r) => r.status !== 'cancelled');

  const days = [];
  for (let d = from30; d <= today; d = addDays(d, 1)) days.push({ date: d, orders: 0, totalCents: 0 });
  const byDay = new Map(days.map((d) => [d.date, d]));
  for (const r of rows) {
    const d = byDay.get(sastDate(r.paid_when));
    if (d) { d.orders += 1; d.totalCents += r.total_cents; }
  }
  const salesSince = (fromYmd) => days.filter((d) => d.date >= fromYmd).reduce((t, d) => ({ orders: t.orders + d.orders, totalCents: t.totalCents + d.totalCents }), { orders: 0, totalCents: 0 });

  const open = db.prepare(`SELECT o.id, o.order_number, o.first_name, o.last_name, o.status, o.fulfilment_json, o.collection, o.delivery_quote, o.shipping_cents, o.collection_ready_at, o.paid_at
    FROM orders o WHERE o.payment_status = 'paid' AND o.status NOT IN ('cancelled', 'delivered') ORDER BY o.paid_at`).all();
  const collections = [];
  for (const o of open) {
    for (const sh of parseShipments(o)) {
      if (sh.method === 'collect' && !sh.readyAt) {
        collections.push({ id: o.id, orderNumber: o.order_number, customer: `${o.first_name} ${o.last_name}`.trim(), label: sh.label || '', paidAt: o.paid_at });
      }
    }
  }
  const quotes = open.filter((o) => o.delivery_quote && o.status === 'paid').map((o) => ({ id: o.id, orderNumber: o.order_number, customer: `${o.first_name} ${o.last_name}`.trim(), paidAt: o.paid_at }));
  const toProcess = open.filter((o) => o.status === 'paid').map((o) => ({ id: o.id, orderNumber: o.order_number, customer: `${o.first_name} ${o.last_name}`.trim(), paidAt: o.paid_at }));

  // Live products priced below what they cost us (cost incl VAT).
  const lowMarginSql = 'FROM products WHERE active = 1 AND cost_cents > 0 AND price_cents < CAST(ROUND(cost_cents * ?) AS INTEGER)';
  const lowMargin = {
    count: db.prepare(`SELECT COUNT(*) n ${lowMarginSql}`).get(ctx.vat).n,
    items: db.prepare(`SELECT id, name, sku, price_cents, cost_cents, price_mode ${lowMarginSql} ORDER BY (price_cents - cost_cents * ?) LIMIT 10`).all(ctx.vat, ctx.vat)
      .map((p) => ({ id: p.id, name: p.name, sku: p.sku, priceCents: p.price_cents, costInclVatCents: Math.round(p.cost_cents * ctx.vat), manual: p.price_mode === 'manual' })),
  };

  const topProducts = db.prepare(`SELECT COALESCE(oi.product_id, oi.sku) AS key, oi.product_id AS productId, MAX(oi.name) AS name, SUM(oi.quantity) AS quantity, SUM(oi.line_total_cents) AS revenueCents
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.payment_status = 'paid' AND o.status != 'cancelled' AND ${PAID_AT} >= ?
    GROUP BY key ORDER BY quantity DESC, revenueCents DESC LIMIT 8`).all(utcStartOf(from30));

  const latestOrders = db.prepare(`SELECT id, order_number, first_name, last_name, status, payment_status, total_cents, created_at, delivery_quote, collection
    FROM orders WHERE status != 'pending_payment' ORDER BY created_at DESC LIMIT 8`).all()
    .map((o) => ({ id: o.id, orderNumber: o.order_number, customer: `${o.first_name} ${o.last_name}`.trim(), status: o.status, totalCents: o.total_cents, createdAt: o.created_at, deliveryQuote: Boolean(o.delivery_quote), collection: Boolean(o.collection) }));

  return {
    today,
    sales: { today: salesSince(today), days7: salesSince(addDays(today, -6)), days30: salesSince(from30) },
    series30: days,
    monthToDate: financeTotals(`${today.slice(0, 7)}-01`, today, db),
    ordersToProcess: { count: toProcess.length, items: toProcess.slice(0, 8) },
    collectionsWaiting: { count: collections.length, items: collections.slice(0, 8) },
    deliveryQuotesPending: { count: quotes.length, items: quotes.slice(0, 8) },
    lowMargin,
    topProducts,
    latestOrders,
  };
}

// ------------------------------------------------------------ routes

const notFound = () => Object.assign(new Error('Not found'), { status: 404 });
const orNotFound = (v) => {
  if (!v) throw notFound();
  return v;
};

export function register({ admin, wrap }) {
  admin.get('/finance/dashboard', wrap(() => getDashboard()));
  admin.get('/finance/overview', wrap((req) => getFinancialOverview({ from: req.query.from, to: req.query.to })));
  admin.get('/finance/settings', wrap(() => getFinanceSettings()));
  admin.put('/finance/settings', wrap((req) => updateFinanceSettings(req.body || {})));

  admin.get('/finance/expenses', wrap((req) => {
    const s = getFinanceSettings();
    return { ...listExpenses(req.query), categories: s.expenseCategories, paymentMethods: s.expensePaymentMethods };
  }));
  admin.get('/finance/expenses/:id', wrap((req) => orNotFound(getExpense(req.params.id))));
  admin.post('/finance/expenses', wrap((req) => saveExpense(req.body || {})));
  admin.put('/finance/expenses/:id', wrap((req) => orNotFound(saveExpense(req.body || {}, req.params.id))));
  admin.delete('/finance/expenses/:id', wrap((req) => {
    if (!deleteExpense(req.params.id)) throw notFound();
    return { ok: true };
  }));

  admin.get('/finance/delivery-costs', wrap(() => listDeliveryCostOverrides()));
  admin.put('/finance/delivery-costs/:order', wrap((req) => setDeliveryCost(req.params.order, req.body || {})));
  admin.delete('/finance/delivery-costs/:order', wrap((req) => setDeliveryCost(req.params.order, { costCents: null })));
}
