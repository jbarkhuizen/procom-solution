import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

process.env.UPLOADS_DIR = path.join(os.tmpdir(), 'procom-test-uploads');
process.env.DISABLE_BACKUPS = '1';

const { useMemoryDb } = await import('../db.js');
const catalog = await import('../catalog.js');
const m = await import('./marketing.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'procom-mkt-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let db;
beforeEach(() => {
  db = useMemoryDb();
});

// A file shaped like Lapanza3d's live DB (same CREATE TABLEs as its db.js).
function fakeLapanza(name, { platforms = [], groups = [], withTables = true } = {}) {
  const file = path.join(tmp, name);
  fs.rmSync(file, { force: true });
  const src = new Database(file);
  if (withTables) {
    src.prepare(`CREATE TABLE advert_platforms (id TEXT PRIMARY KEY, name TEXT NOT NULL, has_groups INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`).run();
    src.prepare(`CREATE TABLE advert_platform_groups (id TEXT PRIMARY KEY, platform_id TEXT NOT NULL REFERENCES advert_platforms(id) ON DELETE CASCADE,
      group_name TEXT NOT NULL, allowed_days TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`).run();
    src.prepare(`CREATE TABLE adverts (id TEXT PRIMARY KEY, platform_id TEXT NOT NULL, image_path TEXT NOT NULL DEFAULT '', caption TEXT NOT NULL DEFAULT '',
      publish_date TEXT NOT NULL, publish_time TEXT NOT NULL DEFAULT '', duration_days INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`).run();
    const t = '2026-09-01T00:00:00.000Z';
    platforms.forEach(([id, pname, hasGroups, notes = '', active = 1], i) =>
      src.prepare('INSERT INTO advert_platforms VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, pname, hasGroups ? 1 : 0, notes, active, i, t, t));
    groups.forEach(([pid, gname, days, notes = ''], i) =>
      src.prepare('INSERT INTO advert_platform_groups VALUES (?, ?, ?, ?, ?, ?, ?)').run(`g${i}`, pid, gname, days, notes, t, t));
    src.prepare("INSERT INTO adverts (id, platform_id, caption, publish_date, created_at, updated_at) VALUES ('a1', 'fb', 'Lapanza advert', '2026-09-01', ?, ?)").run(t, t);
  } else {
    src.prepare('CREATE TABLE something_else (id TEXT)').run();
  }
  src.close();
  return file;
}

const lapanzaData = {
  platforms: [
    ['fb', 'Facebook', false, 'Post at 18:00'],
    ['fbg', 'Facebook Groups', true, 'Read each group rules'],
    ['tt', 'TikTok', false, '', 0],
    ['li', 'LinkedIn', false, 'Business tone'],
  ],
  groups: [
    ['fbg', 'Pretoria Buy & Sell', 'Mon,Thu', 'No links'],
    ['fbg', 'Centurion Classifieds', 'Sat', ''],
  ],
};

test('seeds Lapanza3d\'s default platforms once, never again after deletes', () => {
  assert.equal(m.seedDefaultPlatforms(db), true);
  const names = m.listPlatforms({}, db).map((p) => p.name);
  assert.deepEqual(names, m.DEFAULT_PLATFORMS.map(([n]) => n));
  assert.ok(m.listPlatforms({}, db).find((p) => p.name === 'WhatsApp Groups').hasGroups);
  for (const p of m.listPlatforms({}, db)) m.deletePlatform(p.id, db);
  assert.equal(m.seedDefaultPlatforms(db), false);
  assert.equal(m.listPlatforms({}, db).length, 0);
});

test('leads: validation, filters, CSV import with source + dedupe', () => {
  assert.throws(() => m.saveLead({ email: 'x@y.co' }, null, db), /name or a company/);
  assert.throws(() => m.saveLead({ name: 'A', email: 'nope' }, null, db), /valid email/);
  assert.throws(() => m.saveLead({ name: 'A', status: 'maybe' }, null, db), /Status must be/);
  const a = m.saveLead({ name: 'Thandi M', company: 'Sunnyside Primary', email: 'Thandi@School.co.za', type: 'School', status: 'Contacted', source: 'School fair 2026', lastContactedAt: '2026-09-20' }, null, db);
  assert.equal(a.email, 'thandi@school.co.za');
  assert.equal(a.type, 'school');
  assert.equal(a.status, 'contacted');
  const upd = m.saveLead({ status: 'not interested' }, a.id, db);
  assert.equal(upd.status, 'not_interested');
  assert.equal(upd.company, 'Sunnyside Primary');

  const csv = [
    'Name,Company,Email,Mobile,Type,Status,Notes',
    'Piet,PC Traders,piet@pctraders.co.za,0821112222,Reseller,Interested,Wants price list',
    'Dup,,THANDI@school.co.za,,,,', // duplicate of existing email
    ',,,,,,', // blank row -> ignored
    ',,no-name@x.co,,,,', // no name or company
    'Mia,Acme,bad-email,,,,',
    'Piet again,PC Traders,piet@pctraders.co.za,,,,', // duplicate within the file
  ].join('\n');
  assert.throws(() => m.importLeadsCsv({ csv: 'Foo,Bar\n1,2' }, db), /No Name or Company column/);
  const noSource = m.importLeadsCsv({ csv }, db);
  assert.equal(noSource.created, 0);
  assert.ok(noSource.skippedRows.some((r) => /No source/.test(r.reason)));
  const r = m.importLeadsCsv({ csv, source: 'Reseller list from SMD' }, db);
  assert.equal(r.created, 1);
  assert.deepEqual(r.skippedRows.map((s) => s.reason), ['Duplicate', 'No name or company', '"bad-email" is not a valid email address', 'Duplicate']);
  const piet = m.listLeads({ q: 'pctraders' }, db).items[0];
  assert.equal(piet.type, 'reseller');
  assert.equal(piet.status, 'interested');
  assert.equal(piet.source, 'Reseller list from SMD');
  assert.equal(piet.phone, '0821112222');
  assert.equal(m.listLeads({ status: 'interested' }, db).items.length, 1);
  assert.equal(m.listLeads({ type: 'school' }, db).items.length, 1);
  assert.equal(m.listLeads({}, db).counts.not_interested, 1);
});

test('groups: allowed days normalised; adverts warn on a disallowed day', () => {
  const p = m.savePlatform({ name: 'Facebook Groups', hasGroups: true }, null, db);
  assert.throws(() => m.savePlatform({ name: 'facebook groups' }, null, db), /already a platform/);
  const g = m.saveGroup({ platformId: p.id, groupName: 'Pretoria Buy & Sell', allowedDays: ['thu', 'Mon', 'Funday'] }, null, db);
  assert.deepEqual(g.allowedDays, ['Mon', 'Thu']);
  assert.throws(() => m.saveGroup({ platformId: p.id, groupName: 'pretoria buy & sell' }, null, db), /already has a group/);

  assert.equal(m.weekdayOf('2026-10-01'), 'Thu');
  assert.equal(m.allowedDaysWarning({ groupId: g.id, publishDate: '2026-10-01' }, db), '');
  assert.match(m.allowedDaysWarning({ groupId: g.id, publishDate: '2026-10-03' }, db), /only allows posts on Mon, Thu — 2026-10-03 is a Sat/);

  const ad = m.saveAdvert({ platformId: p.id, groupId: g.id, caption: 'Specials this week', publishDate: '2026-10-03', publishTime: '18:30', durationDays: 3 }, null, db);
  assert.equal(ad.endDate, '2026-10-05');
  assert.equal(ad.groupName, 'Pretoria Buy & Sell');
  assert.match(ad.dayWarning, /Sat/);
  assert.equal(m.saveAdvert({ publishDate: '2026-10-05' }, ad.id, db).dayWarning, ''); // Monday

  // Any day allowed when a group has none set.
  const open = m.saveGroup({ platformId: p.id, groupName: 'Open group' }, null, db);
  assert.equal(m.allowedDaysWarning({ groupId: open.id, publishDate: '2026-10-04' }, db), '');

  assert.throws(() => m.saveAdvert({ platformId: p.id, publishDate: '2026-02-30' }, null, db), /publish date/);
  assert.throws(() => m.saveAdvert({ platformId: p.id, publishDate: '2026-10-01', publishTime: '25:00' }, null, db), /HH:MM/);
  assert.throws(() => m.saveAdvert({ platformId: p.id, publishDate: '2026-10-01', durationDays: 0 }, null, db), /Duration/);
  assert.throws(() => m.deletePlatform(p.id, db), /Untick Active/);
  assert.throws(() => m.deleteGroup(g.id, db), /advert/);

  // Window filter keeps adverts overlapping the range.
  assert.equal(m.listAdverts({ from: '2026-10-05', to: '2026-10-10' }, db).length, 1);
  assert.equal(m.listAdverts({ from: '2026-10-08' }, db).length, 0); // runs 5-7 Oct after the move
});

test('advert links a product', () => {
  const cat = db.prepare("SELECT id FROM categories WHERE slug = 'keyboards-mice'").get().id;
  const prod = catalog.saveProduct({ name: 'Test Mouse', costCents: 10000, categoryId: cat });
  const p = m.savePlatform({ name: 'Instagram' }, null, db);
  const ad = m.saveAdvert({ platformId: p.id, productId: prod.id, publishDate: '2026-10-01' }, null, db);
  assert.equal(ad.productName, 'Test Mouse');
  assert.equal(ad.productSlug, prod.slug);
  assert.throws(() => m.saveAdvert({ platformId: p.id, productId: 'nope', publishDate: '2026-10-01' }, null, db), /product not found/);
});

test('Lapanza copy: preview, apply, idempotent, keeps Procom-only entries, read-only source', () => {
  const file = fakeLapanza('lapanza.db', lapanzaData);
  const before = fs.readFileSync(file);
  // Procom already has Facebook (different notes), a Procom-only platform, and
  // one Lapanza group with other days.
  const fb = m.savePlatform({ name: 'facebook', notes: 'old' }, null, db);
  const fbg = m.savePlatform({ name: 'Facebook Groups', hasGroups: true }, null, db);
  m.saveGroup({ platformId: fbg.id, groupName: 'Pretoria buy & sell', allowedDays: ['Fri'] }, null, db);
  const own = m.saveGroup({ platformId: fbg.id, groupName: 'Procom own group', allowedDays: ['Tue'] }, null, db);
  const only = m.savePlatform({ name: 'Procom Flyers', notes: 'ours' }, null, db);
  m.saveAdvert({ platformId: fb.id, publishDate: '2026-10-01', caption: 'ours' }, null, db);

  const prev = m.previewLapanzaCopy({ file }, db);
  assert.deepEqual(prev.summary, { platformsAdded: 2, platformsUpdated: 2, platformsSame: 0, groupsAdded: 1, groupsUpdated: 1, groupsSame: 0 });
  assert.deepEqual(prev.procomOnly, ['Procom Flyers']);
  const pfb = prev.platforms.find((p) => p.name === 'Facebook');
  assert.equal(pfb.action, 'update');
  assert.deepEqual(pfb.changes, ['name', 'notes']);
  // Preview writes nothing.
  assert.equal(m.listPlatforms({}, db).length, 3);

  const res = m.applyLapanzaCopy({ file }, db);
  assert.deepEqual(res.summary, prev.summary);
  const after = m.listPlatforms({}, db);
  const byName = Object.fromEntries(after.map((p) => [p.name, p]));
  assert.deepEqual(Object.keys(byName).sort(), ['Facebook', 'Facebook Groups', 'LinkedIn', 'Procom Flyers', 'TikTok']);
  assert.equal(byName.Facebook.id, fb.id); // matched, not duplicated
  assert.equal(byName.Facebook.notes, 'Post at 18:00');
  assert.equal(byName.TikTok.active, false);
  assert.equal(byName['Procom Flyers'].notes, 'ours');
  assert.equal(byName['Procom Flyers'].id, only.id);
  const groups = Object.fromEntries(byName['Facebook Groups'].groups.map((g) => [g.groupName, g]));
  assert.deepEqual(groups['Pretoria Buy & Sell'].allowedDays, ['Mon', 'Thu']);
  assert.equal(groups['Pretoria Buy & Sell'].notes, 'No links');
  assert.deepEqual(groups['Centurion Classifieds'].allowedDays, ['Sat']);
  assert.equal(groups['Procom own group'].id, own.id);
  // Adverts are never copied.
  assert.equal(m.listAdverts({}, db).length, 1);
  assert.equal(m.listAdverts({}, db)[0].caption, 'ours');

  // Second run: nothing to do, nothing duplicated.
  const again = m.previewLapanzaCopy({ file }, db);
  assert.deepEqual(again.summary, { platformsAdded: 0, platformsUpdated: 0, platformsSame: 4, groupsAdded: 0, groupsUpdated: 0, groupsSame: 2 });
  m.applyLapanzaCopy({ file }, db);
  assert.equal(m.listPlatforms({}, db).length, 5);
  assert.equal(m.listPlatforms({}, db).find((p) => p.name === 'Facebook Groups').groups.length, 3);

  // Source file untouched (opened read-only).
  assert.ok(fs.readFileSync(file).equals(before));
  // A copy means the defaults are never seeded on top.
  assert.equal(m.seedDefaultPlatforms(db), false);
});

test('Lapanza copy: missing file, not a database, missing tables', () => {
  assert.throws(() => m.previewLapanzaCopy({ file: path.join(tmp, 'nope.db') }, db), /Lapanza3d database not found at .*nope\.db/);
  const junk = path.join(tmp, 'junk.db');
  fs.writeFileSync(junk, 'this is not sqlite at all, just text '.repeat(50));
  assert.throws(() => m.previewLapanzaCopy({ file: junk }, db), /Could not read the Lapanza3d database/);
  const empty = fakeLapanza('empty.db', { withTables: false });
  assert.throws(() => m.applyLapanzaCopy({ file: empty }, db), /no advert_platforms \/ advert_platform_groups table/);
  assert.equal(m.listPlatforms({}, db).length, 0);
});

test('LAPANZA_DB env var picks the source file', () => {
  const file = fakeLapanza('env.db', lapanzaData);
  const old = process.env.LAPANZA_DB;
  process.env.LAPANZA_DB = file;
  try {
    assert.equal(m.lapanzaDbPath(), file);
    assert.equal(m.previewLapanzaCopy({}, db).summary.platformsAdded, 4);
  } finally {
    if (old === undefined) delete process.env.LAPANZA_DB;
    else process.env.LAPANZA_DB = old;
  }
  assert.equal(m.lapanzaDbPath(), '/opt/lapanza/app/data/lapanza.db');
});
