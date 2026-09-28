// Customers → Clients: everyone who has ordered or registered, grouped by
// email (guests have no account row). Detail view lists all their orders.
const state = { q: '', page: 1 };

export default function register(routes, kit) {
  const { $, h, rand, fmtDate, api, view, setTop, pager, statusBadge } = kit;

  const accountBadge = (c) =>
    !c.registered ? '<span class="badge">Guest</span>'
    : c.disabled ? '<span class="badge bad">Disabled</span>'
    : c.verified ? '<span class="badge ok">Registered</span>'
    : '<span class="badge warn">Unverified</span>';

  async function list() {
    setTop('Customers', 'Clients');
    const res = await api(`/clients?${new URLSearchParams({ q: state.q, page: state.page })}`);
    const root = view(`
      <div class="toolbar">
        <input id="c-q" type="search" placeholder="Name, email or phone" value="${h(state.q)}">
        <span class="muted">${res.total} client${res.total === 1 ? '' : 's'} · ${res.registered} with an account</span>
      </div>
      <div class="panel table-wrap"><table class="catalog">
        <thead><tr><th>Client</th><th>Phone</th><th class="num">Orders</th><th class="num">Total spent</th><th>Last order</th><th>Account</th></tr></thead>
        <tbody>${
          res.items.map((c) => `<tr data-go="#/clients/${h(encodeURIComponent(c.email))}">
            <td><strong>${h(c.name || '—')}</strong><br><span class="muted">${h(c.email)}</span></td>
            <td>${h(c.phone)}</td>
            <td class="num">${c.paidOrderCount}${c.orderCount > c.paidOrderCount ? ` <span class="muted">(+${c.orderCount - c.paidOrderCount} unpaid)</span>` : ''}</td>
            <td class="num">${rand(c.totalSpentCents)}</td>
            <td>${h(fmtDate(c.lastOrderAt)) || '<span class="muted">—</span>'}</td>
            <td>${accountBadge(c)}${c.newsletter ? ' <span class="badge info">Newsletter</span>' : ''}</td>
          </tr>`).join('') || '<tr><td colspan="6" class="empty">No clients yet — they appear here once someone orders or registers.</td></tr>'
        }</tbody></table></div>
      ${pager(res.page, res.pages)}
      <p class="mini-help">Spent = paid orders only. Guests are grouped by the email they checked out with; registering with the same email links their earlier orders to the account.</p>`);
    $('#c-q', root).addEventListener('change', (e) => { state.q = e.target.value; state.page = 1; list(); });
    root.addEventListener('click', (e) => {
      const pg = e.target.closest('[data-page]');
      if (pg) { state.page = Number(pg.dataset.page); list(); }
    });
  }

  async function detail(email) {
    const c = await api(`/clients/detail?${new URLSearchParams({ email })}`);
    setTop('Customers', c.name || c.email, '<button class="btn" data-go="#/clients">← Clients</button>');
    const a = c.client;
    view(`
      <div class="stats">
        <div class="stat-card"><div class="label">Paid orders</div><div class="value">${c.paidOrderCount}</div></div>
        <div class="stat-card"><div class="label">Total spent</div><div class="value">${rand(c.totalSpentCents)}</div></div>
        <div class="stat-card"><div class="label">Last order</div><div class="value" style="font-size:1rem">${h(fmtDate(c.lastOrderAt)) || '—'}</div></div>
        <div class="stat-card"><div class="label">Account</div><div class="value" style="font-size:1rem">${accountBadge({ registered: Boolean(a), disabled: a?.disabled, verified: a?.emailVerified })}</div></div>
      </div>
      <div class="editor-layout">
        <div class="panel">
          <div class="section-head"><h3>Orders</h3></div>
          <div class="table-wrap"><table class="catalog">
            <thead><tr><th>Order</th><th class="num">Items</th><th class="num">Total</th><th>Status</th><th>Placed</th></tr></thead>
            <tbody>${
              c.orders.map((o) => `<tr data-go="#/orders/${h(o.id)}"><td><strong>${h(o.orderNumber)}</strong>${a && !o.linked ? ' <span class="muted">(not linked)</span>' : ''}</td><td class="num">${o.itemCount}</td><td class="num">${rand(o.totalCents)}</td><td>${statusBadge(o.status)}</td><td>${h(fmtDate(o.createdAt))}</td></tr>`).join('') ||
              '<tr><td colspan="5" class="empty">No orders yet.</td></tr>'
            }</tbody></table></div>
        </div>
        <div class="stack gap-4 editor-actions">
          <div class="panel">
            <div class="section-head"><h3>Contact</h3></div>
            <div class="meta-list">
              <div><span>Name</span><span>${h(c.name || '—')}</span></div>
              <div><span>Email</span><a href="mailto:${h(c.email)}">${h(c.email)}</a></div>
              ${c.phone ? `<div><span>Phone</span><a href="tel:${h(c.phone)}">${h(c.phone)}</a></div>` : ''}
              ${c.addresses.map((ad, i) => `<div><span>${i ? 'Earlier address' : 'Address'}</span><span style="text-align:right">${h(ad)}</span></div>`).join('')}
            </div>
          </div>
          ${a ? `<div class="panel">
            <div class="section-head"><h3>Account</h3></div>
            <div class="meta-list">
              <div><span>Registered</span><span>${h(fmtDate(a.createdAt))}</span></div>
              <div><span>Email verified</span><span>${a.emailVerified ? h(fmtDate(a.verifiedAt)) || 'Yes' : 'No'}</span></div>
              <div><span>Last login</span><span>${h(fmtDate(a.lastLoginAt)) || 'Never'}</span></div>
              <div><span>Newsletter</span><span>${a.newsletter ? `Yes, since ${h(fmtDate(a.newsletterAt))}` : 'No'}</span></div>
              ${a.addressLine1 ? `<div><span>Saved address</span><span style="text-align:right">${[a.addressLine1, a.addressLine2, a.suburb, a.city, a.province, a.postalCode].filter(Boolean).map(h).join('<br>')}</span></div>` : ''}
            </div>
            <p class="mini-help">Manage the login under <a href="#/registered-users">Registered users</a>.</p>
          </div>` : '<div class="panel"><p class="mini-help">Guest — no account. If they register with this email, these orders are linked to it automatically.</p></div>'}
        </div>
      </div>`);
  }

  routes.clients = async (email) => (email ? detail(email) : list());
}
