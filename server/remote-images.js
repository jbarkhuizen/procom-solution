import dns from 'dns/promises';
import http from 'http';
import https from 'https';
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

// Every IPv4 range that is not a normal public address.
const BLOCKED_V4 = new net.BlockList();
for (const [addr, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]]) BLOCKED_V4.addSubnet(addr, prefix, 'ipv4');
// IPv6 ranges inside 2000::/3 that are still not public (Teredo, documentation, 6to4).
const BLOCKED_V6 = new net.BlockList();
for (const [addr, prefix] of [['2001::', 32], ['2001:db8::', 32], ['2002::', 16]]) BLOCKED_V6.addSubnet(addr, prefix, 'ipv6');

// "::ffff:7f00:1" / "::1" / "64:ff9b::7f00:1" -> 8 groups of 16 bits.
function ipv6Groups(ip) {
  let s = ip.toLowerCase().replace(/%.*$/, '');
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted[1].split('.').map(Number);
    s = s.replace(dotted[1], `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`);
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? [] : tail ? tail.split(':') : [];
  const fill = tail === undefined ? [] : Array(Math.max(0, 8 - h.length - t.length)).fill('0');
  return [...h, ...fill, ...t].map((g) => parseInt(g || '0', 16));
}

// True for anything that is not an ordinary public internet address. IPv6 is an allow-list: only global
// unicast 2000::/3 passes, and addresses that wrap an IPv4 one (mapped ::ffff:a.b.c.d in either spelling, IPv4-compatible)
// are judged by that IPv4 address. NAT64 (64:ff9b::/96) and 6to4 (2002::/16) are refused outright.
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return BLOCKED_V4.check(ip, 'ipv4');
  if (!net.isIPv6(ip)) return true;
  const g = ipv6Groups(ip);
  if (g.length !== 8 || g.some((x) => !Number.isInteger(x))) return true;
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    const v4 = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
    return BLOCKED_V4.check(v4, 'ipv4') || (g[5] === 0 && g[6] === 0 && g[7] <= 1); // ::, ::1
  }
  if ((g[0] & 0xe000) !== 0x2000) return true;
  return BLOCKED_V6.check(ip, 'ipv6');
}

// Resolves the host and refuses non-public addresses; returns the ONE address the request must use
// (the connection is pinned to it, so the DNS answer cannot change between the check and the download).
async function resolvePublic(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('invalid URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('only http/https URLs');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new Error('refusing private/internal address');
  return { url, address: addrs[0].address, family: addrs[0].family };
}

// GET with the connection pinned to an already-checked address. Resolves to { status, headers (lower-case), body (async iterable) }.
function pinnedGet({ url, address, family }, signal) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      url,
      {
        method: 'GET',
        signal,
        headers: { 'User-Agent': 'ProcomSolutions-FeedImporter/1.0' },
        lookup: (_host, opts, cb) => (opts && opts.all ? cb(null, [{ address, family }]) : cb(null, address, family)),
      },
      (res) => resolve({ status: res.statusCode, headers: res.headers, body: res }),
    );
    req.on('error', reject);
    req.end();
  });
}

export async function fetchImage(raw) {
  let target = raw;
  for (let hop = 0; hop < 4; hop++) {
    const pinned = await resolvePublic(target);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await pinnedGet(pinned, ctrl.signal);
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        res.body.resume();
        target = new URL(res.headers.location, pinned.url).toString();
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        res.body.resume();
        throw new Error(`HTTP ${res.status}`);
      }
      const len = Number(res.headers['content-length'] || 0);
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
