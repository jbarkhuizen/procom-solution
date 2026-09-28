// Customers → Potential market: marketing-lead contacts (businesses, schools,
// resellers) that aren't customers yet. See server/features/marketing.js.
// POPIA: every contact records where the details came from (Source), and
// these contacts are never part of the newsletter audience.

const state = { q: '', status: '', type: '' };

const STATUS_BADGE = { new: 'info', contacted: 'warn', interested: 'ok', customer: 'ok', not_interested: 'neutral' };
const TYPE_LABEL = { business: 'Business', school: 'School', reseller: 'Reseller', other: 'Other' };

// Quotes where needed; a leading = @ or +/- not followed by a digit could be
// read as a spreadsheet formula, so it gets a ' prefix (phone numbers like
// +27 82 … stay as they are).
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=@]/.test(s) || /^[+-](?![\d\s])/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(items, labels) {
  const head = ['Name', 'Company', 'Email', 'Phone', 'Type', 'Status', 'Source', 'Notes', 'Last contacted', 'Added'];
  const rows = items.map((c) => [c.name, c.company, c.email, c.phone, TYPE_LABEL[c.type] || c.type, labels[c.status] || c.status, c.source, c.notes, c.lastContactedAt, c.createdAt.slice(0, 10)]);
  const csv = [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `potential-market-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export default function register(routes, kit) {
  const { $, h, api, toast, fail, view, setTop, options, setHtml } = kit;

  routes['potential-market'] = async () => {
    setTop(
      'Customers',
      'Potential market',
      `<button class="btn" data-pm="import">Import CSV</button>
       <button class="btn" data-pm="export">Export CSV</button>
       <button class="btn btn-primary" data-pm="new">+ Contact</button>`,
    );
    const [meta, res] = await Promise.all([api('/marketing/meta'), api(`/marketing/leads?${new URLSearchParams(state)}`)]);
    const labels = Object.fromEntries(meta.leadStatuses.map((s) => [s.value, s.label]));
    const statusOpts = meta.leadStatuses;
    const typeOpts = meta.leadTypes.map((t) => ({ value: t, label: TYPE_LABEL[t] || t }));
    const filtered = Boolean(state.q || state.status || state.type);

    const root = view(`
      <div class="stats">
        ${statusOpts.map((s) => `<div class="stat-card" data-filter-status="${h(s.value)}" style="cursor:pointer${state.status === s.value ? ';outline:2px solid var(--brand)' : ''}"><div class="label">${h(s.label)}</div><div class="value">${res.counts[s.value] || 0}</div></div>`).join('')}
      </div>
      <div class="toolbar">
        <input id="pm-q" type="search" placeholder="Search name, company, email, notes" value="${h(state.q)}">
        <select id="pm-status">${options(statusOpts, state.status, { empty: 'All statuses' })}</select>
        <select id="pm-type">${options(typeOpts, state.type, { empty: 'All types' })}</select>
        <span class="muted">${filtered ? `${res.items.length} of ${res.total}` : res.total} contact${res.total === 1 ? '' : 's'}</span>
      </div>
      <div id="pm-import" class="panel stack gap-3 hidden" style="margin-bottom:1rem"></div>
      <div class="editor-layout">
        <div class="panel table-wrap"><table class="catalog">
          <thead><tr><th>Contact</th><th>Phone / email</th><th>Type</th><th>Status</th><th>Last contacted</th></tr></thead>
          <tbody>${
            res.items.map((c) => `<tr data-id="${h(c.id)}" style="cursor:pointer">
              <td><strong>${h(c.name || c.company)}</strong>${c.name && c.company ? `<br><span class="muted">${h(c.company)}</span>` : ''}${c.source ? `<br><span class="mini-help">Source: ${h(c.source)}</span>` : ''}</td>
              <td>${h(c.phone)}${c.phone && c.email ? '<br>' : ''}${c.email ? `<span class="muted">${h(c.email)}</span>` : ''}${!c.phone && !c.email ? '<span class="muted">—</span>' : ''}</td>
              <td>${h(TYPE_LABEL[c.type] || c.type)}</td>
              <td><span class="badge ${STATUS_BADGE[c.status] || 'neutral'}">${h(labels[c.status] || c.status)}</span></td>
              <td>${h(c.lastContactedAt) || '<span class="muted">—</span>'}</td>
            </tr>`).join('') ||
            `<tr><td colspan="5"><div class="empty">${filtered ? 'No contacts match these filters.' : 'No leads yet — add businesses, schools or resellers you want to approach, or import a CSV.'}</div></td></tr>`
          }</tbody></table></div>
        <div class="panel sticky-panel" id="pm-editor"><p class="muted">Select a contact to edit, or add a new one.</p>
          <p class="mini-help">Lead details are personal information (POPIA). Only keep people you have a business reason to contact, record where the details came from, and delete anyone who asks. Leads are <strong>not</strong> added to newsletters — they must subscribe themselves.</p></div>
      </div>`);

    const editor = (c) => {
      root.querySelectorAll('tr[data-id]').forEach((tr) => tr.classList.toggle('selected', Boolean(c) && tr.dataset.id === c.id));
      setHtml(
        $('#pm-editor', root),
        `<form id="pm-form" class="stack gap-3"><div class="section-head"><h3>${c ? 'Edit contact' : 'New contact'}</h3></div>
        <div class="grid-2"><label class="field"><span>Contact name</span><input name="name" maxlength="200" value="${h(c?.name)}"></label>
        <label class="field"><span>Company / school</span><input name="company" maxlength="200" value="${h(c?.company)}"></label></div>
        <div class="grid-2"><label class="field"><span>Email</span><input name="email" type="email" maxlength="200" value="${h(c?.email)}"></label>
        <label class="field"><span>Phone</span><input name="phone" type="tel" maxlength="60" value="${h(c?.phone)}"></label></div>
        <div class="grid-2"><label class="field"><span>Type</span><select name="type">${options(typeOpts, c?.type || 'business')}</select></label>
        <label class="field"><span>Status</span><select name="status">${options(statusOpts, c?.status || 'new')}</select></label></div>
        <label class="field"><span>Last contacted</span><input name="lastContactedAt" type="date" value="${h(c?.lastContactedAt)}"></label>
        <label class="field"><span>Source — where did these details come from?</span><input name="source" maxlength="500" value="${h(c?.source)}" placeholder="e.g. Their website, met at school fair, referral from …"></label>
        <label class="field"><span>Notes</span><textarea name="notes" rows="4" maxlength="4000">${h(c?.notes)}</textarea></label>
        <div class="row-card-actions">${c ? '<button type="button" class="btn btn-danger" id="pm-del">Delete</button>' : '<span></span>'}
          <span>${c ? '<button type="button" class="btn" id="pm-today">Contacted today</button> ' : ''}<button class="btn btn-primary">Save</button></span></div></form>`,
      );
      const form = $('#pm-form', root);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api(c ? `/marketing/leads/${c.id}` : '/marketing/leads', { method: c ? 'PUT' : 'POST', body: Object.fromEntries(new FormData(form)) });
          toast('Contact saved');
          routes['potential-market']();
        } catch (err) { fail(err); }
      });
      $('#pm-today', root)?.addEventListener('click', () => {
        form.lastContactedAt.value = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
        if (form.status.value === 'new') form.status.value = 'contacted';
      });
      $('#pm-del', root)?.addEventListener('click', async () => {
        if (!confirm(`Delete ${c.name || c.company}? This removes their details permanently.`)) return;
        try { await api(`/marketing/leads/${c.id}`, { method: 'DELETE' }); toast('Deleted'); routes['potential-market'](); } catch (err) { fail(err); }
      });
    };

    const showImport = () => {
      const box = $('#pm-import', root);
      box.classList.remove('hidden');
      setHtml(
        box,
        `<div class="section-head"><h3>Import contacts from CSV</h3></div>
        <p class="mini-help">Columns (first row = headings): <strong>Name</strong> and/or <strong>Company</strong>, Email, Phone, Type (Business, School, Reseller, Other), Status (New, Contacted, Interested, Customer, Not interested), Source, Notes, Last contacted (YYYY-MM-DD). A row matching an existing contact by email — or by name + company when there's no email — is skipped, never overwritten.</p>
        <div class="grid-2"><label class="field"><span>CSV file</span><input type="file" id="pm-file" accept=".csv,text/csv"></label>
        <label class="field"><span>Source for rows without one (required by POPIA)</span><input id="pm-source" maxlength="500" placeholder="e.g. Pretoria schools list, Sept 2026"></label></div>
        <div class="row-card-actions"><button class="btn" id="pm-import-cancel">Cancel</button><button class="btn btn-primary" id="pm-import-go">Import</button></div>
        <div id="pm-import-result" class="mini-help"></div>`,
      );
      $('#pm-import-cancel', box).addEventListener('click', () => box.classList.add('hidden'));
      $('#pm-import-go', box).addEventListener('click', async () => {
        const file = $('#pm-file', box).files[0];
        if (!file) return toast('Choose a CSV file first', true);
        try {
          const r = await api('/marketing/leads/import', { method: 'POST', body: { csv: await file.text(), source: $('#pm-source', box).value } });
          toast(`${r.created} added, ${r.skipped} skipped`);
          if (!r.skipped) return routes['potential-market']();
          setHtml(
            $('#pm-import-result', box),
            `<strong>${r.created} added, ${r.skipped} skipped:</strong><br>${r.skippedRows.slice(0, 50).map((s) => `Row ${h(s.row)}: ${h(s.reason)}`).join('<br>')}${r.skipped > 50 ? '<br>…' : ''}
             <br><button class="btn small" id="pm-import-done" style="margin-top:0.5rem">Done</button>`,
          );
          $('#pm-import-done', box).addEventListener('click', () => routes['potential-market']());
        } catch (err) { fail(err); }
      });
    };

    const reload = () => routes['potential-market']();
    $('#pm-q', root).addEventListener('change', (e) => { state.q = e.target.value; reload(); });
    $('#pm-status', root).addEventListener('change', (e) => { state.status = e.target.value; reload(); });
    $('#pm-type', root).addEventListener('change', (e) => { state.type = e.target.value; reload(); });
    root.addEventListener('click', (e) => {
      const card = e.target.closest('[data-filter-status]');
      if (card) {
        state.status = state.status === card.dataset.filterStatus ? '' : card.dataset.filterStatus;
        return reload();
      }
      const tr = e.target.closest('tr[data-id]');
      if (tr) editor(res.items.find((c) => c.id === tr.dataset.id));
    });
    $('[data-pm="new"]').addEventListener('click', () => editor(null));
    $('[data-pm="import"]').addEventListener('click', showImport);
    $('[data-pm="export"]').addEventListener('click', () => {
      if (!res.items.length) return toast('Nothing to export', true);
      downloadCsv(res.items, labels);
    });
  };
}
