// Storefront "Specials" page: products with a running special, biggest saving first.
import { addWithFeedback } from './site.js';
import { api, esc } from './api.js';
import { productCard, skeletonCards, bindAddButtons } from './cards.js';
import { setHtml } from './dom.js';
import { createLoadMore } from './load-more.js';

const grid = document.getElementById('grid');
const known = new Map();
bindAddButtons(grid, (id) => known.get(id), (p) => addWithFeedback(p));

// Quick filter: one chip per shop category that has specials (from /api/specials).
const catNav = document.getElementById('special-cats');
const currentCategory = () => new URLSearchParams(location.search).get('category') || '';
const chip = (slug, label, count, active) =>
  `<a href="/specials.html${slug ? `?category=${encodeURIComponent(slug)}` : ''}" data-cat="${esc(slug)}" ${active ? 'aria-current="true"' : ''}
    class="text-xs font-semibold border-2 rounded-full px-4 py-1.5 transition-colors ${active ? 'border-charcoal bg-charcoal text-cream' : 'border-charcoal/20 hover:border-terracotta hover:text-terracotta'}">${esc(label)} <span class="${active ? 'text-cream/70' : 'text-espresso/45'}">${Number(count)}</span></a>`;
function renderCategories(res) {
  const cur = currentCategory();
  if (!res.categories?.length) return setHtml(catNav, '');
  setHtml(catNav, chip('', 'All', res.allTotal ?? res.total, !cur) + res.categories.map((c) => chip(c.slug, c.name, c.count, c.slug === cur)).join(''));
}
catNav.addEventListener('click', (e) => {
  const a = e.target.closest('[data-cat]');
  if (!a) return;
  e.preventDefault();
  const slug = a.dataset.cat;
  history.pushState(null, '', slug ? `/specials.html?category=${encodeURIComponent(slug)}` : '/specials.html');
  load();
});

const EMPTY = `<div class="col-span-full text-center py-20"><p class="font-serif text-2xl mb-2">No specials right now</p><p class="text-sm text-espresso/60 mb-6">Check back soon — or browse the full range.</p><a href="/shop.html" class="inline-flex bg-charcoal text-cream rounded-full px-5 py-2.5 text-sm font-semibold hover:bg-terracotta">Shop all products</a></div>`;

const list = createLoadMore({
  grid,
  bar: document.getElementById('load-more'),
  emptyHtml: EMPTY,
  noun: 'specials',
  fetchPage: (page) => {
    const q = new URLSearchParams({ page, pageSize: 30 });
    if (currentCategory()) q.set('category', currentCategory());
    return api(`/api/specials?${q}`);
  },
  renderItems: (items) => {
    items.forEach((p) => known.set(p.id, p));
    return items.map(productCard).join('');
  },
  onFirst: (res) => {
    document.getElementById('result-count').textContent = res.total ? `${res.total} product${res.total === 1 ? '' : 's'} on special${res.category ? ` in ${res.category.name}` : ''}` : '';
    renderCategories(res);
  },
});

async function load() {
  setHtml(grid, skeletonCards(10));
  try {
    await list.reset();
  } catch (err) {
    setHtml(grid, `<p class="col-span-full text-terracotta">${esc(err.message)}</p>`);
  }
}

window.addEventListener('popstate', load);
load();
