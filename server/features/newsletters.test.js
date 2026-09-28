import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';

process.env.UPLOADS_DIR = path.join(os.tmpdir(), 'procom-test-uploads');
process.env.DISABLE_BACKUPS = '1';

const { useMemoryDb } = await import('../db.js');
const catalog = await import('../catalog.js');
const nl = await import('./newsletters.js');

const SITE = 'https://shop.test';
let db;
let server;
let base;
let mails;
const fakeMail = async (m) => {
  mails.push(m);
  return true;
};

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
  admin.use((req, _res, next) => {
    req.admin = { adminId: 'x', username: 'tester' };
    next();
  });
  app.use('/api/admin', admin);
  nl.register({ app, admin, wrap, rateLimit, express, siteUrl: SITE, mail: fakeMail, autoStart: false });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => new Promise((resolve) => server.close(resolve)));

const call = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const tick = () => new Promise((r) => setTimeout(r, 20));
const tokenFrom = (mail, param) => mail.html.match(new RegExp(`[?&]${param}=([a-f0-9]{64})`))[1];

function addClient(email, { optIn = 1, verified = 1, disabled = 0 } = {}) {
  const ts = new Date().toISOString();
  db.prepare(`INSERT INTO clients (id, email, password_hash, first_name, last_name, email_verified, disabled, newsletter_opt_in, newsletter_opted_in_at, created_at, updated_at)
    VALUES (?, ?, 'x', 'A', 'B', ?, ?, ?, ?, ?, ?)`).run(randomUUID(), email, verified, disabled, optIn, optIn ? ts : null, ts, ts);
}

function addConfirmed(email) {
  const out = nl.subscribe({ email, source: 'footer' }, db);
  assert.ok(nl.confirmSubscription(out.token, db));
}

function product(name = 'Mouse', costCents = 10000) {
  const catId = db.prepare("SELECT id FROM categories WHERE slug = 'keyboards-mice'").get().id;
  return catalog.saveProduct({ name, brand: 'Logi', costCents, categoryId: catId, weightG: 500 });
}

// Draft -> test -> approve -> queue, the only way into the send queue.
async function approvedCampaign(content = { mode: 'text', bodyText: 'Hello there' }) {
  const c = nl.saveCampaign({ subject: 'September specials', ...content }, null, { db });
  await nl.sendTest(c.id, 'admin@shop.test', { siteUrl: SITE, mail: fakeMail, db });
  return nl.approveCampaign(c.id, { db, siteUrl: SITE });
}

test('footer signup is double opt-in and records source + time', async () => {
  const r = await call('POST', '/api/newsletter/subscribe', { email: 'Ann@Example.com', source: 'footer' });
  assert.equal(r.status, 200);
  await tick();
  assert.equal(mails.length, 1);
  assert.match(mails[0].html, /newsletter\.html\?confirm=/);
  assert.equal(nl.isEligible('ann@example.com', db), false, 'pending is not opted in');
  const row = db.prepare('SELECT * FROM newsletter_subscribers WHERE email = ?').get('ann@example.com');
  assert.equal(row.source, 'footer');
  assert.ok(row.subscribed_at);

  const c = await call('POST', '/api/newsletter/confirm', { token: tokenFrom(mails[0], 'confirm') });
  assert.equal(c.status, 200);
  assert.equal(nl.isEligible('ann@example.com', db), true);
  assert.ok(db.prepare('SELECT confirmed_at FROM newsletter_subscribers WHERE email = ?').get('ann@example.com').confirmed_at);

  // Same answer for an already-subscribed address, and no second email.
  const again = await call('POST', '/api/newsletter/subscribe', { email: 'ann@example.com' });
  assert.deepEqual(again.body, r.body);
  await tick();
  assert.equal(mails.length, 1);

  // Honeypot: looks fine, does nothing.
  await call('POST', '/api/newsletter/subscribe', { email: 'bot@example.com', website: 'spam' });
  await tick();
  assert.equal(mails.length, 1);
  assert.equal((await call('POST', '/api/newsletter/confirm', { token: 'f'.repeat(64) })).status, 400);
});

test('audience is opt-in only: confirmed subscribers + verified opted-in accounts, de-duplicated', () => {
  addConfirmed('sub@example.com');
  nl.subscribe({ email: 'pending@example.com' }, db); // never confirmed
  addClient('acct@example.com');
  addClient('noopt@example.com', { optIn: 0 });
  addClient('unverified@example.com', { verified: 0 });
  addClient('disabled@example.com', { disabled: 1 });
  addClient('sub@example.com'); // both routes: listed once
  const emails = nl.listAudience(db).map((a) => a.email).sort();
  assert.deepEqual(emails, ['acct@example.com', 'sub@example.com']);
  assert.equal(nl.listAudience(db).find((a) => a.email === 'sub@example.com').source, 'subscriber');
});

test('compose -> test -> approve -> send: approval needs a test, edits need a new one', async () => {
  const c = nl.saveCampaign({ subject: 'Hi', mode: 'text', bodyText: 'Body' }, null, { db });
  assert.throws(() => nl.approveCampaign(c.id, { db }), /test email/);
  assert.throws(() => nl.queueCampaign(c.id, { db }), /Approve/);
  await nl.sendTest(c.id, 'admin@shop.test', { siteUrl: SITE, mail: fakeMail, db });
  assert.match(mails.at(-1).subject, /^\[TEST\] Hi/);
  assert.equal(nl.approveCampaign(c.id, { db }).status, 'approved');
  assert.equal(nl.saveCampaign({ subject: 'Hi 2', mode: 'text', bodyText: 'Body' }, c.id, { db }).status, 'draft');
  assert.throws(() => nl.approveCampaign(c.id, { db }), /test email/);
});

test('daily cap: stops at the cap, carries on the next SAST day', async () => {
  for (let i = 0; i < 30; i++) addConfirmed(`p${i}@example.com`);
  nl.updateNewsletterSettings({ dailyCap: 25, batchSize: 20 }, db);
  const c = await approvedCampaign(); // the test email counts too: 1 used
  nl.queueCampaign(c.id, { db });
  mails = [];
  const day1 = Date.parse('2026-10-01T08:00:00Z');
  const run = (t) => nl.runSendBatch({ db, mail: fakeMail, siteUrl: SITE, now: () => t });
  // The test email was counted on the real "today"; pin it to day 1 for the check.
  db.prepare('DELETE FROM newsletter_daily_usage').run();
  assert.equal((await run(day1)).sent, 20);
  assert.equal((await run(day1 + 60_000)).sent, 5);
  const capped = await run(day1 + 120_000);
  assert.equal(capped.skipped, 'cap');
  assert.equal(mails.length, 25);
  assert.equal(nl.usedToday(db, day1), 25);
  // 21:59 UTC on day 1 is still day 1 in SAST... 22:00 UTC is the next day.
  assert.equal((await run(Date.parse('2026-10-01T21:59:00Z'))).skipped, 'cap');
  assert.equal((await run(Date.parse('2026-10-01T22:00:30Z'))).sent, 5);
  assert.equal(nl.getCampaign(c.id, db).status, 'sent');
  assert.equal(new Set(mails.map((m) => m.to)).size, 30, 'nobody got it twice');
});

test('resume after restart: queue survives, in-flight rows are not re-sent', async () => {
  for (let i = 0; i < 12; i++) addConfirmed(`r${i}@example.com`);
  nl.updateNewsletterSettings({ batchSize: 5 }, db);
  const c = await approvedCampaign();
  nl.queueCampaign(c.id, { db });
  mails = [];
  await nl.runSendBatch({ db, mail: fakeMail, siteUrl: SITE });
  assert.equal(mails.length, 5);
  // Simulate a crash mid-send: one row stuck in 'sending'.
  const stuck = db.prepare("SELECT id, email FROM newsletter_recipients WHERE status = 'queued' ORDER BY id LIMIT 1").get();
  db.prepare("UPDATE newsletter_recipients SET status = 'sending' WHERE id = ?").run(stuck.id);
  // "Restart": the recovery runs, then the sender carries on from the table.
  assert.equal(nl.recoverInterrupted(db), 1);
  await nl.runSendBatch({ db, mail: fakeMail, siteUrl: SITE });
  await nl.runSendBatch({ db, mail: fakeMail, siteUrl: SITE });
  assert.equal(mails.length, 11);
  assert.ok(!mails.some((m) => m.to === stuck.email), 'the uncertain one is not re-sent automatically');
  const done = nl.getCampaign(c.id, db);
  assert.equal(done.status, 'sent');
  assert.equal(done.counts.sent, 11);
  assert.equal(done.counts.failed, 1);
});

test('failed sends retry, then give up; mail returning false counts as a failure', async () => {
  addConfirmed('x@example.com');
  const c = await approvedCampaign();
  nl.queueCampaign(c.id, { db });
  const bad = async () => false;
  for (let i = 0; i < 3; i++) await nl.runSendBatch({ db, mail: bad, siteUrl: SITE });
  const r = nl.listCampaignRecipients(c.id, db)[0];
  assert.equal(r.status, 'failed');
  assert.equal(r.attempts, 3);
  assert.equal(nl.getCampaign(c.id, db).status, 'sent');
  nl.retryFailed(c.id, db);
  await nl.runSendBatch({ db, mail: fakeMail, siteUrl: SITE });
  assert.equal(nl.listCampaignRecipients(c.id, db)[0].status, 'sent');
});

test('one-click unsubscribe: every email carries it, it stops future and queued sends', async () => {
  addConfirmed('ann@example.com');
  addClient('bob@example.com');
  addConfirmed('cat@example.com');
  nl.updateNewsletterSettings({ batchSize: 1 }, db);
  const c = await approvedCampaign();
  nl.queueCampaign(c.id, { db });
  mails = [];
  await nl.runSendBatch({ db, mail: fakeMail, siteUrl: SITE });
  assert.equal(mails.length, 1);
  const first = mails[0];
  assert.match(first.html, /https:\/\/shop\.test\/newsletter\.html\?unsubscribe=[a-f0-9]{64}/);
  assert.ok(!first.html.includes(nl.UNSUB_PLACEHOLDER));

  // Bob (an account) unsubscribes from a link before his turn in the queue.
  const bobToken = nl.unsubToken('bob@example.com', db);
  const u = await call('POST', '/api/newsletter/unsubscribe', { token: bobToken });
  assert.equal(u.status, 200);
  assert.equal(db.prepare('SELECT newsletter_opt_in FROM clients WHERE email = ?').get('bob@example.com').newsletter_opt_in, 0);
  assert.equal(nl.listSuppressions(db)[0].email, 'bob@example.com');
  for (let i = 0; i < 4; i++) await nl.runSendBatch({ db, mail: fakeMail, siteUrl: SITE });
  assert.deepEqual(mails.map((m) => m.to).sort(), ['ann@example.com', 'cat@example.com']);
  assert.equal(nl.listCampaignRecipients(c.id, db).find((r) => r.email === 'bob@example.com').status, 'skipped');

  // Status + resubscribe via the same token (mailbox proven by the link).
  assert.equal((await call('GET', `/api/newsletter/status?token=${bobToken}`)).body.subscribed, false);
  assert.equal((await call('POST', '/api/newsletter/resubscribe', { token: bobToken })).status, 200);
  assert.equal(nl.isEligible('bob@example.com', db), true);
  assert.equal((await call('POST', '/api/newsletter/unsubscribe', { token: 'a'.repeat(64) })).status, 400);
});

test('suppression list: blocks sends and the signup form; ticking the box again after an unsubscribe re-opts in', async () => {
  addConfirmed('ann@example.com');
  nl.addSuppression({ email: 'ANN@example.com', note: 'asked by phone' }, db);
  assert.equal(nl.isEligible('ann@example.com', db), false);
  mails = [];
  await call('POST', '/api/newsletter/subscribe', { email: 'ann@example.com' });
  await tick();
  assert.equal(mails.length, 0, 'an admin-suppressed address gets no confirmation email');
  assert.throws(() => nl.resubscribeByToken(nl.unsubToken('ann@example.com', db), db), /contact us/);
  nl.removeSuppression('ann@example.com', db);
  assert.equal(nl.isEligible('ann@example.com', db), false, 'removing a suppression does not opt anyone in');

  // An 'unsubscribe' suppression is lifted by a later opt-in on the account.
  addClient('bob@example.com');
  nl.unsubscribeByToken(nl.unsubToken('bob@example.com', db), db, Date.now() - 60_000);
  assert.equal(nl.isEligible('bob@example.com', db), false);
  db.prepare('UPDATE clients SET newsletter_opt_in = 1, newsletter_opted_in_at = ? WHERE email = ?').run(new Date().toISOString(), 'bob@example.com');
  assert.equal(nl.isEligible('bob@example.com', db), true);
});

test('content: escaped, unsafe URLs refused, product cards show the live price', () => {
  const p = product('Wireless Mouse', 10000);
  const blocks = [
    { type: 'heading', text: '<script>alert(1)</script>Deals' },
    { type: 'text', text: 'Line one\nSee https://shop.test/x?a=1&b=2' },
    { type: 'products', ids: [p.id, 'missing-id'] },
    { type: 'button', text: 'Shop now', url: '/shop.html' },
  ];
  const r = nl.renderContent({ mode: 'blocks', blocks }, { siteUrl: SITE, db });
  assert.ok(!r.html.includes('<script>'));
  assert.match(r.html, /&lt;script&gt;/);
  assert.match(r.html, /href="https:\/\/shop\.test\/x\?a=1&amp;b=2"/);
  assert.match(r.html, /https:\/\/shop\.test\/shop\.html/);
  assert.match(r.html, /Wireless Mouse/);
  assert.match(r.html, /product\.html\?p=wireless-mouse/);
  assert.ok(r.html.includes(`R ${(p.priceCents / 100).toFixed(2)}`));
  assert.equal(r.warnings.length, 1, 'missing product reported, not rendered');
  assert.throws(() => nl.renderContent({ mode: 'blocks', blocks: [{ type: 'button', text: 'x', url: 'javascript:alert(1)' }] }, { siteUrl: SITE, db }), /link/);
  assert.throws(() => nl.renderContent({ mode: 'blocks', blocks: [{ type: 'image', url: 'data:image/png;base64,xx' }] }, { siteUrl: SITE, db }), /https/);
  // Live price: a repriced product shows its new price in the next render.
  catalog.saveProduct({ costCents: 20000 }, p.id);
  const again = nl.renderContent({ mode: 'blocks', blocks: [{ type: 'products', ids: [p.id] }] }, { siteUrl: SITE, db });
  const now = catalog.getProduct(p.id, { admin: false });
  assert.notEqual(now.priceCents, p.priceCents);
  assert.ok(again.html.includes(`R ${(now.priceCents / 100).toFixed(2)}`));
});

test('admin routes: overview, preview, subscribers', async () => {
  addConfirmed('ann@example.com');
  addClient('bob@example.com');
  const o = await call('GET', '/api/admin/newsletters/overview');
  assert.equal(o.body.audience.total, 2);
  assert.equal(o.body.usage.cap, 400);
  const pv = await call('POST', '/api/admin/newsletters/preview', { subject: 'S', mode: 'text', bodyText: 'Hello <b>x</b>' });
  assert.equal(pv.status, 200);
  assert.match(pv.body.html, /Hello &lt;b&gt;x&lt;\/b&gt;/);
  const created = await call('POST', '/api/admin/newsletters/campaigns', { subject: 'S', mode: 'text', bodyText: 'Hi' });
  assert.equal(created.status, 201);
  assert.equal((await call('POST', `/api/admin/newsletters/campaigns/${created.body.id}/approve`)).status, 400);
  const s = await call('GET', '/api/admin/newsletters/subscribers');
  assert.equal(s.body.subscribers.length, 1);
  assert.equal(s.body.accounts.length, 1);
  const set = await call('PUT', '/api/admin/newsletters/settings', { dailyCap: 100 });
  assert.equal(set.body.cap, 100);
  assert.equal((await call('PUT', '/api/admin/newsletters/settings', { dailyCap: -1 })).status, 400);
});
