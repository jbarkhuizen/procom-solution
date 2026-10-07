import { track } from './analytics-beacon.js';
// Browser-side cart. Holds display snapshots only -- the server re-reads every
// price and stock level at checkout, so a tampered cart can't change what's charged.
const KEY = 'procom-cart';

function read() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function write(items) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch { /* private mode: cart still works for this page */ }
  window.dispatchEvent(new CustomEvent('cart:updated', { detail: { items } }));
}

export const getCart = read;
export const cartCount = () => read().reduce((s, i) => s + i.quantity, 0);
export const cartSubtotal = () => read().reduce((s, i) => s + i.priceCents * i.quantity, 0);
export const cartWeight = () => read().reduce((s, i) => s + (i.weightG || 0) * i.quantity, 0);
export const cartNeedsDeliveryQuote = () => read().some((i) => i.quoteDelivery);

// Pack items (min_order_qty > 1, "Order in Qty of 12") are sold in whole packs
// only (owner 2026-10-06): 12, 24, 36... Rounds to the nearest whole pack,
// at least one pack, and never more whole packs than `max` units allow.
export function toWholePacks(quantity, pack = 1, max = null) {
  const n = Math.max(1, Number(pack) || 1);
  let q = Math.max(n, Math.round((Number(quantity) || 0) / n) * n);
  if (max != null) q = Math.min(q, Math.floor(max / n) * n);
  return q;
}

export function addToCart(product, quantity = 1) {
  track('add_to_cart', { productId: product.id, quantity });
  const items = read();
  const min = product.minOrderQty || 1;
  const existing = items.find((i) => i.productId === product.id);
  if (existing) existing.quantity += quantity;
  else
    items.push({
      productId: product.id,
      slug: product.slug,
      name: product.name,
      priceCents: product.priceCents,
      image: product.image || '',
      weightG: product.weightG || 0,
      minOrderQty: min,
      maxQty: product.stockQty ?? null,
      quoteDelivery: Boolean(product.quoteDelivery),
      quantity: Math.max(min, quantity),
    });
  const line = items.find((i) => i.productId === product.id);
  line.quantity = toWholePacks(line.quantity, line.minOrderQty, line.maxQty);
  write(items);
}

export function setQuantity(productId, quantity) {
  let items = read();
  const line = items.find((i) => i.productId === productId);
  if (!line) return;
  if (quantity < (line.minOrderQty || 1)) items = items.filter((i) => i.productId !== productId);
  else line.quantity = toWholePacks(Math.min(quantity, 999), line.minOrderQty, line.maxQty);
  write(items);
}

export function removeFromCart(productId) {
  write(read().filter((i) => i.productId !== productId));
}

export function clearCart() {
  write([]);
}

// Re-syncs snapshots with the live catalog (price changes, delisted items).
export async function refreshCart() {
  const items = read();
  if (!items.length) return { items, changed: false };
  const res = await fetch('/api/cart/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: items.map((i) => i.productId) }) });
  if (!res.ok) return { items, changed: false };
  const live = new Map((await res.json()).map((p) => [p.id, p]));
  let changed = false;
  let dirty = false; // snapshot differs but nothing the customer needs to be told
  const changes = []; // what the customer must be told: price up / down, sold out
  const next = [];
  for (const i of items) {
    const p = live.get(i.productId);
    if (!p || !p.inStock) {
      changed = true;
      changes.push({ kind: 'sold_out', name: i.name });
      continue;
    }
    if (p.priceCents !== i.priceCents) {
      changed = true;
      changes.push({ kind: p.priceCents > i.priceCents ? 'price_up' : 'price_down', name: p.name, from: i.priceCents, to: p.priceCents, pack: Math.max(1, i.minOrderQty || 1) });
    }
    if (Boolean(p.quoteDelivery) !== Boolean(i.quoteDelivery)) changed = true;
    if (Boolean(p.priceDrop) !== Boolean(i.priceDrop)) dirty = true;
    next.push({ ...i, name: p.name, slug: p.slug, priceCents: p.priceCents, image: p.image, weightG: p.weightG, minOrderQty: p.minOrderQty, maxQty: p.stockQty ?? null, quoteDelivery: Boolean(p.quoteDelivery), priceDrop: Boolean(p.priceDrop) });
  }
  if (changed || dirty) write(next);
  return { items: next, changed, changes };
}
