export function slugify(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/["'’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

// Returns a slug not already used in `table`, appending -2, -3... on clash.
export function uniqueSlug(db, table, base, excludeId = '') {
  const root = slugify(base);
  let candidate = root;
  let n = 2;
  const stmt = db.prepare(`SELECT id FROM ${table} WHERE slug = ? AND id != ?`);
  while (stmt.get(candidate, excludeId)) candidate = `${root}-${n++}`;
  return candidate;
}

// Accepts 'R1,299.00', '1299', 1299.5 -> integer cents. Returns null if unparseable.
// Accepts 'R1,299.00', 'R10 999.00', '1299', 1299.5 and decimal-comma
// '1 299,00' / '1.299,00' -> integer cents. Returns null if unparseable.
export function parseRandToCents(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) : null;
  let s = String(value).replace(/[^0-9.,-]/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot && /,\d{1,2}$/.test(s)) {
    s = s.replace(/\./g, '').replace(',', '.'); // comma is the decimal separator
  } else {
    s = s.replace(/,/g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export function formatRand(cents) {
  const amount = (Number(cents) || 0) / 100;
  const sign = amount < 0 ? '-' : '';
  const [whole, dec] = Math.abs(amount).toFixed(2).split('.');
  return `${sign}R ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${dec}`;
}

export function parseJsonArray(text) {
  try {
    const v = JSON.parse(text || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
