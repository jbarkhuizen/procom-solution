// Tables/columns for this feature (see README.md). Imports nothing.
// A special targets one product, a category (incl. its sub-categories) or a
// brand, and is either a percentage off or a fixed special price (products
// only). Dates are whole SAST days, inclusive; '' = open-ended.
export const SQL = `
  CREATE TABLE IF NOT EXISTS specials (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL DEFAULT '',
    target_type TEXT NOT NULL CHECK (target_type IN ('product','category','brand')),
    target_id TEXT NOT NULL DEFAULT '',        -- product id, category id or brand name
    kind TEXT NOT NULL CHECK (kind IN ('percent','price')),
    percent_off REAL NOT NULL DEFAULT 0,
    price_cents INTEGER NOT NULL DEFAULT 0,
    starts_at TEXT NOT NULL DEFAULT '',
    ends_at TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;
export const COLUMNS = [];
