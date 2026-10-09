import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';

process.env.UPLOADS_DIR = path.join(os.tmpdir(), 'procom-test-uploads');
process.env.DISABLE_BACKUPS = '1';
process.env.BACKUPS_DIR = path.join(os.tmpdir(), `procom-test-backups-${process.pid}`);
delete process.env.GMAIL_USER;

const { useMemoryDb } = await import('./db.js');
const catalog = await import('./catalog.js');
const orders = await import('./orders.js');
const auth = await import('./auth.js');
const backups = await import('./backups.js');

let db;
beforeEach(() => {
  db = useMemoryDb();
});
const realLog = console.log;
console.log = (...a) => (String(a[0]).startsWith('[mail disabled]') ? undefined : realLog(...a));
after(() => {
  console.log = realLog;
  fs.rmSync(process.env.BACKUPS_DIR, { recursive: true, force: true });
});

const catId = (slug) => db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug).id;
const customer = { firstName: 'Ann', lastName: 'Lee', email: 'ann@example.com', phone: '0821234567', addressLine1: '1 Main Rd', city: 'Pretoria', postalCode: '0081' };
const courier = () => db.prepare("SELECT id FROM shipping_options WHERE name LIKE 'PUDO Small%'").get().id;
let n = 0;
const stockItem = (over = {}) => catalog.saveProduct({ name: `Low ${++n}`, sku: `LOW${n}`, costCents: 10000, categoryId: catId('keyboards-mice'), weightG: 100, fulfilment: 'stock', stockQty: 50, ...over });

test('admin sessions are stored hashed; the cookie token still logs in and out', () => {
  const admin = auth.createAdmin({ username: 'boss', password: 'a-long-password-1' }, db);
  const token = auth.createSession(admin.id, db);
  const stored = db.prepare('SELECT token FROM admin_sessions').get().token;
  assert.notEqual(stored, token, 'the database never holds the cookie value');
  assert.match(stored, /^[0-9a-f]{64}$/);
  assert.equal(auth.getSession(token, db).username, 'boss');
  assert.equal(auth.getSession(stored, db), null, 'a copy of the stored value is not a login');
  auth.destroySession(token, db);
  assert.equal(auth.getSession(token, db), null);
});

test('very long passwords are refused before the expensive hash', () => {
  auth.createAdmin({ username: 'boss', password: 'a-long-password-1' }, db);
  assert.equal(auth.verifyLogin('boss', 'a-long-password-1', db)?.username, 'boss');
  assert.equal(auth.verifyLogin('boss', 'x'.repeat(5000), db), null);
});

test('search: a typed % or _ is an ordinary character, not a wildcard', () => {
  stockItem({ name: 'Mouse 100% cotton', sku: 'PCT1' });
  stockItem({ name: 'Mouse plain', sku: 'PLAIN1' });
  const names = (q) => catalog.queryProducts({ q, pageSize: 50 }, db).items.map((p) => p.name);
  assert.deepEqual(names('100%'), ['Mouse 100% cotton']);
  assert.equal(names('%').length, 1, 'a lone % matches only names that contain a %');
  assert.deepEqual(names('PLA_N'), [], 'an underscore does not match any single character');
});

test('a supplier that still has products cannot be deleted', () => {
  const smd = db.prepare("SELECT id FROM suppliers WHERE name LIKE 'SMD%'").get().id;
  const extra = catalog.saveSupplier({ name: 'Spare Supplier' }, null, db).id;
  catalog.saveProduct({ name: 'Uses SMD', sku: 'USESMD', supplierId: smd, supplierCode: 'U1', costCents: 10000, categoryId: catId('keyboards-mice') }, null, db);
  assert.throws(() => catalog.deleteSupplier(smd, db), /still has 1 product/);
  assert.equal(catalog.deleteSupplier(extra, db), true, 'an unused supplier can go');
});

test('quantities are never silently changed; bad ones are refused', () => {
  const p = stockItem();
  for (const quantity of [0, -1, 1000, 1.5, 'abc']) {
    assert.throws(() => orders.createOrder({ customer, shippingOptionId: courier(), items: [{ productId: p.id, quantity }] }), /whole number from 1 to 999/, String(quantity));
  }
  assert.ok(orders.createOrder({ customer, shippingOptionId: courier(), items: [{ productId: p.id, quantity: 2 }] }));
});

test('a paid order cannot go back to awaiting payment; unpaid checkouts are cancelled after 14 days', () => {
  const p = stockItem();
  const paid = orders.createOrder({ customer, shippingOptionId: courier(), items: [{ productId: p.id, quantity: 1 }] });
  orders.markOrderPaid(paid.id, { pfPaymentId: 'x' });
  assert.throws(() => orders.updateOrder(paid.id, { status: 'pending_payment' }), /cannot go back/);

  const old = orders.createOrder({ customer, shippingOptionId: courier(), items: [{ productId: p.id, quantity: 1 }] });
  const fresh = orders.createOrder({ customer, shippingOptionId: courier(), items: [{ productId: p.id, quantity: 1 }] });
  db.prepare('UPDATE orders SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 15 * 86400_000).toISOString(), old.id);
  assert.equal(orders.cancelAbandonedOrders(db), 1);
  assert.equal(orders.getOrder(old.id, db).status, 'cancelled');
  assert.equal(orders.getOrder(fresh.id, db).status, 'pending_payment');
  assert.equal(orders.getOrder(paid.id, db).status, 'paid');
});

test('backup pruning keeps the newest 30 routine backups and never touches labelled ones', async () => {
  const dir = process.env.BACKUPS_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const labelled = path.join(dir, 'procom-2026-01-01T00-00-00-000Z-pre-pricing.db');
  fs.writeFileSync(labelled, 'x');
  fs.utimesSync(labelled, new Date('2026-01-01'), new Date('2026-01-01'));
  for (let i = 0; i < 33; i++) {
    const f = path.join(dir, `procom-2026-02-${String(i + 1).padStart(2, '0')}-scheduled.db`);
    fs.writeFileSync(f, 'x');
    const t = new Date(Date.parse('2026-02-01') + i * 86400_000);
    fs.utimesSync(f, t, t);
  }
  await backups.createBackup('manual');
  const files = fs.readdirSync(dir);
  assert.ok(files.includes(path.basename(labelled)), 'the pre-pricing backup survives');
  assert.equal(files.filter((f) => /-(scheduled|startup|manual)\.db$/.test(f)).length, 30);
});

test('five wrong passwords lock one account for 15 minutes, from any address; the right password clears the count', async () => {
  const guard = await import('./login-guard.js');
  guard._resetLoginGuard();
  const t0 = 1_000_000;
  for (let i = 0; i < 4; i++) guard.noteLogin('Boss', false, t0 + i);
  assert.equal(guard.loginLocked('boss', t0 + 10), false, 'four misses: still open');
  guard.noteLogin('boss', true, t0 + 11);
  for (let i = 0; i < 4; i++) guard.noteLogin('boss', false, t0 + 20 + i);
  assert.equal(guard.loginLocked('boss', t0 + 30), false, 'the right password reset the count');
  guard.noteLogin('BOSS', false, t0 + 40); // the fifth
  assert.equal(guard.loginLocked('boss', t0 + 50), true);
  assert.equal(guard.loginLocked('someone-else', t0 + 50), false);
  assert.equal(guard.loginLocked('boss', t0 + 40 + guard.LOCK_MS + 1), false, 'unlocks after 15 minutes');
  guard.noteLogin('boss', false, t0 + 40 + guard.LOCK_MS + 2);
  assert.equal(guard.loginLocked('boss', t0 + 40 + guard.LOCK_MS + 3), false, 'a new count starts after a lock');
});
