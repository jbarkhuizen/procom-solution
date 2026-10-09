import './site.js';
import { api, formatRand } from './api.js';
import { clearCart } from './cart.js';

let stored = null;
try {
  stored = sessionStorage.getItem('procom-pending-order');
} catch { /* storage blocked */ }
const id = new URLSearchParams(location.search).get('order') || stored;
const $ = (x) => document.getElementById(x);

// Payfast's ITN usually lands within seconds of the redirect, but not
// always before it -- poll briefly rather than showing "unpaid" too early.
async function poll(attempt = 0) {
  if (!id) {
    $('c-body').textContent = 'Your order has been received.';
    return;
  }
  let o;
  try {
    o = await api(`/api/orders/${encodeURIComponent(id)}/status`);
  } catch (err) {
    // A busy moment (429) or a bad connection is not "order not found": do not alarm someone who has just paid.
    if (err.status === 404) $('c-body').textContent = 'We could not find that order. If you were charged, please contact us with your Payfast reference.';
    else {
      $('c-body').textContent = 'We could not check your order just now. Please wait a moment: if you paid, your confirmation email is on its way.';
      if (attempt < 5) setTimeout(() => poll(attempt + 1), 4000);
    }
    return;
  }
  $('c-card').classList.remove('hidden');
  $('c-number').textContent = o.orderNumber;
  $('c-status').textContent = o.statusLabel;
  $('c-total').textContent = formatRand(o.totalCents);
  $('c-email').textContent = o.email;
  if (o.paymentStatus === 'paid') {
    clearCart();
    sessionStorage.removeItem('procom-pending-order');
    $('c-eyebrow').textContent = 'Payment confirmed';
    $('c-title').textContent = 'Thank you — your order is in!';
    $('c-body').textContent = 'A confirmation email is on its way. Most items ship straight from our warehouse — we will email your tracking number as soon as it is dispatched.';
    return;
  }
  if (attempt < 12) {
    setTimeout(() => poll(attempt + 1), 2500);
    return;
  }
  $('c-title').textContent = 'Payment still processing';
  $('c-body').textContent = 'Payfast has not confirmed your payment yet. This can take a few minutes for Instant EFT. You will receive an email once it is confirmed — no need to pay again.';
}

poll();
