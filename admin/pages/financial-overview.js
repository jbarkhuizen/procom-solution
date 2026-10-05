// Admin -> Financial overview: income, costs and profit per month (South
// African time) and for any date range, from paid orders + expenses captured
// by hand. Numbers come from GET /api/admin/finance/overview
// (server/features/finance.js, where the rules are documented).
// Every dynamic value goes through kit.h() before kit.view()/kit.setTop().

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (ym) => {
  const [y, m] = String(ym || '').split('-');
  return MONTHS[Number(m) - 1] ? `${MONTHS[Number(m) - 1]} ${y}` : ym;
};
const todaySast = () => new Date(Date.now() + 2 * 3600 * 1000).toISOString().slice(0, 10);
const shiftMonth = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};
const lastDay = (ym) => new Date(Date.parse(`${shiftMonth(ym, 1)}-01T00:00:00Z`) - 86400000).toISOString().slice(0, 10);

const PRESETS = {
  last12: ['Last 12 months', (t) => [`${shiftMonth(t.slice(0, 7), -11)}-01`, t]],
  'this-month': ['This month', (t) => [`${t.slice(0, 7)}-01`, t]],
  'last-month': ['Last month', (t) => { const m = shiftMonth(t.slice(0, 7), -1); return [`${m}-01`, lastDay(m)]; }],
  'tax-year': ['This tax year (from 1 March)', (t) => [`${Number(t.slice(5, 7)) >= 3 ? t.slice(0, 4) : Number(t.slice(0, 4)) - 1}-03-01`, t]],
  'calendar-year': ['This calendar year', (t) => [`${t.slice(0, 4)}-01-01`, t]],
  custom: ['Custom dates', null],
};

const state = { preset: 'last12', from: '', to: '' };

const costsOf = (m) => m.cogsCents + m.deliveryCostCents + m.payfastFeesCents + m.expensesCents;
const pctText = (v) => (v == null ? '—' : `${v.toFixed(1)}%`);

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function downloadCsv(name, rows) {
  const csv = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Grouped bars (income vs all costs) with a profit line, in admin.css colours.
// The Month by month table below is its text alternative.
function monthChart(months, h, rand) {
  if (!months.length) return '<p class="muted">No months in this range.</p>';
  const W = 720;
  const H = 230;
  const top = 12;
  const bottom = 24;
  const hi = Math.max(1, ...months.map((m) => Math.max(m.incomeCents, costsOf(m), m.profitCents)));
  const lo = Math.min(0, ...months.map((m) => m.profitCents));
  const y = (v) => top + ((hi - v) / (hi - lo)) * (H - top - bottom);
  const gw = W / months.length;
  const bw = Math.max(3, Math.min(24, gw * 0.3));
  const every = Math.ceil(months.length / 12);
  const zero = y(0);
  const groups = months.map((m, i) => {
    const cx = i * gw + gw / 2;
    const bar = (x, v, fill) => {
      const yy = y(Math.max(0, v));
      return `<rect x="${(x).toFixed(1)}" y="${yy.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, zero - yy).toFixed(1)}" rx="2" style="fill:${fill}"></rect>`;
    };
    const label = i % every === 0 ? `<text x="${cx.toFixed(1)}" y="${H - 6}" text-anchor="middle" style="fill:var(--muted);font-size:11px">${h(monthLabel(m.month).replace(' 20', " '"))}</text>` : '';
    return `<g><title>${h(monthLabel(m.month))} — income ${h(rand(m.incomeCents))}, costs ${h(rand(costsOf(m)))}, profit ${h(rand(m.profitCents))}</title>
      <rect x="${(i * gw).toFixed(1)}" y="0" width="${gw.toFixed(1)}" height="${H - bottom}" style="fill:transparent"></rect>
      ${bar(cx - bw - 1, m.incomeCents, 'var(--brand)')}${bar(cx + 1, costsOf(m), 'color-mix(in srgb, var(--muted) 45%, transparent)')}${label}</g>`;
  });
  const pts = months.map((m, i) => `${(i * gw + gw / 2).toFixed(1)},${y(m.profitCents).toFixed(1)}`);
  const dots = months.map((m, i) => `<circle cx="${(i * gw + gw / 2).toFixed(1)}" cy="${y(m.profitCents).toFixed(1)}" r="3.5" style="fill:${m.profitCents < 0 ? 'var(--danger)' : 'var(--ok)'}"></circle>`).join('');
  const sw = (c) => `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${c};vertical-align:-1px"></span>`;
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block" role="img" aria-labelledby="fo-chart-title fo-chart-desc">
      <title id="fo-chart-title">Income, costs and profit per month</title>
      <desc id="fo-chart-desc">Bars show income and total costs for each month; the line shows profit. The same figures are in the Month by month table.</desc>
      <line x1="0" x2="${W}" y1="${zero.toFixed(1)}" y2="${zero.toFixed(1)}" style="stroke:var(--line);stroke-width:1"></line>
      ${groups.join('')}
      <polyline points="${pts.join(' ')}" style="fill:none;stroke:var(--ok);stroke-width:2;stroke-linejoin:round"></polyline>${dots}
    </svg>
    <p class="mini-help">${sw('var(--brand)')} Income · ${sw('color-mix(in srgb, var(--muted) 45%, transparent)')} Costs (goods, delivery, Payfast fees, expenses) · ${sw('var(--ok)')} Profit (red dot = a loss). Hover a month for the figures.</p>`;
}

const ROWS = [
  ['orders', 'Paid orders', false],
  ['goodsCents', 'Goods sold (after discounts)'],
  ['deliveryChargedCents', 'Delivery charged'],
  ['incomeCents', 'Income (money received)'],
  ['cogsCents', 'Cost of goods (incl supplier VAT)'],
  ['deliveryCostCents', 'Delivery cost'],
  ['payfastFeesCents', 'Payfast fees'],
  ['expensesCents', 'Expenses'],
  ['profitCents', 'Profit'],
];

export default function register(routes, kit) {
  const { $, h, rand, api, toast, fail, view, setTop } = kit;
  const money = (v, strong = false) => `<span style="${v < 0 ? 'color:var(--danger);' : ''}${strong ? 'font-weight:700' : ''}">${rand(v)}</span>`;

  routes['financial-overview'] = async () => {
    const q = state.preset === 'custom' || state.from ? { from: state.from, to: state.to } : {};
    const [d, overrides] = await Promise.all([api(`/finance/overview?${new URLSearchParams(q)}`), api('/finance/delivery-costs')]);
    state.from = d.from;
    state.to = d.to;
    const t = d.totals;
    const fees = d.assumptions.payfastFees;

    setTop('Financial', 'Financial overview', '<button class="btn btn-primary" data-fo="csv">Export CSV</button>');

    const cmp = d.compare;
    const change = (a, b) => {
      if (!b) return '<span class="muted">—</span>';
      const p = ((a - b) / Math.abs(b)) * 100;
      return `<span style="color:${p >= 0 ? 'var(--ok)' : 'var(--danger)'}">${p >= 0 ? '▲' : '▼'} ${h(Math.abs(p).toFixed(0))}%</span>`;
    };
    const cmpRows = ROWS.map(([k, label, isMoney = true]) => {
      const a = cmp.thisMonth[k];
      const b = cmp.lastMonth[k];
      const better = k === 'orders' || k.startsWith('goods') || k.startsWith('income') || k.startsWith('profit') || k === 'deliveryChargedCents';
      return `<tr${k === 'profitCents' ? ' style="font-weight:700"' : ''}><td style="white-space:nowrap">${h(label)}</td><td class="num">${isMoney ? money(a) : h(a)}</td><td class="num">${isMoney ? money(b) : h(b)}</td><td class="num">${better ? change(a, b) : '<span class="muted">—</span>'}</td></tr>`;
    }).join('');

    const monthRows = [...d.months].reverse().map((m) => `<tr>
        <td style="white-space:nowrap">${h(monthLabel(m.month))}</td><td class="num">${h(m.orders)}</td><td class="num">${rand(m.goodsCents)}</td><td class="num">${rand(m.deliveryChargedCents)}</td>
        <td class="num"><strong>${rand(m.incomeCents)}</strong></td><td class="num">${rand(m.cogsCents)}</td><td class="num">${rand(m.deliveryCostCents)}</td>
        <td class="num">${rand(m.payfastFeesCents)}</td><td class="num">${rand(m.expensesCents)}</td><td class="num">${money(m.profitCents, true)}</td><td class="num">${h(pctText(m.grossMarginPct))}</td>
      </tr>`).join('');
    const totalRow = `<tr style="font-weight:700;border-top:2px solid var(--line)"><td>Total</td><td class="num">${h(t.orders)}</td><td class="num">${rand(t.goodsCents)}</td><td class="num">${rand(t.deliveryChargedCents)}</td>
      <td class="num">${rand(t.incomeCents)}</td><td class="num">${rand(t.cogsCents)}</td><td class="num">${rand(t.deliveryCostCents)}</td><td class="num">${rand(t.payfastFeesCents)}</td>
      <td class="num">${rand(t.expensesCents)}</td><td class="num">${money(t.profitCents)}</td><td class="num">${h(pctText(t.grossMarginPct))}</td></tr>`;

    const ytdRows = [d.ytd.calendar, d.ytd.taxYear].map((y) => `<tr><td style="white-space:nowrap">${h(y.label)}<br><span class="muted">${h(y.from)} → ${h(y.to)}</span></td>
      <td class="num">${h(y.orders)}</td><td class="num">${rand(y.incomeCents)}</td><td class="num">${rand(y.cogsCents + y.deliveryCostCents + y.payfastFeesCents)}</td>
      <td class="num">${rand(y.expensesCents)}</td><td class="num">${money(y.profitCents, true)}</td><td class="num">${h(pctText(y.grossMarginPct))}</td></tr>`).join('');

    const maxCat = Math.max(1, ...d.expensesByCategory.map((c) => c.totalCents));
    const catRows = d.expensesByCategory.map((c) => `<tr><td>${h(c.category)}</td>
      <td style="width:45%"><div style="background:color-mix(in srgb, var(--brand) 35%, var(--line));height:10px;border-radius:3px;width:${Math.max(2, Math.round((c.totalCents / maxCat) * 100))}%"></div></td>
      <td class="num">${rand(c.totalCents)}</td></tr>`).join('');

    const overrideRows = overrides.map((o) => `<tr><td><a href="#/orders/${h(encodeURIComponent(o.orderId))}">${h(o.orderNumber)}</a></td><td class="num">${rand(o.deliveryChargedCents)}</td><td class="num">${rand(o.ruleCostCents)}</td><td class="num"><strong>${rand(o.costCents)}</strong></td><td>${h(o.note)}</td><td><button class="btn small" data-override-del="${h(o.orderNumber)}">Remove</button></td></tr>`).join('');

    // Fee on R1,000 incl VAT (when Payfast adds VAT), so methods compare at a glance.
    const vatF = fees.addVat ? 1 + d.assumptions.vatRatePct / 100 : 1;
    const on1000 = (m) => ((1000 * m.pct) / 100 + m.fixedCents / 100) * vatF;
    const rnum = (cents) => (cents / 100).toFixed(2);
    const methodRows = fees.methods.map((m) => `<tr data-method="${h(m.key)}">
        <td><input type="checkbox" data-f="enabled" ${m.enabled ? 'checked' : ''} aria-label="${h(m.name)} switched on"></td>
        <td>${h(m.name)}</td>
        <td><input type="number" min="0" step="0.01" data-f="fixedCents" value="${h(rnum(m.fixedCents))}" style="width:5.5rem"></td>
        <td><input type="number" min="0" max="20" step="0.01" data-f="pct" value="${h(m.pct)}" style="width:5rem"></td>
        <td><input type="number" min="0" step="0.01" data-f="minCents" value="${h(rnum(m.minCents))}" style="width:6rem"></td>
        <td><input type="number" min="0" step="0.01" data-f="maxCents" value="${h(rnum(m.maxCents))}" style="width:8rem"></td>
        <td class="num">R${h(on1000(m).toFixed(2))}</td></tr>`).join('');
    const methodOptions = (sel) => fees.methods.map((m) => `<option value="${h(m.key)}" ${m.key === sel ? 'selected' : ''}>${h(m.name)}</option>`).join('');

    const root = view(`
      <div class="toolbar">
        <select id="fo-preset" aria-label="Date range">${Object.entries(PRESETS).map(([k, [label]]) => `<option value="${h(k)}" ${k === state.preset ? 'selected' : ''}>${h(label)}</option>`).join('')}</select>
        <label class="field"><span>From</span><input id="fo-from" type="date" value="${h(d.from)}"></label>
        <label class="field"><span>To</span><input id="fo-to" type="date" value="${h(d.to)}"></label>
        <span class="muted">${h(d.from)} → ${h(d.to)} (South African time)</span>
      </div>

      <div class="stats">
        <div class="stat-card"><div class="label">Income · ${h(t.orders)} paid order${t.orders === 1 ? '' : 's'}</div><div class="value">${rand(t.incomeCents)}</div></div>
        <div class="stat-card"><div class="label">All costs + expenses</div><div class="value">${rand(costsOf(t))}</div></div>
        <div class="stat-card"><div class="label">Profit${t.profitMarginPct == null ? '' : ` · ${h(pctText(t.profitMarginPct))} of income`}</div><div class="value" style="${t.profitCents < 0 ? 'color:var(--danger)' : ''}">${rand(t.profitCents)}</div></div>
        <div class="stat-card"><div class="label">Gross margin on goods</div><div class="value">${h(pctText(t.grossMarginPct))}</div></div>
      </div>

      ${t.cancelledOrders ? `<div class="panel" style="margin-bottom:1rem"><p style="margin:0"><span class="badge bad">Cancelled</span> <strong>${h(t.cancelledOrders)} paid order${t.cancelledOrders === 1 ? ' was' : 's were'} cancelled</strong> in this range (${rand(t.cancelledCents)}). ${t.cancelledOrders === 1 ? 'It is' : 'They are'} left out of every figure on this page — make sure the money was refunded in Payfast.
        ${d.cancelled.slice(0, 10).map((c) => `<a href="#/orders/${h(encodeURIComponent(c.id))}">${h(c.orderNumber)}</a>`).join(', ')}</p></div>` : ''}

      <div class="panel" style="margin-bottom:1rem">
        <div class="section-head"><h3>Income, costs and profit by month</h3></div>
        ${monthChart(d.months, h, rand)}
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(min(100%, 440px), 1fr));gap:0.75rem;align-items:start;margin-bottom:1rem">
        <div class="panel table-wrap" style="min-width:0">
          <div class="section-head"><h3>This month vs last month</h3></div>
          <table class="catalog"><thead><tr><th></th><th class="num">${h(monthLabel(cmp.thisMonth.label))}<br><span class="muted">to ${h(cmp.thisMonth.to)}</span></th><th class="num">${h(monthLabel(cmp.lastMonth.label))}</th><th class="num">Change</th></tr></thead><tbody>${cmpRows}</tbody></table>
        </div>
        <div class="stack gap-3" style="min-width:0">
          <div class="panel table-wrap">
            <div class="section-head"><h3>Year to date</h3></div>
            <table class="catalog"><thead><tr><th>Period</th><th class="num">Orders</th><th class="num">Income</th><th class="num">Goods, delivery &amp; fees</th><th class="num">Expenses</th><th class="num">Profit</th><th class="num">Gross margin</th></tr></thead><tbody>${ytdRows}</tbody></table>
          </div>
          <div class="panel table-wrap">
            <div class="section-head"><h3>Expenses by category</h3><a class="btn small" href="#/expenses" style="text-decoration:none;color:inherit">Expenses</a></div>
            <table class="catalog"><tbody>${catRows || '<tr><td class="empty">No expenses captured in this range.</td></tr>'}</tbody></table>
          </div>
        </div>
      </div>

      <div class="panel table-wrap" style="margin-bottom:1rem">
        <div class="section-head"><h3>Month by month</h3><span class="muted">newest first</span></div>
        <table class="catalog" id="fo-months">
          <thead><tr><th>Month</th><th class="num">Orders</th><th class="num">Goods</th><th class="num">Delivery charged</th><th class="num">Income</th><th class="num">Cost of goods</th><th class="num">Delivery cost</th><th class="num">Payfast fees</th><th class="num">Expenses</th><th class="num">Profit</th><th class="num">Gross margin</th></tr></thead>
          <tbody>${monthRows}${totalRow}</tbody>
        </table>
      </div>

      <details class="panel" style="margin-bottom:1rem" open>
        <summary style="cursor:pointer;font-weight:700">How these numbers are worked out</summary>
        <ul class="mini-help" style="line-height:1.6;margin-top:0.6rem">
          <li><strong>Income</strong> = paid orders, counted on the day Payfast confirmed payment (South African time). Goods = what the items sold for after promo discounts; delivery charged = what customers paid for delivery. Unpaid and <strong>cancelled</strong> orders are left out.</li>
          <li><strong>Cost of goods</strong> = the supplier cost on each order line × quantity, <strong>plus ${h(d.assumptions.vatRatePct)}% VAT</strong> — supplier prices exclude VAT, and because Procom is not VAT-registered, the VAT we pay the supplier is a cost.</li>
          <li><strong>Delivery cost</strong> = what the courier costs us: the "courier cost to us" set per supplier (SMD R150, while customers pay R157 to cover the Payfast fee) or per shipping option (blank = the price charged), and nothing when the order qualified for free delivery (same R5,000 rule). Collections cost R0. Orders placed before 2 Oct 2026 count the fee charged. Where a real cost differs, set it per order below${d.assumptions.deliveryOverrides ? ` (${h(d.assumptions.deliveryOverrides)} set)` : ''}.</li>
          <li><strong>Payfast fees</strong> = the <strong>actual fee Payfast reports</strong> with each payment (${h(d.assumptions.actualFeeOrders || 0)} paid order${d.assumptions.actualFeeOrders === 1 ? '' : 's'} so far). For older orders it is an <strong>estimate</strong>: card orders at ${h(fees.card.name)} (${h(fees.card.pct)}% + ${rand(fees.card.fixedCents)}), Instant EFT at ${h(fees.eft.name)} (${h(fees.eft.pct)}%${fees.eft.fixedCents ? ` + ${rand(fees.eft.fixedCents)}` : ''})${fees.addVat ? ', plus VAT on the fee' : ''}. Set the rates below from your Payfast dashboard (Settings → Payment methods).</li>
          <li><strong>Expenses</strong> = what you captured on the Expenses page, by expense date.</li>
          <li><strong>Profit</strong> = income − cost of goods − delivery cost − Payfast fees − expenses. <strong>Gross margin</strong> = (goods − cost of goods) ÷ goods.</li>
        </ul>
      </details>

      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(min(100%, 440px), 1fr));gap:0.75rem;align-items:start">
        <form class="panel stack gap-3" id="fo-fees" style="min-width:0">
          <div class="section-head"><h3>Payfast payment methods &amp; fees</h3><span class="badge">copy from your Payfast dashboard</span></div>
          <p class="mini-help" style="margin:0">Fees as Payfast shows them (excluding VAT). Tick the methods switched on in Payfast. Min/max = the order amounts Payfast accepts for that method. <strong>Instant EFT</strong> is offered at checkout only while it is ticked here (and switch it on in Payfast too). The margin check in Site settings uses the dearest method that is switched on: <strong>${h(fees.pricing.name)}</strong> (R${h(on1000(fees.pricing).toFixed(2))} on R1,000).</p>
          <div class="table-wrap"><table class="catalog" id="fo-methods"><thead><tr><th>On</th><th>Method</th><th>Fixed (R)</th><th>%</th><th>Min order (R)</th><th>Max order (R)</th><th class="num">Fee on R1,000${fees.addVat ? ' incl VAT' : ''}</th></tr></thead><tbody>${methodRows}</tbody></table></div>
          <div class="grid-3">
            <label class="field"><span>Estimate card orders with</span><select id="fo-card-method">${methodOptions(fees.cardMethod)}</select></label>
            <label class="field"><span>Estimate Instant EFT orders with</span><select id="fo-eft-method">${methodOptions(fees.eftMethod)}</select></label>
          </div>
          <p class="mini-help" style="margin:0">Estimates are only used when Payfast didn't report the actual fee (orders paid before 29 Sept 2026). On the Payfast page the customer may choose any card-type method (credit, debit, Apple/Google/Samsung Pay, SnapScan, Zapper, QR).</p>
          <label class="field checkbox"><input type="checkbox" id="fo-addvat" ${fees.addVat ? 'checked' : ''}><span>Payfast adds VAT to its fees (we can't claim it back)</span></label>
          <div><button class="btn btn-primary" type="submit">Save Payfast fees</button></div>
        </form>
        <div class="panel stack gap-3" style="min-width:0">
          <div class="section-head"><h3>Actual delivery cost for an order</h3></div>
          <p class="mini-help" style="margin:0">Only needed when a courier charged something different from what the customer paid (e.g. a quoted delivery or a re-delivery). Leave the amount empty to go back to the rule.</p>
          <form id="fo-override" class="grid-3" style="align-items:end">
            <label class="field"><span>Order number</span><input name="order" placeholder="PC10001" required></label>
            <label class="field"><span>Actual cost (R)</span><input name="cost" type="number" min="0" step="0.01"></label>
            <label class="field"><span>Note</span><input name="note" maxlength="300" placeholder="e.g. courier invoice 123"></label>
            <div><button class="btn" type="submit">Save</button></div>
          </form>
          ${overrides.length ? `<div class="table-wrap"><table class="catalog"><thead><tr><th>Order</th><th class="num">Charged</th><th class="num">Rule</th><th class="num">Actual</th><th>Note</th><th></th></tr></thead><tbody>${overrideRows}</tbody></table></div>` : '<p class="muted" style="margin:0">No per-order delivery costs set.</p>'}
        </div>
      </div>`);

    const reload = () => routes['financial-overview']().catch(fail);
    $('#fo-preset', root).addEventListener('change', (e) => {
      state.preset = e.target.value;
      const fn = PRESETS[state.preset][1];
      if (fn) [state.from, state.to] = fn(todaySast());
      reload();
    });
    for (const id of ['#fo-from', '#fo-to']) {
      $(id, root).addEventListener('change', () => {
        state.preset = 'custom';
        state.from = $('#fo-from', root).value;
        state.to = $('#fo-to', root).value;
        reload();
      });
    }

    $('#fo-fees', root).addEventListener('submit', async (e) => {
      e.preventDefault();
      const methods = [...root.querySelectorAll('#fo-methods tr[data-method]')].map((tr) => {
        const m = { key: tr.dataset.method };
        for (const input of tr.querySelectorAll('[data-f]')) {
          const f = input.dataset.f;
          m[f] = f === 'enabled' ? input.checked : f === 'pct' ? Number(input.value || 0) : Math.round(Number(input.value || 0) * 100);
        }
        return m;
      });
      const payfastFees = { methods, cardMethod: $('#fo-card-method', root).value, eftMethod: $('#fo-eft-method', root).value, addVat: $('#fo-addvat', root).checked };
      try {
        await api('/finance/settings', { method: 'PUT', body: { payfastFees } });
        toast('Payfast fees saved');
        reload();
      } catch (err) { fail(err); }
    });

    $('#fo-override', root).addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const cost = String(fd.get('cost') || '').trim();
      try {
        const r = await api(`/finance/delivery-costs/${encodeURIComponent(String(fd.get('order')).trim())}`, { method: 'PUT', body: { costCents: cost === '' ? null : Math.round(Number(cost) * 100), note: fd.get('note') } });
        toast(r.removed ? `${r.orderNumber}: back to the delivery rule` : `${r.orderNumber}: delivery cost saved`);
        reload();
      } catch (err) { fail(err); }
    });
    root.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-override-del]');
      if (!b) return;
      try {
        await api(`/finance/delivery-costs/${encodeURIComponent(b.dataset.overrideDel)}`, { method: 'DELETE' });
        toast('Removed');
        reload();
      } catch (err) { fail(err); }
    });

    $('[data-fo="csv"]')?.addEventListener('click', () => {
      const head = ['Month', 'Paid orders', 'Goods (R)', 'Delivery charged (R)', 'Income (R)', 'Cost of goods incl VAT (R)', 'Delivery cost (R)', 'Payfast fees (R)', 'Expenses (R)', 'Profit (R)', 'Gross margin %', 'Cancelled orders', 'Cancelled (R)'];
      const r2 = (c) => ((Number(c) || 0) / 100).toFixed(2);
      const line = (label, m) => [label, m.orders, r2(m.goodsCents), r2(m.deliveryChargedCents), r2(m.incomeCents), r2(m.cogsCents), r2(m.deliveryCostCents), r2(m.payfastFeesCents), r2(m.expensesCents), r2(m.profitCents), m.grossMarginPct ?? '', m.cancelledOrders, r2(m.cancelledCents)];
      downloadCsv(`financial-overview-${d.from}-to-${d.to}.csv`, [head, ...d.months.map((m) => line(m.month, m)), line('Total', t)]);
    });
  };
}
