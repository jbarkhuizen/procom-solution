// Admin -> System -> API run log: every Esquire / SMD API run with its status,
// duration and a one-line overview. Click a row for the figures of that run.
// Data: GET /api/admin/ops/api-runs (server/features/ops.js, server/api-run-log.js).
// Every dynamic value goes through kit.h() before kit.view()/kit.setTop().

const fmtSeconds = (s) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);

export default function register(routes, kit) {
  const { $, $$, h, fmtDate, api, view, setTop, fail } = kit;

  const badge = (r) => `<span class="badge ${r.ok ? 'test-passed' : 'test-failed'}">${r.ok ? 'OK' : 'Failed'}</span>`;
  const kindLabel = (r) => (r.kind === 'check' ? 'Connection check' : r.trigger === 'scheduled' ? 'Scheduled' : 'Started from admin');

  const card = (s) => {
    const last = s.last;
    const failedNote = s.days7.failed ? ` · <strong style="color:#a51d1d">${h(s.days7.failed)} failed</strong>` : '';
    return `<div class="panel" style="flex:1 1 280px">
      <p class="mini-help" style="margin:0 0 .25rem">${h(s.supplier)}</p>
      ${last
        ? `<p style="margin:0 0 .25rem;font-size:1.1rem">${badge(last)} <strong>${h(fmtDate(last.startedAt))}</strong></p><p class="muted" style="margin:0 0 .5rem">${h(last.overview)}</p>`
        : '<p class="muted" style="margin:0 0 .5rem">No runs logged yet.</p>'}
      <p class="muted" style="margin:0">Last 7 days: ${h(s.days7.runs)} runs${failedNote} · Last 30 days: ${h(s.days30.runs)} runs${s.days30.failed ? `, ${h(s.days30.failed)} failed` : ''}</p>
      <p class="muted" style="margin:0">Last good run: ${s.lastGoodAt ? h(fmtDate(s.lastGoodAt)) : '—'} · Next run: ${s.nextRunAt ? h(fmtDate(s.nextRunAt)) : '—'}</p>
    </div>`;
  };

  const row = (r) => `<tr class="api-run-row" data-run="${h(r.id)}" style="cursor:pointer">
      <td style="white-space:nowrap">${h(fmtDate(r.startedAt))}</td>
      <td>${h(r.supplier)}</td>
      <td>${h(kindLabel(r))}</td>
      <td>${badge(r)}</td>
      <td style="white-space:nowrap">${h(fmtSeconds(r.seconds))}</td>
      <td>${h(r.overview)}</td>
    </tr>
    <tr class="api-run-detail hidden" data-detail="${h(r.id)}"><td colspan="6">
      ${r.error ? `<p style="color:#a51d1d;margin:.25rem 0"><strong>${h(r.error)}</strong></p>` : ''}
      ${r.figures.length ? `<table class="catalog"><tbody>${r.figures.map(([k, v]) => `<tr><td>${h(k)}</td><td style="text-align:right"><strong>${h(v)}</strong></td></tr>`).join('')}</tbody></table>` : '<p class="muted" style="margin:.25rem 0">No further figures for this run.</p>'}
    </td></tr>`;

  routes['api-runs'] = async (...args) => {
    const [supplier = '', status = ''] = args;
    const q = new URLSearchParams();
    if (supplier) q.set('supplier', supplier);
    if (status) q.set('status', status);
    const { summary, runs } = await api(`/ops/api-runs?${q}`);
    setTop('System', 'API run log');
    const opt = (v, cur, label) => `<option value="${h(v)}"${v === cur ? ' selected' : ''}>${h(label)}</option>`;
    view(`
      <p class="mini-help">Every Esquire and SMD API run is logged here: when it ran, whether it worked, how long it took and what it did. Click a run to see its figures. Entries are kept for 180 days. Runs before this page existed were filled in from the supplier report history (last 30 days).</p>
      <div style="display:flex;gap:1rem;flex-wrap:wrap;margin-bottom:1rem">${summary.map(card).join('')}</div>
      <div class="panel" style="display:flex;gap:.75rem;flex-wrap:wrap;align-items:center;margin-bottom:1rem">
        <label>Supplier <select id="ar-supplier">${opt('', supplier, 'All')}${opt('Esquire', supplier, 'Esquire')}${opt('SMD', supplier, 'SMD')}</select></label>
        <label>Status <select id="ar-status">${opt('', status, 'All')}${opt('ok', status, 'OK')}${opt('failed', status, 'Failed')}</select></label>
        <span class="muted">${h(runs.length)} run${runs.length === 1 ? '' : 's'} shown</span>
      </div>
      <div class="panel table-wrap"><table class="catalog">
        <thead><tr><th>When</th><th>Supplier</th><th>Type</th><th>Status</th><th>Took</th><th>Overview</th></tr></thead>
        <tbody>${runs.map(row).join('') || '<tr><td colspan="6" class="empty">No runs match.</td></tr>'}</tbody>
      </table></div>`);

    const go = () => { location.hash = `#/api-runs/${encodeURIComponent($('#ar-supplier').value)}/${encodeURIComponent($('#ar-status').value)}`; };
    $('#ar-supplier').addEventListener('change', go);
    $('#ar-status').addEventListener('change', go);
    $$('.api-run-row').forEach((tr) => tr.addEventListener('click', () => {
      try { $(`[data-detail="${tr.dataset.run}"]`).classList.toggle('hidden'); } catch (err) { fail(err); }
    }));
  };
}
