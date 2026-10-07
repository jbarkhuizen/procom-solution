// Tables for the price-drops feature (see README.md). Imports nothing.
//
// price_drops   one row per drop of a product's shop price found by a supplier
//               sync. was_cents is the price before the FIRST drop (what we
//               charged), now_cents the price after the latest one. The page
//               shows a drop only while the product's live price is still below
//               was_cents, so a price that goes back up removes it at once; the
//               row is closed (ended_at) at the next sync so a later drop starts fresh.
export const SQL = `
  CREATE TABLE IF NOT EXISTS price_drops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id TEXT NOT NULL,
    was_cents INTEGER NOT NULL,
    now_cents INTEGER NOT NULL,
    cost_was_cents INTEGER NOT NULL DEFAULT 0,   -- supplier cost excl VAT
    cost_now_cents INTEGER NOT NULL DEFAULT 0,
    detected_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,                    -- latest drop; the keep-days window counts from here
    hidden INTEGER NOT NULL DEFAULT 0,           -- hidden by the owner
    pinned INTEGER NOT NULL DEFAULT 0,           -- owner keeps it past the keep-days window
    ended_at TEXT,
    ended_reason TEXT NOT NULL DEFAULT ''        -- back_to_normal | expired | too_small
  );
  CREATE INDEX IF NOT EXISTS idx_price_drops_product ON price_drops (product_id, ended_at);
  CREATE INDEX IF NOT EXISTS idx_price_drops_open ON price_drops (ended_at, updated_at);
`;

export const COLUMNS = [];
