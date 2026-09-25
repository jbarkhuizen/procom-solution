import path from 'path';

// Functions, not constants -- resolved per call so tests can chdir/override
// env. Same convention as the Lapanza backend.
export function dataDir() {
  return process.env.DATA_DIR || path.join(process.cwd(), 'data');
}

// Deliberately NOT under public/: Vite copies public/ into dist/ on every
// build, which would duplicate thousands of supplier photos per deploy.
export function uploadsDir() {
  return process.env.UPLOADS_DIR || path.join(dataDir(), 'uploads');
}

export function backupsDir() {
  return process.env.BACKUPS_DIR || path.join(dataDir(), 'backups');
}
