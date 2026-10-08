// Where a visit came from: referrer host + campaign tags (utm_source / utm_medium /
// utm_campaign) -> a readable channel (owner 2026-10-08). Pure functions, no database.
// Used when a page view is stored, when the Analytics page groups visits, and
// when an order records the channel that brought the customer.

export const CHANNELS = {
  google: 'Google search',
  search: 'Other search engines',
  facebook: 'Facebook',
  instagram: 'Instagram',
  whatsapp: 'WhatsApp',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  x: 'X / Twitter',
  linkedin: 'LinkedIn',
  pinterest: 'Pinterest',
  reddit: 'Reddit',
  social: 'Other social',
  email: 'Email / newsletter',
  paid: 'Paid ads',
  other: 'Other websites',
  direct: 'Direct / no referrer',
};

const SEARCH_HOST = /(^|\.)(bing|duckduckgo|yahoo|ecosia|yandex|baidu|qwant|startpage|brave|search\.brave|ask|aol)\./;
const GOOGLE_HOST = /^(www\.)?google\.[a-z.]+$|^(www\.)?googleadservices\.com$/;
const SOCIAL = [
  ['facebook', /(^|\.)(facebook\.com|fb\.com|fb\.me|messenger\.com)$/],
  ['instagram', /(^|\.)instagram\.com$/],
  ['whatsapp', /(^|\.)(whatsapp\.com|wa\.me)$/],
  ['tiktok', /(^|\.)tiktok\.com$/],
  ['youtube', /(^|\.)(youtube\.com|youtu\.be)$/],
  ['x', /(^|\.)(twitter\.com|x\.com|t\.co)$/],
  ['linkedin', /(^|\.)(linkedin\.com|lnkd\.in)$/],
  ['pinterest', /(^|\.)pinterest\.[a-z.]+$/],
  ['reddit', /(^|\.)reddit\.com$/],
];
const MAIL_HOST = /(^|\.)(mail\.google\.com|outlook\.live\.com|outlook\.office\.com|mail\.yahoo\.com|webmail\.[a-z.]+)$/;
const PAID_MEDIUM = /^(cpc|ppc|paid|paidsearch|paid-search|paid_social|paidsocial|display|ads?|banner)$/;
const EMAIL_MEDIUM = /^(e-?mail|newsletter)$/;

// Search engines send no useful page; the referring page is only kept for other sites.
export const isSearchHost = (host) => GOOGLE_HOST.test(host) || SEARCH_HOST.test(host);

// { host, utmSource, utmMedium } -> { key, label }. Campaign tags win over the
// referrer: they are what the owner put on the link on purpose.
export function classifyChannel({ host = '', utmSource = '', utmMedium = '' } = {}) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  const src = String(utmSource || '').toLowerCase();
  const med = String(utmMedium || '').toLowerCase();
  const pick = (key) => ({ key, label: CHANNELS[key] });
  if (PAID_MEDIUM.test(med)) return pick('paid');
  if (EMAIL_MEDIUM.test(med) || src === 'newsletter' || src === 'email') return pick('email');
  for (const [key, re] of SOCIAL) if (src === key || (src && re.test(src)) || (!src && re.test(h))) return pick(key);
  if (src === 'google') return pick('google');
  if (src || med) return pick(med === 'social' ? 'social' : 'other');
  if (!h) return pick('direct');
  if (MAIL_HOST.test(h)) return pick('email');
  if (GOOGLE_HOST.test(h)) return pick('google');
  if (SEARCH_HOST.test(h)) return pick('search');
  for (const [key, re] of SOCIAL) if (re.test(h)) return pick(key);
  return pick('other');
}

const TAG_RE = /^[a-z0-9][a-z0-9 _.+%-]{0,59}$/;
// A campaign tag from a link: lower-case, 60 characters, plain characters only; '' if not.
export function cleanTag(v) {
  if (typeof v !== 'string') return '';
  let s = v.trim().toLowerCase();
  try {
    s = decodeURIComponent(s);
  } catch { /* keep as is */ }
  s = s.replace(/\+/g, ' ').replace(/\s+/g, ' ').slice(0, 60);
  return TAG_RE.test(s) ? s : '';
}

// Page on the referring site, without query or fragment: '/blog/best-printers'. '' if none/unsafe.
export function cleanRefPath(v) {
  if (typeof v !== 'string' || !v.startsWith('/') || v.startsWith('//')) return '';
  const p = v.split(/[?#]/)[0].slice(0, 120);
  return /^\/[A-Za-z0-9/_.~%+-]*$/.test(p) && p !== '/' ? p : '';
}

// Adds the newsletter campaign tags to every link in `html` that points at our
// own site (so visits from the email show as "Email / newsletter" with the
// campaign's name). Links that already carry utm_source are left alone.
export function addUtmToLinks(html, siteUrl, campaignName) {
  let base;
  try {
    base = new URL(siteUrl);
  } catch {
    return html;
  }
  const campaign = String(campaignName || 'newsletter').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'newsletter';
  return String(html).replace(/href="(https?:\/\/[^"]+)"/g, (whole, raw) => {
    try {
      const u = new URL(raw.replace(/&amp;/g, '&'));
      if (u.host !== base.host || u.searchParams.has('utm_source') || /unsubscribe/i.test(u.search)) return whole;
      u.searchParams.set('utm_source', 'newsletter');
      u.searchParams.set('utm_medium', 'email');
      u.searchParams.set('utm_campaign', campaign);
      return `href="${u.href.replace(/&/g, '&amp;')}"`;
    } catch {
      return whole;
    }
  });
}
