import { randomUUID } from 'crypto';
import { getDb } from './db.js';
import { getSettings } from './settings.js';
import { parseRandToCents, clampInt } from './util.js';
import { storeProductImage, copyUpload, deleteUpload } from './images.js';
import { saveProduct, repriceProducts } from './catalog.js';
import { parseFeedFile, guessMapping, normHeader, FIELDS } from './feed-parsers.js';
import { startImageDownloads } from './remote-images.js';

// Supplier feed import: any supported file (XLSX, CSV, JSON, XML, PDF) is
// parsed into tables (feed-parsers.js), previewed with an editable column
// mapping, then imported into feed_items. Listing a feed item copies it into
// the storefront catalogue.

// ------------------------------------------------------------ preview cache

// Parsed uploads are kept briefly so "Preview" and "Import" don't each need
// the file uploaded (and parsed) again. Single-process server, so a Map is fine.
const previews = new Map();
const PREVIEW_TTL_MS = 30 * 60 * 1000;

function prunePreviews() {
  const now = Date.now();
  for (const [k, v] of previews) if (now - v.createdAt > PREVIEW_TTL_MS) previews.delete(k);
  while (previews.size > 5) previews.delete(previews.keys().next().value);
}

// "... (To Be Ordered in Qty of 36)" -> 36
export function parseMinOrderQty(name) {
  const m = String(name || '').match(/qty\s*of\s*(\d+)/i);
  return m ? clampInt(m[1], 1, 10_000, 1) : 1;
}

function columnIndex(headers, header) {
  if (!header) return -1;
  const n = normHeader(header);
  return headers.findIndex((h) => normHeader(h) === n);
}

// Turns parsed tables into feed items using the admin's column mapping.
// A field set to '' in the mapping is deliberately ignored; a field missing
// from the mapping falls back to per-table auto-detection (sheets vary).
export function itemsFromTables(parsed, mapping = {}, { pricesIncludeVat = false, vatRatePct = 15 } = {}) {
  const items = [];
  const problems = { noCode: 0, noName: 0, noCost: 0 };
  for (const table of parsed.tables) {
    const guess = guessMapping(table.headers);
    const col = {};
    for (const f of FIELDS) col[f] = columnIndex(table.headers, mapping[f] === undefined ? guess[f] : mapping[f]);
    table.rows.forEach((row, i) => {
      const get = (f) => (col[f] >= 0 ? String(row[col[f]] ?? '').trim() : '');
      const code = get('code');
      const name = get('name').replace(/\s+/g, ' ');
      let costCents = parseRandToCents(get('cost'));
      if (!code) return void problems.noCode++;
      if (!name) return void problems.noName++;
      if (costCents == null || costCents <= 0) return void problems.noCost++;
      if (pricesIncludeVat) costCents = Math.round(costCents / (1 + vatRatePct / 100));
      const imageUrl = /^https?:\/\//i.test(get('image')) ? get('image') : '';
      items.push({
        code,
        name,
        // SMD workbooks: one sheet per brand, so the sheet name is a sensible fallback.
        brand: get('brand') || (parsed.format === 'xlsx' ? table.name : ''),
        category: get('category'),
        costCents,
        minOrderQty: get('moq') ? clampInt(get('moq'), 1, 10_000, 1) : parseMinOrderQty(name),
        sheet: table.name,
        imageBuffer: table.images.get(i) || null,
        imageUrl,
      });
    });
  }
  return { items, problems };
}

export async function previewFeedFile({ fileName, buffer }) {
  const parsed = await parseFeedFile(fileName, buffer);
  if (!parsed.tables.length) throw new Error('No rows found in this file');
  prunePreviews();
  const token = randomUUID();
  previews.set(token, { fileName, parsed, createdAt: Date.now() });
  // Headers across all tables, most common first (SMD: same headers on every sheet).
  const headerCount = new Map();
  for (const t of parsed.tables) for (const h of t.headers) headerCount.set(h, (headerCount.get(h) || 0) + 1);
  const headers = [...headerCount.keys()].sort((a, b) => headerCount.get(b) - headerCount.get(a));
  const mapping = guessMapping(parsed.tables[0].headers);
  return {
    token,
    fileName,
    format: parsed.format,
    warnings: parsed.warnings,
    tables: parsed.tables.map((t) => ({ name: t.name, rows: t.rows.length, images: t.images.size })),
    totalRows: parsed.tables.reduce((s, t) => s + t.rows.length, 0),
    headers,
    mapping,
    // Flyers are partial lists; everything else is assumed to be a full pricelist.
    completeListDefault: !(parsed.format === 'pdf' && parsed.warnings.some((w) => /flyer/i.test(w))),
    sample: parsed.tables[0].rows.slice(0, 5).map((r) => Object.fromEntries(parsed.tables[0].headers.map((h, i) => [h, r[i]]))),
  };
}

// Mapped result for the preview screen (re-run whenever the admin changes a column).
export function previewMapped({ token, mapping, pricesIncludeVat }) {
  const p = previews.get(token);
  if (!p) throw new Error('Preview expired — please choose the file again');
  const { items, problems } = itemsFromTables(p.parsed, mapping, { pricesIncludeVat, vatRatePct: getSettings().vatRatePct });
  return {
    usable: items.length,
    problems,
    sample: items.slice(0, 8).map(({ imageBuffer, ...it }) => ({ ...it, hasPhoto: Boolean(imageBuffer || it.imageUrl) })),
  };
}

// ------------------------------------------------------------------- import

// Upserts feed rows, pushes new costs to listed products, reprices them.
// completeList: the file is the supplier's full list, so listed products whose
// code is missing from it are marked out of stock. Off for promo flyers.
export async function importFeed({ supplierId, token, mapping, pricesIncludeVat = false, completeList = true }, db = getDb()) {
  if (!db.prepare('SELECT id FROM suppliers WHERE id = ?').get(supplierId)) throw new Error('Choose a supplier');
  const p = previews.get(token);
  if (!p) throw new Error('Preview expired — please choose the file again');
  const { items, problems } = itemsFromTables(p.parsed, mapping, { pricesIncludeVat, vatRatePct: getSettings(db).vatRatePct });
  if (!items.length) throw new Error('No usable rows. Check the column mapping: Code, Name and Cost are required.');
  const fileName = p.fileName;
  const format = p.parsed.format;

  // Embedded photos are processed outside the DB transaction (sharp is async).
  const existing = new Map(db.prepare('SELECT code, image FROM feed_items WHERE supplier_id = ?').all(supplierId).map((r) => [r.code, r.image]));
  for (const item of items) {
    item.image = existing.get(item.code) || '';
    if (!item.image && item.imageBuffer) {
      try {
        item.image = await storeProductImage(item.imageBuffer, 'feed');
      } catch {
        item.image = ''; // corrupt/unsupported embedded image -- import the row without a photo
      }
    }
  }

  const ts = new Date().toISOString();
  const stats = { format, rowsTotal: items.length, rowsNew: 0, rowsUpdated: 0, priceChanges: 0, productsRepriced: 0, productsMarkedOut: 0, imagesQueued: 0, skipped: problems };
  const changedCosts = new Map();
  const getFeed = db.prepare('SELECT id, cost_cents FROM feed_items WHERE supplier_id = ? AND code = ?');
  const insFeed = db.prepare(`INSERT INTO feed_items (id, supplier_id, code, name, brand, category, cost_cents, min_order_qty, image, image_url, image_status, source_file, source_sheet, in_latest_import, imported_at)
    VALUES (@id, @supplierId, @code, @name, @brand, @category, @cost, @moq, @image, @imageUrl, @imageStatus, @file, @sheet, 1, @ts)`);
  const updFeed = db.prepare(`UPDATE feed_items SET name = @name, brand = @brand, category = @category,
    previous_cost_cents = CASE WHEN cost_cents != @cost THEN cost_cents ELSE previous_cost_cents END,
    cost_cents = @cost, min_order_qty = @moq, image = @image, image_url = @imageUrl,
    image_status = CASE WHEN @image = '' AND @imageUrl != '' AND image_status != 'failed' THEN 'pending' ELSE image_status END,
    source_file = @file, source_sheet = @sheet, in_latest_import = 1, imported_at = @ts WHERE id = @id`);
  // Partial lists (promo flyers) carry weaker data -- guessed brands, no
  // categories -- so for items we already know they only update the cost.
  const updCostOnly = db.prepare(`UPDATE feed_items SET
    previous_cost_cents = CASE WHEN cost_cents != @cost THEN cost_cents ELSE previous_cost_cents END,
    cost_cents = @cost, imported_at = @ts WHERE id = @id`);

  const tx = db.transaction(() => {
    if (completeList) {
      // Only rows from the sheets in THIS upload get flagged as missing --
      // SMD ships three separate lists, and file names change every month.
      const sheets = [...new Set(items.map((i) => i.sheet))];
      db.prepare(`UPDATE feed_items SET in_latest_import = 0 WHERE supplier_id = ? AND source_sheet IN (${sheets.map(() => '?').join(',')})`).run(supplierId, ...sheets);
    }
    const seen = new Set();
    for (const it of items) {
      if (seen.has(it.code)) continue; // duplicate code across sheets: first wins
      seen.add(it.code);
      const row = {
        supplierId,
        code: it.code,
        name: it.name,
        brand: it.brand,
        category: it.category,
        cost: it.costCents,
        moq: it.minOrderQty,
        image: it.image,
        imageUrl: it.imageUrl,
        imageStatus: !it.image && it.imageUrl ? 'pending' : '',
        file: fileName,
        sheet: it.sheet,
        ts,
      };
      const ex = getFeed.get(supplierId, it.code);
      if (ex) {
        if (ex.cost_cents !== it.costCents) {
          stats.priceChanges++;
          changedCosts.set(it.code, it.costCents);
        }
        if (completeList) {
          updFeed.run({ ...row, id: ex.id });
          if (!it.image && it.imageUrl) stats.imagesQueued++;
        } else {
          updCostOnly.run({ cost: it.costCents, ts, id: ex.id });
        }
        stats.rowsUpdated++;
      } else {
        if (!it.image && it.imageUrl) stats.imagesQueued++;
        insFeed.run({ ...row, id: randomUUID() });
        stats.rowsNew++;
      }
    }
    const updProduct = db.prepare('UPDATE products SET cost_cents = ?, updated_at = ? WHERE supplier_id = ? AND supplier_code = ?');
    for (const [code, cost] of changedCosts) updProduct.run(cost, ts, supplierId, code);

    if (completeList) {
      // Listed items that vanished from the supplier's list can't be fulfilled --
      // stop selling them. Never auto-flips back to in-stock: an admin's manual
      // "out of stock" (e.g. supplier phoned) must survive the next import.
      stats.productsMarkedOut = db.prepare(`UPDATE products SET supplier_in_stock = 0, updated_at = @ts
        WHERE fulfilment = 'dropship' AND supplier_in_stock = 1 AND supplier_id = @s AND supplier_code IN
        (SELECT code FROM feed_items WHERE supplier_id = @s AND in_latest_import = 0)`).run({ ts, s: supplierId }).changes;
    }
  });
  tx();

  if (changedCosts.size) {
    const codes = [...changedCosts.keys()];
    const ids = db
      .prepare(`SELECT id FROM products WHERE supplier_id = ? AND supplier_code IN (${codes.map(() => '?').join(',')})`)
      .all(supplierId, ...codes)
      .map((r) => r.id);
    stats.productsRepriced = ids.length ? repriceProducts({ ids }, db) : 0;
  }

  db.prepare(`INSERT INTO feed_imports (id, supplier_id, file_name, format, rows_total, rows_new, rows_updated, price_changes, products_repriced, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), supplierId, fileName, format, stats.rowsTotal, stats.rowsNew, stats.rowsUpdated, stats.priceChanges, stats.productsRepriced, ts);
  previews.delete(token);
  if (stats.imagesQueued) startImageDownloads(db);
  return stats;
}

// Undoes an import: removes its history row plus the feed items whose most
// recent data came from it. Items touched by a later import, and items
// already listed in the shop, are kept -- products are never affected.
export function deleteImport(id, db = getDb()) {
  const imp = db.prepare('SELECT * FROM feed_imports WHERE id = ?').get(id);
  if (!imp) return null;
  const doomed = db
    .prepare(`SELECT f.id, f.image FROM feed_items f
      LEFT JOIN products p ON p.supplier_id = f.supplier_id AND p.supplier_code = f.code
      WHERE f.supplier_id = ? AND f.source_file = ? AND f.imported_at = ? AND p.id IS NULL`)
    .all(imp.supplier_id, imp.file_name, imp.created_at);
  const kept = db.prepare('SELECT COUNT(*) n FROM feed_items WHERE supplier_id = ? AND source_file = ? AND imported_at = ?')
    .get(imp.supplier_id, imp.file_name, imp.created_at).n - doomed.length;
  const tx = db.transaction(() => {
    const del = db.prepare('DELETE FROM feed_items WHERE id = ?');
    for (const f of doomed) del.run(f.id);
    db.prepare('DELETE FROM feed_imports WHERE id = ?').run(id);
  });
  tx();
  // Feed photos are only used by feed rows (listed products own copies).
  for (const f of doomed) if (f.image) deleteUpload(f.image);
  return { itemsDeleted: doomed.length, itemsKeptBecauseListed: kept };
}

// Convenience for scripts/tests: parse + import in one go with auto-mapping.
export async function importFile({ supplierId, fileName, buffer, ...opts }, db = getDb()) {
  const pv = await previewFeedFile({ fileName, buffer });
  return importFeed({ supplierId, token: pv.token, mapping: pv.mapping, completeList: pv.completeListDefault, ...opts }, db);
}

// ------------------------------------------------------------ browse/listing

export function listFeed(opts = {}, db = getDb()) {
  const where = [];
  const params = {};
  if (opts.supplierId) {
    where.push('f.supplier_id = @supplierId');
    params.supplierId = opts.supplierId;
  }
  if (opts.category) {
    where.push('f.category = @category');
    params.category = opts.category;
  }
  if (opts.brand) {
    where.push('f.brand = @brand');
    params.brand = opts.brand;
  }
  if (opts.q) {
    String(opts.q).trim().split(/\s+/).slice(0, 6).forEach((t, i) => {
      where.push(`(f.name LIKE @q${i} OR f.code LIKE @q${i} OR f.brand LIKE @q${i})`);
      params[`q${i}`] = `%${t}%`;
    });
  }
  if (opts.listed === 'yes') where.push('p.id IS NOT NULL');
  if (opts.listed === 'no') where.push('p.id IS NULL');
  if (opts.singleUnit) where.push('f.min_order_qty = 1');
  if (opts.withImage) where.push("f.image != ''");
  if (opts.changed) where.push('f.previous_cost_cents IS NOT NULL AND f.previous_cost_cents != f.cost_cents');
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = 'FROM feed_items f LEFT JOIN products p ON p.supplier_id = f.supplier_id AND p.supplier_code = f.code';
  const total = db.prepare(`SELECT COUNT(*) n ${from} ${whereSql}`).get(params).n;
  const pageSize = clampInt(opts.pageSize, 1, 200, 50);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = clampInt(opts.page, 1, pages, 1);
  const items = db
    .prepare(`SELECT f.*, p.id AS product_id, p.price_cents AS product_price_cents, p.active AS product_active ${from} ${whereSql}
      ORDER BY f.brand COLLATE NOCASE, f.name COLLATE NOCASE LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`)
    .all(params)
    .map((r) => ({
      id: r.id,
      supplierId: r.supplier_id,
      code: r.code,
      name: r.name,
      brand: r.brand,
      category: r.category,
      costCents: r.cost_cents,
      previousCostCents: r.previous_cost_cents,
      minOrderQty: r.min_order_qty,
      image: r.image,
      imageStatus: r.image_status,
      sheet: r.source_sheet,
      inLatestImport: Boolean(r.in_latest_import),
      productId: r.product_id,
      productPriceCents: r.product_price_cents,
      productActive: r.product_active == null ? null : Boolean(r.product_active),
    }));
  return { items, total, page, pages, pageSize };
}

export function feedFacets(supplierId, db = getDb()) {
  const cond = supplierId ? 'WHERE supplier_id = ?' : '';
  const args = supplierId ? [supplierId] : [];
  return {
    categories: db.prepare(`SELECT category AS name, COUNT(*) n FROM feed_items ${cond} GROUP BY category ORDER BY category`).all(...args),
    brands: db.prepare(`SELECT brand AS name, COUNT(*) n FROM feed_items ${cond} GROUP BY brand ORDER BY brand COLLATE NOCASE`).all(...args),
    imports: db.prepare('SELECT * FROM feed_imports ORDER BY created_at DESC LIMIT 10').all(),
    pendingImages: db.prepare("SELECT COUNT(*) n FROM feed_items WHERE image_status IN ('pending','downloading')").get().n,
  };
}

// Creates storefront products from feed rows. Already-listed rows are skipped.
export function listFeedItems({ feedIds, categoryId, markupPct, active = true, weightG }, db = getDb()) {
  if (!Array.isArray(feedIds) || !feedIds.length) throw new Error('Select at least one item');
  const rows = db.prepare(`SELECT * FROM feed_items WHERE id IN (${feedIds.map(() => '?').join(',')})`).all(...feedIds);
  const result = { created: 0, skipped: 0, errors: [] };
  for (const f of rows) {
    const exists = db.prepare('SELECT id FROM products WHERE supplier_id = ? AND supplier_code = ?').get(f.supplier_id, f.code);
    if (exists) {
      result.skipped++;
      continue;
    }
    try {
      const image = f.image ? copyUpload(f.image) : null;
      const sku = db.prepare('SELECT id FROM products WHERE sku = ?').get(f.code) ? `${f.code}-${f.supplier_id.slice(0, 4)}` : f.code;
      saveProduct(
        {
          sku,
          // The MOQ note is supplier-facing; keep it off the customer-facing title.
          name: f.name.replace(/\s*\((?:to be )?ordered in qty of \d+\)\s*/i, ' ').trim(),
          brand: f.brand,
          categoryId: categoryId || null,
          fulfilment: 'dropship',
          supplierId: f.supplier_id,
          supplierCode: f.code,
          costCents: f.cost_cents,
          markupPct: markupPct === '' || markupPct == null ? null : markupPct,
          priceMode: 'auto',
          minOrderQty: f.min_order_qty,
          weightG: weightG || undefined,
          images: image ? [image] : [],
          active,
        },
        null,
        db,
      );
      result.created++;
    } catch (err) {
      result.errors.push(`${f.code}: ${err.message}`);
    }
  }
  return result;
}
