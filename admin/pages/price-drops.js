// Admin -> Marketing -> Price drops. See server/features/pricedrops.js.
// Products whose shop price came down after a supplier sync are listed on the
// storefront "Price drops" page automatically; here the owner sees the
// supplier's prices next to hers (Payfast fee, profit, floor), hides or pins a
// drop, and sets the rules. Every dynamic value goes through kit.h().

const CURRENT = new Set(['live', 'sold_out', 'hidden', 'inactive']);
const STATE = {
  live: ['On the page', 'ok'],
  sold_out: ['Sold out (greyed)', 'bad'],
  hidden: ['Hidden by me', 'neutral'],
  inactive: ['Product hidden', 'neutral'],
  back_to_normal: ['Back to normal price', 'neutral'],
  expired: ['Expired', 'neutral'],
  too_small: ['Drop too small now', 'neutral'],
  removed: ['Product removed', 'neutral'],
};
let filter = 'current';
let supplierFilter = '';

export default function register(routes, kit) {
  const { $, $$, h, rand, api, toast, fail, view, setTop, fmtDate } = kit;
  const signed = (cents) => `${cents > 0 ? '+' : cents < 0 ? '−' : ''}${rand(Math.abs(cents))}`;
  const pct = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)}%`;
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short' }) : '—');

  const badge = (r) => {
    const [label, cls] = STATE[r.state] || [r.state, 'neutral'];
    const big = r.state === 'live' && r.changePct <= -50 ? ' <span class="badge warn">Big drop, check</span>' : '';
    return `<span class="badge ${cls}">${h(label)}</span>${r.pinned ? ' <span class="badge info">Pinned</span>' : ''}${big}`;
  };

  const rowHtml = (r) => {
    const open = CURRENT.has(r.state) && !r.endedAt;
    const dim = r.state === 'hidden' || !CURRENT.has(r.state) ? ' style="opacity:.6"' : '';
    return `<tr${dim}>
      <td><input type="checkbox" data-pick="${h(r.id)}" ${open ? '' : 'disabled'}></td>
      <td>${r.image ? `<img src="${h(r.image)}" alt="" style="width:40px;height:40px;object-fit:contain">` : ''}</td>
      <td><strong>${h(r.name)}</strong><br><span class="mini-help">${h(r.sku)} · ${h(r.category)}${r.supplier ? ` · ${h(r.supplier)}` : ''} · detected ${h(fmtDate(r.detectedAt))}</span></td>
      <td class="num">${rand(r.costWasCents)}</td>
      <td class="num">${rand(r.costNowCents)}</td>
      <td class="num">${rand(r.costNowIncVatCents)}</td>
      <td class="num">${signed(r.costChangeCents)}<br><span class="mini-help">${pct(r.costChangePct)}</span></td>
      <td class="num"><s>${rand(r.wasCents)}</s></td>
      <td class="num"><strong>${rand(r.nowCents)}</strong></td>
      <td class="num">${signed(r.changeCents)}<br><span class="mini-help">${pct(r.changePct)}</span></td>
      <td class="num">${rand(r.feeCents)}</td>
      <td class="num"${r.profitCents < 0 ? ' style="color:var(--danger);font-weight:700"' : ''}>${rand(r.profitCents)}<br><span class="mini-help">${h(r.profitPct)}%</span></td>
      <td class="num">${rand(r.floorCents)}</td>
      <td class="num">${r.stock == null ? '—' : h(r.stock)}</td>
      <td>${r.pinned ? 'Pinned' : h(day(r.expiresAt))}</td>
      <td>${badge(r)}</td>
      <td style="white-space:nowrap">${open ? `<button class="btn small" data-hide="${h(r.id)}" data-to="${r.hidden ? 0 : 1}">${r.hidden ? 'Show' : 'Hide'}</button> <button class="btn small" data-pin="${h(r.id)}" data-to="${r.pinned ? 0 : 1}">${r.pinned ? 'Unpin' : 'Pin'}</button>` : `<span class="mini-help">${h(day(r.endedAt))}</span>`}</td>
    </tr>`;
  };

  const csv = (rows) => {
    const cols = [['SKU', (r) => r.sku], ['Product', (r) => r.name], ['Category', (r) => r.category], ['Supplier', (r) => r.supplier], ['Status', (r) => (STATE[r.state] || [r.state])[0]],
      ['Cost was', (r) => r.costWasCents / 100], ['Cost now', (r) => r.costNowCents / 100], ['Cost now incl VAT', (r) => r.costNowIncVatCents / 100],
      ['Price was', (r) => r.wasCents / 100], ['Price now', (r) => r.nowCents / 100], ['Change %', (r) => r.changePct], ['Payfast fee', (r) => r.feeCents / 100],
      ['Profit', (r) => r.profitCents / 100], ['Floor', (r) => r.floorCents / 100], ['Stock', (r) => (r.stock == null ? '' : r.stock)], ['Detected', (r) => r.detectedAt]];
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    return [cols.map((c) => q(c[0])).join(','), ...rows.map((r) => cols.map((c) => q(c[1](r))).join(','))].join('\r\n');
  };

  routes['price-drops'] = async () => {
    setTop('Marketing', 'Price drops');
    const { settings, items } = await api('/price-drops');
    const live = items.filter((r) => CURRENT.has(r.state) && !r.endedAt);
    const count = (st) => items.filter((r) => st.includes(r.state)).length;
    const suppliers = [...new Set(items.map((r) => r.supplier).filter(Boolean))].sort();
    const shown = items.filter((r) => (filter === 'current' ? CURRENT.has(r.state) : filter === 'page' ? r.state === 'live' : filter === 'sold_out' ? r.state === 'sold_out' : filter === 'hidden' ? r.state === 'hidden' : !CURRENT.has(r.state))
      && (!supplierFilter || r.supplier === supplierFilter));
    const chip = (key, label, n) => `<button class="btn small ${filter === key ? 'btn-primary' : ''}" data-filter="${key}">${h(label)} ${h(n)}</button>`;
    const root = view(`
      <p class="mini-help" style="margin-bottom:.75rem">Products whose shop price came down after a supplier update appear on the <a href="/price-drops.html" target="_blank" rel="noopener">Price drops page</a> by themselves. A drop comes off the page the moment the price is back at (or above) the price it was, when its days run out, or when you hide it — checked live, not only after a supplier update. Prices are the normal pricing-rule prices (supplier cost + VAT, markup, R10 minimum profit); nothing here changes a price. Hide stops a drop showing; Pin keeps it past the days limit.</p>
      <div class="panel"><h3 style="margin:0 0 .6rem">Rules for the storefront page</h3>
        <div class="form-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:.8rem;align-items:end">
          <label>Show the page<select id="pd-on"><option value="1" ${settings.on ? 'selected' : ''}>On</option><option value="0" ${settings.on ? '' : 'selected'}>Off</option></select></label>
          <label>Smallest drop (%)<input id="pd-pct" type="number" min="0" max="100" step="0.5" value="${h(settings.minPct)}"></label>
          <label>and smallest drop (R)<input id="pd-rand" type="number" min="0" step="1" value="${h(settings.minRand)}"></label>
          <label>Keep a drop on the page (days)<input id="pd-days" type="number" min="1" max="90" step="1" value="${h(settings.days)}"></label>
          <div><button class="btn btn-primary" id="pd-save">Save rules</button></div>
        </div>
        <p class="mini-help" style="margin:.6rem 0 0">New drops go live automatically after each supplier update. Sold-out items stay on the page, greyed out, until they expire or the price goes back up.</p>
      </div>
      <div class="panel" style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
        ${chip('current', 'Current', count([...CURRENT]))}${chip('page', 'On the page', count(['live']))}${chip('sold_out', 'Sold out', count(['sold_out']))}${chip('hidden', 'Hidden by me', count(['hidden']))}${chip('history', 'History (30 days)', items.length - count([...CURRENT]))}
        <select id="pd-supplier"><option value="">Supplier: all</option>${suppliers.map((s) => `<option ${s === supplierFilter ? 'selected' : ''}>${h(s)}</option>`).join('')}</select>
        <span style="flex:1"></span>
        <button class="btn small" data-bulk="hide">Hide selected</button><button class="btn small" data-bulk="show">Show selected</button><button class="btn small" data-bulk="pin">Pin selected</button><button class="btn small" id="pd-csv">Export CSV</button>
      </div>
      <p class="mini-help" style="margin:0 0 .4rem"><span class="badge info">Supplier</span> columns are the supplier's cost excl VAT unless stated · <span class="badge warn">My pricing</span> columns are what customers pay. Floor = supplier cost incl VAT + the Payfast fee (worst case). Profit = price now − cost incl VAT − Payfast fee.</p>
      <div class="panel table-wrap" style="padding:0;overflow:auto"><table class="catalog" style="min-width:1700px">
        <thead>
          <tr><th colspan="3"></th><th colspan="4" style="text-align:center;background:rgb(223 230 238/.5)">SUPPLIER</th><th colspan="6" style="text-align:center;background:rgb(233 227 207/.7)">MY PRICING</th><th colspan="5"></th></tr>
          <tr><th></th><th></th><th>Product</th><th class="num">Cost was</th><th class="num">Cost now</th><th class="num">Cost now incl VAT</th><th class="num">Cost change</th>
            <th class="num">Price was</th><th class="num">Price now</th><th class="num">Change</th><th class="num">Payfast fee</th><th class="num">Profit</th><th class="num">Floor</th>
            <th class="num">Stock</th><th>Expires</th><th>Status</th><th>${filter === 'history' ? 'Ended' : 'Actions'}</th></tr>
        </thead>
        <tbody>${shown.map(rowHtml).join('') || `<tr><td colspan="17" class="empty">${live.length || items.length ? 'Nothing in this list.' : 'No price drops yet. They appear here after the next supplier update (06:00 / 06:30, 12:00 / 12:30, 18:00 / 18:30).'}</td></tr>`}</tbody>
      </table></div>`);

    $$('[data-filter]', root).forEach((b) => b.addEventListener('click', () => { filter = b.dataset.filter; routes['price-drops'](); }));
    $('#pd-supplier', root).addEventListener('change', (e) => { supplierFilter = e.target.value; routes['price-drops'](); });
    $('#pd-save', root).addEventListener('click', async () => {
      try {
        await api('/price-drops/settings', { method: 'PUT', body: { on: $('#pd-on', root).value === '1', minPct: Number($('#pd-pct', root).value), minRand: Number($('#pd-rand', root).value), days: Number($('#pd-days', root).value) } });
        toast('Rules saved');
        routes['price-drops']();
      } catch (err) { fail(err); }
    });
    root.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-hide],[data-pin]');
      if (!b) return;
      try {
        await api(`/price-drops/${b.dataset.hide || b.dataset.pin}`, { method: 'PATCH', body: b.dataset.hide ? { hidden: b.dataset.to === '1' } : { pinned: b.dataset.to === '1' } });
        routes['price-drops']();
      } catch (err) { fail(err); }
    });
    $$('[data-bulk]', root).forEach((b) => b.addEventListener('click', async () => {
      const ids = $$('[data-pick]:checked', root).map((c) => Number(c.dataset.pick));
      if (!ids.length) return toast('Tick the rows first', true);
      try {
        const r = await api('/price-drops/bulk', { method: 'POST', body: { ids, action: b.dataset.bulk } });
        toast(`${r.updated} updated`);
        routes['price-drops']();
      } catch (err) { fail(err); }
    }));
    $('#pd-csv', root).addEventListener('click', () => {
      const url = URL.createObjectURL(new Blob([`﻿${csv(shown)}`], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `price-drops-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    });
  };
}
