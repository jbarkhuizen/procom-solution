// Admin -> Audit log: who changed what, when. Rows come from
// server/features/governance.js (every non-GET admin request + sign-in events).
// Filters (admin, action, area, result, date range, text), paging, a detail
// drawer and CSV export. Every dynamic value goes through kit.h().

const state = { actor: '', action: '', area: '', ok: '', from: '', to: '', q: '', page: 1 };

const LABELS = {
  priceCents: 'Price', costCents: 'Cost', markupPct: 'Markup %', priceMode: 'Price mode', stockQty: 'Stock', supplierInStock: 'Supplier in stock',
  categoryId: 'Category', compareAtCents: 'Was price', minOrderQty: 'Min order qty', quoteDelivery: 'Delivery quoted', weightG: 'Weight (g)',
  defaultMarkupPct: 'Default markup %', vatRatePct: 'VAT %', vatRegistered: 'VAT registered', vatNumber: 'VAT number', siteName: 'Site name',
  contactEmail: 'Public email', contactPhone: 'Public phone', whatsappNumber: 'WhatsApp', ownerNotifyEmail: 'Notification email',
  legalEntity: 'Legal entity', defaultWeightG: 'Default weight (g)',
};
const label = (k) => LABELS[k] || String(k).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^\w/, (c) => c.toUpperCase());

function params(extra = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...state, ...extra })) if (v !== '' && v != null) p.set(k, v);
  return p;
}

export default function register(routes, kit) {
  const { $, h, api, fail, view, setTop, options, pager, fmtDate, setHtml } = kit;
  const fmtVal = (k, v) => {
    if (v === null || v === undefined || v === '') return '<span class="muted">—</span>';
    if (/Cents$/.test(k) && typeof v === 'number') return h(kit.rand(v));
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    return h(v);
  };

  function detailHtml(e) {
    const d = e.details || {};
    const rowsKv = (obj) => Object.entries(obj).map(([k, v]) => `<tr><th style="text-align:left;font-weight:600;padding-right:1rem">${h(label(k))}</th><td>${fmtVal(k, v)}</td></tr>`).join('');
    const changed = d.changed && Object.keys(d.changed).length
      ? `<h4 style="margin:1rem 0 0.4rem">What changed</h4><div class="table-wrap"><table class="catalog"><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>${Object.entries(d.changed)
        .map(([k, [a, b]]) => `<tr><td>${h(label(k))}</td><td>${fmtVal(k, a)}</td><td><strong>${fmtVal(k, b)}</strong></td></tr>`).join('')}</tbody></table></div>`
      : d.noChanges ? '<p class="muted">Saved with no field changes.</p>' : '';
    const values = d.values ? `<h4 style="margin:1rem 0 0.4rem">Values sent</h4><table>${rowsKv(d.values)}</table>` : '';
    const extra = [
      d.fields?.length ? `<p class="mini-help">Fields sent: ${h(d.fields.join(', '))}</p>` : '',
      d.redacted?.length ? `<p class="mini-help">Not recorded (sensitive): ${h(d.redacted.join(', '))}</p>` : '',
      d.upload ? `<p class="mini-help">File upload${d.files ? ` · ${h(d.files)} file(s)` : ''} — contents are never logged.</p>` : '',
      d.largeBody ? `<p class="mini-help">Large request (${h(d.largeBody)}) — body not logged.</p>` : '',
      d.valuesOmitted || d.fieldsOmitted || d.changedOmitted ? '<p class="mini-help">Some details were trimmed to keep the log small.</p>' : '',
    ].join('');
    return `
      <div class="section-head" style="display:flex;justify-content:space-between;align-items:center;gap:1rem">
        <h3 style="margin:0">${h(e.action)}</h3>
        <button class="btn small" type="button" data-close aria-label="Close details">✕</button>
      </div>
      <table style="margin-top:0.6rem;font-size:0.9rem"><tbody>
        <tr><th style="text-align:left;padding-right:1rem">When</th><td>${h(fmtDate(e.createdAt))}</td></tr>
        <tr><th style="text-align:left;padding-right:1rem">Admin</th><td>${h(e.actor || '—')}</td></tr>
        <tr><th style="text-align:left;padding-right:1rem">Area</th><td>${h(e.area || '—')}</td></tr>
        <tr><th style="text-align:left;padding-right:1rem">Result</th><td>${e.ok ? '<span class="badge ok">OK</span>' : '<span class="badge bad">Failed</span>'} ${e.status ? `<span class="muted">HTTP ${h(e.status)}</span>` : ''}</td></tr>
        ${e.targetId ? `<tr><th style="text-align:left;padding-right:1rem">Target</th><td><code>${h(e.targetId)}</code></td></tr>` : ''}
        <tr><th style="text-align:left;padding-right:1rem">Request</th><td><code>${h(e.method)} ${h(e.path)}</code></td></tr>
        ${e.ip ? `<tr><th style="text-align:left;padding-right:1rem">IP</th><td>${h(e.ip)}</td></tr>` : ''}
      </tbody></table>
      ${changed}${values}${extra}`;
  }

  routes['audit-log'] = async () => {
    const res = await api(`/audit-log?${params()}`);
    state.page = res.page;
    const exportHref = `/api/admin/audit-log/export.csv?${params({ page: '' })}`;
    setTop('System', 'Audit log', `<a class="btn" href="${h(exportHref)}" download style="text-decoration:none;color:inherit">Export CSV</a>`);
    const filtered = ['actor', 'action', 'area', 'ok', 'from', 'to', 'q'].some((k) => state[k]);
    const opt = (list) => list.map((v) => ({ value: v, label: v }));

    const rows = res.items.map((e, i) => `<tr data-i="${i}" tabindex="0" style="cursor:pointer">
        <td style="white-space:nowrap">${h(fmtDate(e.createdAt))}</td>
        <td>${h(e.actor || '—')}</td>
        <td><strong>${h(e.action)}</strong>${e.area ? ` <span class="badge neutral">${h(e.area)}</span>` : ''}</td>
        <td class="muted" style="max-width:10rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${h(e.targetId || '')}</td>
        <td>${e.ok ? '<span class="badge ok">OK</span>' : `<span class="badge bad">Failed${e.status ? ` ${h(e.status)}` : ''}</span>`}</td>
      </tr>`).join('');

    const root = view(`
      <div class="toolbar" style="flex-wrap:wrap">
        <input id="al-q" type="search" placeholder="Search action, target, details…" value="${h(state.q)}" aria-label="Search">
        <select id="al-actor" aria-label="Admin">${options(opt(res.actors), state.actor, { empty: 'All admins' })}</select>
        <select id="al-action" aria-label="Action">${options(opt(res.actions), state.action, { empty: 'All actions' })}</select>
        <select id="al-area" aria-label="Area">${options(opt(res.areas), state.area, { empty: 'All areas' })}</select>
        <select id="al-ok" aria-label="Result">${options([{ value: '1', label: 'Succeeded' }, { value: '0', label: 'Failed' }], state.ok, { empty: 'Any result' })}</select>
        <label class="field"><span>From</span><input id="al-from" type="date" value="${h(state.from)}"></label>
        <label class="field"><span>To</span><input id="al-to" type="date" value="${h(state.to)}"></label>
        ${filtered ? '<button class="btn small" id="al-clear" type="button">Clear filters</button>' : ''}
        <span class="muted">${h(res.total)} entr${res.total === 1 ? 'y' : 'ies'}</span>
      </div>
      <div class="panel table-wrap"><table class="catalog">
        <thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Target</th><th>Result</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5" class="empty">${filtered ? 'No entries match these filters.' : 'Nothing logged yet. Changes made in the admin (saves, deletes, sign-ins) appear here.'}</td></tr>`}</tbody>
      </table>${pager(res.page, res.pages)}</div>
      <p class="mini-help" style="margin-top:0.75rem">Every change made in the admin is recorded here with who made it and whether it worked. Passwords, tokens, keys and uploaded files are never recorded, and customer details only by id. Entries older than ${h(res.retentionMonths)} months are removed automatically. Dates are South African time.</p>
      <aside id="al-drawer" class="panel" hidden role="dialog" aria-modal="false" aria-label="Audit entry details"
        style="position:fixed;top:0;right:0;bottom:0;width:min(480px,100vw);z-index:60;overflow-y:auto;border-radius:0;box-shadow:var(--shadow);background:var(--panel)"></aside>`);

    const reload = () => routes['audit-log']().catch(fail);
    const set = (k) => (e) => { state[k] = e.target.value.trim(); state.page = 1; reload(); };
    $('#al-q', root).addEventListener('change', set('q'));
    $('#al-actor', root).addEventListener('change', set('actor'));
    $('#al-action', root).addEventListener('change', set('action'));
    $('#al-area', root).addEventListener('change', set('area'));
    $('#al-ok', root).addEventListener('change', set('ok'));
    $('#al-from', root).addEventListener('change', set('from'));
    $('#al-to', root).addEventListener('change', set('to'));
    $('#al-clear', root)?.addEventListener('click', () => { Object.assign(state, { actor: '', action: '', area: '', ok: '', from: '', to: '', q: '', page: 1 }); reload(); });

    const drawer = $('#al-drawer', root);
    let lastRow = null;
    const closeDrawer = () => { drawer.hidden = true; lastRow?.focus(); };
    const openDrawer = (tr) => {
      const e = res.items[Number(tr.dataset.i)];
      if (!e) return;
      lastRow = tr;
      setHtml(drawer, detailHtml(e));
      drawer.hidden = false;
      $('[data-close]', drawer)?.focus();
    };
    root.addEventListener('click', (e) => {
      const pg = e.target.closest('[data-page]');
      if (pg && !pg.disabled) { state.page = Number(pg.dataset.page); reload(); return; }
      if (e.target.closest('[data-close]')) { closeDrawer(); return; }
      const tr = e.target.closest('tr[data-i]');
      if (tr) openDrawer(tr);
    });
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !drawer.hidden) { closeDrawer(); return; }
      const tr = e.target.closest?.('tr[data-i]');
      if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openDrawer(tr); }
    });
  };
}
