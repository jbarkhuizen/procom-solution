// Storefront "Specials" page: products with a running special, biggest saving first.
import { addWithFeedback } from './site.js';
import { api, esc } from './api.js';
import { productCard, skeletonCards, bindAddButtons } from './cards.js';
import { setHtml } from './dom.js';

const grid = document.getElementById('grid');
const known = new Map();
bindAddButtons(grid, (id) => known.get(id), (p) => addWithFeedback(p));

const page = () => Number(new URLSearchParams(location.search).get('page')) || 1;

function renderPager(current, pages) {
  const el = document.getElementById('pager');
  if (pages <= 1) return setHtml(el, '');
  let html = current > 1 ? `<a href="#" data-page="${current - 1}" aria-label="Previous page">‹</a>` : '';
  for (let n = 1; n <= pages; n++) {
    if (pages > 7 && Math.abs(n - current) > 1 && n !== 1 && n !== pages) {
      if (!html.endsWith('<span>…</span>')) html += '<span>…</span>';
      continue;
    }
    html += n === current ? `<span class="current" aria-current="page">${n}</span>` : `<a href="#" data-page="${n}">${n}</a>`;
  }
  if (current < pages) html += `<a href="#" data-page="${current + 1}" aria-label="Next page">›</a>`;
  setHtml(el, html);
}

async function load() {
  setHtml(grid, skeletonCards(10));
  try {
    const res = await api(`/api/specials?page=${page()}&pageSize=30`);
    res.items.forEach((p) => known.set(p.id, p));
    document.getElementById('result-count').textContent = res.total ? `${res.total} product${res.total === 1 ? '' : 's'} on special` : '';
    setHtml(
      grid,
      res.items.length
        ? res.items.map(productCard).join('')
        : `<div class="col-span-full text-center py-20"><p class="font-serif text-2xl mb-2">No specials right now</p><p class="text-sm text-espresso/60 mb-6">Check back soon — or browse the full range.</p><a href="/shop.html" class="inline-flex bg-charcoal text-cream rounded-full px-5 py-2.5 text-sm font-semibold hover:bg-terracotta">Shop all products</a></div>`,
    );
    renderPager(res.page, res.pages);
  } catch (err) {
    setHtml(grid, `<p class="col-span-full text-terracotta">${esc(err.message)}</p>`);
  }
}

document.getElementById('pager').addEventListener('click', (e) => {
  const a = e.target.closest('[data-page]');
  if (!a) return;
  e.preventDefault();
  const n = Number(a.dataset.page);
  history.pushState(null, '', n > 1 ? `/specials.html?page=${n}` : '/specials.html');
  load();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
window.addEventListener('popstate', load);
load();
