import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';

process.env.UPLOADS_DIR = path.join(os.tmpdir(), 'procom-test-uploads');
process.env.DISABLE_BACKUPS = '1';

const { useMemoryDb } = await import('./db.js');
const catalog = await import('./catalog.js');
const report = await import('./sync-report.js');

let db;
beforeEach(() => {
  db = useMemoryDb();
});

const smdId = () => db.prepare("SELECT id FROM suppliers WHERE name LIKE 'SMD%'").get().id;
const mk = (sku, over = {}) => catalog.saveProduct({ name: `Item ${sku}`, sku, supplierId: smdId(), supplierCode: sku, costCents: 10000, ...over }, null, db);
const set = (sku, fields) => {
  const cols = Object.keys(fields);
  db.prepare(`UPDATE products SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE sku = @sku`).run({ ...fields, sku });
};

test('diff: went on special, price reduced, price increased, special ended, newly listed', () => {
  for (const s of ['SPEC', 'DOWN', 'UP', 'ENDED', 'SAME']) mk(s);
  set('ENDED', { price_cents: 10000, compare_at_cents: 12700 });
  const before = report.snapshotPrices(smdId(), db);

  set('SPEC', { price_cents: 10200, compare_at_cents: 12700 }); // R127 -> R102 on special
  set('DOWN', { price_cents: 11500 }); // cost came down
  set('UP', { price_cents: 13000 });
  set('ENDED', { price_cents: 12700, compare_at_cents: null });
  mk('NEW');
  const d = report.diffPrices(before, smdId(), db);

  assert.deepEqual(d.newSpecials.map((x) => [x.sku, x.normalCents, x.specialCents]), [['SPEC', 12700, 10200]]);
  assert.deepEqual(d.priceDown.map((x) => [x.sku, x.fromCents, x.toCents]).sort(), [['DOWN', 12700, 11500], ['SPEC', 12700, 10200]]);
  assert.equal(d.priceDown[0].sku, 'SPEC', 'biggest drop first');
  assert.equal(d.priceUp, 2, 'UP and ENDED (back to the normal price)');
  assert.equal(d.specialsEnded, 1);
  assert.equal(d.newlyListed, 1);
});

test('Word overview: a real .docx with the summary and both lists; file name in SA time', async () => {
  const buf = await report.buildSyncReportDocx({
    supplierLabel: 'SMD',
    startedAt: '2026-10-05T10:30:00.000Z',
    ok: true,
    summaryRows: [['Costs lowered', 3]],
    changes: { newSpecials: [{ sku: 'A1', name: 'Mouse', normalCents: 12700, specialCents: 10200 }], priceDown: [{ sku: 'B1', name: 'Cable', fromCents: 5000, toCents: 4500 }], priceUp: 0, specialsEnded: 0, newlyListed: 0 },
  });
  assert.ok(Buffer.isBuffer(buf) && buf.length > 2000);
  assert.equal(buf.subarray(0, 2).toString(), 'PK', 'docx is a zip');
  assert.match(buf.toString('latin1'), /word\/document\.xml/);
  assert.equal(report.reportFileName('SMD', '2026-10-05T10:30:00.000Z'), 'SMD-update-2026-10-05-1230.docx');
  const failed = await report.buildSyncReportDocx({ supplierLabel: 'Esquire', startedAt: '2026-10-05T04:00:00.000Z', ok: false, error: 'login failed' });
  assert.equal(failed.subarray(0, 2).toString(), 'PK');
});
