import './site.js';
import { api, esc, formatRand } from './api.js';
import { getCart, cartSubtotal, cartWeight, refreshCart } from './cart.js';
import { setHtml } from './dom.js';
import { initPromo, promoPayload, promoDiscountCents } from './checkout-promo.js';
import { initAccountCheckout } from './checkout-account.js';
import { track } from './analytics-beacon.js';

const form = document.getElementById('checkout-form');
const PREFS_KEY = 'procom-checkout-details';
let plan = []; // one group per supplier shipment, from /api/checkout/delivery
// Instant EFT is offered only while it is switched on in Payfast and the total is within its limits.
let payOptions = { eft: { enabled: false, minCents: 0, maxCents: 0 } };

function notice(message, tone = 'warn') {
  const el = document.getElementById('notice');
  el.textContent = message;
  el.className = `rounded-sm border-2 p-4 text-sm mb-6 ${tone === 'warn' ? 'border-terracotta text-terracotta' : 'border-charcoal'}`;
}

function formatKg(g) {
  return g >= 1000 ? `${(g / 1000).toFixed(g % 1000 ? 1 : 0)} kg` : `${g} g`;
}

// The chosen option of each shipment (null until picked).
function chosen(g) {
  const id = form.querySelector(`input[name="ship-${CSS.escape(g.key)}"]:checked`)?.value;
  return g.options.find((o) => o.id === id) || null;
}

const optionHtml = (g, o, prev) => {
  const base = o.method === 'quote' ? 'Quoted separately' : o.priceCents ? formatRand(o.priceCents) : 'Free';
  const price = o.insuranceCents ? `${base} + ${formatRand(o.insuranceCents)} courier insurance` : base;
  const note = [
    o.method === 'quote' ? "Pay for the products now; we'll send you the courier cost to your address within 1 business day, before anything ships." : '',
    o.method === 'courier' && o.priceCents ? 'Free delivery on larger orders from this warehouse.' : '',
    o.method === 'own_courier' ? 'After ordering, email us your courier’s waybill and collection date.' : '',
    o.insuranceCents ? `${o.insuranceName}. Not charged if you collect or send your own courier.` : '',
  ].filter(Boolean).join(' ');
  return `<label class="ship-option"><input type="radio" name="ship-${esc(g.key)}" value="${esc(o.id)}" ${o.id === prev ? 'checked' : ''} required>
  <span class="flex-1"><span class="block text-sm font-semibold leading-snug">${esc(o.name)}</span><span class="block text-sm text-terracotta font-semibold mt-0.5">${esc(price)}</span>${note ? `<span class="block text-xs text-espresso/65 mt-1 leading-relaxed">${esc(note)}</span>` : ''}</span></label>`;
};

// Where and how to collect -- only rendered once Collect (or own courier) is chosen for that shipment.
const collectHtml = (c, ownCourier = false) => `<div class="mt-3 rounded-sm border-2 border-charcoal bg-linen/60 p-4 text-sm leading-relaxed">
  <p class="text-espresso/75 mb-3">${ownCourier ? `Your courier collects from the address below — book it for ${esc(c.leadText)}. After ordering, email us the <strong>waybill</strong> and <strong>collection date</strong>.` : `We'll email you a <strong>collection notice</strong> when your order is ready — ${esc(c.leadText)}. Please wait for it before you go.`}</p>
  <p><span class="font-semibold">Address:</span> ${esc(c.address)}</p>
  ${c.hours ? `<p><span class="font-semibold">Hours:</span> ${esc(c.hours)}</p>` : ''}
  ${c.requirements ? `<p class="mt-1"><span class="font-semibold">Bring:</span> ${esc(c.requirements)}</p>` : ''}
  <div class="collect-map mt-3 aspect-[4/3] sm:aspect-[16/9] w-full rounded-sm overflow-hidden border border-charcoal/15 bg-white" data-address="${esc(c.address)}"></div>
  <a class="inline-block mt-2 underline hover:text-terracotta" target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&amp;query=${encodeURIComponent(c.address)}">Open in Google Maps</a>
</div>`;

function renderShipping() {
  document.getElementById('weight').textContent = formatKg(cartWeight());
  const prev = Object.fromEntries(plan.map((g) => [g.key, chosen(g)?.id]));
  const many = plan.length > 1;
  setHtml(
    document.getElementById('ship-options'),
    plan
      .map((g) => {
        const pick = prev[g.key] || (g.options.length === 1 ? g.options[0].id : undefined);
        return `<div data-group="${esc(g.key)}">
        ${many ? `<p class="form-label mb-1">${esc(g.heading)}</p><p class="text-xs text-espresso/60 mb-2">${g.items.map((i) => `${Number(i.quantity)} × ${esc(i.name)}`).join(' · ')}</p>` : ''}
        ${g.largeItems.length ? `<p class="text-xs text-espresso/70 mb-2">Includes large items (${g.largeItems.slice(0, 3).map(esc).join(', ')}${g.largeItems.length > 3 ? '…' : ''}).</p>` : ''}
        ${g.options.length ? `<div class="grid sm:grid-cols-2 gap-3">${g.options.map((o) => optionHtml(g, o, pick)).join('')}</div>` : '<p class="text-sm text-terracotta">No delivery option covers this order weight — please WhatsApp us and we will arrange delivery.</p>'}
        <div class="collect-slot"></div>
      </div>`;
      })
      .join('') || '<p class="text-sm text-espresso/60">Loading delivery options…</p>',
  );
  syncDeliveryFields();
}

// The map loads only once collection is chosen (Google sees nothing before that).
function showMaps() {
  for (const box of document.querySelectorAll('.collect-map')) {
    if (box.firstChild) continue;
    const f = document.createElement('iframe');
    f.src = `https://maps.google.com/maps?q=${encodeURIComponent(box.dataset.address)}&z=15&output=embed`;
    f.title = 'Map of the collection address';
    f.loading = 'lazy';
    f.referrerPolicy = 'no-referrer-when-downgrade';
    f.className = 'w-full h-full border-0';
    box.appendChild(f);
  }
}

function syncDeliveryFields() {
  let needsAddress = false;
  let pudo = false;
  let toDoor = false;
  for (const g of plan) {
    const o = chosen(g);
    const slot = document.querySelector(`[data-group="${CSS.escape(g.key)}"] .collect-slot`);
    const isCollect = o?.method === 'collect' || o?.method === 'own_courier';
    const want = isCollect ? `${o.method}` : '';
    if (slot && slot.dataset.shown !== want) {
      slot.dataset.shown = want;
      setHtml(slot, isCollect ? collectHtml(o.collection, o.method === 'own_courier') : '');
    }
    if (!o || o.method === 'courier' || o.method === 'quote') needsAddress = true;
    if (o?.method === 'store') {
      const isPudo = /pudo/i.test(o.category || '');
      pudo ||= isPudo;
      toDoor ||= isPudo && /door/i.test(o.name);
      if (!isPudo) needsAddress = true;
    }
  }
  document.getElementById('pudo-fields').classList.toggle('hidden', !pudo);
  document.getElementById('address-fields').classList.toggle('hidden', !(needsAddress || toDoor));
  showMaps();
  renderSummary();
}

function renderSummary() {
  const items = getCart();
  setHtml(
    document.getElementById('summary-items'),
    items
      .map(
        (i) => `<div class="flex gap-3"><div class="w-12 h-12 shrink-0 bg-white rounded-sm border border-charcoal/10 overflow-hidden">${i.image ? `<img src="${esc(i.image)}" alt="" class="w-full h-full object-contain p-0.5">` : ''}</div>
        <div class="flex-1 min-w-0"><p class="leading-snug line-clamp-2">${esc(i.name)}</p><p class="text-espresso/55 text-xs">Qty ${Number(i.quantity)}</p></div>
        <p class="font-medium whitespace-nowrap">${formatRand(i.priceCents * i.quantity)}</p></div>`,
      )
      .join(''),
  );
  const sub = cartSubtotal();
  const picks = plan.map(chosen);
  const fee = picks.reduce((t, o) => t + (o?.priceCents || 0) + (o?.insuranceCents || 0), 0);
  const quote = picks.some((o) => o?.method === 'quote');
  const allCollect = picks.length && picks.every((o) => o?.method === 'collect' || o?.method === 'own_courier');
  document.getElementById('sum-subtotal').textContent = formatRand(sub);
  document.getElementById('sum-shipping').textContent =
    !plan.length || picks.some((o) => !o) ? 'Choose an option' : allCollect ? (picks.some((o) => o.method === 'own_courier') ? 'Free — your own courier' : 'Free — collect') : quote ? `${fee ? `${formatRand(fee)} + ` : ''}quoted after order` : fee ? formatRand(fee) : 'Free';
  const discount = Math.min(sub, promoDiscountCents());
  document.getElementById('sum-discount-row').classList.toggle('hidden', !discount);
  document.getElementById('sum-discount').textContent = `−${formatRand(discount)}`;
  document.getElementById('sum-total').textContent = formatRand(sub - discount + fee);
  showPaymentOptions(sub - discount + fee);
}

function showPaymentOptions(totalCents) {
  const { eft } = payOptions;
  const ok = eft.enabled && totalCents >= eft.minCents && totalCents <= eft.maxCents;
  const label = document.getElementById('pay-eft');
  label.classList.toggle('hidden', !ok);
  const radio = label.querySelector('input');
  if (!ok && radio.checked) form.querySelector('input[name="paymentMethod"][value="payfast_card"]').checked = true;
}

function restoreDetails() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    for (const [k, v] of Object.entries(saved)) if (form.elements[k] && typeof v === 'string') form.elements[k].value = v;
  } catch { /* ignore */ }
}

function saveDetails(customer) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(customer));
  } catch { /* ignore */ }
}

function showError(msg) {
  const el = document.getElementById('form-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

// Payfast expects a real form POST (not fetch) so the browser navigates to their hosted page.
function submitToPayfast({ actionUrl, fields }) {
  const f = document.createElement('form');
  f.method = 'POST';
  f.action = actionUrl;
  for (const [name, value] of fields) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    f.appendChild(input);
  }
  document.body.appendChild(f);
  f.submit();
}

form.addEventListener('change', (e) => {
  if (e.target.name?.startsWith('ship-')) syncDeliveryFields();
});

async function loadPlan() {
  plan = await api('/api/checkout/delivery', { method: 'POST', body: { items: getCart().map((i) => ({ productId: i.productId, quantity: i.quantity })) } }).catch(() => []);
  renderShipping();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  document.getElementById('form-error').classList.add('hidden');
  const fd = new FormData(form);
  if (!fd.get('terms')) return showError('Please accept the Terms & Conditions to continue.');
  if (!plan.length || plan.some((g) => !chosen(g))) return showError(plan.length > 1 ? 'Please choose delivery or collection for each warehouse.' : 'Please choose a delivery or collection option.');
  const customer = Object.fromEntries(['firstName', 'lastName', 'email', 'phone', 'addressLine1', 'addressLine2', 'suburb', 'city', 'province', 'postalCode', 'pudoLocker'].map((k) => [k, String(fd.get(k) || '').trim()]));
  const btn = document.getElementById('pay-btn');
  btn.disabled = true;
  btn.textContent = 'Preparing payment…';
  try {
    const res = await api('/api/checkout', {
      method: 'POST',
      body: {
        customer,
        notes: fd.get('notes'),
        delivery: Object.fromEntries(plan.map((g) => [g.key, chosen(g).id])),
        ...promoPayload(),
        paymentMethod: fd.get('paymentMethod'),
        items: getCart().map((i) => ({ productId: i.productId, quantity: i.quantity })),
      },
    });
    saveDetails(customer);
    sessionStorage.setItem('procom-pending-order', res.orderId);
    submitToPayfast(res.payfast);
  } catch (err) {
    showError(err.message);
    btn.disabled = false;
    btn.textContent = 'Pay securely with Payfast';
  }
});

async function init() {
  api('/api/payment-options').then((o) => {
    payOptions = o;
    renderSummary();
  }).catch(() => {});
  if (new URLSearchParams(location.search).get('cancelled')) notice('Payment was cancelled — nothing was charged. Your cart is still here whenever you are ready.');
  const { changed } = await refreshCart().catch(() => ({ changed: false }));
  if (changed) notice('Some prices or availability in your cart changed since you added them. Please review your order below.');
  if (!getCart().length) {
    form.classList.add('hidden');
    document.getElementById('empty').classList.remove('hidden');
    return;
  }
  restoreDetails();
  track('checkout_start', { items: getCart().length });
  await initAccountCheckout(form).catch(() => {});
  initPromo({ onChange: renderSummary });
  await loadPlan();
  window.addEventListener('cart:updated', () => {
    if (!getCart().length) location.reload();
    loadPlan();
  });
}

init();
