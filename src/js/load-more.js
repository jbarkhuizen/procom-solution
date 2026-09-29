// "Load more" for product grids (shop, specials) -- no page numbers. The
// first batch replaces the grid; each click appends the next batch. How many
// batches are showing is kept in history.state, so Back from a product page
// brings the same list back instead of starting over.
import { esc } from './api.js';
import { setHtml, appendHtml } from './dom.js';

const MAX_RESTORE = 10; // batches re-fetched on Back (10 x 30 = 300 products)

// fetchPage(n) -> { items, total, page, pages }; renderItems(items) -> HTML;
// onFirst(res) runs after the first batch (counts, filters, empty state).
export function createLoadMore({ grid, bar, fetchPage, renderItems, onFirst = () => {}, emptyHtml = '', noun = 'products' }) {
  let token = 0; // a newer reset() wins over a slower older request
  let page = 0;
  let pages = 0;
  let total = 0;
  let shown = 0;

  function renderBar(loading = false) {
    if (!total || page >= pages) {
      setHtml(bar, total > shown ? '' : total > 30 ? `<p class="text-xs text-espresso/55">All ${total} ${esc(noun)} shown</p>` : '');
      return;
    }
    const next = Math.min(30, total - shown);
    setHtml(
      bar,
      `<p class="text-xs text-espresso/55">Showing ${shown} of ${total} ${esc(noun)}</p>
      <button type="button" data-load-more ${loading ? 'disabled' : ''}>${loading ? 'Loading…' : `Load ${next} more`}</button>`,
    );
  }

  async function append(my) {
    const res = await fetchPage(page + 1);
    if (my !== token) return false;
    page = res.page;
    pages = res.pages;
    total = res.total;
    shown += res.items.length;
    appendHtml(grid, renderItems(res.items)); // renderItems escapes every value (cards.js)
    return res;
  }

  function remember() {
    try {
      history.replaceState({ ...(history.state || {}), batches: page }, '', location.href);
    } catch { /* ignore */ }
  }

  // Start over (new filters, first visit, Back/Forward).
  async function reset({ restore = true } = {}) {
    const my = ++token;
    page = pages = total = shown = 0;
    setHtml(bar, '');
    const want = restore ? Math.min(MAX_RESTORE, Math.max(1, Number(history.state?.batches) || 1)) : 1;
    const first = await fetchPage(1);
    if (my !== token) return;
    page = first.page;
    pages = first.pages;
    total = first.total;
    shown = first.items.length;
    setHtml(grid, first.items.length ? renderItems(first.items) : emptyHtml);
    onFirst(first);
    while (page < Math.min(want, pages)) if (!(await append(my))) return;
    remember();
    renderBar();
  }

  bar.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-load-more]')) return;
    const my = token;
    renderBar(true);
    try {
      await append(my);
      remember();
    } catch (err) {
      setHtml(bar, `<p class="text-sm text-terracotta">${esc(err.message)}</p>`);
      return;
    }
    if (my === token) renderBar();
  });

  return { reset };
}
