import { addWithFeedback } from './site.js';
import { api, esc, getCategories } from './api.js';
import { productCard, skeletonCards, bindAddButtons } from './cards.js';
import { setHtml } from './dom.js';
import { createLoadMore } from './load-more.js';

const grid = document.getElementById('grid');
const form = document.getElementById('filters');
const known = new Map();
bindAddButtons(grid, (id) => known.get(id), (p) => addWithFeedback(p));

function state() {
  const q = new URLSearchParams(location.search);
  return {
    category: q.get('category') || '',
    q: q.get('q') || '',
    brand: q.get('brand') || '',
    sort: q.get('sort') || 'featured',
    inStock: q.get('inStock') === '1',
  };
}

// A filter change starts a fresh list (the new history entry has no batches).
function go(patch) {
  const next = { ...state(), ...patch };
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(next)) {
    if (v === '' || v === false || v == null || (k === 'sort' && v === 'featured')) continue;
    q.set(k, v === true ? '1' : String(v));
  }
  history.pushState(null, '', `/shop.html${q.toString() ? `?${q}` : ''}`);
  load();
}

function findCat(tree, slug, trail = []) {
  for (const c of tree) {
    if (c.slug === slug) return { cat: c, trail: [...trail, c] };
    const hit = findCat(c.children, slug, [...trail, c]);
    if (hit) return hit;
  }
  return null;
}

async function renderHeader(s) {
  const tree = await getCategories();
  const found = s.category ? findCat(tree, s.category) : null;
  const title = found ? found.cat.name : s.q ? `Search: “${s.q}”` : 'All products';
  document.getElementById('shop-title').textContent = title;
  document.title = `${title} — Procom Solutions`;
  // shop.html ships a canonical of /shop.html; left alone it tells Google every
  // category page is a copy of the shop, so it would drop them from search.
  const canonical = document.querySelector('link[rel="canonical"]');
  if (canonical && found) canonical.href = `${location.origin}/shop.html?category=${encodeURIComponent(found.cat.slug)}`;
  const desc = document.getElementById('shop-desc');
  desc.textContent = found?.cat.description || '';
  desc.classList.toggle('hidden', !found?.cat.description);
  const crumbs = ['<a href="/" class="hover:text-terracotta">Home</a>', '<a href="/shop.html" class="hover:text-terracotta">Shop</a>'];
  (found?.trail || []).forEach((c, i, arr) =>
    crumbs.push(i === arr.length - 1 ? `<span class="text-espresso/80">${esc(c.name)}</span>` : `<a href="/shop.html?category=${encodeURIComponent(c.slug)}" class="hover:text-terracotta">${esc(c.name)}</a>`),
  );
  setHtml(document.getElementById('crumbs'), crumbs.join(' / '));
  const children = (found ? found.cat.children : tree).filter((c) => c.productCount > 0);
  setHtml(
    document.getElementById('subcats'),
    children
      .map((c) => `<a href="/shop.html?category=${encodeURIComponent(c.slug)}" class="text-xs font-semibold border-2 border-charcoal/20 rounded-full px-4 py-1.5 hover:border-terracotta hover:text-terracotta transition-colors">${esc(c.name)} <span class="text-espresso/45">${Number(c.productCount)}</span></a>`)
      .join(''),
  );
}

const EMPTY = `<div class="col-span-full text-center py-20"><p class="font-serif text-2xl mb-2">Nothing found</p><p class="text-sm text-espresso/60 mb-6">Try a different search — or ask us, we can source most tech items.</p><a href="/contact.html" class="inline-flex bg-charcoal text-cream rounded-full px-5 py-2.5 text-sm font-semibold hover:bg-terracotta">Ask us to find it</a></div>`;

const list = createLoadMore({
  grid,
  bar: document.getElementById('load-more'),
  emptyHtml: EMPTY,
  fetchPage: (page) => {
    const s = state();
    const params = new URLSearchParams({ page, sort: s.sort, pageSize: 30 });
    if (s.category) params.set('category', s.category);
    if (s.q) params.set('q', s.q);
    if (s.brand) params.set('brand', s.brand);
    if (s.inStock) params.set('inStock', '1');
    return api(`/api/products?${params}`);
  },
  renderItems: (items) => {
    items.forEach((p) => known.set(p.id, p));
    return items.map(productCard).join('');
  },
  onFirst: (res) => {
    const s = state();
    document.getElementById('result-count').textContent = `${res.total} product${res.total === 1 ? '' : 's'}`;
    setHtml(
      form.brand,
      `<option value="">All brands</option>` + res.brands.map((b) => `<option value="${esc(b.name)}" ${b.name === s.brand ? 'selected' : ''}>${esc(b.name)} (${Number(b.count)})</option>`).join(''),
    );
  },
});

async function load() {
  const s = state();
  form.q.value = s.q;
  form.sort.value = s.sort;
  form.inStock.checked = s.inStock;
  renderHeader(s);
  setHtml(grid, skeletonCards(10));
  try {
    await list.reset();
  } catch (err) {
    setHtml(grid, `<p class="col-span-full text-terracotta">${esc(err.message)}</p>`);
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  go({ q: form.q.value.trim() });
});
form.brand.addEventListener('change', () => go({ brand: form.brand.value }));
form.sort.addEventListener('change', () => go({ sort: form.sort.value }));
form.inStock.addEventListener('change', () => go({ inStock: form.inStock.checked }));
window.addEventListener('popstate', load);
load();
