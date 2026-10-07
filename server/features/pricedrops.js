// Price drops: products whose shop price came down after a supplier sync
// (Esquire / SMD API), listed on the storefront "Price drops" page and managed
// in Admin -> Advertise -> Price drops (owner 2026-10-07).
//
// Rules the owner approved:
//   - any drop in OUR shop price counts, if it is at least priceDropMinPct % AND
//     priceDropMinRand rand (default 5% and R10); new drops go live automatically;
//   - a drop stays priceDropDays days (default 7) from the latest drop;
//   - it comes off the moment the live price is back at (or above) the price it
//     was -- checked on every page view, not only after a sync;
//   - a sold-out item stays on the page, greyed out, until it expires or the price goes back up.
// Prices are the normal pricing-engine prices (cost x 1.15 VAT, markup, R10
// minimum profit); nothing here changes a price. The server re-prices every
// order from the database, so a drop that has ended can never be charged.
import { getDb } from '../db.js';
import { getSettings, updateSettings } from '../settings.js';
import { clampInt } from '../util.js';
import { floorCents, floorContext } from './discount-common.js';
import { getProduct } from '../catalog.js';

const DAY_MS = 86400_000;
const ENDING = new Set(['back_to_normal', 'too_small', 'expired']); // states that close a drop for good

export function dropSettings(db = getDb()) {
  const s = getSettings(db);
  return {
    on: Boolean(s.priceDropsOn),
    minPct: Math.max(0, Number(s.priceDropMinPct) || 0),
    minRand: Math.max(0, Number(s.priceDropMinRand) || 0),
    days: Math.max(1, Number(s.priceDropDays) || 7),
  };
}

// Big enough to count as a drop: at least minPct % and minRand rand off.
export function qualifies(wasCents, nowCents, cfg) {
  const off = wasCents - nowCents;
  return off > 0 && off >= Math.round(cfg.minRand * 100) && (off / wasCents) * 100 >= cfg.minPct - 1e-9;
}

// What a drop is doing right now, from the product's LIVE row.
// live | sold_out | hidden (owner) | inactive (product hidden/removed)
// | back_to_normal | too_small | expired | (stored reason once closed)
export function dropState(drop, p, cfg, at = Date.now()) {
  if (drop.ended_at) return drop.ended_reason || 'ended';
  if (!p) return 'inactive';
  if (p.price_cents >= drop.was_cents) return 'back_to_normal';
  if (!qualifies(drop.was_cents, p.price_cents, cfg)) return 'too_small';
  if (!drop.pinned && at > Date.parse(drop.updated_at) + cfg.days * DAY_MS) return 'expired';
  if (!p.active) return 'inactive';
  if (drop.hidden) return 'hidden';
  const inStock = p.fulfilment === 'stock' ? p.stock_qty > 0 : Boolean(p.supplier_in_stock);
  return inStock ? 'live' : 'sold_out';
}

const OPEN_SQL = `SELECT d.*, p.price_cents, p.cost_cents, p.active, p.fulfilment, p.stock_qty, p.supplier_in_stock, p.supplier_stock_qty, p.sku, p.name, p.slug, p.images, p.category_id, p.supplier_id, p.min_order_qty
  FROM price_drops d LEFT JOIN products p ON p.id = d.product_id`;
const asProduct = (r) => (r.price_cents == null ? null : r);

// Closes every drop that has run its course (price back up, expired, too small
// now) so the next drop of that product starts fresh. Returns how many.
export function closeEnded(db = getDb(), at = Date.now()) {
  const cfg = dropSettings(db);
  const upd = db.prepare('UPDATE price_drops SET ended_at = ?, ended_reason = ? WHERE id = ?');
  const iso = new Date(at).toISOString();
  let n = 0;
  for (const r of db.prepare(`${OPEN_SQL} WHERE d.ended_at IS NULL`).all()) {
    const state = asProduct(r) ? dropState(r, r, cfg, at) : 'removed';
    if (ENDING.has(state) || state === 'removed') {
      upd.run(iso, state, r.id);
      n++;
    }
  }
  return n;
}

// Called after every supplier sync with diffPrices() output (esquire.js,
// smd-api.js). Always runs -- even with no drops -- so ended drops are closed.
export function recordPriceDrops(changes, db = getDb(), at = Date.now()) {
  const out = { closed: closeEnded(db, at), added: 0, updated: 0 };
  const cfg = dropSettings(db);
  const iso = new Date(at).toISOString();
  const open = db.prepare('SELECT id FROM price_drops WHERE product_id = ? AND ended_at IS NULL');
  const ins = db.prepare('INSERT INTO price_drops (product_id, was_cents, now_cents, cost_was_cents, cost_now_cents, detected_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const upd = db.prepare('UPDATE price_drops SET now_cents = ?, cost_now_cents = ?, updated_at = ? WHERE id = ?');
  const tx = db.transaction(() => {
    for (const x of changes?.priceDown || []) {
      const row = open.get(x.id);
      if (row) {
        // Dropped again: "was" stays the original price, the keep-days window restarts.
        upd.run(x.toCents, x.costToCents ?? 0, iso, row.id);
        out.updated++;
      } else if (qualifies(x.fromCents, x.toCents, cfg)) {
        ins.run(x.id, x.fromCents, x.toCents, x.costFromCents ?? 0, x.costToCents ?? 0, iso, iso);
        out.added++;
      }
    }
  });
  tx();
  return out;
}

// Product ids (of `ids`) that are on the page right now -- the cart uses this
// to show the price-drop notice at checkout.
export function liveDropIds(ids, db = getDb()) {
  const cfg = dropSettings(db);
  const out = new Set();
  if (!cfg.on || !ids.length) return out;
  const q = db.prepare(`${OPEN_SQL} WHERE d.ended_at IS NULL AND d.product_id = ?`);
  for (const id of ids) {
    for (const r of q.all(id)) if (asProduct(r) && dropState(r, r, cfg) === 'live') out.add(id);
  }
  return out;
}

// ------------------------------------------------------------------ storefront

// Page of drops (live first, biggest % first; sold-out ones last, greyed by the
// page). `since` = '24h' narrows to drops from the last day.
export function publicDrops({ page = 1, pageSize = 30, category = '', since = '' } = {}, db = getDb()) {
  const cfg = dropSettings(db);
  const empty = { items: [], total: 0, page: 1, pages: 1, pageSize: 30, categories: [], allTotal: 0, days: cfg.days, on: cfg.on };
  if (!cfg.on) return empty;
  const at = Date.now();
  const cats = new Map(db.prepare('SELECT id, parent_id, name, slug, sort_order FROM categories WHERE active = 1').all().map((c) => [c.id, c]));
  const topOf = (id) => {
    const seen = new Set();
    let c = cats.get(id);
    while (c && c.parent_id && cats.has(c.parent_id) && !seen.has(c.id)) {
      seen.add(c.id);
      c = cats.get(c.parent_id);
    }
    return c || null;
  };
  let rows = db.prepare(`${OPEN_SQL} WHERE d.ended_at IS NULL`).all()
    .filter((r) => asProduct(r))
    .map((r) => ({ r, state: dropState(r, r, cfg, at) }))
    .filter((x) => x.state === 'live' || x.state === 'sold_out');
  if (since === '24h') rows = rows.filter((x) => at - Date.parse(x.r.updated_at) <= DAY_MS);

  const counts = new Map();
  for (const { r } of rows) {
    const top = topOf(r.category_id);
    if (top) counts.set(top.id, (counts.get(top.id) || 0) + 1);
  }
  const categories = [...counts.entries()]
    .map(([id, count]) => ({ slug: cats.get(id).slug, name: cats.get(id).name, count, sort: cats.get(id).sort_order }))
    .sort((a, b) => b.count - a.count || a.sort - b.sort)
    .map(({ sort, ...c }) => c);
  const allTotal = rows.length;

  const chosen = category ? [...cats.values()].find((c) => c.slug === String(category)) : null;
  if (chosen) {
    const keep = new Set([chosen.id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const c of cats.values()) if (c.parent_id && keep.has(c.parent_id) && !keep.has(c.id)) keep.add(c.id), (grew = true);
    }
    rows = rows.filter((x) => keep.has(x.r.category_id));
  }
  const pct = (r) => (r.was_cents - r.price_cents) / r.was_cents;
  rows.sort((a, b) => (a.state === 'sold_out') - (b.state === 'sold_out') || pct(b.r) - pct(a.r) || a.r.name.localeCompare(b.r.name));

  const size = clampInt(pageSize, 1, 96, 30);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const pg = clampInt(page, 1, pages, 1);
  const items = rows.slice((pg - 1) * size, pg * size)
    .map(({ r, state }) => {
      const p = getProduct(r.product_id, { admin: false }, db);
      if (!p) return null;
      const was = r.was_cents;
      return {
        ...p,
        drop: {
          wasCents: was,
          nowCents: p.priceCents,
          changeCents: was - p.priceCents,
          changePct: Math.round(((was - p.priceCents) / was) * 100),
          detectedAt: r.detected_at,
          updatedAt: r.updated_at,
          soldOut: state === 'sold_out',
        },
      };
    })
    .filter(Boolean);
  return { items, total: rows.length, page: pg, pages, pageSize: size, categories, allTotal, days: cfg.days, on: cfg.on };
}

// ------------------------------------------------------------------ admin

// Every open drop plus the ones that ended in the last 30 days (history), with
// the supplier's prices next to ours. All money is integer cents.
export function adminDrops(db = getDb(), at = Date.now()) {
  const cfg = dropSettings(db);
  const ctx = floorContext(db);
  const vat = ctx.vatRatePct;
  const fee = (price) => Math.round(((price * ctx.fee.pct) / 100 + ctx.fee.fixedCents) * ctx.fee.vatFactor);
  const cats = new Map(db.prepare('SELECT id, name FROM categories').all().map((c) => [c.id, c.name]));
  const sup = new Map(db.prepare('SELECT id, name FROM suppliers').all().map((s) => [s.id, s.name]));
  const since = new Date(at - 30 * DAY_MS).toISOString();
  const rows = db.prepare(`${OPEN_SQL} WHERE d.ended_at IS NULL OR d.ended_at >= ? ORDER BY d.updated_at DESC, d.id DESC`).all(since);
  const items = rows.map((r) => {
    const live = asProduct(r);
    const state = live ? dropState(r, r, cfg, at) : r.ended_reason || 'removed';
    const nowCents = live ? r.price_cents : r.now_cents;
    const costNow = live ? r.cost_cents : r.cost_now_cents;
    const costNowInc = Math.round((costNow * (100 + vat)) / 100);
    const f = fee(nowCents);
    const profit = nowCents - costNowInc - f;
    const stock = !live ? null : r.fulfilment === 'stock' ? r.stock_qty : r.supplier_in_stock ? r.supplier_stock_qty : 0;
    let images = [];
    try { images = JSON.parse(r.images || '[]'); } catch { /* none */ }
    return {
      id: r.id,
      productId: r.product_id,
      sku: r.sku || '',
      name: r.name || '(removed product)',
      slug: r.slug || '',
      image: images[0] || '',
      category: cats.get(r.category_id) || '',
      supplier: sup.get(r.supplier_id) || '',
      state,
      hidden: Boolean(r.hidden),
      pinned: Boolean(r.pinned),
      detectedAt: r.detected_at,
      updatedAt: r.updated_at,
      expiresAt: r.pinned ? null : new Date(Date.parse(r.updated_at) + cfg.days * DAY_MS).toISOString(),
      endedAt: r.ended_at,
      // supplier
      costWasCents: r.cost_was_cents,
      costNowCents: costNow,
      costNowIncVatCents: costNowInc,
      costChangeCents: costNow - r.cost_was_cents,
      costChangePct: r.cost_was_cents ? Math.round(((costNow - r.cost_was_cents) / r.cost_was_cents) * 100) : 0,
      // mine
      wasCents: r.was_cents,
      nowCents,
      changeCents: nowCents - r.was_cents,
      changePct: Math.round(((nowCents - r.was_cents) / r.was_cents) * 100),
      feeCents: f,
      profitCents: profit,
      profitPct: nowCents ? Math.round((profit / nowCents) * 1000) / 10 : 0,
      floorCents: floorCents(costNow, ctx),
      stock,
    };
  });
  return { settings: cfg, items };
}

export function saveDropSettings(body, db = getDb()) {
  const b = body || {};
  const patch = {};
  if ('on' in b) patch.priceDropsOn = Boolean(b.on);
  if ('minPct' in b) patch.priceDropMinPct = Math.min(100, Math.max(0, Number(b.minPct)));
  if ('minRand' in b) patch.priceDropMinRand = Math.max(0, Number(b.minRand));
  if ('days' in b) patch.priceDropDays = Math.min(90, Math.max(1, Math.round(Number(b.days))));
  for (const [k, v] of Object.entries(patch)) if (typeof v === 'number' && !Number.isFinite(v)) throw Object.assign(new Error(`Not a valid number for ${k}`), { status: 400 });
  updateSettings(patch, db);
  return dropSettings(db);
}

// flags: { hidden?, pinned? } for one or many drops (ids).
export function setDropFlags(ids, flags, db = getDb()) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isInteger);
  const sets = [];
  if ('hidden' in flags) sets.push(['hidden', flags.hidden ? 1 : 0]);
  if ('pinned' in flags) sets.push(['pinned', flags.pinned ? 1 : 0]);
  if (!sets.length || !list.length) return 0;
  const sql = `UPDATE price_drops SET ${sets.map(([c]) => `${c} = ?`).join(', ')} WHERE id = ? AND ended_at IS NULL`;
  let n = 0;
  const tx = db.transaction(() => {
    for (const id of list) n += db.prepare(sql).run(...sets.map(([, v]) => v), id).changes;
  });
  tx();
  return n;
}

export function register({ app, admin, wrap }) {
  app.get('/api/price-drops', wrap((req) => publicDrops({ page: req.query.page, pageSize: req.query.pageSize, category: String(req.query.category || ''), since: String(req.query.since || '') })));

  admin.get('/price-drops', wrap(() => adminDrops()));
  admin.put('/price-drops/settings', wrap((req) => saveDropSettings(req.body)));
  admin.patch('/price-drops/:id', wrap((req) => {
    const n = setDropFlags(req.params.id, { ...('hidden' in (req.body || {}) ? { hidden: req.body.hidden } : {}), ...('pinned' in (req.body || {}) ? { pinned: req.body.pinned } : {}) });
    if (!n) throw Object.assign(new Error('Price drop not found (it may have ended)'), { status: 404 });
    return { ok: true };
  }));
  admin.post('/price-drops/bulk', wrap((req) => {
    const action = String(req.body?.action || '');
    const flags = { hide: { hidden: true }, show: { hidden: false }, pin: { pinned: true }, unpin: { pinned: false } }[action];
    if (!flags) throw Object.assign(new Error('Unknown action'), { status: 400 });
    return { updated: setDropFlags(req.body?.ids || [], flags) };
  }));
}
