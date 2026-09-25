import { addWithFeedback } from './site.js';
import { api, esc, formatRand, getCategories } from './api.js';
import { productCard, productUrl, skeletonCards, bindAddButtons } from './cards.js';
import { setHtml } from './dom.js';

const known = new Map();
const remember = (list) => list.forEach((p) => known.set(p.id, p));

// Tile colours cycle through the lapanza3d palette.
const TILE_STYLES = ['bg-charcoal text-cream', 'bg-lime text-charcoal', 'bg-terracotta text-cream', 'bg-linen text-charcoal'];

async function renderCategories() {
  const el = document.getElementById('category-tiles');
  const cats = (await getCategories()).filter((c) => c.productCount > 0);
  if (!cats.length) {
    el.closest('section').classList.add('hidden');
    return;
  }
  setHtml(
    el,
    cats
      .map(
        (c, i) => `<a href="/shop.html?category=${encodeURIComponent(c.slug)}" class="tile cat-tile ${TILE_STYLES[i % TILE_STYLES.length]} rounded-sm p-6 min-h-[9rem] flex flex-col justify-between brutal">
        <span class="cat-count">${Number(c.productCount)} item${c.productCount === 1 ? '' : 's'}</span>
        <span class="font-serif text-xl md:text-2xl leading-tight tracking-tight">${esc(c.name)}</span>
      </a>`,
      )
      .join(''),
  );
}

async function renderFeatured() {
  const el = document.getElementById('hero-featured');
  setHtml(el, '<div class="aspect-square skeleton"></div>'.repeat(4));
  let { items } = await api('/api/products?featured=1&pageSize=4');
  if (items.length < 4) items = items.concat((await api('/api/products?sort=newest&pageSize=8')).items.filter((p) => !items.some((f) => f.id === p.id))).slice(0, 4);
  if (!items.length) {
    el.classList.add('hidden');
    return;
  }
  setHtml(
    el,
    items
      .map(
        (p) => `<a href="${productUrl(p)}" class="group bg-cream/85 border-2 border-charcoal/15 rounded-sm p-3 hover:border-terracotta transition-colors">
        <div class="aspect-square bg-white rounded-sm overflow-hidden flex items-center justify-center mb-2">${p.image ? `<img src="${esc(p.image)}" alt="${esc(p.name)}" class="w-full h-full object-contain p-3 group-hover:scale-105 transition-transform">` : ''}</div>
        <p class="text-xs font-medium leading-tight line-clamp-2 group-hover:text-terracotta">${esc(p.name)}</p>
        <p class="text-terracotta font-semibold text-sm mt-1">${formatRand(p.priceCents)}</p>
      </a>`,
      )
      .join(''),
  );
}

async function renderNew() {
  const el = document.getElementById('new-products');
  setHtml(el, skeletonCards(8));
  const { items } = await api('/api/products?sort=newest&pageSize=8');
  remember(items);
  if (!items.length) {
    setHtml(el, '<p class="text-espresso/60 col-span-full">New products are being added — check back soon.</p>');
    return;
  }
  setHtml(el, items.map(productCard).join(''));
  bindAddButtons(el, (id) => known.get(id), (p) => addWithFeedback(p));
}

renderCategories();
renderFeatured().catch(() => document.getElementById('hero-featured').classList.add('hidden'));
renderNew().catch(() => setHtml(document.getElementById('new-products'), '<p class="text-espresso/60">Could not load products right now.</p>'));
