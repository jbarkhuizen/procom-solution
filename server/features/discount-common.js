// Shared by promo codes and specials: the owner's margin guard, SA dates and
// category/brand targeting.
//
// MARGIN GUARD (owner rule, 2026-09-30): no discount may ever take an item
// below its cost including VAT PLUS the Payfast fee on that price. Supplier VAT
// is a cost to us (not VAT-registered), and so is the VAT on Payfast's fee.
// The fee used is the dearest payment method switched on in Financial overview
// (worst case), and its fixed part is counted per unit (a one-item order).
//   floor = ceil((cost x (1 + VAT) + fixed x feeVat) / (1 - pct x feeVat))
// `ctx` is floorContext(db); a plain number is a VAT rate with no fee (old callers, tests).

import { getFinanceSettings } from './finance.js';

export function floorCents(costCents, ctx = 15) {
  const cost = Math.max(0, Number(costCents) || 0);
  const o = typeof ctx === 'object' && ctx ? ctx : { vatRatePct: ctx };
  const vat = Number.isFinite(Number(o.vatRatePct)) ? Number(o.vatRatePct) : 15;
  // cost × (100 + vat) / 100 keeps integer VAT rates exact (no 11499.9999 -> 11500 drift).
  const withVat = Math.ceil((cost * (100 + vat)) / 100 - 1e-9) || 0; // never -0
  if (!o.fee || !cost) return withVat;
  const f = o.fee;
  return Math.ceil((withVat + f.fixedCents * f.vatFactor) / (1 - (f.pct / 100) * f.vatFactor) - 1e-9);
}

// VAT rate + worst-case Payfast fee for floorCents().
export function floorContext(db) {
  const vatRatePct = vatRate(db);
  const fees = getFinanceSettings(db).payfastFees;
  const r = fees.pricing;
  return { vatRatePct, fee: { pct: r.pct, fixedCents: r.fixedCents, vatFactor: fees.addVat ? 1 + vatRatePct / 100 : 1, name: r.name } };
}

// Room to discount one unit without going below the floor.
export const headroomCents = (unitCents, costCents, vatRatePct) => Math.max(0, (Number(unitCents) || 0) - floorCents(costCents, vatRatePct));

// Dates are whole days in South African time (UTC+2, no DST): a special
// "ending 30 Sept" runs until midnight SAST at the end of the 30th.
export function todaySast(now = Date.now()) {
  return new Date(now + 2 * 3600_000).toISOString().slice(0, 10);
}

// '' / null = no date. Accepts 'YYYY-MM-DD' (or anything starting with it).
export function normDate(value, label) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!m || Number.isNaN(Date.parse(`${m[1]}T00:00:00Z`))) throw new Error(`${label} must be a date (YYYY-MM-DD)`);
  return m[1];
}

// 'running' | 'scheduled' | 'ended' | 'off' for a row with active/starts_at/ends_at.
export function windowState(row, today = todaySast()) {
  if (!row.active) return 'off';
  if (row.starts_at && today < row.starts_at) return 'scheduled';
  if (row.ends_at && today > row.ends_at) return 'ended';
  return 'running';
}

// Map category id -> [that id + every descendant id].
export function descendantMap(db) {
  const rows = db.prepare('SELECT id, parent_id FROM categories').all();
  const children = new Map();
  for (const r of rows) {
    if (!r.parent_id) continue;
    if (!children.has(r.parent_id)) children.set(r.parent_id, []);
    children.get(r.parent_id).push(r.id);
  }
  const cache = new Map();
  const of = (rootId) => {
    if (cache.has(rootId)) return cache.get(rootId);
    const out = [rootId];
    const seen = new Set(out);
    for (let i = 0; i < out.length; i++) {
      for (const c of children.get(out[i]) || []) if (!seen.has(c)) (seen.add(c), out.push(c));
    }
    cache.set(rootId, out);
    return out;
  };
  return of;
}

export const brandKey = (b) => String(b ?? '').trim().toLowerCase();

export function vatRate(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'vatRatePct'").get();
  const n = row ? Number(JSON.parse(row.value)) : 15;
  return Number.isFinite(n) ? n : 15;
}

// Active products a category/brand/product target covers.
export function productsForTarget(db, { type, id, brand }, cols = 'p.*') {
  if (type === 'product') return db.prepare(`SELECT ${cols} FROM products p WHERE p.id = ?`).all(id);
  if (type === 'category') {
    const ids = descendantMap(db)(id);
    return db.prepare(`SELECT ${cols} FROM products p WHERE p.active = 1 AND p.category_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  }
  if (type === 'brand') return db.prepare(`SELECT ${cols} FROM products p WHERE p.active = 1 AND p.brand = ? COLLATE NOCASE`).all(String(brand).trim());
  return db.prepare(`SELECT ${cols} FROM products p WHERE p.active = 1`).all();
}

export function brandList(db) {
  return db.prepare("SELECT brand, COUNT(*) n FROM products WHERE active = 1 AND brand != '' GROUP BY brand COLLATE NOCASE ORDER BY brand COLLATE NOCASE").all().map((r) => ({ name: r.brand, count: r.n }));
}
