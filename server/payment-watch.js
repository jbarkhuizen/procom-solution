// A customer who comes back from Payfast but whose payment never gets confirmed
// (the Payfast notice was lost, rejected or is still being retried) must not be
// forgotten: the order would sit in "Awaiting payment", which the Orders list
// hides by default, while the money has been taken (audit 2026-10-08).
//
// The checkout-complete page asks for the order status; the first time it does so
// for an unpaid order we note it (payment_return_seen_at). If that order is still
// unpaid 15 minutes later the owner gets one email, the order gets an event, and
// the dashboard shows it until the order is paid or cancelled.
import { getDb } from './db.js';
import { logOrderEvent } from './orders.js';
import { sendOwnerAlert } from './mailer.js';
import { formatRand } from './util.js';

export const GRACE_MS = 15 * 60_000;
const LOOKBACK_MS = 7 * 86400_000;

export function markReturnSeen(orderId, db = getDb(), now = Date.now()) {
  db.prepare("UPDATE orders SET payment_return_seen_at = ? WHERE id = ? AND payment_status != 'paid' AND payment_return_seen_at IS NULL").run(new Date(now).toISOString(), orderId);
}

const WAITING = "payment_status != 'paid' AND status = 'pending_payment' AND payment_return_seen_at IS NOT NULL AND payment_return_seen_at < ? AND payment_return_seen_at > ?";

// Orders whose customer returned from Payfast more than 15 minutes ago but are still unpaid.
export function paymentsToCheck(db = getDb(), now = Date.now()) {
  const rows = db
    .prepare(`SELECT id, order_number, first_name, last_name, total_cents, payment_return_seen_at FROM orders WHERE ${WAITING} ORDER BY payment_return_seen_at DESC`)
    .all(new Date(now - GRACE_MS).toISOString(), new Date(now - LOOKBACK_MS).toISOString());
  return { count: rows.length, items: rows.slice(0, 8).map((o) => ({ id: o.id, orderNumber: o.order_number, customer: `${o.first_name} ${o.last_name}`.trim(), totalCents: o.total_cents })) };
}

// Alerts once per order. Returns the order numbers alerted.
export async function checkUnconfirmedPayments({ db = getDb(), now = Date.now(), alert = sendOwnerAlert } = {}) {
  const rows = db
    .prepare(`SELECT id, order_number, first_name, last_name, email, total_cents FROM orders WHERE ${WAITING} AND payment_alerted_at IS NULL`)
    .all(new Date(now - GRACE_MS).toISOString(), new Date(now - LOOKBACK_MS).toISOString());
  const done = [];
  for (const o of rows) {
    db.prepare('UPDATE orders SET payment_alerted_at = ? WHERE id = ?').run(new Date(now).toISOString(), o.id);
    logOrderEvent(o.id, 'The customer came back from Payfast but the payment is not confirmed. Check Payfast; if it was paid, the order can be marked paid by hand.', 'system', db);
    await alert(
      `Check Payfast: order ${o.order_number} is not confirmed`,
      `${`${o.first_name} ${o.last_name}`.trim()} (${o.email}) came back from Payfast for order ${o.order_number} (${formatRand(o.total_cents)}), but we never received the payment confirmation.\n\nPlease look in your Payfast dashboard. If the payment went through, mark the order as paid in the admin; if not, the customer may have cancelled.`,
    );
    done.push(o.order_number);
  }
  return done;
}

export function startPaymentWatch() {
  const run = () => checkUnconfirmedPayments().catch((err) => console.error('Payment watch failed:', err.message));
  setInterval(run, 5 * 60_000).unref?.();
  setTimeout(run, 60_000).unref?.();
}
