import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import express from 'express';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'procom-ops-test-'));
process.env.DATA_DIR = TMP;
process.env.UPLOADS_DIR = path.join(TMP, 'uploads');
process.env.BACKUPS_DIR = path.join(TMP, 'backups');
process.env.DISABLE_BACKUPS = '1';
delete process.env.BACKUP_RCLONE_REMOTE;
delete process.env.GMAIL_USER;

const { useMemoryDb } = await import('../db.js');
const ops = await import('./ops.js');

let db;
beforeEach(() => {
  db = useMemoryDb();
  delete process.env.BACKUP_RCLONE_REMOTE;
  fs.rmSync(process.env.BACKUPS_DIR, { recursive: true, force: true });
  fs.rmSync(process.env.UPLOADS_DIR, { recursive: true, force: true });
  fs.mkdirSync(process.env.BACKUPS_DIR, { recursive: true });
  fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });
});
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// Fake execFile: records calls; `respond(file, args)` returns { stdout } or throws.
function fakeRunner(respond = () => ({ stdout: '' })) {
  const calls = [];
  const run = async (file, args, opts) => {
    calls.push({ file, args, opts });
    return respond(file, args, opts);
  };
  return { run, calls };
}
const fail = (props) => Object.assign(new Error(props.message || 'Command failed'), props);

// ------------------------------------------------------------------ off-site

test('off-site remote: only "name:path" remotes are accepted, never flags or local paths', () => {
  assert.equal(ops.normaliseRemote(' gdrive:procomsolutions/ '), 'gdrive:procomsolutions');
  assert.equal(ops.normaliseRemote('gdrive:'), 'gdrive:');
  assert.equal(ops.normaliseRemote('gdrive-procom:Backups/Procom Solutions'), 'gdrive-procom:Backups/Procom Solutions');
  assert.equal(ops.normaliseRemote(''), '');
  for (const bad of ['-vv:x', '--config=/etc/x:y', '/opt/procomsolutions/app/data', 'gdrive:../lapanza', 'gdrive:a/../b', 'gdrive:x;rm -rf', 'no-colon']) {
    assert.throws(() => ops.normaliseRemote(bad), /rclone remote/, bad);
  }
  assert.equal(ops.remoteJoin('gdrive:', 'backups'), 'gdrive:backups');
  assert.equal(ops.remoteJoin('gdrive:procomsolutions', 'uploads'), 'gdrive:procomsolutions/uploads');
});

test('off-site remote: stored in the ops table, env BACKUP_RCLONE_REMOTE overrides, blank means off', () => {
  assert.equal(ops.getOffsiteConfig(db).source, 'off');
  ops.setOffsiteRemote('gdrive:procomsolutions', db);
  assert.deepEqual([ops.getOffsiteConfig(db).remote, ops.getOffsiteConfig(db).source], ['gdrive:procomsolutions', 'settings']);
  process.env.BACKUP_RCLONE_REMOTE = 'gdrive-procom:';
  assert.deepEqual([ops.getOffsiteConfig(db).remote, ops.getOffsiteConfig(db).source], ['gdrive-procom:', 'env']);
  process.env.BACKUP_RCLONE_REMOTE = '-bad';
  assert.equal(ops.getOffsiteConfig(db).remote, '');
  assert.match(ops.getOffsiteConfig(db).error, /not a valid remote/);
  delete process.env.BACKUP_RCLONE_REMOTE;
  ops.setOffsiteRemote('', db);
  assert.equal(ops.getOffsiteConfig(db).remote, '');
});

test('sync now: mirrors backups with rclone sync, copies uploads with rclone copy (never sync), records the result', async () => {
  ops.setOffsiteRemote('gdrive:procomsolutions', db);
  const { run, calls } = fakeRunner();
  const res = await ops.syncOffsite({ run, db, requestedBy: 'johan' });
  assert.equal(res.status, 'ok');
  assert.deepEqual(calls.map((c) => [c.file, ...c.args]), [
    ['rclone', 'sync', process.env.BACKUPS_DIR, 'gdrive:procomsolutions/backups'],
    ['rclone', 'copy', process.env.UPLOADS_DIR, 'gdrive:procomsolutions/uploads'],
  ]);
  assert.ok(calls.every((c) => c.opts.timeout > 0), 'every rclone call has a timeout');
  const last = ops.lastOffsiteSync(db);
  assert.equal(last.status, 'ok');
  assert.equal(last.requestedBy, 'johan');
  assert.equal(ops.backupsOverview(db).offsite.lastSync.id, last.id);
});

test('sync now: missing rclone binary is reported plainly; failed uploads copy is "partial", not a failed backup', async () => {
  ops.setOffsiteRemote('gdrive:procomsolutions', db);
  const missing = fakeRunner(() => {
    throw fail({ code: 'ENOENT', message: 'spawn rclone ENOENT' });
  });
  const r1 = await ops.syncOffsite({ run: missing.run, db });
  assert.equal(r1.status, 'failed');
  assert.match(r1.message, /not installed/);
  assert.equal(missing.calls.length, 1, 'uploads skipped when rclone is missing');

  const partial = fakeRunner((_f, args) => {
    if (args[0] === 'copy') throw fail({ code: 1, stderr: 'Failed to copy: googleapi: Error 403: The user has exceeded their Drive storage quota\n"access_token":"ya29.secret"' });
    return { stdout: '' };
  });
  const r2 = await ops.syncOffsite({ run: partial.run, db });
  assert.equal(r2.status, 'partial');
  assert.ok(r2.backupsOk && !r2.uploadsOk);
  assert.match(r2.message, /quota/);
  assert.doesNotMatch(r2.message, /ya29/);
});

test('sync now: refused when off, and only one copy at a time', async () => {
  assert.throws(() => ops.syncOffsite({ run: fakeRunner().run, db }), /off/);
  ops.setOffsiteRemote('gdrive:procomsolutions', db);
  let release;
  const slow = fakeRunner(() => new Promise((r) => (release = () => r({ stdout: '' }))));
  const first = ops.syncOffsite({ run: slow.run, db });
  assert.equal(ops.isSyncing(), true);
  assert.throws(() => ops.syncOffsite({ run: slow.run, db }), (err) => err.status === 409);
  release();
  await new Promise((r) => setImmediate(r));
  release();
  await first;
  assert.equal(ops.isSyncing(), false);
});

test('automatic copy: runs once after each automatic backup, ignores manual ones and brand-new files', async () => {
  ops.setOffsiteRemote('gdrive:procomsolutions', db);
  const dir = process.env.BACKUPS_DIR;
  const old = new Date(Date.now() - 10 * 60_000);
  fs.writeFileSync(path.join(dir, 'procom-2026-09-28-scheduled.db'), 'x');
  fs.utimesSync(path.join(dir, 'procom-2026-09-28-scheduled.db'), old, old);
  const newer = new Date(Date.now() - 5 * 60_000);
  fs.writeFileSync(path.join(dir, 'procom-2026-09-29-manual.db'), 'x');
  fs.utimesSync(path.join(dir, 'procom-2026-09-29-manual.db'), newer, newer);

  const saved = process.env.DISABLE_BACKUPS;
  delete process.env.DISABLE_BACKUPS;
  try {
    const { run, calls } = fakeRunner();
    const r = await ops.autoSyncIfDue({ run, db });
    assert.equal(r.trigger, 'automatic');
    assert.equal(r.backupFile, 'procom-2026-09-28-scheduled.db');
    assert.equal(calls.length, 2);
    assert.equal(await ops.autoSyncIfDue({ run, db }), null, 'same backup is not copied twice');

    fs.writeFileSync(path.join(dir, 'procom-2026-09-29-scheduled.db'), 'x'); // just written
    assert.equal(await ops.autoSyncIfDue({ run, db }), null);
    assert.equal((await ops.autoSyncIfDue({ run, db, now: Date.now() + 120_000 })).backupFile, 'procom-2026-09-29-scheduled.db');
  } finally {
    process.env.DISABLE_BACKUPS = saved;
  }
  assert.equal(await ops.autoSyncIfDue({ run: fakeRunner().run, db, now: Date.now() + 1e9 }), null, 'off while DISABLE_BACKUPS=1');
});

test('test connection: rclone lsd on the remote; a folder not created yet still counts as connected', async () => {
  ops.setOffsiteRemote('gdrive:procomsolutions', db);
  const ok = fakeRunner(() => ({ stdout: '          -1 2026-09-28 10:00:00        -1 backups\n          -1 2026-09-28 10:00:00        -1 uploads\n' }));
  const r1 = await ops.testOffsiteConnection({ run: ok.run, db });
  assert.deepEqual(ok.calls[0].args, ['lsd', 'gdrive:procomsolutions']);
  assert.equal(r1.ok, true);
  assert.match(r1.message, /2 folders/);

  const notYet = fakeRunner(() => {
    throw fail({ code: 3, stderr: 'ERROR : error listing: directory not found' });
  });
  assert.equal((await ops.testOffsiteConnection({ run: notYet.run, db })).ok, true);

  const bad = fakeRunner(() => {
    throw fail({ code: 1, stderr: 'Failed to create file system for "nope:": didn\'t find section in config file' });
  });
  const r3 = await ops.testOffsiteConnection({ run: bad.run, db });
  assert.equal(r3.ok, false);
  assert.match(r3.message, /section in config/);
  assert.equal(ops.backupsOverview(db).offsite.lastTest.ok, false);
});

// ------------------------------------------------------------------ versions

test('version labels: 1.0 first, then 1.01 … 1.99, 2.0', () => {
  assert.equal(ops.nextVersionLabel(null), '1.0');
  assert.equal(ops.nextVersionLabel('1.0'), '1.01');
  assert.equal(ops.nextVersionLabel('1.09'), '1.10');
  assert.equal(ops.nextVersionLabel('1.99'), '2.0');
});

const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const logLine = (sha, subject, body = '') => `${sha}\x1fJohan\x1f2026-09-29T08:00:00+02:00\x1f${subject}\x1f${body}\x1e\n`;

function fakeGit({ head, log = '', headInfo = 'Some change\x1f' }) {
  return fakeRunner((file, args) => {
    assert.equal(file, 'git');
    if (args[0] === 'rev-parse') return { stdout: `${head}\n` };
    if (args[0] === 'log' && args[1] === '-1') return { stdout: headInfo };
    if (args[0] === 'log') return { stdout: log };
    throw new Error(`unexpected git ${args.join(' ')}`);
  });
}

test('version history: recorded at startup only when the commit changed; lists commits since the last one', async () => {
  const g1 = fakeGit({ head: SHA1, log: logLine('c'.repeat(40), 'Phase 2 integration') });
  const r1 = await ops.recordStartupVersion({ run: g1.run, db });
  assert.equal(r1.recorded, true);
  assert.equal(r1.version.label, '1.0');
  assert.equal(r1.version.commitUrl, `https://github.com/jbarkhuizen/procom-solution/commit/${SHA1}`);

  const again = await ops.recordStartupVersion({ run: fakeGit({ head: SHA1 }).run, db });
  assert.equal(again.recorded, false);

  const g2 = fakeGit({
    head: SHA2,
    log: logLine('d'.repeat(40), 'Ops: off-site backups', 'Adds rclone.\n\nCo-Authored-By: Claude <noreply@anthropic.com>') + logLine('e'.repeat(40), 'Fix test'),
    headInfo: 'Merge pull request #33 from jbarkhuizen/ops\x1fPhase 3 ops\n',
  });
  const r2 = await ops.recordStartupVersion({ run: g2.run, db });
  assert.equal(r2.version.label, '1.01');
  assert.equal(r2.version.description, 'Phase 3 ops (#33)');
  const logCall = g2.calls.find((c) => c.args[0] === 'log' && c.args[1] === '--no-merges');
  assert.equal(logCall.args.at(-1), `${SHA1}..${SHA2}`);
  assert.equal(logCall.args[logCall.args.indexOf('-n') + 1], '101', 'capped at 100 (+1 to detect more)');

  const detail = ops.getVersion(r2.version.id, db);
  assert.equal(detail.commits.length, 2);
  assert.equal(detail.commits[0].body, 'Adds rclone.', 'trailers stripped');
  assert.equal(detail.compareUrl, `https://github.com/jbarkhuizen/procom-solution/compare/${SHA1}...${SHA2}`);
  assert.deepEqual(ops.listVersions(db).map((v) => v.label), ['1.01', '1.0']);
});

test('version history: more than the cap is marked truncated; no git means no row and no crash', async () => {
  const many = Array.from({ length: 5 }, (_, i) => logLine(String(i).repeat(40).slice(0, 40).replace(/\d/g, 'f'), `c${i}`)).join('');
  const r = await ops.recordStartupVersion({ run: fakeGit({ head: SHA1, log: many }).run, db, baseline: 3 });
  assert.equal(r.version.commitCount, 3);
  assert.equal(r.version.commitsTruncated, true);

  const noGit = fakeRunner(() => {
    throw fail({ code: 'ENOENT' });
  });
  const r2 = await ops.recordStartupVersion({ run: noGit.run, db: useMemoryDb() });
  assert.equal(r2.recorded, false);
  assert.match(r2.reason, /git unavailable/);
});

// ------------------------------------------------------------------ test runs

test('test cases: every test("…") name in server/**/*.test.js is listed with a suite description', () => {
  assert.deepEqual(ops.parseTestNames(`test('a \\'quoted\\' name', () => {});\n  test("double", async () => {});\n contest('no')\n t.test('nested')`), ["a 'quoted' name", 'double']);
  const { suites, total } = ops.listTestCases();
  const mine = suites.find((s) => s.file === 'server/features/ops.test.js');
  assert.ok(mine, 'finds files in sub-folders');
  assert.ok(mine.description);
  assert.ok(mine.tests.some((t) => t.name.startsWith('test cases: every test')));
  assert.ok(total > 100);
  assert.ok(suites.every((s) => s.description), `missing description: ${suites.filter((s) => !s.description).map((s) => s.file)}`);
});

test('test runs: child gets a temp data dir, backups off and no secrets from .env', () => {
  const env = ops.testRunEnv('/tmp/x', { PATH: '/usr/bin', GMAIL_APP_PASSWORD: 'secret', PAYFAST_PASSPHRASE: 'p', BACKUP_RCLONE_REMOTE: 'gdrive:', DATA_DIR: '/opt/live' });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.DATA_DIR, '/tmp/x');
  assert.equal(env.DB_FILE, path.join('/tmp/x', 'test.db'));
  assert.equal(env.DISABLE_BACKUPS, '1');
  for (const k of ['GMAIL_APP_PASSWORD', 'PAYFAST_PASSPHRASE', 'BACKUP_RCLONE_REMOTE']) assert.equal(env[k], undefined, k);
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = undefined;
  child.killed = null;
  child.kill = (sig) => {
    child.killed = sig;
    setImmediate(() => child.emit('close', null));
  };
  return child;
}

test('test runs: one at a time, counts parsed from node --test output, history kept', async () => {
  let child;
  let spawned;
  const spawnFn = (cmd, args, opts) => {
    spawned = { cmd, args, opts };
    child = fakeChild();
    return child;
  };
  const { run, done } = ops.startTestRun({ requestedBy: 'johan', spawnFn, db });
  assert.equal(run.status, 'running');
  assert.equal(spawned.cmd, process.execPath);
  assert.equal(spawned.args[0], '--test');
  assert.ok(spawned.args.includes('server/features/ops.test.js'));
  assert.equal(spawned.opts.env.DISABLE_BACKUPS, '1');
  assert.notEqual(spawned.opts.env.DATA_DIR, process.env.DATA_DIR, 'fresh temp dir per run');
  assert.throws(() => ops.startTestRun({ spawnFn, db }), (err) => err.status === 409);

  child.stdout.emit('data', '✔ something (1ms)\nℹ tests 3\nℹ suites 0\nℹ pass 2\nℹ fail 1\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n');
  child.emit('close', 1);
  const finished = await done;
  assert.equal(finished.status, 'failed');
  assert.deepEqual([finished.total, finished.passed, finished.failed], [3, 2, 1]);
  assert.match(finished.output, /tests 3/);
  assert.equal(ops.testRunActive(), null);
  assert.equal(ops.listTestRuns(20, db)[0].requestedBy, 'johan');

  const second = ops.startTestRun({ spawnFn, db });
  child.stdout.emit('data', 'ℹ tests 1\nℹ pass 1\nℹ fail 0\n');
  child.emit('close', 0);
  assert.equal((await second.done).status, 'passed');
});

test('test runs: stopped at the time limit; runs cut off by a restart are marked interrupted', async () => {
  const { done } = ops.startTestRun({ spawnFn: () => fakeChild(), db, timeoutMs: 20 });
  const r = await done;
  assert.equal(r.status, 'timed_out');
  assert.match(r.output, /time limit/);

  db.prepare("INSERT INTO test_runs (id, status, started_at) VALUES ('old', 'running', '2026-09-01T00:00:00Z')").run();
  assert.equal(ops.getTestRun('old', db).status, 'interrupted');
  assert.match(ops.getTestRun('old', db).output, /restarted/);
});

// ------------------------------------------------------------------ about + routes

test('about this site: live facts and counts, email shown as yes/no only', () => {
  process.env.GMAIL_USER = 'shop@example.com';
  process.env.GMAIL_APP_PASSWORD = 'super-secret-app-password';
  try {
    const o = ops.siteOverview({ db });
    assert.equal(o.config.emailConfigured, true);
    assert.equal(o.app.nodeVersion, process.version);
    assert.ok(['live', 'sandbox'].includes(o.config.payfastMode));
    assert.ok(o.database.tables.some((t) => t.table === 'products'));
    assert.equal(typeof o.counts.products, 'number');
    assert.ok(o.storage.folders.length === 3);
    assert.match(o.links.status, /docs\/STATUS\.md$/);
    const json = JSON.stringify(o);
    assert.doesNotMatch(json, /super-secret/);
    assert.doesNotMatch(json, /shop@example\.com/);
  } finally {
    delete process.env.GMAIL_USER;
    delete process.env.GMAIL_APP_PASSWORD;
  }
});

test('routes: mounted on the admin router; bad remote rejected; unknown version is 404', async () => {
  const app = express();
  app.use(express.json());
  const admin = express.Router();
  const wrap = (f) => async (req, res) => {
    try {
      const out = await f(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  };
  ops.register({ app, admin, wrap, jobs: false });
  app.use('/api/admin', admin);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/admin`;
  try {
    const bad = await fetch(`${base}/ops/backups/remote`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remote: '--config=/etc/passwd:' }) });
    assert.equal(bad.status, 400);
    const ok = await fetch(`${base}/ops/backups/remote`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remote: 'gdrive:procomsolutions' }) });
    assert.equal((await ok.json()).offsite.remote, 'gdrive:procomsolutions');
    const overview = await (await fetch(`${base}/ops/backups`)).json();
    assert.equal(overview.offsite.backupsTarget, 'gdrive:procomsolutions/backups');
    assert.equal((await fetch(`${base}/ops/versions/nope`)).status, 404);
    const tests = await (await fetch(`${base}/ops/tests`)).json();
    assert.ok(tests.suites.length > 5);
    assert.equal((await fetch(`${base}/ops/overview`)).status, 200);
  } finally {
    server.close();
  }
});
