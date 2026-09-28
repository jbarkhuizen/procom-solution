// Customer accounts (server/features/accounts.js). Imports nothing.
//
// A clients row is a registered login only -- guests have no row; the admin
// "Clients" CRM view groups orders by email instead. Tokens (session,
// verification, reset) are stored as SHA-256 hashes, never in the clear.
// orders.client_id itself is added by db.js's COLUMN_MIGRATIONS.
export const SQL = `
  CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,                        -- trimmed + lowercased
    password_hash TEXT NOT NULL,
    first_name TEXT NOT NULL DEFAULT '',
    last_name TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    address_line1 TEXT NOT NULL DEFAULT '',
    address_line2 TEXT NOT NULL DEFAULT '',
    suburb TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    province TEXT NOT NULL DEFAULT '',
    postal_code TEXT NOT NULL DEFAULT '',
    email_verified INTEGER NOT NULL DEFAULT 0,
    verified_at TEXT,
    disabled INTEGER NOT NULL DEFAULT 0,
    newsletter_opt_in INTEGER NOT NULL DEFAULT 0,
    newsletter_opted_in_at TEXT,
    verify_token_hash TEXT,
    verify_expires_at INTEGER,
    reset_token_hash TEXT,
    reset_expires_at INTEGER,
    last_login_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_email ON clients (email);
  CREATE INDEX IF NOT EXISTS idx_clients_verify ON clients (verify_token_hash);
  CREATE INDEX IF NOT EXISTS idx_clients_reset ON clients (reset_token_hash);

  -- Separate from admin_sessions: a customer login never grants admin access.
  CREATE TABLE IF NOT EXISTS client_sessions (
    token_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_client_sessions_client ON client_sessions (client_id);

  CREATE INDEX IF NOT EXISTS idx_orders_client ON orders (client_id);
  CREATE INDEX IF NOT EXISTS idx_orders_email_lower ON orders (lower(email));
`;

export const COLUMNS = [];
