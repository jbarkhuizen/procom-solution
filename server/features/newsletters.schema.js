// Newsletters (server/features/newsletters.js). Imports nothing.
//
// Audience = confirmed footer/newsletter-page subscribers (double opt-in)
// + verified customer accounts with clients.newsletter_opt_in = 1, minus
// newsletter_suppressions. Every opt-in keeps its time and source (POPIA).
export const SQL = `
  CREATE TABLE IF NOT EXISTS newsletter_subscribers (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,                      -- trimmed + lowercased
    status TEXT NOT NULL DEFAULT 'pending',   -- pending | confirmed | unsubscribed
    source TEXT NOT NULL DEFAULT '',          -- where the opt-in came from: footer, newsletter-page, resubscribe-link
    subscribed_at TEXT NOT NULL,              -- when the signup form was (last) submitted
    confirmed_at TEXT,                        -- when the confirmation link was clicked
    unsubscribed_at TEXT,
    confirm_token_hash TEXT,                  -- SHA-256 of the confirmation token
    confirm_expires_at INTEGER,
    confirm_sent_at INTEGER,                  -- throttles repeat confirmation emails
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_newsletter_subscribers_email ON newsletter_subscribers (email);
  CREATE INDEX IF NOT EXISTS idx_newsletter_subscribers_confirm ON newsletter_subscribers (confirm_token_hash);

  -- One stable unsubscribe token per address (subscriber or account), used
  -- in every newsletter's one-click link. It can only unsubscribe/resubscribe.
  CREATE TABLE IF NOT EXISTS newsletter_unsub_tokens (
    email TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );

  -- Global do-not-send list. reason 'unsubscribe' is lifted by a later,
  -- proven opt-in; 'admin' and 'bounce' only by an admin.
  CREATE TABLE IF NOT EXISTS newsletter_suppressions (
    email TEXT PRIMARY KEY,
    reason TEXT NOT NULL DEFAULT 'unsubscribe',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS newsletter_campaigns (
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'blocks',      -- blocks | text
    blocks_json TEXT NOT NULL DEFAULT '[]',
    body_text TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',     -- draft | approved | sending | paused | sent | cancelled
    test_sent_at TEXT,
    test_sent_to TEXT,
    approved_at TEXT,
    approved_by TEXT,
    queued_at TEXT,
    finished_at TEXT,
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- The send queue. Survives restarts: the sender picks up 'queued' rows.
  CREATE TABLE IF NOT EXISTS newsletter_recipients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id TEXT NOT NULL REFERENCES newsletter_campaigns(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    source TEXT NOT NULL,                     -- subscriber | account
    status TEXT NOT NULL DEFAULT 'queued',    -- queued | sending | sent | failed | skipped
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '',
    queued_at TEXT NOT NULL,
    attempted_at TEXT,
    sent_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_newsletter_recipients_unique ON newsletter_recipients (campaign_id, email);
  CREATE INDEX IF NOT EXISTS idx_newsletter_recipients_status ON newsletter_recipients (status, campaign_id);

  -- Emails attempted per South African day (all campaigns + tests), for the daily cap.
  CREATE TABLE IF NOT EXISTS newsletter_daily_usage (
    day TEXT PRIMARY KEY,                     -- YYYY-MM-DD in SAST
    attempts INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS newsletter_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

export const COLUMNS = [];
