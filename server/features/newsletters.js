// Newsletters (Phase 2). Ported from lapanza3d (newsletter.js,
// newsletter-campaigns.js, newsletter-content.js), adapted to Procom:
//
//  - Audience is opt-in only: confirmed subscribers from the footer /
//    newsletter page (double opt-in: signup -> confirmation email -> click)
//    plus verified customer accounts that ticked the newsletter box
//    (clients.newsletter_opt_in, accounts feature). Suppressed addresses are
//    never emailed. Each opt-in keeps its time and source (POPIA).
//  - A campaign goes draft -> preview -> test email -> approve -> send.
//    Editing an approved campaign sends it back to draft (test again).
//  - Sending is throttled: a queue in newsletter_recipients, drained in small
//    batches by an unref'd setInterval started in register(), never more than
//    the daily cap (default 400 per South African day, all campaigns + tests).
//    State lives in SQLite, so a restart simply carries on; the cap resets at
//    SAST midnight and the queue continues the next day.
//  - Every email has a one-click unsubscribe link (newsletter.html?unsubscribe=<token>).
//    sendMail() doesn't take extra headers, so there is no List-Unsubscribe header yet.
//  - Content: a block editor (heading, text, image, button, product cards
//    with the live price incl. specials, divider) or plain text. Everything
//    is escaped server-side; only http(s) URLs are allowed.
import { createHash, randomBytes, randomUUID } from 'crypto';
import { getDb } from '../db.js';
import { getProduct, queryProducts } from '../catalog.js';
import { getSettings } from '../settings.js';
import { sendMail, layout } from '../mailer.js';
import { escapeHtml, formatRand } from '../util.js';

const httpError = (status, message) => Object.assign(new Error(message), { status });
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const normEmail = (v) => str(v, 160).toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');
const newToken = () => randomBytes(32).toString('hex');
const isToken = (t) => typeof t === 'string' && /^[a-f0-9]{64}$/.test(t);
const nowIso = (now = Date.now()) => new Date(now).toISOString();

const CONFIRM_TTL_MS = 7 * 24 * 60 * 60 * 1000; // confirmation link: 7 days
const CONFIRM_RESEND_MS = 10 * 60 * 1000; // at most one confirmation email per address per 10 min
const MAX_ATTEMPTS = 3; // per recipient, then 'failed'
const MAX_BLOCKS = 40;
const MAX_PRODUCTS_PER_BLOCK = 12;
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000; // South Africa: UTC+2, no DST
export const UNSUB_PLACEHOLDER = '__PROCOM_UNSUBSCRIBE_URL__';

// ---------------------------------------------------------------- settings

export const NEWSLETTER_DEFAULTS = { dailyCap: 400, batchSize: 20, paused: false };

export function getNewsletterSettings(db = getDb()) {
  const out = { ...NEWSLETTER_DEFAULTS };
  for (const r of db.prepare('SELECT key, value FROM newsletter_settings').all()) {
    if (!(r.key in out)) continue;
    try {
      out[r.key] = JSON.parse(r.value);
    } catch {
      /* keep default */
    }
  }
  return out;
}

export function updateNewsletterSettings(patch, db = getDb()) {
  const b = patch || {};
  const up = db.prepare('INSERT INTO newsletter_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const int = (v, min, max, label) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < min || n > max) throw httpError(400, `${label} must be between ${min} and ${max}`);
    return n;
  };
  db.transaction(() => {
    if (b.dailyCap !== undefined) up.run('dailyCap', JSON.stringify(int(b.dailyCap, 0, 2000, 'Daily limit')));
    if (b.batchSize !== undefined) up.run('batchSize', JSON.stringify(int(b.batchSize, 1, 100, 'Batch size')));
    if (b.paused !== undefined) up.run('paused', JSON.stringify(b.paused === true || b.paused === 'true' || b.paused === 1));
  })();
  return getNewsletterSettings(db);
}

// ------------------------------------------------------------ daily usage

export function sastDay(now = Date.now()) {
  return new Date(now + SAST_OFFSET_MS).toISOString().slice(0, 10);
}

export function usedToday(db = getDb(), now = Date.now()) {
  return db.prepare('SELECT attempts FROM newsletter_daily_usage WHERE day = ?').get(sastDay(now))?.attempts || 0;
}

function countAttempt(db, now) {
  db.prepare('INSERT INTO newsletter_daily_usage (day, attempts) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET attempts = attempts + 1').run(sastDay(now));
}

export function usageSummary(db = getDb(), now = Date.now()) {
  const s = getNewsletterSettings(db);
  const used = usedToday(db, now);
  return { day: sastDay(now), used, cap: s.dailyCap, remaining: Math.max(0, s.dailyCap - used), batchSize: s.batchSize, paused: s.paused };
}

// ------------------------------------------------------ audience / opt-in

// Addresses we may email, with where the consent came from. A suppression
// blocks an address; an 'unsubscribe' suppression is lifted by a later
// proven opt-in (confirmed link, or ticking the box while logged in).
const AUDIENCE_SQL = `
  SELECT email, source, opted_at FROM (
    SELECT email, 'subscriber' AS source, confirmed_at AS opted_at, 1 AS pri
      FROM newsletter_subscribers WHERE status = 'confirmed'
    UNION ALL
    SELECT email, 'account' AS source, newsletter_opted_in_at AS opted_at, 2 AS pri
      FROM clients WHERE newsletter_opt_in = 1 AND email_verified = 1 AND disabled = 0
  ) a
  WHERE NOT EXISTS (
    SELECT 1 FROM newsletter_suppressions s WHERE s.email = a.email
      AND (s.reason != 'unsubscribe' OR a.opted_at IS NULL OR s.created_at >= a.opted_at)
  )`;

export function listAudience(db = getDb()) {
  const rows = db.prepare(`${AUDIENCE_SQL} ORDER BY pri`).all();
  const byEmail = new Map();
  for (const r of rows) {
    const em = normEmail(r.email);
    if (em && !byEmail.has(em)) byEmail.set(em, { email: em, source: r.source, optedAt: r.opted_at });
  }
  return [...byEmail.values()];
}

export function isEligible(email, db = getDb()) {
  const em = normEmail(email);
  if (!em) return false;
  return Boolean(db.prepare(`SELECT 1 FROM (${AUDIENCE_SQL}) WHERE email = ? LIMIT 1`).get(em));
}

export function audienceCounts(db = getDb()) {
  const list = listAudience(db);
  return { total: list.length, subscribers: list.filter((a) => a.source === 'subscriber').length, accounts: list.filter((a) => a.source === 'account').length };
}

export function unsubToken(email, db = getDb()) {
  const em = normEmail(email);
  const row = db.prepare('SELECT token FROM newsletter_unsub_tokens WHERE email = ?').get(em);
  if (row) return row.token;
  const token = newToken();
  db.prepare('INSERT INTO newsletter_unsub_tokens (email, token, created_at) VALUES (?, ?, ?)').run(em, token, nowIso());
  return token;
}

const emailForUnsubToken = (token, db) => (isToken(token) ? db.prepare('SELECT email FROM newsletter_unsub_tokens WHERE token = ?').get(token)?.email || null : null);

const SOURCES = new Set(['footer', 'newsletter-page', 'checkout', 'account']);

// Returns what the route must email (or nothing). The HTTP answer is the
// same for every outcome, so the form never reveals who is subscribed.
export function subscribe(input, db = getDb(), now = Date.now()) {
  const email = normEmail(input?.email);
  if (!EMAIL_RE.test(email)) throw httpError(400, 'Please enter a valid email address');
  const source = SOURCES.has(input?.source) ? input.source : 'footer';
  const sup = db.prepare('SELECT reason FROM newsletter_suppressions WHERE email = ?').get(email);
  if (sup && sup.reason !== 'unsubscribe') return { action: 'none' }; // blocked by admin/bounce: never email it
  const existing = db.prepare('SELECT * FROM newsletter_subscribers WHERE email = ?').get(email);
  if (existing?.status === 'confirmed' && !sup) return { action: 'none' };
  if (existing?.confirm_sent_at && now - existing.confirm_sent_at < CONFIRM_RESEND_MS) return { action: 'none' };
  const token = newToken();
  const ts = nowIso(now);
  if (existing) {
    db.prepare(`UPDATE newsletter_subscribers SET status = CASE WHEN status = 'confirmed' THEN status ELSE 'pending' END, source = ?, subscribed_at = ?,
        confirm_token_hash = ?, confirm_expires_at = ?, confirm_sent_at = ?, updated_at = ? WHERE id = ?`)
      .run(source, ts, hashToken(token), now + CONFIRM_TTL_MS, now, ts, existing.id);
  } else {
    db.prepare(`INSERT INTO newsletter_subscribers (id, email, status, source, subscribed_at, confirm_token_hash, confirm_expires_at, confirm_sent_at, created_at, updated_at)
        VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), email, source, ts, hashToken(token), now + CONFIRM_TTL_MS, now, ts, ts);
  }
  return { action: 'confirm', email, token };
}

// Consumes a confirmation token. The click proves the mailbox, so it also
// lifts an earlier 'unsubscribe' suppression for this address.
export function confirmSubscription(token, db = getDb(), now = Date.now()) {
  if (!isToken(token)) return null;
  const row = db.prepare('SELECT * FROM newsletter_subscribers WHERE confirm_token_hash = ?').get(hashToken(token));
  if (!row || !row.confirm_expires_at || row.confirm_expires_at < now) return null;
  const ts = nowIso(now);
  db.transaction(() => {
    db.prepare(`UPDATE newsletter_subscribers SET status = 'confirmed', confirmed_at = ?, unsubscribed_at = NULL,
        confirm_token_hash = NULL, confirm_expires_at = NULL, updated_at = ? WHERE id = ?`).run(ts, ts, row.id);
    db.prepare("DELETE FROM newsletter_suppressions WHERE email = ? AND reason = 'unsubscribe'").run(row.email);
  })();
  return { email: row.email, token: unsubToken(row.email, db) };
}

// One-click unsubscribe: the subscriber row, the account opt-in and every
// queued email for the address stop, and the address is suppressed.
export function unsubscribeByToken(token, db = getDb(), now = Date.now()) {
  const email = emailForUnsubToken(token, db);
  if (!email) return null;
  unsubscribeEmail(email, 'unsubscribe', db, now);
  return { email };
}

export function unsubscribeEmail(email, reason = 'unsubscribe', db = getDb(), now = Date.now(), note = '') {
  const em = normEmail(email);
  const ts = nowIso(now);
  db.transaction(() => {
    db.prepare("UPDATE newsletter_subscribers SET status = 'unsubscribed', unsubscribed_at = ?, confirm_token_hash = NULL, confirm_expires_at = NULL, updated_at = ? WHERE email = ? AND status != 'unsubscribed'").run(ts, ts, em);
    db.prepare('UPDATE clients SET newsletter_opt_in = 0, newsletter_opted_in_at = NULL, updated_at = ? WHERE email = ? AND newsletter_opt_in = 1').run(ts, em);
    db.prepare('INSERT INTO newsletter_suppressions (email, reason, note, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET reason = excluded.reason, note = excluded.note, created_at = excluded.created_at')
      .run(em, reason, str(note, 300), ts);
    db.prepare("UPDATE newsletter_recipients SET status = 'skipped', error = 'Unsubscribed' WHERE email = ? AND status = 'queued'").run(em);
  })();
}

// "Subscribe again" from the unsubscribe page: the token came from an email
// to this address, so the mailbox is proven -- no second confirmation needed.
export function resubscribeByToken(token, db = getDb(), now = Date.now()) {
  const email = emailForUnsubToken(token, db);
  if (!email) return null;
  const sup = db.prepare('SELECT reason FROM newsletter_suppressions WHERE email = ?').get(email);
  if (sup && sup.reason !== 'unsubscribe') throw httpError(400, 'This address can’t be subscribed from here. Please contact us.');
  const ts = nowIso(now);
  db.transaction(() => {
    db.prepare("DELETE FROM newsletter_suppressions WHERE email = ? AND reason = 'unsubscribe'").run(email);
    const existing = db.prepare('SELECT id FROM newsletter_subscribers WHERE email = ?').get(email);
    if (existing) {
      db.prepare(`UPDATE newsletter_subscribers SET status = 'confirmed', source = 'resubscribe-link', subscribed_at = ?, confirmed_at = ?, unsubscribed_at = NULL,
          confirm_token_hash = NULL, confirm_expires_at = NULL, updated_at = ? WHERE id = ?`).run(ts, ts, ts, existing.id);
    } else {
      db.prepare(`INSERT INTO newsletter_subscribers (id, email, status, source, subscribed_at, confirmed_at, created_at, updated_at)
          VALUES (?, ?, 'confirmed', 'resubscribe-link', ?, ?, ?, ?)`).run(randomUUID(), email, ts, ts, ts, ts);
    }
  })();
  return { email };
}

export function statusByToken(token, db = getDb()) {
  const email = emailForUnsubToken(token, db);
  if (!email) return null;
  return { email: maskEmail(email), subscribed: isEligible(email, db) };
}

export function maskEmail(email) {
  const [user, domain = ''] = String(email).split('@');
  return `${user.slice(0, 2)}${'•'.repeat(Math.max(1, Math.min(6, user.length - 2)))}@${domain}`;
}

// --------------------------------------------------------------- content

// Absolute http(s) URL, or '' if unsafe. Site-relative paths ("/shop.html")
// are made absolute, since emails can't resolve relative links.
export function safeUrl(value, siteUrl = '') {
  const v = String(value ?? '').trim();
  if (!v) return '';
  if (v.startsWith('/') && !v.startsWith('//')) return siteUrl ? `${siteUrl}${v}` : '';
  if (!/^https?:\/\//i.test(v)) return '';
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}

const BLOCK_TYPES = new Set(['heading', 'text', 'image', 'button', 'products', 'divider']);

// Cleans admin input into the stored shape (drops unknown fields/types).
export function normaliseBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks.slice(0, MAX_BLOCKS).filter((b) => b && BLOCK_TYPES.has(b.type)).map((b) => {
    switch (b.type) {
      case 'heading': return { type: 'heading', text: str(b.text, 200) };
      case 'text': return { type: 'text', text: String(b.text ?? '').slice(0, 5000) };
      case 'image': return { type: 'image', url: str(b.url, 1000), alt: str(b.alt, 200), link: str(b.link, 1000) };
      case 'button': return { type: 'button', text: str(b.text, 80), url: str(b.url, 1000) };
      case 'products': return { type: 'products', ids: (Array.isArray(b.ids) ? b.ids : []).map((id) => str(id, 64)).filter(Boolean).slice(0, MAX_PRODUCTS_PER_BLOCK) };
      default: return { type: 'divider' };
    }
  });
}

const P = 'font:15px/1.6 Arial,sans-serif;color:#38332d;margin:0 0 14px';
const linkify = (escaped) => escaped.replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)]/g, (u) => `<a href="${u}" style="color:#c24b28">${u}</a>`);
const paragraphs = (text) =>
  String(text || '')
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p style="${P}">${linkify(escapeHtml(p)).replace(/\n/g, '<br>')}</p>`)
    .join('');

function productRows(ids, { siteUrl, db, warnings }) {
  const rows = [];
  const textLines = [];
  for (const id of ids) {
    const active = db.prepare('SELECT active FROM products WHERE id = ?').get(id);
    const p = active?.active ? getProduct(id, { admin: false }, db) : null;
    if (!p) {
      warnings.push(`A product in the email is no longer in the shop and was left out (${id}).`);
      continue;
    }
    const url = `${siteUrl}/product.html?p=${encodeURIComponent(p.slug)}`;
    const img = safeUrl(p.image, siteUrl);
    const min = p.minOrderQty || 1;
    const price = min > 1
      ? `${formatRand(p.priceCents * min)} <span style="font-size:12px;color:#6a5f54">per ${min}</span>`
      : `${formatRand(p.priceCents)}${p.onSpecial && p.compareAtCents > p.priceCents ? ` <s style="font-size:12px;color:#6a5f54">${formatRand(p.compareAtCents)}</s>` : ''}`;
    rows.push(`<tr>
      <td style="width:104px;padding:10px 12px 10px 0;vertical-align:top">${img ? `<a href="${escapeHtml(url)}"><img src="${escapeHtml(img)}" alt="${escapeHtml(p.name)}" width="96" style="display:block;width:96px;max-width:96px;height:auto;border:1px solid #e5ddd0;border-radius:4px"></a>` : ''}</td>
      <td style="padding:10px 0;vertical-align:top;font:14px/1.4 Arial,sans-serif;color:#1a1612">
        ${p.brand ? `<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#6a5f54">${escapeHtml(p.brand)}</div>` : ''}
        <div style="font-weight:700;margin:2px 0 4px"><a href="${escapeHtml(url)}" style="color:#1a1612;text-decoration:none">${escapeHtml(p.name)}</a></div>
        <div style="color:#c24b28;font-weight:700;margin:0 0 6px">${price}${p.onSpecial ? ' <span style="background:#c24b28;color:#fff;font-size:11px;padding:1px 6px;border-radius:999px">Special</span>' : ''}</div>
        <a href="${escapeHtml(url)}" style="font-size:13px;color:#c24b28">View product &rsaquo;</a>
      </td></tr>`);
    textLines.push(`${p.name} — ${min > 1 ? `${formatRand(p.priceCents * min)} per ${min}` : formatRand(p.priceCents)}: ${url}`);
  }
  if (!rows.length) return { html: '', text: '' };
  return { html: `<table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 16px;border-top:1px solid #e5ddd0">${rows.join('')}</table>`, text: textLines.join('\n') };
}

// Renders stored content into the email body (without the footer). Product
// prices are read live, so they are current when each batch goes out.
export function renderContent({ mode, blocks, bodyText }, { siteUrl = '', db = getDb() } = {}) {
  const warnings = [];
  if (mode === 'text') {
    const text = String(bodyText || '').trim();
    if (!text) throw httpError(400, 'Write the email text first');
    return { html: paragraphs(text), text, warnings };
  }
  const list = normaliseBlocks(blocks);
  if (!list.length) throw httpError(400, 'Add at least one block');
  const html = [];
  const text = [];
  list.forEach((b, i) => {
    const n = `Block ${i + 1}`;
    switch (b.type) {
      case 'heading':
        if (!b.text) throw httpError(400, `${n}: the heading is empty`);
        html.push(`<h2 style="font:700 22px/1.3 Arial,sans-serif;color:#1a1612;margin:0 0 14px">${escapeHtml(b.text)}</h2>`);
        text.push(b.text.toUpperCase());
        break;
      case 'text':
        if (!b.text.trim()) throw httpError(400, `${n}: the text is empty`);
        html.push(paragraphs(b.text));
        text.push(b.text.trim());
        break;
      case 'image': {
        const src = safeUrl(b.url, siteUrl);
        if (!src) throw httpError(400, `${n}: the image needs a web address starting with https://`);
        const link = b.link ? safeUrl(b.link, siteUrl) : '';
        if (b.link && !link) throw httpError(400, `${n}: the image link must start with https://`);
        const img = `<img src="${escapeHtml(src)}" alt="${escapeHtml(b.alt)}" style="display:block;max-width:100%;height:auto;margin:0 0 16px;border:0;border-radius:4px">`;
        html.push(link ? `<a href="${escapeHtml(link)}">${img}</a>` : img);
        break;
      }
      case 'button': {
        const url = safeUrl(b.url, siteUrl);
        if (!b.text || !url) throw httpError(400, `${n}: a button needs a label and a link starting with https:// or /`);
        html.push(`<p style="margin:6px 0 20px"><a href="${escapeHtml(url)}" style="background:#1a1612;color:#f7f3eb;text-decoration:none;padding:12px 22px;border-radius:999px;font:700 14px Arial,sans-serif;display:inline-block">${escapeHtml(b.text)}</a></p>`);
        text.push(`${b.text}: ${url}`);
        break;
      }
      case 'products': {
        if (!b.ids.length) throw httpError(400, `${n}: choose at least one product`);
        const r = productRows(b.ids, { siteUrl, db, warnings });
        html.push(r.html);
        if (r.text) text.push(r.text);
        break;
      }
      default:
        html.push('<hr style="border:0;border-top:1px solid #e5ddd0;margin:20px 0">');
    }
  });
  return { html: html.join(''), text: text.join('\n\n'), warnings };
}

function footer(unsubUrl, test) {
  const s = getSettings();
  return `<div style="border-top:1px solid #e5ddd0;margin-top:22px;padding-top:14px;font:12px/1.5 Arial,sans-serif;color:#6a5f54">
    <p style="margin:0 0 6px">You're receiving this because you asked ${escapeHtml(s.siteName || 'Procom Solutions')} for emails about specials and new products.</p>
    <p style="margin:0">${test ? 'Test email — the unsubscribe link below is disabled. ' : ''}<a href="${unsubUrl}" style="color:#c24b28">Unsubscribe with one click</a></p>
  </div>`;
}

// Full email for one campaign. The unsubscribe URL stays a placeholder so
// the body is rendered once per batch and personalised per recipient.
export function buildCampaignEmail(campaign, { siteUrl = '', db = getDb(), test = false } = {}) {
  const body = renderContent(campaign, { siteUrl, db });
  const html = layout(campaign.subject, `${body.html}${footer(UNSUB_PLACEHOLDER, test)}`);
  return { subject: `${test ? '[TEST] ' : ''}${campaign.subject}`, html, text: body.text, warnings: body.warnings };
}

const unsubUrlFor = (siteUrl, token) => `${siteUrl}/newsletter.html?unsubscribe=${token}`;

// ------------------------------------------------------------- campaigns

function rowToCampaign(r, db) {
  if (!r) return null;
  const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM newsletter_recipients WHERE campaign_id = ? GROUP BY status').all(r.id).map((x) => [x.status, x.n]));
  const c = { queued: 0, sending: 0, sent: 0, failed: 0, skipped: 0, ...counts };
  return {
    id: r.id,
    subject: r.subject,
    mode: r.mode,
    blocks: JSON.parse(r.blocks_json || '[]'),
    bodyText: r.body_text,
    status: r.status,
    testSentAt: r.test_sent_at,
    testSentTo: r.test_sent_to,
    approvedAt: r.approved_at,
    approvedBy: r.approved_by,
    queuedAt: r.queued_at,
    finishedAt: r.finished_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    counts: c,
    recipients: c.queued + c.sending + c.sent + c.failed + c.skipped,
  };
}

export function getCampaign(id, db = getDb()) {
  return rowToCampaign(db.prepare('SELECT * FROM newsletter_campaigns WHERE id = ?').get(id), db);
}

export function listCampaigns(db = getDb()) {
  return db.prepare('SELECT * FROM newsletter_campaigns ORDER BY created_at DESC').all().map((r) => rowToCampaign(r, db));
}

function contentFrom(b) {
  const mode = b.mode === 'text' ? 'text' : 'blocks';
  return { mode, blocks: mode === 'blocks' ? normaliseBlocks(b.blocks) : [], bodyText: mode === 'text' ? String(b.bodyText ?? '').slice(0, 20000) : '' };
}

export function saveCampaign(input, id = null, { by = '', db = getDb(), now = Date.now() } = {}) {
  const b = input || {};
  const subject = str(b.subject, 150);
  if (!subject) throw httpError(400, 'The subject is required');
  const content = contentFrom(b);
  const ts = nowIso(now);
  if (id) {
    const cur = getCampaign(id, db);
    if (!cur) return null;
    if (!['draft', 'approved'].includes(cur.status)) throw httpError(400, 'A campaign can’t be edited once sending has started');
    // Any edit needs a fresh test + approval.
    db.prepare(`UPDATE newsletter_campaigns SET subject = ?, mode = ?, blocks_json = ?, body_text = ?, status = 'draft',
        test_sent_at = NULL, test_sent_to = NULL, approved_at = NULL, approved_by = NULL, updated_at = ? WHERE id = ?`)
      .run(subject, content.mode, JSON.stringify(content.blocks), content.bodyText, ts, id);
    return getCampaign(id, db);
  }
  const newId = randomUUID();
  db.prepare(`INSERT INTO newsletter_campaigns (id, subject, mode, blocks_json, body_text, status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)`).run(newId, subject, content.mode, JSON.stringify(content.blocks), content.bodyText, str(by, 80), ts, ts);
  return getCampaign(newId, db);
}

export function deleteCampaign(id, db = getDb()) {
  const c = getCampaign(id, db);
  if (!c) return false;
  if (c.status === 'sending') throw httpError(400, 'Pause or cancel the campaign before deleting it');
  db.prepare('DELETE FROM newsletter_campaigns WHERE id = ?').run(id);
  return true;
}

export async function sendTest(id, to, { siteUrl = '', mail = sendMail, db = getDb(), now = Date.now() } = {}) {
  const c = getCampaign(id, db);
  if (!c) return null;
  const email = normEmail(to);
  if (!EMAIL_RE.test(email)) throw httpError(400, 'Enter a valid email address for the test');
  const { subject, html } = buildCampaignEmail(c, { siteUrl, db, test: true });
  countAttempt(db, now);
  const ok = await mail({ to: email, subject, html: html.split(UNSUB_PLACEHOLDER).join(escapeHtml(`${siteUrl}/newsletter.html?unsubscribe=test`)) });
  if (ok === false) throw httpError(502, 'The test email could not be sent (is email set up on the server?)');
  db.prepare('UPDATE newsletter_campaigns SET test_sent_at = ?, test_sent_to = ?, updated_at = ? WHERE id = ?').run(nowIso(now), email, nowIso(now), id);
  return getCampaign(id, db);
}

export function approveCampaign(id, { by = '', db = getDb(), siteUrl = '', now = Date.now() } = {}) {
  const c = getCampaign(id, db);
  if (!c) return null;
  if (c.status !== 'draft') throw httpError(400, 'Only a draft can be approved');
  if (!c.testSentAt) throw httpError(400, 'Send yourself a test email first, and check it, before approving');
  renderContent(c, { siteUrl, db }); // still valid?
  db.prepare("UPDATE newsletter_campaigns SET status = 'approved', approved_at = ?, approved_by = ?, updated_at = ? WHERE id = ?").run(nowIso(now), str(by, 80), nowIso(now), id);
  return getCampaign(id, db);
}

// Snapshots today's audience into the queue; the sender does the rest.
export function queueCampaign(id, { db = getDb(), now = Date.now() } = {}) {
  const c = getCampaign(id, db);
  if (!c) return null;
  if (c.status !== 'approved') throw httpError(400, 'Approve the campaign before sending it');
  const audience = listAudience(db);
  if (!audience.length) throw httpError(400, 'Nobody has opted in yet, so there is no one to send to');
  const ts = nowIso(now);
  db.transaction(() => {
    const ins = db.prepare("INSERT OR IGNORE INTO newsletter_recipients (campaign_id, email, source, status, queued_at) VALUES (?, ?, ?, 'queued', ?)");
    for (const a of audience) ins.run(id, a.email, a.source, ts);
    db.prepare("UPDATE newsletter_campaigns SET status = 'sending', queued_at = ?, updated_at = ? WHERE id = ?").run(ts, ts, id);
  })();
  return getCampaign(id, db);
}

export function pauseCampaign(id, db = getDb()) {
  const c = getCampaign(id, db);
  if (!c) return null;
  if (c.status !== 'sending') throw httpError(400, 'Only a sending campaign can be paused');
  db.prepare("UPDATE newsletter_campaigns SET status = 'paused', updated_at = ? WHERE id = ?").run(nowIso(), id);
  return getCampaign(id, db);
}

export function resumeCampaign(id, db = getDb()) {
  const c = getCampaign(id, db);
  if (!c) return null;
  if (c.status !== 'paused') throw httpError(400, 'Only a paused campaign can be resumed');
  db.prepare("UPDATE newsletter_campaigns SET status = 'sending', updated_at = ? WHERE id = ?").run(nowIso(), id);
  return getCampaign(id, db);
}

export function cancelCampaign(id, db = getDb(), now = Date.now()) {
  const c = getCampaign(id, db);
  if (!c) return null;
  if (!['sending', 'paused', 'approved'].includes(c.status)) throw httpError(400, 'This campaign can’t be cancelled');
  db.transaction(() => {
    db.prepare("UPDATE newsletter_recipients SET status = 'skipped', error = 'Cancelled' WHERE campaign_id = ? AND status = 'queued'").run(id);
    db.prepare("UPDATE newsletter_campaigns SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ?").run(nowIso(now), nowIso(now), id);
  })();
  return getCampaign(id, db);
}

export function retryFailed(id, db = getDb()) {
  const c = getCampaign(id, db);
  if (!c) return null;
  if (!['sent', 'sending', 'paused'].includes(c.status)) throw httpError(400, 'Nothing to retry');
  const n = db.prepare("UPDATE newsletter_recipients SET status = 'queued', attempts = 0, error = '' WHERE campaign_id = ? AND status = 'failed'").run(id).changes;
  if (!n) throw httpError(400, 'No failed emails to retry');
  if (c.status === 'sent') db.prepare("UPDATE newsletter_campaigns SET status = 'sending', finished_at = NULL, updated_at = ? WHERE id = ?").run(nowIso(), id);
  return getCampaign(id, db);
}

export function listCampaignRecipients(id, db = getDb()) {
  return db.prepare(`SELECT email, source, status, attempts, error, queued_at AS queuedAt, attempted_at AS attemptedAt, sent_at AS sentAt
      FROM newsletter_recipients WHERE campaign_id = ? ORDER BY id LIMIT 5000`).all(id);
}

// ----------------------------------------------------------------- sender

// A crash between "sending" and "sent" leaves rows we can't be sure about.
// They are marked failed (not re-sent) so nobody gets the email twice; an
// admin can still "Retry failed".
export function recoverInterrupted(db = getDb()) {
  return db.prepare("UPDATE newsletter_recipients SET status = 'failed', error = 'Interrupted by a server restart — may or may not have been delivered' WHERE status = 'sending'").run().changes;
}

let sending = false;

// Sends one batch: at most batchSize, never past the daily cap. Returns a summary.
export async function runSendBatch({ db = getDb(), mail = sendMail, siteUrl = '', now = () => Date.now() } = {}) {
  if (sending) return { skipped: 'busy' };
  sending = true;
  try {
    const s = getNewsletterSettings(db);
    if (s.paused) return { skipped: 'paused', sent: 0, failed: 0 };
    const remaining = Math.max(0, s.dailyCap - usedToday(db, now()));
    if (!remaining) return { skipped: 'cap', sent: 0, failed: 0 };
    const batch = db.prepare(`SELECT r.* FROM newsletter_recipients r JOIN newsletter_campaigns c ON c.id = r.campaign_id
        WHERE r.status = 'queued' AND c.status = 'sending' ORDER BY c.queued_at, r.id LIMIT ?`).all(Math.min(s.batchSize, remaining));
    const rendered = new Map();
    const broken = new Set();
    let sent = 0;
    let failed = 0;
    let skipped = 0;
    for (const r of batch) {
      const ts = now();
      if (!isEligible(r.email, db)) {
        db.prepare("UPDATE newsletter_recipients SET status = 'skipped', error = 'No longer opted in' WHERE id = ?").run(r.id);
        skipped++;
        continue;
      }
      if (broken.has(r.campaign_id)) continue;
      let email = rendered.get(r.campaign_id);
      if (!email) {
        try {
          email = buildCampaignEmail(getCampaign(r.campaign_id, db), { siteUrl, db });
        } catch (err) {
          // Content no longer renders (e.g. every product removed): stop this campaign.
          db.prepare("UPDATE newsletter_campaigns SET status = 'paused', updated_at = ? WHERE id = ?").run(nowIso(ts), r.campaign_id);
          console.error(`Newsletter ${r.campaign_id} paused: ${err.message}`);
          broken.add(r.campaign_id);
          continue;
        }
        rendered.set(r.campaign_id, email);
      }
      if (db.prepare('SELECT status FROM newsletter_campaigns WHERE id = ?').get(r.campaign_id)?.status !== 'sending') continue;
      db.prepare("UPDATE newsletter_recipients SET status = 'sending', attempts = attempts + 1, attempted_at = ? WHERE id = ?").run(nowIso(ts), r.id);
      countAttempt(db, ts);
      const url = escapeHtml(unsubUrlFor(siteUrl, unsubToken(r.email, db)));
      let ok = false;
      let error = '';
      try {
        ok = (await mail({ to: r.email, subject: email.subject, html: email.html.split(UNSUB_PLACEHOLDER).join(url) })) !== false;
        if (!ok) error = 'Not sent (mail failed or email not set up)';
      } catch (err) {
        error = str(err?.message || 'Send failed', 300);
      }
      if (ok) {
        db.prepare("UPDATE newsletter_recipients SET status = 'sent', sent_at = ?, error = '' WHERE id = ?").run(nowIso(now()), r.id);
        sent++;
      } else {
        const attempts = r.attempts + 1;
        db.prepare('UPDATE newsletter_recipients SET status = ?, error = ? WHERE id = ?').run(attempts >= MAX_ATTEMPTS ? 'failed' : 'queued', error, r.id);
        failed++;
      }
    }
    // A whole batch failing usually means SMTP is down: the next tick retries.
    const done = db.prepare(`SELECT c.id FROM newsletter_campaigns c WHERE c.status = 'sending'
        AND NOT EXISTS (SELECT 1 FROM newsletter_recipients r WHERE r.campaign_id = c.id AND r.status IN ('queued', 'sending'))`).all();
    for (const d of done) db.prepare("UPDATE newsletter_campaigns SET status = 'sent', finished_at = ?, updated_at = ? WHERE id = ?").run(nowIso(now()), nowIso(now()), d.id);
    return { sent, failed, skipped, finished: done.length };
  } finally {
    sending = false;
  }
}

// ------------------------------------------------------------ admin lists

export function listSubscribers(db = getDb()) {
  const sup = new Map(db.prepare('SELECT email, reason, created_at FROM newsletter_suppressions').all().map((s) => [s.email, s]));
  const eligible = new Set(listAudience(db).map((a) => a.email));
  const subs = db.prepare('SELECT * FROM newsletter_subscribers ORDER BY created_at DESC').all().map((r) => ({
    id: r.id,
    kind: 'subscriber',
    email: r.email,
    status: r.status,
    source: r.source,
    subscribedAt: r.subscribed_at,
    confirmedAt: r.confirmed_at,
    unsubscribedAt: r.unsubscribed_at,
    suppressed: sup.get(r.email)?.reason || '',
    receives: eligible.has(r.email),
  }));
  const accounts = db.prepare('SELECT id, email, first_name, last_name, email_verified, disabled, newsletter_opted_in_at FROM clients WHERE newsletter_opt_in = 1 ORDER BY newsletter_opted_in_at DESC').all().map((r) => ({
    id: r.id,
    kind: 'account',
    email: r.email,
    name: `${r.first_name} ${r.last_name}`.trim(),
    status: !r.email_verified ? 'unverified' : r.disabled ? 'disabled' : 'confirmed',
    source: 'account',
    subscribedAt: r.newsletter_opted_in_at,
    confirmedAt: r.email_verified ? r.newsletter_opted_in_at : null,
    suppressed: sup.get(r.email)?.reason || '',
    receives: eligible.has(r.email),
  }));
  return { subscribers: subs, accounts, audience: audienceCounts(db) };
}

export function deleteSubscriber(id, db = getDb()) {
  return db.prepare('DELETE FROM newsletter_subscribers WHERE id = ?').run(id).changes > 0;
}

export function listSuppressions(db = getDb()) {
  return db.prepare('SELECT email, reason, note, created_at AS createdAt FROM newsletter_suppressions ORDER BY created_at DESC').all();
}

export function addSuppression({ email, note }, db = getDb()) {
  const em = normEmail(email);
  if (!EMAIL_RE.test(em)) throw httpError(400, 'Enter a valid email address');
  unsubscribeEmail(em, 'admin', db, Date.now(), note);
  return listSuppressions(db);
}

export function removeSuppression(email, db = getDb()) {
  return db.prepare('DELETE FROM newsletter_suppressions WHERE email = ?').run(normEmail(email)).changes > 0;
}

const pickerItem = (p) => ({
  id: p.id, name: p.name, brand: p.brand, image: p.image, priceCents: p.priceCents, compareAtCents: p.compareAtCents, onSpecial: p.onSpecial, minOrderQty: p.minOrderQty, inStock: p.inStock,
});

// Product picker: search live products, or look up chosen ids (for names).
export function searchProducts({ q = '', ids = '' } = {}, db = getDb()) {
  if (ids) {
    return String(ids).split(',').slice(0, 50).map((id) => getProduct(str(id, 64), { admin: false }, db)).filter(Boolean).map(pickerItem);
  }
  return queryProducts({ q: str(q, 100), pageSize: 20, sort: 'name' }, db).items.map(pickerItem);
}

// ------------------------------------------------------------------ email

export function confirmationEmail(token, siteUrl) {
  const url = `${siteUrl}/newsletter.html?confirm=${token}`;
  return {
    subject: 'Please confirm your subscription — Procom Solutions',
    html: layout('Confirm your subscription', `<p style="margin:0 0 12px">Hi there,</p>
      <p style="margin:0">Please confirm that you'd like emails from Procom Solutions about specials and new products. We send a few a month at most, and every email has a one-click unsubscribe link.</p>
      <p style="margin:22px 0"><a href="${escapeHtml(url)}" style="background:#1a1612;color:#f7f3eb;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:700;display:inline-block">Yes, subscribe me</a></p>
      <p style="font-size:12px;color:#6a5f54;margin:0">This link works for 7 days. If you didn't ask for this, ignore this email — you won't be subscribed.<br>Link not working? Copy this into your browser: ${escapeHtml(url)}</p>`),
  };
}

// ----------------------------------------------------------------- routes

let timer = null;
let startTimer = null;

export function register({ app, admin, wrap, rateLimit, siteUrl = '', mail = sendMail, intervalMs = 60_000, autoStart = true }) {
  const base = String(siteUrl || '').replace(/\/$/, '');
  const db = () => getDb();

  // --- public (same-origin check on writes, like /api/account)
  app.use('/api/newsletter', (req, res, next) => {
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
  const limiter = (windowMin, limit) => rateLimit({ windowMs: windowMin * 60_000, limit, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: `Too many attempts — please try again in ${windowMin} minutes` } });
  const subscribeLimiter = limiter(15, 5);
  const tokenLimiter = limiter(15, 30);

  const SUBSCRIBED = { ok: true, message: 'Thanks! Please check your inbox and click the link in our email to confirm.' };
  app.post('/api/newsletter/subscribe', subscribeLimiter, wrap(async (req) => {
    const b = req.body || {};
    if (b.website) return SUBSCRIBED; // honeypot
    const out = subscribe(b);
    if (out.action === 'confirm') {
      const { subject, html } = confirmationEmail(out.token, base);
      Promise.resolve().then(() => mail({ to: out.email, subject, html })).catch((err) => console.error('Newsletter confirmation email failed:', err.message));
    }
    return SUBSCRIBED;
  }));
  app.post('/api/newsletter/confirm', tokenLimiter, wrap((req) => {
    const r = confirmSubscription(req.body?.token);
    if (!r) throw httpError(400, 'This confirmation link is invalid or has expired. Please sign up again.');
    return { ok: true, email: maskEmail(r.email), manageToken: r.token };
  }));
  app.post('/api/newsletter/unsubscribe', tokenLimiter, wrap((req) => {
    const r = unsubscribeByToken(req.body?.token);
    if (!r) throw httpError(400, 'This unsubscribe link is invalid. Please contact us and we’ll remove you by hand.');
    return { ok: true, email: maskEmail(r.email) };
  }));
  app.post('/api/newsletter/resubscribe', tokenLimiter, wrap((req) => {
    const r = resubscribeByToken(req.body?.token);
    if (!r) throw httpError(400, 'This link is invalid.');
    return { ok: true, email: maskEmail(r.email) };
  }));
  app.get('/api/newsletter/status', tokenLimiter, wrap((req) => statusByToken(req.query.token) || (() => { throw httpError(404, 'Link not recognised'); })()));

  // --- admin (mounted at /api/admin; login + same-origin handled by the core)
  const nf = (v) => {
    if (v == null || v === false) throw httpError(404, 'Not found');
    return v;
  };
  const who = (req) => req.admin?.username || '';
  admin.get('/newsletters/overview', wrap(() => ({ usage: usageSummary(db()), audience: audienceCounts(db()), campaigns: listCampaigns(db()) })));
  admin.put('/newsletters/settings', wrap((req) => {
    updateNewsletterSettings(req.body);
    return usageSummary(db());
  }));
  admin.get('/newsletters/products', wrap((req) => searchProducts({ q: req.query.q, ids: req.query.ids })));
  admin.post('/newsletters/preview', wrap((req) => {
    const b = req.body || {};
    // An unfinished draft is normal while typing: answer 200 with the problem as a warning.
    try {
      const e = buildCampaignEmail({ subject: str(b.subject, 150) || '(no subject)', ...contentFrom(b) }, { siteUrl: base, db: db() });
      return { html: e.html.split(UNSUB_PLACEHOLDER).join('#'), text: e.text, warnings: e.warnings };
    } catch (err) {
      if (err.status !== 400) throw err;
      return { html: '', text: '', warnings: [err.message] };
    }
  }));
  admin.get('/newsletters/campaigns/:id', wrap((req) => nf(getCampaign(req.params.id))));
  admin.get('/newsletters/campaigns/:id/recipients', wrap((req) => {
    nf(getCampaign(req.params.id));
    return listCampaignRecipients(req.params.id);
  }));
  admin.post('/newsletters/campaigns', wrap((req, res) => {
    res.status(201);
    return saveCampaign(req.body, null, { by: who(req) });
  }));
  admin.put('/newsletters/campaigns/:id', wrap((req) => nf(saveCampaign(req.body, req.params.id, { by: who(req) }))));
  admin.delete('/newsletters/campaigns/:id', wrap((req) => ({ ok: nf(deleteCampaign(req.params.id)) })));
  admin.post('/newsletters/campaigns/:id/test', wrap(async (req) => {
    let to = req.body?.to;
    if (!to) to = db().prepare('SELECT email FROM admins WHERE id = ?').get(req.admin?.adminId)?.email || getSettings().ownerNotifyEmail;
    return nf(await sendTest(req.params.id, to, { siteUrl: base, mail }));
  }));
  admin.post('/newsletters/campaigns/:id/approve', wrap((req) => nf(approveCampaign(req.params.id, { by: who(req), siteUrl: base }))));
  admin.post('/newsletters/campaigns/:id/send', wrap((req) => nf(queueCampaign(req.params.id))));
  admin.post('/newsletters/campaigns/:id/pause', wrap((req) => nf(pauseCampaign(req.params.id))));
  admin.post('/newsletters/campaigns/:id/resume', wrap((req) => nf(resumeCampaign(req.params.id))));
  admin.post('/newsletters/campaigns/:id/cancel', wrap((req) => nf(cancelCampaign(req.params.id))));
  admin.post('/newsletters/campaigns/:id/retry-failed', wrap((req) => nf(retryFailed(req.params.id))));
  admin.get('/newsletters/test-address', wrap((req) => ({ to: db().prepare('SELECT email FROM admins WHERE id = ?').get(req.admin?.adminId)?.email || getSettings().ownerNotifyEmail })));
  admin.get('/newsletters/subscribers', wrap(() => listSubscribers()));
  admin.delete('/newsletters/subscribers/:id', wrap((req) => ({ ok: nf(deleteSubscriber(req.params.id)) })));
  admin.get('/newsletters/suppressions', wrap(() => listSuppressions()));
  admin.post('/newsletters/suppressions', wrap((req) => addSuppression(req.body || {})));
  admin.delete('/newsletters/suppressions/:email', wrap((req) => ({ ok: nf(removeSuppression(req.params.email)) })));

  // --- throttled sender
  if (timer) clearInterval(timer);
  if (startTimer) clearTimeout(startTimer);
  timer = null;
  startTimer = null;
  if (autoStart) {
    try {
      const n = recoverInterrupted();
      if (n) console.warn(`Newsletters: ${n} email(s) interrupted by a restart were marked failed (use Retry failed to resend).`);
    } catch (err) {
      console.error('Newsletters: recovery failed:', err.message);
    }
    const tick = () => runSendBatch({ mail, siteUrl: base }).catch((err) => console.error('Newsletter batch failed:', err.message));
    timer = setInterval(tick, intervalMs);
    timer.unref?.();
    startTimer = setTimeout(tick, 5_000); // pick up where a restart left off
    startTimer.unref?.();
  }
}
