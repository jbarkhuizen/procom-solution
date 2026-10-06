// Admin -> System -> API run log: one row per Esquire / SMD API run, whether it
// worked, how long it took and a one-line overview (owner 2026-10-06).
// Written by esquire.js / smd-api.js after every run (scheduled, started from
// admin, and the SMD connection check); never throws -- logging must not break a sync.
import { getDb } from './db.js';

const KEEP_DAYS = 180;
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// What happened, in one line, plus the figures shown when a row is opened.
export function describeRun(supplier, report) {
  if (!report.ok) return { overview: `Failed: ${report.error || 'unknown error'}`, figures: [] };
  if (supplier === 'SMD') {
    const st = report.stats || {};
    if (report.check) return { overview: `Connection check: ${n(st.matched)} of ${n(st.listed)} products found, nothing changed`, figures: [['Products SMD sent', report.api?.products ?? '—'], ['Found in the API', n(st.matched)], ['Your SMD products', n(st.listed)]] };
    const al = report.autoList;
    const listed = al && report.autoListOn ? n(al.created) : 0;
    return {
      overview: `${n(report.repriced)} shop prices changed · ${n(st.markedOut)} out of stock · ${n(st.backInStock)} back in stock${listed ? ` · ${listed} listed` : ''}`,
      figures: [
        ['Products SMD sent', report.api?.products ?? '—'], ['Your SMD products found in the API', `${n(st.matched)} of ${n(st.listed)}`],
        ['Supplier costs went up / down', `${n(st.costUp)} / ${n(st.costDown)}`], ['Shop prices changed', n(report.repriced)],
        ['On supplier special now', n(st.specials)], ['Went out of stock', n(st.markedOut)], ['Back in stock', n(st.backInStock)],
        ['Hidden (not in the API)', n(st.hidden)], ['Shown again', n(st.unhidden)], ['New products not in the shop yet', n(st.newSkus)], ['New products listed', listed],
      ],
    };
  }
  const im = report.import || {};
  const al = report.autoList;
  const listed = al && report.autoListOn ? n(al.created) : 0;
  return {
    overview: `${n(im.productsRepriced)} shop prices changed · ${n(im.productsMarkedOut)} out of stock · ${n(im.productsBackInStock)} back in stock · ${n(im.rowsNew)} new in the feed${listed ? ` · ${listed} listed` : ''}`,
    figures: [
      ['Products in the Esquire feed', report.feedRows ?? '—'], ['Imported', report.sellableRows ?? '—'], ['New to the feed', n(im.rowsNew)],
      ['Supplier cost changes', n(im.priceChanges)], ['Shop prices changed', n(im.productsRepriced)], ['Went out of stock', n(im.productsMarkedOut)], ['Back in stock', n(im.productsBackInStock)],
      ['Hidden (left the feed)', n(im.productsHidden)], ['Shown again', n(im.productsUnhidden)], ['New products listed', listed],
    ],
  };
}

export function recordApiRun(supplier, report, db = getDb()) {
  try {
    const { overview, figures } = describeRun(supplier, report);
    db.prepare('INSERT INTO api_run_log (supplier, started_at, trigger, kind, ok, error, seconds, overview, figures_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(supplier, report.startedAt, report.trigger === 'scheduled' ? 'scheduled' : 'manual', report.check ? 'check' : 'sync', report.ok ? 1 : 0, report.error || '', n(report.seconds), overview, JSON.stringify(figures));
    db.prepare('DELETE FROM api_run_log WHERE started_at < ?').run(new Date(Date.now() - KEEP_DAYS * 86400_000).toISOString());
  } catch (err) {
    console.error('Could not log the API run:', err.message);
  }
}

const rowOut = (r) => ({ id: r.id, supplier: r.supplier, startedAt: r.started_at, trigger: r.trigger, kind: r.kind, ok: Boolean(r.ok), error: r.error, seconds: r.seconds, overview: r.overview, figures: JSON.parse(r.figures_json || '[]') });

// filters: { supplier, status: 'ok' | 'failed', limit }
export function listApiRuns({ supplier = '', status = '', limit = 200 } = {}, db = getDb()) {
  const where = [];
  const args = [];
  if (supplier) { where.push('supplier = ?'); args.push(supplier); }
  if (status === 'ok') where.push('ok = 1');
  if (status === 'failed') where.push('ok = 0');
  const rows = db.prepare(`SELECT * FROM api_run_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC, id DESC LIMIT ?`).all(...args, Math.min(500, Math.max(1, Number(limit) || 200)));
  return rows.map(rowOut);
}

// Per supplier: the last run, the last good run and the last 7 / 30 days at a glance.
export function apiRunSummary(db = getDb()) {
  const since = (days) => new Date(Date.now() - days * 86400_000).toISOString();
  return ['Esquire', 'SMD'].map((supplier) => {
    const last = db.prepare('SELECT * FROM api_run_log WHERE supplier = ? ORDER BY started_at DESC, id DESC LIMIT 1').get(supplier);
    const lastOk = db.prepare("SELECT started_at FROM api_run_log WHERE supplier = ? AND ok = 1 AND kind = 'sync' ORDER BY started_at DESC LIMIT 1").get(supplier);
    const count = (days) => db.prepare('SELECT COUNT(*) runs, COALESCE(SUM(1 - ok), 0) failed FROM api_run_log WHERE supplier = ? AND started_at >= ?').get(supplier, since(days));
    return { supplier, last: last ? rowOut(last) : null, lastGoodAt: lastOk?.started_at || null, days7: count(7), days30: count(30) };
  });
}

// One-off: the report history (sync_report_runs, last 30 days) seeds an empty log,
// so the page is not blank on the day it ships. Trigger and kind are not known there.
export function backfillApiRunLog(db = getDb()) {
  try {
    if (db.prepare('SELECT COUNT(*) n FROM api_run_log').get().n) return 0;
    const rows = db.prepare('SELECT * FROM sync_report_runs ORDER BY started_at').all();
    const ins = db.prepare('INSERT INTO api_run_log (supplier, started_at, trigger, kind, ok, error, seconds, overview, figures_json) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)');
    for (const r of rows) {
      const figures = JSON.parse(r.summary_json || '[]');
      const pick = (...labels) => figures.find(([l]) => labels.includes(l))?.[1] ?? 0;
      const overview = r.ok
        ? `${pick('Shop prices updated')} shop prices changed · ${pick('Went out of stock', 'Marked out of stock', 'Listed products now out of stock')} out of stock · ${pick('Back in stock', 'Listed products back in stock')} back in stock`
        : `Failed: ${r.error || 'unknown error'}`;
      ins.run(r.supplier, r.started_at, 'scheduled', 'sync', r.ok ? 1 : 0, r.error || '', overview, JSON.stringify(r.ok ? figures : []));
    }
    return rows.length;
  } catch (err) {
    console.error('Could not seed the API run log:', err.message);
    return 0;
  }
}
