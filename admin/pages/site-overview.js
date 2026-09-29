// Admin -> About this site: live facts about the running app (version, uptime,
// database, disk, backups, configuration yes/no) plus a short plain-language
// description of how the shop works. Secrets are never shown, only whether
// something is set. Data: GET /api/admin/ops/overview (server/features/ops.js).
// Every dynamic value goes through kit.h() before kit.view()/kit.setTop().

const fmtBytes = (n) => {
  if (n == null) return 'Unavailable';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};
const fmtUptime = (s) => {
  const d = Math.floor(s / 86_400);
  const hr = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${hr}h ${m}m` : hr ? `${hr}h ${m}m` : `${m}m`;
};
const num = (n) => Number(n || 0).toLocaleString('en-ZA');

export default function register(routes, kit) {
  const { h, fmtDate, api, view, setTop } = kit;
  const yes = (on, yesText = 'Yes', noText = 'No') => (on ? `<span class="badge test-passed">${h(yesText)}</span>` : `<span class="badge test-failed">${h(noText)}</span>`);
  const stat = (label, value) => `<div class="overview-stat"><span>${h(label)}</span><strong>${value}</strong></div>`;

  routes['site-overview'] = async () => {
    const o = await api('/ops/overview');
    setTop('System', 'About this site', `<a class="btn" href="${h(o.links.status)}" target="_blank" rel="noopener" style="text-decoration:none;color:inherit">Status &amp; decisions (GitHub) ↗</a>`);
    const disk = o.storage.disk;
    const pct = disk && disk.totalBytes ? Math.round((disk.usedBytes / disk.totalBytes) * 100) : null;
    const lastBackup = o.backups.latest;
    const lastSync = o.backups.lastOffsiteSync;
    const syncText = !o.config.offsiteConfigured
      ? '<span class="muted">Off</span>'
      : lastSync
        ? `${yes(lastSync.status === 'ok', 'OK', lastSync.status === 'partial' ? 'Partly failed' : 'Failed')} ${h(fmtDate(lastSync.finishedAt || lastSync.startedAt))}`
        : '<span class="muted">Not yet</span>';

    view(`
      <div class="stack gap-4">
        <div class="panel stack gap-3">
          <div class="section-head"><div><h3>Right now</h3><p class="muted" style="margin:0">Checked ${h(fmtDate(o.generatedAt))}</p></div></div>
          <div class="site-overview-grid">
            ${stat('Version', o.app.version ? `<a href="#/version-history">${h(o.app.version)}</a>` : 'Not recorded yet')}
            ${stat('Commit', o.app.commitSha ? `<a href="${h(o.app.commitUrl)}" target="_blank" rel="noopener"><code>${h(o.app.commitSha.slice(0, 7))}</code></a>` : 'Unknown')}
            ${stat('Running for', `${h(fmtUptime(o.app.processUptimeSeconds))} <span class="muted" style="font-weight:400">(server up ${h(fmtUptime(o.app.serverUptimeSeconds))})</span>`)}
            ${stat('Node.js', h(o.app.nodeVersion))}
            ${stat('Payfast', o.config.payfastMode === 'live' ? '<span class="badge test-passed">Live</span>' : '<span class="badge test-running">Sandbox (test)</span>')}
            ${stat('Email (Gmail) set up', yes(o.config.emailConfigured))}
            ${stat('Last backup', lastBackup ? h(fmtDate(lastBackup.createdAt)) : '<span class="muted">None yet</span>')}
            ${stat('Last copy to Google Drive', syncText)}
            ${stat('Last test run', o.tests ? `${yes(o.tests.status === 'passed', 'Passed', 'Failed')} ${h(fmtDate(o.tests.startedAt))}` : '<span class="muted">Not run here yet</span>')}
          </div>
        </div>

        <div class="panel stack gap-3">
          <div class="section-head"><h3>Shop in numbers</h3></div>
          <div class="site-overview-grid">
            ${stat('Products (live / all)', `${h(num(o.counts.liveProducts))} / ${h(num(o.counts.products))}`)}
            ${stat('Categories', h(num(o.counts.categories)))}
            ${stat('Orders (paid / all)', `${h(num(o.counts.paidOrders))} / ${h(num(o.counts.orders))}`)}
            ${stat('Paying customers', h(num(o.counts.customers)))}
            ${stat('Customer accounts', h(num(o.counts.registeredAccounts)))}
          </div>
        </div>

        <div class="panel stack gap-3">
          <div class="section-head"><h3>Storage</h3>${pct != null ? `<strong>${h(fmtBytes(disk.usedBytes))} used of ${h(fmtBytes(disk.totalBytes))} (${h(pct)}%)</strong>` : ''}</div>
          ${pct != null ? `<div class="capacity-bar"><span style="width:${Math.min(100, pct)}%"></span></div><p class="muted" style="margin:0">${h(fmtBytes(disk.freeBytes))} free on the server's disk (shared with the other sites on it).</p>` : ''}
          <div class="table-wrap"><table class="catalog">
            <thead><tr><th>What</th><th class="num">Size</th><th class="num">Files</th></tr></thead>
            <tbody>
              <tr><td>Database</td><td class="num">${h(fmtBytes(o.database.sizeBytes))}</td><td class="num">1</td></tr>
              ${o.storage.folders.map((f) => `<tr><td>${h(f.label)}</td><td class="num">${f.missing ? '<span class="muted">not created yet</span>' : h(fmtBytes(f.bytes))}${f.truncated ? ' +' : ''}</td><td class="num">${h(num(f.files))}</td></tr>`).join('')}
            </tbody>
          </table></div>
          <details class="release-commit"><summary>Rows per database table</summary>
            <table class="catalog" style="margin-top:0.5rem"><tbody>${o.database.tables.map((t) => `<tr><td><code>${h(t.table)}</code></td><td class="num">${h(num(t.rows))}</td></tr>`).join('')}</tbody></table>
          </details>
        </div>

        <div class="panel stack gap-2">
          <div class="section-head"><h3>How the site works</h3></div>
          <p style="margin:0"><strong>Products and suppliers.</strong> Almost everything is dropshipped from suppliers (mainly SMD). Their price lists are imported under Warehouse feed; the shop price is our cost plus 15% VAT (we are not VAT-registered, so VAT is a cost) plus a markup (10% by default, or per category or product), rounded up to the next rand. The shop reads the catalogue live, so changes show immediately.</p>
          <p style="margin:0"><strong>Delivery.</strong> Each supplier's items ship separately with their own choice at checkout. SMD: R150 courier per order, free when SMD's invoice reaches R5,000, or free collection at their Edenvale warehouse. Other suppliers use the store-wide courier prices, and large items get a delivery quote after ordering.</p>
          <p style="margin:0"><strong>Payments and orders.</strong> Customers pay by card or Instant EFT through Payfast. When Payfast confirms a payment the order becomes Paid, stock is updated, an invoice number is issued, and the customer and the shop are emailed. Each order gets an order sheet to send to the supplier.</p>
          <p style="margin:0"><strong>Extras.</strong> Optional customer accounts, invoices, promo codes and specials (never below cost incl VAT), our own visitor statistics (no cookies or third parties), opt-in newsletters, finance overview and expenses, marketing planning, and these System pages: backups with a Google Drive copy, version history, automated tests.</p>
          <p style="margin:0"><strong>Safety nets.</strong> The database is backed up every day (30 kept) and copied to Google Drive when set up; the full test suite runs before every deploy; deploys happen automatically when changes are merged on GitHub.</p>
          <p class="muted" style="margin:0.5rem 0 0">Current state, decisions and open items: <a href="${h(o.links.status)}" target="_blank" rel="noopener">docs/STATUS.md</a> · server runbook: <a href="${h(o.links.deploy)}" target="_blank" rel="noopener">deploy/DEPLOY.md</a> · <a href="${h(o.links.repo)}" target="_blank" rel="noopener">code on GitHub</a></p>
        </div>
      </div>`);
  };
}
