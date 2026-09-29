// Admin -> Version history: one row per deployed commit, recorded by the
// server when it starts on a new git commit (server/features/ops.js).
// Routes: #/version-history (list), #/version-history/<id> (detail).
// Every dynamic value goes through kit.h() before kit.view()/kit.setTop().

const short = (sha) => String(sha || '').slice(0, 7);

export default function register(routes, kit) {
  const { h, fmtDate, api, view, setTop } = kit;

  const commitLink = (url, sha) => `<a href="${h(url)}" target="_blank" rel="noopener"><code>${h(short(sha))}</code></a>`;

  async function list() {
    const { versions, currentSha } = await api('/ops/versions');
    setTop('System', 'Version history');
    const rows = versions
      .map((v) => {
        const more = v.commitCount - v.subjects.length;
        const changes = v.subjects.length
          ? `<ul style="margin:0.35rem 0 0;padding-left:1.1rem">${v.subjects.map((s) => `<li>${h(s)}</li>`).join('')}${more > 0 ? `<li class="muted">and ${h(more)} more…</li>` : ''}</ul>`
          : '<span class="muted">No new commits listed.</span>';
        return `<tr>
          <td style="white-space:nowrap"><a class="btn small" href="#/version-history/${h(encodeURIComponent(v.id))}">V${h(v.label)}</a>${v.commitSha === currentSha ? ' <span class="badge test-passed">Running</span>' : ''}</td>
          <td style="white-space:nowrap">${h(fmtDate(v.recordedAt))}</td>
          <td><strong>${h(v.description)}</strong>${changes}</td>
          <td>${commitLink(v.commitUrl, v.commitSha)}</td>
        </tr>`;
      })
      .join('');
    view(`
      <p class="mini-help">A new version is recorded automatically when the server starts on a new commit (every deploy). Nothing to do here. Each version lists the changes since the one before; click a version for the full list, or a commit to open it on GitHub.</p>
      <div class="panel table-wrap"><table class="catalog">
        <thead><tr><th>Version</th><th>Deployed</th><th>Changes</th><th>Commit</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="empty">No versions recorded yet. The first one is recorded the next time the server starts.</td></tr>'}</tbody>
      </table></div>`);
  }

  async function detail(id) {
    const v = await api(`/ops/versions/${encodeURIComponent(id)}`);
    setTop('System', `Version V${v.label}`, '<a class="btn" href="#/version-history" style="text-decoration:none;color:inherit">← Version history</a>');
    const commits = v.commits
      .map(
        (c) => `<details class="release-commit">
          <summary><strong>${h(c.subject)}</strong> <a href="${h(c.url)}" target="_blank" rel="noopener"><code>${h(short(c.sha))}</code></a></summary>
          <p class="muted">${h(c.author)} · ${h(fmtDate(c.date))}</p>
          ${c.body ? `<pre class="release-commit-body">${h(c.body)}</pre>` : ''}
        </details>`,
      )
      .join('');
    view(`
      <div class="panel stack gap-3">
        <div class="section-head"><h3>V${h(v.label)} — ${h(v.description)}</h3></div>
        <div class="release-meta">
          <span><strong>Deployed:</strong> ${h(fmtDate(v.recordedAt))}</span>
          <span><strong>Commit:</strong> ${commitLink(v.commitUrl, v.commitSha)}</span>
          ${v.compareUrl ? `<span><strong>Previous:</strong> <code>${h(short(v.previousSha))}</code> · <a href="${h(v.compareUrl)}" target="_blank" rel="noopener">compare on GitHub</a></span>` : '<span>First recorded version (baseline)</span>'}
          <span><strong>Node:</strong> ${h(v.nodeVersion)}</span>
        </div>
        <div>
          <h4>Changes (${h(v.commitCount)}${v.commitsTruncated ? ', list shortened' : ''})</h4>
          ${v.previousSha ? '' : '<p class="muted">The first recorded version lists the most recent commits before it.</p>'}
          <div class="stack gap-2">${commits || '<div class="empty">No commits were listed for this version (e.g. a redeploy of an earlier commit).</div>'}</div>
          ${v.commitsTruncated ? `<p class="muted">Only the latest ${h(v.commitCount)} are shown${v.compareUrl ? ` — <a href="${h(v.compareUrl)}" target="_blank" rel="noopener">see all on GitHub</a>` : ''}.</p>` : ''}
        </div>
      </div>`);
  }

  routes['version-history'] = (id) => (id ? detail(id) : list());
}
