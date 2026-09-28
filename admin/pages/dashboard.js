// Admin -> Dashboard (Phase 2): replaces the core dashboard with a fuller
// overview. Sales and work queues come from GET /api/admin/finance/dashboard
// (server/features/finance.js); catalogue counts and unread enquiries still
// come from the core GET /api/admin/dashboard.
// Every dynamic value goes through kit.h() before kit.view()/kit.setTop().

const dayLabel = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', timeZone: 'UTC' });

// 30-day sales sparkline. The caption next to it is the text alternative.
function sparkline(days, h, rand) {
  const W = 320;
  const H = 70;
  const max = Math.max(1, ...days.map((d) => d.totalCents));
  const x = (i) => (days.length > 1 ? (i / (days.length - 1)) * (W - 4) + 2 : W / 2);
  const y = (v) => H - 4 - (v / max) * (H - 10);
  const pts = days.map((d, i) => `${x(i).toFixed(1)},${y(d.totalCents).toFixed(1)}`);
  const area = `2,${H - 4} ${pts.join(' ')} ${(W - 2).toFixed(1)},${H - 4}`;
  const best = days.reduce((b, d) => (d.totalCents > b.totalCents ? d : b), days[0]);
  const dots = days.map((d, i) => (d.totalCents ? `<circle cx="${x(i).toFixed(1)}" cy="${y(d.totalCents).toFixed(1)}" r="2.2" style="fill:var(--brand)"><title>${h(dayLabel(d.date))}: ${h(rand(d.totalCents))} (${h(d.orders)} order${d.orders === 1 ? '' : 's'})</title></circle>` : '')).join('');
  const total = days.reduce((t, d) => t + d.totalCents, 0);
  const desc = total
    ? `Sales over the last 30 days: ${rand(total)} in total; best day ${dayLabel(best.date)} with ${rand(best.totalCents)}.`
    : 'No sales in the last 30 days.';
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:90px;display:block" preserveAspectRatio="none" role="img" aria-label="${h(desc)}">
      <polygon points="${area}" style="fill:var(--brand-soft)"></polygon>
      <polyline points="${pts.join(' ')}" style="fill:none;stroke:var(--brand);stroke-width:2;stroke-linejoin:round" vector-effect="non-scaling-stroke"></polyline>${dots}
    </svg>
    <div class="muted" style="display:flex;justify-content:space-between;font-size:0.75rem"><span>${h(dayLabel(days[0].date))}</span><span>Today</span></div>
    <p class="mini-help">${h(desc)}</p>`;
}

export default function register(routes, kit) {
  const { h, rand, api, view, setTop, statusBadge, fmtDate } = kit;

  routes.dashboard = async () => {
    setTop('Overview', 'Dashboard', `<button class="btn btn-primary" data-go="#/feed">Import pricelist</button><button class="btn btn-secondary" data-go="#/products/new">+ Product</button><button class="btn" data-go="#/expenses/new">+ Expense</button>`);
    const [core, d] = await Promise.all([api('/dashboard'), api('/finance/dashboard')]);
    const s = d.sales;
    const mtd = d.monthToDate;
    const orderCount = (n) => `${h(n)} order${n === 1 ? '' : 's'}`;
    const attention = (href, count, label, tone) => `<a class="stat-card" href="${h(href)}"${label.includes('below cost') ? ' data-scroll="dash-low"' : ''} style="text-decoration:none;color:inherit;display:block;${count ? `border-color:var(--${tone})` : ''}">
        <div class="label">${h(label)}</div><div class="value" style="${count ? `color:var(--${tone})` : ''}">${h(count)}</div></a>`;
    const who = (o) => `<a href="#/orders/${h(encodeURIComponent(o.id))}"><strong>${h(o.orderNumber)}</strong></a> · ${h(o.customer)}`;
    const queue = (title, items, more, empty, extra = () => '') => `<div><h4 style="margin:0.4rem 0">${h(title)}</h4>${
      items.length
        ? `<ul style="margin:0;padding-left:1.1rem;line-height:1.7">${items.map((o) => `<li>${who(o)}${extra(o)}</li>`).join('')}</ul>${more > items.length ? `<p class="mini-help">+ ${h(more - items.length)} more</p>` : ''}`
        : `<p class="muted" style="margin:0">${h(empty)}</p>`
    }</div>`;

    const latest = d.latestOrders.length
      ? d.latestOrders.map((o) => `<a class="recent-item" href="#/orders/${h(encodeURIComponent(o.id))}" style="text-decoration:none;color:inherit">
          <span><strong>${h(o.orderNumber)}</strong> · ${h(o.customer)}<br><span class="muted" style="font-size:0.8rem">${h(fmtDate(o.createdAt))}${o.collection ? ' · collection' : ''}${o.deliveryQuote ? ' · delivery quote' : ''}</span></span>
          <span>${statusBadge(o.status)} ${rand(o.totalCents)}</span></a>`).join('')
      : '<p class="muted">No orders yet.</p>';

    const top = d.topProducts.length
      ? `<table class="catalog"><thead><tr><th>Product</th><th class="num">Sold</th><th class="num">Sales</th></tr></thead><tbody>${d.topProducts.map((p) => `<tr><td>${p.productId ? `<a href="#/products/${h(encodeURIComponent(p.productId))}">${h(p.name)}</a>` : h(p.name)}</td><td class="num">${h(p.quantity)}</td><td class="num">${rand(p.revenueCents)}</td></tr>`).join('')}</tbody></table>`
      : '<p class="muted">No sales in the last 30 days.</p>';

    const low = d.lowMargin.items.length
      ? `<table class="catalog"><thead><tr><th>Product</th><th class="num">Price</th><th class="num">Cost incl VAT</th></tr></thead><tbody>${d.lowMargin.items.map((p) => `<tr><td><a href="#/products/${h(encodeURIComponent(p.id))}">${h(p.name)}</a>${p.manual ? ' <span class="badge neutral">manual price</span>' : ''}</td><td class="num money-up">${rand(p.priceCents)}</td><td class="num">${rand(p.costInclVatCents)}</td></tr>`).join('')}</tbody></table>
         ${d.lowMargin.count > d.lowMargin.items.length ? `<p class="mini-help">+ ${h(d.lowMargin.count - d.lowMargin.items.length)} more</p>` : ''}`
      : '<p class="muted" style="margin:0">None — every live product sells above what it costs us.</p>';

    const links = [
      ['#/orders', 'Orders'], ['#/feed', 'Warehouse feed'], ['#/products', 'Products'], ['#/categories', 'Categories'],
      ['#/expenses/new', 'Capture an expense'], ['#/financial-overview', 'Financial overview'], ['#/invoice-history', 'Invoice history'],
      ['#/promos', 'Promo codes'], ['#/specials', 'Specials'], ['#/messages', 'Enquiries'], ['#/settings', 'Site settings'],
    ];

    const root = view(`
      <div class="stats">
        <div class="stat-card"><div class="label">Sales today · ${orderCount(s.today.orders)}</div><div class="value">${rand(s.today.totalCents)}</div></div>
        <div class="stat-card"><div class="label">Last 7 days · ${orderCount(s.days7.orders)}</div><div class="value">${rand(s.days7.totalCents)}</div></div>
        <div class="stat-card"><div class="label">Last 30 days · ${orderCount(s.days30.orders)}</div><div class="value">${rand(s.days30.totalCents)}</div></div>
        <a class="stat-card" href="#/financial-overview" style="text-decoration:none;color:inherit;display:block"><div class="label">Profit this month (est.)${mtd.profitMarginPct == null ? '' : ` · ${h(mtd.profitMarginPct.toFixed(1))}%`}</div><div class="value" style="${mtd.profitCents < 0 ? 'color:var(--danger)' : ''}">${rand(mtd.profitCents)}</div></a>
      </div>
      <div class="stats">
        ${attention('#/orders/list/paid', d.ordersToProcess.count, 'Orders to process (paid, not ordered yet)', 'warn')}
        ${attention('#/orders/list/paid', d.collectionsWaiting.count, 'Collections waiting to be packed', 'warn')}
        ${attention('#/orders/list/paid', d.deliveryQuotesPending.count, 'Delivery quotes to send', 'warn')}
        ${attention('#/dashboard', d.lowMargin.count, 'Products priced below cost', 'danger')}
      </div>

      <div class="grid-2" style="align-items:start;margin-bottom:1rem">
        <div class="panel">
          <div class="section-head"><h3>Sales — last 30 days</h3><a class="btn small" href="#/financial-overview" style="text-decoration:none;color:inherit">Financial overview</a></div>
          ${sparkline(d.series30, h, rand)}
        </div>
        <div class="panel table-wrap">
          <div class="section-head"><h3>Top sellers — last 30 days</h3></div>
          ${top}
        </div>
      </div>

      <div class="grid-2" style="align-items:start;margin-bottom:1rem">
        <div class="panel">
          <div class="section-head"><h3>Latest orders</h3><a class="btn small" href="#/orders" style="text-decoration:none;color:inherit">All orders</a></div>
          <div class="recent-list">${latest}</div>
        </div>
        <div class="panel stack gap-2">
          <div class="section-head"><h3>To do</h3></div>
          ${queue('Order from the supplier', d.ordersToProcess.items, d.ordersToProcess.count, 'Nothing waiting — all paid orders have been ordered.')}
          ${queue('Collections not yet ready', d.collectionsWaiting.items, d.collectionsWaiting.count, 'No collections waiting.', (o) => (o.label ? ` <span class="muted">(${h(o.label)})</span>` : ''))}
          ${queue('Delivery quotes to send', d.deliveryQuotesPending.items, d.deliveryQuotesPending.count, 'No delivery quotes pending.')}
          <div class="meta-list" style="margin-top:0.5rem">
            <div><span>Unread enquiries</span><a href="#/messages">${h(core.unreadMessages)}</a></div>
            <div><span>Orders awaiting payment (30 days)</span><a href="#/orders/list/pending_payment">${h(core.awaitingPayment)}</a></div>
            <div><span>Products without a category</span><a href="#/products/list/__none">${h(core.uncategorised)}</a></div>
            <div><span>Live but out of stock</span><a href="#/products">${h(core.outOfStock)}</a></div>
          </div>
        </div>
      </div>

      <div class="panel table-wrap" id="dash-low" style="margin-bottom:1rem">
        <div class="section-head"><h3>Products priced below cost</h3><span class="muted">live products whose price is under supplier cost + VAT</span></div>
        ${low}
      </div>

      <div class="stats">
        <div class="stat-card"><div class="label">Live products</div><div class="value">${h(core.activeProducts)}</div></div>
        <div class="stat-card"><div class="label">Hidden products</div><div class="value">${h(core.inactiveProducts)}</div></div>
        <div class="stat-card"><div class="label">Out of stock (live)</div><div class="value">${h(core.outOfStock)}</div></div>
        <div class="stat-card"><div class="label">Warehouse items available</div><div class="value">${h(core.feedItems)}</div></div>
      </div>

      <div class="panel">
        <div class="section-head"><h3>Quick links</h3></div>
        <div style="display:flex;flex-wrap:wrap;gap:0.5rem">${links.map(([href, label]) => `<a class="btn small" href="${h(href)}" style="text-decoration:none;color:inherit">${h(label)}</a>`).join('')}</div>
      </div>`);
    root.addEventListener('click', (e) => {
      const a = e.target.closest('[data-scroll]');
      if (!a) return;
      e.preventDefault();
      document.getElementById(a.dataset.scroll)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };
}
