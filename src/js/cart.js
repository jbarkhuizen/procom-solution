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

export function addToCart(product, quantity = 1) {
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
      quantity: Math.max(min, quantity),
    });
  const line = items.find((i) => i.productId === product.id);
  if (line.maxQty != null) line.quantity = Math.min(line.quantity, line.maxQty);
  write(items);
}

export function setQuantity(productId, quantity) {
  let items = read();
  const line = items.find((i) => i.productId === productId);
  if (!line) return;
  if (quantity < (line.minOrderQty || 1)) items = items.filter((i) => i.productId !== productId);
  else line.quantity = line.maxQty != null ? Math.min(quantity, line.maxQty) : Math.min(quantity, 999);
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
  const next = [];
  for (const i of items) {
    const p = live.get(i.productId);
    if (!p || !p.inStock) {
      changed = true;
      continue;
    }
    if (p.priceCents !== i.priceCents) changed = true;
    next.push({ ...i, name: p.name, slug: p.slug, priceCents: p.priceCents, image: p.image, weightG: p.weightG, minOrderQty: p.minOrderQty, maxQty: p.stockQty ?? null });
  }
  if (changed) write(next);
  return { items: next, changed };
}
