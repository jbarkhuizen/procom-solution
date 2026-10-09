// Per-ACCOUNT lockout on top of the per-address limit (audit 2026-10-08): 5 wrong passwords for one username lock that
// username for 15 minutes, however many addresses the guesses come from. Kept in memory; a restart clears it.
const failed = new Map(); // username -> { n, until }
export const LOCK_AFTER = 5;
export const LOCK_MS = 15 * 60_000;
const key = (u) => String(u || '').trim().toLowerCase().slice(0, 100);

export function loginLocked(username, now = Date.now()) {
  const f = failed.get(key(username));
  return Boolean(f && f.until > now);
}

// Call after every attempt: ok = the password was right.
export function noteLogin(username, ok, now = Date.now()) {
  const k = key(username);
  if (ok) return void failed.delete(k);
  const f = failed.get(k);
  const n = (f && f.n >= LOCK_AFTER && f.until <= now ? 0 : f?.n || 0) + 1; // a finished lock starts counting again
  failed.set(k, { n, until: n >= LOCK_AFTER ? now + LOCK_MS : 0 });
  if (failed.size > 5000) failed.delete(failed.keys().next().value);
}

export function _resetLoginGuard() {
  failed.clear();
}
