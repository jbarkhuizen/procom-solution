// Sequential invoices + admin Invoice history.
//
// Every paid order gets the next number (INV-000001, INV-000002, ...) once,
// when Payfast confirms payment (onOrderPaid). Orders paid before this
// feature existed are numbered from admin (Invoice history -> "Issue missing
// invoices"), oldest payment first. The invoice itself is a printable page,
// /invoice.html?o=<orderId>, fed by GET /api/orders/:id/invoice -- the order
// id is an unguessable UUID, so the link works like /api/orders/:id/status.
//
// Procom is NOT VAT-registered: documents say "Invoice" (never "Tax
// invoice") and carry no VAT line.
import { getDb } from '../db.js';
import { getOrder, logOrderEvent } from '../orders.js';
import { getSettings } from '../settings.js';
import { sendMail, layout } from '../mailer.js';
import { escapeHtml, formatRand, clampInt } from '../util.js';

// Physical address on invoices. TODO: move to a site setting.
export const SELLER_ADDRESS = '23 Gladiator Rd, Pierre van Ryneveld, Centurion';
const PREFIX = 'INV-';
const PAD = 6;
const DEFAULT_SITE_URL = 'https://www.procomsolutions.co.za';

let siteUrl = (process.env.SITE_URL || DEFAULT_SITE_URL).replace(/\/$/, '');

export const formatInvoiceNumber = (n) => `${PREFIX}${String(n).padStart(PAD, '0')}`;
export const invoiceUrl = (orderId) => `${siteUrl}/invoice.html?o=${encodeURIComponent(orderId)}`;

const PAYMENT_LABELS = { payfast_card: 'Card (Payfast)', payfast_eft: 'Instant EFT (Payfast)' };
export const paymentLabel = (m) => PAYMENT_LABELS[m] || 'Payfast';

// Gives a paid order its invoice number. Idempotent: an order that already
// has a number keeps it. Runs in a transaction (a savepoint when the caller
// is already in one), so the counter bump and the order update commit
// together and the sequence has no gaps or duplicates.
// Returns { invoiceNumber, created } or null for an unknown order.
export function issueInvoice(orderId, { actor = 'system', db = getDb() } = {}) {
  const tx = db.transaction(() => {
    const o = db.prepare('SELECT id, invoice_number, payment_status FROM orders WHERE id = ?').get(orderId);
    if (!o) return null;
    if (o.invoice_number) return { invoiceNumber: o.invoice_number, created: false };
    if (o.payment_status !== 'paid') throw new Error('Only paid orders can be invoiced');
    const counter = db.prepare('SELECT last_number FROM invoice_counter WHERE id = 1').get()?.last_number || 0;
    // Never below a number already on an order (e.g. a restored backup whose
    // counter row lags behind its orders).
    const used = db.prepare(`SELECT MAX(CAST(SUBSTR(invoice_number, ${PREFIX.length + 1}) AS INTEGER)) AS n FROM orders WHERE invoice_number LIKE '${PREFIX}%'`).get().n || 0;
    const n = Math.max(counter, used) + 1;
    const invoiceNumber = formatInvoiceNumber(n);
    const ts = new Date().toISOString();
    db.prepare('INSERT INTO invoice_counter (id, last_number) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET last_number = excluded.last_number').run(n);
    db.prepare("UPDATE orders SET invoice_number = ?, invoiced_at = ?, updated_at = ? WHERE id = ? AND invoice_number = ''").run(invoiceNumber, ts, ts, orderId);
    logOrderEvent(orderId, `Invoice ${invoiceNumber} issued`, actor, db);
    return { invoiceNumber, created: true };
  });
  return tx();
}

export function invoiceEmailHtml(order) {
  const url = invoiceUrl(order.id);
  return layout(
    `Invoice ${order.invoiceNumber}`,
    `<p>Hi ${escapeHtml(order.firstName)},</p>
     <p>Thank you for your payment. Your invoice <strong>${escapeHtml(order.invoiceNumber)}</strong> for order <strong>${escapeHtml(order.orderNumber)}</strong> (${formatRand(order.totalCents)}) is ready.</p>
     <p style="margin:18px 0"><a href="${escapeHtml(url)}" style="display:inline-block;background:#1a1612;color:#f7f3eb;text-decoration:none;padding:10px 18px;border-radius:999px;font-weight:700">View or print your invoice</a></p>
     <p style="font-size:12px;color:#6a5f54">Keep this email: the link opens your invoice at any time. Anyone with the link can see it, so only share it with people you trust.</p>`,
  );
}

export function sendInvoiceEmail(order) {
  return sendMail({ to: order.email, subject: `Procom Solutions — invoice ${order.invoiceNumber} (order ${order.orderNumber})`, html: invoiceEmailHtml(order) });
}

// Fire-and-forget: mail problems are logged, never thrown.
function emailInBackground(orderId, db) {
  Promise.resolve()
    .then(() => sendInvoiceEmail(getOrder(orderId, db)))
    .catch((err) => console.error(`Invoice email for order ${orderId} failed:`, err));
}

// Core hook: called once after the Payfast payment is confirmed. Runs inside
// payment handling, so it must never throw.
export function onOrderPaid(order, db = getDb()) {
  try {
    if (!order?.id) return;
    const r = issueInvoice(order.id, { actor: 'system', db });
    if (r?.created) emailInBackground(order.id, db);
  } catch (err) {
    console.error(`Invoice for order ${order?.orderNumber || order?.id} failed:`, err);
  }
}

// Numbers every paid order that has none, oldest payment first. Customers
// are only emailed when asked (these orders may be weeks old).
export function issueMissingInvoices({ email = false, actor = 'admin', db = getDb() } = {}) {
  const ids = db.prepare("SELECT id FROM orders WHERE payment_status = 'paid' AND invoice_number = '' ORDER BY paid_at, created_at, order_number").all().map((r) => r.id);
  const issued = [];
  for (const id of ids) {
    const r = issueInvoice(id, { actor, db });
    if (!r?.created) continue;
    const o = db.prepare('SELECT order_number FROM orders WHERE id = ?').get(id);
    issued.push({ orderId: id, orderNumber: o.order_number, invoiceNumber: r.invoiceNumber });
    if (email) emailInBackground(id, db);
  }
  return { issued };
}

// What the public invoice page shows. Null when the order is unknown, unpaid
// or not invoiced. Suppliers appear only by their public label.
export function publicInvoice(orderId, db = getDb()) {
  const o = getOrder(String(orderId || ''), db);
  if (!o || o.paymentStatus !== 'paid' || !o.invoiceNumber) return null;
  const s = getSettings(db);
  return {
    invoiceNumber: o.invoiceNumber,
    invoiceDate: o.invoicedAt,
    orderNumber: o.orderNumber,
    cancelled: o.status === 'cancelled',
    seller: {
      name: s.legalEntity,
      tradingAs: s.siteName,
      address: SELLER_ADDRESS,
      email: s.contactEmail,
      phone: s.contactPhone,
      website: siteUrl.replace(/^https?:\/\//, ''),
    },
    customer: {
      name: [o.firstName, o.lastName].filter(Boolean).join(' '),
      email: o.email,
      phone: o.phone,
      address: o.address,
      pudoLocker: o.pudoLocker || '',
    },
    items: o.items.map((i) => ({ name: i.name, sku: i.sku || '', quantity: i.quantity, unitCents: i.unitPriceCents, lineTotalCents: i.lineTotalCents })),
    subtotalCents: o.subtotalCents,
    discountCents: o.discountCents,
    promoCode: o.promoCode,
    shipments: o.shipments.map((sh) => ({
      label: sh.label || '',
      method: sh.method,
      name: sh.name || '',
      feeCents: sh.feeCents || 0,
      collection: sh.method === 'collect' && sh.collection
        ? { address: sh.collection.address || '', hours: sh.collection.hours || '', requirements: sh.collection.requirements || '' }
        : null,
    })),
    deliveryCents: o.shippingCents,
    deliveryQuote: o.deliveryQuote,
    totalCents: o.totalCents,
    payment: { method: paymentLabel(o.paymentMethod), paidAt: o.paidAt, reference: o.pfPaymentId || '' },
  };
}

// Invoice history for admin. Dates are filtered/grouped in South African
// time (UTC+2, no daylight saving) so a 00:30 invoice lands on the right day.
const SAST = "datetime(invoiced_at, '+2 hours')";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function listInvoices(opts = {}, db = getDb()) {
  const where = ["invoice_number != ''"];
  const params = {};
  const q = String(opts.q || '').trim().slice(0, 100);
  if (q) {
    where.push("(invoice_number LIKE @q OR order_number LIKE @q OR email LIKE @q OR first_name LIKE @q OR last_name LIKE @q OR (first_name || ' ' || last_name) LIKE @q)");
    params.q = `%${q}%`;
  }
  if (DATE_RE.test(opts.from || '')) {
    where.push(`substr(${SAST}, 1, 10) >= @from`);
    params.from = opts.from;
  }
  if (DATE_RE.test(opts.to || '')) {
    where.push(`substr(${SAST}, 1, 10) <= @to`);
    params.to = opts.to;
  }
  const w = `WHERE ${where.join(' AND ')}`;
  const limit = clampInt(opts.limit, 1, 10000, 5000);
  const rows = db.prepare(`SELECT id, invoice_number, invoiced_at, order_number, status, payment_method, paid_at, pf_payment_id, first_name, last_name, email, total_cents, discount_cents, shipping_cents
    FROM orders ${w} ORDER BY invoice_number DESC LIMIT ${limit}`).all(params);
  const sums = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(total_cents), 0) t FROM orders ${w}`).get(params);
  const months = db.prepare(`SELECT substr(${SAST}, 1, 7) AS month, COUNT(*) AS count, COALESCE(SUM(total_cents), 0) AS totalCents
    FROM orders ${w} GROUP BY month ORDER BY month DESC`).all(params);
  const missing = db.prepare("SELECT COUNT(*) n FROM orders WHERE payment_status = 'paid' AND invoice_number = ''").get().n;
  return {
    items: rows.map((r) => ({
      orderId: r.id,
      invoiceNumber: r.invoice_number,
      invoicedAt: r.invoiced_at,
      orderNumber: r.order_number,
      status: r.status,
      customer: [r.first_name, r.last_name].filter(Boolean).join(' '),
      email: r.email,
      totalCents: r.total_cents,
      discountCents: r.discount_cents || 0,
      deliveryCents: r.shipping_cents,
      paymentMethod: r.payment_method,
      paymentLabel: paymentLabel(r.payment_method),
      paidAt: r.paid_at,
      paymentReference: r.pf_payment_id || '',
    })),
    total: sums.n,
    totalCents: sums.t,
    months,
    missing,
  };
}

const notFound = () => Object.assign(new Error('Not found'), { status: 404 });

export function register({ app, admin, wrap, rateLimit, siteUrl: url }) {
  if (url) siteUrl = String(url).replace(/\/$/, '');

  const invoiceLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false });
  app.get('/api/orders/:id/invoice', invoiceLimiter, wrap((req, res) => {
    const inv = publicInvoice(req.params.id);
    if (!inv) throw notFound();
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
    return inv;
  }));

  admin.get('/invoices', wrap((req) => listInvoices({ q: req.query.q, from: req.query.from, to: req.query.to })));
  admin.post('/invoices/issue-missing', wrap((req) => issueMissingInvoices({ email: req.body?.email === true })));
  admin.post('/invoices/:orderId/email', wrap(async (req) => {
    const o = getOrder(req.params.orderId);
    if (!o || !o.invoiceNumber) throw notFound();
    const sent = await sendInvoiceEmail(o);
    if (sent) logOrderEvent(o.id, `Invoice ${o.invoiceNumber} emailed to the customer`, 'admin');
    return { sent };
  }));
}
