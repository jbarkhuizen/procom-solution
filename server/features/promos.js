// Promo codes (checkout discount, never below cost incl VAT) + admin Promo codes.
//
// Ported from lapanza3d's promos.js and adapted: the client never decides a
// discount -- checkout previews it through POST /api/promo/check, and
// createOrder recomputes it through priceAdjustments(). Uses are counted from
// PAID orders only, so abandoned checkouts don't burn a limited code.
//
// Margin guard (owner rule): the discount is capped at the sum, over the lines
// the code applies to, of (unit price − cost incl VAT) × qty. Unit prices
// already include any running special, so a code on top of a special can
// only use what margin the special left.
import { randomUUID } from 'crypto';
import { getDb } from '../db.js';
import { parseRandToCents, clampInt } from '../util.js';
import { floorCents, floorContext, todaySast, normDate, windowState, descendantMap, brandKey, productsForTarget, brandList } from './discount-common.js';
import { specialPriceCents } from './specials.js';

export const KINDS = ['percent', 'fixed'];
const now = () => new Date().toISOString();
const rands = (cents) => `R${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;

// Customer-facing refusal (shown at checkout as is).
class PromoError extends Error {}

// ------------------------------------------------------------------ usage

// A code with a use limit is "reserved" by an order that is waiting for its payment for up to 20 minutes, so a burst of
// unpaid checkouts cannot all use the last few uses (audit 2026-10-08). Paid orders always count.
const RESERVE_MS = 20 * 60_000;

export function promoUses(code, db = getDb(), now = Date.now()) {
  return db
    .prepare("SELECT COUNT(*) n FROM orders WHERE promo_code = ? COLLATE NOCASE AND (payment_status = 'paid' OR (status = 'pending_payment' AND created_at >= ?))")
    .get(code, new Date(now - RESERVE_MS).toISOString()).n;
}

// jo.hn+sale@gmail.com and john@gmail.com are one mailbox: the per-customer limit compares the real address.
export function normalEmail(email) {
  const [local = '', domain = ''] = String(email || '').trim().toLowerCase().split('@');
  const base = local.split('+')[0];
  return `${/^(gmail|googlemail)\.com$/.test(domain) ? base.replace(/\./g, '') : base}@${domain}`;
}

export function promoUsesByEmail(code, email, db = getDb()) {
  const want = normalEmail(email);
  return db
    .prepare("SELECT email FROM orders WHERE promo_code = ? COLLATE NOCASE AND payment_status = 'paid'")
    .all(code)
    .filter((r) => normalEmail(r.email) === want).length;
}

function usageStats(db) {
  const out = new Map();
  const rows = db
    .prepare("SELECT promo_code code, COUNT(*) n, SUM(total_cents) revenue, SUM(discount_cents) discount FROM orders WHERE promo_code != '' AND payment_status = 'paid' GROUP BY promo_code COLLATE NOCASE")
    .all();
  for (const r of rows) out.set(r.code.toUpperCase(), { uses: r.n, revenueCents: r.revenue || 0, discountGivenCents: r.discount || 0 });
  return out;
}

// ------------------------------------------------------------------ rules

function getPromoRow(code, db) {
  const c = String(code || '').trim();
  return c ? db.prepare('SELECT * FROM promo_codes WHERE code = ? COLLATE NOCASE').get(c) : null;
}

// Does the code's category/brand restriction cover this product row?
function scopeTest(promo, db) {
  const cats = promo.category_id ? new Set(descendantMap(db)(promo.category_id)) : null;
  const brand = promo.brand ? brandKey(promo.brand) : '';
  return (p) => (!cats || cats.has(p.category_id)) && (!brand || brandKey(p.brand) === brand);
}

// The full calculation. Throws PromoError for a code the customer can't use;
// otherwise returns the capped discount (may be 0 when every eligible item is
// already at its cost floor).
export function evaluatePromo({ items = [], subtotalCents, promoCode, email = '' }, db = getDb()) {
  const promo = getPromoRow(promoCode, db);
  if (!promo || !promo.active) throw new PromoError('That promo code is not valid.');
  const state = windowState(promo, todaySast());
  if (state === 'scheduled') throw new PromoError('That promo code is not active yet.');
  if (state === 'ended') throw new PromoError('That promo code has expired.');
  if (promo.max_uses != null && promoUses(promo.code, db) >= promo.max_uses) throw new PromoError('That promo code has been fully redeemed.');
  if (promo.max_uses_per_email != null && email && promoUsesByEmail(promo.code, email, db) >= promo.max_uses_per_email) {
    throw new PromoError(promo.max_uses_per_email === 1 ? 'You have already used that promo code.' : 'You have used that promo code the maximum number of times.');
  }
  const subtotal = subtotalCents ?? items.reduce((s, i) => s + i.unitCents * i.quantity, 0);
  if (subtotal < promo.min_subtotal_cents) throw new PromoError(`That code needs a minimum order of ${rands(promo.min_subtotal_cents)}.`);

  const inScope = scopeTest(promo, db);
  const eligible = items.filter((i) => i.p && inScope(i.p));
  if (!eligible.length) throw new PromoError('That promo code does not apply to the items in your cart.');
  const eligibleSubtotal = eligible.reduce((s, i) => s + i.unitCents * i.quantity, 0);
  const requested = promo.kind === 'percent' ? Math.round((eligibleSubtotal * promo.percent_off) / 100) : Math.min(promo.amount_cents, eligibleSubtotal);

  const vat = floorContext(db);
  const capCents = eligible.reduce((s, i) => s + Math.max(0, i.unitCents - floorCents(i.p.cost_cents, vat)) * i.quantity, 0);
  const discountCents = Math.max(0, Math.min(requested, capCents, subtotal));
  return { code: promo.code, promo, requestedCents: requested, capCents, discountCents, capped: discountCents < requested };
}

// Core hook, called by createOrder.
export function priceAdjustments({ items, subtotalCents, promoCode, email }, db = getDb()) {
  if (!String(promoCode || '').trim()) return { discountCents: 0, promoCode: '' };
  const r = evaluatePromo({ items, subtotalCents, promoCode, email }, db);
  return { discountCents: r.discountCents, promoCode: r.code };
}

// Public preview for checkout: same rules, cart given as product ids.
export function checkPromo({ code, items, email } = {}, db = getDb()) {
  const promoCode = String(code || '').trim().slice(0, 40);
  if (!promoCode) return { ok: false, code: '', discountCents: 0, message: 'Enter a promo code.' };
  const lines = [];
  for (const it of Array.isArray(items) ? items.slice(0, 100) : []) {
    const p = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(String(it?.productId || ''));
    if (!p) continue;
    const quantity = clampInt(it.quantity, 1, 999, 1);
    lines.push({ p, quantity, unitCents: specialPriceCents(p, db) ?? p.price_cents });
  }
  if (!lines.length) return { ok: false, code: '', discountCents: 0, message: 'Your cart is empty.' };
  try {
    const r = evaluatePromo({ items: lines, promoCode, email: String(email || '').trim().slice(0, 200) }, db);
    if (!r.discountCents) return { ok: false, code: r.code, discountCents: 0, message: 'The items in your cart are already at their lowest price, so this code can’t take anything off.' };
    const what = r.promo.kind === 'percent' ? `${r.promo.percent_off}% off` : `${rands(r.promo.amount_cents)} off`;
    const scope = r.promo.category_id || r.promo.brand ? ' qualifying items' : '';
    return {
      ok: true,
      code: r.code,
      discountCents: r.discountCents,
      message: r.capped ? `Code ${r.code} applied — limited, as some items are already at their lowest price.` : `Code ${r.code} applied — ${what}${scope}.`,
    };
  } catch (err) {
    if (err instanceof PromoError) return { ok: false, code: '', discountCents: 0, message: err.message };
    throw err;
  }
}

// ------------------------------------------------------------------ admin CRUD

function categoryPath(db, id) {
  if (!id) return '';
  const rows = db.prepare('SELECT id, parent_id, name FROM categories').all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const names = [];
  for (let c = byId.get(id), n = 0; c && n < 10; c = byId.get(c.parent_id), n++) names.unshift(c.name);
  return names.join(' › ') || '(deleted category)';
}

function rowToPromo(r, db, stats) {
  const st = stats?.get(r.code.toUpperCase()) || { uses: 0, revenueCents: 0, discountGivenCents: 0 };
  return {
    id: r.id,
    code: r.code,
    description: r.description,
    kind: r.kind,
    percentOff: r.percent_off,
    amountCents: r.amount_cents,
    minSubtotalCents: r.min_subtotal_cents,
    categoryId: r.category_id,
    categoryName: categoryPath(db, r.category_id),
    brand: r.brand,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    maxUses: r.max_uses,
    maxUsesPerEmail: r.max_uses_per_email,
    active: Boolean(r.active),
    state: windowState(r),
    ...st,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const optInt = (v, label) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) throw new Error(`${label} must be 1 or more (blank = unlimited)`);
  return n;
};

export function normalisePromo(data = {}, db = getDb()) {
  const code = String(data.code ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,40}$/.test(code)) throw new Error('Codes are 2–40 letters, digits, dashes or underscores');
  const kind = String(data.kind || 'percent');
  if (!KINDS.includes(kind)) throw new Error('Invalid discount type');
  let percentOff = 0;
  let amountCents = 0;
  if (kind === 'percent') {
    percentOff = Number(data.percentOff);
    if (!Number.isFinite(percentOff) || percentOff <= 0 || percentOff > 90) throw new Error('Percentage off must be between 0 and 90');
    percentOff = Math.round(percentOff * 100) / 100;
  } else {
    amountCents = data.amountCents != null && data.amountCents !== '' ? Math.round(Number(data.amountCents)) : parseRandToCents(data.amount);
    if (!Number.isFinite(amountCents) || amountCents <= 0) throw new Error('Enter the rand amount off');
  }
  const minSubtotalCents = data.minSubtotalCents != null && data.minSubtotalCents !== '' ? Math.max(0, Math.round(Number(data.minSubtotalCents)) || 0) : Math.max(0, parseRandToCents(data.minSubtotal) || 0);
  const categoryId = String(data.categoryId ?? '').trim();
  if (categoryId && !db.prepare('SELECT 1 FROM categories WHERE id = ?').get(categoryId)) throw new Error('That category no longer exists');
  const brand = String(data.brand ?? '').trim().slice(0, 80);
  const startsAt = normDate(data.startsAt, 'Start date');
  const endsAt = normDate(data.endsAt, 'End date');
  if (startsAt && endsAt && endsAt < startsAt) throw new Error('The end date is before the start date');
  const active = !(data.active === false || data.active === 'false' || data.active === 0 || data.active === '0');
  return {
    code,
    description: String(data.description ?? '').trim().slice(0, 200),
    kind,
    percent_off: percentOff,
    amount_cents: amountCents,
    min_subtotal_cents: minSubtotalCents,
    category_id: categoryId,
    brand,
    starts_at: startsAt,
    ends_at: endsAt,
    max_uses: optInt(data.maxUses, 'Max uses'),
    max_uses_per_email: optInt(data.maxUsesPerEmail, 'Max uses per customer'),
    active: active ? 1 : 0,
  };
}

export function getPromo(id, db = getDb()) {
  const r = db.prepare('SELECT * FROM promo_codes WHERE id = ?').get(id);
  return r ? { ...rowToPromo(r, db, usageStats(db)), floor: floorImpact(r, db) } : null;
}

export function savePromo(data, id = null, db = getDb()) {
  const p = normalisePromo(data, db);
  const clash = getPromoRow(p.code, db);
  if (clash && clash.id !== id) throw new Error(`Code "${p.code}" already exists`);
  const ts = now();
  if (id) {
    const existing = db.prepare('SELECT * FROM promo_codes WHERE id = ?').get(id);
    if (!existing) return null;
    // Uses are counted by code on paid orders, so renaming would reset them.
    if (existing.code.toUpperCase() !== p.code && promoUses(existing.code, db) > 0) {
      throw new Error(`"${existing.code}" has been used on paid orders, so it can't be renamed — create a new code instead`);
    }
    db.prepare(`UPDATE promo_codes SET code=@code, description=@description, kind=@kind, percent_off=@percent_off, amount_cents=@amount_cents,
      min_subtotal_cents=@min_subtotal_cents, category_id=@category_id, brand=@brand, starts_at=@starts_at, ends_at=@ends_at,
      max_uses=@max_uses, max_uses_per_email=@max_uses_per_email, active=@active, updated_at=@ts WHERE id=@id`).run({ ...p, id, ts });
  } else {
    id = randomUUID();
    db.prepare(`INSERT INTO promo_codes (id, code, description, kind, percent_off, amount_cents, min_subtotal_cents, category_id, brand,
      starts_at, ends_at, max_uses, max_uses_per_email, active, created_at, updated_at)
      VALUES (@id, @code, @description, @kind, @percent_off, @amount_cents, @min_subtotal_cents, @category_id, @brand,
      @starts_at, @ends_at, @max_uses, @max_uses_per_email, @active, @ts, @ts)`).run({ ...p, id, ts });
  }
  return getPromo(id, db);
}

export function deletePromo(id, db = getDb()) {
  return db.prepare('DELETE FROM promo_codes WHERE id = ?').run(id).changes > 0;
}

// How often the cost floor would limit this code, per product in its scope
// (one unit at today's price, specials included). For a percentage code:
// products whose margin is below the percentage, and the % they can really
// get. For a rand code: products whose margin on one unit is below the amount.
export function floorImpact(promo, db = getDb()) {
  const vat = floorContext(db);
  const inScope = scopeTest(promo, db);
  const rows = productsForTarget(db, promo.category_id ? { type: 'category', id: promo.category_id } : promo.brand ? { type: 'brand', brand: promo.brand } : {}).filter(inScope);
  const caps = [];
  let fullyBlocked = 0;
  for (const p of rows) {
    const unit = specialPriceCents(p, db) ?? p.price_cents;
    if (unit <= 0) continue;
    const room = Math.max(0, unit - floorCents(p.cost_cents, vat));
    if (!room) fullyBlocked++;
    const limited = promo.kind === 'percent' ? (room / unit) * 100 < promo.percent_off : room < promo.amount_cents;
    if (limited) caps.push(promo.kind === 'percent' ? (room / unit) * 100 : room);
  }
  caps.sort((a, b) => a - b);
  const median = caps.length ? caps[Math.floor(caps.length / 2)] : null;
  return {
    products: rows.length,
    capped: caps.length,
    fullyBlocked,
    // percent: typical % actually available on the capped products; fixed: typical rand margin (cents)
    typicalCap: median == null ? null : promo.kind === 'percent' ? Math.round(median * 10) / 10 : Math.round(median),
    lowestCap: caps.length ? (promo.kind === 'percent' ? Math.round(caps[0] * 10) / 10 : Math.round(caps[0])) : null,
  };
}

export function listPromos(db = getDb()) {
  const stats = usageStats(db);
  return db
    .prepare('SELECT * FROM promo_codes ORDER BY active DESC, created_at DESC')
    .all()
    .map((r) => ({ ...rowToPromo(r, db, stats), floor: floorImpact(r, db) }));
}

// ------------------------------------------------------------------ routes

export function register({ app, admin, wrap, rateLimit }) {
  // Guessing codes is the abuse to stop: 30 checks per 15 minutes per IP.
  const promoLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many promo code attempts — please try again in a few minutes.' } });
  app.post('/api/promo/check', promoLimiter, wrap((req) => checkPromo(req.body || {})));

  admin.get('/promos', wrap(() => listPromos()));
  admin.get('/promos/options', wrap(() => ({ brands: brandList(getDb()), today: todaySast() })));
  admin.post('/promos/impact', wrap((req) => {
    const p = normalisePromo({ ...req.body, code: 'PREVIEW' });
    return floorImpact(p);
  }));
  admin.post('/promos', wrap((req) => savePromo(req.body || {})));
  admin.put('/promos/:id', wrap((req) => {
    const p = savePromo(req.body || {}, req.params.id);
    if (!p) throw Object.assign(new Error('Not found'), { status: 404 });
    return p;
  }));
  admin.delete('/promos/:id', wrap((req) => {
    if (!deletePromo(req.params.id)) throw Object.assign(new Error('Not found'), { status: 404 });
    return { ok: true };
  }));
}
