import bcrypt from 'bcryptjs';
import { randomBytes, randomUUID } from 'crypto';
import { getDb } from './db.js';

export const SESSION_COOKIE = 'procom_admin_session';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MIN_PASSWORD = 10;

function assertPassword(pw) {
  if (!pw || String(pw).length < MIN_PASSWORD) throw new Error(`Password must be at least ${MIN_PASSWORD} characters`);
}

export function hasAnyAdmin(db = getDb()) {
  return db.prepare('SELECT COUNT(*) n FROM admins').get().n > 0;
}

export function listAdmins(db = getDb()) {
  return db.prepare('SELECT id, username, email, created_at AS createdAt FROM admins ORDER BY created_at').all();
}

export function createAdmin({ username, password, email }, db = getDb()) {
  const u = String(username || '').trim();
  if (!/^[a-zA-Z0-9._@-]{3,60}$/.test(u)) throw new Error('Username must be 3-60 characters (letters, numbers, . _ @ -)');
  assertPassword(password);
  if (db.prepare('SELECT id FROM admins WHERE LOWER(username) = LOWER(?)').get(u)) throw new Error('Username already taken');
  const id = randomUUID();
  db.prepare('INSERT INTO admins (id, username, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    u,
    String(email || '').trim() || null,
    bcrypt.hashSync(String(password), 11),
    new Date().toISOString(),
  );
  return { id, username: u };
}

export function deleteAdmin(id, db = getDb()) {
  if (db.prepare('SELECT COUNT(*) n FROM admins').get().n <= 1) throw new Error('Cannot remove the last admin account');
  return db.prepare('DELETE FROM admins WHERE id = ?').run(id).changes > 0;
}

export function resetAdminPassword(id, password, db = getDb()) {
  assertPassword(password);
  const ok = db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(password), 11), id).changes > 0;
  // Kill existing sessions -- a reset is often a response to a leaked password.
  if (ok) db.prepare('DELETE FROM admin_sessions WHERE admin_id = ?').run(id);
  return ok;
}

// Constant-ish time: always runs one bcrypt compare, even for unknown users,
// so response timing doesn't reveal which usernames exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 11);
export function verifyLogin(identifier, password, db = getDb()) {
  const id = String(identifier || '').trim();
  const row = db.prepare('SELECT id, username, password_hash FROM admins WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)').get(id, id);
  const ok = bcrypt.compareSync(String(password || ''), row ? row.password_hash : DUMMY_HASH);
  return row && ok ? { id: row.id, username: row.username } : null;
}

export function createSession(adminId, db = getDb()) {
  const token = randomBytes(32).toString('hex');
  db.prepare('DELETE FROM admin_sessions WHERE created_at < ?').run(Date.now() - SESSION_TTL_MS);
  db.prepare('INSERT INTO admin_sessions (token, admin_id, created_at) VALUES (?, ?, ?)').run(token, adminId, Date.now());
  return token;
}

export function getSession(token, db = getDb()) {
  if (!token) return null;
  const row = db
    .prepare('SELECT s.token, s.created_at, a.id AS admin_id, a.username FROM admin_sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token = ?')
    .get(token);
  if (!row) return null;
  if (Date.now() - row.created_at >= SESSION_TTL_MS) {
    db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
    return null;
  }
  return { adminId: row.admin_id, username: row.username };
}

export function destroySession(token, db = getDb()) {
  if (token) db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
}
