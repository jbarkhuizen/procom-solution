// Advertise → Calendar: the planned adverts as an agenda (7 days back to 21
// days ahead, like Lapanza3d) or a month grid. An advert shows on every day
// it runs. Click one to edit it on the Adverts page.

const state = { mode: 'agenda', month: '' }; // month = 'YYYY-MM'

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function todayYmd() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
}
// Pure calendar-date arithmetic in UTC, so no timezone can shift a day.
function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function weekdayIndex(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Mon = 0
}
function dayLabel(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}
function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-ZA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
function shiftMonth(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}

export default function register(routes, kit) {
  const { h, api, view, setTop, $ } = kit;

  const item = (a, day, compact = false) => {
    const first = a.publishDate === day;
    const where = `${a.platformName}${a.groupName ? ` · ${a.groupName}` : ''}`;
    if (compact) {
      return `<a href="#/adverts/${h(a.id)}" class="badge ${a.dayWarning && first ? 'warn' : 'info'}" title="${h(`${where}${a.caption ? ` — ${a.caption}` : ''}`)}" style="display:block;text-transform:none;letter-spacing:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:0.2rem;text-decoration:none;${first ? '' : 'opacity:0.6'}">${first && a.publishTime ? `${h(a.publishTime)} ` : ''}${h(where)}</a>`;
    }
    return `<a href="#/adverts/${h(a.id)}" class="row-card-actions" style="justify-content:flex-start;gap:0.75rem;color:inherit;text-decoration:none">
      ${a.imagePath ? `<img class="thumb" src="${h(a.imagePath)}" alt="">` : ''}
      <span><strong>${h(where)}</strong>${first && a.publishTime ? ` · ${h(a.publishTime)}` : ''}${a.caption ? ` — ${h(a.caption.length > 120 ? `${a.caption.slice(0, 120)}…` : a.caption)}` : ''}
      ${first ? (a.durationDays > 1 ? ` <span class="muted">(runs ${a.durationDays} days)</span>` : '') : ' <span class="muted">(still running)</span>'}
      ${first && a.dayWarning ? `<br><span class="badge warn" style="text-transform:none;letter-spacing:0">⚠ ${h(a.dayWarning)}</span>` : ''}</span></a>`;
  };

  routes['ad-calendar'] = async () => {
    setTop(
      'Advertise',
      'Calendar',
      `<button class="btn ${state.mode === 'agenda' ? 'btn-primary' : ''}" data-mode="agenda">Agenda</button>
       <button class="btn ${state.mode === 'month' ? 'btn-primary' : ''}" data-mode="month">Month</button>
       <button class="btn" data-go-adverts>+ Advert</button>`,
    );
    const today = todayYmd();
    if (!state.month) state.month = today.slice(0, 7);

    let from;
    let to;
    if (state.mode === 'agenda') {
      from = addDays(today, -7);
      to = addDays(today, 21);
    } else {
      const first = `${state.month}-01`;
      from = addDays(first, -weekdayIndex(first)); // Monday on/before the 1st
      const last = addDays(`${shiftMonth(state.month, 1)}-01`, -1);
      to = addDays(last, 6 - weekdayIndex(last)); // Sunday on/after the last day
    }
    const adverts = await api(`/marketing/adverts?${new URLSearchParams({ from, to })}`);
    const on = (day) => adverts.filter((a) => a.publishDate <= day && a.endDate >= day);

    let body;
    if (state.mode === 'agenda') {
      const blocks = [];
      for (let d = from; d <= to; d = addDays(d, 1)) {
        const list = on(d);
        if (!list.length && d !== today) continue;
        blocks.push(`<div class="panel stack gap-2" style="margin-bottom:0.5rem;${d === today ? 'border-color:var(--brand)' : ''}${d < today ? ';opacity:0.75' : ''}">
          <div class="section-head"><h3>${h(dayLabel(d))}${d === today ? ' — Today' : ''}</h3></div>
          ${list.map((a) => item(a, d)).join('') || '<p class="muted" style="margin:0">Nothing planned today.</p>'}
        </div>`);
      }
      body = `<p class="mini-help">${h(dayLabel(from))} to ${h(dayLabel(to))} (7 days back, 21 days ahead). Days without adverts are hidden.</p>${blocks.join('')}`;
    } else {
      const cells = [];
      for (let d = from; d <= to; d = addDays(d, 1)) {
        const inMonth = d.startsWith(state.month);
        const list = on(d);
        cells.push(`<div style="min-height:5.5rem;padding:0.35rem;border:1px solid var(--line);border-radius:6px;min-width:0;${inMonth ? '' : 'opacity:0.45;'}${d === today ? 'border-color:var(--brand);border-width:2px;' : ''}">
          <div class="mini-help" style="font-weight:700">${Number(d.slice(8))}</div>
          ${list.slice(0, 4).map((a) => item(a, d, true)).join('')}${list.length > 4 ? `<div class="mini-help">+${list.length - 4} more</div>` : ''}
        </div>`);
      }
      body = `<div class="toolbar"><button class="btn small" data-month="-1">‹ Prev</button><strong>${h(monthLabel(state.month))}</strong><button class="btn small" data-month="1">Next ›</button><button class="btn small" data-month="0">This month</button></div>
        <div class="panel" style="overflow-x:auto"><div style="display:grid;grid-template-columns:repeat(7,minmax(5.5rem,1fr));gap:0.3rem;min-width:40rem">
          ${WEEKDAYS.map((w) => `<div class="mini-help" style="font-weight:700;text-align:center">${w}</div>`).join('')}
          ${cells.join('')}
        </div></div>
        <p class="mini-help">Faded entries are later days of a multi-day advert; amber ones break their group's allowed days.</p>`;
    }
    const root = view(adverts.length || state.mode === 'month' ? body : `${body}<div class="empty">No adverts in this window — plan one on the <a href="#/adverts">Adverts</a> page.</div>`);

    $('[data-mode="agenda"]').addEventListener('click', () => { state.mode = 'agenda'; routes['ad-calendar'](); });
    $('[data-mode="month"]').addEventListener('click', () => { state.mode = 'month'; routes['ad-calendar'](); });
    $('[data-go-adverts]').addEventListener('click', () => { location.hash = '#/adverts/new'; });
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-month]');
      if (!b) return;
      const n = Number(b.dataset.month);
      state.month = n ? shiftMonth(state.month, n) : today.slice(0, 7);
      routes['ad-calendar']();
    });
  };
}
