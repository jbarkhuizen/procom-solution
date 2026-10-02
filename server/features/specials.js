// Specials (sale prices, never below cost incl VAT) + admin Specials.
//
// A special targets a product, a category (and its sub-categories) or a brand,
// and is a percentage off or a fixed special price (products only). When
// several run for one product the lowest price wins, then the margin guard
// lifts it to the cost floor (cost × 1.15, see discount-common.js).
//
// specialPriceCents() runs for every product the storefront renders, so the
// running specials live in an in-memory index per database: rebuilt at most
// once a minute (so start/end dates take effect within a minute) and dropped
// whenever a special is saved or deleted.
import { randomUUID } from 'crypto';
import { getDb } from '../db.js';
import { parseRandToCents, clampInt } from '../util.js';
import { floorCents, floorContext, todaySast, normDate, windowState, descendantMap, brandKey, productsForTarget, brandList } from './discount-common.js';

export const TARGET_TYPES = ['product', 'category', 'brand'];
export const KINDS = ['percent', 'price'];
const CACHE_TTL_MS = 60_000;
const now = () => new Date().toISOString();

// ------------------------------------------------------------------ price engine

const caches = new WeakMap(); // db connection -> index of running specials

function loadIndex(db) {
  const t = Date.now();
  const hit = caches.get(db);
  if (hit && t - hit.builtAt < CACHE_TTL_MS) return hit;
  const today = todaySast(t);
  const rows = db.prepare('SELECT * FROM specials WHERE active = 1').all().filter((r) => windowState(r, today) === 'running');
  const idx = { builtAt: t, vat: floorContext(db), count: rows.length, byProduct: new Map(), byCategory: new Map(), byBrand: new Map() };
  const add = (map, key, s) => (map.has(key) ? map.get(key).push(s) : map.set(key, [s]));
  if (rows.length) {
    const desc = descendantMap(db);
    for (const s of rows) {
      if (s.target_type === 'product') add(idx.byProduct, s.target_id, s);
      else if (s.target_type === 'category') for (const id of desc(s.target_id)) add(idx.byCategory, id, s);
      else if (s.target_type === 'brand') add(idx.byBrand, brandKey(s.target_id), s);
    }
  }
  caches.set(db, idx);
  return idx;
}

export function invalidateSpecials(db = getDb()) {
  caches.delete(db);
}

// What one special would make a product's price, before the cost floor.
// Percentages round up to the whole rand, like every other shop price.
export function rawSpecialCents(s, row) {
  if (s.kind === 'price') return s.price_cents;
  const cut = (row.price_cents * (100 - s.percent_off)) / 100;
  return Math.ceil(cut / 100 - 1e-9) * 100;
}

function evaluate(row, list, vat) {
  let best = null;
  for (const s of list) {
    const raw = rawSpecialCents(s, row);
    if (!best || raw < best.rawCents) best = { special: s, rawCents: raw };
  }
  if (!best) return null;
  const floor = floorCents(row.cost_cents, vat);
  const specialCents = Math.max(best.rawCents, floor);
  return {
    specialId: best.special.id,
    label: best.special.label,
    rawCents: best.rawCents,
    floorCents: floor,
    specialCents,
    capped: best.rawCents < floor,
    // Only a real reduction counts: the floor (or a fixed price) can land at or above the normal price.
    applies: specialCents < row.price_cents,
  };
}

// Full detail of the winning running special for a product row, or null.
export function specialDetails(row, db = getDb()) {
  if (!row) return null;
  const idx = loadIndex(db);
  if (!idx.count) return null;
  const list = [
    ...(idx.byProduct.get(row.id) || []),
    ...(idx.byCategory.get(row.category_id) || []),
    ...(row.brand ? idx.byBrand.get(brandKey(row.brand)) || [] : []),
  ];
  return list.length ? evaluate(row, list, idx.vat) : null;
}

// Core hook: the special price in cents (floored at cost incl VAT), or null
// when no running special lowers this product's price.
export function specialPriceCents(row, db = getDb()) {
  const d = specialDetails(row, db);
  return d && d.applies ? d.specialCents : null;
}

// ------------------------------------------------------------------ admin CRUD

function targetName(db, type, id) {
  if (type === 'product') return db.prepare('SELECT name FROM products WHERE id = ?').get(id)?.name || '(deleted product)';
  if (type === 'category') {
    const rows = db.prepare('SELECT id, parent_id, name FROM categories').all();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const names = [];
    for (let c = byId.get(id), n = 0; c && n < 10; c = byId.get(c.parent_id), n++) names.unshift(c.name);
    return names.join(' › ') || '(deleted category)';
  }
  return id;
}

function rowToSpecial(r, db) {
  return {
    id: r.id,
    label: r.label,
    targetType: r.target_type,
    targetId: r.target_id,
    targetName: targetName(db, r.target_type, r.target_id),
    kind: r.kind,
    percentOff: r.percent_off,
    priceCents: r.price_cents,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    active: Boolean(r.active),
    state: windowState(r),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// Validates admin input into a DB-shaped row (no id/timestamps).
export function normaliseSpecial(data = {}, db = getDb()) {
  const label = String(data.label ?? '').trim().slice(0, 80) || 'Special';
  const type = String(data.targetType || '');
  if (!TARGET_TYPES.includes(type)) throw new Error('Choose what the special is for: a product, a category or a brand');
  let targetId = String(data.targetId ?? '').trim();
  if (!targetId) throw new Error(type === 'brand' ? 'Choose a brand' : `Choose a ${type}`);
  if (type === 'product' && !db.prepare('SELECT 1 FROM products WHERE id = ?').get(targetId)) throw new Error('That product no longer exists');
  if (type === 'category' && !db.prepare('SELECT 1 FROM categories WHERE id = ?').get(targetId)) throw new Error('That category no longer exists');
  if (type === 'brand') targetId = targetId.slice(0, 80);
  const kind = String(data.kind || 'percent');
  if (!KINDS.includes(kind)) throw new Error('Invalid discount type');
  let percentOff = 0;
  let priceCents = 0;
  if (kind === 'percent') {
    percentOff = Number(data.percentOff);
    if (!Number.isFinite(percentOff) || percentOff <= 0 || percentOff >= 100) throw new Error('Percentage off must be between 0 and 100');
    percentOff = Math.round(percentOff * 100) / 100;
  } else {
    if (type !== 'product') throw new Error('A fixed special price is only possible for a single product — use a percentage for categories and brands');
    priceCents = data.priceCents != null && data.priceCents !== '' ? Math.round(Number(data.priceCents)) : parseRandToCents(data.price);
    if (!Number.isFinite(priceCents) || priceCents <= 0) throw new Error('Enter the special price');
  }
  const startsAt = normDate(data.startsAt, 'Start date');
  const endsAt = normDate(data.endsAt, 'End date');
  if (startsAt && endsAt && endsAt < startsAt) throw new Error('The end date is before the start date');
  const active = !(data.active === false || data.active === 'false' || data.active === 0 || data.active === '0');
  return { label, target_type: type, target_id: targetId, kind, percent_off: percentOff, price_cents: priceCents, starts_at: startsAt, ends_at: endsAt, active: active ? 1 : 0 };
}

export function getSpecial(id, db = getDb()) {
  const r = db.prepare('SELECT * FROM specials WHERE id = ?').get(id);
  return r ? rowToSpecial(r, db) : null;
}

export function saveSpecial(data, id = null, db = getDb()) {
  const s = normaliseSpecial(data, db);
  const ts = now();
  if (id) {
    if (!db.prepare('SELECT 1 FROM specials WHERE id = ?').get(id)) return null;
    db.prepare(`UPDATE specials SET label=@label, target_type=@target_type, target_id=@target_id, kind=@kind, percent_off=@percent_off,
      price_cents=@price_cents, starts_at=@starts_at, ends_at=@ends_at, active=@active, updated_at=@ts WHERE id=@id`).run({ ...s, id, ts });
  } else {
    id = randomUUID();
    db.prepare(`INSERT INTO specials (id, label, target_type, target_id, kind, percent_off, price_cents, starts_at, ends_at, active, created_at, updated_at)
      VALUES (@id, @label, @target_type, @target_id, @kind, @percent_off, @price_cents, @starts_at, @ends_at, @active, @ts, @ts)`).run({ ...s, id, ts });
  }
  invalidateSpecials(db);
  return getSpecial(id, db);
}

export function deleteSpecial(id, db = getDb()) {
  const n = db.prepare('DELETE FROM specials WHERE id = ?').run(id).changes;
  invalidateSpecials(db);
  return n > 0;
}

// What one special (saved or not) does to each product it covers, judged on
// its own (another special may still beat it). Used for the admin list's
// counts and the preview table.
export function specialImpact(s, db = getDb(), { limit = 0 } = {}) {
  const vat = floorContext(db);
  const rows = productsForTarget(db, { type: s.target_type, id: s.target_id, brand: s.target_id }, 'p.id, p.name, p.sku, p.brand, p.price_cents, p.cost_cents, p.active');
  let affected = 0;
  let capped = 0;
  let notLower = 0;
  const items = [];
  for (const r of rows) {
    const raw = rawSpecialCents(s, r);
    const floor = floorCents(r.cost_cents, vat);
    const price = Math.max(raw, floor);
    const lower = price < r.price_cents;
    if (lower) affected++;
    else notLower++;
    if (raw < floor) capped++;
    items.push({ id: r.id, name: r.name, sku: r.sku, brand: r.brand, active: Boolean(r.active), normalCents: r.price_cents, requestedCents: raw, floorCents: floor, specialCents: lower ? price : r.price_cents, capped: raw < floor, lower });
  }
  items.sort((a, b) => Number(b.capped) - Number(a.capped) || a.name.localeCompare(b.name));
  return { products: rows.length, affected, capped, notLower, items: limit ? items.slice(0, limit) : items };
}

export function listSpecials(db = getDb()) {
  return db
    .prepare('SELECT * FROM specials ORDER BY active DESC, CASE WHEN ends_at = \'\' THEN \'9999\' ELSE ends_at END DESC, created_at DESC')
    .all()
    .map((r) => {
      const { products, affected, capped, notLower } = specialImpact(r, db);
      return { ...rowToSpecial(r, db), products, affected, capped, notLower };
    });
}

// Storefront: products on special, biggest saving first. Two kinds:
//  - specials set up in Admin -> Specials (this module), and
//  - products showing a struck-through "was" price: supplier specials from
//    the SMD API (products.special_by_feed) or a was-price set on the product.
// A product in both counts once, with the admin special (the lower price).
// `category` (slug) narrows the list to that category and everything under
// it; `categories` counts the specials per top-level shop category (quick filter).
export function productsOnSpecial({ page = 1, pageSize = 24, category = '' } = {}, db = getDb()) {
  const idx = loadIndex(db);
  const saving = new Map(); // id -> { name, pct }
  if (idx.count) {
    const ids = [...idx.byProduct.keys()];
    const cats = [...idx.byCategory.keys()];
    const brands = [...idx.byBrand.keys()];
    const where = [];
    if (ids.length) where.push(`id IN (${ids.map(() => '?').join(',')})`);
    if (cats.length) where.push(`category_id IN (${cats.map(() => '?').join(',')})`);
    if (brands.length) where.push(`lower(trim(brand)) IN (${brands.map(() => '?').join(',')})`);
    for (const r of db.prepare(`SELECT id, name, brand, category_id, price_cents, cost_cents FROM products WHERE active = 1 AND (${where.join(' OR ')})`).all(...ids, ...cats, ...brands)) {
      const sp = specialPriceCents(r, db);
      if (sp != null && r.price_cents > 0) saving.set(r.id, { name: r.name, pct: (r.price_cents - sp) / r.price_cents });
    }
  }
  for (const r of db.prepare('SELECT id, name, price_cents, compare_at_cents FROM products WHERE active = 1 AND compare_at_cents > price_cents AND price_cents > 0').all()) {
    if (!saving.has(r.id)) saving.set(r.id, { name: r.name, pct: (r.compare_at_cents - r.price_cents) / r.compare_at_cents });
  }
  // Category of each product on special, and its top-level shop category.
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
  const catOf = new Map();
  const idList = [...saving.keys()];
  for (let i = 0; i < idList.length; i += 500) {
    const chunk = idList.slice(i, i + 500);
    for (const r of db.prepare(`SELECT id, category_id FROM products WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk)) catOf.set(r.id, r.category_id);
  }
  const counts = new Map();
  for (const id of idList) {
    const top = topOf(catOf.get(id));
    if (top) counts.set(top.id, (counts.get(top.id) || 0) + 1);
  }
  const categories = [...counts.entries()]
    .map(([id, count]) => ({ slug: cats.get(id).slug, name: cats.get(id).name, count, sort: cats.get(id).sort_order }))
    .sort((a, b) => b.count - a.count || a.sort - b.sort)
    .map(({ sort, ...c }) => c);

  // Optional filter: a category and all its descendants.
  let keep = null;
  const chosen = category ? [...cats.values()].find((c) => c.slug === String(category)) : null;
  if (chosen) {
    keep = new Set([chosen.id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const c of cats.values()) if (c.parent_id && keep.has(c.parent_id) && !keep.has(c.id)) keep.add(c.id), (grew = true);
    }
  }
  const rows = [...saving.entries()]
    .filter(([id]) => !keep || keep.has(catOf.get(id)))
    .sort((a, b) => b[1].pct - a[1].pct || a[1].name.localeCompare(b[1].name))
    .map(([id]) => ({ r: { id } }));
  const size = clampInt(pageSize, 1, 96, 24);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const p = clampInt(page, 1, pages, 1);
  return { rows: rows.slice((p - 1) * size, p * size).map((x) => x.r.id), total: rows.length, page: p, pages, pageSize: size, categories, allTotal: saving.size, category: chosen ? { slug: chosen.slug, name: chosen.name } : null };
}

// ------------------------------------------------------------------ routes

export function register({ app, admin, wrap }) {
  app.get(
    '/api/specials',
    wrap(async (req) => {
      const { getProduct } = await import('../catalog.js'); // catalog imports this module; load lazily
      const { rows, ...rest } = productsOnSpecial({ page: req.query.page, pageSize: req.query.pageSize, category: req.query.category });
      return { ...rest, items: rows.map((id) => getProduct(id, { admin: false })).filter(Boolean) };
    }),
  );

  admin.get('/specials', wrap(() => listSpecials()));
  admin.get('/specials/options', wrap(() => ({ brands: brandList(getDb()), today: todaySast() })));
  admin.post('/specials/preview', wrap((req) => {
    const s = normaliseSpecial(req.body || {});
    return specialImpact(s, getDb(), { limit: 300 });
  }));
  admin.post('/specials', wrap((req) => saveSpecial(req.body || {})));
  admin.put('/specials/:id', wrap((req) => {
    const s = saveSpecial(req.body || {}, req.params.id);
    if (!s) throw Object.assign(new Error('Not found'), { status: 404 });
    return s;
  }));
  admin.delete('/specials/:id', wrap((req) => {
    if (!deleteSpecial(req.params.id)) throw Object.assign(new Error('Not found'), { status: 404 });
    return { ok: true };
  }));
}
