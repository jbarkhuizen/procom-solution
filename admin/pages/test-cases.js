// Admin -> Test cases: every automated test in server/**/*.test.js with a
// plain-language summary per suite, and "Run tests now", which runs them on
// the server with a throw-away database (server/features/ops.js).
// Every dynamic value goes through kit.h() before kit.view()/kit.setTop().

const fmtDuration = (ms) => (ms == null ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const STATUS = {
  passed: ['Passed', 'test-passed'],
  failed: ['Failed', 'test-failed'],
  timed_out: ['Timed out', 'test-failed'],
  interrupted: ['Interrupted', 'test-failed'],
  running: ['Running', 'test-running'],
};

let pollTimer = null;
const onPage = () => location.hash.replace(/^#\/?/, '').split('/')[0] === 'test-cases';

export default function register(routes, kit) {
  const { $, h, fmtDate, api, toast, fail, view, setTop } = kit;
  const badge = (s) => {
    const [label, cls] = STATUS[s] || [s, ''];
    return `<span class="badge ${cls}">${h(label)}</span>`;
  };
  const summary = (r) =>
    r.status === 'running'
      ? `${badge(r.status)} started ${h(fmtDate(r.startedAt))}${r.requestedBy ? ` by ${h(r.requestedBy)}` : ''} — usually under a minute…`
      : `${badge(r.status)} ${h(r.passed)} passed · ${h(r.failed)} failed${r.skipped ? ` · ${h(r.skipped)} skipped` : ''} of ${h(r.total)} · ${h(fmtDuration(r.durationMs))} · ${h(fmtDate(r.startedAt))}${r.requestedBy ? ` · ${h(r.requestedBy)}` : ''}`;

  async function showOutput(root, id) {
    const run = await api(`/ops/tests/runs/${encodeURIComponent(id)}`);
    const pre = $('#tc-output', root);
    pre.textContent = run.output || 'No output was captured.';
    pre.classList.remove('hidden');
    pre.scrollTop = pre.scrollHeight;
    $('#tc-output-title', root).textContent = `Output of the run started ${fmtDate(run.startedAt)}`;
    $('#tc-output-title', root).classList.remove('hidden');
  }

  routes['test-cases'] = async () => {
    clearTimeout(pollTimer);
    const data = await api('/ops/tests');
    const running = Boolean(data.active) || data.runs.some((r) => r.status === 'running');
    setTop('System', 'Test cases', `<button class="btn btn-primary" data-tc="run" ${running ? 'disabled' : ''}>${running ? 'Running…' : 'Run tests now'}</button>`);

    const latest = data.runs[0];
    const suites = data.suites
      .map(
        (s) => `<details class="release-commit">
          <summary><strong>${h(s.description || s.file)}</strong> <span class="muted">· ${h(s.tests.length)} test${s.tests.length === 1 ? '' : 's'} · <code>${h(s.file)}</code></span></summary>
          <ul style="margin:0.5rem 0 0;padding-left:1.1rem">${s.tests.map((t) => `<li>${h(t.name)}</li>`).join('')}</ul>
        </details>`,
      )
      .join('');
    const runs = data.runs
      .map((r) => `<button class="test-run-history" type="button" data-run="${h(r.id)}">${summary(r)}</button>`)
      .join('');

    const root = view(`
      <div class="stack gap-4">
        <div class="panel stack gap-2">
          <div class="section-head"><div><h3>Automated checks</h3>
            <p class="mini-help" style="margin:0">${h(data.total)} tests in ${h(data.suites.length)} groups check prices, orders, delivery, invoices, promos and the rest of the shop's rules. The same tests run before every deploy. “Run tests now” runs them here on the server against a throw-away database: they never touch live products or orders and never send email. One run at a time; a run is stopped after 10 minutes.</p></div></div>
          <div id="tc-status" class="test-run-status">${latest ? summary(latest) : 'No test runs yet.'}</div>
        </div>
        <div class="panel stack gap-2">
          <div class="section-head"><h3>Recent runs</h3></div>
          ${runs || '<div class="empty">No test runs yet.</div>'}
          <p id="tc-output-title" class="muted hidden" style="margin:0.5rem 0 0"></p>
          <pre id="tc-output" class="test-output hidden"></pre>
        </div>
        <div class="panel stack gap-2">
          <div class="section-head"><h3>What is tested</h3></div>
          ${suites || '<div class="empty">No test files found.</div>'}
        </div>
      </div>`);

    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-run]');
      if (b) showOutput(root, b.dataset.run).catch(fail);
    });
    $('[data-tc="run"]')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        await api('/ops/tests/run', { method: 'POST' });
        toast('Test run started');
        routes['test-cases']().catch(fail);
      } catch (err) {
        fail(err);
        e.target.disabled = false;
      }
    });

    if (running) {
      const runId = (data.runs.find((r) => r.status === 'running') || {}).id;
      pollTimer = setTimeout(async function tick() {
        if (!onPage()) return;
        try {
          const r = runId ? await api(`/ops/tests/runs/${encodeURIComponent(runId)}`) : null;
          if (r && r.status === 'running') {
            pollTimer = setTimeout(tick, 2000);
            return;
          }
          if (r) toast(r.status === 'passed' ? `All ${r.total} tests passed` : `Test run ${STATUS[r.status]?.[0].toLowerCase() || r.status}: ${r.failed} failed`, r.status !== 'passed');
          await routes['test-cases']();
          if (r) await showOutput(document, r.id);
        } catch (err) {
          fail(err);
        }
      }, 2000);
    }
  };
}
