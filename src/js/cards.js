import { esc, formatRand } from './api.js';

export function productUrl(p) {
  return `/product.html?p=${encodeURIComponent(p.slug)}`;
}

export function availabilityPill(p) {
  if (!p.inStock) return '<span class="pill pill-warn">Out of stock</span>';
  return '<span class="pill pill-ok">In stock</span>';
}

// Compact card. Supplier photos are ~113px, so the image is shown near its
// real size (.pc-img caps it) instead of being stretched into a big blurry square.
export function productCard(p) {
  const img = p.image
    ? `<img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy" class="pc-img group-hover:scale-[1.05] transition-transform duration-300">`
    : `<span class="text-espresso/35 text-[0.6rem] uppercase tracking-[0.18em]">Photo soon</span>`;
  const sale = p.compareAtCents && p.compareAtCents > p.priceCents;
  return `<article class="product-card group border border-charcoal/10 rounded-sm overflow-hidden hover:border-terracotta flex flex-col">
    <a href="${productUrl(p)}" class="img-wrap block h-36 flex items-center justify-center border-b border-charcoal/10 overflow-hidden relative" aria-label="View ${esc(p.name)}">
      ${img}
      ${sale ? '<span class="pill pill-sale absolute top-1.5 left-1.5">Sale</span>' : ''}
    </a>
    <div class="p-2.5 flex flex-col flex-1">
      ${p.brand ? `<p class="text-[0.58rem] uppercase tracking-[0.14em] text-espresso/50 font-bold leading-none mb-1">${esc(p.brand)}</p>` : ''}
      <h3 class="text-[0.8rem] font-medium leading-snug mb-1.5 line-clamp-2"><a href="${productUrl(p)}" class="hover:text-terracotta">${esc(p.name)}</a></h3>
      <div class="mt-auto">
        <div class="flex items-center justify-between gap-1.5 flex-wrap">
          <p class="leading-none"><span class="text-terracotta font-semibold text-sm">${formatRand(p.priceCents)}</span>${sale ? ` <s class="text-[0.65rem] text-espresso/45">${formatRand(p.compareAtCents)}</s>` : ''}</p>
          ${availabilityPill(p)}
        </div>
        <button type="button" data-add="${esc(p.id)}" ${p.inStock ? '' : 'disabled'}
          class="w-full mt-2 text-[0.7rem] font-semibold bg-charcoal text-cream rounded-full px-2 py-1.5 hover:bg-terracotta transition-colors disabled:opacity-40 disabled:cursor-not-allowed">${p.inStock ? (p.minOrderQty > 1 ? `Add ${p.minOrderQty} to cart` : 'Add to cart') : 'Out of stock'}</button>
      </div>
    </div>
  </article>`;
}

// Shared grid classes so shop, home and related products stay consistent.
export const GRID_CLASSES = 'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3';

export function skeletonCards(n = 10) {
  return Array.from({ length: n }, () => `<div class="border border-charcoal/10 rounded-sm overflow-hidden"><div class="h-36 skeleton rounded-none"></div><div class="p-2.5 space-y-1.5"><div class="h-2.5 w-1/3 skeleton"></div><div class="h-3.5 w-full skeleton"></div><div class="h-3.5 w-1/2 skeleton"></div></div></div>`).join('');
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
