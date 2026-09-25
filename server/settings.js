import { getDb, DEFAULT_SETTINGS } from './db.js';

export function getSettings(db = getDb()) {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      out[row.key] = row.value;
    }
  }
  return out;
}

// Only known keys are writable -- stops the admin UI (or a crafted request)
// from stuffing arbitrary keys into the table.
export function updateSettings(patch, db = getDb()) {
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(patch || {})) {
      if (!(k in DEFAULT_SETTINGS)) continue;
      const def = DEFAULT_SETTINGS[k];
      let value = v;
      if (typeof def === 'number') value = Number(v);
      if (typeof def === 'boolean') value = v === true || v === 'true' || v === 1 || v === '1';
      if (typeof def === 'string') value = String(v ?? '');
      if (typeof def === 'number' && !Number.isFinite(value)) continue;
      up.run(k, JSON.stringify(value));
    }
  });
  tx();
  return getSettings(db);
}

// What the storefront may see. Never includes owner-only fields.
export function publicSettings(db = getDb()) {
  const s = getSettings(db);
  return {
    siteName: s.siteName,
    tagline: s.tagline,
    contactEmail: s.contactEmail,
    contactPhone: s.contactPhone,
    whatsappNumber: s.whatsappNumber,
    hours: s.hours,
    announcement: s.announcement,
    vatRegistered: s.vatRegistered,
    vatNumber: s.vatRegistered ? s.vatNumber : '',
    legalEntity: s.legalEntity,
  };
}
