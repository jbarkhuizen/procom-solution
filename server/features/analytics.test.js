import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';

process.env.UPLOADS_DIR = path.join(os.tmpdir(), 'procom-test-uploads');
process.env.DISABLE_BACKUPS = '1';
delete process.env.GMAIL_USER; // never send real mail from tests

const { useMemoryDb } = await import('../db.js');
const catalog = await import('../catalog.js');
const orders = await import('../orders.js');
const auth = await import('../auth.js');
const analytics = await import('./analytics.js');
const express = (await import('express')).default;
const cookieParser = (await import('cookie-parser')).default;
const rateLimit = (await import('express-rate-limit')).default;

let db;
beforeEach(() => {
  db = useMemoryDb();
  analytics._resetOnline();
});

const realLog = console.log;
console.log = (...args) => (String(args[0]).startsWith('[mail disabled]') ? undefined : realLog(...args));
after(() => (console.log = realLog));

const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const catId = (slug) => db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug).id;
const courierSmall = () => db.prepare("SELECT id FROM shipping_options WHERE name LIKE 'PUDO Small%'").get().id;
const customer = { firstName: 'Ann', lastName: 'Lee', email: 'ann@example.com', phone: '0821234567', addressLine1: '1 Main Rd', city: 'Pretoria', postalCode: '0081' };
let skuN = 0;
const product = (over = {}) => catalog.saveProduct({ name: 'Test Mouse', sku: `T${++skuN}`, brand: 'Logi', costCents: 10000, categoryId: catId('keyboards-mice'), weightG: 500, active: true, ...over });
const view = (over = {}) => analytics.parseView({ v: 'visitor-0001', path: '/', ...over });

// A tiny app with the feature mounted, like server/index.js does it.
async function withServer(fn, opts = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  const admin = express.Router();
  const wrap = (f) => async (req, res) => {
    try {
      const out = await f(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  };
  analytics.register({ app, admin, wrap, rateLimit, express, siteUrl: 'https://www.procomsolutions.co.za', pruneJob: false, ...opts });
  app.use('/api/admin', admin);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (kind, body, headers = {}) =>
    fetch(`${base}/api/analytics/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': BROWSER, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  try {
    await fn({ base, post });
  } finally {
    server.close();
  }
}

const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

test('ingestion: valid page view is stored with derived fields only', async () => {
  await withServer(async ({ post }) => {
    const r = await post('view', { v: 'abc12345-visitor', path: '/product.html', ref: 'www.Google.com', product: 'logi-mouse', category: '', q: 'ignored off shop', extra: 'x'.repeat(50) }, { 'User-Agent': PHONE });
    assert.equal(r.status, 204);
    const row = db.prepare('SELECT * FROM page_views').get();
    assert.equal(row.path, '/product');
    assert.equal(row.referrer_host, 'google.com');
    assert.equal(row.product_slug, 'logi-mouse');
    assert.equal(row.search_query, '');
    assert.equal(row.device, 'mobile');
    assert.equal(row.logged_in, 0);
    assert.match(row.day, /^\d{4}-\d{2}-\d{2}$/);
    // Nothing identifying: no IP / user agent columns at all.
    const cols = db.prepare('PRAGMA table_info(page_views)').all().map((c) => c.name);
    assert.ok(!cols.some((c) => /ip|agent|client|email/i.test(c)), cols.join(','));
  });
});

test('ingestion: invalid fields and oversized bodies are rejected', async () => {
  await withServer(async ({ post }) => {
    assert.equal((await post('view', { v: 'short', path: '/' })).status, 400); // visitor id too short
    assert.equal((await post('view', { v: 'visitor-0001', path: 'https://evil.test/' })).status, 400);
    assert.equal((await post('view', { v: 'visitor-0001', path: '//evil.test' })).status, 400);
    assert.equal((await post('view', { v: 'visitor-0001', path: '/<script>' })).status, 400);
    assert.equal((await post('view', { v: 'visitor-0001', path: '/product.html', product: 'bad slug!' })).status, 400);
    assert.equal((await post('view', [1, 2])).status, 400);
    assert.equal((await post('event', { v: 'visitor-0001', event: 'hack' })).status, 400);
    assert.equal((await post('event', { v: 'visitor-0001', event: 'add_to_cart', data: { quantity: -1 } })).status, 400);
    assert.equal((await post('event', { v: 'visitor-0001', event: 'add_to_cart', data: { productId: 'x y' } })).status, 400);
    assert.equal((await post('view', { v: 'visitor-0001', path: '/', pad: 'x'.repeat(3000) })).status, 413);
    assert.equal(count('page_views'), 0);
    assert.equal(count('analytics_events'), 0);
    // Self-referrals and junk referrers are dropped, not rejected.
    assert.equal((await post('view', { v: 'visitor-0001', path: '/', ref: 'procomsolutions.co.za' })).status, 204);
    assert.equal((await post('view', { v: 'visitor-0001', path: '/', ref: 'not a host' })).status, 204);
    assert.deepEqual(db.prepare('SELECT referrer_host FROM page_views').all().map((r) => r.referrer_host), ['', '']);
  });
});

test('bots, link previews, headless browsers and staff sessions are ignored', async () => {
  for (const ua of ['Googlebot/2.1 (+http://www.google.com/bot.html)', 'Mozilla/5.0 (compatible; bingbot/2.0)', 'facebookexternalhit/1.1', 'curl/8.4.0', 'python-requests/2.31', 'Mozilla/5.0 HeadlessChrome/128.0', 'WhatsApp/2.23.20.0', '']) {
    assert.equal(analytics.isBot(ua), true, ua);
  }
  for (const ua of [BROWSER, PHONE, 'Mozilla/5.0 (Linux; Android 12; CUBOT X50) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36']) assert.equal(analytics.isBot(ua), false, ua);
  assert.equal(analytics.deviceFromUa(PHONE), 'mobile');
  assert.equal(analytics.deviceFromUa('Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X)'), 'tablet');
  assert.equal(analytics.deviceFromUa(BROWSER), 'desktop');

  await withServer(async ({ post }) => {
    assert.equal((await post('view', { v: 'visitor-0001', path: '/' }, { 'User-Agent': 'Googlebot/2.1' })).status, 204);
    assert.equal((await post('event', { v: 'visitor-0001', event: 'add_to_cart' }, { 'User-Agent': 'curl/8' })).status, 204);
    const a = auth.createAdmin({ username: 'owner', password: 'correct horse battery' });
    const token = auth.createSession(a.id);
    assert.equal((await post('view', { v: 'visitor-0001', path: '/' }, { Cookie: `${auth.SESSION_COOKIE}=${token}` })).status, 204);
    assert.equal(count('page_views'), 0);
    assert.equal(count('analytics_events'), 0);
    assert.equal(analytics.onlineNow().count, 0);
  });
});

test('ingestion is rate limited per client', async () => {
  await withServer(async ({ post }) => {
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await post('ping', { v: 'visitor-0001', path: '/' })).status);
    assert.deepEqual(statuses, [204, 204, 204, 429]);
  }, { limit: 3 });
});

test('heartbeats keep a visitor online without storing rows', () => {
  const t0 = Date.parse('2026-09-28T10:00:00Z');
  analytics.touchVisitor('visitor-0001', { path: '/shop', device: 'mobile', now: t0 });
  analytics.touchVisitor('visitor-0002', { path: '/shop', now: t0 });
  analytics.touchVisitor('visitor-0003', { path: '/', now: t0 - analytics.ONLINE_WINDOW_MS - 1 });
  const o = analytics.onlineNow(t0 + 1000);
  assert.equal(o.count, 2);
  assert.deepEqual(o.pages, [{ path: '/shop', visitors: 2 }]);
  assert.equal(o.devices.mobile, 1);
  assert.equal(count('page_views'), 0);
});

test('searches record whether they found anything', () => {
  product({ name: 'Logitech Wireless Mouse' });
  analytics.recordPageView(view({ path: '/shop.html', q: '  Wireless   MOUSE ' }), {}, db);
  analytics.recordPageView(view({ path: '/shop.html', q: 'unicorn saddle' }), {}, db);
  analytics.recordPageView(view({ path: '/shop.html', q: 'unicorn saddle', v: 'visitor-0002' }), {}, db);
  const s = analytics.analyticsSummary({ days: 7 }, {}, db);
  assert.deepEqual(s.topSearches.map((r) => [r.query, r.searches, r.results]), [['unicorn saddle', 2, 0], ['wireless mouse', 1, 1]]);
  assert.deepEqual(s.zeroResultSearches.map((r) => r.query), ['unicorn saddle']);
});

test('funnel: product views -> add to cart -> checkout -> paid orders', () => {
  const p = product();
  const pv = (v, device = 'desktop') => analytics.recordPageView(view({ v, path: '/product.html', product: p.slug }), { device }, db);
  const ev = (v, event, extra = {}) => analytics.recordEvent({ visitorId: v, event, path: '/product', productId: p.id, quantity: 1, ...extra }, {}, db);
  for (const v of ['visitor-000a', 'visitor-000b', 'visitor-000c', 'visitor-000d']) pv(v);
  pv('visitor-000a'); // repeat view, same visitor
  pv('visitor-000e', 'mobile');
  ev('visitor-000a', 'add_to_cart');
  ev('visitor-000a', 'add_to_cart');
  ev('visitor-000b', 'add_to_cart');
  ev('visitor-000a', 'checkout_start', { productId: '', quantity: 2 });
  analytics.recordPageView(view({ v: 'visitor-000f', path: '/', ref: 'facebook.com' }), {}, db);

  const order = orders.createOrder({ customer, shippingOptionId: courierSmall(), items: [{ productId: p.id, quantity: 1 }] });
  orders.markOrderPaid(order.id, { pfPaymentId: 'pf1' });
  orders.createOrder({ customer, shippingOptionId: courierSmall(), items: [{ productId: p.id, quantity: 1 }] }); // unpaid: not counted

  const s = analytics.analyticsSummary({ days: 30 }, {}, db);
  assert.deepEqual(s.funnel.map((f) => [f.key, f.visitors]), [['product_view', 5], ['add_to_cart', 2], ['checkout_start', 1], ['paid', 1]]);
  assert.equal(s.funnel[1].count, 3);
  assert.equal(s.funnel[1].ofPrevious, 40);
  assert.equal(s.funnel[2].ofPrevious, 50);
  assert.equal(s.totals.visitors, 6);
  assert.equal(s.totals.pageViews, 7);
  assert.equal(s.totals.paidOrders, 1);
  assert.equal(s.totals.conversionRate, 16.7);
  assert.equal(s.topProducts[0].slug, p.slug);
  assert.equal(s.topProducts[0].name, 'Test Mouse');
  assert.equal(s.topProducts[0].views, 6);
  assert.equal(s.topProducts[0].addedToCart, 3);
  assert.deepEqual(s.referrers, [{ host: 'facebook.com', views: 1, visitors: 1 }]);
  assert.equal(s.devices.mobile.visitors, 1);
  assert.equal(s.devices.desktop.visitors, 5);
  assert.equal(s.daily.length, 30);
  assert.equal(s.daily.at(-1).pageViews, 7);
  assert.equal(s.daily.at(-1).paidOrders, 1);
});

test('admin aggregates: top pages/categories, date ranges and validation', async () => {
  const day = (iso) => ({ now: new Date(iso) });
  analytics.recordPageView(view({ path: '/shop.html', category: 'keyboards-mice' }), day('2026-09-01T08:00:00Z'), db);
  analytics.recordPageView(view({ path: '/shop.html', category: 'keyboards-mice', v: 'visitor-0002' }), day('2026-09-02T08:00:00Z'), db);
  analytics.recordPageView(view({ path: '/' }), day('2026-09-02T09:00:00Z'), db);
  // 23:30 UTC on 2 Sept is 01:30 on 3 Sept in South Africa.
  analytics.recordPageView(view({ path: '/contact.html' }), day('2026-09-02T23:30:00Z'), db);

  const s = analytics.analyticsSummary({ from: '2026-09-01', to: '2026-09-02' }, {}, db);
  assert.equal(s.totals.pageViews, 3);
  assert.equal(s.totals.visitors, 2);
  assert.deepEqual(s.topPages.map((p) => [p.path, p.views]), [['/shop', 2], ['/', 1]]);
  assert.equal(s.topCategories[0].slug, 'keyboards-mice');
  assert.equal(s.topCategories[0].views, 2);
  assert.ok(s.topCategories[0].name && s.topCategories[0].name !== 'keyboards-mice');
  assert.deepEqual(s.daily.map((d) => [d.day, d.pageViews]), [['2026-09-01', 1], ['2026-09-02', 2]]);
  assert.equal(s.previous.from, '2026-08-30');
  assert.equal(analytics.analyticsSummary({ from: '2026-09-03', to: '2026-09-03' }, {}, db).topPages[0].path, '/contact');

  assert.throws(() => analytics.resolveRange({ from: '2026-09-05', to: '2026-09-01' }), /after the end/);
  assert.throws(() => analytics.resolveRange({ from: '2026-02-30', to: '2026-03-01' }), /YYYY-MM-DD/);
  assert.throws(() => analytics.resolveRange({ from: '2020-01-01', to: '2026-01-01' }), /at most/);
  assert.deepEqual(analytics.resolveRange({ days: '7' }, new Date('2026-09-28T12:00:00Z')), { from: '2026-09-22', to: '2026-09-28', days: 7 });

  await withServer(async ({ base }) => {
    const r = await fetch(`${base}/api/admin/analytics?from=2026-09-01&to=2026-09-02`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).totals.pageViews, 3);
    assert.equal((await fetch(`${base}/api/admin/analytics?from=bad&to=2026-09-02`)).status, 400);
    assert.equal((await fetch(`${base}/api/admin/analytics/online`)).status, 200);
  });
});

test('prune: raw rows older than 12 months go, daily totals stay', () => {
  const old = { now: new Date('2025-08-15T10:00:00Z') };
  analytics.recordPageView(view({ v: 'visitor-000a', path: '/product.html', product: 'x' }), old, db);
  analytics.recordPageView(view({ v: 'visitor-000a', path: '/' }), old, db);
  analytics.recordPageView(view({ v: 'visitor-000b', path: '/' }), old, db);
  analytics.recordEvent({ visitorId: 'visitor-000a', event: 'add_to_cart', productId: 'p1', quantity: 1 }, old, db);
  analytics.recordPageView(view({ v: 'visitor-000c', path: '/' }), { now: new Date('2026-09-01T10:00:00Z') }, db);

  const r = analytics.pruneAnalytics({ now: new Date('2026-09-28T10:00:00Z') }, db);
  assert.deepEqual([r.pageViews, r.events, r.rolledUpDays, r.cutoffDay], [3, 1, 1, '2025-09-28']);
  assert.equal(count('page_views'), 1);
  assert.equal(count('analytics_events'), 0);
  assert.deepEqual(db.prepare('SELECT * FROM analytics_daily').get(), { day: '2025-08-15', page_views: 3, visitors: 2, product_views: 1, add_to_cart: 1, checkout_start: 0 });
  // Idempotent: a second run changes nothing.
  assert.deepEqual(analytics.pruneAnalytics({ now: new Date('2026-09-28T10:00:00Z') }, db).rolledUpDays, 0);
  assert.equal(db.prepare('SELECT page_views FROM analytics_daily').get().page_views, 3);
  // The chart still shows the pruned day from the rollup.
  const s = analytics.analyticsSummary({ from: '2025-08-15', to: '2025-08-15' }, {}, db);
  assert.equal(s.daily[0].pageViews, 3);
  assert.equal(s.totals.visitors, 2);
  assert.equal(s.totals.approximate, true);
});

test('recordEvent ignores events outside the vocabulary', () => {
  assert.equal(analytics.recordEvent({ visitorId: 'visitor-0001', event: 'purchase' }, {}, db), false);
  assert.equal(analytics.recordEvent({}, {}, db), false);
  assert.equal(count('analytics_events'), 0);
});
