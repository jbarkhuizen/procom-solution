export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

export function formatRand(cents) {
  const amount = (Number(cents) || 0) / 100;
  const sign = amount < 0 ? '-' : '';
  const [whole, dec] = Math.abs(amount).toFixed(2).split('.');
  return `${sign}R ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${dec}`;
}

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Site settings are needed on every page (contact details, WhatsApp link);
// cache per tab so navigation doesn't refetch them.
let sitePromise = null;
export function getSite() {
  if (!sitePromise) {
    sitePromise = (async () => {
      try {
        const cached = sessionStorage.getItem('procom-site');
        if (cached) return JSON.parse(cached);
      } catch { /* storage blocked */ }
      const site = await api('/api/site');
      try { sessionStorage.setItem('procom-site', JSON.stringify(site)); } catch { /* ignore */ }
      return site;
    })().catch(() => null);
  }
  return sitePromise;
}

let catsPromise = null;
export function getCategories() {
  if (!catsPromise) catsPromise = api('/api/categories').catch(() => []);
  return catsPromise;
}

export function whatsappLink(site, text = 'Hello Procom Solutions, I am contacting you from your website.') {
  const num = String(site?.whatsappNumber || '27826639608').replace(/\D/g, '');
  return `https://api.whatsapp.com/send?phone=${num}&text=${encodeURIComponent(text)}`;
}
