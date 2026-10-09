import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';

process.env.UPLOADS_DIR = path.join(os.tmpdir(), 'procom-test-uploads');
process.env.DISABLE_BACKUPS = '1';
delete process.env.GMAIL_USER; // never send real mail from tests

const { useMemoryDb } = await import('./db.js');
const { updateSettings } = await import('./settings.js');
const mailer = await import('./mailer.js');
const digest = await import('./supplier-digest.js');
const { mergeChanges } = await import('./sync-report.js');

const logged = [];
const realLog = console.log;
console.log = (...a) => (String(a[0]).startsWith('[mail disabled]') ? logged.push(String(a[0])) : realLog(...a));
after(() => (console.log = realLog));

let db;
beforeEach(() => {
  db = useMemoryDb();
  logged.length = 0;
});

const smdReport = (startedAt, changes) => ({
  trigger: 'scheduled', check: false, ok: true, error: '', startedAt, seconds: 3,
  api: { products: 10, prices: 10, stock: 10, photoSkus: 0 },
  stats: { listed: 5, matched: 5, notInApi: 0, costUp: 1, costDown: 2, specials: 1, specialsEnded: 0, markedOut: 0, backInStock: 0, hidden: 0, unhidden: 0, lowStock: 0, descriptions: 0, photoSets: 0, newSkus: 0, newSkuCategories: {} },
  repriced: 3,
  changes,
});
const ch = (sku, from, to) => ({ newSpecials: [{ sku, name: `Item ${sku}`, normalCents: from, specialCents: to }], priceDown: [{ sku, name: `Item ${sku}`, fromCents: from, toCents: to }], priceUp: 1, specialsEnded: 0, newlyListed: 0 });
const runs = () => db.prepare('SELECT supplier, sent FROM sync_report_runs ORDER BY id').all();

test('after every update (default): emailed at once and recorded as sent', async () => {
  await mailer.sendSmdReport(smdReport('2026-10-05T04:30:00.000Z', ch('A', 12700, 10200)));
  assert.equal(logged.length, 1);
  assert.match(logged[0], /SMD sync — 3 cost changes, 1 on special, 1 price down/);
  assert.deepEqual(runs(), [{ supplier: 'SMD', sent: 1 }]);
  assert.equal((await digest.sendSupplierDigest({ db })).reason, 'not in daily mode');
});

test('a failed update is emailed at once even in daily mode, and not repeated in the digest', async () => {
  updateSettings({ supplierReportMode: 'daily' }, db);
  await mailer.sendSmdReport({ trigger: 'scheduled', check: false, ok: false, error: 'SMD sent no prices -- skipped', startedAt: '2026-10-05T04:30:00.000Z', seconds: 2 });
  assert.equal(logged.length, 1, 'sent at once, not held until 19:00');
  assert.match(logged[0], /SMD sync FAILED/);
  assert.deepEqual(runs(), [{ supplier: 'SMD', sent: 1 }], 'recorded and marked sent: the digest will not repeat it');
});

test('off: nothing is emailed', async () => {
  updateSettings({ supplierReportMode: 'off' }, db);
  await mailer.sendSmdReport(smdReport('2026-10-05T04:30:00.000Z', ch('A', 12700, 10200)));
  assert.equal(logged.length, 0);
  assert.equal((await digest.sendSupplierDigest({ db })).sent, false);
});

test('once a day: updates wait, then one email covers them all; a connection check still goes at once', async () => {
  updateSettings({ supplierReportMode: 'daily' }, db);
  await mailer.sendSmdReport(smdReport('2026-10-05T04:30:00.000Z', ch('A', 12700, 10200)));
  await mailer.sendSmdReport(smdReport('2026-10-05T10:30:00.000Z', ch('B', 5000, 4500)));
  assert.equal(logged.length, 0, 'nothing sent during the day');
  assert.deepEqual(runs().map((r) => r.sent), [0, 0]);

  await mailer.sendSmdReport({ ...smdReport('2026-10-05T11:00:00.000Z', null), check: true });
  assert.equal(logged.length, 1, 'connection check emailed at once');
  assert.equal(runs().length, 2, 'connection checks are not recorded');

  const r = await digest.sendSupplierDigest({ db, now: new Date('2026-10-05T17:00:00.000Z') });
  assert.equal(r.runs, 2);
  assert.deepEqual(r.sections, ['SMD']);
  assert.equal(logged.length, 2);
  assert.match(logged[1], /Supplier updates 05 October 2026 — SMD 2 on special, 2 price down/);
  assert.deepEqual(runs().map((x) => x.sent), [1, 1]);
  assert.equal((await digest.sendSupplierDigest({ db, now: new Date('2026-10-05T17:00:00.000Z') })).reason, 'no updates waiting');
});

test('merging a day of runs: one row per product, first "was" and last "now" price', () => {
  const m = mergeChanges([ch('A', 12700, 11000), ch('A', 11000, 10200), null, ch('B', 5000, 4500)]);
  assert.deepEqual(m.priceDown.map((x) => [x.sku, x.fromCents, x.toCents]), [['A', 12700, 10200], ['B', 5000, 4500]]);
  assert.equal(m.newSpecials.length, 2);
  assert.equal(m.priceUp, 3);
});
