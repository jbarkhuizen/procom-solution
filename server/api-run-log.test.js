import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';

process.env.UPLOADS_DIR = path.join(os.tmpdir(), 'procom-test-uploads');
process.env.DISABLE_BACKUPS = '1';

const { useMemoryDb } = await import('./db.js');
const log = await import('./api-run-log.js');

let db;
beforeEach(() => {
  db = useMemoryDb();
});

const smd = (over = {}) => ({ ok: true, trigger: 'scheduled', check: false, startedAt: new Date().toISOString(), seconds: 4, api: { products: 10 }, stats: { listed: 5, matched: 5, markedOut: 2, backInStock: 1 }, repriced: 3, ...over });

test('every run is logged with status, type and a one-line overview', () => {
  log.recordApiRun('SMD', smd(), db);
  log.recordApiRun('SMD', smd({ check: true, trigger: 'manual' }), db);
  log.recordApiRun('SMD', smd({ ok: false, error: 'SMD sent no prices -- skipped' }), db);
  log.recordApiRun('Esquire', { ok: true, trigger: 'manual', startedAt: new Date().toISOString(), seconds: 70, feedRows: 100, sellableRows: 90, import: { rowsNew: 4, productsRepriced: 6, productsMarkedOut: 1, productsBackInStock: 0 } }, db);
  const all = log.listApiRuns({}, db);
  assert.equal(all.length, 4);
  const byKind = Object.fromEntries(all.map((r) => [`${r.supplier}-${r.kind}-${r.ok}`, r]));
  assert.equal(byKind['SMD-sync-true'].overview, '3 shop prices changed · 2 out of stock · 1 back in stock');
  assert.equal(byKind['SMD-check-true'].trigger, 'manual');
  assert.match(byKind['SMD-check-true'].overview, /Connection check: 5 of 5/);
  assert.equal(byKind['SMD-sync-false'].overview, 'Failed: SMD sent no prices -- skipped');
  assert.match(byKind['Esquire-sync-true'].overview, /^6 shop prices changed · 1 out of stock · 0 back in stock · 4 new in the feed/);
  assert.ok(byKind['Esquire-sync-true'].figures.length > 3);
});

test('filters by supplier and status; summary counts failures and the last good run', () => {
  const tenDaysAgo = new Date(Date.now() - 10 * 86400_000).toISOString();
  log.recordApiRun('SMD', smd({ startedAt: tenDaysAgo }), db);
  log.recordApiRun('SMD', smd({ ok: false, error: 'boom', startedAt: new Date().toISOString() }), db);
  log.recordApiRun('Esquire', { ok: true, trigger: 'scheduled', startedAt: new Date().toISOString(), seconds: 1, import: {} }, db);
  assert.equal(log.listApiRuns({ supplier: 'SMD' }, db).length, 2);
  assert.equal(log.listApiRuns({ status: 'failed' }, db).length, 1);
  assert.equal(log.listApiRuns({ supplier: 'Esquire', status: 'failed' }, db).length, 0);
  const s = Object.fromEntries(log.apiRunSummary(db).map((x) => [x.supplier, x]));
  assert.equal(s.SMD.days7.runs, 1, 'the run 10 days ago is outside 7 days');
  assert.equal(s.SMD.days7.failed, 1);
  assert.equal(s.SMD.days30.runs, 2);
  assert.equal(s.SMD.last.ok, false);
  assert.equal(s.SMD.lastGoodAt, tenDaysAgo);
  assert.equal(s.Esquire.days7.failed, 0);
});

test('entries older than 180 days are dropped when the next run is logged', () => {
  log.recordApiRun('SMD', smd({ startedAt: new Date(Date.now() - 200 * 86400_000).toISOString() }), db);
  assert.equal(log.listApiRuns({}, db).length, 0, 'an old run is purged straight away');
  log.recordApiRun('SMD', smd(), db);
  assert.equal(log.listApiRuns({}, db).length, 1);
});

test('an empty log is seeded once from the supplier report history', () => {
  const ins = db.prepare('INSERT INTO sync_report_runs (supplier, started_at, ok, error, summary_json, sent) VALUES (?, ?, ?, ?, ?, 1)');
  ins.run('SMD', new Date().toISOString(), 1, '', JSON.stringify([['Shop prices updated', 104], ['Went out of stock', 58], ['Back in stock', 60]]));
  ins.run('Esquire', new Date().toISOString(), 0, 'login failed', '[]');
  assert.equal(log.backfillApiRunLog(db), 2);
  assert.equal(log.backfillApiRunLog(db), 0, 'only when the log is empty');
  const runs = log.listApiRuns({}, db);
  assert.equal(runs.length, 2);
  assert.ok(runs.some((r) => r.overview === '104 shop prices changed · 58 out of stock · 60 back in stock'));
  assert.ok(runs.some((r) => r.overview === 'Failed: login failed' && !r.ok));
});

test('logging never throws', () => {
  assert.doesNotThrow(() => log.recordApiRun('SMD', smd(), { prepare() { throw new Error('db gone'); } }));
});
