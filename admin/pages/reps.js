// Admin → Sales → Sales reps: partners who drive sales with their own codes and earn a share of the profit.
// List + report (dates), one rep's sales/payouts, add/edit, codes, payouts. See server/features/reps.js.
const state = { from: '', to: '' };

const STATUS = { pending: ['Waiting (hold)', 'warn'], payable: ['Payable', 'info'], paid: ['Paid', 'ok'], reversed: ['Reversed', 'bad'] };

export default function register(routes, kit) {
  const { $, h, rand, fmtDate, api, toast, fail, view, setTop, setHtml } = kit;

  const qs = () => new URLSearchParams(Object.fromEntries(Object.entries(state).filter(([, v]) => v))).toString();
  const badge = (s) => {
    const [l, c] = STATUS[s] || [s, 'neutral'];
    return `<span class="badge ${c}">${h(l)}</span>`;
  };
  const dateBar = () => `<div class="toolbar"><label class="field" style="margin:0"><span>From</span><input type="date" id="r-from" value="${h(state.from)}"></label>
    <label class="field" style="margin:0"><span>To</span><input type="date" id="r-to" value="${h(state.to)}"></label>
    <button class="btn small" id="r-clear">All time</button></div>`;
  const bindDates = (root, reload) => {
    $('#r-from', root).addEventListener('change', (e) => { state.from = e.target.value; reload(); });
    $('#r-to', root).addEventListener('change', (e) => { state.to = e.target.value; reload(); });
    $('#r-clear', root).addEventListener('click', () => { state.from = ''; state.to = ''; reload(); });
  };
  const stat = (label, value, sub = '') => `<div class="stat-card"><div class="label">${h(label)}</div><div class="value">${value}</div>${sub ? `<div class="mini-help">${h(sub)}</div>` : ''}</div>`;

  // ------------------------------------------------------------ list

  async function list() {
    setTop('Sales', 'Sales reps', '<button class="btn btn-primary" data-rep-new>+ Sales rep</button>');
    const res = await api(`/reps?${qs()}`);
    const t = res.total;
    const root = view(`${dateBar()}
      <div class="stats">
        ${stat('Sales credited', rand(t.salesCents), `${t.orders} order${t.orders === 1 ? '' : 's'} in this period`)}
        ${stat('Commission earned', rand(t.earnedCents), 'in this period')}
        ${stat('Owed to reps', rand(t.owedCents), `${rand(t.payableCents)} payable now · ${rand(t.pendingCents)} still in the hold`)}
        ${stat('Paid out', rand(t.paidCents), 'all time')}
      </div>
      <div class="editor-layout">
      <div class="panel table-wrap"><table class="catalog">
        <thead><tr><th>Rep</th><th>Codes</th><th class="num">Orders</th><th class="num">Sales</th><th class="num">Commission</th><th class="num">Payable now</th><th class="num">In hold</th><th class="num">Paid</th></tr></thead>
        <tbody>${
          res.reps.map((r) => `<tr data-go="#/reps/${h(r.id)}"><td><strong>${h(r.name)}</strong>${r.active ? '' : ' <span class="badge bad">Paused</span>'}<br><span class="muted">${h(r.company || r.email)}</span></td>
            <td>${r.codes.map(h).join(', ') || '—'}</td>
            <td class="num">${r.totals.orders}</td><td class="num">${rand(r.totals.salesCents)}</td><td class="num">${rand(r.totals.earnedCents)}<br><span class="mini-help">${h(String(r.percent))}%</span></td>
            <td class="num"><strong>${rand(r.totals.payableCents)}</strong></td><td class="num">${rand(r.totals.pendingCents)}</td><td class="num">${rand(r.totals.paidCents)}</td></tr>`).join('') ||
          '<tr><td colspan="8"><div class="empty">No sales reps yet — add the first one.</div></td></tr>'
        }</tbody></table>
        <p class="mini-help" style="margin-top:.75rem">Commission = the rep’s share of the order profit (what the customer paid − cost incl. VAT − delivery cost to us − Payfast fee), frozen when the order is paid and payable ${res.settings.holdHours} hours later. Orders, sales and commission follow the dates above; payable, in hold and paid are always the full balance.</p></div>
      <div class="panel sticky-panel" id="rep-editor"><p class="muted">Click <strong>+ Sales rep</strong> to register one, or click a rep to see their sales.</p></div></div>`);
    bindDates(root, list);
    $('[data-rep-new]').addEventListener('click', () => editor(root, null, list));
  }

  function editor(root, r, done) {
    setHtml(
      $('#rep-editor', root),
      `<form id="rform" class="stack gap-3"><div class="section-head"><h3>${r ? `Edit ${h(r.name)}` : 'New sales rep'}</h3></div>
      <label class="field"><span>Name</span><input name="name" required maxlength="120" value="${h(r?.name)}"></label>
      <label class="field"><span>Company (optional)</span><input name="company" maxlength="120" value="${h(r?.company)}"></label>
      <div class="grid-2"><label class="field"><span>Email (reports go here)</span><input name="email" type="email" required value="${h(r?.email)}"></label>
      <label class="field"><span>Phone</span><input name="phone" maxlength="40" value="${h(r?.phone)}"></label></div>
      <label class="field"><span>Share of the profit %</span><input name="percent" type="number" min="1" max="100" step="0.5" value="${h(r?.percent ?? 50)}"></label>
      ${r ? '' : '<div class="grid-2"><label class="field"><span>First code</span><input name="code" required maxlength="30" style="text-transform:uppercase" placeholder="e.g. 3DBYTED"></label><label class="field"><span>Campaign label (optional)</span><input name="label" maxlength="80"></label></div>'}
      <label class="field"><span>Notes (admin only)</span><textarea name="notes" rows="2" maxlength="1000">${h(r?.notes)}</textarea></label>
      ${r ? `<label class="field checkbox"><input type="checkbox" name="active" ${r.active ? 'checked' : ''}><span>Active (untick to pause: codes stop working, earned commission stays)</span></label>` : ''}
      <p class="mini-help">${r ? 'A new percentage only applies to future orders; commission already earned never changes.' : 'A welcome email with the code and link is sent to the rep (you are copied). Bank details are not stored here — you record each EFT as a payout.'}</p>
      <div class="row-card-actions"><span></span><button class="btn btn-primary">Save</button></div></form>`,
    );
    const form = $('#rform', root);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(form));
      if (r) body.active = form.active.checked;
      try {
        const saved = await api(r ? `/reps/${r.id}` : '/reps', { method: r ? 'PUT' : 'POST', body });
        toast('Saved');
        if (r) done(); else location.hash = `#/reps/${saved.id}`;
      } catch (err) { fail(err); }
    });
  }

  // ------------------------------------------------------------ one rep

  async function detail(id) {
    const r = await api(`/reps/${encodeURIComponent(id)}?${qs()}`);
    setTop('Sales reps', r.name, `<button class="btn" data-go="#/reps">← Sales reps</button>`);
    const t = r.totals;
    const root = view(`${dateBar()}
      <div class="stats">
        ${stat('Orders', String(t.orders), t.reversedOrders ? `${t.reversedOrders} cancelled` : '')}
        ${stat('Sales', rand(t.salesCents))}
        ${stat('Profit on those', rand(t.profitCents), `${r.percent}% is the rep’s`)}
        ${stat('Commission earned', rand(t.earnedCents))}
        ${stat('Payable now', rand(t.payableCents), `${rand(t.pendingCents)} still in the hold`)}
        ${stat('Paid to date', rand(t.paidCents))}
      </div>
      <div class="editor-layout">
        <div class="stack gap-4">
          <div class="panel table-wrap"><div class="section-head"><h3>Sales</h3></div><table class="catalog">
            <thead><tr><th>Date</th><th>Order</th><th>Customer</th><th>Code</th><th class="num">Order total</th><th class="num">Profit</th><th class="num">Commission</th><th>Status</th></tr></thead>
            <tbody>${
              r.commissions.map((c) => `<tr ${c.kind === 'sale' ? `data-go="#/orders/${h(c.orderId)}"` : ''}><td>${h(fmtDate(c.earnedAt))}</td><td><strong>${h(c.orderNumber)}</strong>${c.kind === 'reversal' ? '<br><span class="mini-help">deduction (order cancelled after payout)</span>' : ''}</td><td>${h(c.customer) || '—'}</td><td>${h(c.code) || '<span class="muted">repeat customer</span>'}</td>
                <td class="num">${rand(c.saleCents)}</td><td class="num">${rand(c.profitCents)}</td><td class="num"><strong>${rand(c.commissionCents)}</strong><br><span class="mini-help">${h(String(c.percent))}%</span></td>
                <td>${badge(c.status)}${c.status === 'pending' ? `<br><span class="mini-help">payable ${h(fmtDate(c.payableAt))}</span>` : ''}</td></tr>`).join('') ||
              '<tr><td colspan="8"><div class="empty">No sales in this period.</div></td></tr>'
            }</tbody></table></div>
          <div class="panel table-wrap"><div class="section-head"><h3>Payouts</h3></div><table class="catalog">
            <thead><tr><th>Date</th><th class="num">Amount</th><th>Reference</th><th>Recorded by</th></tr></thead>
            <tbody>${r.payouts.map((p) => `<tr><td>${h(fmtDate(p.paidAt))}</td><td class="num">${rand(p.amountCents)}</td><td>${h(p.reference) || '—'}${p.note ? `<br><span class="mini-help">${h(p.note)}</span>` : ''}</td><td>${h(p.createdBy)}</td></tr>`).join('') || '<tr><td colspan="4"><div class="empty">Nothing paid out yet.</div></td></tr>'}</tbody></table></div>
        </div>
        <div class="stack gap-4 editor-actions" id="rep-side">
          <div class="panel"><div class="section-head"><h3>Pay out</h3></div>
            <p>Payable now: <strong>${rand(t.payableCents)}</strong>${t.pendingCents ? `<br><span class="mini-help">${rand(t.pendingCents)} more after the ${r.settings.holdHours} h hold</span>` : ''}</p>
            <form id="payform" class="stack gap-3"><label class="field"><span>Your EFT reference</span><input name="reference" maxlength="80" placeholder="e.g. EFT 15 Oct"></label>
            <label class="field"><span>Note (shown to the rep)</span><input name="note" maxlength="300"></label>
            <button class="btn btn-primary" ${t.payableCents > 0 && t.payableCents >= r.settings.minPayoutCents ? '' : 'disabled'}>I have paid ${rand(t.payableCents)} — record it</button>
            <p class="mini-help">Make the EFT in your bank first, then record it here. The rep is emailed (you are copied). A balance that is negative (a refund after a payout) is netted off the next payout.${r.settings.minPayoutCents ? ` Minimum payout ${rand(r.settings.minPayoutCents)}.` : ''}</p></form></div>
          <div class="panel"><div class="section-head"><h3>Codes</h3></div>
            ${r.codes.map((c) => `<div class="row-card" style="margin-bottom:.6rem"><strong>${h(c.code)}</strong> ${c.active ? '' : '<span class="badge bad">Off</span>'}${c.label ? ` · ${h(c.label)}` : ''}<br><span class="mini-help">${c.orders} paid order${c.orders === 1 ? '' : 's'} · <a href="${h(c.link)}" target="_blank" rel="noopener">${h(c.link)}</a></span><br>
              <button class="btn small" data-toggle="${h(c.id)}" data-on="${c.active ? 1 : 0}">${c.active ? 'Switch off' : 'Switch on'}</button></div>`).join('')}
            <form id="codeform" class="grid-2"><input name="code" required maxlength="30" placeholder="New code" style="text-transform:uppercase"><input name="label" maxlength="80" placeholder="Campaign (optional)"><button class="btn small">Add code</button></form></div>
          <div class="panel"><div class="section-head"><h3>Details</h3></div>
            <div class="meta-list"><div><span>Email</span><a href="mailto:${h(r.email)}">${h(r.email)}</a></div>${r.phone ? `<div><span>Phone</span><span>${h(r.phone)}</span></div>` : ''}${r.company ? `<div><span>Company</span><span>${h(r.company)}</span></div>` : ''}<div><span>Share of profit</span><span>${h(String(r.percent))}%</span></div><div><span>Status</span><span>${r.active ? 'Active' : 'Paused'}</span></div></div>
            ${r.notes ? `<p class="mini-help">${h(r.notes)}</p>` : ''}
            <div class="row-card-actions"><button class="btn small" id="welcome">Resend welcome email</button><button class="btn small" id="edit">Edit</button></div>
            <div id="rep-editor"></div></div>
        </div>
      </div>`);
    bindDates(root, () => detail(id));
    $('#payform', root).addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!confirm(`Record a payout of ${rand(t.payableCents)} to ${r.name}? Only do this after the EFT was made.`)) return;
      try { await api(`/reps/${r.id}/payout`, { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); toast('Payout recorded, rep emailed'); detail(id); } catch (err) { fail(err); }
    });
    $('#codeform', root).addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api(`/reps/${r.id}/codes`, { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); toast('Code added'); detail(id); } catch (err) { fail(err); }
    });
    root.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
      try { await api(`/rep-codes/${b.dataset.toggle}`, { method: 'PUT', body: { active: b.dataset.on !== '1' } }); detail(id); } catch (err) { fail(err); }
    }));
    $('#welcome', root).addEventListener('click', async () => {
      if (!confirm(`Email the welcome message (with the code and link) to ${r.email}?`)) return;
      try { await api(`/reps/${r.id}/welcome`, { method: 'POST' }); toast('Welcome email sent'); } catch (err) { fail(err); }
    });
    $('#edit', root).addEventListener('click', () => editor(root, r, () => detail(id)));
  }

  // ------------------------------------------------------------ settings (payout rules)

  routes.reps = async (id) => (id ? detail(id) : list());

  routes['rep-settings'] = async () => {
    setTop('Sales', 'Rep payout rules');
    const s = await api('/rep-settings');
    const root = view(`<div class="panel" style="max-width:32rem"><form id="sform" class="stack gap-3">
      <label class="field"><span>Hold before commission is payable (hours)</span><input name="holdHours" type="number" min="0" max="1440" value="${h(s.holdHours)}"></label>
      <label class="field"><span>Minimum payout (R)</span><input name="minPayoutRand" type="number" min="0" step="0.01" value="${h((s.minPayoutCents / 100).toFixed(2))}"></label>
      <p class="mini-help">The hold applies to commission earned from now on. A payout is only possible once the payable balance reaches the minimum (R0 = any amount).</p>
      <button class="btn btn-primary">Save</button></form></div>`);
    $('#sform', root).addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('/rep-settings', { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) }); toast('Saved'); } catch (err) { fail(err); }
    });
  };
}
