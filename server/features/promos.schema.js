// Tables/columns for this feature (see README.md). Imports nothing.
// Uses are not stored: they are counted from paid orders (orders.promo_code +
// payment_status = 'paid'), so abandoned checkouts never use up a code.
export const SQL = `
  CREATE TABLE IF NOT EXISTS promo_codes (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL CHECK (kind IN ('percent','fixed')),
    percent_off REAL NOT NULL DEFAULT 0,
    amount_cents INTEGER NOT NULL DEFAULT 0,
    min_subtotal_cents INTEGER NOT NULL DEFAULT 0,
    category_id TEXT NOT NULL DEFAULT '',      -- '' = any category (else incl. sub-categories)
    brand TEXT NOT NULL DEFAULT '',            -- '' = any brand
    starts_at TEXT NOT NULL DEFAULT '',
    ends_at TEXT NOT NULL DEFAULT '',
    max_uses INTEGER,                          -- NULL = unlimited
    max_uses_per_email INTEGER,                -- NULL = unlimited
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_orders_promo_code ON orders (promo_code);
`;
export const COLUMNS = [];
