import './site.js';
import { api, esc, formatRand } from './api.js';
import { setHtml } from './dom.js';

// Customer account page: log in / register / forgot + reset password /
// confirm email (?verify=), and for a logged-in customer their orders,
// delivery details, newsletter choice and password.

const $ = (id) => document.getElementById(id);
const SECTIONS = ['guest', 'forgot', 'reset', 'member'];
const params = new URLSearchParams(location.search);

function show(name) {
  $('acc-loading').classList.add('hidden');
  for (const s of SECTIONS) $(`acc-${s}`).classList.toggle('hidden', s !== name);
}

function notice(message, tone = 'ok') {
  const el = $('acc-notice');
  el.textContent = message;
  el.className = `rounded-sm border-2 p-4 text-sm mb-6 ${tone === 'error' ? 'border-terracotta text-terracotta' : 'border-charcoal'}`;
}

function result(form, message, isError = false) {
  const el = form.querySelector('[data-result]');
  el.textContent = message;
  el.className = `text-sm font-medium ${isError ? 'text-terracotta' : ''}`;
}

// Only same-site paths, so ?next= can't send people elsewhere.
function nextUrl() {
  const n = params.get('next') || '';
  return /^\/(?!\/)[\w\-./?=&%]*$/.test(n) ? n : '';
}

// Drop tokens from the address bar (and history) once used.
function cleanUrl() {
  const keep = new URLSearchParams();
  if (nextUrl()) keep.set('next', nextUrl());
  history.replaceState(null, '', `/account.html${keep.toString() ? `?${keep}` : ''}`);
}

// Wraps a form submit: disables the button, shows errors under the form.
function onSubmit(form, handler) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    form.querySelector('[data-result]')?.classList.add('hidden');
    try {
      await handler(Object.fromEntries(new FormData(form)));
    } catch (err) {
      result(form, err.message, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

// ------------------------------------------------------------- logged in

const STATUS_TONE = { cancelled: 'text-espresso/50', pending_payment: 'text-terracotta' };
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

async function renderOrders() {
  const box = $('acc-orders');
  let list = [];
  try {
    list = await api('/api/account/orders');
  } catch (err) {
    box.textContent = err.message;
    return;
  }
  if (!list.length) {
    setHtml(box, `<div class="border-2 border-dashed border-charcoal/25 rounded-sm p-8 text-center"><p class="text-espresso/70 mb-4">No orders yet. Orders you place with this email address will show up here.</p><a href="/shop.html" class="inline-flex bg-charcoal text-cream rounded-full px-5 py-2.5 text-sm font-semibold hover:bg-terracotta">Browse products</a></div>`);
    return;
  }
  const rows = list
    .map(
      (o) => `<tr class="border-t border-charcoal/10">
      <td class="px-4 py-3 font-semibold whitespace-nowrap">${esc(o.orderNumber)}</td>
      <td class="px-4 py-3 whitespace-nowrap">${esc(fmtDate(o.createdAt))}</td>
      <td class="px-4 py-3 ${STATUS_TONE[o.status] || ''}">${esc(o.statusLabel)}${o.trackingNumber ? `<span class="block text-xs text-espresso/60">Tracking: ${esc(o.trackingNumber)}</span>` : ''}</td>
      <td class="px-4 py-3 text-right whitespace-nowrap">${esc(formatRand(o.totalCents))}<span class="block text-xs text-espresso/55">${Number(o.itemCount)} item${o.itemCount === 1 ? '' : 's'}</span></td>
      <td class="px-4 py-3 text-right whitespace-nowrap">${o.invoiceUrl ? `<a href="${esc(o.invoiceUrl)}" class="underline font-semibold hover:text-terracotta">Invoice</a>` : '<span class="text-espresso/40">—</span>'}</td>
    </tr>`,
    )
    .join('');
  // Phones get stacked cards instead of a table that scrolls sideways.
  const cards = list
    .map(
      (o) => `<div class="border-2 border-charcoal rounded-sm p-4 text-sm">
      <div class="flex justify-between gap-3"><span class="font-semibold">${esc(o.orderNumber)}</span><span>${esc(formatRand(o.totalCents))}</span></div>
      <div class="flex justify-between gap-3 text-espresso/65 mt-1"><span>${esc(fmtDate(o.createdAt))} · ${Number(o.itemCount)} item${o.itemCount === 1 ? '' : 's'}</span><span class="${STATUS_TONE[o.status] || ''}">${esc(o.statusLabel)}</span></div>
      ${o.trackingNumber ? `<p class="text-xs text-espresso/60 mt-1">Tracking: ${esc(o.trackingNumber)}</p>` : ''}
      ${o.invoiceUrl ? `<a href="${esc(o.invoiceUrl)}" class="inline-block mt-2 underline font-semibold hover:text-terracotta">View invoice</a>` : ''}
    </div>`,
    )
    .join('');
  setHtml(
    box,
    `<div class="sm:hidden space-y-3">${cards}</div>
    <div class="hidden sm:block border-2 border-charcoal rounded-sm overflow-x-auto"><table class="w-full text-sm">
      <thead class="bg-linen text-left"><tr><th class="px-4 py-2.5 font-semibold">Order</th><th class="px-4 py-2.5 font-semibold">Date</th><th class="px-4 py-2.5 font-semibold">Status</th><th class="px-4 py-2.5 font-semibold text-right">Total</th><th class="px-4 py-2.5 font-semibold text-right">Invoice</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`,
  );
}

function fillDetails(c) {
  const form = $('details-form');
  for (const k of ['firstName', 'lastName', 'phone', 'addressLine1', 'addressLine2', 'suburb', 'city', 'province', 'postalCode']) {
    if (form.elements[k]) form.elements[k].value = c[k] || '';
  }
  $('nl-check').checked = Boolean(c.newsletter);
}

function showMember(c) {
  $('acc-welcome').textContent = c.firstName ? `Hi, ${c.firstName}` : 'Welcome back';
  $('acc-email').textContent = `Logged in as ${c.email}`;
  fillDetails(c);
  show('member');
  renderOrders();
}

onSubmit($('details-form'), async (data) => {
  const { client } = await api('/api/account/me', { method: 'PUT', body: data });
  fillDetails(client);
  $('acc-welcome').textContent = `Hi, ${client.firstName}`;
  result($('details-form'), 'Saved — these will be filled in at checkout.');
});

$('nl-check').addEventListener('change', async (e) => {
  const form = $('newsletter-form');
  try {
    await api('/api/account/me', { method: 'PUT', body: { newsletter: e.target.checked } });
    result(form, e.target.checked ? "You're subscribed." : "You're unsubscribed.");
  } catch (err) {
    e.target.checked = !e.target.checked;
    result(form, err.message, true);
  }
});

onSubmit($('password-form'), async (data) => {
  if (String(data.newPassword || '').length < 8) throw new Error('Your new password needs at least 8 characters.');
  await api('/api/account/password', { method: 'PUT', body: data });
  $('password-form').reset();
  result($('password-form'), 'Password changed. Other devices have been logged out.');
});

$('logout-btn').addEventListener('click', async () => {
  await api('/api/account/logout', { method: 'POST' }).catch(() => {});
  location.href = '/account.html';
});

// ------------------------------------------------------------ logged out

function afterLogin(client, message = '') {
  const next = nextUrl();
  if (next) {
    location.href = next;
    return;
  }
  cleanUrl();
  if (message) notice(message);
  showMember(client);
}

onSubmit($('login-form'), async (data) => {
  const { client } = await api('/api/account/login', { method: 'POST', body: { email: data.email, password: data.password } });
  afterLogin(client);
});

onSubmit($('register-form'), async (data) => {
  if (!data.firstName?.trim() || !data.lastName?.trim()) throw new Error('Please fill in your first name and surname.');
  if (String(data.password || '').length < 8) throw new Error('Your password needs at least 8 characters.');
  if (data.password !== data.confirmPassword) throw new Error("The two passwords don't match.");
  const { confirmPassword: _c, ...body } = data;
  const res = await api('/api/account/register', { method: 'POST', body: { ...body, newsletter: data.newsletter === 'on' } });
  $('register-form').reset();
  result($('register-form'), res.message);
});

onSubmit($('forgot-form'), async (data) => {
  const res = await api('/api/account/forgot-password', { method: 'POST', body: { email: data.email } });
  result($('forgot-form'), res.message);
});

onSubmit($('reset-form'), async (data) => {
  if (String(data.password || '').length < 8) throw new Error('Your password needs at least 8 characters.');
  if (data.password !== data.confirmPassword) throw new Error("The two passwords don't match.");
  const { client } = await api('/api/account/reset-password', { method: 'POST', body: { token: params.get('reset'), password: data.password } });
  afterLogin(client, 'Your new password is saved and you are logged in.');
});

document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-show]');
  if (!link) return;
  e.preventDefault();
  show(link.dataset.show);
  const email = $('l-email').value;
  if (link.dataset.show === 'forgot' && email) $('f-email').value = email;
});

// ------------------------------------------------------------------- boot

async function init() {
  const verify = params.get('verify');
  if (verify) {
    try {
      const { client } = await api('/api/account/verify', { method: 'POST', body: { token: verify } });
      afterLogin(client, 'Thanks — your email is confirmed and you are logged in.');
      return;
    } catch (err) {
      cleanUrl();
      notice(err.message, 'error');
    }
  }
  if (params.get('reset')) {
    show('reset');
    return;
  }
  const me = await api('/api/account/me').catch(() => ({ authenticated: false }));
  if (me.authenticated && nextUrl()) location.href = nextUrl();
  else if (me.authenticated) showMember(me.client);
  else show(location.hash === '#forgot' ? 'forgot' : 'guest');
}

init();
