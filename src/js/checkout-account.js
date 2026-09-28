// Prefills checkout for a logged-in customer (accounts feature). checkout.js calls this.
// Guest checkout stays: logged out, the slot only offers an optional log in.
import { api, esc } from './api.js';
import { setHtml } from './dom.js';

const FIELDS = ['firstName', 'lastName', 'email', 'phone', 'addressLine1', 'addressLine2', 'suburb', 'city', 'province', 'postalCode'];
const linkCls = 'underline font-semibold hover:text-terracotta';

export async function initAccountCheckout(form) {
  const slot = document.getElementById('account-slot');
  if (!slot || !form) return;
  const me = await api('/api/account/me').catch(() => ({ authenticated: false }));
  const next = encodeURIComponent('/checkout.html');

  if (!me.authenticated) {
    setHtml(slot, `<p class="text-sm text-espresso/70 border border-charcoal/15 rounded-sm px-4 py-3">Have an account? <a href="/account.html?next=${next}" class="${linkCls}">Log in</a> to fill in your details, or <a href="/account.html?next=${next}#register-form" class="${linkCls}">create an account</a> (optional — guest checkout is fine).</p>`);
    return;
  }

  const c = me.client;
  // Account details win over whatever this browser remembered from a previous checkout.
  for (const k of FIELDS) {
    const el = form.elements[k];
    if (el && c[k]) el.value = c[k];
  }
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ');
  setHtml(slot, `<div class="text-sm border-2 border-charcoal rounded-sm px-4 py-3 bg-linen/40 flex flex-wrap items-center justify-between gap-2">
    <span>Logged in as <strong>${esc(name || c.email)}</strong>${name ? ` <span class="text-espresso/60">(${esc(c.email)})</span>` : ''}. This order will appear in <a href="/account.html" class="${linkCls}">your account</a>.</span>
    <button type="button" data-account-logout class="text-xs uppercase tracking-wide font-semibold underline hover:text-terracotta">Not you? Log out</button>
  </div>`);
  // Orders link to the account by email, so say so if they change it.
  const email = form.elements.email;
  const hint = document.createElement('p');
  hint.className = 'text-xs text-terracotta mt-1.5 hidden';
  hint.textContent = `Orders appear in your account only when placed with ${c.email}.`;
  email?.insertAdjacentElement('afterend', hint);
  email?.addEventListener('input', () => hint.classList.toggle('hidden', email.value.trim().toLowerCase() === c.email));

  slot.querySelector('[data-account-logout]').addEventListener('click', async () => {
    await api('/api/account/logout', { method: 'POST' }).catch(() => {});
    try {
      localStorage.removeItem('procom-checkout-details'); // don't leave this person's details for the next one
    } catch { /* ignore */ }
    location.reload();
  });
}
