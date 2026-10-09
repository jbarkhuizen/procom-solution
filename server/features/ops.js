// Ops (Phase 3): off-site copy of the backups, version history, test runs from
// the admin, and "About this site". Ported from Lapanza3d (server/backups.js
// syncOffsite, version-history.js, test-runs.js, site-overview.js) and adapted.
//
// Safety notes (read before changing):
// - Every external program is started with execFile/spawn and ARRAY arguments,
//   never a shell string. The rclone remote is validated (must look like
//   "name:path", may not start with "-") so it can never be read as a flag.
// - Off-site: the backups folder is mirrored with `rclone sync` (so the remote
//   follows local pruning) into <remote>/backups; uploads are only ever
//   `rclone copy`-ed (add/update, never delete) into <remote>/uploads, so an
//   accidental local deletion can't wipe the off-site photos too.
// - Test runs spawn `node --test` with a minimal environment: no secrets from
//   .env, DATA_DIR/UPLOADS_DIR/BACKUPS_DIR/DB_FILE in a fresh temp folder and
//   DISABLE_BACKUPS=1, so a test can never touch live data or send mail.
//   One run at a time, killed after a timeout.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { execFile as runFile, spawn } from 'child_process';
import { getDb } from '../db.js';
import { backupsDir, dataDir, uploadsDir } from '../paths.js';
import { listBackups } from '../backups.js';
import { payfastMode } from '../payfast.js';
import { listApiRuns, apiRunSummary, backfillApiRunLog } from '../api-run-log.js';
import { nextRunAt, syncHours } from '../esquire.js';
import { smdStatus } from '../smd-api.js';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const defaultRun = promisify(runFile); // (file, args, opts) -> { stdout, stderr }
export const GITHUB_REPO = 'https://github.com/jbarkhuizen/procom-solution';
const KEEP_BACKUPS = 30; // matches server/backups.js

const nowIso = () => new Date().toISOString();
const httpError = (message, status = 400) => Object.assign(new Error(message), { status });

// ------------------------------------------------------------------ settings

function getSetting(key, db = getDb()) {
  return db.prepare('SELECT value FROM ops_settings WHERE key = ?').get(key)?.value ?? '';
}
function setSetting(key, value, db = getDb()) {
  db.prepare(
    `INSERT INTO ops_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, String(value ?? ''), nowIso());
}

// ------------------------------------------------------------------ off-site copy

// "gdrive,root_folder_id=ID:", "gdrive-procom:", "gdrive-procom:Backups/Procom".
// A name, a colon, then an optional path. No leading "-" (would be a flag),
// no ".." segments, no local paths (those have no "name:" prefix).
// Also rclone's connection-string form "gdrive,root_folder_id=<Drive folder id>:"
// -- the same Google login, but rooted in a folder of our own.
const REMOTE_RE = /^([A-Za-z0-9_][A-Za-z0-9_.-]{0,63})(,root_folder_id=[A-Za-z0-9_-]{10,100})?:[A-Za-z0-9_.\-/ ]{0,200}$/;

// On this VPS Lapanza3d runs `rclone sync <its backups> gdrive:` nightly, which
// deletes everything else under the "gdrive" remote's root folder -- so anything
// Procom put anywhere under plain "gdrive:" would be wiped every night.
export const SHARED_REMOTE = 'gdrive';

// A pasted Drive folder link (https://drive.google.com/drive/folders/<id>, also
// the /u/0/ and ?usp=sharing forms) means "the shared Google login, rooted in
// that folder".
const DRIVE_URL_RE = /^https?:\/\/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]{10,100})\/?(?:[?#].*)?$/i;

export function normaliseRemote(value) {
  let v = String(value ?? '').trim();
  if (!v) return '';
  const url = DRIVE_URL_RE.exec(v);
  if (url) return `${SHARED_REMOTE},root_folder_id=${url[1]}:`;
  if (/^(https?|ftp|file)[,:]/i.test(v)) {
    throw httpError('That is a web address, not an rclone remote. Paste the Google Drive folder link (https://drive.google.com/drive/folders/...) or enter gdrive,root_folder_id=<folder id>:');
  }
  const m = REMOTE_RE.exec(v);
  if (!m || v.split(/[:/]/).some((seg) => seg === '..')) {
    throw httpError('Enter an rclone remote such as gdrive,root_folder_id=<folder id>: (remote name, optional folder id, a colon, then an optional folder).');
  }
  if (m[1] === SHARED_REMOTE && !m[2]) {
    throw httpError('Plain "gdrive:" is Lapanza3d\'s backup folder — its nightly sync deletes anything else in it. Create a separate folder in Google Drive and enter gdrive,root_folder_id=<that folder\'s id>: (the id is the last part of the folder\'s web address).');
  }
  if (!v.endsWith(':')) v = v.replace(/\/+$/, '');
  return v;
}

export function remoteJoin(remote, sub) {
  return remote.endsWith(':') || remote.endsWith('/') ? `${remote}${sub}` : `${remote}/${sub}`;
}

// The env var wins over the admin setting (lets the server owner pin it).
export function getOffsiteConfig(db = getDb()) {
  const env = String(process.env.BACKUP_RCLONE_REMOTE ?? '').trim();
  const stored = getSetting('offsite_remote', db);
  if (env) {
    try {
      return { remote: normaliseRemote(env), source: 'env', stored, error: '' };
    } catch (err) {
      return { remote: '', source: 'env', stored, error: `BACKUP_RCLONE_REMOTE is not a valid remote: ${err.message}` };
    }
  }
  if (!stored) return { remote: '', source: 'off', stored, error: '' };
  // Re-check what was saved earlier (e.g. a Drive link saved before links were converted).
  try {
    return { remote: normaliseRemote(stored), source: 'settings', stored, error: '' };
  } catch (err) {
    return { remote: '', source: 'settings', stored, error: `The saved remote is not valid: ${err.message}` };
  }
}

export function setOffsiteRemote(value, db = getDb()) {
  const remote = normaliseRemote(value);
  setSetting('offsite_remote', remote, db);
  return getOffsiteConfig(db);
}

// Never show token-looking text from rclone's error output.
function redact(text) {
  return String(text || '')
    .replace(/"(access_token|refresh_token|client_secret|token)"\s*:\s*"[^"]*"/gi, '"$1":"***"')
    .replace(/\b(ya29\.[\w-]+|1\/\/[\w-]{20,})/g, '***');
}

export function describeRunError(err, what = 'rclone') {
  if (err?.code === 'ENOENT') return `${what} is not installed on this server (see deploy/DEPLOY.md, "Off-site backups").`;
  if (err?.killed || err?.signal === 'SIGTERM') return `${what} took too long and was stopped.`;
  const lines = redact(err?.stderr || err?.message || 'failed')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const useful = lines.filter((l) => /error|fail|denied|not found|quota|couldn't|didn't/i.test(l));
  return (useful.at(-1) || lines.at(-1) || 'failed').slice(0, 400);
}

let syncInFlight = null;
export const isSyncing = () => Boolean(syncInFlight);

function syncRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    trigger: row.trigger,
    remote: row.remote,
    status: row.status,
    backupsOk: Boolean(row.backups_ok),
    uploadsOk: Boolean(row.uploads_ok),
    message: row.message,
    backupFile: row.backup_file,
    requestedBy: row.requested_by,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
  };
}

export function lastOffsiteSync(db = getDb()) {
  return syncRow(db.prepare("SELECT * FROM ops_offsite_syncs WHERE status != 'running' ORDER BY id DESC LIMIT 1").get());
}

export function recentOffsiteSyncs(limit = 10, db = getDb()) {
  return db.prepare('SELECT * FROM ops_offsite_syncs ORDER BY id DESC LIMIT ?').all(limit).map(syncRow);
}

// Mirrors data/backups -> <remote>/backups (sync) and copies data/uploads ->
// <remote>/uploads (copy). Resolves with the finished sync record; failures are
// recorded, not thrown (except "off" / "already running").
export function syncOffsite({ trigger = 'manual', requestedBy = '', backupFile = '', run = defaultRun, db = getDb(), backups = backupsDir(), uploads = uploadsDir() } = {}) {
  if (syncInFlight) throw httpError('An off-site copy is already running — wait for it to finish.', 409);
  const { remote, error } = getOffsiteConfig(db);
  if (!remote) throw httpError(error || 'Off-site copy is off. Enter the Google Drive remote (e.g. gdrive,root_folder_id=FOLDER_ID:) and save first.');

  const started = Date.now();
  const id = db
    .prepare('INSERT INTO ops_offsite_syncs (trigger, remote, status, backup_file, requested_by, started_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(trigger, remote, 'running', backupFile, requestedBy, nowIso()).lastInsertRowid;

  const work = (async () => {
    const messages = [];
    let backupsOk = false;
    let uploadsOk = false;
    let missingBinary = false;
    try {
      fs.mkdirSync(backups, { recursive: true });
      await run('rclone', ['sync', backups, remoteJoin(remote, 'backups')], { timeout: 30 * 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
      backupsOk = true;
    } catch (err) {
      missingBinary = err?.code === 'ENOENT';
      messages.push(`Backups: ${describeRunError(err)}`);
    }
    if (missingBinary) {
      messages.push('Uploads: skipped.');
    } else if (!fs.existsSync(uploads)) {
      uploadsOk = true;
      messages.push('No uploads folder yet, so no photos to copy.');
    } else {
      try {
        await run('rclone', ['copy', uploads, remoteJoin(remote, 'uploads')], { timeout: 2 * 60 * 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
        uploadsOk = true;
      } catch (err) {
        messages.push(`Uploads: ${describeRunError(err)}`);
      }
    }
    const status = backupsOk && uploadsOk ? 'ok' : backupsOk ? 'partial' : 'failed';
    if (status === 'ok') messages.unshift(fs.existsSync(uploads) ? 'Backups mirrored and photos copied.' : 'Backups mirrored.');
    db.prepare('UPDATE ops_offsite_syncs SET status = ?, backups_ok = ?, uploads_ok = ?, message = ?, finished_at = ?, duration_ms = ? WHERE id = ?').run(
      status,
      backupsOk ? 1 : 0,
      uploadsOk ? 1 : 0,
      messages.join(' ').slice(0, 1000),
      nowIso(),
      Date.now() - started,
      id,
    );
    if (status !== 'ok') console.error(`Off-site backup copy ${status}: ${messages.join(' ')}`);
    return syncRow(db.prepare('SELECT * FROM ops_offsite_syncs WHERE id = ?').get(id));
  })().finally(() => {
    syncInFlight = null;
  });
  syncInFlight = work;
  return work;
}

// Called on a timer: after each AUTOMATIC backup (server/backups.js names them
// "-startup.db" / "-scheduled.db") run one off-site copy. One attempt per
// backup file, so a broken remote doesn't retry every few minutes.
export async function autoSyncIfDue({ run = defaultRun, db = getDb(), now = Date.now() } = {}) {
  if (process.env.DISABLE_BACKUPS === '1' || syncInFlight) return null;
  if (!getOffsiteConfig(db).remote) return null;
  const latest = listBackups().find((b) => /-(startup|scheduled)\.db$/.test(b.file));
  if (!latest || now - Date.parse(latest.createdAt) < 60_000) return null; // may still be being written
  const last = db.prepare("SELECT backup_file FROM ops_offsite_syncs WHERE trigger = 'automatic' ORDER BY id DESC LIMIT 1").get();
  if (last?.backup_file === latest.file) return null;
  return syncOffsite({ trigger: 'automatic', backupFile: latest.file, run, db });
}

export async function testOffsiteConnection({ run = defaultRun, db = getDb() } = {}) {
  const { remote, error } = getOffsiteConfig(db);
  if (!remote) throw httpError(error || 'Off-site copy is off. Enter the Google Drive remote first.');
  let result;
  try {
    const { stdout } = await run('rclone', ['lsd', remote], { timeout: 45_000, maxBuffer: 1024 * 1024, windowsHide: true });
    const folders = String(stdout || '').split('\n').filter((l) => l.trim()).length;
    result = { ok: true, message: `Connected to ${remote} — ${folders} folder${folders === 1 ? '' : 's'} inside.` };
  } catch (err) {
    if (/directory not found/i.test(String(err?.stderr || ''))) {
      result = { ok: true, message: `Connected. ${remote} doesn't exist yet — the first sync creates it.` };
    } else {
      result = { ok: false, message: describeRunError(err) };
    }
  }
  result = { ...result, remote, at: nowIso() };
  setSetting('offsite_last_test', JSON.stringify(result), db);
  return result;
}

function lastConnectionTest(db = getDb()) {
  try {
    return JSON.parse(getSetting('offsite_last_test', db) || 'null');
  } catch {
    return null;
  }
}

export function backupsOverview(db = getDb()) {
  const backups = listBackups();
  const cfg = getOffsiteConfig(db);
  return {
    backups,
    keep: KEEP_BACKUPS,
    totalBytes: backups.reduce((s, b) => s + (b.size || 0), 0),
    automaticDisabled: process.env.DISABLE_BACKUPS === '1',
    offsite: {
      remote: cfg.remote,
      source: cfg.source,
      stored: cfg.stored,
      error: cfg.error,
      backupsTarget: cfg.remote ? remoteJoin(cfg.remote, 'backups') : '',
      uploadsTarget: cfg.remote ? remoteJoin(cfg.remote, 'uploads') : '',
      syncing: isSyncing(),
      lastSync: lastOffsiteSync(db),
      lastTest: lastConnectionTest(db),
      recent: recentOffsiteSyncs(10, db),
    },
  };
}

// ------------------------------------------------------------------ version history

// 1.0 is the first recorded production version; then 1.01 ... 1.99, 2.0, 2.01 ...
// (Lapanza3d's scheme, continued from 1.0 instead of 0.01).
export function nextVersionLabel(last) {
  const m = last ? /^(\d+)\.(\d{1,2})$/.exec(last) : null;
  if (!m) return '1.0';
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (minor >= 99) return `${major + 1}.0`;
  return `${major}.${String(minor + 1).padStart(2, '0')}`;
}

const SHA_RE = /^[0-9a-f]{40}$/;
const LOG_FORMAT = '--format=%H%x1f%an%x1f%aI%x1f%s%x1f%b%x1e';
const TRAILER_RE = /^(co-authored-by|claude-session|signed-off-by|generated with)\b.*$/gim;

export function parseGitLog(stdout) {
  return String(stdout || '')
    .split('\x1e')
    .map((chunk) => chunk.replace(/^\s+/, ''))
    .filter(Boolean)
    .map((chunk) => {
      const [sha, author, date, subject, body = ''] = chunk.split('\x1f');
      return {
        sha: String(sha || '').trim(),
        author: String(author || '').trim(),
        date: String(date || '').trim(),
        subject: String(subject || '').trim(),
        body: body.replace(TRAILER_RE, '').replace(/🤖.*$/gm, '').replace(/https:\/\/claude\.ai\/code\/\S+/g, '').trim().slice(0, 2000),
      };
    })
    .filter((c) => SHA_RE.test(c.sha));
}

// "Merge pull request #32 from x/y" + body "Phase 2 integration" -> "Phase 2 integration (#32)".
export function describeHead(subject, body) {
  const m = /^Merge pull request #(\d+)/.exec(subject || '');
  const firstLine = String(body || '').split('\n').map((l) => l.trim()).find(Boolean);
  if (m && firstLine) return `${firstLine} (#${m[1]})`;
  return subject || '';
}

let currentSha = '';
export const currentCommit = () => currentSha;

function versionRow(row, withCommits = false) {
  if (!row) return null;
  const commits = JSON.parse(row.commits_json || '[]');
  return {
    id: row.id,
    versionNumber: row.version_number,
    label: row.version_label,
    commitSha: row.commit_sha,
    previousSha: row.previous_sha,
    description: row.description,
    commitCount: commits.length,
    commitsTruncated: Boolean(row.commits_truncated),
    nodeVersion: row.node_version,
    recordedAt: row.recorded_at,
    commitUrl: `${GITHUB_REPO}/commit/${row.commit_sha}`,
    compareUrl: row.previous_sha ? `${GITHUB_REPO}/compare/${row.previous_sha}...${row.commit_sha}` : '',
    ...(withCommits ? { commits: commits.map((c) => ({ ...c, url: `${GITHUB_REPO}/commit/${c.sha}` })) } : { subjects: commits.slice(0, 5).map((c) => c.subject) }),
  };
}

export function listVersions(db = getDb()) {
  return db.prepare('SELECT * FROM version_history ORDER BY version_number DESC').all().map((r) => versionRow(r));
}

export function getVersion(id, db = getDb()) {
  return versionRow(db.prepare('SELECT * FROM version_history WHERE id = ?').get(id), true);
}

// Called once at server start. Records a version when HEAD differs from the
// last recorded commit. Never throws (a missing git just means no row).
export async function recordStartupVersion({ run = defaultRun, db = getDb(), root = APP_ROOT, limit = 100, baseline = 30 } = {}) {
  const git = (args) => run('git', args, { cwd: root, timeout: 20_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  let sha;
  try {
    sha = String((await git(['rev-parse', 'HEAD'])).stdout || '').trim();
  } catch (err) {
    return { recorded: false, reason: `git unavailable: ${describeRunError(err, 'git')}` };
  }
  if (!SHA_RE.test(sha)) return { recorded: false, reason: 'no commit' };
  currentSha = sha;
  const last = db.prepare('SELECT * FROM version_history ORDER BY version_number DESC LIMIT 1').get();
  if (last?.commit_sha === sha) return { recorded: false, reason: 'unchanged', version: versionRow(last) };

  const prev = last && SHA_RE.test(last.commit_sha) ? last.commit_sha : '';
  const cap = prev ? limit : baseline;
  let out = '';
  try {
    out = (await git(['log', '--no-merges', LOG_FORMAT, '-n', String(cap + 1), ...(prev ? [`${prev}..${sha}`] : [sha])])).stdout;
  } catch {
    // Previous commit unknown here (history rewritten / shallow clone): list recent ones.
    out = await git(['log', '--no-merges', LOG_FORMAT, '-n', String(cap + 1), sha]).then((r) => r.stdout).catch(() => '');
  }
  let commits = parseGitLog(out);
  const truncated = commits.length > cap;
  commits = commits.slice(0, cap);

  let description = '';
  try {
    const head = String((await git(['log', '-1', '--format=%s%x1f%b', sha])).stdout || '');
    const [subject, body] = head.split('\x1f');
    description = describeHead(subject.trim(), body);
  } catch {
    /* fall back below */
  }
  if (!description) description = commits[0]?.subject || sha.slice(0, 7);

  const version = db.transaction(() => {
    const latest = db.prepare('SELECT * FROM version_history ORDER BY version_number DESC LIMIT 1').get();
    if (latest?.commit_sha === sha) return null; // recorded meanwhile
    const row = {
      id: randomUUID(),
      version_number: (latest?.version_number || 0) + 1,
      version_label: nextVersionLabel(latest?.version_label),
      commit_sha: sha,
      previous_sha: prev,
      description: description.slice(0, 300),
      commits_json: JSON.stringify(commits),
      commits_truncated: truncated ? 1 : 0,
      node_version: process.version,
      recorded_at: nowIso(),
    };
    db.prepare(
      `INSERT INTO version_history (id, version_number, version_label, commit_sha, previous_sha, description, commits_json, commits_truncated, node_version, recorded_at)
       VALUES (@id, @version_number, @version_label, @commit_sha, @previous_sha, @description, @commits_json, @commits_truncated, @node_version, @recorded_at)`,
    ).run(row);
    return row;
  })();
  if (!version) return { recorded: false, reason: 'unchanged' };
  console.log(`Recorded version V${version.version_label} (${sha.slice(0, 7)}): ${version.description}`);
  return { recorded: true, version: versionRow(version) };
}

// ------------------------------------------------------------------ test runs

// Plain-language summary per suite (the individual test names are shown too).
const SUITE_DESCRIPTIONS = {
  'server/server.test.js': 'Core shop rules: pricing and markup, rounding, orders re-priced on the server, stock, shipping options, delivery per supplier, Payfast signatures, admin logins.',
  'server/feed.test.js': 'Warehouse price lists: reading Excel/CSV/PDF files, matching columns, importing, cost updates and out-of-stock handling.',
  'server/esquire.test.js': 'Esquire API sync: VAT stripped, stock out/back in, glitch guard, schedule, category rules.',
  'server/catalog-search.test.js': 'Shop search: model numbers match however they are typed (K1-C, K1 C, K1C).',
  'server/supplier-digest.test.js': 'Supplier update emails: after every update, once a day at 19:00 (one combined email) or off.',
  'server/sync-report.test.js': 'Supplier sync report: products that went on special or changed price, and the Word overview attached to the report email.',
  'server/supplier-extras.test.js': 'Supplier details: encrypted portal password, own-courier delivery, courier insurance line (Esquire TVs).',
  'server/smd-api.test.js': 'SMD live API: headers and paging, check mode, costs and specials, stock, descriptions, new SKUs, photos, schedule.',
  'server/smd-autolist.test.js': 'SMD auto-list: which store category each SMD row goes into, skipped rows, heavy items marked "delivery quoted".',
  'server/features/accounts.test.js': 'Customer accounts: register, email verification, login, password reset, saved details, linking orders.',
  'server/features/analytics-sources.test.js': 'Analytics sources: channels (Google, Facebook, newsletter...), campaign tags, referring pages, visitor places from MaxMind (IP never stored), channel on orders.',
  'server/features/analytics.test.js': 'Own visitor statistics: what is stored (no IPs), bots and Do Not Track ignored, funnel and totals.',
  'server/features/finance.test.js': 'Dashboard and Financial overview: income, cost of goods, delivery, Payfast fees and expenses per month.',
  'server/features/invoices.test.js': 'Invoices: gap-free numbering when payment is confirmed, printable invoice, invoice history.',
  'server/features/marketing.test.js': 'Marketing: potential-market leads, adverts, calendar and platform rules (incl. copying from Lapanza3d).',
  'server/features/governance.test.js': 'Governance: audit log of admin changes (with secrets redacted), todo/backlog, and its one-time seed.',
  'server/features/newsletters.test.js': 'Newsletters: opt-in only, double opt-in, unsubscribe, daily sending limit.',
  'server/features/phase1.test.js': 'Accounts, invoices, promos and specials working together in one order.',
  'server/features/promos.test.js': 'Promo codes: validity, usage limits, discount never takes a sale below cost incl VAT.',
  'server/features/pricedrops.test.js': 'Price drops page: which supplier-sync drops qualify (5% and R10), 7-day window, off the page the moment the price is back up, sold-out items greyed, hide/pin, admin figures.',
  'server/features/specials.test.js': 'Specials: sale prices, dates, never below cost incl VAT, struck-through normal price.',
  'server/api-run-log.test.js': 'API run log (Admin -> System): every Esquire / SMD run is logged with its status and a one-line overview; filters, summary and seeding from the report history.',
  'server/payment-safety.test.js': 'Payment safety: Payfast notices retried only when Payfast could not be asked, important emails queued and retried, customers back from Payfast with an unconfirmed payment flagged once.',
  'server/features/ops.test.js': 'Ops: off-site backup copy, version history, test runs and About this site (with rclone/git faked).',
};

export function listTestFiles(root = APP_ROOT) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.test.js')) out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  const serverDir = path.join(root, 'server');
  if (fs.existsSync(serverDir)) walk(serverDir);
  return out.sort();
}

export function parseTestNames(source) {
  const names = [];
  // Top-level test('…') calls only (line start), so strings in test code don't count.
  const re = /^[ \t]*test\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/gm;
  for (const m of String(source).matchAll(re)) names.push(m[2].replace(/\\(['"`\\])/g, '$1'));
  return names;
}

export function listTestCases(root = APP_ROOT) {
  const suites = listTestFiles(root).map((file) => ({
    file,
    description: SUITE_DESCRIPTIONS[file] || '',
    tests: parseTestNames(fs.readFileSync(path.join(root, file), 'utf8')).map((name) => ({ name })),
  }));
  return { suites, total: suites.reduce((s, x) => s + x.tests.length, 0) };
}

// Only harmless variables reach the child: nothing from .env (mail, Payfast,
// rclone), plus a throw-away data folder and backups switched off.
const ENV_ALLOW = ['PATH', 'Path', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'];
export function testRunEnv(tmpDir, base = process.env) {
  const env = {};
  for (const k of ENV_ALLOW) if (base[k] != null) env[k] = base[k];
  return {
    ...env,
    TMPDIR: tmpDir,
    TEMP: tmpDir,
    TMP: tmpDir,
    DATA_DIR: tmpDir,
    UPLOADS_DIR: path.join(tmpDir, 'uploads'),
    BACKUPS_DIR: path.join(tmpDir, 'backups'),
    DB_FILE: path.join(tmpDir, 'test.db'),
    DISABLE_BACKUPS: '1',
    NODE_ENV: 'test',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
  };
}

export function parseTestSummary(output) {
  const count = (name) => {
    const all = [...String(output).matchAll(new RegExp(`^[ℹ#]\\s*${name} (\\d+)\\s*$`, 'gm'))];
    return all.length ? Number(all.at(-1)[1]) : 0;
  };
  return { total: count('tests'), passed: count('pass'), failed: count('fail') + count('cancelled'), skipped: count('skipped') + count('todo') };
}

const OUTPUT_KEEP = 30_000;
let activeRunId = null;
export const testRunActive = () => activeRunId;

export function recoverInterruptedRuns(db = getDb()) {
  db.prepare(
    `UPDATE test_runs SET status = 'interrupted', completed_at = ?,
       output = CASE WHEN output = '' THEN 'Interrupted: the server restarted while this run was going.'
                ELSE output || char(10) || char(10) || 'Interrupted: the server restarted while this run was going.' END
     WHERE status = 'running' AND id != ?`,
  ).run(nowIso(), activeRunId || '');
}

function runRow(row, withOutput = false) {
  if (!row) return null;
  const { output, ...rest } = row;
  return {
    id: rest.id,
    status: rest.status,
    requestedBy: rest.requested_by,
    startedAt: rest.started_at,
    completedAt: rest.completed_at,
    durationMs: rest.duration_ms,
    total: rest.total_count,
    passed: rest.passed_count,
    failed: rest.failed_count,
    skipped: rest.skipped_count,
    ...(withOutput ? { output } : {}),
  };
}

export function listTestRuns(limit = 20, db = getDb()) {
  recoverInterruptedRuns(db);
  return db.prepare('SELECT * FROM test_runs ORDER BY started_at DESC LIMIT ?').all(limit).map((r) => runRow(r));
}

export function getTestRun(id, db = getDb()) {
  recoverInterruptedRuns(db);
  return runRow(db.prepare('SELECT * FROM test_runs WHERE id = ?').get(id), true);
}

// Starts `node --test` for every server test file. Returns { run, done }:
// `run` is the row as started, `done` resolves with the finished row.
export function startTestRun({ requestedBy = '', root = APP_ROOT, spawnFn = spawn, timeoutMs = 10 * 60_000, db = getDb() } = {}) {
  recoverInterruptedRuns(db);
  if (activeRunId) throw httpError('A test run is already in progress.', 409);
  const files = listTestFiles(root);
  if (!files.length) throw httpError('No test files found.');

  const id = randomUUID();
  activeRunId = id;
  const started = Date.now();
  db.prepare("INSERT INTO test_runs (id, status, requested_by, started_at) VALUES (?, 'running', ?, ?)").run(id, requestedBy, nowIso());

  let tmp = '';
  const done = new Promise((resolve) => {
    let output = '';
    let finished = false;
    let timedOut = false;
    let timer = null;
    const finish = (code, extra = '') => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (extra) output += `\n${extra}`;
      const s = parseTestSummary(output);
      const status = timedOut ? 'timed_out' : code === 0 ? 'passed' : 'failed';
      try {
        db.prepare(
          `UPDATE test_runs SET status = ?, completed_at = ?, duration_ms = ?, total_count = ?, passed_count = ?, failed_count = ?, skipped_count = ?, output = ?
           WHERE id = ?`,
        ).run(status, nowIso(), Date.now() - started, s.total, s.passed, s.failed, s.skipped, output.slice(-OUTPUT_KEEP), id);
      } finally {
        activeRunId = null;
        if (tmp) fs.rm(tmp, { recursive: true, force: true }, () => {});
      }
      resolve(runRow(db.prepare('SELECT * FROM test_runs WHERE id = ?').get(id), true));
    };
    try {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'procom-test-run-'));
      const child = spawnFn(process.execPath, ['--test', '--test-reporter=spec', ...files], {
        cwd: root,
        env: testRunEnv(tmp),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // Own process group on Linux, so a timeout also stops the per-file
        // test processes node --test starts.
        detached: process.platform !== 'win32',
      });
      const append = (chunk) => {
        output = `${output}${chunk}`.slice(-4 * OUTPUT_KEEP);
      };
      child.stdout?.on('data', append);
      child.stderr?.on('data', append);
      child.on('error', (err) => finish(1, `Could not start the tests: ${err.message}`));
      child.on('close', (code) => finish(code ?? 1, timedOut ? `Stopped after ${Math.round(timeoutMs / 1000)} s (time limit).` : ''));
      timer = setTimeout(() => {
        timedOut = true;
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }, timeoutMs);
    } catch (err) {
      finish(1, `Could not start the tests: ${err.message}`);
    }
  });
  return { run: getTestRun(id, db), done };
}

// ------------------------------------------------------------------ about this site

const sizeCache = new Map();
// Recursive folder size (bytes, files). Cached for 5 minutes; capped so a huge
// folder can't stall the request.
export function folderSize(dir, { maxEntries = 300_000 } = {}) {
  const cached = sizeCache.get(dir);
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.value;
  let bytes = 0;
  let files = 0;
  let seen = 0;
  let truncated = false;
  const stack = [dir];
  if (!fs.existsSync(dir)) return { bytes: null, files: 0, truncated: false, missing: true };
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > maxEntries) {
        truncated = true;
        break;
      }
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) {
        try {
          bytes += fs.statSync(full).size;
          files += 1;
        } catch {
          /* vanished */
        }
      }
    }
    if (truncated) break;
  }
  const value = { bytes, files, truncated };
  sizeCache.set(dir, { at: Date.now(), value });
  return value;
}

const KEY_TABLES = ['products', 'categories', 'suppliers', 'feed_items', 'feed_imports', 'orders', 'order_items', 'clients', 'newsletter_subscribers', 'promo_codes', 'specials', 'page_views', 'version_history', 'test_runs'];

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function appPackage(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
}

export function siteOverview({ db = getDb(), root = APP_ROOT } = {}) {
  const dbFile = process.env.DB_FILE || path.join(dataDir(), 'procom.db');
  const fileSize = (f) => {
    try {
      return fs.statSync(f).size;
    } catch {
      return 0;
    }
  };
  let disk = null;
  try {
    const st = fs.statfsSync(fs.existsSync(dataDir()) ? dataDir() : root);
    const total = Number(st.blocks) * Number(st.bsize);
    const free = Number(st.bavail) * Number(st.bsize);
    disk = { totalBytes: total, freeBytes: free, usedBytes: total - Number(st.bfree) * Number(st.bsize) };
  } catch {
    /* not supported */
  }
  const one = (sql, ...args) => {
    try {
      return db.prepare(sql).get(...args);
    } catch {
      return null;
    }
  };
  const latest = db.prepare('SELECT * FROM version_history ORDER BY version_number DESC LIMIT 1').get();
  const lastRun = db.prepare("SELECT * FROM test_runs WHERE status != 'running' ORDER BY started_at DESC LIMIT 1").get();
  const backups = listBackups();
  const offsite = getOffsiteConfig(db);
  const pkg = appPackage(root);
  return {
    generatedAt: nowIso(),
    app: {
      name: pkg.name || 'procom-solutions',
      packageVersion: pkg.version || '',
      version: latest ? `V${latest.version_label}` : '',
      commitSha: currentSha || latest?.commit_sha || '',
      commitUrl: currentSha || latest?.commit_sha ? `${GITHUB_REPO}/commit/${currentSha || latest.commit_sha}` : '',
      versionRecordedAt: latest?.recorded_at || '',
      nodeVersion: process.version,
      platform: `${os.type()} ${os.release()} (${os.arch()})`,
      processUptimeSeconds: Math.round(process.uptime()),
      serverUptimeSeconds: Math.round(os.uptime()),
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    },
    config: {
      payfastMode: payfastMode(),
      emailConfigured: Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD),
      offsiteConfigured: Boolean(offsite.remote),
      offsiteRemote: offsite.remote,
      automaticBackups: process.env.DISABLE_BACKUPS !== '1',
    },
    database: {
      sizeBytes: fileSize(dbFile) + fileSize(`${dbFile}-wal`) + fileSize(`${dbFile}-shm`),
      tables: KEY_TABLES.filter((t) => tableExists(db, t)).map((t) => ({ table: t, rows: db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n })),
    },
    storage: {
      disk,
      folders: [
        { label: 'Data folder (database, uploads, backups)', ...folderSize(dataDir()) },
        { label: 'Uploads (product photos)', ...folderSize(uploadsDir()) },
        { label: 'Backups', ...folderSize(backupsDir()) },
      ],
    },
    backups: {
      count: backups.length,
      latest: backups[0] || null,
      lastOffsiteSync: lastOffsiteSync(db),
    },
    counts: {
      products: one('SELECT COUNT(*) AS n FROM products')?.n ?? 0,
      liveProducts: one('SELECT COUNT(*) AS n FROM products WHERE active = 1')?.n ?? 0,
      categories: one('SELECT COUNT(*) AS n FROM categories WHERE active = 1')?.n ?? 0,
      orders: one('SELECT COUNT(*) AS n FROM orders')?.n ?? 0,
      paidOrders: one('SELECT COUNT(*) AS n FROM orders WHERE paid_at IS NOT NULL')?.n ?? 0,
      customers: one('SELECT COUNT(DISTINCT lower(email)) AS n FROM orders WHERE paid_at IS NOT NULL')?.n ?? 0,
      registeredAccounts: one('SELECT COUNT(*) AS n FROM clients')?.n ?? 0,
    },
    tests: lastRun ? runRow(lastRun) : null,
    links: {
      status: `${GITHUB_REPO}/blob/main/docs/STATUS.md`,
      deploy: `${GITHUB_REPO}/blob/main/deploy/DEPLOY.md`,
      repo: GITHUB_REPO,
    },
  };
}

// ------------------------------------------------------------------ routes

export function register({ admin, wrap, jobs = true }) {
  const who = (req) => String(req.admin?.username || '');

  // Backups (core keeps GET/POST /backups for the list + "Back up now").
  admin.get('/ops/backups', wrap(() => backupsOverview()));
  admin.put('/ops/backups/remote', wrap((req) => ({ offsite: setOffsiteRemote(req.body?.remote) })));
  admin.post('/ops/backups/sync', wrap((req) => {
    // Runs in the background (uploads can take minutes); the page polls /ops/backups.
    syncOffsite({ trigger: 'manual', requestedBy: who(req) }).catch((err) => console.error('Off-site copy failed:', err.message));
    return { started: true };
  }));
  admin.post('/ops/backups/test', wrap(() => testOffsiteConnection()));

  // Version history.
  admin.get('/ops/versions', wrap(() => ({ versions: listVersions(), currentSha })));
  admin.get('/ops/versions/:id', wrap((req) => getVersion(req.params.id) || Promise.reject(httpError('Version not found', 404))));

  // Test cases + runs.
  admin.get('/ops/tests', wrap(() => ({ ...listTestCases(), runs: listTestRuns(), active: testRunActive() })));
  admin.get('/ops/tests/runs/:id', wrap((req) => getTestRun(req.params.id) || Promise.reject(httpError('Test run not found', 404))));
  admin.post('/ops/tests/run', wrap((req) => startTestRun({ requestedBy: who(req) }).run));

  // API run log (Esquire / SMD).
  admin.get('/ops/api-runs', wrap((req) => {
    backfillApiRunLog();
    const smd = smdStatus();
    const slots = (smd.runTimesSast || []).map((t) => ({ h: Number(t.slice(0, 2)), m: Number(t.slice(3)) }));
    const iso = (d) => (d ? d.toISOString() : null);
    return {
      summary: apiRunSummary().map((s) => ({ ...s, nextRunAt: iso(nextRunAt(new Date(), s.supplier === 'SMD' ? slots : syncHours())) })),
      runs: listApiRuns({ supplier: String(req.query.supplier || ''), status: String(req.query.status || ''), limit: req.query.limit }),
    };
  }));

  // About this site.
  admin.get('/ops/overview', wrap(() => siteOverview()));

  if (!jobs) return;
  try {
    recoverInterruptedRuns();
  } catch (err) {
    console.error('Test-run recovery failed:', err.message);
  }
  recordStartupVersion().catch((err) => console.error('Version history:', err.message));
  const tick = () => autoSyncIfDue().catch((err) => console.error('Automatic off-site copy failed:', err.message));
  setTimeout(tick, 2 * 60_000).unref();
  setInterval(tick, 10 * 60_000).unref();
}
