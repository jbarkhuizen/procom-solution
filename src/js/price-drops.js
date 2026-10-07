// Storefront "Price drops" page: products whose price just came down, as a table
// (cards on a phone). Data: GET /api/price-drops (server/features/pricedrops.js).
// A drop leaves the list as soon as the price is back up; sold-out ones stay, greyed.
import { addWithFeedback } from './site.js';
import { api, esc, formatRand } from './api.js';
import { productUrl, bindAddButtons, shipsFromIcon } from './cards.js';
import { setHtml } from './dom.js';
import { createLoadMore } from './load-more.js';

const body = document.getElementById('grid');
const filters = document.getElementById('drop-filters');
const known = new Map();
bindAddButtons(body, (id) => known.get(id), (p) => addWithFeedback(p));

const params = () => new URLSearchParams(location.search);
const currentCategory = () => params().get('category') || '';
const currentSince = () => (params().get('since') === '24h' ? '24h' : '');
const href = (category, since) => {
  const q = new URLSearchParams();
  if (category) q.set('category', category);
  if (since) q.set('since', since);
  return `/price-drops.html${q.toString() ? `?${q}` : ''}`;
};
const chip = (label, url, active, count) =>
  `<a href="${esc(url)}" data-filter-url="${esc(url)}" ${active ? 'aria-current="true"' : ''}
    class="text-xs font-semibold border-2 rounded-full px-4 py-1.5 transition-colors ${active ? 'border-charcoal bg-charcoal text-cream' : 'border-charcoal/20 hover:border-terracotta hover:text-terracotta'}">${esc(label)}${count != null ? ` <span class="${active ? 'text-cream/70' : 'text-espresso/45'}">${Number(count)}</span>` : ''}</a>`;

function renderFilters(res) {
  const cat = currentCategory();
  const since = currentSince();
  const cats = (res.categories || []).map((c) => chip(c.name, href(c.slug, since), c.slug === cat, c.count)).join('');
  const time = `<span class="text-xs text-espresso/55 self-center ml-2">Dropped in the last:</span>${chip('24 hours', href(cat, '24h'), since === '24h')}${chip(`${res.days || 7} days`, href(cat, ''), since !== '24h')}`;
  setHtml(filters, (res.categories?.length ? chip('All', href('', since), !cat, res.allTotal ?? res.total) : '') + cats + time);
}
filters.addEventListener('click', (e) => {
  const a = e.target.closest('[data-filter-url]');
  if (!a) return;
  e.preventDefault();
  history.pushState(null, '', a.dataset.filterUrl);
  load();
});

const stockText = (p) => {
  if (p.drop.soldOut || !p.inStock) return { text: 'Sold out', cls: 'pill-warn' };
  const n = p.stockOnHand != null ? Number(p.stockOnHand) : null;
  if (n == null) return { text: 'In stock', cls: 'pill-ok' };
  return n <= 5 ? { text: `Only ${n} left`, cls: 'pill-low' } : { text: `${n} in stock`, cls: 'pill-ok' };
};

// Pack items (min order > 1) show the pack total, like the shop cards.
function row(p) {
  const pack = Math.max(1, Number(p.minOrderQty) || 1);
  const d = p.drop;
  const st = stockText(p);
  const sold = st.text === 'Sold out';
  const img = p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy">` : '<span class="text-espresso/35 text-[0.55rem] uppercase tracking-[0.15em]">Photo soon</span>';
  return `<tr class="${sold ? 'sold-out' : ''}">
    <td class="c-photo"><a href="${productUrl(p)}" class="drop-photo" tabindex="-1" aria-hidden="true">${img}</a></td>
    <td class="c-sku font-mono text-[0.7rem] text-espresso/60">${esc(p.sku || '')}</td>
    <td><a href="${productUrl(p)}" class="font-semibold hover:text-terracotta hover:underline">${esc(p.name)}</a>${pack > 1 ? `<span class="block text-[0.7rem] text-espresso/55">Sold in packs of ${pack}</span>` : ''}${p.categoryName ? `<span class="block text-[0.7rem] text-espresso/55">${esc(p.categoryName)}</span>` : ''}</td>
    <td class="num"><s class="text-espresso/50">${formatRand(d.wasCents * pack)}</s></td>
    <td class="num"><strong>${formatRand(d.nowCents * pack)}</strong>${pack > 1 ? ` <span class="text-[0.7rem] text-espresso/55">per ${pack}</span>` : ''}</td>
    <td class="num font-semibold" style="color:#2e6e46">&minus;${formatRand(d.changeCents * pack)}<br>&minus;${Number(d.changePct)}%</td>
    <td class="num"><div class="drop-stock"><span class="inline-flex items-center gap-1"><span class="pill ${st.cls}">${esc(st.text)}</span>${shipsFromIcon(p)}</span><button type="button" data-add="${esc(p.id)}" ${sold ? 'disabled' : ''}
      class="text-[0.7rem] font-semibold bg-charcoal text-cream rounded-full px-3 py-1.5 hover:bg-terracotta transition-colors disabled:opacity-40 disabled:cursor-not-allowed">${sold ? 'Sold out' : pack > 1 ? `Add ${pack} to cart` : 'Add to cart'}</button></div></td>
  </tr>`;
}

const empty = (on) => `<tr><td colspan="7" class="text-center py-16"><p class="font-serif text-2xl mb-2">${on === false ? 'Price drops are switched off right now' : 'No price drops right now'}</p><p class="text-sm text-espresso/60 mb-6">New drops appear after each supplier update — or browse the full range.</p><a href="/shop.html" class="inline-flex bg-charcoal text-cream rounded-full px-5 py-2.5 text-sm font-semibold hover:bg-terracotta">Shop all products</a></td></tr>`;

let lastOn = true;
const list = createLoadMore({
  grid: body,
  bar: document.getElementById('load-more'),
  emptyHtml: empty(true),
  noun: 'price drops',
  fetchPage: async (page) => {
    const q = new URLSearchParams({ page, pageSize: 30 });
    if (currentCategory()) q.set('category', currentCategory());
    if (currentSince()) q.set('since', currentSince());
    const res = await api(`/api/price-drops?${q}`);
    lastOn = res.on;
    return res;
  },
  renderItems: (items) => {
    items.forEach((p) => known.set(p.id, p));
    return items.map(row).join('');
  },
  onFirst: (res) => {
    document.getElementById('result-count').textContent = res.total ? `${res.total} product${res.total === 1 ? '' : 's'} shown` : '';
    renderFilters(res);
  },
});

async function load() {
  setHtml(body, `<tr><td colspan="7" class="py-10 text-center text-sm text-espresso/55">Loading…</td></tr>`);
  try {
    await list.reset();
    if (lastOn === false) setHtml(body, empty(false));
  } catch (err) {
    setHtml(body, `<tr><td colspan="7" class="text-terracotta py-6">${esc(err.message)}</td></tr>`);
  }
}

window.addEventListener('popstate', load);
load();
