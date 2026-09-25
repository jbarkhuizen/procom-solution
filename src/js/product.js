import { addWithFeedback } from './site.js';
import { api, esc, formatRand, getSite, whatsappLink } from './api.js';
import { productCard, availabilityPill, bindAddButtons } from './cards.js';
import { setHtml } from './dom.js';

const root = document.getElementById('product-root');
const slug = new URLSearchParams(location.search).get('p');

// Plain-text description -> paragraphs (admin enters text, not HTML).
function paragraphs(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function setMeta(p) {
  document.title = `${p.name} — Procom Solutions`;
  const desc = (p.shortDescription || p.description || `${p.brand} ${p.name}`).slice(0, 155);
  document.querySelector('meta[name="description"]')?.setAttribute('content', desc);
  const ld = document.createElement('script');
  ld.type = 'application/ld+json';
  ld.textContent = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.name,
    sku: p.sku,
    brand: p.brand ? { '@type': 'Brand', name: p.brand } : undefined,
    image: p.images.map((i) => location.origin + i),
    description: desc,
    offers: {
      '@type': 'Offer',
      price: (p.priceCents / 100).toFixed(2),
      priceCurrency: 'ZAR',
      availability: p.inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      url: location.href,
    },
  });
  document.head.appendChild(ld);
}

function gallery(p) {
  if (!p.images.length) {
    return `<div class="h-52 bg-white border border-charcoal/10 rounded-sm flex items-center justify-center"><span class="text-espresso/35 text-xs uppercase tracking-[0.2em]">Photo coming soon</span></div>`;
  }
  const thumbs = p.images.length > 1
    ? `<div class="gallery-thumb-strip flex-wrap">${p.images.map((src, i) => `<button type="button" class="gallery-thumb-btn bg-white" data-thumb="${i}" aria-label="Show image ${i + 1}" ${i === 0 ? 'aria-current="true"' : ''}><img src="${esc(src)}" alt="" class="w-full h-full object-contain"></button>`).join('')}</div>`
    : '';
  return `<div class="h-52 md:h-60 bg-white border border-charcoal/10 rounded-sm overflow-hidden flex items-center justify-center p-4"><img id="main-img" src="${esc(p.images[0])}" alt="${esc(p.name)}" class="pd-img"></div>${thumbs}`;
}

async function load() {
  if (!slug) {
    location.replace('/shop.html');
    return;
  }
  let data;
  try {
    data = await api(`/api/products/${encodeURIComponent(slug)}`);
  } catch {
    setHtml(root, `<div class="text-center py-24"><h1 class="font-serif text-3xl mb-3">Product not found</h1><p class="text-espresso/60 mb-6">It may have sold out or been removed.</p><a href="/shop.html" class="inline-flex bg-charcoal text-cream rounded-full px-5 py-2.5 text-sm font-semibold hover:bg-terracotta">Back to the shop</a></div>`);
    return;
  }
  const { product: p, breadcrumb, related } = data;
  const site = await getSite();
  setMeta(p);
  const min = p.minOrderQty || 1;
  const sale = p.compareAtCents && p.compareAtCents > p.priceCents;
  const crumbs = ['<a href="/" class="hover:text-terracotta">Home</a>', '<a href="/shop.html" class="hover:text-terracotta">Shop</a>', ...breadcrumb.map((c) => `<a href="/shop.html?category=${encodeURIComponent(c.slug)}" class="hover:text-terracotta">${esc(c.name)}</a>`)];
  const specs = p.specs.length
    ? `<div class="spec-panel mt-5"><table class="w-full text-[0.82rem]"><tbody>${p.specs.map((s) => `<tr class="border-b border-charcoal/10 last:border-0"><th class="text-left font-semibold py-1.5 pr-4 align-top w-2/5">${esc(s.label)}</th><td class="py-1.5 text-espresso/75">${esc(s.value)}</td></tr>`).join('')}</tbody></table></div>`
    : '';
  setHtml(
    root,
    `<nav class="text-xs text-espresso/50 mb-4" aria-label="Breadcrumb">${crumbs.join(' / ')}</nav>
    <div class="grid md:grid-cols-[minmax(0,280px)_1fr] gap-6 lg:gap-10 items-start">
      <div class="md:sticky md:top-24">${gallery(p)}</div>
      <div>
        ${p.brand ? `<p class="eyebrow mb-3">${esc(p.brand)}</p>` : ''}
        <h1 class="font-serif text-2xl md:text-[1.75rem] leading-tight tracking-tight mb-2">${esc(p.name)}</h1>
        <p class="mb-2"><span class="text-2xl font-semibold text-terracotta">${formatRand(p.priceCents)}</span>${sale ? ` <s class="text-espresso/45 ml-2">${formatRand(p.compareAtCents)}</s>` : ''}</p>
        <div class="flex flex-wrap items-center gap-2 mb-3">${availabilityPill(p)}<span class="text-xs text-espresso/60">${esc(p.availability)}</span></div>
        ${p.shortDescription ? `<p class="text-sm text-espresso/80 leading-relaxed mb-3">${esc(p.shortDescription)}</p>` : ''}
        ${p.inStock ? `<div class="flex flex-wrap items-center gap-3 mb-3">
          <div class="qty"><button type="button" data-step="-1" aria-label="Decrease">−</button><input id="qty" type="number" value="${min}" min="${min}" ${p.stockQty != null ? `max="${Number(p.stockQty)}"` : ''} aria-label="Quantity"><button type="button" data-step="1" aria-label="Increase">+</button></div>
          <button type="button" id="add-btn" class="magnetic-btn flex-1 sm:flex-none sm:w-60 bg-charcoal text-cream rounded-full px-6 py-2.5 text-sm font-semibold brutal hover:bg-terracotta">Add to cart</button>
        </div>
        ${min > 1 ? `<p class="text-xs text-espresso/60 mb-3">Sold in quantities of ${min} or more.</p>` : ''}` : `<p class="text-sm text-espresso/70 mb-4">This item is currently unavailable. WhatsApp us and we'll let you know when it's back or suggest an alternative.</p>`}
        <a href="${esc(whatsappLink(site, `Hi Procom, I have a question about ${p.name} (${p.sku}).`))}" target="_blank" rel="noopener noreferrer" class="inline-flex text-sm font-semibold border-2 border-charcoal rounded-full px-5 py-2.5 hover:bg-charcoal hover:text-cream transition-colors">Ask about this product</a>
        <div class="flex items-start gap-2 rounded-sm border border-charcoal/10 bg-linen/60 px-3 py-2.5 text-xs text-espresso/70 mt-4">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="shrink-0 mt-0.5"><rect x="1" y="3" width="15" height="13"/><path d="M16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>
          <span>Delivered nationwide via PUDO locker or courier, or local delivery in Pretoria East. Delivery options and costs are shown at checkout.</span>
        </div>
        ${p.description ? `<div class="rich-text text-sm text-espresso/80 leading-relaxed mt-5">${paragraphs(p.description)}</div>` : ''}
        ${specs}
        <p class="text-xs text-espresso/45 mt-3">SKU: ${esc(p.sku)}</p>
      </div>
    </div>`,
  );

  // Show a photo at up to 1.4x its real pixels (CSS max-width/height then
  // keep it inside the frame): 113px supplier photos render ~158px and stay
  // crisp, while sharper uploaded photos fill the frame.
  const mainImg = document.getElementById('main-img');
  if (mainImg) {
    const fit = () => {
      if (!mainImg.naturalWidth) return;
      mainImg.style.width = `${Math.round(mainImg.naturalWidth * 1.4)}px`;
    };
    mainImg.addEventListener('load', fit);
    if (mainImg.complete) fit();
  }

  root.addEventListener('click', (e) => {
    const thumb = e.target.closest('[data-thumb]');
    if (thumb) {
      document.getElementById('main-img').src = p.images[Number(thumb.dataset.thumb)];
      root.querySelectorAll('[data-thumb]').forEach((b) => b.setAttribute('aria-current', String(b === thumb)));
    }
    const step = e.target.closest('[data-step]');
    if (step) {
      const input = document.getElementById('qty');
      const max = p.stockQty ?? 999;
      input.value = String(Math.min(max, Math.max(min, (Number(input.value) || min) + Number(step.dataset.step))));
    }
    if (e.target.closest('#add-btn')) {
      const q = Math.max(min, Number(document.getElementById('qty').value) || min);
      addWithFeedback(p, q);
    }
  });

  if (related.length) {
    const wrap = document.getElementById('related-wrap');
    const grid = document.getElementById('related');
    wrap.classList.remove('hidden');
    setHtml(grid, related.map(productCard).join(''));
    const map = new Map(related.map((r) => [r.id, r]));
    bindAddButtons(grid, (id) => map.get(id), (r) => addWithFeedback(r));
  }
}

load();
