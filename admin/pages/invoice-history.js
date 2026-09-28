// Admin -> Invoice history: every issued invoice (numbered when Payfast
// confirms payment), with search, a date filter, monthly totals, CSV export
// and a one-off "Issue missing invoices" for orders paid before invoicing.
// Every dynamic value goes through kit.h() before kit.view()/kit.setTop().

const state = { q: '', from: '', to: '' };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (ym) => {
  const [y, m] = String(ym || '').split('-');
  return MONTHS[Number(m) - 1] ? `${MONTHS[Number(m) - 1]} ${y}` : ym;
};
const invoiceDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-ZA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Africa/Johannesburg' }) : '');

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(items) {
  const head = ['Invoice', 'Date', 'Order', 'Customer', 'Email', 'Discount (R)', 'Delivery (R)', 'Total (R)', 'Payment', 'Paid', 'Payfast ref', 'Status'];
  const rands = (c) => ((Number(c) || 0) / 100).toFixed(2);
  const rows = items.map((i) => [i.invoiceNumber, invoiceDate(i.invoicedAt), i.orderNumber, i.customer, i.email, rands(i.discountCents), rands(i.deliveryCents), rands(i.totalCents), i.paymentLabel, invoiceDate(i.paidAt), i.paymentReference, i.status]);
  const csv = [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }); // BOM: Excel reads UTF-8
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `invoices${state.from ? `-from-${state.from}` : ''}${state.to ? `-to-${state.to}` : ''}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function register(routes, kit) {
  const { $, h, rand, api, toast, fail, view, setTop, statusBadge } = kit;

  routes['invoice-history'] = async () => {
    const res = await api(`/invoices?${new URLSearchParams(state)}`);
    setTop(
      'Sales',
      'Invoice history',
      `${res.missing ? `<button class="btn" data-inv="issue-missing">Issue missing invoices (${h(res.missing)})</button>` : ''}
       <button class="btn btn-primary" data-inv="csv" ${res.items.length ? '' : 'disabled'}>Export CSV</button>`,
    );

    const months = res.months
      .map((m) => `<tr><td>${h(monthLabel(m.month))}</td><td class="num">${h(m.count)}</td><td class="num">${rand(m.totalCents)}</td></tr>`)
      .join('');
    const rows = res.items
      .map((i) => `<tr>
        <td><strong>${h(i.invoiceNumber)}</strong></td>
        <td>${h(invoiceDate(i.invoicedAt))}</td>
        <td>${h(i.customer)}<br><span class="muted">${h(i.email)}</span></td>
        <td class="num">${rand(i.totalCents)}</td>
        <td>${h(i.paymentLabel)}${i.status === 'cancelled' ? ` ${statusBadge('cancelled')}` : ''}</td>
        <td><a href="#/orders/${h(encodeURIComponent(i.orderId))}">${h(i.orderNumber)}</a></td>
        <td style="white-space:nowrap">
          <a class="btn small" style="text-decoration:none;color:inherit" href="/invoice.html?o=${h(encodeURIComponent(i.orderId))}" target="_blank" rel="noopener">View / print</a>
          <button class="btn small" data-email="${h(i.orderId)}" data-number="${h(i.invoiceNumber)}" data-to="${h(i.email)}">Email</button>
        </td>
      </tr>`)
      .join('');
    const filtered = state.q || state.from || state.to;

    const root = view(`
      <div class="toolbar">
        <input id="inv-q" type="search" placeholder="Invoice #, order #, name, email" value="${h(state.q)}">
        <label class="field"><span>From</span><input id="inv-from" type="date" value="${h(state.from)}"></label>
        <label class="field"><span>To</span><input id="inv-to" type="date" value="${h(state.to)}"></label>
        ${filtered ? '<button class="btn small" id="inv-clear">Clear filters</button>' : ''}
        <span class="muted">${h(res.total)} invoice${res.total === 1 ? '' : 's'} · ${rand(res.totalCents)}</span>
      </div>
      ${res.missing ? `<div class="panel" style="margin-bottom:1rem"><p class="mini-help" style="margin:0"><strong>${h(res.missing)} paid order${res.missing === 1 ? ' has' : 's have'} no invoice yet</strong> (paid before invoicing was switched on). Click “Issue missing invoices” to number them in payment order.</p></div>` : ''}
      <div class="panel table-wrap"><table class="catalog">
        <thead><tr><th>Invoice</th><th>Date</th><th>Customer</th><th class="num">Total</th><th>Payment</th><th>Order</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="7" class="empty">${filtered ? 'No invoices match these filters.' : 'No invoices yet. Each paid order gets one automatically.'}</td></tr>`}</tbody>
      </table></div>
      ${months ? `<div class="panel table-wrap" style="margin-top:1rem">
        <div class="section-head"><h3>Monthly totals${filtered ? ' (filtered)' : ''}</h3></div>
        <table class="catalog"><thead><tr><th>Month</th><th class="num">Invoices</th><th class="num">Total</th></tr></thead><tbody>${months}</tbody></table>
      </div>` : ''}
      ${res.items.length < res.total ? `<p class="muted">Showing the latest ${h(res.items.length)} of ${h(res.total)}. Narrow the dates to see older invoices.</p>` : ''}`);

    const reload = () => routes['invoice-history']().catch(fail);
    $('#inv-q', root).addEventListener('change', (e) => { state.q = e.target.value.trim(); reload(); });
    $('#inv-from', root).addEventListener('change', (e) => { state.from = e.target.value; reload(); });
    $('#inv-to', root).addEventListener('change', (e) => { state.to = e.target.value; reload(); });
    $('#inv-clear', root)?.addEventListener('click', () => { Object.assign(state, { q: '', from: '', to: '' }); reload(); });

    root.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-email]');
      if (!btn) return;
      if (!confirm(`Email invoice ${btn.dataset.number} to ${btn.dataset.to}?`)) return;
      btn.disabled = true;
      try {
        const r = await api(`/invoices/${encodeURIComponent(btn.dataset.email)}/email`, { method: 'POST' });
        toast(r.sent ? `Invoice ${btn.dataset.number} emailed` : 'Email is not set up on this server — nothing was sent', !r.sent);
      } catch (err) {
        fail(err);
      } finally {
        btn.disabled = false;
      }
    });

    // Top-bar buttons are re-rendered by every setTop(), so these listeners
    // go away with them.
    $('[data-inv="csv"]')?.addEventListener('click', () => downloadCsv(res.items));
    $('[data-inv="issue-missing"]')?.addEventListener('click', async (e) => {
      if (!confirm(`Give ${res.missing} paid order(s) an invoice number now? Numbers go in payment order and cannot be undone.`)) return;
      const email = confirm('Also email each customer a link to their invoice?\n\nOK = email them · Cancel = just number them');
      e.target.disabled = true;
      try {
        const r = await api('/invoices/issue-missing', { method: 'POST', body: { email } });
        toast(r.issued.length ? `Issued ${r.issued.length} invoice(s): ${r.issued.map((i) => `${i.orderNumber} → ${i.invoiceNumber}`).join(', ')}` : 'No invoices were missing');
        reload();
      } catch (err) {
        fail(err);
        e.target.disabled = false;
      }
    });
  };
}
