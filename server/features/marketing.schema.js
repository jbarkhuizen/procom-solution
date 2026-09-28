// Tables/columns for the marketing feature (see README.md). Imports nothing.
//
// Potential market = marketing leads (businesses, schools, resellers) that are
// not customers yet. Their contact details are personal information under
// POPIA: `source` records where the details came from, and nothing in this
// table is ever part of the newsletter audience (that is clients.newsletter_opt_in
// + newsletter subscribers only).
//
// advert_platforms / advert_platform_groups have the same shape as Lapanza3d's
// tables, so "Copy platforms & rules from Lapanza3d" is a straight name match.
// adverts adds group_id (plan against one group's allowed days) and
// product_id (optional product the caption links to) to Lapanza's columns.
export const SQL = `
  CREATE TABLE IF NOT EXISTS potential_market_contacts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    company TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'business',
    status TEXT NOT NULL DEFAULT 'new',
    source TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    last_contacted_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pm_contacts_status ON potential_market_contacts (status);

  CREATE TABLE IF NOT EXISTS advert_platforms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    has_groups INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- allowed_days: comma-separated 3-letter weekdays ("Mon,Thu"); '' = any day.
  CREATE TABLE IF NOT EXISTS advert_platform_groups (
    id TEXT PRIMARY KEY,
    platform_id TEXT NOT NULL REFERENCES advert_platforms(id) ON DELETE CASCADE,
    group_name TEXT NOT NULL,
    allowed_days TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_advert_platform_groups_platform ON advert_platform_groups (platform_id);

  -- One row per scheduled advert on one platform (and optionally one group).
  -- duration_days is inclusive of the publish day.
  CREATE TABLE IF NOT EXISTS adverts (
    id TEXT PRIMARY KEY,
    platform_id TEXT NOT NULL REFERENCES advert_platforms(id),
    group_id TEXT NOT NULL DEFAULT '',
    product_id TEXT NOT NULL DEFAULT '',
    image_path TEXT NOT NULL DEFAULT '',
    caption TEXT NOT NULL DEFAULT '',
    publish_date TEXT NOT NULL,
    publish_time TEXT NOT NULL DEFAULT '',
    duration_days INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_adverts_publish_date ON adverts (publish_date);
`;
export const COLUMNS = [];
