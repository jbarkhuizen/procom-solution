// Printable invoice: /invoice.html?o=<orderId>. The order id is the
// unguessable link from the invoice email; the API returns 404 until the
// order is paid and invoiced. Every dynamic value goes through esc().
import './site.js';
import { api, esc, formatRand } from './api.js';
import { setHtml } from './dom.js';

const $ = (id) => document.getElementById(id);
const orderId = new URLSearchParams(location.search).get('o') || '';

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Johannesburg' }) : '');
const lines = (...parts) => parts.filter(Boolean).map(esc).join('<br>');

function addressLines(c) {
  if (c.pudoLocker) return lines(`PUDO locker: ${c.pudoLocker}`);
  const a = c.address || {};
  return lines(a.line1, a.line2, a.suburb, [a.city, a.postalCode].filter(Boolean).join(' '), a.province);
}

function shipmentLine(sh, many) {
  if (sh.method === 'collect') return sh.label && sh.label !== 'Your order' ? `Collection from our ${sh.label}` : 'Collection (free)';
  const what = sh.method === 'quote' ? `${sh.name} (quoted separately)` : sh.name;
  return `Delivery${many && sh.label ? ` — ${sh.label}` : ''}: ${what}`;
}

function render(inv) {
  const s = inv.seller;
  const c = inv.customer;
  const many = inv.shipments.length > 1;
  const delivery = inv.shipments
    .map((sh) => `<tr><td>${esc(shipmentLine(sh, many))}</td><td class="num">${formatRand(sh.feeCents)}</td></tr>${sh.insuranceCents ? `<tr><td>${esc(sh.insuranceName || 'Courier insurance')}</td><td class="num">${formatRand(sh.insuranceCents)}</td></tr>` : ''}`)
    .join('');
  const collections = inv.shipments.filter((sh) => sh.collection);
  const deliverTo = collections.length === inv.shipments.length ? '' : addressLines(c);

  return `
    ${inv.cancelled ? '<p class="mb-6 border-2 border-terracotta text-terracotta rounded-sm px-4 py-2 text-sm font-semibold">This order was cancelled.</p>' : ''}
    <header class="flex flex-wrap justify-between gap-6 mb-8">
      <div>
        <p class="font-serif text-2xl tracking-tight font-semibold">Procom <span class="text-terracotta italic">Solutions</span></p>
        <p class="text-sm mt-2 leading-relaxed">${lines(s.name, s.address)}<br>${lines(s.email, s.phone, s.website)}</p>
      </div>
      <div class="sm:text-right">
        <h1 class="font-serif text-4xl tracking-tight mb-3">Invoice</h1>
        <dl class="text-sm space-y-1">
          <div><dt class="inline text-espresso/65">Invoice no. </dt><dd class="inline font-semibold">${esc(inv.invoiceNumber)}</dd></div>
          <div><dt class="inline text-espresso/65">Date </dt><dd class="inline">${esc(fmtDate(inv.invoiceDate))}</dd></div>
          <div><dt class="inline text-espresso/65">Order </dt><dd class="inline">${esc(inv.orderNumber)}</dd></div>
        </dl>
      </div>
    </header>

    <section class="grid sm:grid-cols-2 gap-6 mb-8 text-sm inv-avoid-break">
      <div>
        <p class="inv-label">Billed to</p>
        <p class="leading-relaxed">${lines(c.name, c.email, c.phone)}</p>
      </div>
      ${deliverTo ? `<div><p class="inv-label">Deliver to</p><p class="leading-relaxed">${deliverTo}</p></div>` : ''}
    </section>

    <table class="inv-table mb-6">
      <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Amount</th></tr></thead>
      <tbody>${inv.items
        .map((i) => `<tr><td>${esc(i.name)}${i.sku ? `<br><span class="text-xs text-espresso/60">${esc(i.sku)}</span>` : ''}</td><td class="num">${esc(i.quantity)}</td><td class="num">${formatRand(i.unitCents)}</td><td class="num">${formatRand(i.lineTotalCents)}</td></tr>`)
        .join('')}</tbody>
    </table>

    <div class="flex justify-end mb-8 inv-avoid-break">
      <table class="inv-table inv-totals" style="max-width:24rem">
        <tbody>
          <tr><td>Subtotal</td><td class="num">${formatRand(inv.subtotalCents)}</td></tr>
          ${inv.discountCents ? `<tr><td>Discount${inv.promoCode ? ` (${esc(inv.promoCode)})` : ''}</td><td class="num">−${formatRand(inv.discountCents)}</td></tr>` : ''}
          ${delivery}
          <tr class="grand"><td>Total paid</td><td class="num">${formatRand(inv.totalCents)}</td></tr>
        </tbody>
      </table>
    </div>

    <section class="grid sm:grid-cols-2 gap-6 text-sm inv-avoid-break">
      <div>
        <p class="inv-label">Payment</p>
        <p class="leading-relaxed">${lines(inv.payment.method, inv.payment.paidAt ? `Paid ${fmtDate(inv.payment.paidAt)}` : '', inv.payment.reference ? `Payfast ref ${inv.payment.reference}` : '')}</p>
      </div>
      ${collections
        .map((sh) => `<div>
          <p class="inv-label">Collection${many && sh.label ? ` — ${esc(sh.label)}` : ''}</p>
          <p class="leading-relaxed">${lines(sh.collection.address, sh.collection.hours)}</p>
          ${sh.collection.requirements ? `<p class="mt-1 text-espresso/70">${esc(sh.collection.requirements)}</p>` : ''}
        </div>`)
        .join('')}
    </section>
    ${inv.deliveryQuote ? '<p class="mt-6 text-sm text-espresso/70">Delivery of large items is quoted and invoiced separately.</p>' : ''}

    <p class="mt-10 pt-4 border-t border-charcoal/15 text-xs text-espresso/60">Thank you for shopping with ${esc(s.tradingAs || 'Procom Solutions')}. Questions about this invoice? ${lines(s.email)} · ${lines(s.phone)}</p>`;
}

async function load() {
  if (!orderId) {
    $('inv-message').textContent = 'This invoice link is incomplete. Please use the link in your invoice email.';
    return;
  }
  let inv;
  try {
    inv = await api(`/api/orders/${encodeURIComponent(orderId)}/invoice`);
  } catch {
    $('inv-message').textContent = 'We could not find this invoice. It becomes available once your payment has been confirmed — if you have paid, please contact us.';
    return;
  }
  document.title = `Invoice ${inv.invoiceNumber} — Procom Solutions`;
  setHtml($('inv-card'), render(inv));
  $('inv-message').classList.add('hidden');
  $('inv-card').classList.remove('hidden');
  $('inv-actions').classList.remove('hidden');
}

$('inv-print').addEventListener('click', () => window.print());
load();
