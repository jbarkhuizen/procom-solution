// Visitor location for the Analytics page (owner 2026-10-08): country, province
// and city looked up from MaxMind's free GeoLite2-City database, which lives on
// OUR server (data/geoip/). The visitor's IP address is used once, in memory, to
// find the place and is never stored or sent anywhere; only the place name is
// saved with the page view.
//
// The owner enters the MaxMind account ID and licence key in Admin -> Analytics
// (key encrypted with the vault, never listed). The database is downloaded
// from MaxMind and refreshed every ~2 weeks (it is published twice a week).
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { getDb } from '../db.js';
import { dataDir } from '../paths.js';
import { encryptSecret, decryptSecret } from '../vault.js';

const DOWNLOAD_URL = 'https://download.maxmind.com/geoip/databases/GeoLite2-City/download?suffix=tar.gz';
const MAX_AGE_MS = 14 * 86400_000;
const dbDir = () => process.env.GEOIP_DIR || path.join(dataDir(), 'geoip');
export const geoFile = () => path.join(dbDir(), 'GeoLite2-City.mmdb');

// ------------------------------------------------------------ settings (ops_settings)

const getKey = (key, db = getDb()) => db.prepare('SELECT value FROM ops_settings WHERE key = ?').get(key)?.value || '';
const setKey = (key, value, db = getDb()) =>
  db.prepare("INSERT INTO ops_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(key, String(value ?? ''), new Date().toISOString());

export function saveGeoCredentials({ accountId, licenseKey } = {}, db = getDb()) {
  const id = String(accountId ?? '').trim();
  if (id && !/^\d{1,12}$/.test(id)) throw Object.assign(new Error('The MaxMind account ID is a number (see your MaxMind account page)'), { status: 400 });
  const key = String(licenseKey ?? '').trim();
  if (key && !/^[A-Za-z0-9_]{10,80}$/.test(key)) throw Object.assign(new Error('That does not look like a MaxMind licence key'), { status: 400 });
  if (id) setKey('geoip_account_id', id, db);
  if (key) setKey('geoip_license_enc', encryptSecret(key), db); // blank = keep the saved key
  return geoStatus(db);
}

export function geoStatus(db = getDb()) {
  const file = geoFile();
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch { /* not installed */ }
  return {
    configured: Boolean(getKey('geoip_account_id', db) && getKey('geoip_license_enc', db)),
    accountId: getKey('geoip_account_id', db),
    hasKey: Boolean(getKey('geoip_license_enc', db)),
    installed: size > 0,
    sizeMb: Math.round((size / 1048576) * 10) / 10,
    updatedAt: getKey('geoip_updated_at', db) || null,
    lastCheckAt: getKey('geoip_last_check', db) || null,
    lastError: getKey('geoip_last_error', db) || '',
    loaded: Boolean(reader || testLookup),
  };
}

// ------------------------------------------------------------ download + unpack

// First *.mmdb file inside a .tar.gz (MaxMind ships "GeoLite2-City_<date>/GeoLite2-City.mmdb").
export function extractMmdb(tarGz) {
  const tar = zlib.gunzipSync(tarGz);
  let off = 0;
  while (off + 512 <= tar.length) {
    const head = tar.subarray(off, off + 512);
    if (head.every((b) => b === 0)) break;
    const field = (a, b) => head.toString('utf8', a, b).replace(/\0.*$/s, '');
    const size = parseInt(field(124, 136).trim() || '0', 8) || 0;
    const type = String.fromCharCode(head[156] || 48);
    const prefix = field(345, 500);
    const name = (prefix ? `${prefix}/` : '') + field(0, 100);
    if ((type === '0' || type === '\0') && name.endsWith('.mmdb')) return Buffer.from(tar.subarray(off + 512, off + 512 + size));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error('The download did not contain the location database');
}

let updating = null;

// Downloads and installs the database now. Resolves to the new status; failures
// are stored (shown in admin) and thrown.
export function updateGeoDatabase({ fetchImpl = fetch } = {}, db = getDb()) {
  if (updating) return updating;
  const run = async () => {
    setKey('geoip_last_check', new Date().toISOString(), db);
    try {
      const id = getKey('geoip_account_id', db);
      const enc = getKey('geoip_license_enc', db);
      if (!id || !enc) throw new Error('Enter the MaxMind account ID and licence key first');
      const res = await fetchImpl(DOWNLOAD_URL, {
        headers: { Authorization: `Basic ${Buffer.from(`${id}:${decryptSecret(enc)}`).toString('base64')}` },
        redirect: 'follow',
        signal: AbortSignal.timeout(180_000),
      });
      if (res.status === 401) throw new Error('MaxMind rejected the account ID or licence key');
      if (res.status === 403 || res.status === 429) throw new Error('MaxMind refused the download (daily limit reached, or the licence has no GeoLite2 access). Try again tomorrow.');
      if (!res.ok) throw new Error(`MaxMind download failed (HTTP ${res.status})`);
      const mmdb = extractMmdb(Buffer.from(await res.arrayBuffer()));
      fs.mkdirSync(dbDir(), { recursive: true });
      const tmp = `${geoFile()}.part`;
      fs.writeFileSync(tmp, mmdb);
      await openReader(tmp); // refuse a file that cannot be read
      fs.renameSync(tmp, geoFile());
      await openReader(geoFile());
      setKey('geoip_updated_at', new Date().toISOString(), db);
      setKey('geoip_last_error', '', db);
    } catch (err) {
      setKey('geoip_last_error', err.message, db);
      throw err;
    }
    return geoStatus(db);
  };
  // Cleared after the promise exists (a failure before the first await must not leave it set).
  updating = run().finally(() => {
    updating = null;
  });
  return updating;
}

// ------------------------------------------------------------ lookup

let reader = null;
let testLookup = null;

async function openReader(file) {
  const { default: maxmind } = await import('maxmind');
  reader = await maxmind.open(file);
}

// Called once at start (server index) and after every update.
export async function initGeo() {
  try {
    if (fs.existsSync(geoFile())) await openReader(geoFile());
  } catch (err) {
    console.error('Could not load the visitor location database:', err.message);
    reader = null;
  }
}

export function setGeoLookupForTests(fn) {
  testLookup = fn;
}
export function _resetGeo() {
  reader = null;
  testLookup = null;
}

const PRIVATE_IP = /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|::1$|f[cd][0-9a-f]{2}:|fe80:)/i;

// { country: 'ZA', region: 'Gauteng', city: 'Pretoria' } -- '' for anything unknown.
export function geoFor(ip) {
  const none = { country: '', region: '', city: '' };
  try {
    const addr = String(ip || '').replace(/^::ffff:/i, '');
    if (!addr || PRIVATE_IP.test(addr)) return none;
    const r = testLookup ? testLookup(addr) : reader?.get(addr);
    if (!r) return none;
    const clip = (s) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80);
    return {
      country: /^[A-Z]{2}$/.test(r.country?.iso_code || '') ? r.country.iso_code : '',
      region: clip(r.subdivisions?.[0]?.names?.en),
      city: clip(r.city?.names?.en),
    };
  } catch {
    return none;
  }
}

// Checks daily; downloads when configured and missing or older than ~2 weeks.
export function startGeoSchedule() {
  if (process.env.DISABLE_GEOIP_UPDATE === '1') return;
  const check = async () => {
    try {
      const s = geoStatus();
      if (!s.configured) return;
      const age = s.updatedAt ? Date.now() - Date.parse(s.updatedAt) : Infinity;
      if (!s.installed || age > MAX_AGE_MS) await updateGeoDatabase();
    } catch (err) {
      console.error('Visitor location database update failed:', err.message);
    }
  };
  setTimeout(check, 120_000).unref?.();
  setInterval(check, 86400_000).unref?.();
  initGeo();
}
