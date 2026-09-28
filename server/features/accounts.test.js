import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import express from 'express';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';

process.env.UPLOADS_DIR = path.join(os.tmpdir(), 'procom-test-uploads');
process.env.DISABLE_BACKUPS = '1';

const { useMemoryDb } = await import('../db.js');
const catalog = await import('../catalog.js');
const orders = await import('../orders.js');
const accounts = await import('./accounts.js');

let db;
let server;
let base;
let mails;

// Same error wrapper as server/index.js.
const wrap = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (err) {
    if (!res.headersSent) res.status(err.status || 400).json({ error: err.message });
  }
};

beforeEach(async () => {
  db = useMemoryDb();
  mails = [];
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  const admin = express.Router();
  app.use('/api/admin', admin); // auth is the core's job; not under test here
  accounts.register({ app, admin, wrap, rateLimit, express, siteUrl: 'https://shop.test', mail: async (m) => mails.push(m) });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => new Promise((resolve) => server.close(resolve)));

// Minimal cookie-jar client.
function client() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) {
      const pair = set.split(';')[0];
      cookie = pair.endsWith('=') ? '' : pair;
    }
    return { status: res.status, body: await res.json().catch(() => null), setCookie: set };
  };
}

const tick = () => new Promise((r) => setTimeout(r, 20));
const tokenFrom = (mail, param) => mail.html.match(new RegExp(`[?&]${param}=([a-f0-9]{64})`))[1];
const user = { firstName: 'Ann', lastName: 'Lee', email: 'Ann@Example.com', password: 'correct horse' };

function placeOrder(email = 'ann@example.com') {
  const catId = db.prepare("SELECT id FROM categories WHERE slug = 'keyboards-mice'").get().id;
  const p = catalog.saveProduct({ name: `Mouse ${Math.random()}`, brand: 'Logi', costCents: 10000, categoryId: catId, weightG: 500 });
  const ship = db.prepare("SELECT id FROM shipping_options WHERE name LIKE 'PUDO Small%'").get().id;
  const customer = { firstName: 'Ann', lastName: 'Lee', email, phone: '0821234567', addressLine1: '1 Main Rd', city: 'Pretoria', postalCode: '0081' };
  return orders.createOrder({ customer, shippingOptionId: ship, items: [{ productId: p.id, quantity: 1 }] });
}

async function registerAndVerify(req, over = {}) {
  const r = await req('POST', '/api/account/register', { ...user, ...over });
  assert.equal(r.status, 201);
  await tick();
  const mail = mails.at(-1);
  return req('POST', '/api/account/verify', { token: tokenFrom(mail, 'verify') });
}

test('register -> verify -> login -> me -> logout', async () => {
  const req = client();
  const reg = await req('POST', '/api/account/register', user);
  assert.equal(reg.status, 201);
  assert.ok(reg.body.ok);
  await tick();
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'ann@example.com');
  assert.match(mails[0].html, /https:\/\/shop\.test\/account\.html\?verify=/);

  // Unverified: correct password is refused and a fresh link is mailed.
  const early = await req('POST', '/api/account/login', { email: user.email, password: user.password });
  assert.equal(early.status, 403);
  await tick();
  assert.equal(mails.length, 2);
  // The first link was replaced by the second.
  assert.equal((await req('POST', '/api/account/verify', { token: tokenFrom(mails[0], 'verify') })).status, 400);

  const ver = await req('POST', '/api/account/verify', { token: tokenFrom(mails[1], 'verify') });
  assert.equal(ver.status, 200);
  assert.equal(ver.body.client.emailVerified, true);
  assert.match(ver.setCookie, /procom_client_session=.*HttpOnly.*SameSite=Lax/i);
  // Tokens are single-use.
  assert.equal((await req('POST', '/api/account/verify', { token: tokenFrom(mails[1], 'verify') })).status, 400);

  await req('POST', '/api/account/logout');
  assert.equal((await req('GET', '/api/account/me')).body.authenticated, false);

  assert.equal((await req('POST', '/api/account/login', { email: 'ann@example.com', password: 'wrong password' })).status, 401);
  const login = await req('POST', '/api/account/login', { email: ' ANN@example.com ', password: user.password });
  assert.equal(login.status, 200);
  const me = await req('GET', '/api/account/me');
  assert.equal(me.body.authenticated, true);
  assert.equal(me.body.client.email, 'ann@example.com');
  assert.equal(me.body.client.firstName, 'Ann');
  assert.ok(!('password_hash' in me.body.client) && !('passwordHash' in me.body.client));
  assert.ok(db.prepare('SELECT last_login_at FROM clients').get().last_login_at);

  // Session token stored hashed, not as the cookie value.
  const stored = db.prepare('SELECT token_hash FROM client_sessions').get().token_hash;
  assert.ok(!login.setCookie.includes(stored));

  const out = await req('POST', '/api/account/logout');
  assert.equal(out.status, 200);
  assert.equal((await req('GET', '/api/account/me')).body.authenticated, false);
  assert.equal((await req('GET', '/api/account/orders')).status, 401);
});

test('saved details and newsletter opt-in; email and flags cannot be self-edited', async () => {
  const req = client();
  await registerAndVerify(req);
  const r = await req('PUT', '/api/account/me', { phone: '0820000000', addressLine1: '5 Oak St', city: 'Pretoria', province: 'Gauteng', postalCode: '0081', newsletter: true, email: 'evil@example.com', disabled: false, emailVerified: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.client.city, 'Pretoria');
  assert.equal(r.body.client.newsletter, true);
  assert.ok(r.body.client.newsletterAt);
  assert.equal(r.body.client.email, 'ann@example.com');
  const off = await req('PUT', '/api/account/me', { newsletter: false });
  assert.equal(off.body.client.newsletter, false);
});

test('orders link to the account: guest orders on verify, new orders on creation', async () => {
  const guest = placeOrder('ANN@example.com');
  const stranger = placeOrder('bob@example.com');
  assert.equal(guest.clientId, null);

  const req = client();
  await req('POST', '/api/account/register', user);
  await tick();
  // Not linked before the email is proven.
  const before = placeOrder();
  assert.equal(db.prepare('SELECT client_id FROM orders WHERE id = ?').get(before.id).client_id, null);

  const ver = await req('POST', '/api/account/verify', { token: tokenFrom(mails.at(-1), 'verify') });
  const id = ver.body.client.id;
  const linked = (oid) => db.prepare('SELECT client_id FROM orders WHERE id = ?').get(oid).client_id;
  assert.equal(linked(guest.id), id);
  assert.equal(linked(before.id), id);
  assert.equal(linked(stranger.id), null);

  const after = placeOrder('ann@example.com'); // onOrderCreated hook
  assert.equal(linked(after.id), id);

  const list = await req('GET', '/api/account/orders');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.map((o) => o.id).sort(), [guest.id, before.id, after.id].sort());
  assert.equal(list.body[0].statusLabel, 'Awaiting payment');
  assert.equal(list.body[0].invoiceUrl, null); // unpaid
  orders.markOrderPaid(after.id);
  const paid = (await req('GET', '/api/account/orders')).body.find((o) => o.id === after.id);
  assert.equal(paid.invoiceUrl, `/invoice.html?o=${after.id}`);
});

test('password reset flow', async () => {
  const req = client();
  await registerAndVerify(req);
  const other = client();
  await other('POST', '/api/account/login', { email: user.email, password: user.password });
  assert.equal((await other('GET', '/api/account/me')).body.authenticated, true);

  mails.length = 0;
  const fp = await client()('POST', '/api/account/forgot-password', { email: 'ann@EXAMPLE.com' });
  assert.equal(fp.status, 200);
  await tick();
  assert.equal(mails.length, 1);
  const token = tokenFrom(mails[0], 'reset');

  const anon = client();
  assert.equal((await anon('POST', '/api/account/reset-password', { token, password: 'short' })).status, 400);
  assert.equal((await anon('POST', '/api/account/reset-password', { token: 'f'.repeat(64), password: 'a new password' })).status, 400);
  const ok = await anon('POST', '/api/account/reset-password', { token, password: 'a new password' });
  assert.equal(ok.status, 200);
  assert.equal((await anon('GET', '/api/account/me')).body.authenticated, true);
  // Single-use, old password dead, other sessions signed out.
  assert.equal((await anon('POST', '/api/account/reset-password', { token, password: 'another one!' })).status, 400);
  assert.equal((await other('GET', '/api/account/me')).body.authenticated, false);
  assert.equal((await client()('POST', '/api/account/login', { email: user.email, password: user.password })).status, 401);
  assert.equal((await client()('POST', '/api/account/login', { email: user.email, password: 'a new password' })).status, 200);
});

test('expired reset and verification tokens are refused', async () => {
  const req = client();
  await req('POST', '/api/account/register', user);
  await tick();
  db.prepare('UPDATE clients SET verify_expires_at = ?').run(Date.now() - 1);
  assert.equal((await req('POST', '/api/account/verify', { token: tokenFrom(mails[0], 'verify') })).status, 400);
  const r = accounts.requestPasswordReset(user.email, db);
  db.prepare('UPDATE clients SET reset_expires_at = ?').run(Date.now() - 1);
  assert.equal((await req('POST', '/api/account/reset-password', { token: r.token, password: 'a new password' })).status, 400);
});

test('no user enumeration on register, login or reset', async () => {
  const req = client();
  await registerAndVerify(req);
  mails.length = 0;

  // Register: same answer for a new and an existing email; the real owner is emailed instead.
  const fresh = await client()('POST', '/api/account/register', { ...user, email: 'new@example.com' });
  const dup = await client()('POST', '/api/account/register', { ...user, password: 'attacker password' });
  assert.equal(fresh.status, dup.status);
  assert.deepEqual(fresh.body, dup.body);
  await tick();
  const dupMail = mails.find((m) => m.to === 'ann@example.com');
  assert.match(dupMail.subject, /already have/);
  // The duplicate attempt did not change the password.
  assert.equal((await client()('POST', '/api/account/login', { email: user.email, password: 'attacker password' })).status, 401);
  assert.equal((await client()('POST', '/api/account/login', { email: user.email, password: user.password })).status, 200);

  // Login: unknown email and wrong password look identical.
  const unknown = await client()('POST', '/api/account/login', { email: 'nobody@example.com', password: 'whatever123' });
  const wrong = await client()('POST', '/api/account/login', { email: user.email, password: 'whatever123' });
  assert.equal(unknown.status, 401);
  assert.deepEqual(unknown, { ...wrong, setCookie: unknown.setCookie });

  // Forgot password: identical answer; only the real account gets mail.
  mails.length = 0;
  const a = await client()('POST', '/api/account/forgot-password', { email: 'nobody@example.com' });
  const b = await client()('POST', '/api/account/forgot-password', { email: user.email });
  assert.deepEqual(a, b);
  await tick();
  assert.deepEqual(mails.map((m) => m.to), ['ann@example.com']);
});

test('repeat registration of an unverified email sends a set-password link, not a takeover', async () => {
  await client()('POST', '/api/account/register', user);
  await client()('POST', '/api/account/register', { ...user, password: 'attacker password' });
  await tick();
  const finish = mails.at(-1);
  assert.match(finish.subject, /Finish setting up/);
  // Neither password works before the mailbox owner acts.
  assert.equal((await client()('POST', '/api/account/login', { email: user.email, password: 'attacker password' })).status, 401);
  const owner = client();
  const r = await owner('POST', '/api/account/reset-password', { token: tokenFrom(finish, 'reset'), password: 'owners own pw' });
  assert.equal(r.status, 200);
  assert.equal(r.body.client.emailVerified, true);
});

test('cross-origin account mutations are blocked', async () => {
  const res = await fetch(`${base}/api/account/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.test' }, body: JSON.stringify({ email: 'a@b.co', password: 'x' }) });
  assert.equal(res.status, 403);
});

test('admin: clients CRM, registered users, disable, resend, delete', async () => {
  const guest = placeOrder('guest@example.com');
  orders.markOrderPaid(guest.id);
  placeOrder('guest@example.com');
  const req = client();
  const ver = await registerAndVerify(req);
  const id = ver.body.client.id;
  const mine = placeOrder('ann@example.com');
  orders.markOrderPaid(mine.id);
  await client()('POST', '/api/account/register', { ...user, email: 'pending@example.com' });

  const crm = await client()('GET', '/api/admin/clients');
  assert.equal(crm.body.total, 3);
  const g = crm.body.items.find((c) => c.email === 'guest@example.com');
  assert.equal(g.orderCount, 2);
  assert.equal(g.paidOrderCount, 1);
  assert.equal(g.totalSpentCents, guest.totalCents);
  assert.equal(g.registered, false);
  const ann = crm.body.items.find((c) => c.email === 'ann@example.com');
  assert.equal(ann.registered, true);
  assert.equal(ann.verified, true);
  assert.equal((await client()('GET', '/api/admin/clients?q=pending')).body.total, 1);

  const detail = await client()('GET', '/api/admin/clients/detail?email=ANN%40example.com');
  assert.equal(detail.body.client.id, id);
  assert.equal(detail.body.orders.length, 1);
  assert.equal(detail.body.orders[0].linked, true);
  assert.equal((await client()('GET', '/api/admin/clients/detail?email=none%40example.com')).status, 404);

  const users = (await client()('GET', '/api/admin/registered-users')).body;
  assert.equal(users.length, 2);
  const pending = users.find((u) => u.email === 'pending@example.com');
  assert.equal(pending.emailVerified, false);
  assert.equal(users.find((u) => u.id === id).orderCount, 1);

  mails.length = 0;
  assert.equal((await client()('POST', `/api/admin/registered-users/${pending.id}/resend-verification`)).status, 200);
  await tick();
  assert.equal(mails[0].to, 'pending@example.com');
  assert.equal((await client()('POST', `/api/admin/registered-users/${id}/resend-verification`)).status, 400); // already verified

  // Disable signs the customer out and blocks login.
  assert.equal((await client()('PUT', `/api/admin/registered-users/${id}/disabled`, { disabled: true })).body.disabled, true);
  assert.equal((await req('GET', '/api/account/me')).body.authenticated, false);
  assert.equal((await client()('POST', '/api/account/login', { email: user.email, password: user.password })).status, 403);
  await client()('PUT', `/api/admin/registered-users/${id}/disabled`, { disabled: false });
  assert.equal((await client()('POST', '/api/account/login', { email: user.email, password: user.password })).status, 200);

  // Delete removes the login; the order stays, unlinked.
  assert.equal((await client()('DELETE', `/api/admin/registered-users/${id}`)).status, 200);
  assert.equal(db.prepare('SELECT client_id FROM orders WHERE id = ?').get(mine.id).client_id, null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM clients WHERE id = ?').get(id).n, 0);
  assert.equal((await client()('DELETE', `/api/admin/registered-users/${id}`)).status, 404);
});
