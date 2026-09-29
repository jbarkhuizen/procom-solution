// Admin -> Backups (overrides the core routes.backups): the daily database
// backups on the server plus the off-site copy to Google Drive via rclone
// (server/features/ops.js). "Back up now" still uses the core POST /backups.
// Every dynamic value goes through kit.h() before kit.view()/kit.setTop().

const fmtBytes = (n) => {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};
const fmtDuration = (ms) => (ms == null ? '' : ms < 1000 ? `${ms} ms` : ms < 120_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`);

let pollTimer = null;

export default function register(routes, kit) {
  const { $, h, fmtDate, api, toast, fail, view, setTop } = kit;

  const syncBadge = (s) => {
    if (!s) return '<span class="muted">Never</span>';
    const cls = s.status === 'ok' ? 'test-passed' : s.status === 'running' ? 'test-running' : 'test-failed';
    const label = { ok: 'OK', partial: 'Partly failed', failed: 'Failed', running: 'Running' }[s.status] || s.status;
    return `<span class="badge ${cls}">${h(label)}</span>`;
  };

  routes.backups = async () => {
    clearTimeout(pollTimer);
    const data = await api('/ops/backups');
    const o = data.offsite;
    const on = Boolean(o.remote);
    setTop(
      'Settings',
      'Backups',
      `<button class="btn" data-bk="test" ${on ? '' : 'disabled'}>Test connection</button>
       <button class="btn" data-bk="sync" ${on && !o.syncing ? '' : 'disabled'}>${o.syncing ? 'Syncing…' : 'Sync now'}</button>
       <button class="btn btn-primary" data-bk="backup">Back up now</button>`,
    );

    const last = o.lastSync;
    const recent = o.recent
      .map(
        (s) => `<tr>
          <td>${h(fmtDate(s.startedAt))}</td>
          <td>${s.trigger === 'automatic' ? 'Automatic' : `Sync now${s.requestedBy ? ` (${h(s.requestedBy)})` : ''}`}</td>
          <td>${syncBadge(s)}</td>
          <td>${h(s.message)}</td>
          <td class="num">${h(fmtDuration(s.durationMs))}</td>
        </tr>`,
      )
      .join('');
    const rows = data.backups
      .map((b) => `<tr><td><code>${h(b.file)}</code></td><td class="num">${h(fmtBytes(b.size))}</td><td>${h(fmtDate(b.createdAt))}</td></tr>`)
      .join('');

    const root = view(`
      <div class="stack gap-4">
        <div class="panel stack gap-3">
          <div class="section-head"><div><h3>Off-site copy (Google Drive)</h3>
            <p class="mini-help" style="margin:0">Backups on the server protect against mistakes and bad data, but not against the server itself failing. With a Google Drive remote set, the backups folder is mirrored to Drive after every automatic backup (so Drive keeps the same latest ${h(data.keep)}), and product photos are copied there too (copy only: a photo deleted here stays safe on Drive).</p></div>
            <strong>${on ? '<span class="badge test-passed">On</span>' : '<span class="badge test-failed">Off</span>'}</strong>
          </div>
          ${o.error ? `<div class="panel error">${h(o.error)}</div>` : ''}
          <div class="site-overview-grid">
            <div class="overview-stat"><span>Remote</span><strong>${on ? `<code>${h(o.remote)}</code>` : 'Not set'}</strong></div>
            <div class="overview-stat"><span>Backups go to</span><strong>${o.backupsTarget ? `<code>${h(o.backupsTarget)}</code>` : '—'}</strong></div>
            <div class="overview-stat"><span>Photos go to</span><strong>${o.uploadsTarget ? `<code>${h(o.uploadsTarget)}</code>` : '—'}</strong></div>
            <div class="overview-stat"><span>Last sync</span><strong>${syncBadge(last)} ${last ? h(fmtDate(last.finishedAt || last.startedAt)) : ''}</strong></div>
            <div class="overview-stat"><span>Last connection test</span><strong>${o.lastTest ? `${o.lastTest.ok ? '<span class="badge test-passed">OK</span>' : '<span class="badge test-failed">Failed</span>'} ${h(fmtDate(o.lastTest.at))}` : '<span class="muted">Not tested</span>'}</strong></div>
          </div>
          ${o.syncing ? '<p class="mini-help" style="margin:0"><strong>A copy to Google Drive is running now.</strong> This page refreshes by itself; the first copy of all photos can take a while.</p>' : ''}
          ${last?.message && last.status !== 'ok' ? `<p class="error-text" style="margin:0">${h(last.message)}</p>` : ''}
          ${o.lastTest && !o.lastTest.ok ? `<p class="error-text" style="margin:0">Connection test: ${h(o.lastTest.message)}</p>` : o.lastTest ? `<p class="muted" style="margin:0">${h(o.lastTest.message)}</p>` : ''}
          <form id="bk-remote" class="toolbar" style="margin:0">
            <label class="field" style="flex:1;min-width:240px"><span>Google Drive remote (rclone)</span>
              <input name="remote" value="${h(o.stored)}" placeholder="gdrive:procomsolutions" ${o.source === 'env' ? 'disabled' : ''} autocomplete="off" spellcheck="false"></label>
            <button class="btn" ${o.source === 'env' ? 'disabled' : ''}>Save</button>
          </form>
          <p class="mini-help" style="margin:0">${
            o.source === 'env'
              ? 'Set on the server by <code>BACKUP_RCLONE_REMOTE</code> in <code>.env</code>, which overrides this box.'
              : 'Format: remote name, a colon, then a folder, e.g. <code>gdrive:procomsolutions</code>. Leave blank to switch the off-site copy off. The remote must already exist in rclone on the server (see deploy/DEPLOY.md, “Off-site backups”). Use a folder that no other site mirrors into.'
          }</p>
        </div>

        ${recent ? `<div class="panel table-wrap">
          <div class="section-head"><h3>Recent off-site copies</h3></div>
          <table class="catalog"><thead><tr><th>Started</th><th>How</th><th>Result</th><th>Details</th><th class="num">Took</th></tr></thead><tbody>${recent}</tbody></table>
        </div>` : ''}

        <div class="panel table-wrap">
          <div class="section-head"><div><h3>Backups on the server</h3>
            <p class="mini-help" style="margin:0">${data.automaticDisabled ? '<strong>Automatic backups are switched off on this server (DISABLE_BACKUPS=1).</strong> ' : 'The whole database is backed up automatically once a day. '}The latest ${h(data.keep)} are kept in <code>data/backups/</code> (manual ones count too). ${h(data.backups.length)} backup${data.backups.length === 1 ? '' : 's'} · ${h(fmtBytes(data.totalBytes))}. To restore, see deploy/DEPLOY.md, “Restore”.</p></div></div>
          <table class="catalog"><thead><tr><th>File</th><th class="num">Size</th><th>Created</th></tr></thead><tbody>
            ${rows || '<tr><td colspan="3" class="empty">No backups yet.</td></tr>'}
          </tbody></table>
        </div>
      </div>`);

    $('#bk-remote', root).addEventListener('submit', async (e) => {
      e.preventDefault();
      const remote = new FormData(e.target).get('remote');
      try {
        const r = await api('/ops/backups/remote', { method: 'PUT', body: { remote } });
        toast(r.offsite.remote ? `Off-site copy set to ${r.offsite.remote} — click “Test connection”` : 'Off-site copy switched off');
        routes.backups();
      } catch (err) {
        fail(err);
      }
    });

    $('[data-bk="backup"]')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const r = await api('/backups', { method: 'POST' });
        toast(`Backup created: ${r.file}`);
        routes.backups();
      } catch (err) {
        fail(err);
        e.target.disabled = false;
      }
    });
    $('[data-bk="sync"]')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        await api('/ops/backups/sync', { method: 'POST' });
        toast('Copy to Google Drive started');
        routes.backups();
      } catch (err) {
        fail(err);
        e.target.disabled = false;
      }
    });
    $('[data-bk="test"]')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Testing…';
      try {
        const r = await api('/ops/backups/test', { method: 'POST' });
        toast(r.message, !r.ok);
        routes.backups();
      } catch (err) {
        fail(err);
        e.target.disabled = false;
        e.target.textContent = 'Test connection';
      }
    });

    if (o.syncing) {
      pollTimer = setTimeout(() => {
        if (location.hash.replace(/^#\/?/, '').split('/')[0] === 'backups') routes.backups().catch(fail);
      }, 3000);
    }
  };
}
