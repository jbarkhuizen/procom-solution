// Marketing (Phase 2): Potential market (lead contacts), Adverts, Platform
// rules and the ad Calendar. Admin-only routes on the `admin` router.
//
// Ported from lapanza3d's server/advertising.js + potential-market.js and
// adapted:
// - Leads carry company, type, pipeline status, source (POPIA: where the
//   details came from), notes and last-contacted date. They are never part of
//   the newsletter audience -- nothing here touches clients/newsletters.
// - Adverts may target one group of a platform; a planned date that falls on
//   a day the group doesn't allow is saved but flagged (dayWarning).
// - "Copy platforms & rules from Lapanza3d" opens Lapanza's live database
//   READ-ONLY (same VPS, same `deploy` user) and merges its platforms and
//   groups into ours by name. Adverts and images are never copied.
import fs from 'fs';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import multer from 'multer';
import { parse as parseCsv } from 'csv-parse/sync';
import { getDb } from '../db.js';
import { storeProductImage, deleteUpload, isAllowedImage, MAX_IMAGE_BYTES } from '../images.js';

const nowIso = () => new Date().toISOString();
const clean = (v, max = 2000) => String(v ?? '').trim().slice(0, max);
const notFound = (what) => Object.assign(new Error(`${what} not found`), { status: 404 });

// ================================================================ leads

export const LEAD_TYPES = ['business', 'school', 'reseller', 'other'];
export const LEAD_STATUSES = ['new', 'contacted', 'interested', 'customer', 'not_interested'];
export const LEAD_STATUS_LABELS = { new: 'New', contacted: 'Contacted', interested: 'Interested', customer: 'Customer', not_interested: 'Not interested' };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidYmd(s) {
  if (!YMD_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Accepts labels as well as keys ("Not interested", "not-interested").
function normalizeChoice(value, list, fallback) {
  const v = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!v) return fallback;
  if (list.includes(v)) return v;
  if (v.endsWith('s') && list.includes(v.slice(0, -1))) return v.slice(0, -1); // "schools"
  return null;
}

function rowToLead(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    company: r.company,
    email: r.email,
    phone: r.phone,
    type: r.type,
    status: r.status,
    source: r.source,
    notes: r.notes,
    lastContactedAt: r.last_contacted_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listLeads({ q = '', status = '', type = '' } = {}, db = getDb()) {
  const where = [];
  const args = {};
  if (status) { where.push('status = @status'); args.status = status; }
  if (type) { where.push('type = @type'); args.type = type; }
  const term = String(q || '').trim().toLowerCase();
  if (term) {
    where.push("(lower(name) LIKE @q OR lower(company) LIKE @q OR lower(email) LIKE @q OR phone LIKE @q OR lower(notes) LIKE @q OR lower(source) LIKE @q)");
    args.q = `%${term.replace(/[%_]/g, '')}%`;
  }
  const sql = `SELECT * FROM potential_market_contacts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC`;
  const items = db.prepare(sql).all(args).map(rowToLead);
  const counts = Object.fromEntries(LEAD_STATUSES.map((s) => [s, 0]));
  for (const r of db.prepare('SELECT status, COUNT(*) n FROM potential_market_contacts GROUP BY status').all()) counts[r.status] = r.n;
  const total = db.prepare('SELECT COUNT(*) n FROM potential_market_contacts').get().n;
  return { items, counts, total };
}

export function getLead(id, db = getDb()) {
  return rowToLead(db.prepare('SELECT * FROM potential_market_contacts WHERE id = ?').get(id));
}

function leadFields(data, existing) {
  const pick = (key, col, max) => (data[key] !== undefined ? clean(data[key], max) : existing ? existing[col] : '');
  const out = {
    name: pick('name', 'name', 200),
    company: pick('company', 'company', 200),
    email: pick('email', 'email', 200).toLowerCase(),
    phone: pick('phone', 'phone', 60),
    source: pick('source', 'source', 500),
    notes: pick('notes', 'notes', 4000),
    last_contacted_at: pick('lastContactedAt', 'last_contacted_at', 10),
  };
  if (!out.name && !out.company) throw new Error('Enter a contact name or a company');
  if (out.email && !EMAIL_RE.test(out.email)) throw new Error(`"${out.email}" is not a valid email address`);
  if (out.last_contacted_at && !isValidYmd(out.last_contacted_at)) throw new Error('Last contacted must be a date (YYYY-MM-DD)');
  const type = data.type !== undefined ? normalizeChoice(data.type, LEAD_TYPES, 'business') : existing?.type || 'business';
  if (!type) throw new Error(`Type must be one of: ${LEAD_TYPES.join(', ')}`);
  const status = data.status !== undefined ? normalizeChoice(data.status, LEAD_STATUSES, 'new') : existing?.status || 'new';
  if (!status) throw new Error(`Status must be one of: ${Object.values(LEAD_STATUS_LABELS).join(', ')}`);
  return { ...out, type, status };
}

export function saveLead(data = {}, id = null, db = getDb()) {
  const existing = id ? db.prepare('SELECT * FROM potential_market_contacts WHERE id = ?').get(id) : null;
  if (id && !existing) return null;
  const f = leadFields(data, existing);
  const now = nowIso();
  if (existing) {
    db.prepare(
      `UPDATE potential_market_contacts SET name=@name, company=@company, email=@email, phone=@phone, type=@type, status=@status,
        source=@source, notes=@notes, last_contacted_at=@last_contacted_at, updated_at=@now WHERE id=@id`,
    ).run({ ...f, now, id });
    return getLead(id, db);
  }
  const newId = randomUUID();
  db.prepare(
    `INSERT INTO potential_market_contacts (id, name, company, email, phone, type, status, source, notes, last_contacted_at, created_at, updated_at)
     VALUES (@id, @name, @company, @email, @phone, @type, @status, @source, @notes, @last_contacted_at, @now, @now)`,
  ).run({ ...f, id: newId, now });
  return getLead(newId, db);
}

export function deleteLead(id, db = getDb()) {
  return db.prepare('DELETE FROM potential_market_contacts WHERE id = ?').run(id).changes > 0;
}

// Same dedupe rule as Lapanza: email if there is one, else name + company.
function leadKey(r) {
  const email = String(r.email || '').trim().toLowerCase();
  if (email) return `email:${email}`;
  return `name:${String(r.name || '').trim().toLowerCase()}|${String(r.company || '').trim().toLowerCase()}`;
}

const CSV_ALIASES = {
  name: ['name', 'contact', 'contact name', 'contact person', 'full name', 'person'],
  firstName: ['first name', 'firstname'],
  surname: ['surname', 'last name', 'lastname'],
  company: ['company', 'business', 'business name', 'organisation', 'organization', 'school', 'company name'],
  email: ['email', 'e-mail', 'email address'],
  phone: ['phone', 'mobile', 'mobile number', 'cell', 'cellphone', 'tel', 'telephone', 'phone number', 'contact number'],
  type: ['type', 'lead type', 'category'],
  status: ['status', 'stage'],
  source: ['source', 'lead source', 'where from'],
  notes: ['notes', 'note', 'comments', 'comment'],
  lastContactedAt: ['last contacted', 'last contacted at', 'last contact', 'contacted'],
};

function headerKey(header) {
  const h = String(header || '').trim().toLowerCase().replace(/[_]+/g, ' ').replace(/\s+/g, ' ');
  for (const [key, aliases] of Object.entries(CSV_ALIASES)) if (aliases.includes(h)) return key;
  return null;
}

// CSV text -> contacts. `source` is used for rows without their own Source
// column value; a source is required (POPIA: record where details came from).
export function importLeadsCsv({ csv, source = '' } = {}, db = getDb()) {
  const text = String(csv || '').replace(/^﻿/, '');
  if (!text.trim()) throw new Error('The file is empty');
  let records;
  try {
    records = parseCsv(text, { skip_empty_lines: true, relax_column_count: true, trim: true });
  } catch (err) {
    throw new Error(`Could not read the CSV: ${err.message}`);
  }
  if (records.length < 2) throw new Error('The CSV needs a heading row and at least one contact');
  const keys = records[0].map(headerKey);
  if (!keys.some((k) => ['name', 'firstName', 'company'].includes(k))) {
    throw new Error('No Name or Company column found. Headings: Name, Company, Email, Phone, Type, Status, Source, Notes, Last contacted');
  }
  const defaultSource = clean(source, 500);
  const seen = new Set(db.prepare('SELECT name, company, email FROM potential_market_contacts').all().map(leadKey));
  let created = 0;
  const skippedRows = [];
  const run = db.transaction(() => {
    records.slice(1).forEach((cells, i) => {
      const rowNo = i + 2; // spreadsheet row number (heading is row 1)
      if (cells.every((c) => !String(c ?? '').trim())) return; // blank row
      const row = {};
      keys.forEach((k, c) => { if (k && cells[c] != null && row[k] == null) row[k] = cells[c]; });
      if (!row.name && (row.firstName || row.surname)) row.name = [row.firstName, row.surname].filter(Boolean).join(' ');
      delete row.firstName;
      delete row.surname;
      if (!row.source) row.source = defaultSource;
      if (!row.name && !row.company) return skippedRows.push({ row: rowNo, reason: 'No name or company' });
      if (!row.source) return skippedRows.push({ row: rowNo, reason: 'No source (enter where these contacts came from)' });
      const key = leadKey(row);
      if (seen.has(key)) return skippedRows.push({ row: rowNo, reason: 'Duplicate' });
      try {
        saveLead(row, null, db);
        seen.add(key);
        created += 1;
      } catch (err) {
        skippedRows.push({ row: rowNo, reason: err.message });
      }
    });
  });
  run();
  return { created, skipped: skippedRows.length, skippedRows };
}

// ================================================================ platforms

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function normalizeDays(days) {
  const list = (Array.isArray(days) ? days : String(days || '').split(',')).map((d) => String(d).trim().slice(0, 3).toLowerCase());
  return WEEKDAYS.filter((d) => list.includes(d.toLowerCase())).join(',');
}

function rowToPlatform(r) {
  if (!r) return null;
  return { id: r.id, name: r.name, hasGroups: Boolean(r.has_groups), notes: r.notes, active: Boolean(r.active), sortOrder: r.sort_order, createdAt: r.created_at, updatedAt: r.updated_at };
}

function rowToGroup(r) {
  if (!r) return null;
  return {
    id: r.id,
    platformId: r.platform_id,
    groupName: r.group_name,
    allowedDays: r.allowed_days ? r.allowed_days.split(',').filter(Boolean) : [],
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// Platforms with their groups and advert counts, in sort order.
export function listPlatforms({ activeOnly = false } = {}, db = getDb()) {
  const groups = db.prepare('SELECT * FROM advert_platform_groups ORDER BY group_name COLLATE NOCASE').all().map(rowToGroup);
  const adCounts = new Map(db.prepare('SELECT platform_id, COUNT(*) n FROM adverts GROUP BY platform_id').all().map((r) => [r.platform_id, r.n]));
  return db
    .prepare('SELECT * FROM advert_platforms ORDER BY sort_order, created_at')
    .all()
    .map(rowToPlatform)
    .filter((p) => !activeOnly || p.active)
    .map((p) => ({ ...p, groups: groups.filter((g) => g.platformId === p.id), advertCount: adCounts.get(p.id) || 0 }));
}

export function getPlatform(id, db = getDb()) {
  return rowToPlatform(db.prepare('SELECT * FROM advert_platforms WHERE id = ?').get(id));
}

export function savePlatform(data = {}, id = null, db = getDb()) {
  const existing = id ? db.prepare('SELECT * FROM advert_platforms WHERE id = ?').get(id) : null;
  if (id && !existing) return null;
  const name = data.name !== undefined ? clean(data.name, 120) : existing?.name;
  if (!name) throw new Error('Platform name is required');
  const clash = db.prepare('SELECT id FROM advert_platforms WHERE lower(name) = lower(?) AND id != ?').get(name, id || '');
  if (clash) throw new Error(`There is already a platform called "${name}"`);
  const row = {
    name,
    has_groups: data.hasGroups !== undefined ? (data.hasGroups ? 1 : 0) : existing?.has_groups ?? 0,
    notes: data.notes !== undefined ? clean(data.notes) : existing?.notes ?? '',
    active: data.active !== undefined ? (data.active ? 1 : 0) : existing?.active ?? 1,
    now: nowIso(),
  };
  if (existing) {
    db.prepare('UPDATE advert_platforms SET name=@name, has_groups=@has_groups, notes=@notes, active=@active, updated_at=@now WHERE id=@id').run({ ...row, id });
    return getPlatform(id, db);
  }
  const newId = randomUUID();
  const maxSort = db.prepare('SELECT MAX(sort_order) m FROM advert_platforms').get().m;
  db.prepare(
    `INSERT INTO advert_platforms (id, name, has_groups, notes, active, sort_order, created_at, updated_at)
     VALUES (@id, @name, @has_groups, @notes, @active, @sort_order, @now, @now)`,
  ).run({ ...row, id: newId, sort_order: (maxSort ?? -1) + 1 });
  return getPlatform(newId, db);
}

// Retire (active off) instead of deleting a platform that adverts use.
export function deletePlatform(id, db = getDb()) {
  const n = db.prepare('SELECT COUNT(*) n FROM adverts WHERE platform_id = ?').get(id).n;
  if (n > 0) throw new Error(`This platform has ${n} advert(s). Untick Active to retire it instead.`);
  return db.prepare('DELETE FROM advert_platforms WHERE id = ?').run(id).changes > 0; // groups cascade
}

export function getGroup(id, db = getDb()) {
  return rowToGroup(db.prepare('SELECT * FROM advert_platform_groups WHERE id = ?').get(id));
}

export function saveGroup(data = {}, id = null, db = getDb()) {
  const existing = id ? db.prepare('SELECT * FROM advert_platform_groups WHERE id = ?').get(id) : null;
  if (id && !existing) return null;
  const platformId = existing ? existing.platform_id : data.platformId;
  if (!platformId || !db.prepare('SELECT id FROM advert_platforms WHERE id = ?').get(platformId)) throw new Error('Platform not found');
  const groupName = data.groupName !== undefined ? clean(data.groupName, 200) : existing?.group_name;
  if (!groupName) throw new Error('Group name is required');
  const clash = db.prepare('SELECT id FROM advert_platform_groups WHERE platform_id = ? AND lower(group_name) = lower(?) AND id != ?').get(platformId, groupName, id || '');
  if (clash) throw new Error(`This platform already has a group called "${groupName}"`);
  const row = {
    group_name: groupName,
    allowed_days: data.allowedDays !== undefined ? normalizeDays(data.allowedDays) : existing?.allowed_days ?? '',
    notes: data.notes !== undefined ? clean(data.notes) : existing?.notes ?? '',
    now: nowIso(),
  };
  if (existing) {
    db.prepare('UPDATE advert_platform_groups SET group_name=@group_name, allowed_days=@allowed_days, notes=@notes, updated_at=@now WHERE id=@id').run({ ...row, id });
    return getGroup(id, db);
  }
  const newId = randomUUID();
  db.prepare(
    `INSERT INTO advert_platform_groups (id, platform_id, group_name, allowed_days, notes, created_at, updated_at)
     VALUES (@id, @platform_id, @group_name, @allowed_days, @notes, @now, @now)`,
  ).run({ ...row, id: newId, platform_id: platformId });
  return getGroup(newId, db);
}

export function deleteGroup(id, db = getDb()) {
  const n = db.prepare('SELECT COUNT(*) n FROM adverts WHERE group_id = ?').get(id).n;
  if (n > 0) throw new Error(`This group has ${n} advert(s). Move or delete them first.`);
  return db.prepare('DELETE FROM advert_platform_groups WHERE id = ?').run(id).changes > 0;
}

// Lapanza3d's default list (seedAdvertPlatforms), used once when Procom has none.
export const DEFAULT_PLATFORMS = [
  ['Facebook', false],
  ['Facebook Groups', true],
  ['TikTok', false],
  ['Direct Email', false],
  ['Direct WhatsApp', false],
  ['Instagram', false],
  ['WhatsApp Groups', true],
];
const SEED_KEY = 'setup:advertPlatformsV1';

// Only while the table is empty and never seeded before, so a platform the
// owner deletes doesn't come back on the next restart.
export function seedDefaultPlatforms(db = getDb()) {
  if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(SEED_KEY)) return false;
  const now = nowIso();
  const run = db.transaction(() => {
    if (db.prepare('SELECT COUNT(*) n FROM advert_platforms').get().n === 0) {
      const insert = db.prepare(
        `INSERT INTO advert_platforms (id, name, has_groups, notes, active, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, '', 1, ?, ?, ?)`,
      );
      DEFAULT_PLATFORMS.forEach(([name, groups], i) => insert.run(randomUUID(), name, groups ? 1 : 0, i, now, now));
    }
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(SEED_KEY, JSON.stringify(now));
  });
  run();
  return true;
}

// ================================================================ adverts

// Weekday code of a YYYY-MM-DD date (calendar date, no timezone shift).
export function weekdayOf(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return WEEKDAYS[(new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7];
}

// Duration is inclusive of the start day (1 day = ends the same day).
export function endDateOf(publishDate, durationDays) {
  const [y, m, d] = publishDate.split('-').map(Number);
  const days = Math.max(1, Number(durationDays) || 1);
  return new Date(Date.UTC(y, m - 1, d + days - 1)).toISOString().slice(0, 10);
}

// '' when the date is fine, else a plain-language warning. A group with no
// allowed days set allows any day.
export function allowedDaysWarning({ groupId, publishDate }, db = getDb()) {
  if (!groupId || !publishDate || !isValidYmd(publishDate)) return '';
  const g = getGroup(groupId, db);
  if (!g || !g.allowedDays.length) return '';
  const day = weekdayOf(publishDate);
  if (g.allowedDays.includes(day)) return '';
  return `${g.groupName} only allows posts on ${g.allowedDays.join(', ')} — ${publishDate} is a ${day}.`;
}

function advertOut(r, db) {
  if (!r) return null;
  const platform = db.prepare('SELECT name, active FROM advert_platforms WHERE id = ?').get(r.platform_id);
  const group = r.group_id ? db.prepare('SELECT group_name FROM advert_platform_groups WHERE id = ?').get(r.group_id) : null;
  const product = r.product_id ? db.prepare('SELECT name, slug FROM products WHERE id = ?').get(r.product_id) : null;
  return {
    id: r.id,
    platformId: r.platform_id,
    platformName: platform?.name || 'Unknown platform',
    groupId: r.group_id,
    groupName: group?.group_name || '',
    productId: r.product_id,
    productName: product?.name || '',
    productSlug: product?.slug || '',
    imagePath: r.image_path,
    caption: r.caption,
    publishDate: r.publish_date,
    publishTime: r.publish_time,
    durationDays: r.duration_days,
    endDate: endDateOf(r.publish_date, r.duration_days),
    dayWarning: allowedDaysWarning({ groupId: r.group_id, publishDate: r.publish_date }, db),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// from/to (YYYY-MM-DD, optional) keep adverts whose run window overlaps the range.
export function listAdverts({ from = '', to = '' } = {}, db = getDb()) {
  return db
    .prepare('SELECT * FROM adverts ORDER BY publish_date, publish_time, created_at')
    .all()
    .map((r) => advertOut(r, db))
    .filter((a) => (!from || a.endDate >= from) && (!to || a.publishDate <= to));
}

export function getAdvert(id, db = getDb()) {
  return advertOut(db.prepare('SELECT * FROM adverts WHERE id = ?').get(id), db);
}

function advertFields(data, existing, db) {
  const pick = (key, col) => (data[key] !== undefined ? data[key] : existing ? existing[col] : undefined);
  const platformId = String(pick('platformId', 'platform_id') || '');
  if (!platformId) throw new Error('Choose a platform');
  const platform = db.prepare('SELECT id, has_groups FROM advert_platforms WHERE id = ?').get(platformId);
  if (!platform) throw new Error('Platform not found');
  let groupId = String(pick('groupId', 'group_id') || '');
  if (groupId) {
    const g = db.prepare('SELECT platform_id FROM advert_platform_groups WHERE id = ?').get(groupId);
    if (!g) throw new Error('Group not found');
    if (g.platform_id !== platformId) groupId = ''; // platform changed: the old group no longer applies
  }
  const publishDate = String(pick('publishDate', 'publish_date') || '');
  if (!isValidYmd(publishDate)) throw new Error('Choose a publish date');
  const publishTime = String(pick('publishTime', 'publish_time') || '');
  if (publishTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(publishTime)) throw new Error('Publish time must be HH:MM');
  const rawDuration = pick('durationDays', 'duration_days');
  const durationDays = rawDuration === undefined || rawDuration === '' ? 1 : Number(rawDuration);
  if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 365) throw new Error('Duration must be 1 to 365 days');
  const productId = String(pick('productId', 'product_id') || '');
  if (productId && !db.prepare('SELECT id FROM products WHERE id = ?').get(productId)) throw new Error('Linked product not found');
  return {
    platform_id: platformId,
    group_id: groupId,
    product_id: productId,
    caption: clean(pick('caption', 'caption'), 4000),
    publish_date: publishDate,
    publish_time: publishTime,
    duration_days: durationDays,
  };
}

export function saveAdvert(data = {}, id = null, db = getDb()) {
  const existing = id ? db.prepare('SELECT * FROM adverts WHERE id = ?').get(id) : null;
  if (id && !existing) return null;
  const f = advertFields(data, existing, db);
  const now = nowIso();
  if (existing) {
    db.prepare(
      `UPDATE adverts SET platform_id=@platform_id, group_id=@group_id, product_id=@product_id, caption=@caption,
        publish_date=@publish_date, publish_time=@publish_time, duration_days=@duration_days, updated_at=@now WHERE id=@id`,
    ).run({ ...f, now, id });
    return getAdvert(id, db);
  }
  const newId = randomUUID();
  db.prepare(
    `INSERT INTO adverts (id, platform_id, group_id, product_id, image_path, caption, publish_date, publish_time, duration_days, created_at, updated_at)
     VALUES (@id, @platform_id, @group_id, @product_id, '', @caption, @publish_date, @publish_time, @duration_days, @now, @now)`,
  ).run({ ...f, id: newId, now });
  return getAdvert(newId, db);
}

export function setAdvertImage(id, imagePath, db = getDb()) {
  const existing = db.prepare('SELECT image_path FROM adverts WHERE id = ?').get(id);
  if (!existing) return null;
  db.prepare('UPDATE adverts SET image_path = ?, updated_at = ? WHERE id = ?').run(imagePath || '', nowIso(), id);
  if (existing.image_path && existing.image_path !== imagePath) deleteUpload(existing.image_path);
  return getAdvert(id, db);
}

export function deleteAdvert(id, db = getDb()) {
  const existing = db.prepare('SELECT image_path FROM adverts WHERE id = ?').get(id);
  if (!existing) return false;
  db.prepare('DELETE FROM adverts WHERE id = ?').run(id);
  if (existing.image_path) deleteUpload(existing.image_path);
  return true;
}

// ================================================================ copy from Lapanza3d

export function lapanzaDbPath() {
  return process.env.LAPANZA_DB || '/opt/lapanza/app/data/lapanza.db';
}

// Reads Lapanza3d's platforms + groups. Read-only connection, always closed;
// throws a plain-language Error when the file is missing/unreadable or lacks
// the tables.
export function readLapanzaPlatforms(file = lapanzaDbPath()) {
  if (!fs.existsSync(file)) throw new Error(`Lapanza3d database not found at ${file}. Set LAPANZA_DB if it lives elsewhere.`);
  let src;
  try {
    src = new Database(file, { readonly: true, fileMustExist: true });
    const tables = new Set(src.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name));
    const missing = ['advert_platforms', 'advert_platform_groups'].filter((t) => !tables.has(t));
    if (missing.length) throw Object.assign(new Error(`The Lapanza3d database has no ${missing.join(' / ')} table, so there is nothing to copy.`), { friendly: true });
    const platforms = src.prepare('SELECT id, name, has_groups, notes, active, sort_order FROM advert_platforms ORDER BY sort_order, created_at').all();
    const groups = src.prepare('SELECT platform_id, group_name, allowed_days, notes FROM advert_platform_groups ORDER BY group_name').all();
    return platforms.map((p) => ({
      name: clean(p.name, 120),
      hasGroups: Boolean(p.has_groups),
      notes: clean(p.notes),
      active: Boolean(p.active),
      sortOrder: Number(p.sort_order) || 0,
      groups: groups
        .filter((g) => g.platform_id === p.id)
        .map((g) => ({ groupName: clean(g.group_name, 200), allowedDays: normalizeDays(g.allowed_days), notes: clean(g.notes) })),
    })).filter((p) => p.name);
  } catch (err) {
    if (err.friendly) throw new Error(err.message);
    throw new Error(`Could not read the Lapanza3d database at ${file}: ${err.message}`);
  } finally {
    try { src?.close(); } catch { /* already closed */ }
  }
}

const key = (s) => String(s || '').trim().toLowerCase();

// Compares Lapanza's platforms/groups with ours, matched by platform name and
// (within a platform) group name, case-insensitive. Nothing that exists only
// in Procom is touched.
export function planLapanzaCopy(source, db = getDb()) {
  const ours = listPlatforms({}, db);
  const byName = new Map(ours.map((p) => [key(p.name), p]));
  const seenPlatforms = new Set();
  const platforms = [];
  for (const sp of source) {
    const k = key(sp.name);
    if (seenPlatforms.has(k)) continue; // duplicate name in Lapanza: first wins
    seenPlatforms.add(k);
    const mine = byName.get(k);
    const changes = [];
    if (mine) {
      if (mine.name !== sp.name) changes.push('name');
      if (mine.hasGroups !== sp.hasGroups) changes.push('has groups');
      if (mine.notes !== sp.notes) changes.push('notes');
      if (mine.active !== sp.active) changes.push('active');
      if (mine.sortOrder !== sp.sortOrder) changes.push('order');
    }
    const myGroups = new Map((mine?.groups || []).map((g) => [key(g.groupName), g]));
    const seenGroups = new Set();
    const groups = [];
    for (const sg of sp.groups) {
      const gk = key(sg.groupName);
      if (!gk || seenGroups.has(gk)) continue;
      seenGroups.add(gk);
      const mg = myGroups.get(gk);
      const gChanges = [];
      if (mg) {
        if (mg.groupName !== sg.groupName) gChanges.push('name');
        if (mg.allowedDays.join(',') !== sg.allowedDays) gChanges.push('allowed days');
        if (mg.notes !== sg.notes) gChanges.push('notes');
      }
      groups.push({ ...sg, allowedDays: sg.allowedDays ? sg.allowedDays.split(',') : [], id: mg?.id || null, action: !mg ? 'add' : gChanges.length ? 'update' : 'same', changes: gChanges });
    }
    platforms.push({
      ...sp,
      groups,
      id: mine?.id || null,
      action: !mine ? 'add' : changes.length ? 'update' : 'same',
      changes,
    });
  }
  const count = (list, a) => list.filter((x) => x.action === a).length;
  const allGroups = platforms.flatMap((p) => p.groups);
  const procomOnly = ours.filter((p) => !seenPlatforms.has(key(p.name))).map((p) => p.name);
  return {
    platforms,
    procomOnly,
    summary: {
      platformsAdded: count(platforms, 'add'),
      platformsUpdated: count(platforms, 'update'),
      platformsSame: count(platforms, 'same'),
      groupsAdded: count(allGroups, 'add'),
      groupsUpdated: count(allGroups, 'update'),
      groupsSame: count(allGroups, 'same'),
    },
  };
}

export function previewLapanzaCopy({ file = lapanzaDbPath() } = {}, db = getDb()) {
  return { file, ...planLapanzaCopy(readLapanzaPlatforms(file), db) };
}

export function applyLapanzaCopy({ file = lapanzaDbPath() } = {}, db = getDb()) {
  const source = readLapanzaPlatforms(file);
  let plan;
  const run = db.transaction(() => {
    plan = planLapanzaCopy(source, db);
    const now = nowIso();
    for (const p of plan.platforms) {
      let platformId = p.id;
      const row = { name: p.name, has_groups: p.hasGroups ? 1 : 0, notes: p.notes, active: p.active ? 1 : 0, sort_order: p.sortOrder, now };
      if (p.action === 'add') {
        platformId = randomUUID();
        db.prepare(
          `INSERT INTO advert_platforms (id, name, has_groups, notes, active, sort_order, created_at, updated_at)
           VALUES (@id, @name, @has_groups, @notes, @active, @sort_order, @now, @now)`,
        ).run({ ...row, id: platformId });
      } else if (p.action === 'update') {
        db.prepare('UPDATE advert_platforms SET name=@name, has_groups=@has_groups, notes=@notes, active=@active, sort_order=@sort_order, updated_at=@now WHERE id=@id').run({ ...row, id: platformId });
      }
      for (const g of p.groups) {
        const grow = { group_name: g.groupName, allowed_days: g.allowedDays.join(','), notes: g.notes, now };
        if (g.action === 'add') {
          db.prepare(
            `INSERT INTO advert_platform_groups (id, platform_id, group_name, allowed_days, notes, created_at, updated_at)
             VALUES (@id, @platform_id, @group_name, @allowed_days, @notes, @now, @now)`,
          ).run({ ...grow, id: randomUUID(), platform_id: platformId });
        } else if (g.action === 'update') {
          db.prepare('UPDATE advert_platform_groups SET group_name=@group_name, allowed_days=@allowed_days, notes=@notes, updated_at=@now WHERE id=@id').run({ ...grow, id: g.id });
        }
      }
    }
    // Seeding is pointless once the owner has copied a list in.
    db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(SEED_KEY, JSON.stringify(now));
  });
  run();
  return { file, summary: plan.summary };
}

// ================================================================ routes

export function register({ admin, wrap, siteUrl = '' }) {
  try {
    seedDefaultPlatforms();
  } catch (err) {
    console.error('Advert platform seed failed:', err.message);
  }

  const orNotFound = (what) => (v) => {
    if (v == null || v === false) throw notFound(what);
    return v;
  };
  const lead404 = orNotFound('Contact');
  const platform404 = orNotFound('Platform');
  const group404 = orNotFound('Group');
  const advert404 = orNotFound('Advert');

  admin.get('/marketing/meta', wrap(() => ({
    siteUrl: siteUrl.replace(/\/$/, ''),
    leadTypes: LEAD_TYPES,
    leadStatuses: LEAD_STATUSES.map((s) => ({ value: s, label: LEAD_STATUS_LABELS[s] })),
    weekdays: WEEKDAYS,
    lapanzaDb: lapanzaDbPath(),
  })));

  // Potential market
  admin.get('/marketing/leads', wrap((req) => listLeads(req.query)));
  admin.post('/marketing/leads', wrap((req) => saveLead(req.body || {})));
  admin.post('/marketing/leads/import', wrap((req) => importLeadsCsv(req.body || {})));
  admin.put('/marketing/leads/:id', wrap((req) => lead404(saveLead(req.body || {}, req.params.id))));
  admin.delete('/marketing/leads/:id', wrap((req) => ({ ok: lead404(deleteLead(req.params.id)) })));

  // Platform rules
  admin.get('/marketing/platforms', wrap(() => listPlatforms()));
  admin.post('/marketing/platforms', wrap((req) => savePlatform(req.body || {})));
  admin.put('/marketing/platforms/:id', wrap((req) => platform404(savePlatform(req.body || {}, req.params.id))));
  admin.delete('/marketing/platforms/:id', wrap((req) => ({ ok: platform404(deletePlatform(req.params.id)) })));
  admin.post('/marketing/platforms/:id/groups', wrap((req) => saveGroup({ ...(req.body || {}), platformId: req.params.id })));
  admin.put('/marketing/groups/:id', wrap((req) => group404(saveGroup(req.body || {}, req.params.id))));
  admin.delete('/marketing/groups/:id', wrap((req) => ({ ok: group404(deleteGroup(req.params.id)) })));
  // A missing/unreadable Lapanza file is an expected answer, not a failed
  // request: the preview reports it as { ok: false, error } for the page to show.
  admin.get('/marketing/lapanza-copy', wrap(() => {
    try {
      return { ok: true, ...previewLapanzaCopy() };
    } catch (err) {
      return { ok: false, file: lapanzaDbPath(), error: err.message };
    }
  }));
  admin.post('/marketing/lapanza-copy', wrap(() => applyLapanzaCopy()));

  // Adverts
  admin.get('/marketing/adverts', wrap((req) => listAdverts({ from: String(req.query.from || ''), to: String(req.query.to || '') })));
  admin.post('/marketing/adverts/check', wrap((req) => ({ warning: allowedDaysWarning(req.body || {}) })));
  admin.post('/marketing/adverts', wrap((req) => saveAdvert(req.body || {})));
  admin.put('/marketing/adverts/:id', wrap((req) => advert404(saveAdvert(req.body || {}, req.params.id))));
  admin.delete('/marketing/adverts/:id', wrap((req) => ({ ok: advert404(deleteAdvert(req.params.id)) })));

  const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } });
  admin.post('/marketing/adverts/:id/image', imageUpload.single('image'), wrap(async (req) => {
    advert404(getAdvert(req.params.id));
    const f = req.file;
    if (!f) throw new Error('No image received');
    if (!isAllowedImage(f.mimetype)) throw new Error('Only JPG, PNG, WebP, GIF or AVIF images');
    const stored = await storeProductImage(f.buffer, 'adverts');
    return setAdvertImage(req.params.id, stored);
  }));
  admin.delete('/marketing/adverts/:id/image', wrap((req) => advert404(setAdvertImage(req.params.id, ''))));
}
