import dns from 'dns/promises';
import net from 'net';
import { getDb } from './db.js';
import { storeProductImage, copyUpload } from './images.js';
import { parseJsonArray } from './util.js';

// Downloads supplier photo URLs from CSV/JSON/XML feeds in the background.
//
// Feed files are admin-uploaded but their contents come from third parties,
// so every URL is treated as hostile: http(s) only, DNS-resolved and refused
// if it points at a private/loopback/link-local address (otherwise a feed
// could make this server fetch http://127.0.0.1:8787/... -- Lapanza's API),
// redirects re-checked hop by hop, 10 MB / 15 s caps, and the bytes must
// decode as an image (sharp re-encodes them, so nothing else is ever stored).

const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const CONCURRENCY = 4;

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb');
}

async function assertPublicUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('invalid URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('only http/https URLs');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (!addrs.length || addrs.some(isPrivateAddress)) throw new Error('refusing private/internal address');
  return url;
}

export async function fetchImage(raw) {
  let target = raw;
  for (let hop = 0; hop < 4; hop++) {
    const url = await assertPublicUrl(target);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { redirect: 'manual', signal: ctrl.signal, headers: { 'User-Agent': 'ProcomSolutions-FeedImporter/1.0' } });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        target = new URL(res.headers.get('location'), url).toString();
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const len = Number(res.headers.get('content-length') || 0);
      if (len > MAX_BYTES) throw new Error('image too large');
      const chunks = [];
      let total = 0;
      for await (const chunk of res.body) {
        total += chunk.length;
        if (total > MAX_BYTES) throw new Error('image too large');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('too many redirects');
}

let running = null;

// Processes all pending feed photos; safe to call repeatedly (single worker).
export function startImageDownloads(db = getDb()) {
  if (process.env.NO_IMAGE_WORKER === '1') return Promise.resolve(); // tests
  if (running) return running;
  running = (async () => {
    // Select + claim run synchronously (better-sqlite3), so workers never grab the same row.
    const next = db.prepare("SELECT id, image_url, supplier_id, code FROM feed_items WHERE image_status = 'pending' LIMIT 1");
    const done = db.prepare("UPDATE feed_items SET image = ?, image_status = '' WHERE id = ?");
    const failed = db.prepare("UPDATE feed_items SET image_status = 'failed' WHERE id = ?");
    const worker = async () => {
      for (;;) {
        const row = next.get();
        if (!row) return;
        // Claim it so other workers skip it.
        db.prepare("UPDATE feed_items SET image_status = 'downloading' WHERE id = ?").run(row.id);
        try {
          const path = await storeProductImage(await fetchImage(row.image_url), 'feed');
          done.run(path, row.id);
          attachToListedProduct(db, row, path);
        } catch (err) {
          failed.run(row.id);
          console.warn(`Feed image failed for ${row.code}: ${err.message}`);
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    } finally {
      running = null;
    }
  })();
  return running;
}

// If the item was already listed before its photo arrived, give the product the photo.
function attachToListedProduct(db, row, feedPath) {
  const p = db.prepare('SELECT id, images FROM products WHERE supplier_id = ? AND supplier_code = ?').get(row.supplier_id, row.code);
  if (!p || parseJsonArray(p.images).length) return;
  const copy = copyUpload(feedPath);
  if (copy) db.prepare('UPDATE products SET images = ?, updated_at = ? WHERE id = ?').run(JSON.stringify([copy]), new Date().toISOString(), p.id);
}

export function resumePendingDownloads(db = getDb()) {
  // A restart mid-download leaves rows in 'downloading' -- put them back in the queue.
  db.prepare("UPDATE feed_items SET image_status = 'pending' WHERE image_status = 'downloading'").run();
  if (db.prepare("SELECT 1 FROM feed_items WHERE image_status = 'pending' LIMIT 1").get()) startImageDownloads(db);
}
