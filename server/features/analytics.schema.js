// Tables/columns for the analytics feature (see README.md). Imports nothing.
//
// First-party, anonymous: a random visitor id from the browser's
// localStorage, never an IP address, a user agent string or a customer id.
// `day` is the South African calendar day (UTC+2, no daylight saving) the
// row belongs to, stored at insert time so every grouping agrees with the
// admin's clock whatever timezone the server runs in.
//
// page_views / analytics_events are raw rows, kept 12 months (daily prune in
// analytics.js). Before a day is pruned its totals are copied into
// analytics_daily, so the daily chart still works for older ranges.
export const SQL = `
  CREATE TABLE IF NOT EXISTS page_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    visitor_id TEXT NOT NULL,
    path TEXT NOT NULL,
    referrer_host TEXT NOT NULL DEFAULT '',
    product_slug TEXT NOT NULL DEFAULT '',
    category_slug TEXT NOT NULL DEFAULT '',
    search_query TEXT NOT NULL DEFAULT '',
    search_results INTEGER,
    device TEXT NOT NULL DEFAULT 'desktop',
    logged_in INTEGER NOT NULL DEFAULT 0,
    day TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_page_views_day ON page_views (day);
  CREATE INDEX IF NOT EXISTS idx_page_views_created ON page_views (created_at);

  CREATE TABLE IF NOT EXISTS analytics_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    visitor_id TEXT NOT NULL,
    event TEXT NOT NULL,
    path TEXT NOT NULL DEFAULT '',
    product_id TEXT NOT NULL DEFAULT '',
    quantity INTEGER NOT NULL DEFAULT 0,
    device TEXT NOT NULL DEFAULT 'desktop',
    day TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_analytics_events_day ON analytics_events (day, event);
  CREATE INDEX IF NOT EXISTS idx_analytics_events_created ON analytics_events (created_at);

  CREATE TABLE IF NOT EXISTS analytics_daily (
    day TEXT PRIMARY KEY,
    page_views INTEGER NOT NULL DEFAULT 0,
    visitors INTEGER NOT NULL DEFAULT 0,
    product_views INTEGER NOT NULL DEFAULT 0,
    add_to_cart INTEGER NOT NULL DEFAULT 0,
    checkout_start INTEGER NOT NULL DEFAULT 0
  );
`;
// 2026-10-08 (owner): where visitors come from. Campaign tags and the referring
// page come from the landing URL / referrer; the place is looked up from the IP
// in memory (geoip.js) and only the place name is kept, never the IP. Orders keep
// the channel that brought the customer (a label like 'google' or 'email', never a visitor id).
export const COLUMNS = [
  ['page_views', 'referrer_path', "TEXT NOT NULL DEFAULT ''"],
  ['page_views', 'utm_source', "TEXT NOT NULL DEFAULT ''"],
  ['page_views', 'utm_medium', "TEXT NOT NULL DEFAULT ''"],
  ['page_views', 'utm_campaign', "TEXT NOT NULL DEFAULT ''"],
  ['page_views', 'country', "TEXT NOT NULL DEFAULT ''"],
  ['page_views', 'region', "TEXT NOT NULL DEFAULT ''"],
  ['page_views', 'city', "TEXT NOT NULL DEFAULT ''"],
  ['orders', 'source_channel', "TEXT NOT NULL DEFAULT ''"],
  ['orders', 'source_detail', "TEXT NOT NULL DEFAULT ''"],
];
