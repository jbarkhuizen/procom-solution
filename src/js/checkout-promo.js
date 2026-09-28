// Checkout promo-code field (promos feature). checkout.js calls these.
//
// The discount shown here is a preview from POST /api/promo/check; the server
// recomputes (and caps at cost) the real discount when the order is placed.
// The code is re-checked whenever the cart or the email changes, because
// both can change the answer (restricted codes, per-customer limits).
import { api, formatRand } from './api.js';
import { getCart } from './cart.js';
import { setHtml } from './dom.js';

const STORE_KEY = 'procom-promo';
let applied = null; // { code, discountCents, message }
let notify = () => {};
let seq = 0;
let els = null;

export function promoPayload() {
  return applied ? { promoCode: applied.code } : {};
}

export function promoDiscountCents() {
  return applied ? applied.discountCents : 0;
}

function remember(code) {
  try {
    if (code) sessionStorage.setItem(STORE_KEY, code);
    else sessionStorage.removeItem(STORE_KEY);
  } catch { /* storage blocked */ }
}

function showMessage(text, kind) {
  els.msg.textContent = text;
  els.msg.classList.toggle('hidden', !text);
  els.msg.classList.toggle('text-terracotta', kind === 'error');
  els.msg.classList.toggle('font-semibold', kind === 'ok');
  els.msg.classList.toggle('text-espresso/60', kind === 'info');
}

function showApplied() {
  const on = Boolean(applied);
  els.input.readOnly = on;
  els.apply.classList.toggle('hidden', on);
  els.remove.classList.toggle('hidden', !on);
  if (on) {
    els.input.value = applied.code;
    showMessage(`${applied.message} You save ${formatRand(applied.discountCents)}.`, 'ok');
  }
}

function setApplied(next) {
  applied = next;
  remember(next ? next.code : '');
  showApplied();
  notify();
}

async function check(code, { quiet = false } = {}) {
  const items = getCart().map((i) => ({ productId: i.productId, quantity: i.quantity }));
  if (!code || !items.length) return;
  const mine = ++seq;
  els.apply.disabled = true;
  if (!quiet) showMessage('Checking…', 'info');
  try {
    const email = document.getElementById('email')?.value.trim() || '';
    const res = await api('/api/promo/check', { method: 'POST', body: { code, items, email } });
    if (mine !== seq) return; // a newer check is on its way
    if (res.ok) {
      setApplied({ code: res.code, discountCents: res.discountCents, message: res.message });
    } else {
      const wasApplied = Boolean(applied);
      applied = null;
      remember('');
      showApplied();
      showMessage(res.message || 'That promo code is not valid.', 'error');
      if (wasApplied) notify();
    }
  } catch (err) {
    if (mine !== seq) return;
    showMessage(err.message || 'Could not check the code. Please try again.', 'error');
  } finally {
    if (mine === seq) els.apply.disabled = false;
  }
}

export function initPromo({ onChange } = {}) {
  const slot = document.getElementById('promo-slot');
  if (!slot) return;
  notify = typeof onChange === 'function' ? onChange : () => {};
  setHtml(
    slot,
    `<label class="form-label" for="promo-code">Promo code</label>
    <div class="flex gap-2">
      <input class="form-input flex-1 min-w-0 !py-2 uppercase" id="promo-code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="40" placeholder="Enter code">
      <button type="button" id="promo-apply" class="shrink-0 bg-charcoal text-cream rounded-full px-4 py-2 text-sm font-semibold hover:bg-terracotta transition-colors disabled:opacity-50">Apply</button>
      <button type="button" id="promo-remove" class="hidden shrink-0 border border-charcoal/30 rounded-full px-4 py-2 text-sm font-semibold hover:border-terracotta hover:text-terracotta transition-colors">Remove</button>
    </div>
    <p id="promo-msg" class="hidden text-xs mt-2 leading-snug" role="status" aria-live="polite"></p>`,
  );
  els = {
    input: slot.querySelector('#promo-code'),
    apply: slot.querySelector('#promo-apply'),
    remove: slot.querySelector('#promo-remove'),
    msg: slot.querySelector('#promo-msg'),
  };

  const submit = () => {
    const code = els.input.value.trim();
    if (!code) return showMessage('Enter a promo code.', 'error');
    check(code);
  };
  els.apply.addEventListener('click', submit);
  // Enter in the code field applies the code instead of submitting the checkout form.
  els.input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!applied) submit();
  });
  els.remove.addEventListener('click', () => {
    seq++;
    els.input.value = '';
    showMessage('', 'info');
    setApplied(null);
    els.input.focus();
  });

  let timer;
  const recheck = () => {
    if (!applied) return;
    clearTimeout(timer);
    timer = setTimeout(() => applied && getCart().length && check(applied.code, { quiet: true }), 300);
  };
  window.addEventListener('cart:updated', recheck);
  document.getElementById('email')?.addEventListener('change', recheck);

  // Keep an applied code across a page reload in the same tab.
  let saved = '';
  try { saved = sessionStorage.getItem(STORE_KEY) || ''; } catch { /* storage blocked */ }
  if (saved) {
    els.input.value = saved;
    check(saved, { quiet: true });
  }
}
