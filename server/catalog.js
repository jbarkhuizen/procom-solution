import { randomUUID } from 'crypto';
import { specialPriceCents } from './features/specials.js';
import { getDb } from './db.js';
import { getSettings } from './settings.js';
import { effectiveMarkupPct, computeRetailCents, marginCents } from './pricing.js';
import { uniqueSlug, parseJsonArray, clampInt, parseRandToCents } from './util.js';
import { encryptSecret, decryptSecret } from './vault.js';

const now = () => new Date().toISOString();

// ---------------------------------------------------------------- categories

function rowToCategory(r) {
  return {
    id: r.id,
    parentId: r.parent_id,
    name: r.name,
    slug: r.slug,
    description: r.description,
    markupPct: r.markup_pct,
    sortOrder: r.sort_order,
    active: Boolean(r.active),
    quoteDelivery: Boolean(r.quote_delivery),
    courierInsurancePct: r.courier_insurance_pct ?? null,
  };
}

// Category ids whose products get "delivery quoted after order" -- a flag on a
// category applies to all its sub-categories too.
export function quoteDeliveryCategoryIds(db = getDb()) {
  const rows = db.prepare('SELECT id, parent_id, quote_delivery FROM categories').all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = new Set();
  for (const r of rows) {
    const seen = new Set();
    for (let c = r; c && !seen.has(c.id); c = byId.get(c.parent_id)) {
      seen.add(c.id);
      if (c.quote_delivery) {
        out.add(r.id);
        break;
      }
    }
  }
  return out;
}

// Product override wins (1 always / 0 never); NULL inherits from its category.
export function needsDeliveryQuote(productRow, quoteSet) {
  if (productRow.quote_delivery === 1) return true;
  if (productRow.quote_delivery === 0) return false;
  return quoteSet.has(productRow.category_id);
}

export function listCategories({ activeOnly = false } = {}, db = getDb()) {
  const rows = db.prepare(`SELECT * FROM categories ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY sort_order, name`).all();
  return rows.map(rowToCategory);
}

// Map id -> ids of that category and all descendants.
function descendantIds(categories, rootId) {
  const out = [rootId];
  for (let i = 0; i < out.length; i++) {
    for (const c of categories) if (c.parentId === out[i]) out.push(c.id);
  }
  return out;
}

// Chain from the category up to the root, used for markup inheritance and breadcrumbs.
export function categoryChain(categoryId, db = getDb()) {
  const chain = [];
  const seen = new Set();
  let id = categoryId;
  const stmt = db.prepare('SELECT * FROM categories WHERE id = ?');
  while (id && !seen.has(id)) {
    seen.add(id);
    const row = stmt.get(id);
    if (!row) break;
    chain.push(row);
    id = row.parent_id;
  }
  return chain;
}

// Pages for /sitemap.xml (Google): static pages, every category the shop
// shows (it hides empty ones) and every live product, with last-changed dates.
export function sitemapEntries(db = getDb()) {
  const day = (iso) => (iso ? String(iso).slice(0, 10) : undefined);
  const cats = [];
  const walk = (nodes) => nodes.forEach((c) => { if (c.productCount > 0) cats.push(c); walk(c.children); });
  walk(categoryTree({ activeOnly: true }, db));
  const catUpdated = new Map(db.prepare('SELECT id, updated_at FROM categories').all().map((r) => [r.id, r.updated_at]));
  return [
    ...['/', '/shop.html', '/specials.html', '/price-drops.html', '/contact.html', '/terms.html', '/privacy.html', '/returns.html'].map((path) => ({ path })),
    ...cats.map((c) => ({ path: `/shop.html?category=${encodeURIComponent(c.slug)}`, lastmod: day(catUpdated.get(c.id)) })),
    ...db
      .prepare('SELECT slug, updated_at FROM products WHERE active = 1 ORDER BY updated_at DESC')
      .all()
      .map((p) => ({ path: `/product.html?p=${encodeURIComponent(p.slug)}`, lastmod: day(p.updated_at) })),
  ];
}

// Tree with active-product counts (including descendants) for the storefront nav.
export function categoryTree({ activeOnly = true } = {}, db = getDb()) {
  const cats = listCategories({ activeOnly }, db);
  const counts = new Map(
    db.prepare('SELECT category_id, COUNT(*) n FROM products WHERE active = 1 GROUP BY category_id').all().map((r) => [r.category_id, r.n]),
  );
  const byParent = new Map();
  for (const c of cats) {
    const key = c.parentId && cats.some((p) => p.id === c.parentId) ? c.parentId : null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(c);
  }
  const build = (parentId) =>
    (byParent.get(parentId) || []).map((c) => {
      const children = build(c.id);
      const productCount = (counts.get(c.id) || 0) + children.reduce((s, ch) => s + ch.productCount, 0);
      return { ...c, children, productCount };
    });
  return build(null);
}

function insurancePct(v, current) {
  if (v === undefined) return current ?? null;
  if (v === '' || v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 50) throw new Error('Courier insurance must be between 0 and 50%');
  return n;
}

// Category id -> courier insurance % (own value, else the nearest parent's).
export function courierInsuranceByCategory(db = getDb()) {
  const rows = db.prepare('SELECT id, parent_id, courier_insurance_pct FROM categories').all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = new Map();
  for (const r of rows) {
    const seen = new Set();
    for (let c = r; c && !seen.has(c.id); c = byId.get(c.parent_id)) {
      seen.add(c.id);
      if (c.courier_insurance_pct != null) {
        if (c.courier_insurance_pct > 0) out.set(r.id, c.courier_insurance_pct);
        break;
      }
    }
  }
  return out;
}

export function saveCategory(data, id = null, db = getDb()) {
  const name = String(data.name || '').trim();
  if (!name) throw new Error('Category name is required');
  const parentId = data.parentId || null;
  if (id && parentId) {
    const all = listCategories({}, db);
    if (descendantIds(all, id).includes(parentId)) throw new Error('A category cannot be moved inside itself');
  }
  const markup = data.markupPct === '' || data.markupPct == null ? null : Number(data.markupPct);
  if (markup != null && (!Number.isFinite(markup) || markup < 0 || markup > 500)) throw new Error('Markup must be between 0 and 500%');
  const slug = uniqueSlug(db, 'categories', data.slug || name, id || '');
  const fields = {
    parent_id: parentId,
    name,
    slug,
    description: String(data.description || ''),
    markup_pct: markup,
    sort_order: clampInt(data.sortOrder, -9999, 9999, 0),
    active: data.active === false || data.active === 0 ? 0 : 1,
    quote_delivery: data.quoteDelivery === true || data.quoteDelivery === 1 || data.quoteDelivery === '1' || data.quoteDelivery === 'on' ? 1 : 0,
    // Left out of `data` = keep (older callers); '' = inherit from the parent.
    courier_insurance_pct: insurancePct(data.courierInsurancePct, id ? db.prepare('SELECT courier_insurance_pct c FROM categories WHERE id = ?').get(id)?.c : null),
    updated_at: now(),
  };
  if (id) {
    const res = db.prepare(`UPDATE categories SET parent_id=@parent_id, name=@name, slug=@slug, description=@description,
      markup_pct=@markup_pct, sort_order=@sort_order, active=@active, quote_delivery=@quote_delivery, courier_insurance_pct=@courier_insurance_pct, updated_at=@updated_at WHERE id=@id`).run({ ...fields, id });
    if (!res.changes) return null;
  } else {
    id = randomUUID();
    db.prepare(`INSERT INTO categories (id, parent_id, name, slug, description, markup_pct, sort_order, active, quote_delivery, courier_insurance_pct, created_at, updated_at)
      VALUES (@id, @parent_id, @name, @slug, @description, @markup_pct, @sort_order, @active, @quote_delivery, @courier_insurance_pct, @updated_at, @updated_at)`).run({ ...fields, id });
  }
  // A markup change must flow through to every auto-priced product underneath.
  repriceProducts({}, db);
  return rowToCategory(db.prepare('SELECT * FROM categories WHERE id = ?').get(id));
}

export function deleteCategory(id, db = getDb()) {
  const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
  if (!cat) return false;
  const tx = db.transaction(() => {
    // Children and products move up to the deleted category's parent rather than orphaning.
    db.prepare('UPDATE categories SET parent_id = ? WHERE parent_id = ?').run(cat.parent_id, id);
    db.prepare('UPDATE products SET category_id = ? WHERE category_id = ?').run(cat.parent_id, id);
    db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  });
  tx();
  return true;
}

// ------------------------------------------------------------------ products

function rowToProduct(r, { admin = false, supplierLead = '', quoteSet = new Set() } = {}) {
  if (!r) return null;
  // Flat-fee suppliers (e.g. SMD) deliver everything for their one fee: no quotes.
  const quoteDelivery = r.supplier_delivery_mode !== 'flat' && needsDeliveryQuote(r, quoteSet);
  const images = parseJsonArray(r.images);
  const inStock = r.fulfilment === 'stock' ? r.stock_qty > 0 : Boolean(r.supplier_in_stock);
  const base = {
    id: r.id,
    sku: r.sku,
    name: r.name,
    slug: r.slug,
    brand: r.brand,
    categoryId: r.category_id,
    categoryName: r.category_name || '',
    categorySlug: r.category_slug || '',
    shortDescription: r.short_description,
    description: r.description,
    specs: parseJsonArray(r.specs),
    images,
    image: images[0] || '',
    fulfilment: r.fulfilment,
    // A running special shows as the price, with the normal price struck through.
    ...(() => {
      const special = admin ? null : specialPriceCents(r);
      return special != null && special < r.price_cents
        ? { priceCents: special, compareAtCents: Math.max(r.price_cents, r.compare_at_cents || 0), onSpecial: true }
        : { priceCents: r.price_cents, compareAtCents: r.compare_at_cents, onSpecial: false };
    })(),
    weightG: r.weight_g,
    minOrderQty: r.min_order_qty,
    inStock,
    stockQty: r.fulfilment === 'stock' ? r.stock_qty : null,
    availability: !inStock ? 'Out of stock' : r.fulfilment === 'stock' ? 'In stock — ships in 1-2 business days' : supplierLead || r.lead_time_text || 'Ships from our warehouse in 2-5 business days',
    featured: Boolean(r.featured),
    quoteDelivery,
    // Which warehouse ships it, by its public name only ("Samrand warehouse");
    // the supplier's real name never reaches the storefront.
    shipsFrom: r.fulfilment === 'dropship' ? r.supplier_label || '' : '',
    // Icon colour: warehouses in the order they were added, so they always differ (4 colours).
    shipsFromTone: r.fulfilment === 'dropship' && r.supplier_label ? (r.supplier_tone || 0) % 4 : 0,
    // Live supplier stock (SMD API "SOH"), shown to customers when known:
    // stockOnHand in selling units (packs for pack items), stockMax in single
    // units for the quantity box; stockLeft only when low ("Only 3 left").
    ...(() => {
      const known = inStock && r.fulfilment === 'dropship' && r.supplier_stock_qty != null;
      const onHand = known ? Math.floor(r.supplier_stock_qty / Math.max(1, r.min_order_qty)) : null;
      return { stockOnHand: onHand, stockMax: known ? r.supplier_stock_qty : null, stockLeft: onHand != null && onHand <= 5 ? onHand : null };
    })(),
  };
  if (!admin) return base;
  return {
    ...base,
    supplierId: r.supplier_id,
    supplierName: r.supplier_name || '',
    supplierCode: r.supplier_code,
    costCents: r.cost_cents,
    markupPct: r.markup_pct,
    priceMode: r.price_mode,
    supplierInStock: Boolean(r.supplier_in_stock),
    stockQty: r.stock_qty,
    quoteDeliveryOverride: r.quote_delivery, // null = inherit from category
    active: Boolean(r.active),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const PRODUCT_SELECT = `
  SELECT p.*, c.name AS category_name, c.slug AS category_slug, s.name AS supplier_name, s.lead_time_text, s.delivery_mode AS supplier_delivery_mode, s.public_label AS supplier_label,
    (SELECT COUNT(*) FROM suppliers s2 WHERE s2.public_label != '' AND (s2.created_at < s.created_at OR (s2.created_at = s.created_at AND s2.id < s.id))) AS supplier_tone
  FROM products p
  LEFT JOIN categories c ON c.id = p.category_id
  LEFT JOIN suppliers s ON s.id = p.supplier_id`;

function withMargin(p, settings) {
  return { ...p, marginCents: marginCents(p.priceCents, p.costCents, { vatRatePct: settings.vatRatePct, vatRegistered: settings.vatRegistered }) };
}

export function getProduct(id, { admin = true } = {}, db = getDb()) {
  const row = db.prepare(`${PRODUCT_SELECT} WHERE p.id = ?`).get(id);
  if (!row) return null;
  const p = rowToProduct(row, { admin, quoteSet: quoteDeliveryCategoryIds(db) });
  return admin ? withMargin(p, getSettings(db)) : p;
}

export function getPublicProductBySlug(slug, db = getDb()) {
  const row = db.prepare(`${PRODUCT_SELECT} WHERE p.slug = ? AND p.active = 1`).get(slug);
  if (!row) return null;
  const quoteSet = quoteDeliveryCategoryIds(db);
  const product = rowToProduct(row, { quoteSet });
  const breadcrumb = categoryChain(row.category_id, db).reverse().map((c) => ({ name: c.name, slug: c.slug }));
  const related = db
    .prepare(`${PRODUCT_SELECT} WHERE p.active = 1 AND p.category_id = ? AND p.id != ? ORDER BY p.featured DESC, RANDOM() LIMIT 5`)
    .all(row.category_id, row.id)
    .map((r) => rowToProduct(r, { quoteSet }));
  return { product, breadcrumb, related };
}

const SORTS = {
  featured: 'p.featured DESC, p.updated_at DESC',
  newest: 'p.created_at DESC',
  'price-asc': 'p.price_cents ASC',
  'price-desc': 'p.price_cents DESC',
  name: 'p.name COLLATE NOCASE ASC',
};

// Search helpers: lower-case, drop spaces and common punctuation ("K1-C" -> "k1c").
const COMPACT_CHARS = [' ', '-', '_', '/', '.'];
const COMPACT_SQL = (col) => COMPACT_CHARS.reduce((sql, ch) => `REPLACE(${sql}, '${ch}', '')`, `LOWER(${col})`);
export const compactSearch = (s) => String(s).toLowerCase().replace(/[\s\-_/.]+/g, '');

// Shared by storefront listing and admin product table.
export function queryProducts(opts = {}, db = getDb()) {
  const { admin = false } = opts;
  const where = [];
  const params = {};
  if (!admin) where.push('p.active = 1');
  if (admin && opts.status === 'active') where.push('p.active = 1');
  if (admin && opts.status === 'inactive') where.push('p.active = 0');
  if (admin && opts.category === '__none') {
    where.push('p.category_id IS NULL');
  } else if (opts.category) {
    const all = listCategories({}, db);
    const cat = all.find((c) => c.slug === opts.category || c.id === opts.category);
    if (!cat) return { items: [], total: 0, page: 1, pages: 0, brands: [] };
    const ids = descendantIds(all, cat.id);
    where.push(`p.category_id IN (${ids.map((_, i) => `@cat${i}`).join(',')})`);
    ids.forEach((v, i) => (params[`cat${i}`] = v));
  }
  if (opts.q) {
    const terms = String(opts.q).trim().split(/\s+/).slice(0, 6);
    terms.forEach((t, i) => {
      // Model numbers are written many ways ("K1-C", "K1 C", "K1C"): also match the
      // name/SKU with spaces and punctuation removed, for terms of 3+ letters/digits.
      const compact = compactSearch(t);
      const loose = compact.length >= 3 ? ` OR ${COMPACT_SQL('p.name')} LIKE @qc${i} ESCAPE '\\' OR ${COMPACT_SQL('p.sku')} LIKE @qc${i} ESCAPE '\\'` : '';
      where.push(`(p.name LIKE @q${i} ESCAPE '\\' OR p.brand LIKE @q${i} ESCAPE '\\' OR p.sku LIKE @q${i} ESCAPE '\\' OR p.supplier_code LIKE @q${i} ESCAPE '\\'${loose})`);
      const like = (v) => v.replace(/[\\%_]/g, (c) => `\\${c}`); // a typed % or _ is a plain character, not a wildcard
      params[`q${i}`] = `%${like(t)}%`;
      if (loose) params[`qc${i}`] = `%${like(compact)}%`;
    });
  }
  if (opts.fulfilment) {
    where.push('p.fulfilment = @fulfilment');
    params.fulfilment = opts.fulfilment;
  }
  if (opts.featured) where.push('p.featured = 1');
  if (opts.inStock) where.push("((p.fulfilment = 'stock' AND p.stock_qty > 0) OR (p.fulfilment = 'dropship' AND p.supplier_in_stock = 1))");
  if (opts.minPrice != null && opts.minPrice !== '') {
    where.push('p.price_cents >= @minPrice');
    params.minPrice = Math.round(Number(opts.minPrice) * 100) || 0;
  }
  if (opts.maxPrice != null && opts.maxPrice !== '') {
    where.push('p.price_cents <= @maxPrice');
    params.maxPrice = Math.round(Number(opts.maxPrice) * 100) || 0;
  }
  const baseWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
  // Brand facet is computed before applying the brand filter so the list doesn't collapse to one.
  const brands = db
    .prepare(`SELECT p.brand, COUNT(*) n FROM products p ${baseWhere} ${baseWhere ? 'AND' : 'WHERE'} p.brand != '' GROUP BY p.brand ORDER BY p.brand COLLATE NOCASE`)
    .all(params)
    .map((r) => ({ name: r.brand, count: r.n }));
  if (opts.brand) {
    where.push('p.brand = @brand');
    params.brand = opts.brand;
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) n FROM products p ${whereSql}`).get(params).n;
  const pageSize = clampInt(opts.pageSize, 1, 200, 24);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = clampInt(opts.page, 1, pages, 1);
  const order = SORTS[opts.sort] || SORTS.featured;
  const rows = db
    .prepare(`${PRODUCT_SELECT} ${whereSql} ORDER BY ${order}, p.name LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`)
    .all(params);
  const settings = admin ? getSettings(db) : null;
  const quoteSet = quoteDeliveryCategoryIds(db);
  const items = rows.map((r) => {
    const p = rowToProduct(r, { admin, quoteSet });
    return admin ? withMargin(p, settings) : p;
  });
  return { items, total, page, pages, pageSize, brands };
}

// Auto price this product would have at `costCents` (e.g. the "was" price
// while a supplier special lowers the cost).
export function retailForCost(productRow, costCents, db = getDb()) {
  return priceFor({ ...productRow, cost_cents: costCents }, db);
}

function priceFor(fields, db) {
  const settings = getSettings(db);
  const markup = effectiveMarkupPct({
    productMarkup: fields.markup_pct,
    categoryChain: categoryChain(fields.category_id, db),
    defaultMarkup: settings.defaultMarkupPct,
  });
  return computeRetailCents(fields.cost_cents, markup, settings.vatRatePct, Math.round((Number(settings.minProfitRand) || 0) * 100));
}

function normaliseSpecs(specs) {
  if (typeof specs === 'string') {
    // "Label: value" per line, as typed in the admin textarea.
    return specs
      .split('\n')
      .map((line) => line.split(/:(.*)/s))
      .filter(([l, v]) => l && l.trim() && v && v.trim())
      .map(([l, v]) => ({ label: l.trim(), value: v.trim() }));
  }
  return Array.isArray(specs) ? specs.filter((s) => s && s.label).map((s) => ({ label: String(s.label), value: String(s.value ?? '') })) : [];
}

function centsInput(value, fallback) {
  if (value === undefined) return fallback;
  if (value === null || value === '') return null;
  // Admin UI sends rands; allow cents via *Cents keys handled by caller.
  return parseRandToCents(value);
}

// Time-based code for products saved without a SKU; a suffix keeps two saved
// in the same millisecond apart.
function generatedSku(db) {
  const base = `PC-${Date.now().toString(36).toUpperCase()}`;
  const taken = db.prepare('SELECT 1 FROM products WHERE sku = ?');
  let sku = base;
  for (let n = 2; taken.get(sku); n++) sku = `${base}-${n}`;
  return sku;
}

export function saveProduct(data, id = null, db = getDb()) {
  const existing = id ? db.prepare('SELECT * FROM products WHERE id = ?').get(id) : null;
  if (id && !existing) return null;
  const settings = getSettings(db);
  const name = String(data.name ?? existing?.name ?? '').trim();
  if (!name) throw new Error('Product name is required');
  const sku = String(data.sku ?? existing?.sku ?? '').trim() || generatedSku(db);
  const skuClash = db.prepare('SELECT id FROM products WHERE sku = ? AND id != ?').get(sku, id || '');
  if (skuClash) throw new Error(`SKU "${sku}" is already used by another product`);

  const fulfilment = (data.fulfilment ?? existing?.fulfilment ?? 'dropship') === 'stock' ? 'stock' : 'dropship';
  const markupRaw = data.markupPct !== undefined ? data.markupPct : existing?.markup_pct;
  const markup = markupRaw === '' || markupRaw == null ? null : Number(markupRaw);
  if (markup != null && (!Number.isFinite(markup) || markup < 0 || markup > 500)) throw new Error('Markup must be between 0 and 500%');

  const fields = {
    sku,
    name,
    slug: uniqueSlug(db, 'products', data.slug || (existing && existing.name === name ? existing.slug : name), id || ''),
    brand: String(data.brand ?? existing?.brand ?? '').trim(),
    category_id: data.categoryId !== undefined ? data.categoryId || null : existing?.category_id ?? null,
    short_description: String(data.shortDescription ?? existing?.short_description ?? ''),
    description: String(data.description ?? existing?.description ?? ''),
    specs: JSON.stringify(data.specs !== undefined ? normaliseSpecs(data.specs) : parseJsonArray(existing?.specs)),
    images: JSON.stringify(Array.isArray(data.images) ? data.images.filter((s) => typeof s === 'string' && s.startsWith('/uploads/')) : parseJsonArray(existing?.images)),
    fulfilment,
    supplier_id: data.supplierId !== undefined ? data.supplierId || null : existing?.supplier_id ?? null,
    supplier_code: String(data.supplierCode ?? existing?.supplier_code ?? ''),
    cost_cents: data.costCents !== undefined ? Math.max(0, Math.round(Number(data.costCents) || 0)) : centsInput(data.cost, existing?.cost_cents ?? 0) ?? 0,
    markup_pct: markup,
    price_mode: (data.priceMode ?? existing?.price_mode ?? 'auto') === 'manual' ? 'manual' : 'auto',
    price_cents: data.priceCents !== undefined ? Math.round(Number(data.priceCents) || 0) : centsInput(data.price, existing?.price_cents ?? 0) ?? 0,
    compare_at_cents: data.compareAtCents !== undefined ? (data.compareAtCents == null ? null : Math.round(Number(data.compareAtCents))) : centsInput(data.compareAt, existing?.compare_at_cents ?? null),
    weight_g: clampInt(data.weightG ?? existing?.weight_g, 0, 1_000_000, settings.defaultWeightG),
    stock_qty: clampInt(data.stockQty ?? existing?.stock_qty, 0, 1_000_000, 0),
    supplier_in_stock: (data.supplierInStock ?? (existing ? Boolean(existing.supplier_in_stock) : true)) ? 1 : 0,
    min_order_qty: clampInt(data.minOrderQty ?? existing?.min_order_qty, 1, 10_000, 1),
    active: (data.active ?? (existing ? Boolean(existing.active) : true)) ? 1 : 0,
    featured: (data.featured ?? (existing ? Boolean(existing.featured) : false)) ? 1 : 0,
    // '' / 'inherit' / null -> follow the category; '1' always quote; '0' never.
    quote_delivery:
      data.quoteDelivery === undefined
        ? existing?.quote_delivery ?? null
        : ['1', 1, true, 'always'].includes(data.quoteDelivery) ? 1 : ['0', 0, false, 'never'].includes(data.quoteDelivery) ? 0 : null,
    updated_at: now(),
  };
  // Kept only while the admin leaves the stock flag as the feed set it.
  fields.out_by_feed = existing && fields.supplier_in_stock === existing.supplier_in_stock ? existing.out_by_feed : 0;
  fields.hidden_by_feed = existing && fields.active === existing.active ? existing.hidden_by_feed : 0;
  // Photos the admin changes are theirs: supplier feeds never replace them.
  if (existing && Array.isArray(data.images) && fields.images !== existing.images) fields.images_from_feed = 0;
  if (fields.price_mode === 'auto') fields.price_cents = priceFor(fields, db);
  if (fields.active && fields.price_cents <= 0) throw new Error('An active product needs a price above R0 (set a supplier cost or a manual price)');

  if (existing) {
    const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE products SET ${sets} WHERE id = @id`).run({ ...fields, id });
  } else {
    id = randomUUID();
    const cols = Object.keys(fields);
    db.prepare(`INSERT INTO products (id, created_at, ${cols.join(', ')}) VALUES (@id, @updated_at, ${cols.map((c) => '@' + c).join(', ')})`).run({ ...fields, id });
  }
  return getProduct(id, { admin: true }, db);
}

export function deleteProduct(id, db = getDb()) {
  return db.prepare('DELETE FROM products WHERE id = ?').run(id).changes > 0;
}

// Recomputes price for every auto-priced product (optionally a subset).
// Returns number of products whose price actually changed.
export function repriceProducts({ ids = null } = {}, db = getDb()) {
  const rows = ids
    ? db.prepare(`SELECT * FROM products WHERE price_mode = 'auto' AND id IN (${ids.map(() => '?').join(',') || "''"})`).all(...ids)
    : db.prepare("SELECT * FROM products WHERE price_mode = 'auto'").all();
  const upd = db.prepare('UPDATE products SET price_cents = ?, updated_at = ? WHERE id = ?');
  let changed = 0;
  const ts = now();
  const tx = db.transaction(() => {
    for (const r of rows) {
      const price = priceFor(r, db);
      if (price !== r.price_cents) {
        upd.run(price, ts, r.id);
        changed++;
      }
    }
  });
  tx();
  return changed;
}

export function bulkUpdateProducts({ ids, action, value }, db = getDb()) {
  if (!Array.isArray(ids) || !ids.length) throw new Error('No products selected');
  const ph = ids.map(() => '?').join(',');
  const ts = now();
  let changes = 0;
  const tx = db.transaction(() => {
    switch (action) {
      case 'activate':
        changes = db.prepare(`UPDATE products SET active = 1, hidden_by_feed = 0, updated_at = ? WHERE id IN (${ph}) AND price_cents > 0`).run(ts, ...ids).changes;
        break;
      case 'deactivate':
        changes = db.prepare(`UPDATE products SET active = 0, hidden_by_feed = 0, updated_at = ? WHERE id IN (${ph})`).run(ts, ...ids).changes;
        break;
      case 'feature':
      case 'unfeature':
        changes = db.prepare(`UPDATE products SET featured = ?, updated_at = ? WHERE id IN (${ph})`).run(action === 'feature' ? 1 : 0, ts, ...ids).changes;
        break;
      case 'set-category':
        changes = db.prepare(`UPDATE products SET category_id = ?, updated_at = ? WHERE id IN (${ph})`).run(value || null, ts, ...ids).changes;
        repriceProducts({ ids }, db);
        break;
      case 'set-markup': {
        const m = value === '' || value == null ? null : Number(value);
        if (m != null && (!Number.isFinite(m) || m < 0 || m > 500)) throw new Error('Markup must be between 0 and 500%');
        changes = db.prepare(`UPDATE products SET markup_pct = ?, price_mode = 'auto', updated_at = ? WHERE id IN (${ph})`).run(m, ts, ...ids).changes;
        repriceProducts({ ids }, db);
        break;
      }
      case 'supplier-out':
      case 'supplier-in':
        changes = db.prepare(`UPDATE products SET supplier_in_stock = ?, out_by_feed = 0, updated_at = ? WHERE id IN (${ph})`).run(action === 'supplier-in' ? 1 : 0, ts, ...ids).changes;
        break;
      case 'delete':
        changes = db.prepare(`DELETE FROM products WHERE id IN (${ph})`).run(...ids).changes;
        break;
      default:
        throw new Error('Unknown bulk action');
    }
  });
  tx();
  return { changes };
}

// ----------------------------------------------------------------- suppliers

function rowToSupplier(s) {
  return {
    id: s.id,
    name: s.name,
    contactName: s.contact_name,
    email: s.email,
    phone: s.phone,
    leadTimeText: s.lead_time_text,
    notes: s.notes,
    productCount: s.product_count,
    feedCount: s.feed_count,
    deliveryMode: s.delivery_mode === 'flat' ? 'flat' : 'store',
    deliveryFeeCents: s.delivery_fee_cents || 0,
    deliveryCostCents: s.delivery_cost_cents ?? null,
    freeOverCostCents: s.free_over_cost_cents ?? null,
    publicLabel: s.public_label || '',
    collectionEnabled: Boolean(s.collection_enabled),
    collectionAddress: s.collection_address || '',
    collectionHours: s.collection_hours || '',
    collectionRequirements: s.collection_requirements || '',
    collectionLeadText: s.collection_lead_text || '',
    ownCourierEnabled: Boolean(s.own_courier_enabled),
    // Vendor details. The portal password itself is never sent in lists --
    // only whether one is saved (GET /suppliers/:id/portal-password reveals it).
    address: s.address || '',
    website: s.website || '',
    orderProcess: s.order_process || '',
    portalUsername: s.portal_username || '',
    hasPortalPassword: Boolean(s.portal_password_enc),
    hasApiToken: Boolean(s.api_token_enc),
    hasApiKey: Boolean(s.api_key_enc),
  };
}

export function supplierPortalPassword(id, db = getDb()) {
  const row = db.prepare('SELECT name, portal_password_enc FROM suppliers WHERE id = ?').get(id);
  if (!row) return null;
  return { name: row.name, password: decryptSecret(row.portal_password_enc) };
}

export function listSuppliers(db = getDb()) {
  return db
    .prepare(`SELECT s.*, (SELECT COUNT(*) FROM products p WHERE p.supplier_id = s.id) AS product_count,
      (SELECT COUNT(*) FROM feed_items f WHERE f.supplier_id = s.id) AS feed_count FROM suppliers s ORDER BY s.name`)
    .all()
    .map(rowToSupplier);
}

const randToCents = (v) => (v === '' || v == null ? null : Math.round(Number(v) * 100));

// Fields left out of `data` keep their current value (the delivery fields were
// added later, so older callers don't wipe them).
export function saveSupplier(data, id = null, db = getDb()) {
  const name = String(data.name || '').trim();
  if (!name) throw new Error('Supplier name is required');
  const cur = id ? db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id) : null;
  if (id && !cur) return null;
  const pick = (key, col, map = (v) => String(v ?? '')) => (data[key] !== undefined ? map(data[key]) : cur ? cur[col] : map(undefined));
  const bool = (v) => (v === true || v === 1 || v === '1' || v === 'on' ? 1 : 0);
  const f = {
    name,
    contact_name: pick('contactName', 'contact_name'),
    email: pick('email', 'email'),
    phone: pick('phone', 'phone'),
    lead_time_text: pick('leadTimeText', 'lead_time_text', (v) => String(v || 'Ships from our warehouse in 2-5 business days')),
    notes: pick('notes', 'notes'),
    address: pick('address', 'address'),
    website: pick('website', 'website', (v) => String(v ?? '').trim()),
    order_process: pick('orderProcess', 'order_process'),
    portal_username: pick('portalUsername', 'portal_username', (v) => String(v ?? '').trim()),
    // Blank = keep the saved password; clearPortalPassword removes it.
    portal_password_enc: data.clearPortalPassword ? '' : data.portalPassword ? encryptSecret(String(data.portalPassword)) : cur ? cur.portal_password_enc : '',
    own_courier_enabled: pick('ownCourierEnabled', 'own_courier_enabled', bool),
    // Supplier API access (SMD): blank = keep; clearApiAccess removes both.
    api_token_enc: data.clearApiAccess ? '' : data.apiToken ? encryptSecret(String(data.apiToken).trim()) : cur ? cur.api_token_enc : '',
    api_key_enc: data.clearApiAccess ? '' : data.apiKey ? encryptSecret(String(data.apiKey).trim()) : cur ? cur.api_key_enc : '',
    delivery_mode: pick('deliveryMode', 'delivery_mode', (v) => (v === 'flat' ? 'flat' : 'store')),
    delivery_fee_cents: pick('deliveryFee', 'delivery_fee_cents', (v) => Math.max(0, randToCents(v) || 0)),
    delivery_cost_cents: pick('deliveryCost', 'delivery_cost_cents', (v) => (randToCents(v) == null ? null : Math.max(0, randToCents(v)))),
    free_over_cost_cents: pick('freeOverCost', 'free_over_cost_cents', (v) => (randToCents(v) == null ? null : Math.max(0, randToCents(v)))),
    public_label: pick('publicLabel', 'public_label'),
    collection_enabled: pick('collectionEnabled', 'collection_enabled', bool),
    collection_address: pick('collectionAddress', 'collection_address'),
    collection_hours: pick('collectionHours', 'collection_hours'),
    collection_requirements: pick('collectionRequirements', 'collection_requirements'),
    collection_lead_text: pick('collectionLeadText', 'collection_lead_text'),
    updated_at: now(),
  };
  if (f.collection_enabled && !String(f.collection_address).trim()) throw new Error('Enter the collection address, or switch collection off');
  if (f.own_courier_enabled && !String(f.collection_address).trim()) throw new Error("Enter the collection address -- the customer's courier collects there");
  if (f.website && !/^https?:\/\//i.test(f.website)) f.website = `https://${f.website}`;
  const cols = Object.keys(f).filter((k) => k !== 'updated_at');
  if (id) {
    db.prepare(`UPDATE suppliers SET ${cols.map((k) => `${k}=@${k}`).join(', ')}, updated_at=@updated_at WHERE id=@id`).run({ ...f, id });
  } else {
    id = randomUUID();
    db.prepare(`INSERT INTO suppliers (id, ${cols.join(', ')}, created_at, updated_at) VALUES (@id, ${cols.map((k) => '@' + k).join(', ')}, @updated_at, @updated_at)`).run({ ...f, id });
  }
  return listSuppliers(db).find((s) => s.id === id);
}

export function deleteSupplier(id, db = getDb()) {
  // Deleting a supplier would also delete its price-list items and leave its products without a supplier (they would
  // silently fall back to store-wide delivery): refuse while products still use it.
  const n = db.prepare('SELECT COUNT(*) n FROM products WHERE supplier_id = ?').get(id).n;
  if (n) throw new Error(`This supplier still has ${n} product${n === 1 ? '' : 's'} in the shop. Move or delete those first.`);
  return db.prepare('DELETE FROM suppliers WHERE id = ?').run(id).changes > 0;
}
