import { setHtml } from './dom.js';

// ============================================================== helpers

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function rand(cents) {
  const amount = (Number(cents) || 0) / 100;
  const sign = amount < 0 ? '-' : '';
  const [whole, dec] = Math.abs(amount).toFixed(2).split('.');
  return `${sign}R ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${dec}`;
}
const toRands = (cents) => (cents == null ? '' : (cents / 100).toFixed(2));
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }) : '');

class Unauthorized extends Error {}

async function api(path, { method = 'GET', body, form } = {}) {
  const res = await fetch(`/api/admin${path}`, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: form || (body ? JSON.stringify(body) : undefined),
  });
  if (res.status === 401) {
    showLogin();
    throw new Unauthorized('Please sign in');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.style.background = isError ? 'var(--danger)' : '';
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), isError ? 6000 : 3000);
}

function fail(err) {
  if (!(err instanceof Unauthorized)) toast(err.message, true);
}

// Swaps in a fresh #view element on every render: views attach delegated
// listeners to the returned root, and reusing one element would stack every
// previous screen's handlers on top of the current one.
function view(html) {
  const fresh = $('#view').cloneNode(false);
  $('#view').replaceWith(fresh);
  setHtml(fresh, html);
  return fresh;
}

function setTop(eyebrow, title, actions = '') {
  $('#top-eyebrow').textContent = eyebrow;
  $('#top-title').textContent = title;
  setHtml($('#top-actions'), actions);
  document.title = `${title} — Procom Admin`;
}

function options(list, selected, { empty } = {}) {
  return (empty != null ? `<option value="">${h(empty)}</option>` : '') + list.map((o) => `<option value="${h(o.value)}" ${String(o.value) === String(selected ?? '') ? 'selected' : ''}>${h(o.label)}</option>`).join('');
}

function pager(page, pages) {
  if (pages <= 1) return '';
  return `<div class="pager">
    <button class="btn small" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>‹ Prev</button>
    <span class="muted">Page ${page} of ${pages}</span>
    <button class="btn small" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>Next ›</button>
  </div>`;
}

// Categories are needed by several views; flattened with depth for <select>s.
let categoryCache = null;
async function categories(force = false) {
  if (!categoryCache || force) categoryCache = await api('/categories');
  return categoryCache;
}
function flattenTree(tree, depth = 0, out = []) {
  for (const c of tree) {
    out.push({ ...c, depth });
    flattenTree(c.children || [], depth + 1, out);
  }
  return out;
}
async function categoryOptions() {
  const { tree } = await categories();
  return flattenTree(tree).map((c) => ({ value: c.id, label: `${'— '.repeat(c.depth)}${c.name}` }));
}

let settingsCache = null;
async function siteSettings(force = false) {
  if (!settingsCache || force) settingsCache = await api('/settings');
  return settingsCache;
}

// ============================================================== auth

let needsSetup = false;

function showLogin() {
  $('#shell').classList.add('hidden');
  $('#view-login').classList.remove('hidden');
  $('#login-heading').textContent = needsSetup ? 'Create your admin account' : 'Admin portal';
  $('#login-intro').textContent = needsSetup
    ? 'First run — choose the username and password you will use to manage Procom Solutions. Minimum 10 characters.'
    : 'Manage products, warehouse pricelists, categories and orders.';
  $('#setup-email').classList.toggle('hidden', !needsSetup);
  $('#login-submit').textContent = needsSetup ? 'Create account' : 'Sign in';
  $('#login-form [name="password"]').setAttribute('autocomplete', needsSetup ? 'new-password' : 'current-password');
}

function showShell() {
  $('#view-login').classList.add('hidden');
  $('#shell').classList.remove('hidden');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(e.target));
  const err = $('#login-error');
  err.classList.add('hidden');
  try {
    const res = await fetch(needsSetup ? '/api/admin/setup' : '/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fd),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    needsSetup = false;
    e.target.reset();
    showShell();
    route();
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
  }
});

$('#btn-logout').addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST' });
  showLogin();
});

$('#theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('procom-admin-theme', next); } catch { /* ignore */ }
});

// ============================================================== router

const routes = {};
function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

async function route() {
  const [name = 'dashboard', ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.route === name));
  const handler = routes[name] || routes.dashboard;
  view('<div class="empty">Loading…</div>');
  try {
    await handler(...rest.map(decodeURIComponent));
  } catch (err) {
    if (!(err instanceof Unauthorized)) view(`<div class="panel error">${h(err.message)}</div>`);
  }
}

$$('.nav-btn').forEach((b) => b.addEventListener('click', () => go(`#/${b.dataset.route}`)));
window.addEventListener('hashchange', route);

// ============================================================== dashboard

routes.dashboard = async () => {
  setTop('Overview', 'Dashboard', `<button class="btn btn-primary" data-go="#/feed">Import pricelist</button><button class="btn btn-secondary" data-go="#/products/new">+ Product</button>`);
  const [s, cfg] = await Promise.all([api('/dashboard'), siteSettings()]);
  const vat = 1 + cfg.vatRatePct / 100;
  // Shipping is passed through to the courier, so it's excluded from profit.
  const landedCost = cfg.vatRegistered ? s.supplierCost30Cents : Math.round(s.supplierCost30Cents * vat);
  const productRevenue = s.revenue30Cents - s.shipping30Cents;
  const profit = (cfg.vatRegistered ? Math.round(productRevenue / vat) : productRevenue) - landedCost;
  view(`
    <div class="stats">
      <div class="stat-card"><div class="label">Orders to process</div><div class="value">${s.ordersToProcess}</div></div>
      <div class="stat-card"><div class="label">Paid orders · 30 days</div><div class="value">${s.paidOrders30}</div></div>
      <div class="stat-card"><div class="label">Revenue · 30 days</div><div class="value">${rand(s.revenue30Cents)}</div></div>
      <div class="stat-card"><div class="label">Est. gross profit · 30 days</div><div class="value">${rand(profit)}</div></div>
    </div>
    <div class="stats">
      <div class="stat-card"><div class="label">Live products</div><div class="value">${s.activeProducts}</div></div>
      <div class="stat-card"><div class="label">Hidden products</div><div class="value">${s.inactiveProducts}</div></div>
      <div class="stat-card"><div class="label">Out of stock (live)</div><div class="value">${s.outOfStock}</div></div>
      <div class="stat-card"><div class="label">Warehouse items available</div><div class="value">${s.feedItems}</div></div>
    </div>
    <div class="grid-2">
      <div class="panel">
        <div class="section-head"><h3>Recent orders</h3><button class="btn small" data-go="#/orders">All orders</button></div>
        <div class="recent-list">${
          s.recentOrders.length
            ? s.recentOrders.map((o) => `<div class="recent-item" data-go="#/orders/${h(o.id)}"><span><strong>${h(o.orderNumber)}</strong> · ${h(o.firstName)} ${h(o.lastName)}</span><span>${statusBadge(o.status)} ${rand(o.totalCents)}</span></div>`).join('')
            : '<p class="muted">No paid orders yet.</p>'
        }</div>
      </div>
      <div class="panel">
        <div class="section-head"><h3>Needs attention</h3></div>
        <div class="meta-list">
          <div><span>Unread enquiries</span><a href="#/messages">${s.unreadMessages}</a></div>
          <div><span>Products without a category</span><a href="#/products/list/__none">${s.uncategorised}</a></div>
          <div><span>Live but out of stock</span><a href="#/products">${s.outOfStock}</a></div>
          <div><span>Orders awaiting payment (30d)</span><a href="#/orders/list/pending_payment">${s.awaitingPayment}</a></div>
        </div>
        <p class="mini-help" style="margin-top:1rem">Profit estimate = product revenue − supplier cost ${cfg.vatRegistered ? '(VAT-registered: excl. VAT)' : `× ${vat.toFixed(2)} (supplier VAT absorbed)`}; delivery fees excluded.</p>
      </div>
    </div>`);
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-go]');
  if (el && !e.target.closest('input, select, a[href]:not([data-go])')) {
    e.preventDefault();
    go(el.dataset.go);
  }
});

// ============================================================== products

const productState = { q: '', category: '', status: '', fulfilment: '', page: 1, selected: new Set() };

function availability(p) {
  if (p.fulfilment === 'stock') return p.stockQty > 0 ? `<span class="badge ok">${p.stockQty} in stock</span>` : '<span class="badge bad">0 stock</span>';
  return p.supplierInStock ? '<span class="badge ok">Warehouse</span>' : '<span class="badge bad">Supplier out</span>';
}

routes.products = async (id, arg) => {
  if (id === 'new') return productEditor(null);
  if (id && id !== 'list') return productEditor(id);
  if (id === 'list' && arg) Object.assign(productState, { category: arg, page: 1 });
  setTop('Catalogue', 'Products', `<button class="btn" data-action="reprice" title="Recalculate every auto-priced product from cost + markup">Reprice all</button><button class="btn btn-primary" data-go="#/products/new">+ Product</button>`);
  const cats = await categoryOptions();
  const s = productState;
  const q = new URLSearchParams({ q: s.q, category: s.category, status: s.status, fulfilment: s.fulfilment, page: s.page });
  const res = await api(`/products?${q}`);
  const root = view(`
    <div class="toolbar">
      <input id="p-q" type="search" placeholder="Search name, brand, SKU, supplier code" value="${h(s.q)}">
      <select id="p-cat">${options([{ value: '__none', label: '(No category)' }, ...cats], s.category, { empty: 'All categories' })}</select>
      <select id="p-status">${options([{ value: 'active', label: 'Live' }, { value: 'inactive', label: 'Hidden' }], s.status, { empty: 'Any status' })}</select>
      <select id="p-ful">${options([{ value: 'dropship', label: 'Dropship' }, { value: 'stock', label: 'Own stock' }], s.fulfilment, { empty: 'Any fulfilment' })}</select>
      <span class="muted">${res.total} product${res.total === 1 ? '' : 's'}</span>
    </div>
    <div id="bulk"></div>
    <div class="panel table-wrap">
      <table class="catalog">
        <thead><tr><th class="check"><input type="checkbox" id="p-all" aria-label="Select all"></th><th></th><th>Product</th><th>Category</th><th class="num">Cost</th><th class="num">Price</th><th class="num">Margin</th><th>Availability</th><th>Status</th></tr></thead>
        <tbody>${
          res.items
            .map(
              (p) => `<tr data-id="${h(p.id)}" class="${s.selected.has(p.id) ? 'selected' : ''}">
          <td class="check"><input type="checkbox" data-sel ${s.selected.has(p.id) ? 'checked' : ''} aria-label="Select"></td>
          <td>${p.image ? `<img class="thumb" src="${h(p.image)}" alt="">` : '<div class="thumb-empty"></div>'}</td>
          <td><strong>${h(p.name)}</strong><br><span class="muted">${h(p.brand)} · ${h(p.sku)}${p.featured ? ' · ★ featured' : ''}</span></td>
          <td>${p.categoryName ? h(p.categoryName) : '<span class="badge warn">None</span>'}</td>
          <td class="num">${rand(p.costCents)}</td>
          <td class="num"><strong>${rand(p.priceCents)}</strong>${p.priceMode === 'manual' ? '<br><span class="muted">manual</span>' : ''}</td>
          <td class="num ${p.marginCents < 0 ? 'money-up' : ''}">${rand(p.marginCents)}</td>
          <td>${availability(p)}</td>
          <td>${p.active ? '<span class="badge published">Live</span>' : '<span class="badge draft">Hidden</span>'}</td>
        </tr>`,
            )
            .join('') || '<tr><td colspan="9" class="empty">No products match. Use the Warehouse feed to list items quickly.</td></tr>'
        }</tbody>
      </table>
    </div>
    ${pager(res.page, res.pages)}`);

  const renderBulk = () => {
    const n = s.selected.size;
    setHtml(
      $('#bulk', root),
      n
        ? `<div class="bulk-bar"><strong>${n} selected</strong>
        <button class="btn small" data-bulk="activate">Make live</button>
        <button class="btn small" data-bulk="deactivate">Hide</button>
        <button class="btn small" data-bulk="feature">Feature</button>
        <button class="btn small" data-bulk="unfeature">Unfeature</button>
        <button class="btn small" data-bulk="supplier-out">Supplier out</button>
        <button class="btn small" data-bulk="supplier-in">Supplier in</button>
        <select id="bulk-cat">${options(cats, '', { empty: 'Move to category…' })}</select>
        <input id="bulk-markup" type="number" min="0" max="500" step="0.5" placeholder="Markup %" style="width:7rem">
        <button class="btn small" data-bulk="set-markup">Set markup</button>
        <button class="btn small btn-danger" data-bulk="delete">Delete</button>
        <button class="btn small btn-ghost" data-bulk="clear" style="color:inherit">Clear</button></div>`
        : '',
    );
  };
  renderBulk();

  const reload = () => routes.products();
  $('#p-q', root).addEventListener('change', (e) => { s.q = e.target.value; s.page = 1; reload(); });
  $('#p-cat', root).addEventListener('change', (e) => { s.category = e.target.value; s.page = 1; reload(); });
  $('#p-status', root).addEventListener('change', (e) => { s.status = e.target.value; s.page = 1; reload(); });
  $('#p-ful', root).addEventListener('change', (e) => { s.fulfilment = e.target.value; s.page = 1; reload(); });
  $('#p-all', root).addEventListener('change', (e) => {
    res.items.forEach((p) => (e.target.checked ? s.selected.add(p.id) : s.selected.delete(p.id)));
    $$('[data-sel]', root).forEach((c) => (c.checked = e.target.checked));
    $$('tbody tr[data-id]', root).forEach((tr) => tr.classList.toggle('selected', e.target.checked));
    renderBulk();
  });
  root.addEventListener('click', async (e) => {
    const pg = e.target.closest('[data-page]');
    if (pg) { s.page = Number(pg.dataset.page); return reload(); }
    const sel = e.target.closest('[data-sel]');
    const tr = e.target.closest('tr[data-id]');
    if (sel && tr) {
      sel.checked ? s.selected.add(tr.dataset.id) : s.selected.delete(tr.dataset.id);
      tr.classList.toggle('selected', sel.checked);
      return renderBulk();
    }
    if (tr && !e.target.closest('.check')) return go(`#/products/${tr.dataset.id}`);
    const b = e.target.closest('[data-bulk]');
    if (!b) return;
    const action = b.dataset.bulk;
    if (action === 'clear') { s.selected.clear(); return reload(); }
    const ids = [...s.selected];
    let value;
    if (action === 'set-markup') value = $('#bulk-markup', root).value;
    if (action === 'delete' && !confirm(`Delete ${ids.length} product(s)? This cannot be undone.`)) return;
    try {
      const r = await api('/products/bulk', { method: 'POST', body: { ids, action, value } });
      toast(`Updated ${r.changes} product(s)`);
      if (action === 'delete') s.selected.clear();
      reload();
    } catch (err) { fail(err); }
  });
  root.addEventListener('change', async (e) => {
    if (e.target.id !== 'bulk-cat' || !e.target.value) return;
    try {
      const r = await api('/products/bulk', { method: 'POST', body: { ids: [...s.selected], action: 'set-category', value: e.target.value } });
      toast(`Moved ${r.changes} product(s)`);
      reload();
    } catch (err) { fail(err); }
  });
};

document.addEventListener('click', async (e) => {
  if (!e.target.closest('[data-action="reprice"]')) return;
  try {
    const r = await api('/products/reprice', { method: 'POST' });
    toast(`${r.changed} price(s) updated`);
    route();
  } catch (err) { fail(err); }
});

async function productEditor(id) {
  const [p, cats, suppliers, cfg] = await Promise.all([id ? api(`/products/${id}`) : null, categoryOptions(), api('/suppliers'), siteSettings()]);
  const d = p || { fulfilment: 'dropship', priceMode: 'auto', active: true, images: [], specs: [], weightG: cfg.defaultWeightG, minOrderQty: 1, supplierInStock: true, stockQty: 0 };
  let images = [...(d.images || [])];
  setTop('Catalogue', p ? 'Edit product' : 'New product', `<button class="btn" data-go="#/products">← Products</button>${p && p.active ? `<a class="btn" href="/product.html?p=${h(p.slug)}" target="_blank" rel="noopener" style="text-decoration:none;color:inherit">View on site ↗</a>` : ''}`);
  const root = view(`
  <form id="pform" class="editor-layout">
    <div class="stack gap-4">
      <div class="panel stack gap-3">
        <label class="field"><span>Product name</span><input name="name" required value="${h(d.name)}"></label>
        <div class="grid-3">
          <label class="field"><span>Brand</span><input name="brand" value="${h(d.brand)}"></label>
          <label class="field"><span>SKU</span><input name="sku" value="${h(d.sku)}" placeholder="auto if blank"></label>
          <label class="field"><span>Category</span><select name="categoryId">${options(cats, d.categoryId, { empty: '(none)' })}</select></label>
        </div>
        <label class="field"><span>Short description (shown near the price)</span><input name="shortDescription" value="${h(d.shortDescription)}" maxlength="300"></label>
        <label class="field"><span>Full description (blank line = new paragraph)</span><textarea name="description" rows="7">${h(d.description)}</textarea></label>
        <label class="field"><span>Specifications — one per line as <code>Label: value</code></span><textarea name="specs" rows="5" placeholder="Connectivity: USB-A&#10;Warranty: 12 months">${h((d.specs || []).map((s) => `${s.label}: ${s.value}`).join('\n'))}</textarea></label>
      </div>
      <div class="panel gallery-panel">
        <div class="section-head"><h3>Photos</h3><label class="btn small">Upload<input type="file" id="img-upload" accept="image/*" multiple hidden></label></div>
        <div class="gallery-thumbs" id="gallery"></div>
        <p class="mini-help">First photo is the main image. Click ◀ to move a photo earlier. Images are converted to WebP, max 1200px.</p>
      </div>
    </div>

    <div class="stack gap-4 editor-actions">
      <div class="panel stack gap-3">
        <div class="section-head"><h3>Pricing</h3></div>
        <div class="grid-2">
          <label class="field"><span>Supplier cost excl VAT (R)</span><input name="cost" type="number" step="0.01" min="0" value="${toRands(d.costCents)}"></label>
          <label class="field"><span>Markup % (blank = inherit)</span><input name="markupPct" type="number" step="0.5" min="0" max="500" value="${d.markupPct ?? ''}" placeholder="category / ${cfg.defaultMarkupPct}%"></label>
        </div>
        <label class="field"><span>Price mode</span><select name="priceMode">${options([{ value: 'auto', label: 'Automatic from cost + markup' }, { value: 'manual', label: 'Manual price' }], d.priceMode)}</select></label>
        <div class="grid-2">
          <label class="field"><span>Selling price (R)</span><input name="price" type="number" step="0.01" min="0" value="${toRands(d.priceCents)}"></label>
          <label class="field"><span>“Was” price (R, optional)</span><input name="compareAt" type="number" step="0.01" min="0" value="${toRands(d.compareAtCents)}"></label>
        </div>
        <div><span class="field-label">Customer pays</span><div class="price-preview" id="price-preview"></div><p class="mini-help" id="price-help"></p></div>
      </div>

      <div class="panel stack gap-3">
        <div class="section-head"><h3>Fulfilment</h3></div>
        <label class="field"><span>How is it fulfilled?</span><select name="fulfilment">${options([{ value: 'dropship', label: 'Dropship — warehouse ships to customer' }, { value: 'stock', label: 'Own stock — we ship it' }], d.fulfilment)}</select></label>
        <div class="grid-2">
          <label class="field"><span>Supplier</span><select name="supplierId">${options(suppliers.map((s) => ({ value: s.id, label: s.name })), d.supplierId, { empty: '(none)' })}</select></label>
          <label class="field"><span>Supplier code</span><input name="supplierCode" value="${h(d.supplierCode)}"></label>
        </div>
        <div class="grid-2">
          <label class="field" data-show="stock"><span>Stock on hand</span><input name="stockQty" type="number" min="0" value="${d.stockQty ?? 0}"></label>
          <label class="field checkbox" data-show="dropship"><input type="checkbox" name="supplierInStock" ${d.supplierInStock ? 'checked' : ''}><span>Supplier has stock</span></label>
          <label class="field"><span>Weight (g)</span><input name="weightG" type="number" min="0" value="${d.weightG ?? ''}"></label>
        </div>
        <label class="field"><span>Minimum order quantity</span><input name="minOrderQty" type="number" min="1" value="${d.minOrderQty || 1}"></label>
      </div>

      <div class="panel stack gap-2">
        <label class="field checkbox"><input type="checkbox" name="active" ${d.active ? 'checked' : ''}><span>Live on the website</span></label>
        <label class="field checkbox"><input type="checkbox" name="featured" ${d.featured ? 'checked' : ''}><span>Featured on the homepage</span></label>
        <div class="row-card-actions" style="margin-top:0.5rem">
          ${p ? '<button type="button" class="btn btn-danger" id="p-delete">Delete</button>' : '<span></span>'}
          <button type="submit" class="btn btn-primary">Save product</button>
        </div>
        ${p ? `<p class="mini-help">Updated ${h(fmtDate(p.updatedAt))}</p>` : ''}
      </div>
    </div>
  </form>`);

  const form = $('#pform', root);
  const renderGallery = () =>
    setHtml(
      $('#gallery', root),
      images.map((src, i) => `<div class="gallery-thumb" style="background:#fff"><img src="${h(src)}" alt="" style="object-fit:contain"><button type="button" class="gallery-thumb-remove" data-rm="${i}" title="Remove">×</button>${i ? `<button type="button" class="gallery-thumb-remove" style="left:2px;right:auto" data-left="${i}" title="Move earlier">◀</button>` : ''}</div>`).join('') ||
        '<p class="muted">No photos yet.</p>',
    );
  renderGallery();

  const updatePricing = () => {
    const manual = form.priceMode.value === 'manual';
    form.price.readOnly = !manual;
    form.price.style.opacity = manual ? 1 : 0.6;
    const cost = Number(form.cost.value) || 0;
    const m = form.markupPct.value === '' ? null : Number(form.markupPct.value);
    const vat = 1 + cfg.vatRatePct / 100;
    let price;
    if (manual) price = Math.round((Number(form.price.value) || 0) * 100);
    else if (m != null) price = Math.ceil((cost * vat * (1 + m / 100) * 100) / 100) * 100;
    else price = p && p.priceMode === 'auto' && Number(toRands(p.costCents)) === cost ? p.priceCents : null;
    const landed = cfg.vatRegistered ? null : Math.round(cost * vat * 100);
    setHtml($('#price-preview', root), price == null ? '<span class="muted" style="font-size:1rem">Calculated on save (inherits category markup)</span>' : h(rand(price)));
    const margin = price == null ? null : cfg.vatRegistered ? Math.round(price / vat) - Math.round(cost * 100) : price - landed;
    $('#price-help', root).textContent = [
      landed != null ? `Landed cost incl. supplier VAT: ${rand(landed)}` : 'VAT-registered: margin shown excl. VAT',
      margin != null ? `Margin: ${rand(margin)}` : '',
    ].filter(Boolean).join(' · ');
    $$('[data-show]', root).forEach((el) => el.classList.toggle('hidden', el.dataset.show !== form.fulfilment.value));
  };
  form.addEventListener('input', updatePricing);
  form.addEventListener('change', updatePricing);
  updatePricing();

  $('#img-upload', root).addEventListener('change', async (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    const fd = new FormData();
    files.forEach((f) => fd.append('images', f));
    toast(`Uploading ${files.length} photo(s)…`);
    try {
      const r = await api('/uploads/images', { method: 'POST', form: fd });
      images = images.concat(r.paths);
      renderGallery();
      toast('Uploaded — remember to save');
    } catch (err) { fail(err); }
    e.target.value = '';
  });
  $('#gallery', root).addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm]');
    const left = e.target.closest('[data-left]');
    if (rm) images.splice(Number(rm.dataset.rm), 1);
    if (left) {
      const i = Number(left.dataset.left);
      [images[i - 1], images[i]] = [images[i], images[i - 1]];
    }
    if (rm || left) renderGallery();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const body = {
      ...f,
      images,
      active: form.active.checked,
      featured: form.featured.checked,
      supplierInStock: form.supplierInStock.checked,
      compareAt: f.compareAt === '' ? null : f.compareAt,
    };
    try {
      const saved = await api(p ? `/products/${p.id}` : '/products', { method: p ? 'PUT' : 'POST', body });
      toast(`Saved — customer price ${rand(saved.priceCents)}`);
      if (!p) go(`#/products/${saved.id}`);
      else productEditor(saved.id);
    } catch (err) { fail(err); }
  });
  $('#p-delete', root)?.addEventListener('click', async () => {
    if (!confirm(`Delete “${p.name}”? This cannot be undone.`)) return;
    try {
      await api(`/products/${p.id}`, { method: 'DELETE' });
      toast('Product deleted');
      go('#/products');
    } catch (err) { fail(err); }
  });
}

// ============================================================== warehouse feed

const feedState = { supplierId: '', q: '', category: '', brand: '', listed: 'no', singleUnit: true, withImage: false, changed: false, page: 1, selected: new Set() };

routes.feed = async () => {
  setTop('Catalogue', 'Warehouse feed');
  const s = feedState;
  const [suppliers, cats, cfg] = await Promise.all([api('/suppliers'), categoryOptions(), siteSettings()]);
  if (!s.supplierId && suppliers[0]) s.supplierId = suppliers[0].id;
  const q = new URLSearchParams({ supplierId: s.supplierId, q: s.q, category: s.category, brand: s.brand, listed: s.listed, page: s.page, singleUnit: s.singleUnit ? '1' : '', withImage: s.withImage ? '1' : '', changed: s.changed ? '1' : '' });
  const [facets, res] = await Promise.all([api(`/feed/facets?supplierId=${encodeURIComponent(s.supplierId)}`), api(`/feed?${q}`)]);
  const vat = 1 + cfg.vatRatePct / 100;
  const estPrice = (cost) => Math.ceil((cost * vat * (1 + cfg.defaultMarkupPct / 100)) / 100) * 100;
  const last = facets.imports[0];

  const root = view(`
    <div class="grid-2" style="margin-bottom:1rem">
      <div class="panel stack gap-3">
        <div class="section-head"><h3>1 · Upload a supplier pricelist</h3></div>
        <p class="mini-help">SMD .xlsx files as received (Cash wholesale, Home and Beyond, Infant Essential). Photos embedded in the sheet are imported. Re-uploading next month’s list updates costs and <strong>reprices listed products automatically</strong>; listed items missing from the new list are marked out of stock.</p>
        <form id="import-form" class="grid-2" style="align-items:end">
          <label class="field"><span>Supplier</span><select name="supplierId">${options(suppliers.map((x) => ({ value: x.id, label: x.name })), s.supplierId)}</select></label>
          <label class="field"><span>Pricelist (.xlsx)</span><input type="file" name="file" accept=".xlsx" required></label>
          <button class="btn btn-primary" type="submit">Import</button>
          <span class="mini-help" id="import-status">${last ? `Last import: ${h(last.file_name)} · ${h(fmtDate(last.created_at))}` : 'No imports yet.'}</span>
        </form>
      </div>
      <div class="panel">
        <div class="section-head"><h3>Recent imports</h3></div>
        <div class="table-wrap"><table class="catalog"><thead><tr><th>File</th><th class="num">Rows</th><th class="num">New</th><th class="num">Cost changes</th><th class="num">Repriced</th></tr></thead><tbody>
          ${facets.imports.map((i) => `<tr><td>${h(i.file_name)}<br><span class="muted">${h(fmtDate(i.created_at))}</span></td><td class="num">${i.rows_total}</td><td class="num">${i.rows_new}</td><td class="num">${i.price_changes}</td><td class="num">${i.products_repriced}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">—</td></tr>'}
        </tbody></table></div>
      </div>
    </div>

    <div class="panel" style="margin-bottom:1rem">
      <div class="section-head"><h3>2 · Pick items to sell</h3><span class="muted">${res.total} match${res.total === 1 ? '' : 'es'}</span></div>
      <div class="toolbar">
        <input id="f-q" type="search" placeholder="Search name, code, brand" value="${h(s.q)}">
        <select id="f-cat">${options(facets.categories.map((c) => ({ value: c.name, label: `${c.name || '(none)'} (${c.n})` })), s.category, { empty: 'All supplier categories' })}</select>
        <select id="f-brand">${options(facets.brands.map((c) => ({ value: c.name, label: `${c.name} (${c.n})` })), s.brand, { empty: 'All brands' })}</select>
        <select id="f-listed">${options([{ value: 'no', label: 'Not listed yet' }, { value: 'yes', label: 'Already listed' }], s.listed, { empty: 'Listed + not listed' })}</select>
        <label class="field checkbox"><input type="checkbox" id="f-single" ${s.singleUnit ? 'checked' : ''}><span>Single-unit only</span></label>
        <label class="field checkbox"><input type="checkbox" id="f-img" ${s.withImage ? 'checked' : ''}><span>Has photo</span></label>
        <label class="field checkbox"><input type="checkbox" id="f-changed" ${s.changed ? 'checked' : ''}><span>Cost changed</span></label>
      </div>
      <p class="mini-help">“Single-unit only” hides items the supplier sells in minimum quantities (e.g. “order in qty of 36”). Est. price uses the site default markup of ${cfg.defaultMarkupPct}% — category or per-product markups override it once listed.</p>
    </div>

    <div id="list-bar"></div>
    <div class="panel table-wrap">
      <table class="catalog">
        <thead><tr><th class="check"><input type="checkbox" id="f-all" aria-label="Select all"></th><th></th><th>Item</th><th>Supplier category</th><th class="num">Cost excl VAT</th><th class="num">Est. price</th><th>Status</th></tr></thead>
        <tbody>${
          res.items
            .map((f) => {
              const delta = f.previousCostCents != null && f.previousCostCents !== f.costCents ? f.costCents - f.previousCostCents : 0;
              return `<tr data-id="${h(f.id)}" class="${s.selected.has(f.id) ? 'selected' : ''}">
            <td class="check">${f.productId ? '' : `<input type="checkbox" data-sel ${s.selected.has(f.id) ? 'checked' : ''} aria-label="Select">`}</td>
            <td>${f.image ? `<img class="thumb" src="${h(f.image)}" alt="" loading="lazy">` : '<div class="thumb-empty"></div>'}</td>
            <td><strong>${h(f.name)}</strong><br><span class="muted">${h(f.brand)} · ${h(f.code)}${f.minOrderQty > 1 ? ` · <span class="badge warn">MOQ ${f.minOrderQty}</span>` : ''}${f.inLatestImport ? '' : ' · <span class="badge bad">not in latest list</span>'}</span></td>
            <td>${h(f.category)}</td>
            <td class="num">${rand(f.costCents)}${delta ? `<br><span class="${delta > 0 ? 'money-up' : 'money-down'}">${delta > 0 ? '▲' : '▼'} ${rand(Math.abs(delta))}</span>` : ''}</td>
            <td class="num">${f.productId ? rand(f.productPriceCents) : rand(estPrice(f.costCents))}</td>
            <td>${f.productId ? `<a href="#/products/${h(f.productId)}" class="badge ${f.productActive ? 'published' : 'draft'}">${f.productActive ? 'Listed · live' : 'Listed · hidden'}</a>` : '<span class="badge neutral">Not listed</span>'}</td>
          </tr>`;
            })
            .join('') || '<tr><td colspan="7" class="empty">Nothing here yet — upload a pricelist above.</td></tr>'
        }</tbody>
      </table>
    </div>
    ${pager(res.page, res.pages)}`);

  const renderListBar = () => {
    const n = s.selected.size;
    setHtml(
      $('#list-bar', root),
      n
        ? `<div class="bulk-bar"><strong>${n} selected</strong>
        <select id="l-cat">${options(cats, '', { empty: 'Choose storefront category…' })}</select>
        <input id="l-markup" type="number" min="0" max="500" step="0.5" placeholder="Markup % (blank = inherit)" style="width:13rem">
        <label style="display:inline-flex;gap:0.35rem;align-items:center"><input type="checkbox" id="l-active" checked> Live immediately</label>
        <button class="btn small btn-secondary" id="l-go" style="background:var(--accent);color:#1a1612">List ${n} item${n === 1 ? '' : 's'}</button>
        <button class="btn small btn-ghost" id="l-clear" style="color:inherit">Clear</button></div>`
        : '',
    );
  };
  renderListBar();

  const reload = () => routes.feed();
  const bind = (sel, key, isCheck) =>
    $(sel, root).addEventListener('change', (e) => {
      s[key] = isCheck ? e.target.checked : e.target.value;
      s.page = 1;
      reload();
    });
  bind('#f-q', 'q');
  bind('#f-cat', 'category');
  bind('#f-brand', 'brand');
  bind('#f-listed', 'listed');
  bind('#f-single', 'singleUnit', true);
  bind('#f-img', 'withImage', true);
  bind('#f-changed', 'changed', true);

  $('#f-all', root).addEventListener('change', (e) => {
    res.items.filter((f) => !f.productId).forEach((f) => (e.target.checked ? s.selected.add(f.id) : s.selected.delete(f.id)));
    reload();
  });

  $('#import-form', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    s.supplierId = fd.get('supplierId');
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    $('#import-status', root).textContent = 'Importing… large lists with photos can take a minute.';
    try {
      const r = await api('/feed/import', { method: 'POST', form: fd });
      toast(`Imported ${r.rowsTotal} rows · ${r.rowsNew} new · ${r.priceChanges} cost changes · ${r.productsRepriced} products repriced${r.productsMarkedOut ? ` · ${r.productsMarkedOut} marked out of stock` : ''}`);
      s.page = 1;
      reload();
    } catch (err) {
      fail(err);
      btn.disabled = false;
      $('#import-status', root).textContent = '';
    }
  });

  root.addEventListener('click', async (e) => {
    const pg = e.target.closest('[data-page]');
    if (pg) { s.page = Number(pg.dataset.page); return reload(); }
    const sel = e.target.closest('[data-sel]');
    const tr = e.target.closest('tr[data-id]');
    if (sel && tr) {
      sel.checked ? s.selected.add(tr.dataset.id) : s.selected.delete(tr.dataset.id);
      tr.classList.toggle('selected', sel.checked);
      return renderListBar();
    }
    if (e.target.id === 'l-clear') { s.selected.clear(); return reload(); }
    if (e.target.id === 'l-go') {
      const categoryId = $('#l-cat', root).value;
      if (!categoryId && !confirm('List without a category? They won’t appear in the shop menu until you assign one.')) return;
      e.target.disabled = true;
      try {
        const r = await api('/feed/list', { method: 'POST', body: { feedIds: [...s.selected], categoryId, markupPct: $('#l-markup', root).value, active: $('#l-active', root).checked } });
        toast(`Listed ${r.created} product(s)${r.skipped ? ` · ${r.skipped} already listed` : ''}${r.errors.length ? ` · ${r.errors.length} failed` : ''}`);
        if (r.errors.length) console.warn(r.errors);
        s.selected.clear();
        categoryCache = null;
        reload();
      } catch (err) {
        fail(err);
        e.target.disabled = false;
      }
    }
  });
};

// ============================================================== categories

routes.categories = async () => {
  setTop('Catalogue', 'Categories', '<button class="btn btn-primary" data-cat-new>+ Category</button>');
  const [{ tree, list }, cfg] = await Promise.all([categories(true), siteSettings()]);
  const flat = flattenTree(tree);
  const root = view(`
    <div class="editor-layout">
      <div class="panel">
        <div class="section-head"><h3>Category tree</h3><span class="muted">${list.length} categories</span></div>
        ${flat.map((c) => `<div class="cat-row" style="padding-left:${0.7 + c.depth * 1.5}rem">
          <span class="name">${c.depth ? '↳ ' : ''}${h(c.name)}</span>
          ${c.markupPct != null ? `<span class="badge info">${c.markupPct}% markup</span>` : ''}
          ${c.active ? '' : '<span class="badge draft">Hidden</span>'}
          <span class="muted">${c.productCount} live</span>
          <a class="btn small" href="/shop.html?category=${h(c.slug)}" target="_blank" rel="noopener" style="text-decoration:none;color:inherit">View</a>
          <button class="btn small" data-edit="${h(c.id)}">Edit</button>
        </div>`).join('') || '<p class="empty">No categories yet.</p>'}
      </div>
      <div class="panel" id="cat-editor"><p class="muted">Select a category to edit, or add a new one. Markup set here applies to every auto-priced product inside it (and its sub-categories) unless the product overrides it. Site default: ${cfg.defaultMarkupPct}%.</p></div>
    </div>`);

  const editor = (c) => {
    const parentOpts = flat.filter((x) => !c || x.id !== c.id).map((x) => ({ value: x.id, label: `${'— '.repeat(x.depth)}${x.name}` }));
    setHtml(
      $('#cat-editor', root),
      `<form id="cform" class="stack gap-3">
        <div class="section-head"><h3>${c ? 'Edit category' : 'New category'}</h3></div>
        <label class="field"><span>Name</span><input name="name" required value="${h(c?.name)}"></label>
        <label class="field"><span>Parent</span><select name="parentId">${options(parentOpts, c?.parentId, { empty: '(top level)' })}</select></label>
        <label class="field"><span>URL slug</span><input name="slug" value="${h(c?.slug)}" placeholder="auto from name"></label>
        <label class="field"><span>Description (shown at the top of the category page)</span><textarea name="description" rows="3">${h(c?.description)}</textarea></label>
        <div class="grid-2">
          <label class="field"><span>Markup % (blank = inherit)</span><input name="markupPct" type="number" min="0" max="500" step="0.5" value="${c?.markupPct ?? ''}"></label>
          <label class="field"><span>Sort order</span><input name="sortOrder" type="number" value="${c?.sortOrder ?? 0}"></label>
        </div>
        <label class="field checkbox"><input type="checkbox" name="active" ${!c || c.active ? 'checked' : ''}><span>Visible on the website</span></label>
        <div class="row-card-actions">${c ? '<button type="button" class="btn btn-danger" id="c-del">Delete</button>' : '<span></span>'}<button class="btn btn-primary">Save</button></div>
        ${c ? '<p class="mini-help">Deleting moves its products and sub-categories up to the parent.</p>' : ''}
      </form>`,
    );
    $('#cform', root).addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = { ...Object.fromEntries(new FormData(e.target)), active: e.target.active.checked };
      try {
        await api(c ? `/categories/${c.id}` : '/categories', { method: c ? 'PUT' : 'POST', body });
        toast('Category saved');
        routes.categories();
      } catch (err) { fail(err); }
    });
    $('#c-del', root)?.addEventListener('click', async () => {
      if (!confirm(`Delete “${c.name}”?`)) return;
      try {
        await api(`/categories/${c.id}`, { method: 'DELETE' });
        toast('Category deleted');
        routes.categories();
      } catch (err) { fail(err); }
    });
  };
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-edit]');
    if (b) editor(list.find((c) => c.id === b.dataset.edit));
  });
  $('[data-cat-new]').addEventListener('click', () => editor(null));
};

// ============================================================== orders

const STATUS = {
  pending_payment: ['Awaiting payment', 'neutral'],
  paid: ['Paid — to process', 'warn'],
  ordered: ['Ordered from supplier', 'info'],
  shipped: ['Shipped', 'ok'],
  delivered: ['Delivered', 'published'],
  cancelled: ['Cancelled', 'bad'],
};
function statusBadge(s) {
  const [label, cls] = STATUS[s] || [s, 'neutral'];
  return `<span class="badge ${cls}">${h(label)}</span>`;
}

const orderState = { status: '', q: '', includeUnpaid: false, page: 1 };

routes.orders = async (id, arg) => {
  if (id && id !== 'list') return orderDetail(id);
  if (id === 'list' && arg) Object.assign(orderState, { status: arg, includeUnpaid: arg === 'pending_payment', page: 1 });
  setTop('Sales', 'Orders');
  const s = orderState;
  const res = await api(`/orders?${new URLSearchParams({ status: s.status, q: s.q, page: s.page, includeUnpaid: s.includeUnpaid ? '1' : '' })}`);
  const root = view(`
    <div class="toolbar">
      <input id="o-q" type="search" placeholder="Order #, name, email, phone" value="${h(s.q)}">
      <select id="o-status">${options(Object.entries(STATUS).map(([value, [label]]) => ({ value, label })), s.status, { empty: 'All paid / active' })}</select>
      <label class="field checkbox"><input type="checkbox" id="o-unpaid" ${s.includeUnpaid ? 'checked' : ''}><span>Include unpaid</span></label>
      <span class="muted">${res.total} order${res.total === 1 ? '' : 's'}</span>
    </div>
    <div class="panel table-wrap"><table class="catalog">
      <thead><tr><th>Order</th><th>Customer</th><th>Delivery</th><th class="num">Items</th><th class="num">Total</th><th>Status</th><th>Placed</th></tr></thead>
      <tbody>${
        res.items.map((o) => `<tr data-go="#/orders/${h(o.id)}"><td><strong>${h(o.orderNumber)}</strong></td><td>${h(o.firstName)} ${h(o.lastName)}<br><span class="muted">${h(o.email)}</span></td><td>${h(o.shippingName)}</td><td class="num">${o.itemCount}</td><td class="num">${rand(o.totalCents)}</td><td>${statusBadge(o.status)}</td><td>${h(fmtDate(o.createdAt))}</td></tr>`).join('') ||
        '<tr><td colspan="7" class="empty">No orders yet.</td></tr>'
      }</tbody></table></div>
    ${pager(res.page, res.pages)}`);
  const reload = () => routes.orders();
  $('#o-q', root).addEventListener('change', (e) => { s.q = e.target.value; s.page = 1; reload(); });
  $('#o-status', root).addEventListener('change', (e) => { s.status = e.target.value; s.page = 1; reload(); });
  $('#o-unpaid', root).addEventListener('change', (e) => { s.includeUnpaid = e.target.checked; s.page = 1; reload(); });
  root.addEventListener('click', (e) => {
    const pg = e.target.closest('[data-page]');
    if (pg) { s.page = Number(pg.dataset.page); reload(); }
  });
};

async function orderDetail(id) {
  const [o, suppliers] = await Promise.all([api(`/orders/${id}`), api('/suppliers')]);
  setTop('Sales', `Order ${o.orderNumber}`, '<button class="btn" data-go="#/orders">← Orders</button>');
  const a = o.address;
  const cost = o.items.reduce((t, i) => t + i.unitCostCents * i.quantity, 0);
  const supplierFor = (name) => suppliers.find((x) => x.name === name);
  const root = view(`
    <div class="editor-layout">
      <div class="stack gap-4">
        <div class="panel">
          <div class="section-head"><h3>Items</h3>${statusBadge(o.status)}</div>
          <div class="table-wrap"><table class="catalog"><thead><tr><th>Product</th><th>Fulfilment</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Line</th><th class="num">Unit cost</th></tr></thead><tbody>
            ${o.items.map((i) => `<tr><td><strong>${h(i.name)}</strong><br><span class="muted">${h(i.sku)}${i.supplierCode ? ` · supplier code ${h(i.supplierCode)}` : ''}</span></td><td>${i.fulfilment === 'dropship' ? `<span class="badge info">Dropship${i.supplierName ? ` · ${h(i.supplierName)}` : ''}</span>` : '<span class="badge ok">Own stock</span>'}</td><td class="num">${i.quantity}</td><td class="num">${rand(i.unitPriceCents)}</td><td class="num">${rand(i.lineTotalCents)}</td><td class="num muted">${rand(i.unitCostCents)}</td></tr>`).join('')}
          </tbody></table></div>
          <div class="meta-list" style="margin-top:1rem">
            <div><span>Subtotal</span><span>${rand(o.subtotalCents)}</span></div>
            <div><span>Delivery · ${h(o.shippingName)}</span><span>${rand(o.shippingCents)}</span></div>
            <div><span><strong>Total paid</strong></span><strong>${rand(o.totalCents)}</strong></div>
            <div><span>Supplier cost (excl VAT)</span><span>${rand(cost)}</span></div>
            <div><span>Payment</span><span>${h(o.paymentMethod === 'payfast_eft' ? 'Instant EFT' : 'Card')} · ${h(o.paymentStatus)}${o.pfPaymentId ? ` · pf ${h(o.pfPaymentId)}` : ''}</span></div>
          </div>
        </div>

        ${o.supplierSheets.length ? `<div class="panel">
          <div class="section-head"><h3>Order from supplier</h3></div>
          <p class="mini-help">Copy this to the warehouse by email or WhatsApp, then set the status to “Ordered from supplier” and record their reference.</p>
          ${o.supplierSheets.map((sh, i) => {
            const sup = supplierFor(sh.supplier);
            return `<div><strong>${h(sh.supplier)}</strong><pre class="sheet" id="sheet-${i}">${h(sh.text)}</pre>
              <div class="toolbar"><button class="btn small" data-copy="${i}">Copy</button>
              ${sup?.email ? `<a class="btn small" style="text-decoration:none;color:inherit" href="mailto:${h(sup.email)}?subject=${encodeURIComponent(`Order request ${o.orderNumber}`)}&body=${encodeURIComponent(sh.text)}">Email ${h(sup.email)}</a>` : '<span class="mini-help">Add the supplier’s email under Suppliers to email it directly.</span>'}
              ${sup?.phone ? `<a class="btn small" style="text-decoration:none;color:inherit" target="_blank" rel="noopener" href="https://api.whatsapp.com/send?phone=${h(sup.phone.replace(/\D/g, '').replace(/^0/, '27'))}&text=${encodeURIComponent(sh.text)}">WhatsApp</a>` : ''}</div></div>`;
          }).join('')}
        </div>` : ''}

        <div class="panel"><div class="section-head"><h3>History</h3></div>
          <div class="timeline">${o.events.map((ev) => `<div><time>${h(fmtDate(ev.createdAt))}</time><span>${h(ev.message)} <span class="muted">— ${h(ev.actor)}</span></span></div>`).join('')}</div>
        </div>
      </div>

      <div class="stack gap-4 editor-actions">
        <div class="panel">
          <div class="section-head"><h3>Customer</h3></div>
          <div class="meta-list">
            <div><span>Name</span><span>${h(o.firstName)} ${h(o.lastName)}</span></div>
            <div><span>Email</span><a href="mailto:${h(o.email)}">${h(o.email)}</a></div>
            <div><span>Phone</span><a href="tel:${h(o.phone)}">${h(o.phone)}</a></div>
            ${o.pudoLocker ? `<div><span>PUDO locker</span><span>${h(o.pudoLocker)}</span></div>` : ''}
            ${a.line1 ? `<div><span>Address</span><span style="text-align:right">${[a.line1, a.line2, a.suburb, a.city, a.province, a.postalCode].filter(Boolean).map(h).join('<br>')}</span></div>` : ''}
            ${o.customerNotes ? `<div><span>Notes</span><span>${h(o.customerNotes)}</span></div>` : ''}
          </div>
        </div>
        <form class="panel stack gap-3" id="oform">
          <div class="section-head"><h3>Fulfil</h3></div>
          <label class="field"><span>Status</span><select name="status">${options(Object.entries(STATUS).map(([value, [label]]) => ({ value, label })), o.status)}</select></label>
          <label class="field"><span>Supplier order reference</span><input name="supplierRef" value="${h(o.supplierRef)}"></label>
          <label class="field"><span>Tracking number</span><input name="trackingNumber" value="${h(o.trackingNumber)}"></label>
          <label class="field checkbox"><input type="checkbox" name="notifyCustomer" checked><span>Email customer when marked Shipped</span></label>
          <label class="field"><span>Internal notes</span><textarea name="adminNotes" rows="3">${h(o.adminNotes)}</textarea></label>
          <button class="btn btn-primary">Save</button>
        </form>
      </div>
    </div>`);

  root.addEventListener('click', async (e) => {
    const c = e.target.closest('[data-copy]');
    if (!c) return;
    try {
      await navigator.clipboard.writeText($(`#sheet-${c.dataset.copy}`, root).textContent);
      toast('Copied to clipboard');
    } catch { toast('Copy failed — select the text manually', true); }
  });
  $('#oform', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api(`/orders/${o.id}`, { method: 'PUT', body: { status: f.status.value, supplierRef: f.supplierRef.value, trackingNumber: f.trackingNumber.value, adminNotes: f.adminNotes.value, notifyCustomer: f.notifyCustomer.checked } });
      toast('Order updated');
      orderDetail(o.id);
    } catch (err) { fail(err); }
  });
}

// ============================================================== suppliers

routes.suppliers = async () => {
  setTop('Catalogue', 'Suppliers', '<button class="btn btn-primary" data-sup-new>+ Supplier</button>');
  const list = await api('/suppliers');
  const root = view(`<div class="editor-layout">
    <div class="panel table-wrap"><table class="catalog"><thead><tr><th>Supplier</th><th>Contact</th><th class="num">Listed</th><th class="num">In feed</th></tr></thead><tbody>
      ${list.map((s) => `<tr data-id="${h(s.id)}"><td><strong>${h(s.name)}</strong><br><span class="muted">${h(s.leadTimeText)}</span></td><td>${h(s.contactName)}<br><span class="muted">${h(s.email)} ${h(s.phone)}</span></td><td class="num">${s.productCount}</td><td class="num">${s.feedCount}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="panel" id="sup-editor"><p class="muted">Select a supplier to edit. The lead-time text is what customers see as the delivery estimate on dropshipped products.</p></div>
  </div>`);
  const editor = (s) => {
    setHtml(
      $('#sup-editor', root),
      `<form id="sform" class="stack gap-3"><div class="section-head"><h3>${s ? 'Edit supplier' : 'New supplier'}</h3></div>
      <label class="field"><span>Name</span><input name="name" required value="${h(s?.name)}"></label>
      <div class="grid-2"><label class="field"><span>Contact person</span><input name="contactName" value="${h(s?.contactName)}"></label>
      <label class="field"><span>Phone / WhatsApp</span><input name="phone" value="${h(s?.phone)}"></label></div>
      <label class="field"><span>Order email</span><input name="email" type="email" value="${h(s?.email)}"></label>
      <label class="field"><span>Customer-facing lead time</span><input name="leadTimeText" value="${h(s?.leadTimeText || 'Ships from our warehouse in 2-5 business days')}"></label>
      <label class="field"><span>Notes (account no., terms…)</span><textarea name="notes" rows="3">${h(s?.notes)}</textarea></label>
      <div class="row-card-actions">${s ? '<button type="button" class="btn btn-danger" id="s-del">Delete</button>' : '<span></span>'}<button class="btn btn-primary">Save</button></div></form>`,
    );
    $('#sform', root).addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api(s ? `/suppliers/${s.id}` : '/suppliers', { method: s ? 'PUT' : 'POST', body: Object.fromEntries(new FormData(e.target)) });
        toast('Supplier saved');
        routes.suppliers();
      } catch (err) { fail(err); }
    });
    $('#s-del', root)?.addEventListener('click', async () => {
      if (!confirm(`Delete ${s.name}? Its warehouse feed rows are deleted too; listed products stay but lose the supplier link.`)) return;
      try { await api(`/suppliers/${s.id}`, { method: 'DELETE' }); routes.suppliers(); } catch (err) { fail(err); }
    });
  };
  root.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) editor(list.find((s) => s.id === tr.dataset.id));
  });
  $('[data-sup-new]').addEventListener('click', () => editor(null));
};

// ============================================================== shipping

routes.shipping = async () => {
  setTop('Settings', 'Shipping options', '<button class="btn btn-primary" data-ship-new>+ Option</button>');
  const list = await api('/shipping');
  const row = (o) => `<tr data-id="${h(o?.id || '')}">
    <td><input class="inline-input" name="name" value="${h(o?.name)}" placeholder="Option name"></td>
    <td><input class="inline-input" name="category" value="${h(o?.category)}" placeholder="Courier / PUDO Locker / Local Delivery" list="ship-cats"></td>
    <td><select class="inline-input" name="optionType">${options([{ value: 'fixed', label: 'Customer picks' }, { value: 'auto_weight', label: 'Auto by weight' }], o?.optionType || 'fixed')}</select></td>
    <td><input class="inline-input" name="minWeight" type="number" min="0" value="${o?.minWeight ?? 0}" style="width:6rem"></td>
    <td><input class="inline-input" name="maxWeight" type="number" min="0" value="${o?.maxWeight ?? ''}" placeholder="∞" style="width:6rem"></td>
    <td><input class="inline-input" name="price" type="number" step="0.01" min="0" value="${toRands(o?.priceCents ?? 0)}" style="width:7rem"></td>
    <td><input type="checkbox" name="active" ${!o || o.active ? 'checked' : ''}></td>
    <td style="white-space:nowrap"><button class="btn small btn-primary" data-save>Save</button> ${o ? '<button class="btn small btn-danger" data-del>×</button>' : ''}</td>
  </tr>`;
  const root = view(`<div class="panel table-wrap">
    <p class="mini-help">Same model as lapanza3d: “Auto by weight” options (Courier) are picked automatically from the cart weight — their ranges must not overlap. “Customer picks” options are listed under their category at checkout. Weights in grams. PUDO options ask the customer for their locker.</p>
    <datalist id="ship-cats"><option>Courier</option><option>PUDO Locker</option><option>Local Delivery</option></datalist>
    <table class="catalog"><thead><tr><th>Name</th><th>Group</th><th>Type</th><th>Min g</th><th>Max g</th><th>Price R</th><th>On</th><th></th></tr></thead>
    <tbody id="ship-rows">${list.map(row).join('')}</tbody></table></div>`);
  $('[data-ship-new]').addEventListener('click', () => $('#ship-rows', root).insertAdjacentHTML('afterbegin', row(null)));
  root.addEventListener('click', async (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const id = tr.dataset.id;
    if (e.target.closest('[data-del]')) {
      if (!confirm('Delete this shipping option?')) return;
      try { await api(`/shipping/${id}`, { method: 'DELETE' }); toast('Deleted'); routes.shipping(); } catch (err) { fail(err); }
    }
    if (e.target.closest('[data-save]')) {
      const get = (n) => tr.querySelector(`[name="${n}"]`);
      const body = { name: get('name').value, category: get('category').value, optionType: get('optionType').value, minWeight: get('minWeight').value, maxWeight: get('maxWeight').value, price: get('price').value, active: get('active').checked };
      try { await api(id ? `/shipping/${id}` : '/shipping', { method: id ? 'PUT' : 'POST', body }); toast('Saved'); routes.shipping(); } catch (err) { fail(err); }
    }
  });
};

// ============================================================== messages

routes.messages = async () => {
  setTop('Sales', 'Enquiries');
  const list = await api('/messages');
  const root = view(`<div class="stack gap-3">${
    list.map((m) => `<div class="panel" style="opacity:${m.handled ? 0.6 : 1}">
      <div class="section-head"><h3>${h(m.name)}</h3><span class="muted">${h(fmtDate(m.created_at))}</span></div>
      <p class="muted"><a href="mailto:${h(m.email)}?subject=${encodeURIComponent('Re: your enquiry to Procom Solutions')}">${h(m.email)}</a> ${m.phone ? `· <a href="tel:${h(m.phone)}">${h(m.phone)}</a>` : ''}</p>
      <p style="white-space:pre-wrap">${h(m.message)}</p>
      <label class="field checkbox"><input type="checkbox" data-handled="${h(m.id)}" ${m.handled ? 'checked' : ''}><span>Handled</span></label>
    </div>`).join('') || '<div class="panel empty">No enquiries yet.</div>'
  }</div>`);
  root.addEventListener('change', async (e) => {
    const id = e.target.dataset.handled;
    if (!id) return;
    try { await api(`/messages/${id}`, { method: 'PUT', body: { handled: e.target.checked } }); routes.messages(); } catch (err) { fail(err); }
  });
};

// ============================================================== settings

routes.settings = async () => {
  setTop('Settings', 'Site settings');
  const s = await siteSettings(true);
  const f = (key, label, type = 'text', extra = '') => `<label class="field"><span>${h(label)}</span><input name="${key}" type="${type}" value="${h(s[key])}" ${extra}></label>`;
  const root = view(`<form id="setform" class="grid-2">
    <div class="panel stack gap-3">
      <div class="section-head"><h3>Storefront</h3></div>
      ${f('siteName', 'Site name')}
      ${f('tagline', 'Tagline')}
      ${f('announcement', 'Announcement bar (blank hides it)')}
      ${f('hours', 'Business hours')}
      ${f('legalEntity', 'Legal entity shown in footer & policies')}
    </div>
    <div class="panel stack gap-3">
      <div class="section-head"><h3>Contact</h3></div>
      ${f('contactEmail', 'Public email', 'email')}
      ${f('contactPhone', 'Public phone')}
      ${f('whatsappNumber', 'WhatsApp number (international, e.g. 27826639608)')}
      ${f('ownerNotifyEmail', 'Send new-order & enquiry notifications to', 'email')}
    </div>
    <div class="panel stack gap-3">
      <div class="section-head"><h3>Pricing</h3></div>
      ${f('defaultMarkupPct', 'Default markup % on supplier cost', 'number', 'step="0.5" min="0" max="500"')}
      ${f('vatRatePct', 'VAT rate %', 'number', 'step="0.5" min="0" max="50"')}
      <label class="field checkbox"><input type="checkbox" name="vatRegistered" ${s.vatRegistered ? 'checked' : ''}><span>Business is VAT-registered</span></label>
      ${f('vatNumber', 'VAT number')}
      <p class="mini-help">Auto price = cost excl VAT × (1 + VAT) × (1 + markup), rounded up to the next rand. Changing the default markup or VAT rate reprices every auto-priced product that doesn’t have its own or a category markup.</p>
    </div>
    <div class="panel stack gap-3">
      <div class="section-head"><h3>Products</h3></div>
      ${f('defaultWeightG', 'Default product weight (g) — used for courier bracket matching', 'number', 'min="0"')}
      <button class="btn btn-primary" style="margin-top:auto">Save settings</button>
    </div>
  </form>`);
  $('#setform', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { ...Object.fromEntries(new FormData(e.target)), vatRegistered: e.target.vatRegistered.checked };
    try {
      const r = await api('/settings', { method: 'PUT', body });
      settingsCache = r;
      toast(`Settings saved${r.repriced ? ` · ${r.repriced} products repriced` : ''}`);
    } catch (err) { fail(err); }
  });
};

// ============================================================== admins & backups

routes.admins = async () => {
  setTop('Settings', 'Admin users');
  const list = await api('/admins');
  const root = view(`<div class="grid-2">
    <div class="panel"><div class="section-head"><h3>Accounts</h3></div>
      ${list.map((a) => `<div class="row-card"><div><strong>${h(a.username)}</strong> <span class="muted">${h(a.email || '')}</span><br><span class="muted">since ${h(fmtDate(a.createdAt))}</span></div>
        <div class="row-card-actions"><button class="btn small" data-reset="${h(a.id)}">Reset password</button><button class="btn small btn-danger" data-del="${h(a.id)}">Remove</button></div></div>`).join('')}
    </div>
    <form class="panel stack gap-3" id="aform"><div class="section-head"><h3>Add admin</h3></div>
      <label class="field"><span>Username</span><input name="username" required></label>
      <label class="field"><span>Email (optional, can be used to sign in)</span><input name="email" type="email"></label>
      <label class="field"><span>Password (min 10 characters)</span><input name="password" type="password" minlength="10" required autocomplete="new-password"></label>
      <button class="btn btn-primary">Create</button></form>
  </div>`);
  $('#aform', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/admins', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); toast('Admin created'); routes.admins(); } catch (err) { fail(err); }
  });
  root.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del]');
    const reset = e.target.closest('[data-reset]');
    try {
      if (del && confirm('Remove this admin account?')) { await api(`/admins/${del.dataset.del}`, { method: 'DELETE' }); routes.admins(); }
      if (reset) {
        const pw = prompt('New password (min 10 characters):');
        if (pw) { await api(`/admins/${reset.dataset.reset}/password`, { method: 'PUT', body: { password: pw } }); toast('Password reset — that admin must sign in again'); }
      }
    } catch (err) { fail(err); }
  });
};

routes.backups = async () => {
  setTop('Settings', 'Backups', '<button class="btn btn-primary" data-backup-now>Back up now</button>');
  const list = await api('/backups');
  view(`<div class="panel">
    <p class="mini-help">The database is backed up automatically every day (30 kept) in <code>data/backups/</code> on the server. Product photos live in <code>public/uploads/</code>. See deploy/DEPLOY.md for off-server copies.</p>
    <div class="table-wrap"><table class="catalog"><thead><tr><th>File</th><th class="num">Size</th><th>Created</th></tr></thead><tbody>
      ${list.map((b) => `<tr><td>${h(b.file)}</td><td class="num">${(b.size / 1024).toFixed(0)} KB</td><td>${h(fmtDate(b.createdAt))}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">No backups yet.</td></tr>'}
    </tbody></table></div></div>`);
  $('[data-backup-now]').addEventListener('click', async () => {
    try { const r = await api('/backups', { method: 'POST' }); toast(`Backup created: ${r.file}`); routes.backups(); } catch (err) { fail(err); }
  });
};

// ============================================================== boot

(async function boot() {
  try {
    const s = await (await fetch('/api/admin/session')).json();
    needsSetup = s.needsSetup;
    if (!s.authenticated) return showLogin();
    showShell();
    route();
  } catch {
    showLogin();
  }
})();
