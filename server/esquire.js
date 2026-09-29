import { getDb } from './db.js';
import { getSettings } from './settings.js';
import { importFile } from './feed.js';
import { autoList, classifyItem } from './smd-autolist.js';
import { ESQUIRE_LIST } from './esquire-rules.js';
import { sendEsquireReport } from './mailer.js';

// Esquire's live product API, pulled on a schedule (3x a day) instead of an
// uploaded pricelist. Each run: fetch -> import as a complete list -> auto-list
// new items (when switched on) -> email the owner a status report.
//
// Credentials live only in the server's .env (ESQUIRE_USER / ESQUIRE_PASS):
// the API takes them in the query string and this repo is public.
//
// Feed facts (checked 2026-09-29): prices INCLUDE 15% VAT (every price / 1.15
// is an exact 4-decimal number); `m` is Esquire's own markup % (kept at 0 --
// ours is applied by pricing.js); `availableQty` is always "yes", so stock is
// simply "in the feed with status 1".

export const ESQUIRE_FILE = ESQUIRE_LIST.sourceFile;
const API_URL = 'https://api.esquire.co.za/api/DataFeed';
const TIMEOUT_MS = 120_000;
// A feed with far fewer products than last time is treated as a glitch, not
// as thousands of products going out of stock at once.
const MIN_SHARE_OF_PREVIOUS = 0.5;

export const esquireConfigured = () => Boolean(process.env.ESQUIRE_USER && process.env.ESQUIRE_PASS);

export function findEsquireSupplier(db = getDb()) {
  return db.prepare("SELECT id, name FROM suppliers WHERE name LIKE '%esquire%' ORDER BY created_at LIMIT 1").get() || null;
}

export async function fetchEsquireRecords({ fetchImpl = fetch } = {}) {
  if (!esquireConfigured()) throw new Error('Esquire login is not set on the server (ESQUIRE_USER / ESQUIRE_PASS in .env)');
  const url = new URL(API_URL);
  url.search = new URLSearchParams({
    u: process.env.ESQUIRE_USER,
    p: process.env.ESQUIRE_PASS,
    t: 'json',
    m: '0',
    o: 'ascending',
    r: 'RoundNearest',
    rm: '1',
    min: '0',
  }).toString();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
  } catch (err) {
    // Never echo the URL: it carries the password.
    throw new Error(`Could not reach Esquire (${err.name === 'AbortError' ? 'timed out' : err.message})`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`Esquire answered HTTP ${res.status}`);
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error('Esquire sent something that is not JSON (login wrong?)');
  }
  if (!Array.isArray(data)) throw new Error('Esquire feed is not a product list (login wrong?)');
  return data;
}

// Rows we can sell: active, with a code and a price.
export function sellableRecords(records) {
  return records.filter((r) => r && Number(r.status) === 1 && String(r.productCode ?? '').trim() && Number(r.price) > 0);
}

// Groups the owner agreed never to sell (old phone covers, candles,
// stationery...) are left out of the import altogether: no clutter in the
// Warehouse feed, no photo downloads. "Optional:" groups are still imported
// so they can be listed by hand. -> { keep, leftOut: Map(reason -> count) }
export function withoutAgreedSkips(records) {
  const leftOut = new Map();
  const keep = records.filter((r) => {
    const c = classifyItem('esquire', { name: String(r.productName ?? ''), category: String(r.category ?? '').trim() });
    if (!c?.skip || c.skip.startsWith('Optional')) return true;
    leftOut.set(c.skip, (leftOut.get(c.skip) || 0) + 1);
    return false;
  });
  return { keep, leftOut };
}

let running = null;

// One run end to end. Never throws: failures are reported (and emailed).
// `records` lets tests (and a manual re-run of a saved feed) skip the fetch.
export function syncEsquire({ trigger = 'manual', records = null, email = true, fetchImpl } = {}, db = getDb()) {
  if (running) return running;
  running = (async () => {
    const started = new Date();
    const report = { trigger, startedAt: started.toISOString(), ok: false, error: '', autoListOn: Boolean(getSettings(db).esquireAutoList) };
    try {
      const supplier = findEsquireSupplier(db);
      if (!supplier) throw new Error('No supplier named "Esquire" in Admin -> Suppliers');
      const all = records || (await fetchEsquireRecords({ fetchImpl }));
      const { keep: sellable, leftOut } = withoutAgreedSkips(sellableRecords(all));
      report.feedRows = all.length;
      report.sellableRows = sellable.length;
      report.leftOut = [...leftOut].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n);

      const previous = db.prepare('SELECT COUNT(*) n FROM feed_items WHERE supplier_id = ? AND source_file = ? AND in_latest_import = 1').get(supplier.id, ESQUIRE_FILE).n;
      if (previous && sellable.length < previous * MIN_SHARE_OF_PREVIOUS) {
        throw new Error(`Feed has only ${sellable.length} products (last run ${previous}) -- skipped this run so nothing is marked out of stock by mistake`);
      }

      report.import = await importFile(
        { supplierId: supplier.id, fileName: ESQUIRE_FILE, buffer: Buffer.from(JSON.stringify(sellable)), pricesIncludeVat: true, completeList: true, restoreStock: true },
        db,
      );
      // Switched off until the owner approves the category table: the report
      // then shows what *would* be listed.
      report.autoList = autoList({ list: 'esquire', supplierId: supplier.id, dryRun: !report.autoListOn }, db);
      report.ok = true;
    } catch (err) {
      report.error = err.message;
      console.error(`Esquire sync failed: ${err.message}`);
    }
    report.seconds = Math.round((Date.now() - started) / 1000);
    saveLastRun(db, report);
    if (email) await sendEsquireReport(report);
    return report;
  })().finally(() => {
    running = null;
  });
  return running;
}

// Kept for the admin screen; small summary only.
function saveLastRun(db, report) {
  const al = report.autoList;
  const summary = {
    at: report.startedAt,
    trigger: report.trigger,
    ok: report.ok,
    error: report.error,
    seconds: report.seconds,
    sellableRows: report.sellableRows ?? null,
    import: report.import ? { rowsNew: report.import.rowsNew, priceChanges: report.import.priceChanges, productsMarkedOut: report.import.productsMarkedOut, productsBackInStock: report.import.productsBackInStock } : null,
    listed: al ? (report.autoListOn ? al.created : 0) : 0,
    wouldList: al && !report.autoListOn ? al.summary.reduce((n, g) => n + g.newListings, 0) : 0,
  };
  db.prepare("INSERT INTO settings (key, value) VALUES ('esquireLastRun', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(summary));
}

export function esquireStatus(db = getDb()) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'esquireLastRun'").get();
  return {
    configured: esquireConfigured(),
    supplier: findEsquireSupplier(db),
    autoList: Boolean(getSettings(db).esquireAutoList),
    runHoursSast: syncHours(),
    running: Boolean(running),
    lastRun: row ? JSON.parse(row.value) : null,
  };
}

// ------------------------------------------------------------------ schedule

const SAST_OFFSET_H = 2; // South Africa has no daylight saving

export function syncHours() {
  const hours = String(process.env.ESQUIRE_SYNC_HOURS || '6,12,18')
    .split(',')
    .map((h) => Number(h.trim()))
    .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23);
  return [...new Set(hours)].sort((a, b) => a - b);
}

// Next run time after `now` for the given SAST hours.
export function nextRunAt(now = new Date(), hours = syncHours()) {
  const candidates = [];
  for (let day = 0; day <= 2; day++) {
    for (const h of hours) {
      const t = new Date(now);
      t.setUTCDate(t.getUTCDate() + day);
      t.setUTCHours(h - SAST_OFFSET_H, 0, 0, 0); // negative hours roll back a day
      if (t > now) candidates.push(t);
    }
  }
  return candidates.length ? new Date(Math.min(...candidates)) : null;
}

export function startEsquireSchedule() {
  if (!esquireConfigured() || process.env.DISABLE_ESQUIRE_SYNC === '1') return;
  const plan = () => {
    const at = nextRunAt();
    if (!at) return;
    setTimeout(() => {
      syncEsquire({ trigger: 'scheduled' }).finally(plan);
    }, at - Date.now()).unref();
  };
  plan();
  console.log(`Esquire sync scheduled at ${syncHours().map((h) => `${String(h).padStart(2, '0')}:00`).join(', ')} SAST`);
}
