// Sales reps: other people/companies who drive sales with their own code(s) and earn a share of the profit.
//
// Owner rules (2026-10-15):
//  - A rep code gives the customer NO discount; it only credits the sale to the rep. It is typed in the checkout's
//    promo box (or arrives through ?ref=CODE) and is never mixed up with promo codes.
//  - Commission = the rep's percent (Arnold: 50%) of the order's real profit, worked out like the Financial overview:
//    income - cost x VAT - delivery cost to us - Payfast fee. Never below R0. Delivery charged is part of income.
//  - Frozen when Payfast confirms payment (rate and profit never recalculated); payable 48 hours later; the owner
//    records each payout. A cancelled/refunded order reverses its commission (a payout that already went out
//    becomes a deduction on the next one).
//  - The customer's email stays with the rep whose code first paid; later orders credit the same rep with no code.
//    A code typed on a later order wins for that order.
//  - Reps may buy with their own code. No rep login: they get emails and a monthly statement; the owner is copied.
import { randomUUID } from 'crypto';
import { getDb } from '../db.js';
import { getSettings } from '../settings.js';
import { sendMailReliable, layout } from '../mailer.js';
import { escapeHtml, formatRand } from '../util.js';
import { normalEmail } from './promos.js';
import { orderProfit } from './finance.js';

const nowIso = () => new Date().toISOString();
const HOUR = 3600_000;
let siteUrl = (process.env.SITE_URL || 'https://www.procomsolutions.co.za').replace(/\/$/, '');

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const money = (c) => formatRand(c);
const sastDate = (iso) => new Date(new Date(iso).getTime() + 2 * HOUR).toISOString().slice(0, 10);
const sastDateTime = (iso) => new Date(new Date(iso).getTime() + 2 * HOUR).toISOString().slice(0, 16).replace('T', ' ');

// ---------------------------------------------------------------- settings

const SETTING_DEFAULTS = { holdHours: 48, minPayoutCents: 0 };

export function getRepSettings(db = getDb()) {
  const out = { ...SETTING_DEFAULTS };
  for (const r of db.prepare('SELECT key, value FROM rep_settings').all()) if (r.key in out && Number.isFinite(Number(r.value))) out[r.key] = Number(r.value);
  return out;
}

export function saveRepSettings(patch = {}, db = getDb()) {
  const next = {};
  if (patch.holdHours !== undefined) {
    const n = Math.round(Number(patch.holdHours));
    if (!Number.isFinite(n) || n < 0 || n > 24 * 60) throw bad('The hold must be between 0 and 1440 hours.');
    next.holdHours = n;
  }
  if (patch.minPayoutRand !== undefined) {
    const n = Math.round(Number(patch.minPayoutRand) * 100);
    if (!Number.isFinite(n) || n < 0) throw bad('The minimum payout cannot be negative.');
    next.minPayoutCents = n;
  }
  for (const [k, v] of Object.entries(next)) db.prepare('INSERT INTO rep_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
  return getRepSettings(db);
}

// ---------------------------------------------------------------- codes

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{1,29}$/;
const cleanCode = (c) => String(c || '').trim().toUpperCase();

// An active code of an active rep -> { repId, code }. Used by checkout (preview) and createOrder.
export function repCodeInfo(code, db = getDb()) {
  const c = cleanCode(code);
  if (!c) return null;
  const r = db.prepare('SELECT rc.code, rc.rep_id, r.name FROM rep_codes rc JOIN reps r ON r.id = rc.rep_id WHERE rc.code = ? COLLATE NOCASE AND rc.active = 1 AND r.active = 1').get(c);
  return r ? { repId: r.rep_id, code: r.code.toUpperCase(), repName: r.name } : null;
}

// Who earns on this order: the typed rep code, else the rep this customer's email stays with.
export function resolveRepForOrder({ code, email }, db = getDb()) {
  const byCode = repCodeInfo(code, db);
  if (byCode) return { repId: byCode.repId, code: byCode.code, byCode: true };
  if (email) {
    const r = db.prepare('SELECT rc.rep_id FROM rep_customers rc JOIN reps r ON r.id = rc.rep_id WHERE rc.email_key = ? AND r.active = 1').get(normalEmail(email));
    if (r) return { repId: r.rep_id, code: '', byCode: false };
  }
  return null;
}

// ---------------------------------------------------------------- reps

function repRow(r) {
  return r && { id: r.id, name: r.name, company: r.company, email: r.email, phone: r.phone, percent: r.percent, active: Boolean(r.active), notes: r.notes, createdAt: r.created_at };
}

function codesOf(repId, db) {
  const uses = db.prepare("SELECT rep_code code, COUNT(*) n FROM orders WHERE rep_id = ? AND payment_status = 'paid' AND rep_code != '' GROUP BY rep_code COLLATE NOCASE").all(repId);
  const byCode = new Map(uses.map((u) => [u.code.toUpperCase(), u.n]));
  return db.prepare('SELECT * FROM rep_codes WHERE rep_id = ? ORDER BY created_at').all(repId).map((c) => ({ id: c.id, code: c.code.toUpperCase(), label: c.label, active: Boolean(c.active), orders: byCode.get(c.code.toUpperCase()) || 0, link: `${siteUrl}/?ref=${c.code.toUpperCase()}` }));
}

function validEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

export function saveRep(data = {}, id = null, db = getDb()) {
  const name = String(data.name || '').trim().slice(0, 120);
  const email = String(data.email || '').trim().toLowerCase().slice(0, 200);
  if (!name) throw bad('Enter the rep’s name.');
  if (!validEmail(email)) throw bad('Enter a valid email address.');
  const percent = Number(data.percent ?? 50);
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) throw bad('The commission must be between 0 and 100% of the profit.');
  const fields = { name, company: String(data.company || '').trim().slice(0, 120), email, phone: String(data.phone || '').trim().slice(0, 40), percent, notes: String(data.notes || '').trim().slice(0, 1000), active: data.active === false || data.active === 0 ? 0 : 1 };
  const ts = nowIso();
  if (id) {
    const cur = db.prepare('SELECT id FROM reps WHERE id = ?').get(id);
    if (!cur) return null;
    db.prepare('UPDATE reps SET name=@name, company=@company, email=@email, phone=@phone, percent=@percent, notes=@notes, active=@active, updated_at=@ts WHERE id=@id').run({ ...fields, ts, id });
    return getRep(id, {}, db);
  }
  if (db.prepare('SELECT 1 FROM reps WHERE email = ? COLLATE NOCASE').get(email)) throw bad('A rep with that email already exists.');
  const newId = randomUUID();
  let code = null;
  if (data.code) {
    code = cleanCode(data.code);
    if (!CODE_RE.test(code)) throw bad('A code is 2–30 letters, numbers, - or _.');
    if (db.prepare('SELECT 1 FROM rep_codes WHERE code = ? COLLATE NOCASE').get(code) || db.prepare('SELECT 1 FROM promo_codes WHERE code = ? COLLATE NOCASE').get(code)) throw bad('That code is already in use.');
  }
  db.transaction(() => {
    db.prepare('INSERT INTO reps (id, name, company, email, phone, percent, active, notes, created_at, updated_at) VALUES (@id,@name,@company,@email,@phone,@percent,@active,@notes,@ts,@ts)').run({ ...fields, id: newId, ts });
    if (code) db.prepare('INSERT INTO rep_codes (id, rep_id, code, label, active, created_at) VALUES (?,?,?,?,1,?)').run(randomUUID(), newId, code, String(data.label || '').trim().slice(0, 80), ts);
  })();
  if (code) sendWelcome(newId, db).catch((err) => console.error('Rep welcome email failed:', err.message));
  return getRep(newId, {}, db);
}

export function addCode(repId, { code, label } = {}, db = getDb()) {
  const rep = db.prepare('SELECT id FROM reps WHERE id = ?').get(repId);
  if (!rep) return null;
  const c = cleanCode(code);
  if (!CODE_RE.test(c)) throw bad('A code is 2–30 letters, numbers, - or _.');
  if (db.prepare('SELECT 1 FROM rep_codes WHERE code = ? COLLATE NOCASE').get(c) || db.prepare('SELECT 1 FROM promo_codes WHERE code = ? COLLATE NOCASE').get(c)) throw bad('That code is already in use.');
  db.prepare('INSERT INTO rep_codes (id, rep_id, code, label, active, created_at) VALUES (?,?,?,?,1,?)').run(randomUUID(), repId, c, String(label || '').trim().slice(0, 80), nowIso());
  return getRep(repId, {}, db);
}

export function updateCode(codeId, { label, active } = {}, db = getDb()) {
  const c = db.prepare('SELECT * FROM rep_codes WHERE id = ?').get(codeId);
  if (!c) return null;
  db.prepare('UPDATE rep_codes SET label = ?, active = ? WHERE id = ?').run(label === undefined ? c.label : String(label).trim().slice(0, 80), active === undefined ? c.active : active ? 1 : 0, codeId);
  return getRep(c.rep_id, {}, db);
}

// ---------------------------------------------------------------- money

const sastStart = (ymd) => new Date(`${ymd}T00:00:00+02:00`).toISOString();
function range(q = {}) {
  const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const from = ok(q.from) ? sastStart(q.from) : '0000';
  const to = ok(q.to) ? sastStart(new Date(new Date(`${q.to}T00:00:00Z`).getTime() + 86400_000).toISOString().slice(0, 10)) : '9999';
  return { from, to };
}

// Period figures (commissions earned inside the dates) + balances (all time).
function totalsFor(repId, q, db) {
  const { from, to } = range(q);
  const p = db.prepare(`SELECT
      SUM(kind = 'sale' AND status != 'reversed') AS orders,
      COALESCE(SUM(CASE WHEN kind = 'sale' AND status != 'reversed' THEN sale_cents END), 0) AS sales,
      COALESCE(SUM(CASE WHEN kind = 'sale' AND status != 'reversed' THEN profit_cents END), 0) AS profit,
      COALESCE(SUM(CASE WHEN kind = 'sale' AND status != 'reversed' THEN commission_cents END), 0) AS earned,
      SUM(kind = 'sale' AND status = 'reversed') AS reversedOrders
    FROM rep_commissions WHERE rep_id = ? AND earned_at >= ? AND earned_at < ?`).get(repId, from, to);
  const b = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status = 'pending' THEN commission_cents END), 0) AS pending,
      COALESCE(SUM(CASE WHEN status = 'payable' THEN commission_cents END), 0) AS payable,
      COALESCE(SUM(CASE WHEN status = 'paid' THEN commission_cents END), 0) AS paid
    FROM rep_commissions WHERE rep_id = ?`).get(repId);
  return { orders: p.orders || 0, reversedOrders: p.reversedOrders || 0, salesCents: p.sales, profitCents: p.profit, earnedCents: p.earned, pendingCents: b.pending, payableCents: b.payable, paidCents: b.paid, owedCents: b.pending + b.payable };
}

export function listReps(q = {}, db = getDb()) {
  const reps = db.prepare('SELECT * FROM reps ORDER BY active DESC, name COLLATE NOCASE').all().map((r) => ({ ...repRow(r), codes: codesOf(r.id, db).map((c) => c.code), totals: totalsFor(r.id, q, db) }));
  const sum = (k) => reps.reduce((t, r) => t + r.totals[k], 0);
  return { reps, total: { orders: sum('orders'), salesCents: sum('salesCents'), profitCents: sum('profitCents'), earnedCents: sum('earnedCents'), pendingCents: sum('pendingCents'), payableCents: sum('payableCents'), paidCents: sum('paidCents'), owedCents: sum('owedCents') }, settings: getRepSettings(db) };
}

export function getRep(id, q = {}, db = getDb()) {
  const r = db.prepare('SELECT * FROM reps WHERE id = ?').get(id);
  if (!r) return null;
  const { from, to } = range(q);
  const rows = db.prepare(`SELECT c.*, o.first_name, o.last_name, o.paid_at, o.status AS order_status
      FROM rep_commissions c LEFT JOIN orders o ON o.id = c.order_id
      WHERE c.rep_id = ? AND c.earned_at >= ? AND c.earned_at < ? ORDER BY c.earned_at DESC`).all(id, from, to);
  return {
    ...repRow(r),
    codes: codesOf(id, db),
    totals: totalsFor(id, q, db),
    commissions: rows.map((c) => ({ id: c.id, orderId: c.order_id, orderNumber: c.order_number, kind: c.kind, code: c.code, customer: `${c.first_name || ''} ${c.last_name || ''}`.trim(), saleCents: c.sale_cents, profitCents: c.profit_cents, percent: c.percent, commissionCents: c.commission_cents, status: c.status, earnedAt: c.earned_at, payableAt: c.payable_at, note: c.note })),
    payouts: db.prepare('SELECT * FROM rep_payouts WHERE rep_id = ? ORDER BY paid_at DESC').all(id).map((p) => ({ id: p.id, amountCents: p.amount_cents, reference: p.reference, note: p.note, createdBy: p.created_by, paidAt: p.paid_at })),
    settings: getRepSettings(db),
  };
}

// ---------------------------------------------------------------- emails

function recipients(rep) {
  const s = getSettings();
  return [rep.email, s.ownerNotifyEmail].filter(Boolean).filter((e, i, a) => a.findIndex((x) => x.toLowerCase() === e.toLowerCase()) === i).join(', ');
}

const p = (t) => `<p style="margin:0 0 12px">${t}</p>`;
const row = (a, b) => `<tr><td style="padding:4px 0">${escapeHtml(a)}</td><td style="padding:4px 0;text-align:right;font-weight:700">${escapeHtml(b)}</td></tr>`;
const table = (rows) => `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:8px 0 16px">${rows.join('')}</table>`;

function send(rep, subject, title, body, kind, ref) {
  return sendMailReliable({ to: recipients(rep), subject, html: layout(title, body) }, { kind, ref });
}

export async function sendWelcome(repId, db = getDb()) {
  const rep = db.prepare('SELECT * FROM reps WHERE id = ?').get(repId);
  if (!rep) return false;
  const codes = codesOf(repId, db).filter((c) => c.active);
  const s = getRepSettings(db);
  const body =
    p(`Hi ${escapeHtml(rep.name)},`) +
    p(`You are now a sales partner of Procom Solutions. You earn <strong>${escapeHtml(String(rep.percent))}%</strong> of the profit on every order that comes through your code.`) +
    (codes.length ? `<p style="margin:0 0 6px"><strong>Your code${codes.length > 1 ? 's' : ''}:</strong></p>${codes.map((c) => `<p style="margin:0 0 10px"><span style="font-size:18px;font-weight:700">${escapeHtml(c.code)}</span>${c.label ? ` (${escapeHtml(c.label)})` : ''}<br><a href="${escapeHtml(c.link)}" style="color:#c24b28">${escapeHtml(c.link)}</a></p>`).join('')}` : '') +
    p('Customers enter the code at checkout, or you can send them your link (it remembers the code for 30 days). The code gives the customer no discount. A customer who buys with your code stays yours for their later orders too.') +
    p(`We email you for every sale, with your commission. Commission becomes payable ${s.holdHours} hours after the customer pays (so that returns can be handled), and you get a monthly statement on the 1st. If an order is cancelled or refunded, its commission is reversed.`) +
    p(`Questions? Reply to this email.`);
  return send(rep, 'Welcome to the Procom Solutions partner programme', 'Sales partner', body, 'rep-welcome', repId);
}

async function sendSale(rep, order, comm, db) {
  const items = db.prepare('SELECT name, quantity FROM order_items WHERE order_id = ?').all(order.id);
  const customer = `${order.first_name} ${order.last_name}`.trim();
  const body =
    p(`Hi ${escapeHtml(rep.name)}, a sale was made${comm.code ? ` with your code <strong>${escapeHtml(comm.code)}</strong>` : ' by one of your customers'}.`) +
    table([row('Order', order.order_number), row('Customer', customer || '—'), row('Order total', money(order.total_cents)), row('Your commission', money(comm.commission_cents)), row('Payable from', sastDate(comm.payable_at))]) +
    `<ul style="font-size:13px;margin:0 0 16px;padding-left:18px">${items.map((i) => `<li>${escapeHtml(i.name)} × ${i.quantity}</li>`).join('')}</ul>` +
    p('The commission becomes payable after the hold period. If the order is cancelled or refunded before then, it is reversed.');
  return send(rep, `Sale ${order.order_number}: you earned ${money(comm.commission_cents)}`, 'New sale', body, 'rep-sale', order.order_number);
}

async function sendReversal(rep, orderNumber, cents, paidOut) {
  const body =
    p(`Hi ${escapeHtml(rep.name)}, order <strong>${escapeHtml(orderNumber)}</strong> was cancelled or refunded.`) +
    p(paidOut ? `Its commission of ${money(cents)} had already been paid to you, so it will be deducted from your next payout.` : `The commission of ${money(cents)} on that order has been reversed.`);
  return send(rep, `Order ${orderNumber} cancelled: commission reversed`, 'Order cancelled', body, 'rep-reversal', orderNumber);
}

async function sendPayable(rep, rows, balance) {
  const body =
    p(`Hi ${escapeHtml(rep.name)}, these commissions are now payable:`) +
    table(rows.map((r) => row(r.order_number, money(r.commission_cents)))) +
    p(`Your payable balance is now <strong>${money(balance)}</strong>. We pay out by EFT and will email you when the payment is made.`);
  return send(rep, `${money(balance)} commission is now payable`, 'Commission payable', body, 'rep-payable', rep.id);
}

async function sendPayout(rep, payout, count) {
  const body =
    p(`Hi ${escapeHtml(rep.name)}, we paid you <strong>${money(payout.amount_cents)}</strong> by EFT${payout.reference ? ` (reference ${escapeHtml(payout.reference)})` : ''}.`) +
    p(`It covers ${count} commission line${count === 1 ? '' : 's'} up to ${sastDate(payout.paid_at)}.${payout.note ? ` ${escapeHtml(payout.note)}` : ''}`);
  return send(rep, `Commission payout of ${money(payout.amount_cents)}`, 'Payout made', body, 'rep-payout', payout.id);
}

// ---------------------------------------------------------------- hooks

// Called once when payment is confirmed (orders.markOrderPaid). Idempotent per order.
export function onOrderPaid(order, db = getDb()) {
  try {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    if (!o || !o.rep_id) return null;
    if (db.prepare("SELECT 1 FROM rep_commissions WHERE order_id = ? AND kind = 'sale'").get(o.id)) return null;
    const rep = db.prepare('SELECT * FROM reps WHERE id = ?').get(o.rep_id);
    if (!rep) return null;
    const fig = orderProfit(o.id, db);
    const profit = fig ? fig.profitCents : 0;
    const commission = Math.max(0, Math.round((profit * rep.percent) / 100));
    const earnedAt = o.paid_at || nowIso();
    const payableAt = new Date(new Date(earnedAt).getTime() + getRepSettings(db).holdHours * HOUR).toISOString();
    const comm = { id: randomUUID(), rep_id: rep.id, code: o.rep_code || '', order_id: o.id, order_number: o.order_number, sale_cents: o.total_cents, profit_cents: profit, percent: rep.percent, commission_cents: commission, earned_at: earnedAt, payable_at: payableAt };
    db.prepare("INSERT INTO rep_commissions (id, rep_id, code, order_id, order_number, kind, sale_cents, profit_cents, percent, commission_cents, status, earned_at, payable_at) VALUES (@id,@rep_id,@code,@order_id,@order_number,'sale',@sale_cents,@profit_cents,@percent,@commission_cents,'pending',@earned_at,@payable_at)").run(comm);
    // This customer stays with the rep (first rep wins).
    db.prepare('INSERT OR IGNORE INTO rep_customers (email_key, rep_id, first_order_id, created_at) VALUES (?, ?, ?, ?)').run(normalEmail(o.email), rep.id, o.id, nowIso());
    sendSale(rep, o, comm, db).catch((err) => console.error('Rep sale email failed:', err.message));
    return comm;
  } catch (err) {
    console.error('Rep commission failed:', err.message); // never breaks a payment
    return null;
  }
}

// Called by orders.cancelOrder for a paid order.
export function onOrderCancelled(orderId, db = getDb()) {
  try {
    const sale = db.prepare("SELECT * FROM rep_commissions WHERE order_id = ? AND kind = 'sale' AND status != 'reversed'").get(orderId);
    if (!sale) return null;
    const rep = db.prepare('SELECT * FROM reps WHERE id = ?').get(sale.rep_id);
    const ts = nowIso();
    const paidOut = sale.status === 'paid';
    if (paidOut) {
      // Already paid out: a negative line comes off the next payout; the original stays as the record.
      db.prepare("INSERT INTO rep_commissions (id, rep_id, code, order_id, order_number, kind, sale_cents, profit_cents, percent, commission_cents, status, earned_at, payable_at, note) VALUES (?,?,?,?,?,'reversal',?,?,?,?,'payable',?,?,?)")
        .run(randomUUID(), sale.rep_id, sale.code, orderId, sale.order_number, sale.sale_cents, sale.profit_cents, sale.percent, -sale.commission_cents, ts, ts, 'Order cancelled after payout');
    } else {
      db.prepare("UPDATE rep_commissions SET status = 'reversed', note = 'Order cancelled' WHERE id = ?").run(sale.id);
    }
    if (rep && sale.commission_cents > 0) sendReversal(rep, sale.order_number, sale.commission_cents, paidOut).catch((err) => console.error('Rep reversal email failed:', err.message));
    return { reversed: true, paidOut };
  } catch (err) {
    console.error('Rep reversal failed:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------- payouts

export function payableFor(repId, db = getDb()) {
  const rows = db.prepare("SELECT * FROM rep_commissions WHERE rep_id = ? AND status = 'payable' ORDER BY earned_at").all(repId);
  return { rows, totalCents: rows.reduce((t, r) => t + r.commission_cents, 0) };
}

export function recordPayout(repId, { reference = '', note = '', actor = 'admin' } = {}, db = getDb()) {
  const rep = db.prepare('SELECT * FROM reps WHERE id = ?').get(repId);
  if (!rep) return null;
  const { rows, totalCents } = payableFor(repId, db);
  const min = getRepSettings(db).minPayoutCents;
  if (totalCents <= 0) throw bad('Nothing is payable to this rep yet.');
  if (totalCents < min) throw bad(`The payable amount (${money(totalCents)}) is below the minimum payout of ${money(min)}.`);
  const payout = { id: randomUUID(), rep_id: repId, amount_cents: totalCents, reference: String(reference).trim().slice(0, 80), note: String(note).trim().slice(0, 300), created_by: String(actor).slice(0, 60), paid_at: nowIso() };
  db.transaction(() => {
    db.prepare('INSERT INTO rep_payouts (id, rep_id, amount_cents, reference, note, created_by, paid_at) VALUES (@id,@rep_id,@amount_cents,@reference,@note,@created_by,@paid_at)').run(payout);
    db.prepare("UPDATE rep_commissions SET status = 'paid', payout_id = ? WHERE rep_id = ? AND status = 'payable'").run(payout.id, repId);
  })();
  sendPayout(rep, payout, rows.length).catch((err) => console.error('Rep payout email failed:', err.message));
  return getRep(repId, {}, db);
}

// ---------------------------------------------------------------- schedule

// Pending -> payable once the hold is over (one email per rep), and the monthly statements.
export async function processReps({ now = new Date(), db = getDb() } = {}) {
  const out = { madePayable: 0, statements: 0 };
  const due = db.prepare("SELECT * FROM rep_commissions WHERE status = 'pending' AND payable_at <= ? ORDER BY earned_at").all(now.toISOString());
  const byRep = new Map();
  for (const c of due) {
    db.prepare("UPDATE rep_commissions SET status = 'payable' WHERE id = ?").run(c.id);
    out.madePayable++;
    if (!byRep.has(c.rep_id)) byRep.set(c.rep_id, []);
    byRep.get(c.rep_id).push(c);
  }
  for (const [repId, rows] of byRep) {
    const rep = db.prepare('SELECT * FROM reps WHERE id = ?').get(repId);
    if (!rep || !rows.some((r) => r.commission_cents > 0)) continue;
    await sendPayable(rep, rows.filter((r) => r.commission_cents > 0), payableFor(repId, db).totalCents);
  }

  // Statement for the previous month, from 08:00 SAST on the 1st (and any later day if it was missed).
  const sast = new Date(now.getTime() + 2 * HOUR);
  if (sast.getUTCDate() > 1 || sast.getUTCHours() >= 8) {
    const prev = new Date(Date.UTC(sast.getUTCFullYear(), sast.getUTCMonth() - 1, 1));
    const month = prev.toISOString().slice(0, 7);
    for (const rep of db.prepare('SELECT * FROM reps').all()) {
      if (db.prepare('SELECT 1 FROM rep_statements WHERE rep_id = ? AND month = ?').get(rep.id, month)) continue;
      const sent = await sendStatement(rep, month, db);
      db.prepare('INSERT OR IGNORE INTO rep_statements (rep_id, month, sent_at) VALUES (?, ?, ?)').run(rep.id, month, nowIso());
      if (sent) out.statements++;
    }
  }
  return out;
}

export async function sendStatement(rep, month, db = getDb()) {
  const from = sastStart(`${month}-01`);
  const nextMonth = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 10);
  const to = sastStart(nextMonth);
  const lines = db.prepare('SELECT * FROM rep_commissions WHERE rep_id = ? AND earned_at >= ? AND earned_at < ? ORDER BY earned_at').all(rep.id, from, to);
  const payouts = db.prepare('SELECT * FROM rep_payouts WHERE rep_id = ? AND paid_at >= ? AND paid_at < ? ORDER BY paid_at').all(rep.id, from, to);
  if (!lines.length && !payouts.length) return false; // nothing happened: no empty statement
  const earned = lines.filter((l) => l.status !== 'reversed').reduce((t, l) => t + l.commission_cents, 0);
  const bal = totalsFor(rep.id, {}, db);
  const label = new Date(`${month}-15T12:00:00Z`).toLocaleDateString('en-ZA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const body =
    p(`Hi ${escapeHtml(rep.name)}, here is your statement for <strong>${escapeHtml(label)}</strong>.`) +
    table([row('Sales credited to you', String(lines.filter((l) => l.kind === 'sale' && l.status !== 'reversed').length)), row('Commission earned (net of reversals)', money(earned)), row('Paid to you this month', money(payouts.reduce((t, x) => t + x.amount_cents, 0)))]) +
    (lines.length ? `<table style="width:100%;border-collapse:collapse;font-size:13px;margin:0 0 16px"><tr style="text-align:left;border-bottom:1px solid #e5ddd0"><th>Date</th><th>Order</th><th style="text-align:right">Commission</th><th style="text-align:right">Status</th></tr>${lines.map((l) => `<tr><td>${sastDate(l.earned_at)}</td><td>${escapeHtml(l.order_number)}${l.kind === 'reversal' ? ' (reversal)' : ''}</td><td style="text-align:right">${money(l.commission_cents)}</td><td style="text-align:right">${escapeHtml(l.status)}</td></tr>`).join('')}</table>` : '') +
    table([row('Waiting (still in the hold period)', money(bal.pendingCents)), row('Payable', money(bal.payableCents)), row('Paid to date', money(bal.paidCents))]);
  await send(rep, `Your Procom Solutions commission statement, ${label}`, 'Monthly statement', body, 'rep-statement', `${rep.id}-${month}`);
  return true; // handed to the mail queue (it retries by itself)
}

let timer = null;
export function startRepSchedule() {
  if (timer || process.env.DISABLE_REP_SCHEDULE === '1') return;
  timer = setInterval(() => processReps().catch((err) => console.error('Rep schedule failed:', err.message)), 15 * 60_000);
  timer.unref?.();
  setTimeout(() => processReps().catch((err) => console.error('Rep schedule failed:', err.message)), 60_000).unref?.();
}

// ---------------------------------------------------------------- routes

export function register({ admin, wrap, siteUrl: url }) {
  if (url) siteUrl = String(url).replace(/\/$/, '');
  const orNotFound = (v) => {
    if (!v) throw Object.assign(new Error('Not found'), { status: 404 });
    return v;
  };
  admin.get('/reps', wrap((req) => listReps(req.query)));
  admin.post('/reps', wrap((req) => saveRep(req.body || {})));
  admin.get('/reps/:id', wrap((req) => orNotFound(getRep(req.params.id, req.query))));
  admin.put('/reps/:id', wrap((req) => orNotFound(saveRep(req.body || {}, req.params.id))));
  admin.post('/reps/:id/codes', wrap((req) => orNotFound(addCode(req.params.id, req.body || {}))));
  admin.put('/rep-codes/:id', wrap((req) => orNotFound(updateCode(req.params.id, req.body || {}))));
  admin.post('/reps/:id/welcome', wrap(async (req) => {
    orNotFound(getRep(req.params.id));
    await sendWelcome(req.params.id);
    return { ok: true };
  }));
  admin.post('/reps/:id/payout', wrap((req) => orNotFound(recordPayout(req.params.id, { ...req.body, actor: req.admin?.username || 'admin' }))));
  admin.get('/rep-settings', wrap(() => getRepSettings()));
  admin.put('/rep-settings', wrap((req) => saveRepSettings(req.body || {})));
}
