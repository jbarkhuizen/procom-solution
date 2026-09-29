// Storefront "Specials" page: products with a running special, biggest saving first.
import { addWithFeedback } from './site.js';
import { api, esc } from './api.js';
import { productCard, skeletonCards, bindAddButtons } from './cards.js';
import { setHtml } from './dom.js';
import { createLoadMore } from './load-more.js';

const grid = document.getElementById('grid');
const known = new Map();
bindAddButtons(grid, (id) => known.get(id), (p) => addWithFeedback(p));

const EMPTY = `<div class="col-span-full text-center py-20"><p class="font-serif text-2xl mb-2">No specials right now</p><p class="text-sm text-espresso/60 mb-6">Check back soon — or browse the full range.</p><a href="/shop.html" class="inline-flex bg-charcoal text-cream rounded-full px-5 py-2.5 text-sm font-semibold hover:bg-terracotta">Shop all products</a></div>`;

const list = createLoadMore({
  grid,
  bar: document.getElementById('load-more'),
  emptyHtml: EMPTY,
  noun: 'specials',
  fetchPage: (page) => api(`/api/specials?page=${page}&pageSize=30`),
  renderItems: (items) => {
    items.forEach((p) => known.set(p.id, p));
    return items.map(productCard).join('');
  },
  onFirst: (res) => {
    document.getElementById('result-count').textContent = res.total ? `${res.total} product${res.total === 1 ? '' : 's'} on special` : '';
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
