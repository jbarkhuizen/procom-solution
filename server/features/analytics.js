// Analytics feature (Phase 2): first-party visitor analytics, ported from
// Lapanza3d and adapted to Procom.
//
// Privacy (owner decision 2026-09-28): no third parties, no cookies, no
// consent banner. The browser beacon (src/js/analytics-beacon.js) sends an
// anonymous random visitor id kept in localStorage, the page path, the
// referring site's host name, the product/category/search on the page and
// nothing else. The server never stores IP addresses, user agent strings or
// customer ids: the user agent is only read to drop bots and to label the
// row mobile/tablet/desktop, and the customer session cookie only to set a
// yes/no "logged in" flag. Browsers that send Do Not Track or Global Privacy
// Control send nothing at all (checked in the beacon). Staff browsing with
// an admin session is ignored so the owner's own clicks don't count.
//
// Raw rows (page_views, analytics_events) are kept 12 months; a daily prune
// (register() below) first copies each old day's totals into analytics_daily
// so the daily chart keeps working for older ranges.
//
// "Online now" is an in-memory map fed by page views and a ~45 s heartbeat;
// it is never written to the database.
import { getDb } from '../db.js';
import { SESSION_COOKIE, getSession } from '../auth.js';
import { getClientFromRequest } from './accounts.js';
import { queryProducts } from '../catalog.js';

export const RETENTION_MONTHS = 12;
export const ONLINE_WINDOW_MS = 5 * 60 * 1000; // no beacon for 5 min = gone
export const EVENT_TYPES = ['add_to_cart', 'checkout_start'];
export const MAX_BODY_BYTES = 2048;
const MAX_ONLINE = 20_000; // hard cap on the in-memory map
const MAX_RANGE_DAYS = 731;
const DAY_MS = 24 * 60 * 60 * 1000;
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000; // South Africa: UTC+2 all year

// ------------------------------------------------------------------ helpers

// The South African calendar day for a moment in time (YYYY-MM-DD).
export const sastDay = (date = new Date()) => new Date(new Date(date).getTime() + SAST_OFFSET_MS).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && addDays(v, 0) === v;

const BOT_UA = /bot\b|bot\/|crawl|spider|slurp|scrap|headless|phantom|puppeteer|playwright|selenium|lighthouse|pagespeed|gtmetrix|pingdom|uptime|monitor|preview|facebookexternalhit|embedly|quora link|whatsapp|curl|wget|python|httpclient|http-client|okhttp|node-fetch|undici|axios|go-http|java\/|libwww|perl|ruby|php\/|feedfetcher|mediapartners|adsbot|bingpreview|semrush|ahrefs|mj12|dotbot|petalbot|bytespider|gptbot|claudebot|ccbot|chatgpt|anthropic|perplexity/i;

// True for crawlers, link previewers, monitors, scripts and headless browsers.
// An empty user agent is treated as a bot: every real browser sends one.
export function isBot(ua) {
  const s = String(ua || '').trim();
  // "CUBOT" is a phone brand, not a crawler.
  return !s || s.length > 1000 || BOT_UA.test(s.replace(/cubot/gi, ''));
}

export function deviceFromUa(ua) {
  const s = String(ua || '');
  if (/ipad|tablet|playbook|silk|kindle|(android(?!.*mobile))/i.test(s)) return 'tablet';
  if (/mobi|iphone|ipod|android|blackberry|opera mini|iemobile|windows phone/i.test(s)) return 'mobile';
  return 'desktop';
}

class Invalid extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}
const invalid = (msg) => {
  throw new Invalid(msg);
};

const VISITOR_RE = /^[A-Za-z0-9-]{8,64}$/;
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

function cleanVisitor(v) {
  if (typeof v !== 'string' || !VISITOR_RE.test(v)) invalid('Invalid visitor id');
  return v;
}

// '/shop.html?x' -> '/shop', '/index.html' -> '/'. Only plain site paths.
export function cleanPath(v) {
  if (typeof v !== 'string' || !v.startsWith('/') || v.startsWith('//') || v.length > 200) invalid('Invalid path');
  let p = v.split(/[?#]/)[0];
  if (!/^[A-Za-z0-9/_.~%-]*$/.test(p)) invalid('Invalid path');
  p = p.replace(/\.html$/, '').replace(/\/index$/, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p || '/';
}

const optSlug = (v) => {
  if (v == null || v === '') return '';
  if (typeof v !== 'string' || !SLUG_RE.test(v)) invalid('Invalid slug');
  return v.toLowerCase();
};

// Lower-case, collapsed, 100 chars max; control characters removed.
export function cleanSearch(v) {
  if (v == null) return '';
  if (typeof v !== 'string') invalid('Invalid search');
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 100);
}

// Referrer host only (never the full URL); '' for none, a bad value, or the
// site itself. 'www.' is dropped so google.com and www.google.com group.
export function cleanReferrer(v, ownHosts = []) {
  if (typeof v !== 'string' || !v) return '';
  const host = v.trim().toLowerCase().replace(/^www\./, '');
  if (host.length > 120 || !HOST_RE.test(host)) return '';
  const own = ownHosts.map((x) => String(x || '').toLowerCase().replace(/^www\./, '').replace(/:\d+$/, ''));
  if (own.includes(host.replace(/:\d+$/, ''))) return '';
  return host;
}

const isObject = (b) => b && typeof b === 'object' && !Array.isArray(b);

// Validates a page-view beacon body. Throws (status 400) when invalid.
export function parseView(body, { ownHosts = [] } = {}) {
  if (!isObject(body)) invalid('Invalid body');
  const path = cleanPath(body.path);
  return {
    visitorId: cleanVisitor(body.v),
    path,
    referrerHost: cleanReferrer(body.ref, ownHosts),
    productSlug: path === '/product' ? optSlug(body.product) : '',
    categorySlug: optSlug(body.category),
    // Only shop searches: other pages have no ?q=.
    searchQuery: path === '/shop' ? cleanSearch(body.q) : '',
  };
}

export function parseEvent(body) {
  if (!isObject(body)) invalid('Invalid body');
  if (!EVENT_TYPES.includes(body.event)) invalid('Unknown event');
  const data = isObject(body.data) ? body.data : {};
  const productId = data.productId == null || data.productId === '' ? '' : String(data.productId);
  if (productId && !/^[A-Za-z0-9_-]{1,64}$/.test(productId)) invalid('Invalid product');
  const qty = Number(body.event === 'checkout_start' ? data.items ?? 0 : data.quantity ?? 1);
  if (!Number.isInteger(qty) || qty < 0 || qty > 10000) invalid('Invalid quantity');
  return { visitorId: cleanVisitor(body.v), event: body.event, path: body.path == null ? '' : cleanPath(body.path), productId, quantity: qty };
}

// ------------------------------------------------------------- online now

const online = new Map(); // visitorId -> { path, device, lastSeen }

export function touchVisitor(visitorId, { path = '', device = 'desktop', now = Date.now() } = {}) {
  if (!visitorId) return;
  if (!online.has(visitorId) && online.size >= MAX_ONLINE) pruneOnline(now);
  if (!online.has(visitorId) && online.size >= MAX_ONLINE) return;
  online.set(visitorId, { path, device, lastSeen: now });
}

export function pruneOnline(now = Date.now()) {
  const cutoff = now - ONLINE_WINDOW_MS;
  for (const [id, v] of online) if (v.lastSeen < cutoff) online.delete(id);
}

export function onlineNow(now = Date.now()) {
  pruneOnline(now);
  const pages = new Map();
  const devices = { mobile: 0, tablet: 0, desktop: 0 };
  for (const v of online.values()) {
    pages.set(v.path, (pages.get(v.path) || 0) + 1);
    devices[v.device] = (devices[v.device] || 0) + 1;
  }
  return {
    count: online.size,
    devices,
    pages: [...pages].map(([path, visitors]) => ({ path, visitors })).sort((a, b) => b.visitors - a.visitors || a.path.localeCompare(b.path)).slice(0, 10),
  };
}

export function _resetOnline() {
  online.clear();
}

// ------------------------------------------------------------- recording

// Number of live products a shop search finds (the same search the shop
// runs), or null if it can't be worked out.
function searchResultCount(q, db) {
  try {
    return queryProducts({ q, page: 1, pageSize: 1 }, db).total;
  } catch {
    return null;
  }
}

export function recordPageView(view, { device = 'desktop', loggedIn = false, now = new Date() } = {}, db = getDb()) {
  const ts = new Date(now);
  const searchResults = view.searchQuery ? searchResultCount(view.searchQuery, db) : null;
  db.prepare(
    `INSERT INTO page_views (visitor_id, path, referrer_host, product_slug, category_slug, search_query, search_results, device, logged_in, day, created_at)
     VALUES (@visitorId, @path, @referrerHost, @productSlug, @categorySlug, @searchQuery, @searchResults, @device, @loggedIn, @day, @createdAt)`,
  ).run({ ...view, searchResults, device, loggedIn: loggedIn ? 1 : 0, day: sastDay(ts), createdAt: ts.toISOString() });
  touchVisitor(view.visitorId, { path: view.path, device, now: ts.getTime() });
}

// Funnel events. Returns false for an event outside the fixed vocabulary.
export function recordEvent(ev = {}, { device = 'desktop', now = new Date() } = {}, db = getDb()) {
  if (!EVENT_TYPES.includes(ev.event) || !ev.visitorId) return false;
  const ts = new Date(now);
  db.prepare(
    `INSERT INTO analytics_events (visitor_id, event, path, product_id, quantity, device, day, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(String(ev.visitorId).slice(0, 64), ev.event, String(ev.path || '').slice(0, 200), String(ev.productId || '').slice(0, 64), Number(ev.quantity) || 0, device, sastDay(ts), ts.toISOString());
  touchVisitor(ev.visitorId, { path: ev.path || '', device, now: ts.getTime() });
  return true;
}

// ------------------------------------------------------------- retention

// Copies whole days older than the retention window into analytics_daily,
// then deletes their raw rows. Idempotent; safe to run any time.
export function pruneAnalytics({ monthsToKeep = RETENTION_MONTHS, now = new Date() } = {}, db = getDb()) {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - monthsToKeep);
  const cutoffDay = sastDay(cutoff); // rows with day < cutoffDay go
  const run = db.transaction(() => {
    const days = db
      .prepare(
        `SELECT day, COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS visitors, SUM(product_slug != '') AS productViews
         FROM page_views WHERE day < ? GROUP BY day`,
      )
      .all(cutoffDay);
    const ev = new Map(
      db
        .prepare(`SELECT day, SUM(event = 'add_to_cart') AS atc, SUM(event = 'checkout_start') AS cs FROM analytics_events WHERE day < ? GROUP BY day`)
        .all(cutoffDay)
        .map((r) => [r.day, r]),
    );
    const allDays = new Set([...days.map((d) => d.day), ...ev.keys()]);
    const byDay = new Map(days.map((d) => [d.day, d]));
    const upsert = db.prepare(
      `INSERT INTO analytics_daily (day, page_views, visitors, product_views, add_to_cart, checkout_start) VALUES (@day, @views, @visitors, @productViews, @atc, @cs)
       ON CONFLICT(day) DO UPDATE SET page_views = page_views + excluded.page_views, visitors = visitors + excluded.visitors,
         product_views = product_views + excluded.product_views, add_to_cart = add_to_cart + excluded.add_to_cart, checkout_start = checkout_start + excluded.checkout_start`,
    );
    for (const day of allDays) {
      const d = byDay.get(day) || {};
      const e = ev.get(day) || {};
      upsert.run({ day, views: d.views || 0, visitors: d.visitors || 0, productViews: d.productViews || 0, atc: e.atc || 0, cs: e.cs || 0 });
    }
    const pageViews = db.prepare('DELETE FROM page_views WHERE day < ?').run(cutoffDay).changes;
    const events = db.prepare('DELETE FROM analytics_events WHERE day < ?').run(cutoffDay).changes;
    return { pageViews, events, rolledUpDays: allDays.size, cutoffDay };
  });
  return run();
}

// ------------------------------------------------------------- reporting

// Resolves the admin's range: from/to (YYYY-MM-DD, SAST days, inclusive) or
// `days` back from today. Defaults to the last 30 days.
export function resolveRange({ from, to, days } = {}, now = new Date()) {
  const today = sastDay(now);
  if (from || to) {
    if (!isDay(from) || !isDay(to)) invalid('Dates must be YYYY-MM-DD');
    if (from > to) invalid('The start date is after the end date');
    const span = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
    if (span > MAX_RANGE_DAYS) invalid(`Pick a range of at most ${MAX_RANGE_DAYS} days`);
    return { from, to, days: span };
  }
  const n = Math.min(Math.max(Number.parseInt(days, 10) || 30, 1), MAX_RANGE_DAYS);
  return { from: addDays(today, -(n - 1)), to: today, days: n };
}

const PAID_DAY = "date(paid_at, '+2 hours')";

function periodTotals(from, to, db) {
  const raw = db
    .prepare(
      `SELECT COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS visitors, COUNT(DISTINCT day) AS rawDays
       FROM page_views WHERE day BETWEEN ? AND ?`,
    )
    .get(from, to);
  const rolled = db
    .prepare(
      `SELECT COALESCE(SUM(page_views), 0) AS views, COALESCE(SUM(visitors), 0) AS visitors, COUNT(*) AS days
       FROM analytics_daily WHERE day BETWEEN ? AND ? AND day NOT IN (SELECT DISTINCT day FROM page_views WHERE day BETWEEN ? AND ?)`,
    )
    .get(from, to, from, to);
  const paid = db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total_cents), 0) AS cents FROM orders WHERE payment_status = 'paid' AND paid_at IS NOT NULL AND ${PAID_DAY} BETWEEN ? AND ?`)
    .get(from, to);
  return {
    pageViews: raw.views + rolled.views,
    visitors: raw.visitors + rolled.visitors,
    paidOrders: paid.n,
    revenueCents: paid.cents,
    approximate: rolled.days > 0, // visitors summed per day for pruned days
  };
}

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

export function analyticsSummary(query = {}, { now = new Date() } = {}, db = getDb()) {
  const { from, to, days } = resolveRange(query, now);
  const range = [from, to];
  const totals = periodTotals(from, to, db);
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(from, -days);
  const previous = periodTotals(prevFrom, prevTo, db);

  // Daily series, every day present (zeros where quiet).
  const rawDaily = new Map(
    db
      .prepare('SELECT day, COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS visitors FROM page_views WHERE day BETWEEN ? AND ? GROUP BY day')
      .all(...range)
      .map((r) => [r.day, r]),
  );
  const rolledDaily = new Map(db.prepare('SELECT day, page_views AS views, visitors FROM analytics_daily WHERE day BETWEEN ? AND ?').all(...range).map((r) => [r.day, r]));
  const paidDaily = new Map(
    db
      .prepare(`SELECT ${PAID_DAY} AS day, COUNT(*) AS n FROM orders WHERE payment_status = 'paid' AND paid_at IS NOT NULL AND ${PAID_DAY} BETWEEN ? AND ? GROUP BY day`)
      .all(...range)
      .map((r) => [r.day, r.n]),
  );
  const daily = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const r = rawDaily.get(d) || rolledDaily.get(d);
    daily.push({ day: d, pageViews: r?.views || 0, visitors: r?.visitors || 0, paidOrders: paidDaily.get(d) || 0 });
  }

  const topPages = db
    .prepare('SELECT path, COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS visitors FROM page_views WHERE day BETWEEN ? AND ? GROUP BY path ORDER BY views DESC, path LIMIT 10')
    .all(...range);

  const cartByProduct = new Map(
    db
      .prepare("SELECT product_id AS id, COUNT(*) AS n FROM analytics_events WHERE event = 'add_to_cart' AND product_id != '' AND day BETWEEN ? AND ? GROUP BY product_id")
      .all(...range)
      .map((r) => [r.id, r.n]),
  );
  const topProducts = db
    .prepare(
      `SELECT v.product_slug AS slug, COUNT(*) AS views, COUNT(DISTINCT v.visitor_id) AS visitors, p.id, p.name
       FROM page_views v LEFT JOIN products p ON p.slug = v.product_slug
       WHERE v.product_slug != '' AND v.day BETWEEN ? AND ?
       GROUP BY v.product_slug ORDER BY views DESC, slug LIMIT 10`,
    )
    .all(...range)
    .map((r) => ({ slug: r.slug, name: r.name || r.slug, exists: Boolean(r.id), views: r.views, visitors: r.visitors, addedToCart: (r.id && cartByProduct.get(r.id)) || 0 }));

  const topCategories = db
    .prepare(
      `SELECT v.category_slug AS slug, COUNT(*) AS views, COUNT(DISTINCT v.visitor_id) AS visitors, c.name
       FROM page_views v LEFT JOIN categories c ON c.slug = v.category_slug
       WHERE v.category_slug != '' AND v.day BETWEEN ? AND ?
       GROUP BY v.category_slug ORDER BY views DESC, slug LIMIT 10`,
    )
    .all(...range)
    .map((r) => ({ slug: r.slug, name: r.name || r.slug, views: r.views, visitors: r.visitors }));

  // Searches, with the result count of the most recent time each was run.
  const searchSql = (having) => `
    SELECT s.search_query AS query, COUNT(*) AS searches, COUNT(DISTINCT s.visitor_id) AS visitors,
      (SELECT x.search_results FROM page_views x WHERE x.search_query = s.search_query AND x.day BETWEEN @from AND @to ORDER BY x.id DESC LIMIT 1) AS results
    FROM page_views s WHERE s.search_query != '' AND s.day BETWEEN @from AND @to
    GROUP BY s.search_query ${having} ORDER BY searches DESC, query LIMIT 10`;
  const topSearches = db.prepare(searchSql('')).all({ from, to });
  const zeroResultSearches = db.prepare(searchSql('HAVING results = 0')).all({ from, to });

  const referrers = db
    .prepare("SELECT referrer_host AS host, COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS visitors FROM page_views WHERE referrer_host != '' AND day BETWEEN ? AND ? GROUP BY referrer_host ORDER BY views DESC, host LIMIT 10")
    .all(...range);
  const direct = db.prepare("SELECT COUNT(DISTINCT visitor_id) AS n FROM page_views WHERE referrer_host = '' AND day BETWEEN ? AND ?").get(...range).n;

  // Funnel: distinct visitors reaching each step; paid orders from the orders table.
  const productViewers = db.prepare("SELECT COUNT(DISTINCT visitor_id) AS n, COUNT(*) AS views FROM page_views WHERE product_slug != '' AND day BETWEEN ? AND ?").get(...range);
  const ev = Object.fromEntries(
    db
      .prepare('SELECT event, COUNT(*) AS n, COUNT(DISTINCT visitor_id) AS visitors FROM analytics_events WHERE day BETWEEN ? AND ? GROUP BY event')
      .all(...range)
      .map((r) => [r.event, r]),
  );
  const steps = [
    { key: 'product_view', label: 'Viewed a product', visitors: productViewers.n, count: productViewers.views },
    { key: 'add_to_cart', label: 'Added to cart', visitors: ev.add_to_cart?.visitors || 0, count: ev.add_to_cart?.n || 0 },
    { key: 'checkout_start', label: 'Started checkout', visitors: ev.checkout_start?.visitors || 0, count: ev.checkout_start?.n || 0 },
    { key: 'paid', label: 'Paid orders', visitors: totals.paidOrders, count: totals.paidOrders },
  ].map((s, i, arr) => ({ ...s, ofPrevious: i === 0 ? null : pct(s.visitors, arr[i - 1].visitors), ofFirst: pct(s.visitors, arr[0].visitors) }));

  const devices = Object.fromEntries(['mobile', 'tablet', 'desktop'].map((d) => [d, { visitors: 0, pageViews: 0 }]));
  for (const r of db.prepare('SELECT device, COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS visitors FROM page_views WHERE day BETWEEN ? AND ? GROUP BY device').all(...range)) {
    if (devices[r.device]) devices[r.device] = { visitors: r.visitors, pageViews: r.views };
  }
  const loggedIn = db.prepare('SELECT COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS visitors FROM page_views WHERE logged_in = 1 AND day BETWEEN ? AND ?').get(...range);

  return {
    from,
    to,
    days,
    totals: { ...totals, conversionRate: pct(totals.paidOrders, totals.visitors), pagesPerVisitor: totals.visitors ? Math.round((totals.pageViews / totals.visitors) * 10) / 10 : 0 },
    previous: { from: prevFrom, to: prevTo, ...previous, conversionRate: pct(previous.paidOrders, previous.visitors) },
    online: onlineNow(now.getTime()),
    daily,
    topPages,
    topProducts,
    topCategories,
    topSearches,
    zeroResultSearches,
    referrers,
    directVisitors: direct,
    funnel: steps,
    devices,
    loggedIn,
    retentionMonths: RETENTION_MONTHS,
  };
}

// ------------------------------------------------------------- routes

const ignore = (res) => res.status(204).end();

function isAdminBrowsing(req) {
  try {
    return Boolean(getSession(req.cookies?.[SESSION_COOKIE]));
  } catch {
    return false;
  }
}

function isLoggedInCustomer(req) {
  try {
    return Boolean(getClientFromRequest(req));
  } catch {
    return false;
  }
}

let pruneTimer = null;

export function register({ app, admin, wrap, rateLimit, siteUrl = '', limit = 120, pruneJob = true }) {
  const limiter = rateLimit({ windowMs: 60_000, limit, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many requests' } });
  let siteHost = '';
  try {
    siteHost = siteUrl ? new URL(siteUrl).host : '';
  } catch { /* ignore */ }

  // Shared gate for the three beacon routes: size, bots, staff.
  const beacon = (handler) => (req, res) => {
    if (Number(req.get('content-length') || 0) > MAX_BODY_BYTES) return res.status(413).json({ error: 'Too large' });
    const ua = req.get('user-agent');
    if (isBot(ua) || isAdminBrowsing(req)) return ignore(res);
    try {
      handler(req, deviceFromUa(ua));
      ignore(res);
    } catch (err) {
      if (err instanceof Invalid) return res.status(400).json({ error: err.message });
      console.error('Analytics beacon failed:', err);
      ignore(res); // never the visitor's problem
    }
  };

  app.post('/api/analytics/view', limiter, beacon((req, device) => {
    const view = parseView(req.body, { ownHosts: [req.get('host'), siteHost] });
    recordPageView(view, { device, loggedIn: isLoggedInCustomer(req) });
  }));
  app.post('/api/analytics/ping', limiter, beacon((req, device) => {
    if (!isObject(req.body)) invalid('Invalid body');
    touchVisitor(cleanVisitor(req.body.v), { path: cleanPath(req.body.path), device });
  }));
  app.post('/api/analytics/event', limiter, beacon((req, device) => {
    recordEvent(parseEvent(req.body), { device });
  }));

  admin.get('/analytics', wrap((req) => analyticsSummary(req.query || {})));
  admin.get('/analytics/online', wrap(() => onlineNow()));

  // Daily prune, first run a minute after start. unref'd: never keeps the
  // process (or a test run) alive.
  if (pruneJob && !pruneTimer) {
    const run = () => {
      try {
        const r = pruneAnalytics();
        if (r.pageViews || r.events) console.log(`Analytics prune: removed ${r.pageViews} page view(s) and ${r.events} event(s) before ${r.cutoffDay}`);
      } catch (err) {
        console.error('Analytics prune failed:', err);
      }
    };
    setTimeout(run, 60_000).unref?.();
    pruneTimer = setInterval(run, DAY_MS);
    pruneTimer.unref?.();
  }
}
