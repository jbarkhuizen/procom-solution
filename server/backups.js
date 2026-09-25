import fs from 'fs';
import path from 'path';
import { getDb } from './db.js';
import { backupsDir } from './paths.js';

const KEEP = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// better-sqlite3's online backup API: consistent snapshot while the app keeps serving.
export async function createBackup(reason = 'scheduled') {
  const dir = backupsDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `procom-${new Date().toISOString().replace(/[:.]/g, '-')}-${reason}.db`);
  await getDb().backup(file);
  prune();
  return { file: path.basename(file), size: fs.statSync(file).size };
}

export function listBackups() {
  const dir = backupsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { file: f, size: st.size, createdAt: st.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function prune() {
  const dir = backupsDir();
  for (const b of listBackups().slice(KEEP)) fs.unlinkSync(path.join(dir, b.file));
}

export function startBackupSchedule() {
  if (process.env.DISABLE_BACKUPS === '1') return;
  const latest = listBackups()[0];
  if (!latest || Date.now() - Date.parse(latest.createdAt) > DAY_MS) {
    createBackup('startup').catch((err) => console.error('Backup failed:', err.message));
  }
  setInterval(() => createBackup('scheduled').catch((err) => console.error('Backup failed:', err.message)), DAY_MS).unref();
}
