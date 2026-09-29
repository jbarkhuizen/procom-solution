import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import express from 'express';

process.env.UPLOADS_DIR = path.join(os.tmpdir(), 'procom-test-uploads');
process.env.DISABLE_BACKUPS = '1';

const { useMemoryDb } = await import('../db.js');
const g = await import('./governance.js');

let db;
beforeEach(() => {
  db = useMemoryDb();
});

const rows = () => db.prepare('SELECT * FROM audit_log ORDER BY id').all();

// A small app shaped like the core: JSON parser, login check setting
// req.admin, then the audit middleware in front of the admin router.
async function withApp(fn) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const admin = express.Router();
  admin.use((req, res, next) => g.auditAdminRequest(req, res, next));
  app.use('/api/admin', (req, _res, next) => { req.admin = { username: 'johan' }; next(); }, admin);
  admin.put('/settings', (req, res) => {
    const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [k, v] of Object.entries(req.body)) up.run(k, JSON.stringify(v));
    res.json({ ok: true });
  });
  admin.put('/products/:id', (req, res) => res.json({ ok: true, id: req.params.id }));
  admin.delete('/categories/:id', (_req, res) => res.status(404).json({ error: 'Not found' }));
  admin.post('/admins', (_req, res) => res.json({ ok: true }));
  admin.post('/specials/preview', (_req, res) => res.json({ ok: true }));
  admin.get('/products', (_req, res) => res.json([]));
  admin.post('/boom', () => { throw new Error('boom'); });
  g.register({ app, admin, wrap: (f) => async (req, res) => { try { res.json(await f(req, res)); } catch (e) { res.status(e.status || 400).json({ error: e.message }); } } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/admin`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    await r.text();
    await new Promise((res) => setTimeout(res, 20)); // let 'finish' run
    return r.status;
  };
  try {
    await fn(call);
  } finally {
    server.close();
  }
}

test('middleware records mutations with friendly names, outcome and settings diff; skips GETs and previews', async () => {
  await withApp(async (call) => {
    assert.equal(await call('GET', '/products'), 200);
    assert.equal(await call('POST', '/specials/preview', { productId: 'x' }), 200);
    assert.equal(rows().length, 0);

    await call('PUT', '/settings', { defaultMarkupPct: 12, siteName: 'Procom Solutions' });
    await call('DELETE', '/categories/cat-1');
    await call('POST', '/admins', { username: 'martin', password: 'super-secret-pw', email: 'm@example.com' });

    const [s, del, adm] = rows();
    assert.equal(s.action, 'Settings saved');
    assert.equal(s.actor, 'johan');
    assert.equal(s.ok, 1);
    assert.equal(s.path, '/api/admin/settings');
    const sd = JSON.parse(s.details);
    assert.deepEqual(sd.changed.defaultMarkupPct, [10, 12]);
    assert.equal(sd.changed.siteName, undefined, 'unchanged keys are not listed');

    assert.equal(del.action, 'Category deleted');
    assert.equal(del.target_id, 'cat-1');
    assert.equal(del.status, 404);
    assert.equal(del.ok, 0);

    assert.equal(adm.action, 'Admin user created');
    assert.ok(!adm.details.includes('super-secret-pw'), 'password value never stored');
    assert.ok(!adm.details.includes('m@example.com'), 'non-whitelisted values not stored');
    const ad = JSON.parse(adm.details);
    assert.deepEqual(ad.redacted, ['password']);
    assert.equal(ad.values.username, 'martin');
  });
});

test('middleware: product diff, failures and a throwing route still record; request never breaks', async () => {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO products (id, sku, name, slug, price_cents, created_at, updated_at) VALUES ('p1', 'S1', 'Mouse', 'mouse', 10000, ?, ?)").run(now, now);
  await withApp(async (call) => {
    // The fake route doesn't change the row -> recorded with noChanges.
    assert.equal(await call('PUT', '/products/p1', { name: 'Mouse', priceCents: 12000, token: 'abc123' }), 200);
    assert.equal(await call('POST', '/boom', { a: 1 }), 500);
    const [p, boom] = rows();
    assert.equal(p.action, 'Product updated');
    assert.equal(p.target_id, 'p1');
    const pd = JSON.parse(p.details);
    assert.equal(pd.noChanges, true);
    assert.deepEqual(pd.redacted, ['token']);
    assert.ok(!p.details.includes('abc123'));
    assert.equal(boom.ok, 0);
    assert.equal(boom.status, 500);
  });
});

test('describeAdminRequest names actions and masks email targets', () => {
  assert.equal(g.describeAdminRequest('PUT', '/orders/o1', { status: 'shipped' }).action, 'Order status changed');
  assert.equal(g.describeAdminRequest('PUT', '/orders/o1', { notes: 'x' }).action, 'Order updated');
  assert.equal(g.describeAdminRequest('POST', '/backups').action, 'Backup created');
  assert.equal(g.describeAdminRequest('PUT', '/promos/p1', {}).action, 'Promo code saved');
  assert.equal(g.describeAdminRequest('POST', '/feed/smd-autolist', { dryRun: true }), null);
  assert.match(g.describeAdminRequest('POST', '/feed/smd-autolist', { dryRun: false, list: 'cash' }).action, /SMD auto-list applied/);
  assert.equal(g.describeAdminRequest('POST', '/newsletters/campaigns/c1/approve').action, 'Newsletter approved');
  assert.equal(g.describeAdminRequest('DELETE', '/newsletters/suppressions/jane%40example.com').target, 'j***@example.com');
  assert.ok(g.describeAdminRequest('POST', '/some-new-thing/run').action.length > 0);
});

test('summarizeBody redacts secrets, keeps whitelisted values, caps size', () => {
  const s = g.summarizeBody({ password: 'x', newPassword: 'y', apiKey: 'k', sessionToken: 't', status: 'paid', description: 'long text', ids: [1, 2, 3] });
  assert.deepEqual(s.redacted.sort(), ['apiKey', 'newPassword', 'password', 'sessionToken']);
  assert.equal(s.values.status, 'paid');
  assert.equal(s.values.ids, '[3 items]');
  assert.equal(s.values.description, undefined);
  assert.ok(s.fields.includes('description'));

  const big = {};
  for (let i = 0; i < 200; i++) big[`field_${i}_with_a_long_name`] = 'v';
  big.name = 'n'.repeat(500);
  const capped = g.capDetails(g.summarizeBody(big));
  assert.ok(capped.length <= 1000, `details ${capped.length} chars`);
  assert.equal(g.summarizeBody(null), null);
});

test('recordAudit logs sign-in events and never throws', () => {
  g.recordAudit({ action: 'admin.login', actor: 'johan', req: { method: 'POST', originalUrl: '/api/admin/login', ip: '1.2.3.4' } });
  g.recordAudit({ action: 'admin.login_failed', actor: 'nobody', req: { method: 'POST', originalUrl: '/api/admin/login?x=1', ip: '5.6.7.8' }, details: { password: 'nope' } });
  const [ok, bad] = rows();
  assert.equal(ok.action, 'Signed in');
  assert.equal(ok.area, 'Sign-in');
  assert.equal(bad.action, 'Sign-in failed');
  assert.equal(bad.ok, 0);
  assert.equal(bad.path, '/api/admin/login');
  assert.ok(!bad.details.includes('nope'));
  db.close();
  assert.doesNotThrow(() => g.recordAudit({ action: 'admin.logout', actor: 'x' }));
});

test('listAudit filters, pages and exports CSV; prune keeps 12 months', () => {
  const ins = db.prepare("INSERT INTO audit_log (created_at, actor, action, area, ok, details) VALUES (?, ?, ?, 'Catalogue', ?, '')");
  ins.run('2024-01-01T10:00:00.000Z', 'old', 'Product updated', 1);
  ins.run('2026-09-10T10:00:00.000Z', 'johan', 'Product updated', 1);
  ins.run('2026-09-11T21:30:00.000Z', 'martin', 'Category deleted', 0); // 2026-09-11 23:30 SAST
  for (let i = 0; i < 60; i++) ins.run(new Date().toISOString(), 'johan', '=cmd', 1);

  assert.equal(g.listAudit({ actor: 'martin' }).total, 1);
  assert.equal(g.listAudit({ from: '2026-09-11', to: '2026-09-11' }).total, 1);
  assert.equal(g.listAudit({ from: '2026-09-12', to: '2026-09-12' }).total, 0);
  assert.equal(g.listAudit({ ok: '0' }).total, 1);
  assert.equal(g.listAudit({ q: 'category' }).total, 1);
  const p2 = g.listAudit({ page: 2, pageSize: 50 });
  assert.equal(p2.items.length, 13);
  assert.equal(p2.pages, 2);
  assert.ok(p2.actors.includes('martin'));

  const csv = g.auditCsv({ actor: 'johan' });
  assert.ok(csv.includes("'=cmd"), 'formula-looking cells are neutralised');

  assert.equal(g.pruneAudit(12), 1);
  assert.equal(g.listAudit({ actor: 'old' }).total, 0);
});

test('todos seed once: deleted seed items never come back', () => {
  const n = db.prepare('SELECT COUNT(*) n FROM todo_items').get().n;
  // useMemoryDb doesn't call register(), so seed explicitly.
  assert.equal(n, 0);
  assert.equal(g.seedTodos(db), g.SEED_TODOS.length);
  const first = g.listTodos({}, db).items[0];
  assert.ok(g.deleteTodo(first.id, db));
  assert.equal(g.seedTodos(db), 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM todo_items').get().n, g.SEED_TODOS.length - 1);
});

test('todos: create, validate, filter, mark done and reopen', () => {
  assert.throws(() => g.createTodo({ title: '  ' }), /title/);
  assert.throws(() => g.createTodo({ title: 'x', priority: 'urgent' }), /Priority/);
  const a = g.createTodo({ title: 'Fix photos', area: 'Photos', priority: 'high' }, db, { createdBy: 'johan' });
  const b = g.createTodo({ title: 'Check SEO', area: 'SEO' });
  assert.equal(a.number, 1);
  assert.equal(b.number, 2);
  assert.equal(a.status, 'open');
  assert.equal(a.createdBy, 'johan');

  const done = g.updateTodo(a.id, { status: 'done' });
  assert.ok(done.doneAt);
  assert.equal(g.listTodos({ status: 'done' }).items.length, 1);
  assert.equal(g.listTodos({ status: 'not_done' }).items.length, 1);
  assert.equal(g.listTodos({ area: 'SEO' }).items[0].id, b.id);
  assert.equal(g.listTodos({ q: 'photos' }).items.length, 1);
  assert.equal(g.listTodos({}).counts.done, 1);

  const reopened = g.updateTodo(a.id, { status: 'open' });
  assert.equal(reopened.doneAt, '');
  assert.equal(g.updateTodo('missing', { title: 'x' }), null);
});
