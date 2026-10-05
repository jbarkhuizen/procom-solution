import { randomUUID, createHash } from 'crypto';
import sharp from 'sharp';
import { getDb } from './db.js';
import { getSettings } from './settings.js';
import { repriceProducts, retailForCost } from './catalog.js';
import { parseMinOrderQty } from './feed.js';
import { autoList } from './smd-autolist.js';
import { parseRandToCents, parseJsonArray } from './util.js';
import { decryptSecret } from './vault.js';
import { fetchImage } from './remote-images.js';
import { storeProductImage, deleteUpload, resolveUpload } from './images.js';
import { sendSmdReport } from './mailer.js';
import { snapshotPrices, diffPrices } from './sync-report.js';
import { nextRunAt } from './esquire.js';

// SMD's live API (https://api.smdtechnologies.com/v1/, spec: "SMD API INFO"
// PDF, 2026-09-29). Four paged endpoints -- products, media, prices, stock --
// each { data: [...], numberOfPages } (prices says "numberOfPage"). Auth:
// "Authorization: Bearer <token>" + "ClientAccessKey: <key>", saved encrypted
// on the SMD supplier (Admin -> Suppliers). Login problems answer 401 (the
// spec says 404; both are treated the same).
//
// A run updates the SMD products already in the shop (never their category):
//   cost        PriceExcl, or SpecialPriceExcl while SMD runs a special; the
//               shop price follows, and the normal price shows struck through
//   stock       SOH: out of stock at 0 (or below the pack size), back when
//               restocked -- an admin's own "out of stock" is never undone
//   text        SMD's descriptions fill blank descriptions only
//   photos      full-size photos replace SMD's tiny spreadsheet thumbnails;
//               photos an admin uploaded or changed are never touched
// SKUs the shop doesn't sell yet appear in Warehouse feed (supplier file
// "smd-api.json") for listing by hand. RRP is ignored on purpose: a struck-out
// "was" price must be one we actually charged (Consumer Protection Act).
// Monthly pricelist uploads keep working (pack sizes still come from them).

export const SMD_API_FILE = 'smd-api.json';
const API_BASE = 'https://api.smdtechnologies.com/v1/';
const ENDPOINTS = ['products', 'prices', 'stock', 'media'];
const TIMEOUT_MS = 60_000;
const MAX_PAGES = 400;
const PAGE_CONCURRENCY = 3;
const MAX_PHOTOS = 4;
const THUMB_MAX_PX = 300; // SMD's spreadsheet photos are ~113 px
const MIN_SHARE_OF_PREVIOUS = 0.5;

export const NO_ACCESS = 'SMD API access not set: enter the API token and Client access key in Admin → Suppliers → SMD';

export function findSmdSupplier(db = getDb()) {
  return db.prepare("SELECT * FROM suppliers WHERE name LIKE 'SMD%' ORDER BY created_at LIMIT 1").get() || null;
}

// -> { token, key } or null. .env (SMD_API_TOKEN / SMD_API_KEY) wins when set.
export function smdAccess(db = getDb()) {
  if (process.env.SMD_API_TOKEN && process.env.SMD_API_KEY) return { token: process.env.SMD_API_TOKEN, key: process.env.SMD_API_KEY };
  const s = findSmdSupplier(db);
  if (!s?.api_token_enc || !s.api_key_enc) return null;
  return { token: decryptSecret(s.api_token_enc), key: decryptSecret(s.api_key_enc) };
}

export function smdConfigured(db = getDb()) {
  if (process.env.SMD_API_TOKEN && process.env.SMD_API_KEY) return true;
  const s = findSmdSupplier(db);
  return Boolean(s?.api_token_enc && s.api_key_enc);
}

// ------------------------------------------------------------------ fetching

async function getPage(endpoint, page, access, fetchImpl) {
  const url = new URL(endpoint, API_BASE);
  url.searchParams.set('page', String(page));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(url, { signal: ctrl.signal, headers: { Authorization: `Bearer ${access.token}`, ClientAccessKey: access.key, Accept: 'application/json' } });
  } catch (err) {
    throw new Error(`Could not reach SMD (${err.name === 'AbortError' ? 'timed out' : err.message})`);
  } finally {
    clearTimeout(timer);
  }
  if ([401, 403, 404].includes(res.status)) throw new Error(`SMD answered ${res.status} on ${endpoint} -- check the API token and Client access key in Admin → Suppliers → SMD`);
  if (!res.ok) throw new Error(`SMD answered HTTP ${res.status} on ${endpoint}`);
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`SMD ${endpoint} page ${page} is not JSON`);
  }
  if (!body || !Array.isArray(body.data)) throw new Error(`SMD ${endpoint} page ${page} has no data list`);
  return { data: body.data, pages: Number(body.numberOfPages ?? body.numberOfPage) || 1 };
}

async function getAll(endpoint, access, fetchImpl) {
  const first = await getPage(endpoint, 1, access, fetchImpl);
  const pages = Math.min(first.pages, MAX_PAGES);
  const rows = [...first.data];
  const todo = Array.from({ length: pages - 1 }, (_, i) => i + 2);
  const results = new Map();
  const worker = async () => {
    for (let p = todo.shift(); p; p = todo.shift()) results.set(p, (await getPage(endpoint, p, access, fetchImpl)).data);
  };
  await Promise.all(Array.from({ length: PAGE_CONCURRENCY }, worker));
  for (let p = 2; p <= pages; p++) rows.push(...(results.get(p) || []));
  return { rows, pages };
}

const skuOf = (r) => String(r?.Sku ?? r?.ProductCode ?? '').trim();

// Raw endpoint rows -> Maps keyed by SKU.
export function normaliseSmd({ products = [], prices = [], stock = [], media = [] }) {
  const out = { products: new Map(), prices: new Map(), stock: new Map(), media: new Map() };
  for (const r of products) {
    const sku = skuOf(r);
    if (!sku) continue;
    out.products.set(sku, {
      name: String(r.Name ?? '').trim(),
      short: String(r.ShortDescription ?? '').trim(),
      long: String(r.LongDescription ?? '').replace(/\s+/g, ' ').trim(),
      category: String(r.Category ?? '').trim(),
      brand: String(r.Brand ?? '').trim(),
    });
  }
  for (const r of prices) {
    const sku = skuOf(r);
    const cost = parseRandToCents(String(r.PriceExcl ?? ''));
    if (!sku || cost == null || cost <= 0) continue;
    const special = parseRandToCents(String(r.SpecialPriceExcl ?? ''));
    out.prices.set(sku, { costCents: cost, specialCents: special && special > 0 && special < cost ? special : null });
  }
  for (const r of stock) {
    const sku = skuOf(r);
    const soh = Number(r.SOH);
    if (sku && Number.isFinite(soh)) out.stock.set(sku, Math.max(0, Math.floor(soh)));
  }
  const byOrder = new Map();
  for (const r of media) {
    const sku = skuOf(r);
    const url = String(r.Url ?? '').trim();
    if (!sku || !/^https:\/\//i.test(url) || (r.Type && !/image/i.test(r.Type))) continue;
    if (!byOrder.has(sku)) byOrder.set(sku, []);
    byOrder.get(sku).push({ url, order: Number(r.OrderWeight) || 99 });
  }
  for (const [sku, list] of byOrder) {
    const urls = [...new Set(list.sort((a, b) => a.order - b.order).map((m) => m.url))].slice(0, MAX_PHOTOS);
    out.media.set(sku, urls);
  }
  return out;
}

export async function fetchSmdCatalogue({ fetchImpl = fetch, db = getDb() } = {}) {
  const access = smdAccess(db);
  if (!access) throw new Error(NO_ACCESS);
  const raw = {};
  const pages = {};
  for (const ep of ENDPOINTS) {
    const r = await getAll(ep, access, fetchImpl);
    raw[ep] = r.rows;
    pages[ep] = r.pages;
  }
  return { ...normaliseSmd(raw), pages, rows: Object.fromEntries(ENDPOINTS.map((e) => [e, raw[e].length])) };
}

// ---------------------------------------------------------------------- sync

const sigOf = (urls) => createHash('sha1').update(urls.join('\n')).digest('hex').slice(0, 16);

// Plans every change first (so a check run can report it), then applies it.
export function planSmdChanges(cat, db = getDb()) {
  const supplier = findSmdSupplier(db);
  const products = db.prepare("SELECT * FROM products WHERE supplier_id = ? AND fulfilment = 'dropship'").all(supplier.id);
  const plan = { updates: [], media: [], newFeed: [], feedCost: [], pricedSkus: new Set(cat.prices.keys()) };
  const stats = { listed: products.length, matched: 0, notInApi: 0, costUp: 0, costDown: 0, specials: 0, specialsEnded: 0, markedOut: 0, backInStock: 0, hidden: 0, unhidden: 0, lowStock: 0, descriptions: 0, photoSets: 0, newSkus: 0, newSkuCategories: {}, biggestChanges: [] };
  const listed = new Set();
  const missing = [];
  for (const p of products) {
    const sku = p.supplier_code;
    listed.add(sku);
    const price = cat.prices.get(sku);
    const soh = cat.stock.get(sku);
    const info = cat.products.get(sku);
    const u = { id: p.id, set: {} };
    if (!price && soh == null) {
      // Not in SMD's API: owner rule -- not in the API feed = not listed. Hidden
      // after the loop (unless the admin already hid it).
      stats.notInApi++;
      if (p.active) missing.push(p);
      continue;
    }
    stats.matched++;
    if (!p.active && p.hidden_by_feed && p.price_cents > 0) {
      Object.assign(u.set, { active: 1, hidden_by_feed: 0 });
      stats.unhidden++;
    }
    if (price) {
      const cost = price.specialCents ?? price.costCents;
      if (cost !== p.cost_cents) {
        u.set.cost_cents = cost;
        cost > p.cost_cents ? stats.costUp++ : stats.costDown++;
        stats.biggestChanges.push({ sku, name: p.name, from: p.cost_cents, to: cost });
        plan.feedCost.push({ code: sku, cost: price.costCents });
      }
      if (price.specialCents != null) {
        stats.specials++;
        if (p.price_mode === 'auto') {
          const was = retailForCost(p, price.costCents, db);
          const now = retailForCost(p, price.specialCents, db);
          if (was > now && (p.compare_at_cents !== was || !p.special_by_feed)) Object.assign(u.set, { compare_at_cents: was, special_by_feed: 1 });
        }
      } else if (p.special_by_feed) {
        Object.assign(u.set, { compare_at_cents: null, special_by_feed: 0 });
        stats.specialsEnded++;
      }
    }
    if (soh != null) {
      if (soh !== p.supplier_stock_qty) u.set.supplier_stock_qty = soh;
      const enough = soh >= Math.max(1, p.min_order_qty);
      if (!enough && p.supplier_in_stock) {
        Object.assign(u.set, { supplier_in_stock: 0, out_by_feed: 1 });
        stats.markedOut++;
      } else if (enough && !p.supplier_in_stock && p.out_by_feed) {
        Object.assign(u.set, { supplier_in_stock: 1, out_by_feed: 0 });
        stats.backInStock++;
      }
      if (enough && Math.floor(soh / Math.max(1, p.min_order_qty)) <= 5) stats.lowStock++;
    }
    if (info) {
      if (!p.description && info.long) {
        u.set.description = info.long.slice(0, 8000);
        stats.descriptions++;
      }
      if (!p.short_description && info.short && info.short !== info.name && info.short !== p.name) u.set.short_description = info.short.slice(0, 500);
    }
    const urls = cat.media.get(sku);
    if (urls?.length && p.images_from_feed !== 0 && p.media_sig !== sigOf(urls)) {
      plan.media.push({ productId: p.id, urls, sig: sigOf(urls), knownFeed: p.images_from_feed === 1 });
      stats.photoSets++;
    }
    if (Object.keys(u.set).length) plan.updates.push(u);
  }

  // Many listed SKUs missing at once means the API response is incomplete --
  // report it, never mass-hide.
  stats.missingNotMarked = products.length > 0 && stats.notInApi > products.length * 0.2;
  if (!stats.missingNotMarked) {
    for (const p of missing) {
      plan.updates.push({ id: p.id, set: { active: 0, hidden_by_feed: 1 } });
      stats.hidden++;
    }
  }
  stats.missingSample = missing.slice(0, 15).map((p) => `${p.supplier_code} — ${p.name}`);

  // SKUs SMD sells that the shop doesn't: into Warehouse feed for listing by hand.
  const inFeed = new Set(db.prepare('SELECT code FROM feed_items WHERE supplier_id = ?').all(supplier.id).map((r) => r.code));
  for (const [sku, price] of cat.prices) {
    if (listed.has(sku)) continue;
    const info = cat.products.get(sku);
    if (inFeed.has(sku)) {
      plan.feedCost.push({ code: sku, cost: price.costCents });
      continue;
    }
    if (!info?.name) continue;
    stats.newSkus++;
    const top = info.category.split('/')[0] || '(none)';
    stats.newSkuCategories[top] = (stats.newSkuCategories[top] || 0) + 1;
    plan.newFeed.push({ sku, info, price, imageUrl: cat.media.get(sku)?.[0] || '', soh: cat.stock.get(sku) });
  }
  stats.biggestChanges = stats.biggestChanges.sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from)).slice(0, 10);
  return { plan, stats, supplier };
}

function applyPlan({ plan, supplier }, db) {
  const ts = new Date().toISOString();
  const repriceIds = [];
  const tx = db.transaction(() => {
    for (const u of plan.updates) {
      const cols = Object.keys(u.set);
      db.prepare(`UPDATE products SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_at = @ts WHERE id = @id`).run({ ...u.set, ts, id: u.id });
      if ('cost_cents' in u.set) repriceIds.push(u.id);
    }
    const feedCost = db.prepare(`UPDATE feed_items SET previous_cost_cents = CASE WHEN cost_cents != @cost THEN cost_cents ELSE previous_cost_cents END,
      cost_cents = @cost, imported_at = @ts WHERE supplier_id = @s AND code = @code`);
    for (const f of plan.feedCost) feedCost.run({ cost: f.cost, ts, s: supplier.id, code: f.code });
    const ins = db.prepare(`INSERT OR IGNORE INTO feed_items (id, supplier_id, code, name, brand, category, cost_cents, min_order_qty, details, image, image_url, image_status, source_file, source_sheet, in_latest_import, imported_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, 'API', 1, ?)`);
    for (const n of plan.newFeed) {
      // Pack size from SMD's own name: "... ( Order in Qty of 12 )".
      ins.run(randomUUID(), supplier.id, n.sku, n.info.name, n.info.brand, n.info.category, n.price.costCents, parseMinOrderQty(n.info.name), n.info.long.slice(0, 4000), n.imageUrl, n.imageUrl ? 'pending' : '', SMD_API_FILE, ts);
    }
    // API-only feed rows: pack size from the name, and only SKUs SMD still
    // prices count as current (the auto-list never lists a withdrawn one).
    const apiRows = db.prepare('SELECT id, code, name, min_order_qty, in_latest_import FROM feed_items WHERE supplier_id = ? AND source_file = ?').all(supplier.id, SMD_API_FILE);
    const updApi = db.prepare('UPDATE feed_items SET min_order_qty = ?, in_latest_import = ? WHERE id = ?');
    for (const f of apiRows) {
      const moq = parseMinOrderQty(f.name);
      const current = plan.pricedSkus.has(f.code) ? 1 : 0;
      if (moq !== f.min_order_qty || current !== f.in_latest_import) updApi.run(moq, current, f.id);
    }
    const q = db.prepare(`INSERT INTO product_media_queue (product_id, urls, sig, status, tries, updated_at) VALUES (?, ?, ?, 'pending', 0, ?)
      ON CONFLICT(product_id) DO UPDATE SET urls = excluded.urls, sig = excluded.sig, status = 'pending', tries = 0, updated_at = excluded.updated_at`);
    for (const m of plan.media) q.run(m.productId, JSON.stringify(m.urls), m.sig, ts);
  });
  tx();
  // Special price on/off changes the price too (compare_at was set above).
  return repriceIds.length ? repriceProducts({ ids: repriceIds }, db) : 0;
}

let running = null;

// check: true = read-only connection check (report only, nothing changes).
export function syncSmd({ trigger = 'manual', check = false, email = true, fetchImpl, catalogue = null } = {}, db = getDb()) {
  if (running) return running;
  running = (async () => {
    const started = new Date();
    const report = { trigger, check, startedAt: started.toISOString(), ok: false, error: '' };
    try {
      if (!findSmdSupplier(db)) throw new Error('No supplier named "SMD..." in Admin -> Suppliers');
      const cat = catalogue || (await fetchSmdCatalogue({ fetchImpl, db }));
      report.api = { products: cat.products.size, prices: cat.prices.size, stock: cat.stock.size, photoSkus: cat.media.size, pages: cat.pages || null };
      const prev = lastRun(db);
      if (!check && prev?.ok && !prev.check && prev.api?.prices && cat.prices.size < prev.api.prices * MIN_SHARE_OF_PREVIOUS) {
        throw new Error(`SMD sent only ${cat.prices.size} prices (last run ${prev.api.prices}) -- skipped so nothing is marked out of stock by mistake`);
      }
      if (!cat.prices.size) throw new Error('SMD sent no prices -- skipped');
      const planned = planSmdChanges(cat, db);
      const before = check ? null : snapshotPrices(planned.supplier.id, db);
      report.stats = planned.stats;
      if (!check) {
        report.repriced = applyPlan(planned, db);
        startMediaDownloads(db);
      }
      // New SMD products (not in the shop yet) -> shop categories by
      // smd-api-rules.js. Lists only while switched on; otherwise the report
      // says what it would list.
      report.autoListOn = Boolean(getSettings(db).smdApiAutoList);
      report.autoList = autoList({ list: 'smdapi', supplierId: planned.supplier.id, dryRun: check || !report.autoListOn }, db);
      if (before) report.changes = diffPrices(before, planned.supplier.id, db);
      report.ok = true;
    } catch (err) {
      report.error = err.message;
      console.error(`SMD sync failed: ${err.message}`);
    }
    report.seconds = Math.round((Date.now() - started) / 1000);
    saveLastRun(db, report);
    if (email) await sendSmdReport(report);
    return report;
  })().finally(() => {
    running = null;
  });
  return running;
}

function saveLastRun(db, r) {
  const al = r.autoList;
  const summary = { at: r.startedAt, trigger: r.trigger, check: r.check, ok: r.ok, error: r.error, seconds: r.seconds, api: r.api || null, stats: r.stats ? { ...r.stats, biggestChanges: undefined } : null, repriced: r.repriced ?? 0,
    listed: al && r.autoListOn && !r.check ? al.created : 0, wouldList: al && (!r.autoListOn || r.check) ? al.summary.reduce((n, g) => n + g.newListings, 0) : 0 };
  db.prepare("INSERT INTO settings (key, value) VALUES ('smdApiLastRun', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(summary));
}

function lastRun(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'smdApiLastRun'").get();
  try {
    return row ? JSON.parse(row.value) : null;
  } catch {
    return null;
  }
}

export function smdStatus(db = getDb()) {
  return {
    configured: smdConfigured(db),
    supplier: findSmdSupplier(db) ? { id: findSmdSupplier(db).id, name: findSmdSupplier(db).name } : null,
    syncOn: Boolean(getSettings(db).smdApiSync),
    autoList: Boolean(getSettings(db).smdApiAutoList),
    runTimesSast: syncTimes(),
    running: Boolean(running),
    photosQueued: db.prepare("SELECT COUNT(*) n FROM product_media_queue WHERE status IN ('pending','downloading')").get().n,
    lastRun: lastRun(db),
  };
}

// ------------------------------------------------------------ photo downloads

async function isThumbnail(publicPath) {
  const file = resolveUpload(publicPath);
  if (!file) return false;
  try {
    const m = await sharp(file).metadata();
    return Math.max(m.width || 0, m.height || 0) <= THUMB_MAX_PX;
  } catch {
    return true; // unreadable file: nothing worth keeping
  }
}

let mediaRunning = null;

// Downloads queued photo sets and puts them on their products. `download`
// (url -> Buffer) is injectable for tests; default is the SSRF-guarded fetchImage.
export function startMediaDownloads(db = getDb(), { download = fetchImage } = {}) {
  if (process.env.NO_IMAGE_WORKER === '1' && download === fetchImage) return Promise.resolve();
  if (mediaRunning) return mediaRunning;
  mediaRunning = (async () => {
    const next = db.prepare("SELECT * FROM product_media_queue WHERE status = 'pending' ORDER BY updated_at LIMIT 1");
    const worker = async () => {
      for (;;) {
        const job = next.get();
        if (!job) return;
        db.prepare("UPDATE product_media_queue SET status = 'downloading', tries = tries + 1 WHERE product_id = ?").run(job.product_id);
        try {
          const p = db.prepare('SELECT id, images, images_from_feed FROM products WHERE id = ?').get(job.product_id);
          if (!p || p.images_from_feed === 0) {
            db.prepare('DELETE FROM product_media_queue WHERE product_id = ?').run(job.product_id);
            continue;
          }
          const current = parseJsonArray(p.images);
          // Unknown origin: replace only SMD's tiny spreadsheet thumbnails.
          if (p.images_from_feed == null && current.length) {
            const thumbs = await Promise.all(current.map(isThumbnail));
            if (!thumbs.every(Boolean)) {
              db.prepare('UPDATE products SET images_from_feed = 0 WHERE id = ?').run(p.id);
              db.prepare('DELETE FROM product_media_queue WHERE product_id = ?').run(job.product_id);
              continue;
            }
          }
          const saved = [];
          for (const url of JSON.parse(job.urls)) {
            try {
              saved.push(await storeProductImage(await download(url)));
            } catch (err) {
              console.warn(`SMD photo failed for ${p.id}: ${err.message}`);
            }
          }
          if (!saved.length) throw new Error('no photo could be downloaded');
          // Re-check: the admin may have edited the product meanwhile.
          const fresh = db.prepare('SELECT images, images_from_feed FROM products WHERE id = ?').get(p.id);
          if (!fresh || fresh.images_from_feed === 0 || fresh.images !== p.images) {
            saved.forEach(deleteUpload);
          } else {
            db.prepare('UPDATE products SET images = ?, images_from_feed = 1, media_sig = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(saved), job.sig, new Date().toISOString(), p.id);
            current.forEach(deleteUpload); // the replaced feed photos belong to this product only
          }
          db.prepare('DELETE FROM product_media_queue WHERE product_id = ?').run(job.product_id);
        } catch (err) {
          const failed = db.prepare('SELECT tries FROM product_media_queue WHERE product_id = ?').get(job.product_id)?.tries >= 3;
          db.prepare('UPDATE product_media_queue SET status = ? WHERE product_id = ?').run(failed ? 'failed' : 'pending', job.product_id);
          console.warn(`SMD photos for ${job.product_id}: ${err.message}`);
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: 3 }, worker));
    } finally {
      mediaRunning = null;
    }
  })();
  return mediaRunning;
}

export function resumeMediaDownloads(db = getDb()) {
  db.prepare("UPDATE product_media_queue SET status = 'pending' WHERE status = 'downloading'").run();
  if (db.prepare("SELECT 1 FROM product_media_queue WHERE status = 'pending' LIMIT 1").get()) startMediaDownloads(db);
}

// ------------------------------------------------------------------ schedule

// "06:30,12:30,18:30" (SAST) -- 30 minutes after the Esquire runs.
export function syncTimes() {
  return String(process.env.SMD_SYNC_TIMES || '06:30,12:30,18:30')
    .split(',')
    .map((t) => t.trim().match(/^(\d{1,2}):(\d{2})$/))
    .filter((m) => m && Number(m[1]) < 24 && Number(m[2]) < 60)
    .map((m) => `${m[1].padStart(2, '0')}:${m[2]}`);
}

export function startSmdSchedule() {
  if (process.env.DISABLE_SMD_SYNC === '1') return;
  const slots = syncTimes().map((t) => ({ h: Number(t.slice(0, 2)), m: Number(t.slice(3)) }));
  const plan = () => {
    const at = nextRunAt(new Date(), slots);
    if (!at) return;
    setTimeout(() => {
      let ready = false;
      try {
        ready = Boolean(getSettings().smdApiSync) && smdConfigured();
      } catch (err) {
        console.error('SMD sync check failed:', err.message);
      }
      (ready ? syncSmd({ trigger: 'scheduled' }) : Promise.resolve()).finally(plan);
    }, at - Date.now()).unref();
  };
  plan();
  console.log(`SMD sync scheduled at ${syncTimes().join(', ')} SAST (runs only while switched on)`);
}
