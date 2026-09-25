import './site.js';
import { api, esc, formatRand } from './api.js';
import { getCart, cartSubtotal, cartWeight, refreshCart } from './cart.js';
import { setHtml } from './dom.js';

const form = document.getElementById('checkout-form');
const PREFS_KEY = 'procom-checkout-details';
let options = [];

function notice(message, tone = 'warn') {
  const el = document.getElementById('notice');
  el.textContent = message;
  el.className = `rounded-sm border-2 p-4 text-sm mb-6 ${tone === 'warn' ? 'border-terracotta text-terracotta' : 'border-charcoal'}`;
}

function formatKg(g) {
  return g >= 1000 ? `${(g / 1000).toFixed(g % 1000 ? 1 : 0)} kg` : `${g} g`;
}

function selectedOption() {
  const id = form.querySelector('input[name="shippingOptionId"]:checked')?.value;
  return options.find((o) => o.id === id) || null;
}

// Courier brackets collapse into the single one matching the cart weight;
// named options (PUDO, Local) are listed for the customer to choose.
function renderShipping() {
  const weight = cartWeight();
  document.getElementById('weight').textContent = formatKg(weight);
  const groups = new Map();
  for (const o of options) {
    if (o.optionType === 'auto_weight' && (weight < o.minWeight || (o.maxWeight != null && weight > o.maxWeight))) continue;
    if (!groups.has(o.category)) groups.set(o.category, []);
    groups.get(o.category).push(o);
  }
  const prev = selectedOption()?.id;
  setHtml(
    document.getElementById('ship-options'),
    [...groups.entries()]
      .map(
        ([cat, opts]) => `<div><p class="form-label mb-2">${esc(cat)}</p><div class="grid sm:grid-cols-2 gap-3">${opts
          .map(
            (o) => `<label class="ship-option"><input type="radio" name="shippingOptionId" value="${esc(o.id)}" ${o.id === prev ? 'checked' : ''} required>
            <span class="flex-1"><span class="block text-sm font-semibold leading-snug">${esc(o.name)}</span><span class="block text-sm text-terracotta font-semibold mt-0.5">${formatRand(o.priceCents)}</span></span></label>`,
          )
          .join('')}</div></div>`,
      )
      .join('') || '<p class="text-sm text-terracotta">No delivery option covers this order weight — please WhatsApp us and we will arrange delivery.</p>',
  );
  syncDeliveryFields();
}

function syncDeliveryFields() {
  const o = selectedOption();
  const isPudo = Boolean(o && o.optionType === 'fixed' && /pudo/i.test(o.category));
  const toDoor = Boolean(o && /door/i.test(o.name));
  document.getElementById('pudo-fields').classList.toggle('hidden', !isPudo);
  document.getElementById('address-fields').classList.toggle('hidden', isPudo && !toDoor);
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
  const ship = selectedOption();
  document.getElementById('sum-subtotal').textContent = formatRand(sub);
  document.getElementById('sum-shipping').textContent = ship ? formatRand(ship.priceCents) : 'Choose an option';
  document.getElementById('sum-total').textContent = formatRand(sub + (ship?.priceCents || 0));
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
  if (e.target.name === 'shippingOptionId') syncDeliveryFields();
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  document.getElementById('form-error').classList.add('hidden');
  const fd = new FormData(form);
  if (!fd.get('terms')) return showError('Please accept the Terms & Conditions to continue.');
  if (!fd.get('shippingOptionId')) return showError('Please choose a delivery option.');
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
        shippingOptionId: fd.get('shippingOptionId'),
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
  if (new URLSearchParams(location.search).get('cancelled')) notice('Payment was cancelled — nothing was charged. Your cart is still here whenever you are ready.');
  const { changed } = await refreshCart().catch(() => ({ changed: false }));
  if (changed) notice('Some prices or availability in your cart changed since you added them. Please review your order below.');
  if (!getCart().length) {
    form.classList.add('hidden');
    document.getElementById('empty').classList.remove('hidden');
    return;
  }
  restoreDetails();
  options = await api('/api/shipping-options');
  renderShipping();
  window.addEventListener('cart:updated', () => {
    if (!getCart().length) location.reload();
    renderShipping();
  });
}

init();
