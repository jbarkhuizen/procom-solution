import { esc, formatRand } from './api.js';

export function productUrl(p) {
  return `/product.html?p=${encodeURIComponent(p.slug)}`;
}

// Items sold in a minimum quantity show the pack total ("R576.00 per 24") as
// the headline price, so the first amount a customer sees is what they pay.
export function packLabel(p) {
  const min = p.minOrderQty || 1;
  return min > 1 ? { total: formatRand(p.priceCents * min), per: `per ${min}`, each: `${formatRand(p.priceCents)} each` } : null;
}

function priceLine(p, sale) {
  const pack = packLabel(p);
  if (pack) {
    return `<p class="leading-tight"><span class="text-terracotta font-semibold text-sm">${pack.total}</span> <span class="text-[0.68rem] font-semibold text-espresso/70">${pack.per}</span><br><span class="text-[0.62rem] text-espresso/50">${pack.each}</span></p>`;
  }
  return `<p class="leading-none"><span class="text-terracotta font-semibold text-sm">${formatRand(p.priceCents)}</span>${sale ? ` <s class="text-[0.65rem] text-espresso/45">${formatRand(p.compareAtCents)}</s>` : ''}</p>`;
}

// Small warehouse icon: tells a customer which warehouse ships the item (a
// mixed cart ships from two). Public name only -- never the supplier's.
export function shipsFromIcon(p) {
  if (!p.shipsFrom) return '';
  const text = `Ships from our ${p.shipsFrom}`;
  return `<span class="ship-from tone-${Number(p.shipsFromTone) || 0}" title="${esc(text)}" role="img" aria-label="${esc(text)}"><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M1.5 6.2 8 2.5l6.5 3.7v7.3h-13z"/><path d="M4.5 13.5V8.5h7v5M4.5 10.8h7"/></svg></span>`;
}

// Stock pill + the warehouse it ships from (shown even when out of stock).
// Live supplier stock (SMD) shows as a number: "107 in stock" / "Only 3 left"
// (packs for pack items); suppliers without stock numbers say "In stock".
export function availabilityPill(p) {
  if (!p.inStock) return `<span class="inline-flex items-center gap-1"><span class="pill pill-warn">Out of stock</span>${shipsFromIcon(p)}</span>`;
  const n = p.stockOnHand != null ? Number(p.stockOnHand) : null;
  const low = n != null && n <= 5;
  const label = n == null ? 'In stock' : low ? `Only ${n} left` : `${n} in stock`;
  return `<span class="inline-flex items-center gap-1"><span class="pill ${low ? 'pill-low' : 'pill-ok'}">${label}</span>${shipsFromIcon(p)}</span>`;
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
      ${p.sku ? `<p class="text-[0.6rem] font-mono text-espresso/50 leading-none mb-1.5 truncate" title="Stock code">${esc(p.sku)}</p>` : ''}
      <div class="mt-auto">
        <div class="flex items-center justify-between gap-1.5 flex-wrap">
          ${priceLine(p, sale)}
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
