// "Supplier update emails: once a day" (Site settings, owner 2026-10-05):
// one email at 19:00 SAST -- after the last Esquire (18:00) and SMD (18:30)
// runs -- covering every sync since the last email, with one Word document.
// mailer.js records each run in sync_report_runs (sent = 0 while waiting).
import { getDb } from './db.js';
import { getSettings } from './settings.js';
import { sendMail, layout, reportMode, reportRecipients, changesHtml } from './mailer.js';
import { mergeChanges, buildDigestDocx } from './sync-report.js';
import { nextRunAt } from './esquire.js';
import { escapeHtml } from './util.js';

const DAY_MS = 24 * 3600_000;

export function digestTime() {
  const m = String(process.env.SUPPLIER_DIGEST_TIME || '19:00').match(/^(\d{1,2}):(\d{2})$/);
  return m ? { h: Number(m[1]), m: Number(m[2]) } : { h: 19, m: 0 };
}

// Sends the once-a-day email when there are waiting runs. Returns what it did.
export async function sendSupplierDigest({ now = new Date(), db = getDb(), force = false } = {}) {
  if (!force && reportMode(getSettings(db)) !== 'daily') return { sent: false, reason: 'not in daily mode' };
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const runs = db.prepare('SELECT * FROM sync_report_runs WHERE sent = 0 AND started_at >= ? ORDER BY started_at').all(since);
  if (!runs.length) return { sent: false, reason: 'no updates waiting' };

  const sections = ['Esquire', 'SMD']
    .map((supplier) => {
      const mine = runs.filter((r) => r.supplier === supplier);
      if (!mine.length) return null;
      const parsed = mine.map((r) => ({ startedAt: r.started_at, ok: Boolean(r.ok), error: r.error, summaryRows: JSON.parse(r.summary_json || '[]'), changes: r.changes_json ? JSON.parse(r.changes_json) : null }));
      return { supplier, runs: parsed, changes: mergeChanges(parsed.map((p) => p.changes)) };
    })
    .filter(Boolean);

  const dateLabel = now.toLocaleDateString('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'long' });
  const row = (label, value) => `<tr><td style="padding:4px 0">${escapeHtml(label)}</td><td style="padding:4px 0;text-align:right;font-weight:700">${escapeHtml(String(value))}</td></tr>`;
  const table = (rows) => `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:8px 0 16px">${rows.join('')}</table>`;
  const list = (items, max = 15) => `<ul style="font-size:13px;margin:4px 0 16px;padding-left:18px">${items.slice(0, max).map((i) => `<li>${escapeHtml(i)}</li>`).join('')}${items.length > max ? `<li>… and ${items.length - max} more</li>` : ''}</ul>`;
  let body = `<p>All supplier updates of ${escapeHtml(dateLabel)}. Full lists are in the attached Word document.</p>`;
  for (const sec of sections) {
    const failed = sec.runs.filter((r) => !r.ok);
    body += `<h3 style="font-size:16px;margin:16px 0 0">${escapeHtml(sec.supplier)} · ${sec.runs.length} update${sec.runs.length === 1 ? '' : 's'}</h3>`;
    if (failed.length) body += `<p style="background:#c24b28;color:#fff;padding:10px;border-radius:4px">${failed.map((r) => escapeHtml(`${new Date(r.startedAt).toLocaleTimeString('en-ZA', { timeZone: 'Africa/Johannesburg', hour: '2-digit', minute: '2-digit', hour12: false })}: ${r.error}`)).join('<br>')}</p>`;
    body += changesHtml(sec.changes, row, table, list);
  }
  const counts = sections.map((s) => `${s.supplier} ${s.changes.newSpecials.length} on special, ${s.changes.priceDown.length} price down`).join(' · ');
  let attachments;
  try {
    const content = await buildDigestDocx({ dateLabel, sections });
    const ymd = new Date(now.getTime() + 2 * 3600_000).toISOString().slice(0, 10);
    attachments = [{ filename: `Supplier-updates-${ymd}.docx`, content, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }];
  } catch (err) {
    console.error('Daily supplier document failed:', err.message);
  }
  const ok = await sendMail({ to: reportRecipients(getSettings(db)), subject: `Supplier updates ${dateLabel} — ${counts}`, html: layout('Supplier updates — daily', body), attachments });
  // Marked sent even when mail is down: the next day's email starts fresh.
  const ids = runs.map((r) => r.id);
  db.prepare(`UPDATE sync_report_runs SET sent = 1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  db.prepare('DELETE FROM sync_report_runs WHERE started_at < ?').run(new Date(now.getTime() - 30 * DAY_MS).toISOString());
  return { sent: ok, runs: runs.length, sections: sections.map((s) => s.supplier) };
}

export function startSupplierDigestSchedule() {
  const slot = digestTime();
  const plan = () => {
    const at = nextRunAt(new Date(), [slot]);
    if (!at) return;
    setTimeout(() => {
      sendSupplierDigest().catch((err) => console.error('Daily supplier email failed:', err.message)).finally(plan);
    }, at - Date.now()).unref();
  };
  plan();
}
