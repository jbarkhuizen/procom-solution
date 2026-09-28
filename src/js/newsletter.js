// newsletter.html: confirm (?confirm=<token>), one-click unsubscribe
// (?unsubscribe=<token>) and "subscribe again". The signup form itself is
// handled by newsletter-signup.js (loaded by the footer partial).
import { api, esc } from './api.js';
import { setHtml } from './dom.js';

const params = new URLSearchParams(location.search);
const statusBox = document.querySelector('[data-nl-status]');
const title = document.querySelector('[data-nl-title]');
const signup = document.querySelector('[data-nl-signup]');
const isToken = (t) => /^[a-f0-9]{64}$/.test(t || '');

function show(heading, markup, { hideSignup = true } = {}) {
  if (heading) title.textContent = heading;
  setHtml(statusBox, markup);
  statusBox.classList.remove('hidden');
  if (hideSignup) signup.classList.add('hidden');
}

const shopLinks = `<div class="flex flex-wrap gap-3 mt-5">
  <a href="/specials.html" class="inline-flex bg-charcoal text-cream rounded-full px-6 py-3 text-sm font-semibold hover:bg-terracotta">See current specials</a>
  <a href="/shop.html" class="inline-flex border-2 border-charcoal rounded-full px-6 py-3 text-sm font-semibold hover:bg-charcoal hover:text-cream">Shop all products</a></div>`;

async function confirm(token) {
  show('Confirming…', '<p>One moment…</p>');
  try {
    const r = await api('/api/newsletter/confirm', { method: 'POST', body: { token } });
    show("You're subscribed.", `<p class="text-lg">Thanks — <strong>${esc(r.email)}</strong> will now get our specials and new products by email.</p>
      <p class="text-sm text-espresso/65 mt-3">Changed your mind? Every email has a one-click unsubscribe link.</p>${shopLinks}`);
    if (r.manageToken) history.replaceState(null, '', `/newsletter.html?manage=${encodeURIComponent(r.manageToken)}`);
  } catch (err) {
    show('Link expired', `<p>${esc(err.message)}</p>`, { hideSignup: false });
  }
}

async function unsubscribe(token) {
  show('Unsubscribing…', '<p>One moment…</p>');
  try {
    const r = await api('/api/newsletter/unsubscribe', { method: 'POST', body: { token } });
    show("You've been unsubscribed.", `<p class="text-lg"><strong>${esc(r.email)}</strong> won't get any more newsletters from us. Order emails (confirmations, invoices, delivery updates) still arrive as normal.</p>
      <p class="text-sm text-espresso/65 mt-3">Unsubscribed by mistake?</p>
      <button type="button" data-nl-resub class="mt-3 inline-flex border-2 border-charcoal rounded-full px-6 py-3 text-sm font-semibold hover:bg-charcoal hover:text-cream">Subscribe again</button>`);
  } catch (err) {
    show('Link not recognised', `<p>${esc(err.message)}</p>`);
  }
}

async function resubscribe(token) {
  try {
    const r = await api('/api/newsletter/resubscribe', { method: 'POST', body: { token } });
    show('Welcome back.', `<p class="text-lg"><strong>${esc(r.email)}</strong> is subscribed again.</p>${shopLinks}`);
  } catch (err) {
    show(null, `<p>${esc(err.message)}</p>`);
  }
}

// After confirming, the URL carries ?manage=<token>: shows the status and
// offers unsubscribe without doing it (a reload must not unsubscribe).
async function manage(token) {
  try {
    const s = await api(`/api/newsletter/status?token=${encodeURIComponent(token)}`);
    show(s.subscribed ? "You're subscribed." : 'Not subscribed', `<p class="text-lg"><strong>${esc(s.email)}</strong> ${s.subscribed ? 'gets our specials and new products by email.' : "doesn't get our newsletter."}</p>
      <button type="button" data-nl-${s.subscribed ? 'unsub' : 'resub'} class="mt-4 inline-flex border-2 border-charcoal rounded-full px-6 py-3 text-sm font-semibold hover:bg-charcoal hover:text-cream">${s.subscribed ? 'Unsubscribe' : 'Subscribe again'}</button>`);
  } catch (err) {
    show('Link not recognised', `<p>${esc(err.message)}</p>`, { hideSignup: false });
  }
}

const unsubToken = params.get('unsubscribe');
const confirmToken = params.get('confirm');
statusBox?.addEventListener('click', (e) => {
  if (e.target.closest('[data-nl-resub]')) resubscribe(unsubToken || params.get('manage'));
  if (e.target.closest('[data-nl-unsub]')) unsubscribe(unsubToken || params.get('manage'));
});

if (isToken(confirmToken)) confirm(confirmToken);
else if (unsubToken === 'test') show('Test email', '<p>This unsubscribe link comes from a test email, so it does nothing.</p>', { hideSignup: false });
else if (isToken(unsubToken)) unsubscribe(unsubToken); // one click from the email
else if (isToken(params.get('manage'))) manage(params.get('manage'));
else if (confirmToken || unsubToken) show('Link not recognised', '<p>This link looks incomplete. Try copying the whole link from the email, or contact us and we’ll sort it out.</p>', { hideSignup: false });
