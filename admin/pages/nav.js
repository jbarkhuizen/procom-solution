// Admin sidebar: collapsible groups, "Find a page…" filter and a mobile menu.
//
// Built at load from the flat markup in admin/index.html (group label <p>,
// buttons, <hr> dividers), so any nav button added there later is picked up
// automatically. The existing .nav-btn elements are MOVED (not copied): the
// click handlers admin.js attached stay, and data-route values never change.
// - Click a group label (a real <button> with aria-expanded) to open/close it.
// - Open groups are remembered in localStorage (wrapped in try/catch).
// - The group holding the current route always opens on navigation.
// - Phone widths: the nav folds behind a "Menu" button showing the current page.
// DOM is built with createElement/textContent only (no HTML strings).

const STORE_KEY = 'procom-admin-nav-open';
const MOBILE = '(max-width: 980px)';

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'group';

function loadOpen() {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    return Array.isArray(v) ? new Set(v.map(String)) : null;
  } catch {
    return null;
  }
}
function saveOpen(set) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify([...set])); } catch { /* private mode etc. */ }
}
const currentRoute = () => location.hash.replace(/^#\/?/, '').split('/')[0] || 'dashboard';

function el(tag, attrs = {}, text) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
}

export default function register() {
  const sidebar = document.querySelector('.sidebar');
  const nav = sidebar?.querySelector('.sidebar-nav');
  if (!nav || nav.dataset.enhanced) return;
  nav.dataset.enhanced = '1';
  nav.id = nav.id || 'sidebar-nav';

  // ---- 1. regroup: label <p> starts a group; <hr> dividers go away.
  const groups = [];
  let cur = null;
  for (const child of [...nav.children]) {
    if (child.matches('.nav-group-label')) {
      cur = { name: child.textContent.trim(), buttons: [] };
      groups.push(cur);
      child.remove();
    } else if (child.matches('.nav-divider')) {
      child.remove();
    } else if (child.matches('.nav-btn')) {
      if (!cur) { cur = { name: 'Pages', buttons: [] }; groups.push(cur); }
      cur.buttons.push(child);
    }
  }

  const saved = loadOpen();
  const open = saved || new Set(['sales']);
  const byKey = new Map();

  for (const g of groups) {
    const key = slug(g.name);
    const wrap = el('div', { class: 'nav-group', 'data-group': key });
    const toggle = el('button', { type: 'button', class: 'nav-group-toggle', 'aria-expanded': 'false', 'aria-controls': `nav-group-${key}`, id: `nav-group-toggle-${key}` });
    toggle.append(el('span', { class: 'nav-chev', 'aria-hidden': 'true' }, '▾'), el('span', {}, g.name), el('span', { class: 'nav-group-meta', 'aria-hidden': 'true' }, String(g.buttons.length)));
    const items = el('div', { class: 'nav-group-items', id: `nav-group-${key}`, role: 'group', 'aria-labelledby': `nav-group-toggle-${key}` });
    items.append(...g.buttons);
    wrap.append(toggle, items);
    nav.append(wrap);
    byKey.set(key, { wrap, toggle, items, buttons: g.buttons });
    toggle.addEventListener('click', () => setGroup(key, toggle.getAttribute('aria-expanded') !== 'true', true));
  }

  function setGroup(key, isOpen, remember) {
    const g = byKey.get(key);
    if (!g) return;
    g.toggle.setAttribute('aria-expanded', String(isOpen));
    g.items.hidden = !isOpen;
    if (remember) {
      if (isOpen) open.add(key); else open.delete(key);
      saveOpen(open);
    }
  }
  for (const key of byKey.keys()) setGroup(key, open.has(key), false);

  // ---- 2. "Find a page…" filter (Enter opens the first match, Esc clears).
  const find = el('div', { class: 'nav-find', role: 'search' });
  const input = el('input', { type: 'search', placeholder: 'Find a page…', 'aria-label': 'Find an admin page', autocomplete: 'off' });
  const empty = el('p', { class: 'nav-empty', hidden: '' }, 'No page matches.');
  find.append(input);
  nav.before(find);
  nav.append(empty);

  function applyFilter() {
    const term = input.value.trim().toLowerCase();
    let any = false;
    for (const [key, g] of byKey) {
      if (!term) {
        g.wrap.hidden = false;
        g.buttons.forEach((b) => { b.hidden = false; });
        setGroup(key, open.has(key), false);
        continue;
      }
      const groupHit = key.includes(term);
      let hits = 0;
      for (const b of g.buttons) {
        const show = groupHit || b.textContent.toLowerCase().includes(term) || b.dataset.route.includes(term);
        b.hidden = !show;
        if (show) hits += 1;
      }
      g.wrap.hidden = hits === 0;
      if (hits) { any = true; g.toggle.setAttribute('aria-expanded', 'true'); g.items.hidden = false; }
    }
    empty.hidden = !term || any;
  }
  input.addEventListener('input', applyFilter);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = [...nav.querySelectorAll('.nav-btn')].find((b) => !b.hidden && !b.closest('[hidden]'));
      if (first) { first.click(); input.value = ''; applyFilter(); }
    } else if (e.key === 'Escape') {
      input.value = '';
      applyFilter();
    }
  });

  // ---- 3. mobile: fold the nav behind a Menu button.
  const mq = window.matchMedia ? window.matchMedia(MOBILE) : { matches: false, addEventListener() {} };
  const menuBtn = el('button', { type: 'button', class: 'nav-mobile-toggle', 'aria-expanded': 'false', 'aria-controls': nav.id });
  const menuIcon = el('span', { 'aria-hidden': 'true' }, '☰');
  const menuLabel = el('span', { class: 'nav-mobile-current' }, 'Menu');
  menuBtn.append(menuIcon, menuLabel);
  const brand = sidebar.querySelector('.sidebar-brand');
  const themeBtn = brand?.querySelector('#theme-toggle');
  if (themeBtn) themeBtn.before(menuBtn); else brand?.append(menuBtn);
  sidebar.classList.add('nav-enhanced');

  function setMenu(isOpen) {
    sidebar.classList.toggle('nav-open', isOpen);
    menuBtn.setAttribute('aria-expanded', String(isOpen));
    menuIcon.textContent = isOpen ? '✕' : '☰';
  }
  menuBtn.addEventListener('click', () => {
    const next = !sidebar.classList.contains('nav-open');
    setMenu(next);
    if (next) (nav.querySelector('.nav-btn.active') || input).focus?.();
  });
  nav.addEventListener('click', (e) => {
    if (e.target.closest('.nav-btn') && mq.matches) setMenu(false);
  });
  sidebar.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && mq.matches && sidebar.classList.contains('nav-open') && e.target !== input) { setMenu(false); menuBtn.focus(); }
  });

  // ---- 4. follow the route: open its group, mark it, label the menu button.
  function sync() {
    const name = currentRoute();
    const btn = nav.querySelector(`.nav-btn[data-route="${CSS.escape(name)}"]`) || nav.querySelector('.nav-btn[data-route="dashboard"]');
    for (const g of byKey.values()) g.wrap.classList.toggle('has-active', Boolean(btn && g.wrap.contains(btn)));
    const wrap = btn?.closest('.nav-group');
    if (wrap && !input.value.trim()) setGroup(wrap.dataset.group, true, true);
    menuLabel.textContent = btn ? btn.textContent.trim() : 'Menu';
    menuBtn.setAttribute('aria-label', `Menu — current page: ${menuLabel.textContent}`);
  }
  window.addEventListener('hashchange', sync);
  sync();
}
