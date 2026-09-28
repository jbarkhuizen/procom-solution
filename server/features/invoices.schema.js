// Tables/columns for this feature (see README.md). Imports nothing.
//
// Invoice numbers live on orders (invoice_number / invoiced_at, added by the
// core migrations). This single-row counter holds the last number issued, so
// a number is never reused even if an order's invoice is ever cleared by hand.
// The unique index is a last line of defence against a duplicate number.
export const SQL = `
CREATE TABLE IF NOT EXISTS invoice_counter (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_number INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO invoice_counter (id, last_number) VALUES (1, 0);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_invoice_number ON orders(invoice_number) WHERE invoice_number != '';
CREATE INDEX IF NOT EXISTS idx_orders_invoiced_at ON orders(invoiced_at);
`;
export const COLUMNS = [];
