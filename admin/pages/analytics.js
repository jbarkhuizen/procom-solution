// Admin -> Analytics: first-party visitor analytics (server/features/analytics.js).
// Date range (7/30/90 days or custom), headline numbers with the change on
// the previous period, "online now" (refreshed every 30 s while open), a
// daily chart (plain SVG with a hover read-out and a table alternative), the
// shopping funnel, top pages/products/categories/searches, referrers and a
// device split. Every dynamic value goes through kit.h() before kit.view().

const state = { days: '30', from: '', to: '' };
let onlineTimer = null;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (d, withYear = false) => {
  const [y, m, dd] = String(d).split('-');
  return `${Number(dd)} ${MONTHS[Number(m) - 1] || ''}${withYear ? ` ${y}` : ''}`;
};
const plural = (n, word) => (Number(n) === 1 ? word : `${word}s`);
const num = (n) => (Number(n) || 0).toLocaleString('en-ZA');
const pctText = (n) => `${(Number(n) || 0).toLocaleString('en-ZA', { maximumFractionDigits: 1 })}%`;
const PAGE_NAMES = { '/': 'Home', '/shop': 'Shop', '/product': 'Product page', '/checkout': 'Checkout', '/checkout-complete': 'Order complete', '/contact': 'Contact', '/specials': 'Specials', '/account': 'Account', '/terms': 'Terms', '/privacy': 'Privacy', '/returns': 'Returns', '/invoice': 'Invoice', '/newsletter': 'Newsletter', '/404': 'Not found' };

const STYLE = `
.an-range { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 0.5rem; margin-bottom: 1rem; }
.an-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 999px; overflow: hidden; background: var(--bg-elevated); }
.an-seg button { border: 0; background: none; padding: 0.5rem 0.95rem; cursor: pointer; font-weight: 600; font-size: 0.85rem; color: var(--muted); }
.an-seg button + button { border-left: 1px solid var(--line); }
.an-seg button[aria-pressed="true"] { background: var(--ink); color: var(--bg); }
.an-range .field input { padding: 0.45rem 0.6rem; }
.an-range .an-span { margin-left: auto; font-size: 0.85rem; }
.an-stats { grid-template-columns: repeat(5, minmax(0, 1fr)); }
.an-delta { font-size: 0.78rem; margin-top: 0.25rem; color: var(--muted); }
.an-delta.up { color: var(--ok); }
.an-delta.down { color: var(--danger); }
.an-live { display: inline-block; width: 0.55rem; height: 0.55rem; border-radius: 50%; background: var(--ok); margin-right: 0.35rem; box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 25%, transparent); vertical-align: middle; }
.an-chart-wrap { position: relative; }
.an-chart { width: 100%; height: auto; display: block; overflow: visible; }
.an-chart .grid line { stroke: var(--line); }
.an-chart .axis text { fill: var(--muted); font-size: 11px; font-family: var(--font); }
.an-chart .views { fill: none; stroke: var(--muted); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; stroke-dasharray: 5 4; }
.an-chart .visitors { fill: none; stroke: var(--brand); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.an-chart .area { fill: var(--brand-soft); }
.an-chart .orders { fill: var(--ok); stroke: var(--panel); stroke-width: 2; }
.an-chart .cross { stroke: var(--ink); stroke-opacity: 0.35; stroke-width: 1; }
.an-chart .dot { stroke: var(--panel); stroke-width: 2; }
.an-tip { position: absolute; top: 0; pointer-events: none; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow); padding: 0.5rem 0.7rem; font-size: 0.8rem; min-width: 150px; transform: translateX(-50%); }
.an-tip strong { display: block; margin-bottom: 0.2rem; }
.an-tip div { display: flex; justify-content: space-between; gap: 1rem; }
.an-legend { display: flex; flex-wrap: wrap; gap: 1rem; font-size: 0.8rem; color: var(--muted); }
.an-legend span { display: inline-flex; align-items: center; gap: 0.4rem; }
.an-key { display: inline-block; width: 18px; height: 0; border-top: 2px solid var(--brand); }
.an-key.views { border-top: 2px dashed var(--muted); }
.an-key.orders { width: 9px; height: 9px; border: 0; border-radius: 50%; background: var(--ok); }
.an-funnel { display: grid; gap: 0.7rem; }
.an-step-head { display: flex; justify-content: space-between; gap: 0.75rem; font-size: 0.88rem; margin-bottom: 0.3rem; }
.an-bar { height: 12px; border-radius: 999px; background: var(--bg-soft); overflow: hidden; }
.an-bar > span { display: block; height: 100%; border-radius: 999px; background: var(--brand); min-width: 3px; }
.an-bar.ok > span { background: var(--ok); }
.an-drop { font-size: 0.76rem; color: var(--muted); margin-top: 0.2rem; }
table.an-table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
table.an-table th, table.an-table td { padding: 0.45rem 0.35rem; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
table.an-table th { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); font-weight: 700; }
table.an-table td.num, table.an-table th.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
table.an-table tr:last-child td { border-bottom: 0; }
.an-name { overflow-wrap: anywhere; }
.an-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; margin-bottom: 1rem; }
.an-grid > .panel { min-width: 0; }
.an-note { font-size: 0.78rem; color: var(--muted); margin: 0.6rem 0 0; }
.an-empty { color: var(--muted); font-size: 0.88rem; padding: 0.4rem 0; }
.an-zero { display: inline-block; font-size: 0.7rem; font-weight: 700; color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, transparent); border-radius: 999px; padding: 0.05rem 0.45rem; margin-left: 0.3rem; }
details.an-data summary { cursor: pointer; font-size: 0.82rem; color: var(--muted); margin-top: 0.6rem; }
details.an-data .table-wrap { max-height: 280px; margin-top: 0.5rem; }
@media (max-width: 1100px) { .an-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 980px) { .an-stats, .an-grid { grid-template-columns: 1fr; } .an-range .an-span { margin-left: 0; width: 100%; } }
`;

function ensureStyle() {
  if (document.getElementById('an-style')) return;
  const el = document.createElement('style');
  el.id = 'an-style';
  el.textContent = STYLE;
  document.head.appendChild(el);
}

function delta(cur, prev, label) {
  if (!prev && !cur) return `<div class="an-delta">No change ${label}</div>`;
  if (!prev) return `<div class="an-delta up">New ${label}</div>`;
  const change = Math.round(((cur - prev) / prev) * 1000) / 10;
  if (!change) return `<div class="an-delta">No change ${label}</div>`;
  return `<div class="an-delta ${change > 0 ? 'up' : 'down'}">${change > 0 ? '▲' : '▼'} ${pctText(Math.abs(change))} ${label}</div>`;
}

// Top of the y axis: four equal, whole-number steps (0, 5, 10, 15, 20 ...).
function niceMax(v) {
  const raw = Math.max(1, v / 4);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 3, 4, 5, 10].map((m) => m * mag).find((x) => x >= raw && Number.isInteger(x)) || Math.ceil(raw);
  return step * 4;
}

// Chart geometry, shared by the SVG and its hover layer (viewBox units).
function geometry(daily) {
  const W = 760, H = 240, L = 44, R = 12, T = 12, B = 30;
  const n = daily.length;
  const max = niceMax(Math.max(1, ...daily.map((d) => d.pageViews)));
  const x = (i) => L + (n <= 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (n - 1));
  const y = (v) => T + (H - T - B) * (1 - v / max);
  return { W, H, L, R, T, B, n, max, x, y };
}

function chartSvg(daily, h) {
  const { W, H, L, R, T, B, n, max, x, y } = geometry(daily);
  const line = (key) => daily.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join('');
  const area = `${line('visitors')}L${x(n - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`;
  const ticks = [0, 1, 2, 3, 4].map((k) => (max / 4) * k);
  const grid = ticks.map((t) => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/>`).join('');
  const yLabels = ticks.map((t) => `<text x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${h(num(t))}</text>`).join('');
  const every = Math.max(1, Math.ceil(n / 7));
  const xLabels = daily
    .map((d, i) => (i % every === 0 || i === n - 1) && !(i !== n - 1 && n - 1 - i < every / 2) ? `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${h(dayLabel(d.day))}</text>` : '')
    .join('');
  const orders = daily.map((d, i) => (d.paidOrders ? `<circle class="orders" cx="${x(i).toFixed(1)}" cy="${y(0) - 1}" r="5"/>` : '')).join('');
  const single = n === 1 ? `<circle class="dot" cx="${x(0)}" cy="${y(daily[0].visitors)}" r="4" fill="var(--brand)"/>` : '';
  return `<svg class="an-chart" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="an-chart-title an-chart-desc">
    <title id="an-chart-title">Visitors and page views per day</title>
    <desc id="an-chart-desc">${h(chartSummary(daily))}</desc>
    <g class="grid">${grid}</g>
    <g class="axis">${yLabels}${xLabels}</g>
    <path class="area" d="${area}"/>
    <path class="views" d="${line('pageViews')}"/>
    <path class="visitors" d="${line('visitors')}"/>
    ${orders}${single}
    <line class="cross" id="an-cross" x1="0" x2="0" y1="${T}" y2="${y(0)}" visibility="hidden"/>
    <circle class="dot" id="an-dot-views" r="4" fill="var(--muted)" visibility="hidden"/>
    <circle class="dot" id="an-dot-visitors" r="4" fill="var(--brand)" visibility="hidden"/>
    <rect id="an-hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>
  </svg>`;
}

function chartSummary(daily) {
  const views = daily.reduce((s, d) => s + d.pageViews, 0);
  const busiest = daily.reduce((a, d) => (d.pageViews > a.pageViews ? d : a), daily[0] || { pageViews: 0 });
  if (!views) return 'No visits in this range.';
  return `${num(views)} page views over ${daily.length} day(s). Busiest day: ${dayLabel(busiest.day, true)} with ${num(busiest.pageViews)} page views and ${num(busiest.visitors)} visitors. The full numbers are in the table below the chart.`;
}

function wireChart(root, daily) {
  const svg = root.querySelector('.an-chart');
  const tip = root.querySelector('#an-tip');
  if (!svg || !daily.length) return;
  const { W, L, R, n, x, y } = geometry(daily);
  const cross = svg.querySelector('#an-cross');
  const dv = svg.querySelector('#an-dot-views');
  const dvis = svg.querySelector('#an-dot-visitors');
  const hide = () => {
    [cross, dv, dvis].forEach((el) => el.setAttribute('visibility', 'hidden'));
    tip.hidden = true;
  };
  svg.addEventListener('mouseleave', hide);
  svg.addEventListener('mousemove', (e) => {
    const box = svg.getBoundingClientRect();
    const scale = box.width / W;
    const vx = (e.clientX - box.left) / scale;
    const i = n <= 1 ? 0 : Math.min(n - 1, Math.max(0, Math.round(((vx - L) / (W - L - R)) * (n - 1))));
    const d = daily[i];
    cross.setAttribute('x1', x(i));
    cross.setAttribute('x2', x(i));
    dv.setAttribute('cx', x(i));
    dv.setAttribute('cy', y(d.pageViews));
    dvis.setAttribute('cx', x(i));
    dvis.setAttribute('cy', y(d.visitors));
    [cross, dv, dvis].forEach((el) => el.setAttribute('visibility', 'visible'));
    // Tooltip content via DOM text nodes (no HTML sink needed).
    tip.replaceChildren();
    const title = document.createElement('strong');
    title.textContent = dayLabel(d.day, true);
    tip.append(title);
    for (const [label, v] of [['Visitors', d.visitors], ['Page views', d.pageViews], ['Paid orders', d.paidOrders]]) {
      const row = document.createElement('div');
      const a = document.createElement('span');
      const b = document.createElement('span');
      a.textContent = label;
      b.textContent = num(v);
      row.append(a, b);
      tip.append(row);
    }
    tip.hidden = false;
    const px = x(i) * scale;
    const half = tip.offsetWidth / 2;
    tip.style.left = `${Math.min(Math.max(px, half), box.width - half)}px`;
  });
}

const table = (h, head, rows, empty) =>
  rows.length
    ? `<div class="table-wrap"><table class="an-table"><thead><tr>${head.map(([t, cls]) => `<th${cls ? ` class="${cls}"` : ''}>${h(t)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
    : `<p class="an-empty">${h(empty)}</p>`;

function funnelHtml(steps, h) {
  const top = Math.max(1, steps[0]?.visitors || 0);
  return `<div class="an-funnel">${steps
    .map((s, i) => {
      const w = Math.max(0, Math.min(100, (s.visitors / top) * 100));
      const unit = s.key === 'paid' ? plural(s.visitors, 'order') : plural(s.visitors, 'visitor');
      return `<div>
        <div class="an-step-head"><span><strong>${h(s.label)}</strong></span><span>${h(num(s.visitors))} ${unit}${s.key !== 'paid' && s.count !== s.visitors ? ` <span class="muted">· ${h(num(s.count))} times</span>` : ''}</span></div>
        <div class="an-bar${s.key === 'paid' ? ' ok' : ''}" role="img" aria-label="${h(`${s.label}: ${num(s.visitors)} ${unit}`)}">${w > 0 ? `<span style="width:${w.toFixed(1)}%"></span>` : ''}</div>
        ${i ? `<div class="an-drop">${h(pctText(s.ofPrevious))} of the step before · ${h(pctText(s.ofFirst))} of product viewers</div>` : ''}
      </div>`;
    })
    .join('')}</div>`;
}

function devicesHtml(devices, h) {
  const total = Object.values(devices).reduce((s, d) => s + d.visitors, 0);
  if (!total) return '<p class="an-empty">No visits in this range.</p>';
  return `<div class="an-funnel">${[['desktop', 'Desktop'], ['mobile', 'Mobile'], ['tablet', 'Tablet']]
    .map(([k, label]) => {
      const share = (devices[k].visitors / total) * 100;
      return `<div><div class="an-step-head"><span><strong>${label}</strong></span><span>${h(pctText(Math.round(share * 10) / 10))} <span class="muted">· ${h(num(devices[k].visitors))} ${plural(devices[k].visitors, 'visitor')}</span></span></div>
        <div class="an-bar" role="img" aria-label="${h(`${label}: ${Math.round(share)}% of visitors`)}">${share > 0 ? `<span style="width:${share.toFixed(1)}%"></span>` : ''}</div></div>`;
    })
    .join('')}</div>`;
}

// Where visitors came from (owner 2026-10-08): channels with results, campaign
// tags, referring pages and places. Every value goes through h().
const regionNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    return null;
  }
})();
const countryName = (code) => (regionNames && code ? regionNames.of(code) || code : code);

function sourcesHtml(src, h, rand) {
  const ch = src.channels.map(
    (r) => `<tr><td class="an-name">${h(r.label)}</td><td class="num">${h(num(r.visitors))}</td><td class="num">${h(num(r.carts))}</td><td class="num">${h(num(r.checkouts))}</td><td class="num">${h(num(r.orders))}</td><td class="num">${r.orders ? rand(r.revenueCents) : '–'}</td><td class="num">${h(pctText(r.conversionRate))}</td></tr>`,
  );
  if (src.untrackedOrders.orders) ch.push(`<tr><td class="an-name muted">Not tracked (older orders, or the customer blocks analytics)</td><td class="num">–</td><td class="num">–</td><td class="num">–</td><td class="num">${h(num(src.untrackedOrders.orders))}</td><td class="num">${rand(src.untrackedOrders.revenueCents)}</td><td class="num">–</td></tr>`);
  const camps = src.campaigns.map(
    (r) => `<tr><td class="an-name">${h(r.campaign || '(no campaign name)')}</td><td>${h(r.source || '–')}</td><td>${h(r.medium || '–')}</td><td class="num">${h(num(r.visitors))}</td><td class="num">${h(num(r.views))}</td><td class="num">${h(num(r.orders))}</td></tr>`,
  );
  const pages = src.referringPages.map(
    (r) => `<tr><td class="an-name">${h(r.host)}<span class="muted">${h(r.path)}</span></td><td class="num">${h(num(r.visitors))}</td><td class="num">${h(num(r.views))}</td></tr>`,
  );
  const L = src.locations;
  const countries = L.countries.map((r) => `<tr><td class="an-name">${h(countryName(r.country))}</td><td class="num">${h(num(r.visitors))}</td><td class="num">${h(num(r.views))}</td></tr>`);
  const regions = L.regions.map((r) => `<tr><td class="an-name">${h(r.region)} <span class="muted">${h(countryName(r.country))}</span></td><td class="num">${h(num(r.visitors))}</td><td class="num">${h(num(r.views))}</td></tr>`);
  const cities = L.cities.map((r) => `<tr><td class="an-name">${h(r.city)} <span class="muted">${h(r.region)}${r.region ? ', ' : ''}${h(countryName(r.country))}</span></td><td class="num">${h(num(r.visitors))}</td><td class="num">${h(num(r.views))}</td></tr>`);
  const geoNote = L.geo.loaded
    ? `<p class="an-note">${h(num(L.locatedVisitors))} visitor${L.locatedVisitors === 1 ? '' : 's'} placed${L.unlocatedVisitors ? `, ${h(num(L.unlocatedVisitors))} without a known place (visits before locations were switched on, or an address the database does not know).` : '.'}</p>`
    : '<p class="an-note">Locations are not switched on yet: enter your MaxMind account below and press <em>Download / update now</em>.</p>';
  return `
      <div class="panel" style="margin-bottom:1rem">
        <div class="section-head"><h3>Where visitors come from</h3></div>
        ${table(h, [['Channel'], ['Visitors', 'num'], ['Added to cart', 'num'], ['Started checkout', 'num'], ['Paid orders', 'num'], ['Revenue', 'num'], ['Orders ÷ visitors', 'num']], ch, 'No visits in this range.')}
        <p class="an-note">A visitor counts under the first channel that brought them in this range (a link from another site, or a campaign link); everyone else is Direct. Orders count under the channel recorded at checkout (the last outside arrival in the 30 days before). Visitors from WhatsApp, Instagram or Facebook apps often show as Direct unless the link carries campaign tags — use the link builder below.</p>
      </div>
      <div class="an-grid">
        <div class="panel"><div class="section-head"><h3>Campaign links</h3></div>
          ${table(h, [['Campaign'], ['Source'], ['Medium'], ['Visitors', 'num'], ['Views', 'num'], ['Orders', 'num']], camps, 'No campaign links used in this range yet. Newsletters add them automatically; build others below.')}</div>
        <div class="panel"><div class="section-head"><h3>Pages that sent visitors</h3></div>
          ${table(h, [['Page on the other site'], ['Visitors', 'num'], ['Views', 'num']], pages, 'No links from pages on other sites in this range (search engines never show the page).')}</div>
        <div class="panel"><div class="section-head"><h3>Countries</h3></div>
          ${table(h, [['Country'], ['Visitors', 'num'], ['Views', 'num']], countries, 'No locations in this range yet.')}</div>
        <div class="panel"><div class="section-head"><h3>Provinces / regions</h3></div>
          ${table(h, [['Region'], ['Visitors', 'num'], ['Views', 'num']], regions, 'No locations in this range yet.')}</div>
        <div class="panel"><div class="section-head"><h3>Cities</h3></div>
          ${table(h, [['City'], ['Visitors', 'num'], ['Views', 'num']], cities, 'No locations in this range yet.')}${geoNote}</div>
      </div>
      <div class="an-grid">
        <div class="panel"><div class="section-head"><h3>Campaign link builder</h3></div>
          <p class="an-note" style="margin:0 0 .6rem">Make a link for a WhatsApp message, social post, advert or email you send yourself. Visits and orders from it then show under the name you give it.</p>
          <div style="display:grid;gap:.5rem">
            <label class="field"><span>Page</span><input id="lb-url" type="url" value="${h(location.origin)}/"></label>
            <label class="field"><span>Where you share it (source) — e.g. whatsapp, facebook</span><input id="lb-source" type="text" placeholder="whatsapp"></label>
            <label class="field"><span>Type (medium) — e.g. social, email, cpc</span><input id="lb-medium" type="text" placeholder="social"></label>
            <label class="field"><span>Name (campaign) — e.g. october-specials</span><input id="lb-campaign" type="text" placeholder="october-specials"></label>
            <input id="lb-out" type="text" readonly aria-label="Your campaign link" placeholder="Your link appears here">
            <div><button class="btn" id="lb-copy" type="button">Copy link</button></div>
          </div></div>
        <div class="panel"><div class="section-head"><h3>Visitor locations (MaxMind)</h3></div>
          <div id="geo-box"><p class="an-note">Loading…</p></div></div>
      </div>`;
}

function onlineHtml(o, h) {
  return `<span class="an-live" aria-hidden="true"></span>${h(num(o.count))}`;
}

export default function register(routes, kit) {
  const { $, h, rand, api, view, setTop, fail, toast } = kit;

  function wireLinkBuilder(root) {
    const slug = (v) => String(v || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const build = () => {
      const out = $('#lb-out', root);
      try {
        const u = new URL($('#lb-url', root).value);
        for (const [k, id] of [['utm_source', 'lb-source'], ['utm_medium', 'lb-medium'], ['utm_campaign', 'lb-campaign']]) {
          const v = slug($(`#${id}`, root).value);
          if (v) u.searchParams.set(k, v);
          else u.searchParams.delete(k);
        }
        out.value = u.href;
      } catch {
        out.value = '';
      }
    };
    ['lb-url', 'lb-source', 'lb-medium', 'lb-campaign'].forEach((id) => $(`#${id}`, root).addEventListener('input', build));
    $('#lb-copy', root).addEventListener('click', async () => {
      build();
      const out = $('#lb-out', root);
      if (!out.value) return toast('Enter a full page address first', true);
      try {
        await navigator.clipboard.writeText(out.value);
        toast('Link copied');
      } catch {
        out.select();
        toast('Press Ctrl+C to copy');
      }
    });
  }

  // MaxMind account + database refresh (server/features/geoip.js). The licence key is never shown again.
  async function wireGeo(root) {
    const box = $('#geo-box', root);
    if (!box) return;
    const draw = (g) => {
      kit.setHtml(box, `
        <p class="an-note" style="margin:0 0 .6rem">${g.installed ? `Database installed (${h(g.sizeMb)} MB), updated ${h(g.updatedAt ? new Date(g.updatedAt).toLocaleDateString('en-ZA', { dateStyle: 'medium' }) : 'earlier')}. It refreshes itself about every 2 weeks.` : 'Not installed yet.'}
          Visitor addresses are used once to find the city and are never stored. Free MaxMind account: <a href="https://www.maxmind.com/en/geolite2/signup" target="_blank" rel="noopener">create one</a>, then use <em>Manage license keys</em> in your MaxMind account.</p>
        ${g.lastError ? `<p class="an-note" style="color:var(--danger)">${h(g.lastError)}</p>` : ''}
        <div style="display:grid;gap:.5rem">
          <label class="field"><span>MaxMind account ID</span><input id="geo-id" type="text" inputmode="numeric" value="${h(g.accountId)}"></label>
          <label class="field"><span>Licence key ${g.hasKey ? '(saved: leave blank to keep it)' : ''}</span><input id="geo-key" type="password" autocomplete="off" placeholder="${g.hasKey ? '••••••••••••' : ''}"></label>
          <div><button class="btn" id="geo-save" type="button">Save</button> <button class="btn btn-primary" id="geo-update" type="button">Download / update now</button></div>
        </div>`);
      const creds = () => ({ accountId: $('#geo-id', box).value, licenseKey: $('#geo-key', box).value });
      $('#geo-save', box).addEventListener('click', async () => {
        try {
          draw(await api('/analytics/geo', { method: 'PUT', body: creds() }));
          toast('Saved');
        } catch (err) { fail(err); }
      });
      $('#geo-update', box).addEventListener('click', async (e) => {
        e.target.disabled = true;
        e.target.textContent = 'Downloading… (about a minute)';
        try {
          await api('/analytics/geo', { method: 'PUT', body: creds() });
          draw(await api('/analytics/geo/update', { method: 'POST' }));
          toast('Location database installed');
        } catch (err) {
          fail(err);
          try { draw(await api('/analytics/geo')); } catch { /* keep the form */ }
        }
      });
    };
    try {
      draw(await api('/analytics/geo'));
    } catch (err) {
      fail(err);
    }
  }

  const query = () => (state.days === 'custom' ? new URLSearchParams({ from: state.from, to: state.to }) : new URLSearchParams({ days: state.days }));

  routes.analytics = async () => {
    ensureStyle();
    clearInterval(onlineTimer);
    const s = await api(`/analytics?${query()}`);
    if (state.days !== 'custom') Object.assign(state, { from: s.from, to: s.to });
    setTop('Sales', 'Analytics', '<button class="btn" data-an="refresh">Refresh</button>');

    const t = s.totals;
    const p = s.previous;
    const vsLabel = 'vs previous period';
    const products = s.topProducts.map(
      (r) => `<tr><td class="an-name">${r.exists ? `<a href="/product.html?p=${h(encodeURIComponent(r.slug))}" target="_blank" rel="noopener">${h(r.name)}</a>` : `${h(r.name)} <span class="muted">(removed)</span>`}</td><td class="num">${h(num(r.views))}</td><td class="num">${h(num(r.visitors))}</td><td class="num">${h(num(r.addedToCart))}</td></tr>`,
    );
    const pages = s.topPages.map((r) => `<tr><td class="an-name">${h(PAGE_NAMES[r.path] || r.path)} <span class="muted">${h(r.path)}</span></td><td class="num">${h(num(r.views))}</td><td class="num">${h(num(r.visitors))}</td></tr>`);
    const cats = s.topCategories.map((r) => `<tr><td class="an-name"><a href="/shop.html?category=${h(encodeURIComponent(r.slug))}" target="_blank" rel="noopener">${h(r.name)}</a></td><td class="num">${h(num(r.views))}</td><td class="num">${h(num(r.visitors))}</td></tr>`);
    const searches = s.topSearches.map((r) => `<tr><td class="an-name">${h(r.query)}${r.results === 0 ? '<span class="an-zero">0 results</span>' : ''}</td><td class="num">${h(num(r.searches))}</td><td class="num">${r.results == null ? '–' : h(num(r.results))}</td></tr>`);
    const zero = s.zeroResultSearches.map((r) => `<tr><td class="an-name">${h(r.query)}</td><td class="num">${h(num(r.searches))}</td><td class="num">${h(num(r.visitors))}</td></tr>`);
    const refs = [
      ...s.referrers.map((r) => `<tr><td class="an-name">${h(r.host)}</td><td class="num">${h(num(r.visitors))}</td><td class="num">${h(num(r.views))}</td></tr>`),
      `<tr><td class="an-name muted">Direct / no referrer</td><td class="num">${h(num(s.directVisitors))}</td><td class="num">–</td></tr>`,
    ];
    const onlinePages = s.online.pages.map((r) => `${h(PAGE_NAMES[r.path] || r.path)} (${h(r.visitors)})`).join(' · ');
    const dataRows = [...s.daily].reverse().map((d) => `<tr><td>${h(dayLabel(d.day, true))}</td><td class="num">${h(num(d.visitors))}</td><td class="num">${h(num(d.pageViews))}</td><td class="num">${h(num(d.paidOrders))}</td></tr>`);

    const root = view(`
      <div class="an-range">
        <div class="an-seg" role="group" aria-label="Date range">
          ${['7', '30', '90'].map((d) => `<button type="button" data-days="${d}" aria-pressed="${state.days === d}">${d} days</button>`).join('')}
          <button type="button" data-days="custom" aria-pressed="${state.days === 'custom'}">Custom</button>
        </div>
        <label class="field"><span>From</span><input id="an-from" type="date" value="${h(state.from)}" max="${h(s.to)}"></label>
        <label class="field"><span>To</span><input id="an-to" type="date" value="${h(state.to)}"></label>
        <span class="an-span muted">${h(dayLabel(s.from, true))} – ${h(dayLabel(s.to, true))} · ${h(s.days)} day${s.days === 1 ? '' : 's'}</span>
      </div>

      <div class="stats an-stats">
        <div class="stat-card"><div class="label">Online now</div><div class="value" id="an-online">${onlineHtml(s.online, h)}</div><div class="an-delta" id="an-online-pages">${onlinePages || 'Active in the last 5 minutes'}</div></div>
        <div class="stat-card"><div class="label">Visitors</div><div class="value">${h(num(t.visitors))}</div>${delta(t.visitors, p.visitors, vsLabel)}</div>
        <div class="stat-card"><div class="label">Page views</div><div class="value">${h(num(t.pageViews))}</div>${delta(t.pageViews, p.pageViews, vsLabel)}</div>
        <div class="stat-card"><div class="label">Paid orders</div><div class="value">${h(num(t.paidOrders))}</div><div class="an-delta">${rand(t.revenueCents)} revenue</div></div>
        <div class="stat-card"><div class="label">Conversion rate</div><div class="value">${h(pctText(t.conversionRate))}</div><div class="an-delta">Paid orders ÷ visitors · was ${h(pctText(p.conversionRate))}</div></div>
      </div>

      <div class="panel" style="margin-bottom:1rem">
        <div class="section-head"><h3>Visitors per day</h3>
          <div class="an-legend"><span><i class="an-key"></i>Visitors</span><span><i class="an-key views"></i>Page views</span><span><i class="an-key orders"></i>Day with a paid order</span></div>
        </div>
        <div class="an-chart-wrap">${chartSvg(s.daily, h)}<div class="an-tip" id="an-tip" hidden></div></div>
        <details class="an-data"><summary>Show the numbers as a table</summary>
          ${table(h, [['Day'], ['Visitors', 'num'], ['Page views', 'num'], ['Paid orders', 'num']], dataRows, 'No days in range.')}
        </details>
        ${t.approximate ? '<p class="an-note">Part of this range is older than 12 months: only daily totals are kept for it, so visitors there are summed per day.</p>' : ''}
      </div>

      <div class="an-grid">
        <div class="panel">
          <div class="section-head"><h3>Shopping funnel</h3></div>
          ${funnelHtml(s.funnel, h)}
          <p class="an-note">Unique visitors per step; paid orders come from the Orders list (paid in this range). Visitors viewed ${h((t.pagesPerVisitor || 0).toLocaleString('en-ZA'))} pages each on average.</p>
        </div>
        <div class="panel">
          <div class="section-head"><h3>Devices</h3></div>
          ${devicesHtml(s.devices, h)}
          <p class="an-note">${h(num(s.loggedIn.visitors))} visitor${s.loggedIn.visitors === 1 ? ' was' : 's were'} logged in to a customer account.</p>
        </div>
      </div>

      <div class="an-grid">
        <div class="panel"><div class="section-head"><h3>Top products viewed</h3></div>
          ${table(h, [['Product'], ['Views', 'num'], ['Visitors', 'num'], ['Added to cart', 'num']], products, 'No product views in this range.')}</div>
        <div class="panel"><div class="section-head"><h3>Top pages</h3></div>
          ${table(h, [['Page'], ['Views', 'num'], ['Visitors', 'num']], pages, 'No page views in this range.')}</div>
        <div class="panel"><div class="section-head"><h3>Top categories</h3></div>
          ${table(h, [['Category'], ['Views', 'num'], ['Visitors', 'num']], cats, 'No category pages viewed in this range.')}</div>
        <div class="panel"><div class="section-head"><h3>Referrers</h3></div>
          ${table(h, [['Site'], ['Visitors', 'num'], ['Views', 'num']], refs, '')}</div>
        <div class="panel"><div class="section-head"><h3>Top searches</h3></div>
          ${table(h, [['Search'], ['Searches', 'num'], ['Results', 'num']], searches, 'No shop searches in this range.')}</div>
        <div class="panel"><div class="section-head"><h3>Searches with no results</h3></div>
          ${table(h, [['Search'], ['Searches', 'num'], ['Visitors', 'num']], zero, 'Every search found something.')}
          <p class="an-note">Ideas for products to list, or words to add to product names.</p></div>
      </div>
      ${sourcesHtml(s.sources, h, rand)}
      <p class="mini-help">First-party and anonymous: a random visitor id in the browser, no cookies, no IP addresses stored (an address is used once to find the city, then forgotten), no third parties. Bots, your own admin browsing and browsers asking not to be tracked are left out. Raw data is kept ${h(s.retentionMonths)} months.</p>`);

    wireChart(root, s.daily);
    wireLinkBuilder(root);
    wireGeo(root);

    const reload = () => routes.analytics().catch(fail);
    root.querySelectorAll('[data-days]').forEach((b) =>
      b.addEventListener('click', () => {
        if (b.dataset.days === 'custom') {
          state.days = 'custom';
          $('#an-from', root).focus();
          root.querySelectorAll('[data-days]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
          return;
        }
        state.days = b.dataset.days;
        reload();
      }),
    );
    const onDate = () => {
      const from = $('#an-from', root).value;
      const to = $('#an-to', root).value;
      if (!from || !to) return;
      Object.assign(state, { days: 'custom', from, to });
      reload();
    };
    $('#an-from', root).addEventListener('change', onDate);
    $('#an-to', root).addEventListener('change', onDate);
    $('[data-an="refresh"]')?.addEventListener('click', reload);

    // "Online now" refresh while this page is open.
    onlineTimer = setInterval(async () => {
      if (!location.hash.startsWith('#/analytics') || !document.body.contains(root)) return clearInterval(onlineTimer);
      if (document.visibilityState !== 'visible') return;
      try {
        const o = await api('/analytics/online');
        const el = $('#an-online', root);
        if (el) kit.setHtml(el, onlineHtml(o, h));
        const pagesEl = $('#an-online-pages', root);
        if (pagesEl) pagesEl.textContent = o.pages.map((r) => `${PAGE_NAMES[r.path] || r.path} (${r.visitors})`).join(' · ') || 'Active in the last 5 minutes';
      } catch {
        /* next tick */
      }
    }, 30_000);
  };
}
