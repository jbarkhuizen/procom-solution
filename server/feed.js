import { randomUUID } from 'crypto';
import ExcelJS from 'exceljs';
import { getDb } from './db.js';
import { parseRandToCents, clampInt } from './util.js';
import { storeProductImage, copyUpload } from './images.js';
import { saveProduct, repriceProducts } from './catalog.js';

// Supplier pricelist import (SMD format, Sept 2026):
//   each brand is a sheet; header row has
//   Picture | Product Code | Name | Brand | Category | Cost Excl VAT | Index | Top
//   and product photos are embedded images anchored in the Picture column.
// Column positions are located by header text, not fixed indexes, so a
// supplier reordering columns next month doesn't silently import garbage.

const HEADER_ALIASES = {
  code: ['product code', 'code', 'sku', 'item code', 'stock code'],
  name: ['name', 'description', 'product name', 'product description'],
  brand: ['brand', 'manufacturer'],
  category: ['category', 'group'],
  cost: ['cost excl vat', 'cost', 'price excl vat', 'cost ex vat', 'dealer price', 'price'],
  picture: ['picture', 'pictures', 'image', 'photo'],
};

function cellText(cell) {
  const v = cell?.value;
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.result != null) return String(v.result);
    if (v.text != null) return String(v.text);
    return '';
  }
  return String(v);
}

function findHeader(ws) {
  const limit = Math.min(ws.rowCount, 10);
  for (let r = 1; r <= limit; r++) {
    const row = ws.getRow(r);
    const map = {};
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const t = cellText(cell).trim().toLowerCase();
      for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
        if (map[key] == null && aliases.includes(t)) map[key] = col;
      }
    });
    if (map.code && map.name && map.cost) return { row: r, cols: map };
  }
  return null;
}

// "... (To Be Ordered in Qty of 36)" -> 36
export function parseMinOrderQty(name) {
  const m = String(name || '').match(/qty\s*of\s*(\d+)/i);
  return m ? clampInt(m[1], 1, 10_000, 1) : 1;
}

export async function parseWorkbook(buffer, { withImages = true } = {}) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const items = [];
  const skipped = [];
  for (const ws of wb.worksheets) {
    const header = findHeader(ws);
    if (!header) {
      skipped.push(ws.name);
      continue;
    }
    // row number (1-based) -> image buffer, for images anchored in/next to the picture column.
    const imagesByRow = new Map();
    if (withImages) {
      const pictureCol0 = (header.cols.picture || 1) - 1;
      for (const img of ws.getImages()) {
        const tl = img.range?.tl;
        if (!tl) continue;
        const col = Math.floor(tl.nativeCol ?? tl.col ?? 0);
        if (Math.abs(col - pictureCol0) > 1) continue;
        const row = Math.floor(tl.nativeRow ?? tl.row ?? 0) + 1;
        const media = wb.getImage(Number(img.imageId));
        if (media?.buffer && !imagesByRow.has(row)) imagesByRow.set(row, media.buffer);
      }
    }
    for (let r = header.row + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const code = cellText(row.getCell(header.cols.code)).trim();
      const name = cellText(row.getCell(header.cols.name)).replace(/\s+/g, ' ').trim();
      const costCell = row.getCell(header.cols.cost).value;
      const costCents = parseRandToCents(typeof costCell === 'number' ? costCell : cellText(row.getCell(header.cols.cost)));
      if (!code || !name || costCents == null || costCents <= 0) continue;
      items.push({
        code,
        name,
        brand: header.cols.brand ? cellText(row.getCell(header.cols.brand)).trim() : ws.name,
        category: header.cols.category ? cellText(row.getCell(header.cols.category)).trim() : '',
        costCents,
        minOrderQty: parseMinOrderQty(name),
        sheet: ws.name,
        imageBuffer: imagesByRow.get(r) || null,
      });
    }
  }
  return { items, skippedSheets: skipped };
}

// Upserts feed rows, pushes new costs to listed products, reprices them.
export async function importPricelist({ supplierId, fileName, buffer }, db = getDb()) {
  if (!db.prepare('SELECT id FROM suppliers WHERE id = ?').get(supplierId)) throw new Error('Unknown supplier');
  const { items, skippedSheets } = await parseWorkbook(buffer);
  if (!items.length) throw new Error('No product rows found. Expected columns: Product Code, Name, Cost Excl VAT.');

  // Images are processed outside the DB transaction (sharp is async).
  const existingImages = new Map(db.prepare('SELECT code, image FROM feed_items WHERE supplier_id = ?').all(supplierId).map((r) => [r.code, r.image]));
  for (const item of items) {
    item.image = existingImages.get(item.code) || '';
    if (!item.image && item.imageBuffer) {
      try {
        item.image = await storeProductImage(item.imageBuffer, 'feed');
      } catch {
        item.image = ''; // corrupt/unsupported embedded image -- import the row without a photo
      }
    }
  }

  const ts = new Date().toISOString();
  const stats = { rowsTotal: items.length, rowsNew: 0, rowsUpdated: 0, priceChanges: 0, productsRepriced: 0, skippedSheets };
  const changedCosts = new Map();
  const getFeed = db.prepare('SELECT id, cost_cents FROM feed_items WHERE supplier_id = ? AND code = ?');
  const insFeed = db.prepare(`INSERT INTO feed_items (id, supplier_id, code, name, brand, category, cost_cents, min_order_qty, image, source_file, source_sheet, in_latest_import, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`);
  const updFeed = db.prepare(`UPDATE feed_items SET name = ?, brand = ?, category = ?,
    previous_cost_cents = CASE WHEN cost_cents != ? THEN cost_cents ELSE previous_cost_cents END,
    cost_cents = ?, min_order_qty = ?, image = ?, source_file = ?, source_sheet = ?, in_latest_import = 1, imported_at = ? WHERE id = ?`);

  const tx = db.transaction(() => {
    // Only rows from the sheets (brands) in THIS upload get flagged as missing --
    // SMD ships three separate lists, and file names change every month.
    const sheets = [...new Set(items.map((i) => i.sheet))];
    db.prepare(`UPDATE feed_items SET in_latest_import = 0 WHERE supplier_id = ? AND source_sheet IN (${sheets.map(() => '?').join(',')})`)
      .run(supplierId, ...sheets);
    const seen = new Set();
    for (const it of items) {
      if (seen.has(it.code)) continue; // duplicate code across sheets: first wins
      seen.add(it.code);
      const ex = getFeed.get(supplierId, it.code);
      if (ex) {
        if (ex.cost_cents !== it.costCents) {
          stats.priceChanges++;
          changedCosts.set(it.code, it.costCents);
        }
        updFeed.run(it.name, it.brand, it.category, it.costCents, it.costCents, it.minOrderQty, it.image, fileName, it.sheet, ts, ex.id);
        stats.rowsUpdated++;
      } else {
        insFeed.run(randomUUID(), supplierId, it.code, it.name, it.brand, it.category, it.costCents, it.minOrderQty, it.image, fileName, it.sheet, ts);
        stats.rowsNew++;
      }
    }
    const updProduct = db.prepare('UPDATE products SET cost_cents = ?, updated_at = ? WHERE supplier_id = ? AND supplier_code = ?');
    for (const [code, cost] of changedCosts) updProduct.run(cost, ts, supplierId, code);

    // Listed items that vanished from the supplier's list can't be fulfilled --
    // stop selling them. Never auto-flips back to in-stock: an admin's manual
    // "out of stock" (e.g. supplier phoned) must survive the next import.
    stats.productsMarkedOut = db.prepare(`UPDATE products SET supplier_in_stock = 0, updated_at = @ts
      WHERE fulfilment = 'dropship' AND supplier_in_stock = 1 AND supplier_id = @s AND supplier_code IN
      (SELECT code FROM feed_items WHERE supplier_id = @s AND in_latest_import = 0)`).run({ ts, s: supplierId }).changes;
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

  db.prepare(`INSERT INTO feed_imports (id, supplier_id, file_name, rows_total, rows_new, rows_updated, price_changes, products_repriced, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), supplierId, fileName, stats.rowsTotal, stats.rowsNew, stats.rowsUpdated, stats.priceChanges, stats.productsRepriced, ts);
  return stats;
}

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
