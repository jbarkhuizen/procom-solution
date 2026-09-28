// First-party analytics beacon (analytics feature, server/features/analytics.js).
// site.js imports this on every storefront page; cart/checkout call track().
//
// Privacy: no cookies, no third parties. A random visitor id is kept in
// localStorage only to tell "one visitor, several pages" from "several
// visitors"; it carries no personal information. We send the page path, the
// referring site's host name (never the full URL), the product/category on
// the page and the shop search. Nothing is sent when the browser asks not to
// be tracked (Do Not Track / Global Privacy Control), or after ?analytics=off
// (?analytics=on switches it back) -- handy for the owner's own browsing.
//
// Everything here is best-effort: it never throws and never blocks the page.

const VISITOR_KEY = 'procom-visitor-id';
const OPTOUT_KEY = 'procom-analytics-optout';
const HEARTBEAT_MS = 45_000;
const ENDPOINT = '/api/analytics/';

let visitorId = '';
let enabled = null;

function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function randomId() {
  return safe(() => crypto.randomUUID(), '') || `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

function isEnabled() {
  if (enabled !== null) return enabled;
  enabled = safe(() => {
    const flag = new URLSearchParams(location.search).get('analytics');
    safe(() => {
      if (flag === 'off') localStorage.setItem(OPTOUT_KEY, '1');
      if (flag === 'on') localStorage.removeItem(OPTOUT_KEY);
    });
    const dnt = navigator.doNotTrack === '1' || navigator.doNotTrack === 'yes' || window.doNotTrack === '1' || navigator.globalPrivacyControl === true;
    const optedOut = safe(() => localStorage.getItem(OPTOUT_KEY) === '1', false);
    return !dnt && !optedOut && flag !== 'off';
  }, false);
  return enabled;
}

function getVisitorId() {
  if (visitorId) return visitorId;
  visitorId = safe(() => {
    let id = localStorage.getItem(VISITOR_KEY);
    if (!id || !/^[A-Za-z0-9-]{8,64}$/.test(id)) {
      id = randomId();
      localStorage.setItem(VISITOR_KEY, id);
    }
    return id;
  }, '') || randomId(); // storage blocked: a per-page id still counts the view
  return visitorId;
}

function send(kind, payload) {
  safe(() => {
    const body = JSON.stringify({ v: getVisitorId(), path: location.pathname, ...payload });
    const url = ENDPOINT + kind;
    if (navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))) return;
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true, credentials: 'same-origin' }).catch(() => {});
  });
}

function referrerHost() {
  return safe(() => {
    if (!document.referrer) return '';
    const host = new URL(document.referrer).host;
    return host === location.host ? '' : host;
  }, '');
}

function pageDetails() {
  return safe(() => {
    const q = new URLSearchParams(location.search);
    const path = location.pathname.replace(/\.html$/, '');
    return {
      product: path === '/product' ? q.get('p') || '' : '',
      category: q.get('category') || document.body?.dataset.category || '',
      q: path === '/shop' ? (q.get('q') || '').slice(0, 100) : '',
    };
  }, {});
}

// Funnel events: add_to_cart (cart.js), checkout_start (checkout.js).
export function track(event, data = {}) {
  safe(() => {
    if (!isEnabled()) return;
    const clean = {};
    for (const k of ['productId', 'quantity', 'items']) if (data && data[k] != null) clean[k] = data[k];
    send('event', { event: String(event), data: clean });
  });
}

function start() {
  if (!isEnabled()) return;
  send('view', { ref: referrerHost(), ...pageDetails() });
  // "Online now": a heartbeat while the tab is visible, plus one on return.
  const ping = () => safe(() => document.visibilityState === 'visible' && send('ping', {}));
  setInterval(ping, HEARTBEAT_MS);
  safe(() => document.addEventListener('visibilitychange', ping));
}

// Pages that can't run the storefront (e.g. no window) skip silently.
safe(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => safe(start), { once: true });
  else start();
});
