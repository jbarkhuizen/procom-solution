import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';

process.env.UPLOADS_DIR = path.join(os.tmpdir(), 'procom-test-uploads');
process.env.DISABLE_BACKUPS = '1';
delete process.env.GMAIL_USER;

const { useMemoryDb } = await import('./db.js');
const payfast = await import('./payfast.js');
const mailer = await import('./mailer.js');
const watch = await import('./payment-watch.js');
const { getSettings, updateSettings } = await import('./settings.js');

let db;
beforeEach(() => {
  db = useMemoryDb();
});
afterEach(() => mailer.useTransport(null));

const fields = { m_payment_id: 'o1', amount_gross: '100.00', payment_status: 'COMPLETE', pf_payment_id: '555' };
const signed = (extra = {}) => {
  const f = { ...fields, ...extra };
  return { ...f, signature: payfast.buildSignature(Object.entries(f), '', { skipEmpty: false }) };
};
const verify = (body, post, cents = 10000) => payfast.verifyItn('raw', body, cents, '1.2.3.4', { post });

test('Payfast notice: only "could not ask Payfast" is retried; a real refusal is not', async () => {
  const ok = await verify(signed(), async () => 'VALID');
  assert.deepEqual([ok.valid, ok.transient], [true, false]);
  const refused = await verify(signed(), async () => 'INVALID');
  assert.deepEqual([refused.valid, refused.transient], [false, false], 'Payfast said INVALID: answer 200, never retry');
  const down = await verify(signed(), async () => { throw new Error('timeout'); });
  assert.deepEqual([down.valid, down.transient], [false, true], 'Payfast unreachable: answer 503 so Payfast sends it again');
  const odd = await verify(signed(), async () => '');
  assert.equal(odd.transient, true, 'an empty answer is also treated as "try again"');
  const badAmount = await verify(signed(), async () => { throw new Error('x'); }, 99999);
  assert.deepEqual([badAmount.valid, badAmount.transient], [false, false], 'a wrong amount is never retried');
  const badSig = await verify({ ...signed(), signature: 'nope' }, async () => { throw new Error('x'); });
  assert.deepEqual([badSig.valid, badSig.transient], [false, false], 'a forged notice is never retried');
});

const failingTransport = () => ({ sendMail: async () => { throw new Error('gmail down'); } });
const okTransport = (sent) => ({ sendMail: async (m) => { sent.push(m); return {}; } });
const mail = { to: 'owner@example.com', subject: 'New order PC1', html: '<p>x</p>', replyTo: 'cust@example.com' };

test('important mail that fails is queued and retried, then delivered', async () => {
  const realErr = console.error;
  console.error = () => {};
  mailer.useTransport(failingTransport());
  assert.equal(await mailer.sendMailReliable(mail, { kind: 'owner-new-order', ref: 'PC1' }), false);
  console.error = realErr;
  assert.deepEqual(mailer.mailOutboxStats(db), { waiting: 1, failed: 0 });

  // not due yet
  assert.deepEqual(await mailer.processMailOutbox({ db, now: Date.now() }), { sent: 0, failed: 0, retried: 0 });
  // due, Gmail still down: stays queued with a longer pause
  console.error = () => {};
  const later = Date.now() + 6 * 60_000;
  assert.deepEqual(await mailer.processMailOutbox({ db, now: later }), { sent: 0, failed: 0, retried: 1 });
  console.error = realErr;
  const row = db.prepare('SELECT attempts, next_try_at FROM mail_outbox').get();
  assert.equal(row.attempts, 2);
  assert.ok(Date.parse(row.next_try_at) >= later + 9 * 60_000, 'second wait is about 10 minutes');
  // Gmail back: delivered with the original details
  const sent = [];
  mailer.useTransport(okTransport(sent));
  assert.deepEqual(await mailer.processMailOutbox({ db, now: later + 3600_000 }), { sent: 1, failed: 0, retried: 0 });
  assert.deepEqual([sent[0].to, sent[0].subject, sent[0].replyTo], ['owner@example.com', 'New order PC1', 'cust@example.com']);
  assert.deepEqual(mailer.mailOutboxStats(db), { waiting: 0, failed: 0 });
});

test('mail that keeps failing is marked failed after 12 tries and shows in the stats; a working send is not queued', async () => {
  const realErr = console.error;
  console.error = () => {};
  mailer.useTransport(failingTransport());
  await mailer.sendMailReliable(mail, { kind: 'owner-new-order' });
  let now = Date.now();
  let last;
  for (let i = 0; i < 14; i++) {
    now += 7 * 3600_000;
    last = await mailer.processMailOutbox({ db, now });
    if (last.failed) break;
  }
  console.error = realErr;
  assert.equal(last.failed, 1);
  assert.deepEqual(mailer.mailOutboxStats(db), { waiting: 0, failed: 1 });
  const sent = [];
  mailer.useTransport(okTransport(sent));
  assert.equal(await mailer.sendMailReliable(mail), true);
  assert.equal(sent.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM mail_outbox').get().n, 1, 'the good send was not queued');
});

test('owner alerts go to the owner address, and nowhere when none is set', async () => {
  const sent = [];
  mailer.useTransport(okTransport(sent));
  updateSettings({ ownerNotifyEmail: 'owner@example.com' }, db);
  assert.equal(await mailer.sendOwnerAlert('Check Payfast', 'Order PC9 is not confirmed'), true);
  assert.deepEqual([sent[0].to, sent[0].subject], ['owner@example.com', 'Procom Solutions: Check Payfast']);
  assert.match(sent[0].html, /Order PC9 is not confirmed/);
  updateSettings({ ownerNotifyEmail: '' }, db);
  assert.equal(getSettings(db).ownerNotifyEmail, '');
  assert.equal(await mailer.sendOwnerAlert('x', 'y'), false);
});

const order = (id, over = {}) =>
  db.prepare("INSERT INTO orders (id, order_number, status, payment_status, payment_method, first_name, last_name, email, phone, subtotal_cents, total_cents, created_at, updated_at) VALUES (?, ?, ?, ?, 'payfast_card', 'Ann', 'Lee', 'ann@example.com', '1', 1000, 1000, 'x', 'x')")
    .run(id, `PC${id}`, over.status || 'pending_payment', over.payment || 'pending');

test('a customer back from Payfast whose payment never confirms is flagged once, after 15 minutes', async () => {
  order('a');
  order('b'); // customer never came back: an abandoned checkout, no alert
  order('c', { status: 'paid', payment: 'paid' });
  const t0 = Date.parse('2026-10-09T10:00:00Z');
  watch.markReturnSeen('a', db, t0);
  watch.markReturnSeen('c', db, t0); // already paid: ignored
  assert.equal(db.prepare('SELECT payment_return_seen_at FROM orders WHERE id = ?').get('c').payment_return_seen_at, null);

  assert.equal(watch.paymentsToCheck(db, t0 + 10 * 60_000).count, 0, 'still inside the 15 minutes');
  const alerts = [];
  const alert = async (subject, text) => alerts.push([subject, text]);
  assert.deepEqual(await watch.checkUnconfirmedPayments({ db, now: t0 + 10 * 60_000, alert }), []);

  assert.deepEqual(watch.paymentsToCheck(db, t0 + 20 * 60_000).items.map((o) => o.orderNumber), ['PCa']);
  assert.deepEqual(await watch.checkUnconfirmedPayments({ db, now: t0 + 20 * 60_000, alert }), ['PCa']);
  assert.match(alerts[0][0], /PCa/);
  assert.match(alerts[0][1], /Ann Lee/);
  assert.deepEqual(await watch.checkUnconfirmedPayments({ db, now: t0 + 40 * 60_000, alert }), [], 'one alert per order');
  assert.ok(db.prepare("SELECT 1 FROM order_events WHERE order_id = 'a' AND message LIKE '%not confirmed%'").get());
  // it stays on the dashboard until paid
  assert.equal(watch.paymentsToCheck(db, t0 + 40 * 60_000).count, 1);
  db.prepare("UPDATE orders SET payment_status = 'paid', status = 'paid' WHERE id = 'a'").run();
  assert.equal(watch.paymentsToCheck(db, t0 + 40 * 60_000).count, 0);
});
