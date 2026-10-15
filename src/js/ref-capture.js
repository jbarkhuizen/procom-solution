// Sales partner links (?ref=CODE): remember the code for 30 days so checkout can fill it in.
// Only the code is stored (localStorage, this browser); the server decides if it is valid.
const KEY = 'procom-ref';
const DAYS = 30;
const OK = /^[A-Za-z0-9][A-Za-z0-9_-]{1,29}$/;

function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function rememberedRef() {
  return safe(() => {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!v || !OK.test(v.code) || Date.now() - v.t > DAYS * 86400_000) return '';
    return v.code.toUpperCase();
  }, '');
}

safe(() => {
  const code = new URLSearchParams(location.search).get('ref');
  if (code && OK.test(code)) localStorage.setItem(KEY, JSON.stringify({ code: code.toUpperCase(), t: Date.now() }));
});
