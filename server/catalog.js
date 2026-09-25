import { randomUUID } from 'crypto';
import { getDb } from './db.js';
import { getSettings } from './settings.js';
import { effectiveMarkupPct, computeRetailCents, marginCents } from './pricing.js';
import { uniqueSlug, parseJsonArray, clampInt, parseRandToCents } from './util.js';

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
  };
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
    updated_at: now(),
  };
  if (id) {
    const res = db.prepare(`UPDATE categories SET parent_id=@parent_id, name=@name, slug=@slug, description=@description,
      markup_pct=@markup_pct, sort_order=@sort_order, active=@active, updated_at=@updated_at WHERE id=@id`).run({ ...fields, id });
    if (!res.changes) return null;
  } else {
    id = randomUUID();
    db.prepare(`INSERT INTO categories (id, parent_id, name, slug, description, markup_pct, sort_order, active, created_at, updated_at)
      VALUES (@id, @parent_id, @name, @slug, @description, @markup_pct, @sort_order, @active, @updated_at, @updated_at)`).run({ ...fields, id });
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

function rowToProduct(r, { admin = false, supplierLead = '' } = {}) {
  if (!r) return null;
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
    priceCents: r.price_cents,
    compareAtCents: r.compare_at_cents,
    weightG: r.weight_g,
    minOrderQty: r.min_order_qty,
    inStock,
    stockQty: r.fulfilment === 'stock' ? r.stock_qty : null,
    availability: !inStock ? 'Out of stock' : r.fulfilment === 'stock' ? 'In stock — ships in 1-2 business days' : supplierLead || r.lead_time_text || 'Ships from our warehouse in 2-5 business days',
    featured: Boolean(r.featured),
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
    active: Boolean(r.active),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const PRODUCT_SELECT = `
  SELECT p.*, c.name AS category_name, c.slug AS category_slug, s.name AS supplier_name, s.lead_time_text
  FROM products p
  LEFT JOIN categories c ON c.id = p.category_id
  LEFT JOIN suppliers s ON s.id = p.supplier_id`;

function withMargin(p, settings) {
  return { ...p, marginCents: marginCents(p.priceCents, p.costCents, { vatRatePct: settings.vatRatePct, vatRegistered: settings.vatRegistered }) };
}

export function getProduct(id, { admin = true } = {}, db = getDb()) {
  const row = db.prepare(`${PRODUCT_SELECT} WHERE p.id = ?`).get(id);
  if (!row) return null;
  const p = rowToProduct(row, { admin });
  return admin ? withMargin(p, getSettings(db)) : p;
}

export function getPublicProductBySlug(slug, db = getDb()) {
  const row = db.prepare(`${PRODUCT_SELECT} WHERE p.slug = ? AND p.active = 1`).get(slug);
  if (!row) return null;
  const product = rowToProduct(row);
  const breadcrumb = categoryChain(row.category_id, db).reverse().map((c) => ({ name: c.name, slug: c.slug }));
  const related = db
    .prepare(`${PRODUCT_SELECT} WHERE p.active = 1 AND p.category_id = ? AND p.id != ? ORDER BY p.featured DESC, RANDOM() LIMIT 5`)
    .all(row.category_id, row.id)
    .map((r) => rowToProduct(r));
  return { product, breadcrumb, related };
}

const SORTS = {
  featured: 'p.featured DESC, p.updated_at DESC',
  newest: 'p.created_at DESC',
  'price-asc': 'p.price_cents ASC',
  'price-desc': 'p.price_cents DESC',
  name: 'p.name COLLATE NOCASE ASC',
};

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
      where.push(`(p.name LIKE @q${i} OR p.brand LIKE @q${i} OR p.sku LIKE @q${i} OR p.supplier_code LIKE @q${i})`);
      params[`q${i}`] = `%${t}%`;
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
  const items = rows.map((r) => {
    const p = rowToProduct(r, { admin });
    return admin ? withMargin(p, settings) : p;
  });
  return { items, total, page, pages, pageSize, brands };
}

function priceFor(fields, db) {
  const settings = getSettings(db);
  const markup = effectiveMarkupPct({
    productMarkup: fields.markup_pct,
    categoryChain: categoryChain(fields.category_id, db),
    defaultMarkup: settings.defaultMarkupPct,
  });
  return computeRetailCents(fields.cost_cents, markup, settings.vatRatePct);
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

export function saveProduct(data, id = null, db = getDb()) {
  const existing = id ? db.prepare('SELECT * FROM products WHERE id = ?').get(id) : null;
  if (id && !existing) return null;
  const settings = getSettings(db);
  const name = String(data.name ?? existing?.name ?? '').trim();
  if (!name) throw new Error('Product name is required');
  const sku = String(data.sku ?? existing?.sku ?? '').trim() || `PC-${Date.now().toString(36).toUpperCase()}`;
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
    updated_at: now(),
  };
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
        changes = db.prepare(`UPDATE products SET active = 1, updated_at = ? WHERE id IN (${ph}) AND price_cents > 0`).run(ts, ...ids).changes;
        break;
      case 'deactivate':
        changes = db.prepare(`UPDATE products SET active = 0, updated_at = ? WHERE id IN (${ph})`).run(ts, ...ids).changes;
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
        changes = db.prepare(`UPDATE products SET supplier_in_stock = ?, updated_at = ? WHERE id IN (${ph})`).run(action === 'supplier-in' ? 1 : 0, ts, ...ids).changes;
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

export function listSuppliers(db = getDb()) {
  return db
    .prepare(`SELECT s.*, (SELECT COUNT(*) FROM products p WHERE p.supplier_id = s.id) AS product_count,
      (SELECT COUNT(*) FROM feed_items f WHERE f.supplier_id = s.id) AS feed_count FROM suppliers s ORDER BY s.name`)
    .all()
    .map((s) => ({
      id: s.id,
      name: s.name,
      contactName: s.contact_name,
      email: s.email,
      phone: s.phone,
      leadTimeText: s.lead_time_text,
      notes: s.notes,
      productCount: s.product_count,
      feedCount: s.feed_count,
    }));
}

export function saveSupplier(data, id = null, db = getDb()) {
  const name = String(data.name || '').trim();
  if (!name) throw new Error('Supplier name is required');
  const f = {
    name,
    contact_name: String(data.contactName || ''),
    email: String(data.email || ''),
    phone: String(data.phone || ''),
    lead_time_text: String(data.leadTimeText || 'Ships from our warehouse in 2-5 business days'),
    notes: String(data.notes || ''),
    updated_at: now(),
  };
  if (id) {
    if (!db.prepare(`UPDATE suppliers SET name=@name, contact_name=@contact_name, email=@email, phone=@phone, lead_time_text=@lead_time_text, notes=@notes, updated_at=@updated_at WHERE id=@id`).run({ ...f, id }).changes) return null;
  } else {
    id = randomUUID();
    db.prepare(`INSERT INTO suppliers (id, name, contact_name, email, phone, lead_time_text, notes, created_at, updated_at)
      VALUES (@id, @name, @contact_name, @email, @phone, @lead_time_text, @notes, @updated_at, @updated_at)`).run({ ...f, id });
  }
  return listSuppliers(db).find((s) => s.id === id);
}

export function deleteSupplier(id, db = getDb()) {
  return db.prepare('DELETE FROM suppliers WHERE id = ?').run(id).changes > 0;
}
