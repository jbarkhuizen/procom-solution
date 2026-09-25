import { esc, formatRand } from './api.js';

export function productUrl(p) {
  return `/product.html?p=${encodeURIComponent(p.slug)}`;
}

export function availabilityPill(p) {
  if (!p.inStock) return '<span class="pill pill-warn">Out of stock</span>';
  return p.fulfilment === 'stock' ? '<span class="pill pill-ok">In stock</span>' : '<span class="pill pill-ok">Warehouse stock</span>';
}

export function productCard(p) {
  const img = p.image
    ? `<img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy" class="w-full h-full object-contain p-4 group-hover:scale-[1.04] transition-transform duration-300">`
    : `<span class="text-espresso/35 text-[0.65rem] uppercase tracking-[0.2em]">Photo coming soon</span>`;
  const sale = p.compareAtCents && p.compareAtCents > p.priceCents;
  return `<article class="product-card group border border-charcoal/10 rounded-sm overflow-hidden hover:border-terracotta flex flex-col">
    <a href="${productUrl(p)}" class="img-wrap block aspect-square flex items-center justify-center border-b border-charcoal/10 overflow-hidden relative" aria-label="View ${esc(p.name)}">
      ${img}
      ${sale ? '<span class="pill pill-sale absolute top-2 left-2">Sale</span>' : ''}
    </a>
    <div class="p-4 flex flex-col flex-1">
      ${p.brand ? `<p class="text-[0.62rem] uppercase tracking-[0.16em] text-espresso/50 font-bold mb-1">${esc(p.brand)}</p>` : ''}
      <h3 class="text-sm font-medium leading-snug mb-2 line-clamp-2"><a href="${productUrl(p)}" class="hover:text-terracotta">${esc(p.name)}</a></h3>
      <div class="mt-auto">
        <p class="mb-2"><span class="text-terracotta font-semibold">${formatRand(p.priceCents)}</span>${sale ? ` <s class="text-xs text-espresso/45">${formatRand(p.compareAtCents)}</s>` : ''}</p>
        <div class="flex items-center justify-between gap-2">
          ${availabilityPill(p)}
        </div>
        <button type="button" data-add="${esc(p.id)}" ${p.inStock ? '' : 'disabled'}
          class="w-full mt-3 text-xs font-semibold bg-charcoal text-cream rounded-full px-3 py-2 hover:bg-terracotta transition-colors disabled:opacity-40 disabled:cursor-not-allowed">${p.inStock ? (p.minOrderQty > 1 ? `Add ${p.minOrderQty} to cart` : 'Add to cart') : 'Out of stock'}</button>
      </div>
    </div>
  </article>`;
}

export function skeletonCards(n = 8) {
  return Array.from({ length: n }, () => `<div class="border border-charcoal/10 rounded-sm overflow-hidden"><div class="aspect-square skeleton rounded-none"></div><div class="p-4 space-y-2"><div class="h-3 w-1/3 skeleton"></div><div class="h-4 w-full skeleton"></div><div class="h-4 w-1/2 skeleton"></div></div></div>`).join('');
}

// One delegated listener per grid: product objects are looked up by id from `lookup`.
export function bindAddButtons(container, lookup, onAdd) {
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-add]');
    if (!btn) return;
    const p = lookup(btn.dataset.add);
    if (p) onAdd(p, btn);
  });
}
