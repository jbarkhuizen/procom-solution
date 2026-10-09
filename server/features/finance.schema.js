// Tables/columns for this feature (see README.md). Imports nothing.
//
// finance_settings   -- the finance feature's own settings (Payfast fee
//                       estimates, expense categories), JSON values. Kept out
//                       of the core DEFAULT_SETTINGS on purpose.
// finance_expenses   -- expenses captured by hand (one per supplier invoice /
//                       receipt), with line items in finance_expense_items.
//                       Money is integer cents, like the rest of Procom.
// finance_delivery_costs -- optional per-order override of what delivery
//                       really cost us (default: the fee the customer paid).
export const SQL = `
  -- A refund recorded when a paid order is cancelled (the money itself is returned in the
  -- Payfast dashboard). fee_lost_cents = the Payfast fee we paid on that order, which Payfast keeps.
  CREATE TABLE IF NOT EXISTS order_refunds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    fee_lost_cents INTEGER NOT NULL DEFAULT 0,
    reason TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_order_refunds_order ON order_refunds (order_id);

CREATE TABLE IF NOT EXISTS finance_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS finance_expenses (
  id TEXT PRIMARY KEY,
  payee TEXT NOT NULL,
  expense_date TEXT NOT NULL,              -- YYYY-MM-DD (South African date)
  reference TEXT NOT NULL DEFAULT '',      -- supplier invoice / receipt number
  payment_method TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  total_cents INTEGER NOT NULL DEFAULT 0,  -- sum of the lines
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_finance_expenses_date ON finance_expenses (expense_date);

CREATE TABLE IF NOT EXISTS finance_expense_items (
  id TEXT PRIMARY KEY,
  expense_id TEXT NOT NULL REFERENCES finance_expenses(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  quantity REAL NOT NULL DEFAULT 1,
  unit_cents INTEGER NOT NULL DEFAULT 0,
  line_cents INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_finance_expense_items_expense ON finance_expense_items (expense_id);

CREATE TABLE IF NOT EXISTS finance_delivery_costs (
  order_id TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  cost_cents INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
`;
export const COLUMNS = [
  // Fee Payfast deducted from this payment (ITN amount_fee, cents incl VAT);
  // NULL = not reported, Financial overview then estimates it.
  ['orders', 'payfast_fee_cents', 'INTEGER'],
];
