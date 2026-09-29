// Tables for the governance feature (see README.md). Imports nothing.
//
// audit_log: append-only trail of admin actions (Admin -> Audit log). actor is
// the admin username as text (not a foreign key) so a row still reads right
// after that admin account is removed, or for a failed sign-in with a
// username that never existed. details is a small JSON summary (<= ~1 KB)
// built from a whitelist -- never passwords, tokens, secrets, keys or file
// contents. Rows older than 12 months are pruned daily.
//
// todo_items: the owner's Todo / Backlog (Admin -> Todo / Backlog). number is
// the short display number ("#12"); status open | in_progress | done.
//
// governance_flags: one-time markers (e.g. "todo seed done") so a seeded item
// the owner deletes never comes back on the next restart.
export const SQL = `
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    area TEXT NOT NULL DEFAULT '',
    method TEXT NOT NULL DEFAULT '',
    path TEXT NOT NULL DEFAULT '',
    target_id TEXT NOT NULL DEFAULT '',
    status INTEGER,
    ok INTEGER NOT NULL DEFAULT 1,
    ip TEXT NOT NULL DEFAULT '',
    details TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log (actor);
  CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log (action);

  CREATE TABLE IF NOT EXISTS todo_items (
    id TEXT PRIMARY KEY,
    number INTEGER NOT NULL UNIQUE,
    title TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL DEFAULT 'medium',
    status TEXT NOT NULL DEFAULT 'open',
    area TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    date_added TEXT NOT NULL,
    done_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_todo_items_status ON todo_items (status);

  CREATE TABLE IF NOT EXISTS governance_flags (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '',
    set_at TEXT NOT NULL
  );
`;
export const COLUMNS = [];
