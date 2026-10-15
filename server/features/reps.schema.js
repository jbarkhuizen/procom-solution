// Tables/columns for the Sales reps feature (see README.md). Imports nothing.
// Money is integer cents. A rep's bank details are deliberately NOT stored:
// payouts are recorded with the owner's own EFT reference only.
export const SQL = `
  CREATE TABLE IF NOT EXISTS reps (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    company TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    percent REAL NOT NULL DEFAULT 50,          -- share of the order profit; copied into each commission when it is earned
    active INTEGER NOT NULL DEFAULT 1,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rep_codes (
    id TEXT PRIMARY KEY,
    rep_id TEXT NOT NULL REFERENCES reps(id),
    code TEXT NOT NULL UNIQUE COLLATE NOCASE,
    label TEXT NOT NULL DEFAULT '',            -- campaign name, admin only
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_rep_codes_rep ON rep_codes (rep_id);
  -- A customer (real mailbox, see normalEmail) stays with the rep whose code they first paid with.
  CREATE TABLE IF NOT EXISTS rep_customers (
    email_key TEXT PRIMARY KEY,
    rep_id TEXT NOT NULL REFERENCES reps(id),
    first_order_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rep_payouts (
    id TEXT PRIMARY KEY,
    rep_id TEXT NOT NULL REFERENCES reps(id),
    amount_cents INTEGER NOT NULL,
    reference TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    paid_at TEXT NOT NULL
  );
  -- kind 'sale': 50% (or the rep's rate then) of the order profit, frozen when the order is paid.
  -- kind 'reversal': a negative row for a refunded order whose sale commission was already paid out.
  -- status: pending (48 h hold) -> payable -> paid; a sale can also end as reversed.
  CREATE TABLE IF NOT EXISTS rep_commissions (
    id TEXT PRIMARY KEY,
    rep_id TEXT NOT NULL REFERENCES reps(id),
    code TEXT NOT NULL DEFAULT '',
    order_id TEXT NOT NULL,
    order_number TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'sale' CHECK (kind IN ('sale','reversal')),
    sale_cents INTEGER NOT NULL DEFAULT 0,      -- what the customer paid
    profit_cents INTEGER NOT NULL DEFAULT 0,    -- order profit at the time
    percent REAL NOT NULL DEFAULT 0,
    commission_cents INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','payable','paid','reversed')),
    earned_at TEXT NOT NULL,
    payable_at TEXT NOT NULL,
    payout_id TEXT,
    note TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_rep_comm_rep ON rep_commissions (rep_id, status);
  CREATE INDEX IF NOT EXISTS idx_rep_comm_order ON rep_commissions (order_id);
  CREATE TABLE IF NOT EXISTS rep_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS rep_statements (
    rep_id TEXT NOT NULL,
    month TEXT NOT NULL,                        -- YYYY-MM (SAST)
    sent_at TEXT NOT NULL,
    PRIMARY KEY (rep_id, month)
  );
`;
export const COLUMNS = [
  ['orders', 'rep_id', "TEXT NOT NULL DEFAULT ''"],
  ['orders', 'rep_code', "TEXT NOT NULL DEFAULT ''"],
];
