import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';

process.env.UPLOADS_DIR = path.join(os.tmpdir(), 'procom-test-uploads');
process.env.DISABLE_BACKUPS = '1';

const { useMemoryDb } = await import('./db.js');
const catalog = await import('./catalog.js');

let db;
beforeEach(() => {
  db = useMemoryDb();
});

const mk = (name, sku) => catalog.saveProduct({ name, sku, priceMode: 'manual', priceCents: 10000 }, null, db);
const skus = (q) => catalog.queryProducts({ q }, db).items.map((p) => p.sku).sort();

test('search: model numbers match however they are written (K1-C / K1 C / K1C)', () => {
  mk('Creality K1 C 3D Printer 220x220x250 CFS ready model', 'CREALITY-K1C2025');
  mk('Creality K1-C 3D Printer with AI Camera', 'CREALITY-K1C');
  mk('Creality K1 Max 3D Printer', 'CREALITY-K1MAX');
  assert.deepEqual(skus('K1-C'), ['CREALITY-K1C', 'CREALITY-K1C2025']);
  assert.deepEqual(skus('k1c'), ['CREALITY-K1C', 'CREALITY-K1C2025']);
  assert.deepEqual(skus('Creality K1-C 3D Printer'), ['CREALITY-K1C', 'CREALITY-K1C2025']);
  assert.deepEqual(skus('K1-Max'), ['CREALITY-K1MAX']);
  assert.deepEqual(skus('Ender'), [], 'no false hits');
});

test('search: compact form drops spaces and punctuation; short terms stay exact', () => {
  assert.equal(catalog.compactSearch('K1-C 2025/v.2'), 'k1c2025v2');
  mk('X-S Cable', 'XS-1');
  mk('Xbox Stand', 'XB-1');
  assert.deepEqual(skus('XS'), ['XS-1'], 'plain match on SKU only; "X-S" not loosened for 2-letter terms');
});
