// Governance (Phase 3): Audit log + Todo / Backlog. Ported from Lapanza3d's
// server/audit-log.js and server/todos.js and adapted:
//
// Audit log
// - auditAdminRequest() is mounted by the core before every /api/admin route
//   (after the login check). Every non-GET request is recorded when the
//   response finishes: time, admin, method, path, a friendly action name
//   ("Product updated"), the target id, the status code and success/fail,
//   plus a small whitelisted summary of the body (<= ~1 KB).
// - Never stored: values of password / token / secret / key / signature /
//   cookie / session / card fields (only the field name, under "redacted"),
//   file uploads (only a count), large bodies (only their size), and any
//   free-text body value that isn't on the SAFE_VALUE_KEYS whitelist
//   (descriptions, customer emails, addresses, notes...). Site settings and
//   product edits get a before -> after diff of the fields that changed.
// - Read-only POSTs (previews, dry runs) are skipped so the log stays useful.
// - It must never throw or delay the request: all the work happens in
//   try/catch, and the row is written on res 'finish' (after the response).
// - recordAudit() is called by the core for admin sign-in, failed sign-in,
//   sign-out and first-run setup.
// - Rows older than 12 months are pruned daily (unref'd timer).
//
// Todo / Backlog
// - title, details, priority (critical/high/medium/low), status
//   (open/in_progress/done), area tag, date added / done, who added it.
// - Seeded ONCE with the open items from docs/STATUS.md; a flag in
//   governance_flags stops deleted seed items from coming back.
import { randomUUID } from 'crypto';
import { getDb } from '../db.js';
import { getSettings } from '../settings.js';

const nowIso = () => new Date().toISOString();
const clean = (v, max = 2000) => String(v ?? '').trim().slice(0, max);
const notFound = (what) => Object.assign(new Error(`${what} not found`), { status: 404 });

// ================================================================ audit: rules

export const AUDIT_RETENTION_MONTHS = 12;
const MAX_DETAILS = 1000;
const MAX_BODY_BYTES = 64 * 1024;

// Field names whose values are never stored (matched case-insensitively
// against every body key, at any depth we look at).
const SENSITIVE_KEY = /pass(word|phrase)?|pwd|token|secret|api[-_]?key|private|^key$|keys?$|signature|cookie|session|otp|cvv|card|salt|hash|credential|auth/i;

// Body fields whose (short, scalar) values are safe and useful to keep.
// Everything else is recorded by name only.
const SAFE_VALUE_KEYS = new Set([
  'name', 'title', 'status', 'active', 'featured', 'priceMode', 'markupPct', 'priceCents', 'compareAtCents', 'costCents',
  'stockQty', 'supplierInStock', 'minOrderQty', 'weightG', 'fulfilment', 'categoryId', 'parentId', 'supplierId', 'quoteDelivery',
  'sku', 'code', 'brand', 'handled', 'disabled', 'list', 'dryRun', 'completeList', 'pricesIncludeVat', 'notifyCustomer', 'shipment',
  'deliveryMode', 'deliveryFeeCents', 'freeOverCostCents', 'publicLabel', 'optionType', 'category', 'sortOrder', 'priority', 'area',
  'percentOff', 'discountPct', 'discountPercent', 'amountOffCents', 'type', 'kind', 'username', 'paymentMethod', 'date', 'month',
  'defaultMarkupPct', 'vatRatePct', 'vatRegistered', 'action', 'field', 'value', 'enabled', 'maxUses', 'startsAt', 'endsAt',
]);

// Settings are the owner's own public business details -- values are fine to
// keep in the diff, but never anything that looks like a secret.
const PRODUCT_DIFF_COLUMNS = {
  name: 'name', price_cents: 'priceCents', cost_cents: 'costCents', markup_pct: 'markupPct', price_mode: 'priceMode',
  active: 'active', featured: 'featured', stock_qty: 'stockQty', supplier_in_stock: 'supplierInStock', category_id: 'categoryId',
  compare_at_cents: 'compareAtCents', min_order_qty: 'minOrderQty', quote_delivery: 'quoteDelivery', weight_g: 'weightG',
};

const AREAS = {
  products: 'Catalogue', categories: 'Catalogue', suppliers: 'Catalogue', feed: 'Catalogue', uploads: 'Catalogue',
  orders: 'Sales', messages: 'Sales', invoices: 'Sales',
  settings: 'Settings', shipping: 'Settings', admins: 'Settings', backups: 'Settings',
  promos: 'Marketing', specials: 'Marketing', 'price-drops': 'Marketing', newsletters: 'Marketing', marketing: 'Marketing',
  finance: 'Finance', 'registered-users': 'Customers', clients: 'Customers',
  todos: 'System', 'audit-log': 'System', ops: 'System',
};

// [methods, path regex (capture 1 = target id), action (string, or fn(body) -> string | null to skip)]
const ID = '([^/]+)';
const crud = (prefix, noun, { created = 'created', updated = 'updated' } = {}) => [
  ['POST', new RegExp(`^/${prefix}$`), `${noun} ${created}`],
  ['PUT', new RegExp(`^/${prefix}/${ID}$`), `${noun} ${updated}`],
  ['DELETE', new RegExp(`^/${prefix}/${ID}$`), `${noun} deleted`],
];
const RULES = [
  // Read-only helpers that use POST: never logged.
  ['POST', /^\/feed\/preview(\/map)?$/, null],
  ['POST', /^\/promos\/impact$/, null],
  ['POST', /^\/specials\/preview$/, null],
  ['POST', /^\/newsletters\/preview$/, null],
  ['POST', /^\/marketing\/adverts\/check$/, null],

  ['PUT', /^\/settings$/, 'Settings saved'],
  ['POST', /^\/products\/bulk$/, 'Products bulk-updated'],
  ['POST', /^\/products\/reprice$/, 'Products repriced'],
  ...crud('products', 'Product'),
  ['POST', /^\/uploads\/images$/, 'Images uploaded'],
  ...crud('categories', 'Category'),
  ...crud('suppliers', 'Supplier'),
  ['POST', /^\/feed\/import$/, 'Pricelist imported'],
  ['DELETE', new RegExp(`^/feed/imports/${ID}$`), 'Pricelist import deleted'],
  ['POST', /^\/feed\/list$/, 'Feed items listed in shop'],
  ['POST', /^\/feed\/images\/retry$/, 'Photo downloads retried'],
  ['POST', /^\/feed\/smd-autolist$/, (b) => (b?.dryRun === false ? `SMD auto-list applied${b.list ? ` (${clean(b.list, 40)})` : ''}` : null)],

  ['POST', new RegExp(`^/orders/${ID}/collection-ready$`), 'Collection notice emailed'],
  ['PUT', new RegExp(`^/orders/${ID}$`), (b) => (b && b.status ? 'Order status changed' : 'Order updated')],
  ['PUT', new RegExp(`^/messages/${ID}$`), (b) => (b?.handled ? 'Enquiry marked handled' : 'Enquiry marked not handled')],
  ['POST', new RegExp(`^/invoices/${ID}/email$`), 'Invoice emailed'],
  ['POST', /^\/invoices\/issue-missing$/, 'Missing invoices issued'],

  ...crud('shipping', 'Shipping option'),
  ['POST', /^\/admins$/, 'Admin user created'],
  ['DELETE', new RegExp(`^/admins/${ID}$`), 'Admin user removed'],
  ['PUT', new RegExp(`^/admins/${ID}/password$`), 'Admin password reset'],
  ['POST', /^\/backups$/, 'Backup created'],
  ['POST', new RegExp(`^/orders/${ID}/mark-paid$`), 'Order marked as paid by hand'],
  ['POST', new RegExp(`^/orders/${ID}/cancel$`), 'Order cancelled (refund recorded if it was paid)'],

  ...crud('promos', 'Promo code', { created: 'saved', updated: 'saved' }),
  ...crud('specials', 'Special', { created: 'saved', updated: 'saved' }),
  ['PUT', /^\/analytics\/geo$/, 'Visitor location account saved'],
  ['POST', /^\/analytics\/geo\/update$/, 'Visitor location database updated'],
  ['PUT', /^\/price-drops\/settings$/, 'Price drops settings saved'],
  ['PATCH', new RegExp(`^/price-drops/${ID}$`), (b) => ('hidden' in (b || {}) ? (b.hidden ? 'Price drop hidden' : 'Price drop shown') : b?.pinned ? 'Price drop pinned' : 'Price drop unpinned')],
  ['POST', /^\/price-drops\/bulk$/, (b) => `Price drops bulk: ${clean(b?.action, 20)}`],

  ['PUT', /^\/finance\/settings$/, 'Finance settings saved'],
  ...crud('finance/expenses', 'Expense'),
  ['PUT', new RegExp(`^/finance/delivery-costs/${ID}$`), 'Delivery cost saved'],
  ['DELETE', new RegExp(`^/finance/delivery-costs/${ID}$`), 'Delivery cost removed'],

  ['POST', /^\/marketing\/leads\/import$/, 'Leads imported'],
  ...crud('marketing/leads', 'Lead'),
  ['POST', new RegExp(`^/marketing/platforms/${ID}/groups$`), 'Platform group added'],
  ...crud('marketing/platforms', 'Platform'),
  ['PUT', new RegExp(`^/marketing/groups/${ID}$`), 'Platform group updated'],
  ['DELETE', new RegExp(`^/marketing/groups/${ID}$`), 'Platform group deleted'],
  ['POST', new RegExp(`^/marketing/adverts/${ID}/image$`), 'Advert image uploaded'],
  ['DELETE', new RegExp(`^/marketing/adverts/${ID}/image$`), 'Advert image removed'],
  ...crud('marketing/adverts', 'Advert'),
  ['POST', /^\/marketing\/lapanza-copy$/, 'Platforms copied from Lapanza3d'],

  ['PUT', /^\/newsletters\/settings$/, 'Newsletter settings saved'],
  ...crud('newsletters/campaigns', 'Newsletter'),
  ['POST', /^\/newsletters\/suppressions$/, 'Email suppressed'],
  ['DELETE', new RegExp(`^/newsletters/suppressions/${ID}$`), 'Suppression removed'],
  ['DELETE', new RegExp(`^/newsletters/subscribers/${ID}$`), 'Subscriber removed'],

  ['DELETE', new RegExp(`^/registered-users/${ID}$`), 'Customer account deleted'],
  ['PUT', new RegExp(`^/registered-users/${ID}/disabled$`), (b) => (b?.disabled ? 'Customer account disabled' : 'Customer account enabled')],
  ['POST', new RegExp(`^/registered-users/${ID}/verify$`), 'Customer marked verified'],
  ['POST', new RegExp(`^/registered-users/${ID}/send-reset$`), 'Customer reset email sent'],
  ['POST', new RegExp(`^/registered-users/${ID}/resend-verification$`), 'Verification email resent'],

  ['POST', /^\/todos$/, 'Todo added'],
  ['PUT', new RegExp(`^/todos/${ID}$`), (b) => (b?.status === 'done' ? 'Todo marked done' : 'Todo updated')],
  ['DELETE', new RegExp(`^/todos/${ID}$`), 'Todo deleted'],
];

const CAMPAIGN_STEP = { approve: 'approved', send: 'sent', pause: 'paused', resume: 'resumed', cancel: 'cancelled', test: 'test sent', 'retry-failed': 'retry of failed sends' };

const titleCase = (s) => String(s || '').replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const looksLikeId = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-|^\d+$|^[A-Z]{2,4}-?\d+$|@|^[0-9a-f]{16,}$/i.test(s);

function maskEmail(s) {
  return String(s).replace(/^(.)[^@]*(@.*)$/, '$1***$2');
}
function cleanTarget(id) {
  let s = '';
  try { s = decodeURIComponent(String(id || '')); } catch { s = String(id || ''); }
  if (s.includes('@')) s = maskEmail(s);
  return s.slice(0, 80);
}

// -> { action, area, target } or null (not logged).
export function describeAdminRequest(method, path, body) {
  const m = String(method || '').toUpperCase();
  const p = String(path || '').replace(/\/+$/, '') || '/';
  const first = p.split('/')[1] || '';
  const area = AREAS[first] || titleCase(first) || 'Admin';

  const step = p.match(new RegExp(`^/newsletters/campaigns/${ID}/(approve|send|pause|resume|cancel|test|retry-failed)$`));
  if (m === 'POST' && step) return { action: `Newsletter ${CAMPAIGN_STEP[step[2]]}`, area, target: cleanTarget(step[1]) };

  for (const [methods, re, action] of RULES) {
    if (methods !== m) continue;
    const hit = p.match(re);
    if (!hit) continue;
    const name = typeof action === 'function' ? action(body) : action;
    if (!name) return null;
    return { action: name, area, target: cleanTarget(hit[1] || '') };
  }

  // Unknown route (e.g. a newer feature): "<Area> <verb>" from the path.
  const segs = p.split('/').filter(Boolean);
  const idSeg = segs.find((s, i) => i > 0 && looksLikeId(s)) || '';
  const tail = segs.length > 1 && !looksLikeId(segs[segs.length - 1]) ? segs[segs.length - 1] : '';
  const verb = m === 'DELETE' ? 'deleted' : m === 'PUT' || m === 'PATCH' ? 'updated' : 'saved';
  const noun = titleCase(segs[0] || 'Admin');
  return { action: tail && tail !== segs[0] ? `${noun}: ${tail.replace(/[-_]+/g, ' ')}` : `${noun} ${verb}`, area, target: cleanTarget(idSeg) };
}

// ================================================================ audit: body summary

function safeScalar(v, max = 80) {
  if (v == null) return v;
  if (typeof v === 'boolean' || typeof v === 'number') return v;
  if (typeof v === 'string') return v.length > max ? `${v.slice(0, max)}…` : v;
  if (Array.isArray(v)) return `[${v.length} item${v.length === 1 ? '' : 's'}]`;
  return '{…}';
}

// Whitelisted summary of a JSON body: field names, safe values, redacted names.
export function summarizeBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const fields = [];
  const values = {};
  const redacted = [];
  for (const [k, v] of Object.entries(body).slice(0, 60)) {
    const key = String(k).slice(0, 40);
    if (SENSITIVE_KEY.test(key)) { redacted.push(key); continue; }
    fields.push(key);
    if (SAFE_VALUE_KEYS.has(key) && (v == null || typeof v !== 'object' || Array.isArray(v))) values[key] = safeScalar(v);
    else if (Array.isArray(v) && /ids$/i.test(key)) values[key] = safeScalar(v);
  }
  const out = {};
  if (fields.length) out.fields = fields.slice(0, 30);
  if (Object.keys(values).length) out.values = values;
  if (redacted.length) out.redacted = redacted.slice(0, 10);
  return Object.keys(out).length ? out : null;
}

function diffObjects(before, after, keys, { max = 60 } = {}) {
  const changed = {};
  for (const k of keys) {
    if (SENSITIVE_KEY.test(k) || k.startsWith('setup:')) continue;
    const a = before?.[k];
    const b = after?.[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) changed[k] = [safeScalar(a, max), safeScalar(b, max)];
  }
  return changed;
}

// JSON under MAX_DETAILS chars: drops the bulkiest parts first.
export function capDetails(details) {
  if (!details || typeof details !== 'object') return '';
  const d = JSON.parse(JSON.stringify(details));
  let s = JSON.stringify(d);
  if (s.length <= MAX_DETAILS) return s;
  // Shorten long values first, then drop whole sections.
  for (const sec of ['changed', 'values']) {
    if (d[sec]) {
      for (const k of Object.keys(d[sec])) {
        const v = d[sec][k];
        d[sec][k] = Array.isArray(v) ? v.map((x) => safeScalar(x, 20)) : safeScalar(v, 20);
      }
    }
  }
  s = JSON.stringify(d);
  for (const sec of ['values', 'fields', 'changed']) {
    if (s.length <= MAX_DETAILS) break;
    if (d[sec]) {
      const n = Array.isArray(d[sec]) ? d[sec].length : Object.keys(d[sec]).length;
      delete d[sec];
      d[`${sec}Omitted`] = n;
      s = JSON.stringify(d);
    }
  }
  return s.length <= MAX_DETAILS ? s : JSON.stringify({ truncated: true });
}

// ================================================================ audit: writing

const INSERT_SQL = `INSERT INTO audit_log (created_at, actor, action, area, method, path, target_id, status, ok, ip, details)
  VALUES (@created_at, @actor, @action, @area, @method, @path, @target_id, @status, @ok, @ip, @details)`;

function insertAudit(row, db = getDb()) {
  db.prepare(INSERT_SQL).run({
    created_at: nowIso(),
    actor: clean(row.actor, 80),
    action: clean(row.action, 120) || 'Admin action',
    area: clean(row.area, 40),
    method: clean(row.method, 10),
    path: clean(row.path, 200),
    target_id: clean(row.target, 80),
    status: Number.isInteger(row.status) ? row.status : null,
    ok: row.ok === false ? 0 : 1,
    ip: clean(row.ip, 64),
    details: typeof row.details === 'string' ? row.details.slice(0, MAX_DETAILS + 50) : capDetails(row.details),
  });
}

const AUTH_ACTIONS = {
  'admin.login': ['Signed in', true],
  'admin.login_failed': ['Sign-in failed', false],
  'admin.logout': ['Signed out', true],
  'admin.setup': ['First admin account created', true],
};

// Core calls this for sign-in / failed sign-in / sign-out / first-run setup.
// `details` is passed through the same whitelist as request bodies.
export function recordAudit({ action, actor = '', req = null, details = null } = {}, db) {
  try {
    const [label, ok] = AUTH_ACTIONS[action] || [clean(action, 120) || 'Admin action', true];
    insertAudit({
      actor,
      action: label,
      area: AUTH_ACTIONS[action] ? 'Sign-in' : 'Admin',
      method: req?.method || '',
      path: req ? String(req.originalUrl || req.path || '').split('?')[0] : '',
      status: null,
      ok,
      ip: req?.ip || '',
      details: details && typeof details === 'object' ? summarizeBody(details) : null,
    }, db || getDb());
  } catch (err) {
    console.error('audit: failed to record', action, err.message);
  }
}

function snapshotBefore(method, path, db) {
  if (method === 'PUT' && path === '/settings') return { kind: 'settings', data: getSettings(db) };
  const pm = method === 'PUT' && path.match(/^\/products\/([^/]+)$/);
  if (pm) {
    const row = db.prepare(`SELECT ${Object.keys(PRODUCT_DIFF_COLUMNS).join(', ')} FROM products WHERE id = ?`).get(decodeURIComponent(pm[1]));
    return row ? { kind: 'product', id: decodeURIComponent(pm[1]), data: row } : null;
  }
  return null;
}

function diffAfter(snap, db) {
  if (!snap) return null;
  if (snap.kind === 'settings') {
    const after = getSettings(db);
    const keys = [...new Set([...Object.keys(snap.data), ...Object.keys(after)])];
    return diffObjects(snap.data, after, keys, { max: 80 });
  }
  if (snap.kind === 'product') {
    const row = db.prepare(`SELECT ${Object.keys(PRODUCT_DIFF_COLUMNS).join(', ')} FROM products WHERE id = ?`).get(snap.id);
    if (!row) return null;
    const rename = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [PRODUCT_DIFF_COLUMNS[k], v]));
    return diffObjects(rename(snap.data), rename(row), Object.values(PRODUCT_DIFF_COLUMNS));
  }
  return null;
}

// Mounted by the core before every /api/admin route. Never throws, never
// delays: the row is written after the response has gone out.
export function auditAdminRequest(req, res, next) {
  try {
    startAudit(req, res);
  } catch (err) {
    console.error('audit: could not start', err.message);
  }
  next();
}

function startAudit(req, res) {
  const method = String(req.method || '').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  const path = String(req.path || '/');
  const bodyIn = req.body && typeof req.body === 'object' ? req.body : null;
  const described = describeAdminRequest(method, path, bodyIn);
  if (!described) return;

  const size = Number(req.get?.('content-length')) || 0;
  const isUpload = Boolean(req.is?.('multipart/form-data'));
  const details = {};
  if (isUpload) details.upload = true;
  else if (size > MAX_BODY_BYTES) details.largeBody = `${Math.round(size / 1024)} KB`;
  else {
    const summary = summarizeBody(bodyIn);
    if (summary) Object.assign(details, summary);
  }

  const db = getDb();
  let snap = null;
  try { snap = snapshotBefore(method, path, db); } catch { snap = null; }

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    try {
      const status = res.statusCode;
      const ok = res.writableFinished !== false && status < 400;
      if (isUpload) {
        const files = Array.isArray(req.files) ? req.files.length : req.file ? 1 : 0;
        if (files) details.files = files;
      }
      if (snap && ok) {
        const changed = diffAfter(snap, db);
        if (changed) details.changed = changed;
        if (changed && !Object.keys(changed).length) details.noChanges = true;
        if (snap.kind === 'settings') { delete details.fields; delete details.values; }
      }
      if (!ok) details.aborted = res.writableFinished === false ? true : undefined;
      insertAudit({
        actor: req.admin?.username || '',
        action: described.action,
        area: described.area,
        method,
        path: `/api/admin${path}`,
        target: described.target,
        status,
        ok,
        ip: req.ip || '',
        details: Object.keys(details).length ? details : null,
      }, db);
    } catch (err) {
      console.error('audit: failed to record', described.action, err.message);
    }
  };
  res.once('finish', finish);
  res.once('close', finish);
}

// ================================================================ audit: reading

export function pruneAudit(monthsToKeep = AUDIT_RETENTION_MONTHS, db = getDb()) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - monthsToKeep);
  return db.prepare('DELETE FROM audit_log WHERE created_at < ?').run(cutoff.toISOString()).changes;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
// Dates in the filters are SAST calendar days.
const sastStartIso = (ymd) => new Date(`${ymd}T00:00:00+02:00`).toISOString();
const sastNextDayIso = (ymd) => new Date(new Date(`${ymd}T00:00:00+02:00`).getTime() + 86400000).toISOString();

function auditWhere({ actor = '', action = '', area = '', from = '', to = '', q = '', ok = '' } = {}) {
  const where = [];
  const args = {};
  if (actor) { where.push('actor = @actor'); args.actor = String(actor); }
  if (action) { where.push('action = @action'); args.action = String(action); }
  if (area) { where.push('area = @area'); args.area = String(area); }
  if (YMD.test(from)) { where.push('created_at >= @from'); args.from = sastStartIso(from); }
  if (YMD.test(to)) { where.push('created_at < @to'); args.to = sastNextDayIso(to); }
  if (ok === '1' || ok === '0') { where.push('ok = @ok'); args.ok = Number(ok); }
  const term = clean(q, 100).toLowerCase().replace(/[%_]/g, '');
  if (term) {
    where.push('(lower(action) LIKE @q OR lower(actor) LIKE @q OR lower(path) LIKE @q OR lower(target_id) LIKE @q OR lower(details) LIKE @q OR ip LIKE @q)');
    args.q = `%${term}%`;
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

function rowToAudit(r) {
  let details = null;
  try { details = r.details ? JSON.parse(r.details) : null; } catch { details = { raw: r.details }; }
  return {
    id: r.id, createdAt: r.created_at, actor: r.actor, action: r.action, area: r.area, method: r.method,
    path: r.path, targetId: r.target_id, status: r.status, ok: Boolean(r.ok), ip: r.ip, details,
  };
}

export function listAudit(filters = {}, db = getDb()) {
  const { sql, args } = auditWhere(filters);
  const pageSize = Math.min(Math.max(Number(filters.pageSize) || 50, 1), 200);
  const total = db.prepare(`SELECT COUNT(*) n FROM audit_log ${sql}`).get(args).n;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(Number(filters.page) || 1, 1), pages);
  const items = db.prepare(`SELECT * FROM audit_log ${sql} ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset`)
    .all({ ...args, limit: pageSize, offset: (page - 1) * pageSize }).map(rowToAudit);
  const distinct = (col) => db.prepare(`SELECT DISTINCT ${col} v FROM audit_log WHERE ${col} != '' ORDER BY ${col} COLLATE NOCASE`).all().map((r) => r.v);
  return { items, total, page, pages, pageSize, actors: distinct('actor'), actions: distinct('action'), areas: distinct('area'), retentionMonths: AUDIT_RETENTION_MONTHS };
}

const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // no spreadsheet formulas
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function auditCsv(filters = {}, db = getDb()) {
  const { sql, args } = auditWhere(filters);
  const rows = db.prepare(`SELECT * FROM audit_log ${sql} ORDER BY created_at DESC, id DESC LIMIT 20000`).all(args);
  const head = ['Time (UTC)', 'Admin', 'Action', 'Area', 'Target', 'Result', 'Status', 'Method', 'Path', 'IP', 'Details'];
  const lines = [head, ...rows.map((r) => [r.created_at, r.actor, r.action, r.area, r.target_id, r.ok ? 'ok' : 'failed', r.status ?? '', r.method, r.path, r.ip, r.details])];
  return `﻿${lines.map((l) => l.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

// ================================================================ todos

export const TODO_STATUSES = ['open', 'in_progress', 'done'];
export const TODO_STATUS_LABELS = { open: 'Open', in_progress: 'In progress', done: 'Done' };
export const TODO_PRIORITIES = ['critical', 'high', 'medium', 'low'];
export const TODO_AREAS = ['Orders', 'Payments', 'Delivery', 'Catalogue', 'Pricing', 'Marketing', 'Finance', 'Legal', 'SEO', 'Photos', 'Admin', 'Server'];

function rowToTodo(r) {
  if (!r) return null;
  return {
    id: r.id, number: r.number, title: r.title, details: r.details, priority: r.priority, status: r.status,
    area: r.area, createdBy: r.created_by, dateAdded: r.date_added, doneAt: r.done_at, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function getTodo(id, db = getDb()) {
  return rowToTodo(db.prepare('SELECT * FROM todo_items WHERE id = ?').get(String(id)));
}

export function listTodos({ status = '', priority = '', area = '', q = '' } = {}, db = getDb()) {
  const where = [];
  const args = {};
  if (status === 'not_done') where.push("status != 'done'");
  else if (TODO_STATUSES.includes(status)) { where.push('status = @status'); args.status = status; }
  if (TODO_PRIORITIES.includes(priority)) { where.push('priority = @priority'); args.priority = priority; }
  if (area) { where.push('area = @area'); args.area = String(area); }
  const term = clean(q, 100).toLowerCase().replace(/[%_]/g, '');
  if (term) { where.push('(lower(title) LIKE @q OR lower(details) LIKE @q OR lower(area) LIKE @q)'); args.q = `%${term}%`; }
  const items = db.prepare(`SELECT * FROM todo_items ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 ELSE 2 END,
      CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      CASE WHEN status = 'done' THEN done_at END DESC, number ASC`).all(args).map(rowToTodo);
  const counts = { open: 0, in_progress: 0, done: 0 };
  for (const r of db.prepare('SELECT status, COUNT(*) n FROM todo_items GROUP BY status').all()) counts[r.status] = r.n;
  const used = db.prepare("SELECT DISTINCT area FROM todo_items WHERE area != ''").all().map((r) => r.area);
  const areas = [...new Set([...TODO_AREAS, ...used])].sort((a, b) => a.localeCompare(b));
  return { items, counts, areas, statuses: TODO_STATUSES, priorities: TODO_PRIORITIES };
}

function todoFields(data, existing) {
  const title = data.title !== undefined ? clean(data.title, 200) : existing?.title;
  if (!title) throw new Error('Give the todo a short title');
  const pick = (v, list, fallback) => (v === undefined ? fallback : list.includes(String(v)) ? String(v) : null);
  const priority = pick(data.priority, TODO_PRIORITIES, existing?.priority || 'medium');
  if (!priority) throw new Error('Priority must be critical, high, medium or low');
  const status = pick(data.status, TODO_STATUSES, existing?.status || 'open');
  if (!status) throw new Error('Status must be open, in progress or done');
  return {
    title,
    details: data.details !== undefined ? clean(data.details, 4000) : existing?.details || '',
    priority,
    status,
    area: data.area !== undefined ? clean(data.area, 40) : existing?.area || '',
  };
}

export function createTodo(data = {}, db = getDb(), { createdBy = '' } = {}) {
  const f = todoFields(data, null);
  const now = nowIso();
  const id = randomUUID();
  const number = (db.prepare('SELECT MAX(number) m FROM todo_items').get().m || 0) + 1;
  db.prepare(`INSERT INTO todo_items (id, number, title, details, priority, status, area, created_by, date_added, done_at, created_at, updated_at)
    VALUES (@id, @number, @title, @details, @priority, @status, @area, @created_by, @date_added, @done_at, @now, @now)`)
    .run({ ...f, id, number, created_by: clean(createdBy, 80), date_added: data.dateAdded && YMD.test(String(data.dateAdded).slice(0, 10)) ? String(data.dateAdded) : now, done_at: f.status === 'done' ? now : '', now });
  return getTodo(id, db);
}

export function updateTodo(id, data = {}, db = getDb()) {
  const existing = getTodo(id, db);
  if (!existing) return null;
  const f = todoFields(data, existing);
  const now = nowIso();
  // done_at is stamped when an item becomes done and cleared if reopened.
  const doneAt = f.status === 'done' ? existing.doneAt || now : '';
  db.prepare('UPDATE todo_items SET title = @title, details = @details, priority = @priority, status = @status, area = @area, done_at = @done_at, updated_at = @now WHERE id = @id')
    .run({ ...f, done_at: doneAt, now, id: existing.id });
  return getTodo(id, db);
}

export function deleteTodo(id, db = getDb()) {
  return db.prepare('DELETE FROM todo_items WHERE id = ?').run(String(id)).changes > 0;
}

// Open items from docs/STATUS.md "Open items / backlog" (2026-09-28), as short todos.
export const SEED_TODOS = [
  { title: 'Place the first real test order', area: 'Orders', priority: 'high', details: 'Buy a cheap SMD item, choose Collect, click "Ready for collection — email notice" in the order, then refund in Payfast. Proves Payfast ITN → Paid → confirmation + owner emails → supplier order sheet → collection notice end to end.' },
  { title: 'Issue missing invoices once', area: 'Finance', priority: 'high', details: 'Admin → Invoice history → "Issue missing invoices", so older paid orders (PC10002…) get invoice numbers before new ones.' },
  { title: 'Keep specials and promo codes under ~5% at the 10% markup', area: 'Pricing', priority: 'high', details: 'At the 10% default markup the margin above cost incl VAT is ~9% and Payfast takes ~3–4% incl VAT, so a discount above ~5% loses money once fees are counted (the discount cap only protects cost incl VAT, not fees).' },
  { title: 'Check Payfast fee estimates against a statement', area: 'Finance', priority: 'medium', details: 'Financial overview → Payfast payment methods & fees (set from the Payfast dashboard 2026-09-29). New payments record the actual fee; compare a statement once.' },
  { title: 'Copy platforms & rules from Lapanza3d', area: 'Marketing', priority: 'medium', details: 'Platform rules → "Copy platforms & rules from Lapanza3d": check the preview, then apply.' },
  { title: 'Legal: decide who carries risk in transit', area: 'Legal', priority: 'medium', details: 'Terms currently say risk passes to the customer on delivery, so courier losses are ours. Keep or change?' },
  { title: 'Legal: are DB backups copied to Google Drive?', area: 'Legal', priority: 'medium', details: 'If backups are copied off-site to Google Drive, the Privacy Policy must list it.' },
  { title: 'Fill in delivery terms for Esquire, IDS, Huge PC, Dicspeed', area: 'Delivery', priority: 'medium', details: 'Admin → Suppliers → <supplier> → Delivery: public label, flat fee or store-wide, free threshold, collection. Until then their items use the store-wide courier brackets and delivery quotes.' },
  { title: 'Upload better photos for key products', area: 'Photos', priority: 'medium', details: "SMD's embedded photos are about 113px. Start with best sellers and featured products." },
  { title: 'Check Google Search Console indexing', area: 'SEO', priority: 'medium', details: 'In 1–2 weeks: sitemap "Success" and indexed pages rising. If product pages still are not indexed after ~4 weeks, consider server-rendered product pages.' },
  { title: 'Monthly SMD pricelist update', area: 'Catalogue', priority: 'low', details: 'Import the new Infant Essential / Cash Wholesale files, then on the server run node server/smd-autolist-cli.js (dry run) and --apply (see deploy/DEPLOY.md). The browser button can time out on the Cash list.' },
  { title: 'Product weights default to 1 kg', area: 'Delivery', priority: 'low', details: 'Supplier lists have no weights. No effect on SMD items (flat fee); only matters for store-mode suppliers using courier brackets.' },
];

const SEED_FLAG = 'todoSeedV1';

// Seeds once per database. The flag (not the row count) guards it, so items
// the owner deletes never come back after a restart.
export function seedTodos(db = getDb()) {
  if (db.prepare('SELECT 1 FROM governance_flags WHERE key = ?').get(SEED_FLAG)) return 0;
  let n = 0;
  db.transaction(() => {
    for (const t of SEED_TODOS) { createTodo(t, db, { createdBy: 'STATUS.md' }); n += 1; }
    db.prepare('INSERT INTO governance_flags (key, value, set_at) VALUES (?, ?, ?)').run(SEED_FLAG, String(n), nowIso());
  })();
  return n;
}

// ================================================================ routes

let pruneTimer = null;

export function register({ admin, wrap }) {
  try { seedTodos(); } catch (err) { console.error('governance: todo seed failed', err.message); }

  // Prune the audit log once shortly after start, then daily.
  if (!pruneTimer) {
    const prune = () => { try { pruneAudit(); } catch (err) { console.error('audit prune failed', err.message); } };
    setTimeout(prune, 60_000).unref();
    pruneTimer = setInterval(prune, 24 * 3600 * 1000);
    pruneTimer.unref();
  }

  const q = (req) => ({
    actor: clean(req.query.actor, 80), action: clean(req.query.action, 120), area: clean(req.query.area, 40),
    from: clean(req.query.from, 10), to: clean(req.query.to, 10), q: clean(req.query.q, 100), ok: clean(req.query.ok, 1),
    page: req.query.page, pageSize: req.query.pageSize,
  });
  admin.get('/audit-log', wrap((req) => listAudit(q(req))));
  admin.get('/audit-log/export.csv', (req, res) => {
    try {
      const day = new Date(Date.now() + 2 * 3600 * 1000).toISOString().slice(0, 10);
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="procom-audit-log-${day}.csv"`);
      res.send(auditCsv(q(req)));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  admin.get('/todos', wrap((req) => listTodos({ status: clean(req.query.status, 20), priority: clean(req.query.priority, 20), area: clean(req.query.area, 40), q: clean(req.query.q, 100) })));
  admin.post('/todos', wrap((req) => createTodo(req.body || {}, getDb(), { createdBy: req.admin?.username || '' })));
  admin.put('/todos/:id', wrap((req) => {
    const t = updateTodo(req.params.id, req.body || {});
    if (!t) throw notFound('Todo');
    return t;
  }));
  admin.delete('/todos/:id', wrap((req) => {
    if (!deleteTodo(req.params.id)) throw notFound('Todo');
    return { ok: true };
  }));
}
