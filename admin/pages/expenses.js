// Admin -> Expenses: business spend captured by hand (advertising, hosting,
// software, bank charges, ...), one entry per supplier invoice / receipt with
// line items. Feeds the Financial overview. Ported from Lapanza3d's Expenses
// page; money is integer cents on the server (rand in the form).
// Routes: #/expenses (list), #/expenses/new, #/expenses/<id> (edit).
// Every dynamic value goes through kit.h() before kit.view()/kit.setTop().

const state = { q: '', category: '', from: '', to: '' };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (ym) => {
  const [y, m] = String(ym || '').split('-');
  return MONTHS[Number(m) - 1] ? `${MONTHS[Number(m) - 1]} ${y}` : ym;
};
const todaySast = () => new Date(Date.now() + 2 * 3600 * 1000).toISOString().slice(0, 10);
const toCents = (v) => {
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
};

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

export default function register(routes, kit) {
  const { $, h, rand, api, toast, fail, view, setTop, options, go } = kit;
  const navigate = (hash) => (go ? go(hash) : (location.hash = hash));

  routes.expenses = async (id) => {
    if (id) return expenseForm(id === 'new' ? null : id);
    const res = await api(`/finance/expenses?${new URLSearchParams(state)}`);
    setTop('Financial', 'Expenses', `<button class="btn" data-exp="csv" ${res.items.length ? '' : 'disabled'}>Export CSV</button><button class="btn btn-primary" data-exp="new">+ Expense</button>`);
    const filtered = state.q || state.category || state.from || state.to;
    const catOpts = [...new Set([...res.categories, ...res.byCategory.map((c) => c.category)])].map((c) => ({ value: c, label: c }));

    const rows = res.items.map((e) => {
      const cats = [...new Set(e.items.map((i) => i.category || 'Uncategorised'))];
      const desc = e.items.map((i) => i.description).join('; ');
      return `<tr data-edit="${h(e.id)}" style="cursor:pointer">
        <td style="white-space:nowrap">${h(e.date)}</td>
        <td><strong>${h(e.payee)}</strong>${e.reference ? `<br><span class="muted">${h(e.reference)}</span>` : ''}</td>
        <td>${h(desc.length > 90 ? `${desc.slice(0, 90)}…` : desc)}</td>
        <td>${cats.map((c) => `<span class="badge neutral">${h(c)}</span>`).join(' ')}</td>
        <td>${h(e.paymentMethod)}</td>
        <td class="num"><strong>${rand(e.totalCents)}</strong></td>
      </tr>`;
    }).join('');
    const catRows = res.byCategory.map((c) => `<tr><td>${h(c.category)}</td><td class="num">${rand(c.totalCents)}</td></tr>`).join('');
    const monthRows = res.byMonth.map((m) => `<tr><td>${h(monthLabel(m.month))}</td><td class="num">${rand(m.totalCents)}</td></tr>`).join('');

    const root = view(`
      <div class="toolbar">
        <input id="ex-q" type="search" placeholder="Payee, description, reference" value="${h(state.q)}">
        <select id="ex-cat" aria-label="Category">${options(catOpts, state.category, { empty: 'All categories' })}</select>
        <label class="field"><span>From</span><input id="ex-from" type="date" value="${h(state.from)}"></label>
        <label class="field"><span>To</span><input id="ex-to" type="date" value="${h(state.to)}"></label>
        ${filtered ? '<button class="btn small" id="ex-clear">Clear filters</button>' : ''}
        <span class="muted">${h(res.total)} expense${res.total === 1 ? '' : 's'} · ${rand(res.totalCents)}${state.category ? ` in ${h(state.category)}` : ''}</span>
      </div>
      <div class="panel table-wrap" style="margin-bottom:1rem"><table class="catalog">
        <thead><tr><th>Date</th><th>Paid to</th><th>What for</th><th>Category</th><th>Paid from</th><th class="num">Amount</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="6" class="empty">${filtered ? 'No expenses match these filters.' : 'No expenses yet. Click “+ Expense” to capture an invoice or receipt (advertising, hosting, software, bank charges, ...).'}</td></tr>`}</tbody>
      </table></div>
      <div class="grid-2" style="align-items:start">
        <div class="stack gap-3">
          <div class="panel table-wrap"><div class="section-head"><h3>By category${filtered ? ' (filtered)' : ''}</h3></div>
            <table class="catalog"><tbody>${catRows || '<tr><td class="empty">Nothing yet.</td></tr>'}</tbody></table></div>
          <div class="panel table-wrap"><div class="section-head"><h3>By month${filtered ? ' (filtered)' : ''}</h3><a class="btn small" href="#/financial-overview" style="text-decoration:none;color:inherit">Financial overview</a></div>
            <table class="catalog"><tbody>${monthRows || '<tr><td class="empty">Nothing yet.</td></tr>'}</tbody></table></div>
        </div>
        <form class="panel stack gap-3" id="ex-lists">
          <div class="section-head"><h3>Categories &amp; payment accounts</h3></div>
          <label class="field"><span>Expense categories (one per line)</span><textarea name="categories" rows="8">${h(res.categories.join('\n'))}</textarea></label>
          <label class="field"><span>Paid from — your accounts / cards (one per line)</span><textarea name="methods" rows="4">${h(res.paymentMethods.join('\n'))}</textarea></label>
          <p class="mini-help" style="margin:0">Renaming a category here doesn't change expenses already captured.</p>
          <div><button class="btn" type="submit">Save lists</button></div>
        </form>
      </div>`);

    const reload = () => routes.expenses().catch(fail);
    $('#ex-q', root).addEventListener('change', (e) => { state.q = e.target.value.trim(); reload(); });
    $('#ex-cat', root).addEventListener('change', (e) => { state.category = e.target.value; reload(); });
    $('#ex-from', root).addEventListener('change', (e) => { state.from = e.target.value; reload(); });
    $('#ex-to', root).addEventListener('change', (e) => { state.to = e.target.value; reload(); });
    $('#ex-clear', root)?.addEventListener('click', () => { Object.assign(state, { q: '', category: '', from: '', to: '' }); reload(); });
    root.addEventListener('click', (e) => {
      const tr = e.target.closest('[data-edit]');
      if (tr) navigate(`#/expenses/${encodeURIComponent(tr.dataset.edit)}`);
    });
    $('#ex-lists', root).addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const lines = (k) => String(fd.get(k) || '').split('\n').map((s) => s.trim()).filter(Boolean);
      try {
        await api('/finance/settings', { method: 'PUT', body: { expenseCategories: lines('categories'), expensePaymentMethods: lines('methods') } });
        toast('Lists saved');
        reload();
      } catch (err) { fail(err); }
    });

    $('[data-exp="new"]')?.addEventListener('click', () => navigate('#/expenses/new'));
    $('[data-exp="csv"]')?.addEventListener('click', () => {
      const head = ['Date', 'Paid to', 'Reference', 'Paid from', 'Description', 'Category', 'Quantity', 'Unit (R)', 'Line total (R)', 'Expense total (R)', 'Notes'];
      const r2 = (c) => ((Number(c) || 0) / 100).toFixed(2);
      const out = [head];
      for (const e of res.items) {
        e.items.forEach((i, n) => out.push([e.date, e.payee, e.reference, e.paymentMethod, i.description, i.category, i.quantity, r2(i.unitCents), r2(i.lineCents), n === 0 ? r2(e.totalCents) : '', n === 0 ? e.notes : '']));
      }
      downloadCsv(`expenses${state.from ? `-from-${state.from}` : ''}${state.to ? `-to-${state.to}` : ''}.csv`, out);
    });
  };

  async function expenseForm(id) {
    const [list, existing] = await Promise.all([api('/finance/expenses'), id ? api(`/finance/expenses/${encodeURIComponent(id)}`) : null]);
    const e = existing || { payee: '', date: todaySast(), reference: '', paymentMethod: '', notes: '', items: [{ description: '', category: '', quantity: 1, unitCents: 0 }] };
    const categories = [...new Set([...list.categories, ...e.items.map((i) => i.category).filter(Boolean)])];
    const payees = [...new Set(list.items.map((x) => x.payee))].sort();
    setTop('Financial', id ? `Expense — ${e.payee}` : 'New expense', '<a class="btn" href="#/expenses" style="text-decoration:none;color:inherit">← Expenses</a>');

    const lineHtml = (i) => `<tr data-line>
      <td><input class="inline-input" data-f="description" value="${h(i.description)}" maxlength="300" placeholder="e.g. Google search ads" aria-label="Description"></td>
      <td><select class="inline-input" data-f="category" aria-label="Category">${options(categories.map((c) => ({ value: c, label: c })), i.category, { empty: '— category —' })}</select></td>
      <td style="width:6rem"><input class="inline-input" data-f="quantity" type="number" min="0.01" step="0.01" value="${h(i.quantity)}" aria-label="Quantity"></td>
      <td style="width:9rem"><input class="inline-input" data-f="unit" type="number" min="0" step="0.01" value="${h(i.unitCents ? (i.unitCents / 100).toFixed(2) : '')}" placeholder="0.00" aria-label="Amount (R)"></td>
      <td class="num" data-line-total style="white-space:nowrap"></td>
      <td><button type="button" class="btn small" data-remove-line aria-label="Remove line">✕</button></td>
    </tr>`;

    const root = view(`
      <form id="ex-form" class="stack gap-3">
        <div class="panel stack gap-3">
          <div class="grid-3">
            <label class="field"><span>Paid to (supplier / payee) *</span><input name="payee" required maxlength="200" list="ex-payees" value="${h(e.payee)}"></label>
            <label class="field"><span>Date *</span><input name="date" type="date" required value="${h(e.date)}"></label>
            <label class="field"><span>Invoice / receipt number</span><input name="reference" maxlength="100" value="${h(e.reference)}"></label>
          </div>
          <div class="grid-2">
            <label class="field"><span>Paid from</span><input name="paymentMethod" maxlength="100" list="ex-methods" value="${h(e.paymentMethod)}"></label>
            <label class="field"><span>Notes</span><input name="notes" maxlength="2000" value="${h(e.notes)}"></label>
          </div>
          <datalist id="ex-payees">${payees.map((p) => `<option value="${h(p)}"></option>`).join('')}</datalist>
          <datalist id="ex-methods">${list.paymentMethods.map((p) => `<option value="${h(p)}"></option>`).join('')}</datalist>
        </div>
        <div class="panel table-wrap">
          <div class="section-head"><h3>Lines</h3><button type="button" class="btn small" id="ex-add-line">+ Line</button></div>
          <table class="catalog"><thead><tr><th>Description</th><th>Category</th><th>Qty</th><th>Amount each (R)</th><th class="num">Line total</th><th></th></tr></thead>
            <tbody id="ex-lines">${e.items.map(lineHtml).join('')}</tbody>
            <tfoot><tr><td colspan="4" style="text-align:right;font-weight:700">Total</td><td class="num" id="ex-total" style="font-weight:700"></td><td></td></tr></tfoot>
          </table>
          <p class="mini-help">Amounts as paid, including any VAT on the invoice (Procom is not VAT-registered, so VAT is part of the cost).</p>
        </div>
        <div class="editor-actions" style="display:flex;gap:0.5rem">
          <button class="btn btn-primary" type="submit">${id ? 'Save changes' : 'Save expense'}</button>
          <a class="btn" href="#/expenses" style="text-decoration:none;color:inherit">Cancel</a>
          ${id ? '<button class="btn btn-danger" type="button" id="ex-delete" style="margin-left:auto">Delete</button>' : ''}
        </div>
      </form>`);

    const tbody = $('#ex-lines', root);
    const readLines = () => [...tbody.querySelectorAll('[data-line]')].map((tr) => ({
      description: $('[data-f="description"]', tr).value.trim(),
      category: $('[data-f="category"]', tr).value,
      quantity: Number($('[data-f="quantity"]', tr).value || 1),
      unitCents: toCents($('[data-f="unit"]', tr).value || 0),
      tr,
    }));
    const recalc = () => {
      let total = 0;
      for (const l of readLines()) {
        const line = Number.isFinite(l.unitCents) ? Math.round(l.quantity * l.unitCents) : 0;
        total += line;
        $('[data-line-total]', l.tr).textContent = rand(line);
      }
      $('#ex-total', root).textContent = rand(total);
    };
    recalc();
    tbody.addEventListener('input', recalc);
    $('#ex-add-line', root).addEventListener('click', () => {
      const tmp = document.createElement('tbody');
      kit.setHtml(tmp, lineHtml({ description: '', category: '', quantity: 1, unitCents: 0 }));
      tbody.appendChild(tmp.firstElementChild);
      recalc();
    });
    tbody.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-remove-line]');
      if (!b) return;
      if (tbody.querySelectorAll('[data-line]').length > 1) b.closest('tr').remove();
      else b.closest('tr').querySelectorAll('input').forEach((i) => { i.value = i.dataset.f === 'quantity' ? '1' : ''; });
      recalc();
    });

    $('#ex-form', root).addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const fd = Object.fromEntries(new FormData(ev.target));
      const items = readLines().filter((l) => l.description || l.unitCents).map(({ tr, ...l }) => l);
      try {
        const saved = await api(id ? `/finance/expenses/${encodeURIComponent(id)}` : '/finance/expenses', { method: id ? 'PUT' : 'POST', body: { ...fd, items } });
        toast(`Expense saved (${rand(saved.totalCents)})`);
        navigate('#/expenses');
      } catch (err) { fail(err); }
    });
    $('#ex-delete', root)?.addEventListener('click', async () => {
      if (!confirm(`Delete this expense (${e.payee}, ${rand(e.totalCents)})?`)) return;
      try {
        await api(`/finance/expenses/${encodeURIComponent(id)}`, { method: 'DELETE' });
        toast('Expense deleted');
        navigate('#/expenses');
      } catch (err) { fail(err); }
    });
  }
}
