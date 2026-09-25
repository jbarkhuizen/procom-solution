import '../styles/main.css';
import { esc, formatRand, getSite, getCategories, whatsappLink } from './api.js';
import { getCart, cartCount, cartSubtotal, setQuantity, removeFromCart, addToCart } from './cart.js';
import { setHtml } from './dom.js';

const THEME_KEY = 'procom-theme';

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'dark' ? '#14110f' : '#f7f3eb';
}

function initTheme() {
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-theme-toggle]')) return;
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
    applyTheme(next);
  });
}

// ----------------------------------------------------------------- sidebar nav

const THEME_BTN = `<button type="button" class="theme-toggle-btn shrink-0 hidden md:inline-flex" data-theme-toggle aria-label="Toggle dark mode" title="Toggle dark mode">
  <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
  <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 14.5A8.5 8.5 0 0 1 9.5 3 7 7 0 1 0 21 14.5z"/></svg>
</button>`;

const linkCls = 'side-link block py-2.5 uppercase text-[0.68rem] tracking-[0.18em] text-espresso/80 hover:text-terracotta transition-colors border-t border-charcoal/10';

function currentCategorySlug() {
  return new URLSearchParams(location.search).get('category') || document.body.dataset.category || '';
}

function containsSlug(cat, slug) {
  return cat.slug === slug || cat.children.some((c) => containsSlug(c, slug));
}

function renderCategory(cat, active) {
  const href = `/shop.html?category=${encodeURIComponent(cat.slug)}`;
  const kids = cat.children.filter((c) => c.productCount > 0);
  if (!kids.length) {
    return `<a href="${href}" class="${linkCls} ${cat.slug === active ? 'active' : ''}">${esc(cat.name)}</a>`;
  }
  const open = containsSlug(cat, active);
  const links = kids
    .map((c) => `<a href="/shop.html?category=${encodeURIComponent(c.slug)}" class="side-link ${c.slug === active ? 'active' : ''} block py-1.5 text-[0.9rem] text-espresso/70 hover:text-terracotta transition-colors">${esc(c.name)}</a>`)
    .join('');
  return `<details class="rot-open border-t border-charcoal/10 py-2" data-nav-key="${esc(cat.slug)}" ${open ? 'open' : ''}>
    <summary class="flex items-center justify-between uppercase text-[0.68rem] tracking-[0.18em] text-espresso/80 hover:text-terracotta transition-colors py-1.5 font-semibold"><span>${esc(cat.name)}</span><span class="chev transition-transform duration-200 text-terracotta">&#8250;</span></summary>
    <div class="pl-3 mt-1 space-y-0.5 border-l border-charcoal/10">
      <a href="${href}" class="side-link ${cat.slug === active ? 'active' : ''} block py-1.5 text-[0.9rem] text-espresso/70 hover:text-terracotta transition-colors">All ${esc(cat.name)}</a>
      ${links}
    </div>
  </details>`;
}

async function mountNav() {
  const navs = document.querySelectorAll('[data-site-nav]');
  if (!navs.length) return;
  const page = document.body.dataset.page || '';
  const head = `<div class="flex items-start justify-between gap-3 mb-6">
      <a href="/" class="brand-mark hover:opacity-80 transition-opacity inline-flex items-center gap-2 font-serif text-[1.35rem] tracking-tight font-semibold">
        <img src="/branding/logo-mark.svg" alt="" class="h-9 w-9" />
        <span>Procom <span class="mark-sub">Solutions</span></span>
      </a>
      ${THEME_BTN}
    </div>
    <a href="/shop.html" class="${linkCls} ${page === 'shop' && !currentCategorySlug() ? 'active' : ''}">All products</a>`;
  const tail = `<a href="/contact.html" class="${linkCls} ${page === 'contact' ? 'active' : ''}">Get in touch</a>
    <a href="/returns.html" class="${linkCls} border-b">Delivery &amp; Returns</a>`;
  navs.forEach((n) => setHtml(n, head + '<div data-cat-links></div>' + tail));
  // Empty categories stay hidden until something is listed in them.
  const cats = (await getCategories()).filter((c) => c.productCount > 0);
  const active = currentCategorySlug();
  const html = cats.map((c) => renderCategory(c, active)).join('');
  document.querySelectorAll('[data-cat-links]').forEach((el) => setHtml(el, html));
}

function initDrawer() {
  const drawer = document.getElementById('sidebar-drawer');
  const toggle = (show) => {
    if (!drawer) return;
    drawer.classList.toggle('hidden', !show);
    document.body.style.overflow = show ? 'hidden' : '';
  };
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-drawer-open]')) toggle(true);
    if (e.target.closest('[data-drawer-close]')) toggle(false);
  });
}

// ------------------------------------------------------------------ cart drawer

function renderCart() {
  const items = getCart();
  const count = cartCount();
  document.querySelectorAll('[data-cart-count]').forEach((el) => {
    el.textContent = String(count);
    el.classList.toggle('hidden', count === 0);
  });
  document.querySelectorAll('[data-cart-subtotal]').forEach((el) => (el.textContent = formatRand(cartSubtotal())));
  document.querySelectorAll('[data-cart-checkout]').forEach((el) => el.classList.toggle('pointer-events-none', !items.length));
  const box = document.querySelector('[data-cart-items]');
  if (!box) return;
  if (!items.length) {
    setHtml(box, `<div class="text-center py-16"><p class="font-serif text-xl mb-2">Your cart is empty</p><p class="text-sm text-espresso/60 mb-6">Find something good in the shop.</p><a href="/shop.html" class="inline-flex bg-charcoal text-cream rounded-full px-5 py-2.5 text-sm font-semibold hover:bg-terracotta">Browse products</a></div>`);
    return;
  }
  setHtml(
    box,
    items
      .map(
        (i) => `<div class="flex gap-3 py-3 border-b border-charcoal/10" data-line="${esc(i.productId)}">
      <a href="/product.html?p=${encodeURIComponent(i.slug)}" class="w-16 h-16 shrink-0 bg-white rounded-sm border border-charcoal/10 flex items-center justify-center overflow-hidden">${i.image ? `<img src="${esc(i.image)}" alt="" class="w-full h-full object-contain p-1">` : ''}</a>
      <div class="flex-1 min-w-0">
        <p class="text-sm leading-snug line-clamp-2">${esc(i.name)}</p>
        <p class="text-sm text-terracotta font-semibold mt-1">${formatRand(i.priceCents * i.quantity)}</p>
        <div class="flex items-center justify-between mt-2">
          <div class="qty"><button type="button" data-qty="-1" aria-label="Decrease">−</button><input type="number" value="${Number(i.quantity)}" min="1" aria-label="Quantity" data-qty-input><button type="button" data-qty="1" aria-label="Increase">+</button></div>
          <button type="button" data-remove class="text-xs text-espresso/55 hover:text-terracotta underline">Remove</button>
        </div>
        ${i.minOrderQty > 1 ? `<p class="text-[0.7rem] text-espresso/50 mt-1">Minimum ${Number(i.minOrderQty)}</p>` : ''}
      </div>
    </div>`,
      )
      .join(''),
  );
}

export function openCart(open = true) {
  const drawer = document.getElementById('cart-drawer');
  drawer?.classList.toggle('open', open);
  drawer?.setAttribute('aria-hidden', String(!open));
  document.querySelector('.cart-scrim')?.classList.toggle('open', open);
}

function initCart() {
  renderCart();
  window.addEventListener('cart:updated', renderCart);
  window.addEventListener('storage', (e) => e.key === 'procom-cart' && renderCart());
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-cart-open]')) openCart(true);
    if (e.target.closest('[data-cart-close]')) openCart(false);
    const line = e.target.closest('[data-line]');
    if (!line) return;
    const id = line.dataset.line;
    const item = getCart().find((i) => i.productId === id);
    if (!item) return;
    const step = e.target.closest('[data-qty]');
    if (step) setQuantity(id, item.quantity + Number(step.dataset.qty));
    if (e.target.closest('[data-remove]')) removeFromCart(id);
  });
  document.addEventListener('change', (e) => {
    const input = e.target.closest('[data-qty-input]');
    const line = e.target.closest('[data-line]');
    if (input && line) setQuantity(line.dataset.line, Math.max(0, parseInt(input.value, 10) || 0));
  });
  document.addEventListener('keydown', (e) => e.key === 'Escape' && openCart(false));
}

let toastTimer;
export function toast(message) {
  const el = document.getElementById('site-toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

export function addWithFeedback(product, quantity) {
  addToCart(product, quantity || product.minOrderQty || 1);
  toast(`Added to cart — ${product.name.slice(0, 40)}${product.name.length > 40 ? '…' : ''}`);
  openCart(true);
}

// ------------------------------------------------------------ settings hydrate

async function hydrateSite() {
  const site = await getSite();
  if (!site) return;
  document.querySelectorAll('[data-site]').forEach((el) => {
    const v = site[el.dataset.site];
    if (v) el.textContent = v;
    else if (el.dataset.site === 'announcement') el.remove();
  });
  document.querySelectorAll('[data-site-href]').forEach((el) => {
    const kind = el.dataset.siteHref;
    if (kind === 'tel' && site.contactPhone) el.href = `tel:${site.contactPhone.replace(/[^\d+]/g, '').replace(/^0/, '+27')}`;
    if (kind === 'mailto' && site.contactEmail) el.href = `mailto:${site.contactEmail}`;
    if (kind === 'whatsapp') el.href = whatsappLink(site);
  });
  if (!document.querySelector('.wa-fab')) {
    const a = document.createElement('a');
    a.href = whatsappLink(site);
    a.className = 'wa-fab';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.setAttribute('aria-label', 'Chat on WhatsApp');
    a.textContent = 'WhatsApp us';
    document.body.appendChild(a);
  }
}

document.querySelectorAll('[data-year]').forEach((el) => (el.textContent = String(new Date().getFullYear())));
initTheme();
initDrawer();
initCart();
mountNav();
hydrateSite();
