import { randomUUID } from 'crypto';
import { getDb } from './db.js';
import { clampInt, parseRandToCents } from './util.js';

// Same model as lapanza3d: 'auto_weight' brackets are picked by cart weight
// (Courier), 'fixed' options are named choices (PUDO Locker, Local Delivery).

function row(r) {
  return {
    id: r.id,
    name: r.name,
    optionType: r.option_type,
    category: r.category,
    minWeight: r.min_weight,
    maxWeight: r.max_weight,
    priceCents: r.price_cents,
    active: Boolean(r.active),
    sortOrder: r.sort_order,
  };
}

export function listShippingOptions({ activeOnly = false } = {}, db = getDb()) {
  return db
    .prepare(`SELECT * FROM shipping_options ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY category, sort_order, price_cents`)
    .all()
    .map(row);
}

export function getShippingOption(id, db = getDb()) {
  const r = db.prepare('SELECT * FROM shipping_options WHERE id = ?').get(id);
  return r ? row(r) : null;
}

function overlapping(db, c, excludeId) {
  if (c.option_type !== 'auto_weight' || !c.active) return null;
  const others = db.prepare("SELECT * FROM shipping_options WHERE active = 1 AND option_type = 'auto_weight' AND id != ?").all(excludeId || '');
  return others.find((o) => c.min_weight <= (o.max_weight ?? Infinity) && o.min_weight <= (c.max_weight ?? Infinity)) || null;
}

export function saveShippingOption(data, id = null, db = getDb()) {
  const existing = id ? db.prepare('SELECT * FROM shipping_options WHERE id = ?').get(id) : null;
  if (id && !existing) return null;
  const type = (data.optionType ?? existing?.option_type) === 'auto_weight' ? 'auto_weight' : 'fixed';
  const maxRaw = data.maxWeight !== undefined ? data.maxWeight : existing?.max_weight;
  const f = {
    name: String(data.name ?? existing?.name ?? '').trim() || 'Shipping option',
    option_type: type,
    category: String(data.category ?? existing?.category ?? '').trim() || (type === 'auto_weight' ? 'Courier' : 'Other'),
    min_weight: type === 'fixed' ? 0 : clampInt(data.minWeight ?? existing?.min_weight, 0, 1e7, 0),
    max_weight: type === 'fixed' || maxRaw === '' || maxRaw == null ? null : clampInt(maxRaw, 0, 1e7, null),
    price_cents: data.price !== undefined ? parseRandToCents(data.price) ?? 0 : existing?.price_cents ?? 0,
    active: (data.active ?? (existing ? Boolean(existing.active) : true)) ? 1 : 0,
    sort_order: clampInt(data.sortOrder ?? existing?.sort_order, -999, 999, 0),
    updated_at: new Date().toISOString(),
  };
  if (f.max_weight != null && f.max_weight < f.min_weight) throw new Error('Max weight must be at least min weight');
  const clash = overlapping(db, f, id);
  if (clash) throw new Error(`Weight range overlaps active option "${clash.name}"`);
  if (existing) {
    db.prepare(`UPDATE shipping_options SET name=@name, option_type=@option_type, category=@category, min_weight=@min_weight, max_weight=@max_weight,
      price_cents=@price_cents, active=@active, sort_order=@sort_order, updated_at=@updated_at WHERE id=@id`).run({ ...f, id });
  } else {
    id = randomUUID();
    db.prepare(`INSERT INTO shipping_options (id, name, option_type, category, min_weight, max_weight, price_cents, active, sort_order, created_at, updated_at)
      VALUES (@id, @name, @option_type, @category, @min_weight, @max_weight, @price_cents, @active, @sort_order, @updated_at, @updated_at)`).run({ ...f, id });
  }
  return getShippingOption(id, db);
}

export function deleteShippingOption(id, db = getDb()) {
  return db.prepare('DELETE FROM shipping_options WHERE id = ?').run(id).changes > 0;
}

// Validates a customer's chosen option against the cart weight. An
// auto_weight option is only valid if the weight falls in its bracket --
// the client could otherwise pick the cheapest bracket for a heavy cart.
export function resolveShippingForCheckout(optionId, totalWeightG, db = getDb()) {
  const opt = getShippingOption(optionId, db);
  if (!opt || !opt.active) throw new Error('Please choose a delivery option');
  if (opt.optionType === 'auto_weight') {
    const w = Number(totalWeightG) || 0;
    if (w < opt.minWeight || (opt.maxWeight != null && w > opt.maxWeight)) {
      throw new Error('That courier option does not cover the weight of your order. Please choose another delivery option.');
    }
  }
  return opt;
}
