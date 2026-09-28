// Customer accounts: register -> verify email -> log in, password reset,
// the storefront account page (/api/account/...) and the admin Clients and
// Registered users views. Ported from lapanza3d (server/clients.js and the
// /api/client routes), adapted to Procom:
//  - a clients row is a registered login only; guests have no row and the
//    admin Clients view groups orders by email instead;
//  - sessions live in SQLite (client_sessions), separate from admin sessions;
//  - session, verification and reset tokens are stored as SHA-256 hashes;
//  - no response ever reveals whether an email has an account (register,
//    login and forgot-password answer the same either way; the real owner
//    is told by email instead).
import bcrypt from 'bcryptjs';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { getDb } from '../db.js';
import { sendMail, layout } from '../mailer.js';
import { escapeHtml } from '../util.js';

export const CLIENT_COOKIE = 'procom_client_session';
export const CLIENT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24 h
const RESET_TTL_MS = 60 * 60 * 1000; // 1 h (re-requestable any time)
const FINISH_TTL_MS = 24 * 60 * 60 * 1000; // "finish your account" link sent on a repeat registration
const MIN_PASSWORD = 8;
const BCRYPT_ROUNDS = 11;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// What customers see -- never "Ordered from supplier" (dropshipping stays behind the scenes).
const CUSTOMER_STATUS = {
  pending_payment: 'Awaiting payment',
  paid: 'Payment received',
  ordered: 'Being processed',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

const httpError = (status, message) => Object.assign(new Error(message), { status });
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
export const normEmail = (v) => str(v, 160).toLowerCase();
const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');
const newToken = () => randomBytes(32).toString('hex');
const nowIso = () => new Date().toISOString();
const isToken = (t) => typeof t === 'string' && /^[a-f0-9]{64}$/.test(t);

function assertPassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) throw httpError(400, `Password must be at least ${MIN_PASSWORD} characters`);
  if (pw.length > 200) throw httpError(400, 'Password is too long');
}

const PROFILE_FIELDS = {
  firstName: 'first_name',
  lastName: 'last_name',
  phone: 'phone',
  addressLine1: 'address_line1',
  addressLine2: 'address_line2',
  suburb: 'suburb',
  city: 'city',
  province: 'province',
  postalCode: 'postal_code',
};

function rowToClient(r) {
  if (!r) return null;
  return {
    id: r.id,
    email: r.email,
    firstName: r.first_name,
    lastName: r.last_name,
    phone: r.phone,
    addressLine1: r.address_line1,
    addressLine2: r.address_line2,
    suburb: r.suburb,
    city: r.city,
    province: r.province,
    postalCode: r.postal_code,
    emailVerified: Boolean(r.email_verified),
    verifiedAt: r.verified_at || null,
    disabled: Boolean(r.disabled),
    newsletter: Boolean(r.newsletter_opt_in),
    newsletterAt: r.newsletter_opted_in_at || null,
    lastLoginAt: r.last_login_at || null,
    createdAt: r.created_at,
  };
}

const rowById = (id, db) => db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
const rowByEmail = (email, db) => (email ? db.prepare('SELECT * FROM clients WHERE email = ?').get(normEmail(email)) : undefined);

export function getClient(id, db = getDb()) {
  return rowToClient(rowById(id, db));
}

// Links every guest order placed with this email to the client. Only called
// once the email is proven (verification or reset link).
export function linkOrdersByEmail(clientId, db = getDb()) {
  const row = rowById(clientId, db);
  if (!row) return 0;
  return db.prepare('UPDATE orders SET client_id = ? WHERE lower(email) = ? AND client_id IS NULL').run(row.id, row.email).changes;
}

// Hook (orders.js createOrder): an order placed with a verified account's
// email -- as a guest or logged in -- lands in that account.
export function onOrderCreated(order, db = getDb()) {
  if (!order?.id || !order.email) return;
  try {
    const row = db.prepare('SELECT id FROM clients WHERE email = ? AND email_verified = 1').get(normEmail(order.email));
    if (row) db.prepare('UPDATE orders SET client_id = ? WHERE id = ? AND client_id IS NULL').run(row.id, order.id);
  } catch (err) {
    console.error('Linking order to client failed:', err.message); // never fail a checkout over this
  }
}

// ------------------------------------------------------------ account logic

// Always hashes the password (even when the email is taken) so timing is the
// same for every outcome. Returns what the route must email, never what it
// must answer -- the HTTP answer is identical in every case.
export function registerClient(input, db = getDb()) {
  const b = input || {};
  const email = normEmail(b.email);
  const firstName = str(b.firstName, 80);
  const lastName = str(b.lastName, 80);
  if (!firstName || !lastName) throw httpError(400, 'Please fill in your first name and surname');
  if (!EMAIL_RE.test(email)) throw httpError(400, 'Please enter a valid email address');
  assertPassword(b.password);
  const passwordHash = bcrypt.hashSync(b.password, BCRYPT_ROUNDS);
  const existing = rowByEmail(email, db);
  if (existing) {
    if (existing.disabled) return { kind: 'disabled', client: rowToClient(existing) };
    // Existing login: mail the owner a sign-in / reset link. An unverified
    // one gets a "finish setting up" link that sets the password -- so a
    // verified password is always one chosen by the mailbox owner.
    const token = newToken();
    const ttl = existing.email_verified ? RESET_TTL_MS : FINISH_TTL_MS;
    db.prepare('UPDATE clients SET reset_token_hash = ?, reset_expires_at = ?, updated_at = ? WHERE id = ?').run(hashToken(token), Date.now() + ttl, nowIso(), existing.id);
    return { kind: existing.email_verified ? 'exists' : 'unfinished', client: rowToClient(existing), token };
  }
  const id = randomUUID();
  const token = newToken();
  const ts = nowIso();
  const newsletter = b.newsletter === true || b.newsletter === 'on' || b.newsletter === '1';
  db.prepare(`INSERT INTO clients (id, email, password_hash, first_name, last_name, phone, newsletter_opt_in, newsletter_opted_in_at,
      verify_token_hash, verify_expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, email, passwordHash, firstName, lastName, str(b.phone, 30), newsletter ? 1 : 0, newsletter ? ts : null, hashToken(token), Date.now() + VERIFY_TTL_MS, ts, ts,
  );
  return { kind: 'created', client: getClient(id, db), token };
}

// Consumes a verification token. Returns the client or null (unknown/expired).
export function verifyEmail(token, db = getDb()) {
  if (!isToken(token)) return null;
  const row = db.prepare('SELECT * FROM clients WHERE verify_token_hash = ?').get(hashToken(token));
  if (!row) return null;
  if (!row.verify_expires_at || row.verify_expires_at < Date.now()) return null;
  db.prepare('UPDATE clients SET email_verified = 1, verified_at = COALESCE(verified_at, ?), verify_token_hash = NULL, verify_expires_at = NULL, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), row.id);
  linkOrdersByEmail(row.id, db);
  return getClient(row.id, db);
}

// Fresh verification token (old one invalidated). For login-while-unverified and the admin "resend".
export function newVerificationToken(id, db = getDb()) {
  const row = rowById(id, db);
  if (!row) return null;
  if (row.email_verified) throw httpError(400, 'This account is already verified');
  const token = newToken();
  db.prepare('UPDATE clients SET verify_token_hash = ?, verify_expires_at = ?, updated_at = ? WHERE id = ?').run(hashToken(token), Date.now() + VERIFY_TTL_MS, nowIso(), id);
  return { client: rowToClient(row), token };
}

// One bcrypt compare on every path so timing doesn't reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);
export function loginClient(email, password, db = getDb()) {
  const row = rowByEmail(normEmail(email), db);
  const ok = bcrypt.compareSync(String(password || ''), row ? row.password_hash : DUMMY_HASH);
  if (!row || !ok) return { ok: false, reason: 'invalid' };
  // Only reachable with the right password, so these don't leak anything.
  if (row.disabled) return { ok: false, reason: 'disabled' };
  if (!row.email_verified) return { ok: false, reason: 'unverified', client: rowToClient(row) };
  return { ok: true, client: getClient(row.id, db) };
}

// Null for unknown emails and disabled accounts; the route answers the same either way.
export function requestPasswordReset(email, db = getDb()) {
  const row = rowByEmail(normEmail(email), db);
  if (!row || row.disabled) return null;
  const token = newToken();
  db.prepare('UPDATE clients SET reset_token_hash = ?, reset_expires_at = ?, updated_at = ? WHERE id = ?').run(hashToken(token), Date.now() + RESET_TTL_MS, nowIso(), row.id);
  return { client: rowToClient(row), token };
}

// Sets the new password, marks the email verified (the link proves the
// mailbox), links guest orders and signs out every other session.
export function resetPassword(token, password, db = getDb()) {
  assertPassword(password);
  if (!isToken(token)) return null;
  const row = db.prepare('SELECT * FROM clients WHERE reset_token_hash = ?').get(hashToken(token));
  if (!row || row.disabled || !row.reset_expires_at || row.reset_expires_at < Date.now()) return null;
  const ts = nowIso();
  db.prepare(`UPDATE clients SET password_hash = ?, email_verified = 1, verified_at = COALESCE(verified_at, ?), reset_token_hash = NULL, reset_expires_at = NULL,
    verify_token_hash = NULL, verify_expires_at = NULL, updated_at = ? WHERE id = ?`).run(bcrypt.hashSync(password, BCRYPT_ROUNDS), ts, ts, row.id);
  db.prepare('DELETE FROM client_sessions WHERE client_id = ?').run(row.id);
  linkOrdersByEmail(row.id, db);
  return getClient(row.id, db);
}

export function changePassword(id, currentPassword, newPassword, db = getDb()) {
  assertPassword(newPassword);
  const row = rowById(id, db);
  if (!row || !bcrypt.compareSync(String(currentPassword || ''), row.password_hash)) throw httpError(400, 'Your current password is incorrect');
  db.prepare('UPDATE clients SET password_hash = ?, updated_at = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, BCRYPT_ROUNDS), nowIso(), id);
}

// Self-service profile: explicit allow-list (no email, verified or disabled flags).
export function updateProfile(id, body, db = getDb()) {
  const row = rowById(id, db);
  if (!row) return null;
  const b = body || {};
  const sets = [];
  const vals = [];
  for (const [key, col] of Object.entries(PROFILE_FIELDS)) {
    if (b[key] === undefined) continue;
    sets.push(`${col} = ?`);
    vals.push(str(b[key], key === 'phone' ? 30 : 160));
  }
  if (b.firstName !== undefined && !str(b.firstName)) throw httpError(400, 'First name is required');
  if (b.newsletter !== undefined) {
    const on = Boolean(b.newsletter);
    sets.push('newsletter_opt_in = ?', 'newsletter_opted_in_at = ?');
    vals.push(on ? 1 : 0, on ? (row.newsletter_opt_in ? row.newsletter_opted_in_at : nowIso()) : null);
  }
  if (sets.length) db.prepare(`UPDATE clients SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, nowIso(), id);
  return getClient(id, db);
}

export function listClientOrders(clientId, db = getDb()) {
  return db
    .prepare(`SELECT o.id, o.order_number, o.status, o.payment_status, o.total_cents, o.tracking_number, o.created_at, o.paid_at,
        (SELECT COALESCE(SUM(quantity), 0) FROM order_items i WHERE i.order_id = o.id) AS item_count
      FROM orders o WHERE o.client_id = ? ORDER BY o.created_at DESC LIMIT 200`)
    .all(clientId)
    .map((r) => {
      const paid = r.payment_status === 'paid';
      return {
        id: r.id,
        orderNumber: r.order_number,
        status: r.status,
        statusLabel: CUSTOMER_STATUS[r.status] || r.status,
        paid,
        totalCents: r.total_cents,
        itemCount: r.item_count,
        trackingNumber: r.tracking_number || '',
        createdAt: r.created_at,
        paidAt: r.paid_at || null,
        invoiceUrl: paid ? `/invoice.html?o=${encodeURIComponent(r.id)}` : null,
      };
    });
}

// ----------------------------------------------------------------- sessions

export function createClientSession(clientId, db = getDb()) {
  const token = newToken();
  const now = Date.now();
  db.prepare('DELETE FROM client_sessions WHERE expires_at < ?').run(now);
  db.prepare('INSERT INTO client_sessions (token_hash, client_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(hashToken(token), clientId, now, now + CLIENT_SESSION_TTL_MS);
  db.prepare('UPDATE clients SET last_login_at = ? WHERE id = ?').run(new Date(now).toISOString(), clientId);
  return token;
}

export function getClientBySession(token, db = getDb()) {
  if (!isToken(token)) return null;
  const row = db
    .prepare('SELECT c.*, s.expires_at AS session_expires FROM client_sessions s JOIN clients c ON c.id = s.client_id WHERE s.token_hash = ?')
    .get(hashToken(token));
  if (!row) return null;
  if (row.session_expires < Date.now() || row.disabled || !row.email_verified) {
    db.prepare('DELETE FROM client_sessions WHERE token_hash = ?').run(hashToken(token));
    return null;
  }
  return rowToClient(row);
}

export function destroyClientSession(token, db = getDb()) {
  if (isToken(token)) db.prepare('DELETE FROM client_sessions WHERE token_hash = ?').run(hashToken(token));
}

// For other features (e.g. invoices): the logged-in customer, or null.
export function getClientFromRequest(req, db = getDb()) {
  return getClientBySession(req.cookies?.[CLIENT_COOKIE], db);
}

// -------------------------------------------------------------- admin logic

// CRM: everyone who has ordered (grouped by email) or registered.
export function listCrmClients({ q = '', page = 1, pageSize = 50 } = {}, db = getDb()) {
  const byEmail = new Map();
  const orderRows = db
    .prepare(`SELECT lower(email) AS em, COUNT(*) AS orders,
        SUM(CASE WHEN payment_status = 'paid' THEN 1 ELSE 0 END) AS paid_orders,
        SUM(CASE WHEN payment_status = 'paid' THEN total_cents ELSE 0 END) AS spent,
        MAX(CASE WHEN payment_status = 'paid' THEN created_at END) AS last_paid,
        MAX(created_at) AS last_order
      FROM orders GROUP BY lower(email)`)
    .all();
  // Latest order's name/phone per email (for guests).
  const latest = db.prepare('SELECT first_name, last_name, phone, email FROM orders WHERE lower(email) = ? ORDER BY created_at DESC LIMIT 1');
  for (const r of orderRows) {
    const l = latest.get(r.em) || {};
    byEmail.set(r.em, {
      email: r.em,
      name: `${l.first_name || ''} ${l.last_name || ''}`.trim(),
      phone: l.phone || '',
      orderCount: r.orders,
      paidOrderCount: r.paid_orders,
      totalSpentCents: r.spent,
      lastOrderAt: r.last_paid || r.last_order,
      registered: false,
      verified: false,
      clientId: null,
      createdAt: null,
    });
  }
  for (const c of db.prepare('SELECT * FROM clients').all()) {
    const e = byEmail.get(c.email) || { email: c.email, orderCount: 0, paidOrderCount: 0, totalSpentCents: 0, lastOrderAt: null, phone: '' };
    byEmail.set(c.email, {
      ...e,
      name: `${c.first_name} ${c.last_name}`.trim() || e.name || '',
      phone: c.phone || e.phone,
      registered: true,
      verified: Boolean(c.email_verified),
      disabled: Boolean(c.disabled),
      newsletter: Boolean(c.newsletter_opt_in),
      clientId: c.id,
      createdAt: c.created_at,
    });
  }
  let list = [...byEmail.values()];
  const needle = str(q).toLowerCase();
  if (needle) list = list.filter((c) => [c.email, c.name, c.phone].some((v) => String(v || '').toLowerCase().includes(needle)));
  list.sort((a, b) => String(b.lastOrderAt || b.createdAt || '').localeCompare(String(a.lastOrderAt || a.createdAt || '')));
  const size = Math.min(200, Math.max(1, Number(pageSize) || 50));
  const pages = Math.max(1, Math.ceil(list.length / size));
  const p = Math.min(pages, Math.max(1, Number(page) || 1));
  return {
    total: list.length,
    registered: list.filter((c) => c.registered).length,
    page: p,
    pages,
    items: list.slice((p - 1) * size, p * size),
  };
}

export function crmClientDetail(email, db = getDb()) {
  const em = normEmail(email);
  if (!em) return null;
  const client = rowToClient(rowByEmail(em, db));
  const orders = db
    .prepare(`SELECT o.*, (SELECT COALESCE(SUM(quantity), 0) FROM order_items i WHERE i.order_id = o.id) AS item_count
      FROM orders o WHERE lower(o.email) = ? OR (? IS NOT NULL AND o.client_id = ?) ORDER BY o.created_at DESC`)
    .all(em, client?.id ?? null, client?.id ?? null);
  if (!client && !orders.length) return null;
  const paid = orders.filter((o) => o.payment_status === 'paid');
  const last = orders[0];
  const addressOf = (o) => [o.address_line1, o.address_line2, o.suburb, o.city, o.province, o.postal_code].filter(Boolean).join(', ');
  return {
    email: em,
    name: client ? `${client.firstName} ${client.lastName}`.trim() : last ? `${last.first_name} ${last.last_name}`.trim() : '',
    phone: client?.phone || last?.phone || '',
    client,
    orderCount: orders.length,
    paidOrderCount: paid.length,
    totalSpentCents: paid.reduce((s, o) => s + o.total_cents, 0),
    lastOrderAt: last?.created_at || null,
    addresses: [...new Set(orders.map(addressOf).filter(Boolean))].slice(0, 5),
    orders: orders.map((o) => ({
      id: o.id,
      orderNumber: o.order_number,
      status: o.status,
      paymentStatus: o.payment_status,
      totalCents: o.total_cents,
      itemCount: o.item_count,
      createdAt: o.created_at,
      linked: Boolean(client && o.client_id === client.id),
    })),
  };
}

export function listRegisteredUsers(db = getDb()) {
  return db
    .prepare(`SELECT c.*, (SELECT COUNT(*) FROM orders o WHERE o.client_id = c.id) AS order_count
      FROM clients c ORDER BY c.created_at DESC`)
    .all()
    .map((r) => ({ ...rowToClient(r), orderCount: r.order_count }));
}

export function setClientDisabled(id, disabled, db = getDb()) {
  if (!rowById(id, db)) return null;
  db.prepare('UPDATE clients SET disabled = ?, updated_at = ? WHERE id = ?').run(disabled ? 1 : 0, nowIso(), id);
  if (disabled) db.prepare('DELETE FROM client_sessions WHERE client_id = ?').run(id);
  return getClient(id, db);
}

// Admin override for a customer who never got the email.
export function manuallyVerify(id, db = getDb()) {
  if (!rowById(id, db)) return null;
  db.prepare('UPDATE clients SET email_verified = 1, verified_at = COALESCE(verified_at, ?), verify_token_hash = NULL, verify_expires_at = NULL, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), id);
  linkOrdersByEmail(id, db);
  return getClient(id, db);
}

// Removes the login only. Orders stay (unlinked) and still show under Clients by email.
export function deleteClient(id, db = getDb()) {
  if (!rowById(id, db)) return false;
  db.transaction(() => {
    db.prepare('UPDATE orders SET client_id = NULL WHERE client_id = ?').run(id);
    db.prepare('DELETE FROM clients WHERE id = ?').run(id); // sessions cascade
  })();
  return true;
}

// ------------------------------------------------------------------- emails

const button = (href, label) =>
  `<p style="margin:22px 0"><a href="${escapeHtml(href)}" style="background:#1a1612;color:#f7f3eb;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:700;display:inline-block">${escapeHtml(label)}</a></p>`;
const small = (text) => `<p style="font-size:12px;color:#6a5f54;margin:0">${text}</p>`;
const hello = (c) => `<p style="margin:0 0 12px">Hi ${escapeHtml(c.firstName || 'there')},</p>`;

export function buildEmail(kind, client, { siteUrl, token }) {
  const accountUrl = `${siteUrl}/account.html`;
  switch (kind) {
    case 'verify': {
      const url = `${accountUrl}?verify=${token}`;
      return {
        subject: 'Confirm your email — Procom Solutions',
        html: layout('Confirm your email', `${hello(client)}<p style="margin:0">Thanks for creating a Procom Solutions account. Please confirm your email address to finish setting it up.</p>
          ${button(url, 'Confirm my email')}
          ${small(`This link works for 24 hours. If you didn't create an account, you can ignore this email.<br>Link not working? Copy this into your browser: ${escapeHtml(url)}`)}`),
      };
    }
    case 'exists': {
      const url = `${accountUrl}?reset=${token}`;
      return {
        subject: 'You already have a Procom Solutions account',
        html: layout('Your account', `${hello(client)}<p style="margin:0">Someone (hopefully you) tried to create a new account with this email address, but you already have one.</p>
          ${button(accountUrl, 'Log in')}
          <p style="margin:0 0 6px">Forgot your password? <a href="${escapeHtml(url)}" style="color:#c24b28">Choose a new one</a> (link valid for 1 hour).</p>
          ${small("If this wasn't you, you can ignore this email — your account hasn't changed.")}`),
      };
    }
    case 'unfinished': {
      const url = `${accountUrl}?reset=${token}`;
      return {
        subject: 'Finish setting up your Procom Solutions account',
        html: layout('Finish your account', `${hello(client)}<p style="margin:0">You started creating an account with this email address but haven't confirmed it yet. Choose your password to finish — this also confirms your email.</p>
          ${button(url, 'Choose my password')}
          ${small(`This link works for 24 hours. If you didn't ask for this, you can ignore this email.<br>Link not working? Copy this into your browser: ${escapeHtml(url)}`)}`),
      };
    }
    case 'reset': {
      const url = `${accountUrl}?reset=${token}`;
      return {
        subject: 'Reset your Procom Solutions password',
        html: layout('Password reset', `${hello(client)}<p style="margin:0">We received a request to reset the password for your Procom Solutions account.</p>
          ${button(url, 'Choose a new password')}
          ${small(`This link works for 1 hour. If you didn't ask for a reset, you can ignore this email — your password stays the same.<br>Link not working? Copy this into your browser: ${escapeHtml(url)}`)}`),
      };
    }
    default:
      throw new Error(`Unknown email ${kind}`);
  }
}

// ------------------------------------------------------------------- routes

export function register({ app, admin, wrap, rateLimit, express: _express, siteUrl = '', mail = sendMail }) {
  const base = String(siteUrl || '').replace(/\/$/, '');
  // Fire and forget: mail timing must not reveal which branch ran, and a mail outage must not fail the request.
  const send = (kind, client, token) => {
    const { subject, html } = buildEmail(kind, client, { siteUrl: base, token });
    Promise.resolve()
      .then(() => mail({ to: client.email, subject, html }))
      .catch((err) => console.error(`Account email (${kind}) failed:`, err.message));
  };

  const limiter = (windowMin, limit, what) =>
    rateLimit({ windowMs: windowMin * 60_000, limit, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: `Too many ${what} — please try again in ${windowMin} minutes` } });
  const registerLimiter = limiter(60, 10, 'sign-up attempts');
  const loginLimiter = limiter(15, 10, 'login attempts');
  const resetLimiter = limiter(15, 5, 'reset requests');
  const tokenLimiter = limiter(15, 20, 'attempts');

  const setCookie = (req, res, token) =>
    res.cookie(CLIENT_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: CLIENT_SESSION_TTL_MS, path: '/' });
  const clearCookie = (res) => res.clearCookie(CLIENT_COOKIE, { path: '/' });
  const startSession = (req, res, clientId) => setCookie(req, res, createClientSession(clientId));

  // Same-origin check on every account mutation (on top of SameSite=Lax).
  app.use('/api/account', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'GET') {
      const origin = req.get('origin');
      try {
        if (origin && new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Cross-origin request blocked' });
      } catch {
        return res.status(403).json({ error: 'Cross-origin request blocked' });
      }
    }
    next();
  });
  const requireClient = (req, res, next) => {
    const c = getClientFromRequest(req);
    if (!c) return res.status(401).json({ error: 'Please log in' });
    req.client = c;
    next();
  };

  const REGISTERED = { ok: true, message: "Thanks! We've sent you an email — click the link in it to confirm your address, then you can log in." };
  app.post('/api/account/register', registerLimiter, wrap((req, res) => {
    const b = req.body || {};
    if (b.website) return REGISTERED; // honeypot
    const out = registerClient(b);
    if (out.kind === 'created') send('verify', out.client, out.token);
    else if (out.kind === 'exists' || out.kind === 'unfinished') send(out.kind, out.client, out.token);
    res.status(201);
    return REGISTERED;
  }));

  app.post('/api/account/verify', tokenLimiter, wrap((req, res) => {
    const client = verifyEmail(req.body?.token);
    if (!client) throw httpError(400, 'This confirmation link is invalid or has expired. Log in and we will send you a new one.');
    if (client.disabled) throw httpError(403, 'This account has been disabled. Please contact us.');
    startSession(req, res, client.id);
    return { ok: true, client };
  }));

  app.post('/api/account/login', loginLimiter, wrap((req, res) => {
    const { email, password } = req.body || {};
    const r = loginClient(email, password);
    if (r.reason === 'disabled') throw httpError(403, 'This account has been disabled. Please contact us if you think this is a mistake.');
    if (r.reason === 'unverified') {
      const fresh = newVerificationToken(r.client.id);
      if (fresh) send('verify', fresh.client, fresh.token);
      throw httpError(403, "Please confirm your email address first — we've just sent you a new link.");
    }
    if (!r.ok) throw httpError(401, 'Incorrect email or password');
    startSession(req, res, r.client.id);
    return { ok: true, client: r.client };
  }));

  app.post('/api/account/logout', (req, res) => {
    destroyClientSession(req.cookies?.[CLIENT_COOKIE]);
    clearCookie(res);
    res.json({ ok: true });
  });

  const RESET_SENT = { ok: true, message: "If there's an account for that email, we've sent a link to reset the password. It works for 1 hour." };
  app.post('/api/account/forgot-password', resetLimiter, wrap((req) => {
    const email = normEmail(req.body?.email);
    if (!EMAIL_RE.test(email)) throw httpError(400, 'Please enter a valid email address');
    const r = requestPasswordReset(email);
    if (r) send('reset', r.client, r.token);
    return RESET_SENT;
  }));

  app.post('/api/account/reset-password', tokenLimiter, wrap((req, res) => {
    const client = resetPassword(req.body?.token, req.body?.password);
    if (!client) throw httpError(400, 'This reset link is invalid or has expired — please request a new one.');
    startSession(req, res, client.id);
    return { ok: true, client };
  }));

  app.get('/api/account/me', wrap((req) => {
    const client = getClientFromRequest(req);
    return client ? { authenticated: true, client } : { authenticated: false };
  }));
  app.put('/api/account/me', requireClient, wrap((req) => ({ ok: true, client: updateProfile(req.client.id, req.body || {}) })));
  app.put('/api/account/password', requireClient, loginLimiter, wrap((req, res) => {
    changePassword(req.client.id, req.body?.currentPassword, req.body?.newPassword);
    // Sign out other devices; keep this one.
    getDb().prepare('DELETE FROM client_sessions WHERE client_id = ?').run(req.client.id);
    startSession(req, res, req.client.id);
    return { ok: true };
  }));
  app.get('/api/account/orders', requireClient, wrap((req) => listClientOrders(req.client.id)));

  // ---- admin (mounted at /api/admin, already login + same-origin protected)
  const notFound = () => httpError(404, 'Not found');
  admin.get('/clients', wrap((req) => listCrmClients({ q: req.query.q, page: req.query.page })));
  admin.get('/clients/detail', wrap((req) => crmClientDetail(req.query.email) || (() => { throw notFound(); })()));
  admin.get('/registered-users', wrap(() => listRegisteredUsers()));
  admin.post('/registered-users/:id/resend-verification', wrap((req) => {
    const r = newVerificationToken(req.params.id);
    if (!r) throw notFound();
    send('verify', r.client, r.token);
    return { ok: true };
  }));
  admin.post('/registered-users/:id/verify', wrap((req) => manuallyVerify(req.params.id) || (() => { throw notFound(); })()));
  admin.post('/registered-users/:id/send-reset', wrap((req) => {
    const c = getClient(req.params.id);
    if (!c) throw notFound();
    const r = requestPasswordReset(c.email);
    if (!r) throw httpError(400, 'This account is disabled — enable it first');
    send('reset', r.client, r.token);
    return { ok: true };
  }));
  admin.put('/registered-users/:id/disabled', wrap((req) => setClientDisabled(req.params.id, Boolean(req.body?.disabled)) || (() => { throw notFound(); })()));
  admin.delete('/registered-users/:id', wrap((req) => {
    if (!deleteClient(req.params.id)) throw notFound();
    return { ok: true };
  }));
}
