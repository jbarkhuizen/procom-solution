// Tables for the ops feature (see README.md). Imports nothing.
//
// ops_settings       key/value settings owned by this feature (off-site remote,
//                    last "Test connection" result). The env BACKUP_RCLONE_REMOTE
//                    overrides the stored remote.
// ops_offsite_syncs  one row per off-site copy attempt (automatic or "Sync now").
// version_history    one row per deployed git commit, recorded at server start
//                    when HEAD changed since the last row. Labels 1.0, 1.01, ...
// test_runs          "Run tests now" history from Admin -> Test cases.
// api_run_log        one row per supplier API run (Esquire / SMD): when, who started it,
//                    ok or failed, how long, a one-line overview. Kept 180 days.
export const SQL = `
  CREATE TABLE IF NOT EXISTS ops_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS ops_offsite_syncs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger TEXT NOT NULL DEFAULT 'manual',
    remote TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'running',
    backups_ok INTEGER NOT NULL DEFAULT 0,
    uploads_ok INTEGER NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT '',
    backup_file TEXT NOT NULL DEFAULT '',
    requested_by TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,
    finished_at TEXT,
    duration_ms INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_ops_offsite_started ON ops_offsite_syncs (started_at);

  CREATE TABLE IF NOT EXISTS version_history (
    id TEXT PRIMARY KEY,
    version_number INTEGER NOT NULL,
    version_label TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    previous_sha TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    commits_json TEXT NOT NULL DEFAULT '[]',
    commits_truncated INTEGER NOT NULL DEFAULT 0,
    node_version TEXT NOT NULL DEFAULT '',
    recorded_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_version_history_number ON version_history (version_number);

  CREATE TABLE IF NOT EXISTS test_runs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'running',
    requested_by TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,
    completed_at TEXT,
    duration_ms INTEGER,
    total_count INTEGER NOT NULL DEFAULT 0,
    passed_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    skipped_count INTEGER NOT NULL DEFAULT 0,
    output TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_test_runs_started ON test_runs (started_at);

  CREATE TABLE IF NOT EXISTS api_run_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier TEXT NOT NULL,              -- 'Esquire' | 'SMD'
    started_at TEXT NOT NULL,
    trigger TEXT NOT NULL DEFAULT 'scheduled',  -- scheduled | manual
    kind TEXT NOT NULL DEFAULT 'sync',   -- sync | check (SMD connection check, changes nothing)
    ok INTEGER NOT NULL DEFAULT 1,
    error TEXT NOT NULL DEFAULT '',
    seconds INTEGER NOT NULL DEFAULT 0,
    overview TEXT NOT NULL DEFAULT '',   -- one line for the list
    figures_json TEXT NOT NULL DEFAULT '[]'  -- [[label, value], ...] shown when a row is opened
  );
  CREATE INDEX IF NOT EXISTS idx_api_run_log_started ON api_run_log (started_at);
`;

export const COLUMNS = [];
