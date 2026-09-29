// Admin -> Todo / Backlog: the owner's running list of things to do on the
// site (ported from Lapanza3d's Todo page, simplified): title, details,
// priority, status (open / in progress / done), area tag, date added / done.
// Quick add at the top, filters, tick to mark done, edit panel.
// API: /api/admin/todos (server/features/governance.js).
// Every dynamic value goes through kit.h().

const state = { status: 'not_done', priority: '', area: '', q: '', editing: null, expanded: new Set() };

const STATUS_LABEL = { open: 'Open', in_progress: 'In progress', done: 'Done' };
const PRIORITY_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
const ymd = (iso) => (iso ? String(iso).slice(0, 10) : '');

export default function register(routes, kit) {
  const { $, h, api, toast, fail, view, setTop, options } = kit;

  const statusOpts = Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label }));
  const priorityOpts = Object.entries(PRIORITY_LABEL).map(([value, label]) => ({ value, label }));

  function editPanel(t, areas) {
    return `<form class="panel stack gap-3" id="td-edit" style="margin-bottom:1rem">
      <div class="section-head"><h3>${t.id ? `Edit todo #${h(t.number)}` : 'New todo'}</h3></div>
      <label class="field"><span>Title</span><input name="title" required maxlength="200" value="${h(t.title)}"></label>
      <label class="field"><span>Details</span><textarea name="details" rows="4" maxlength="4000">${h(t.details)}</textarea></label>
      <div class="grid-3" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:0.75rem">
        <label class="field"><span>Area</span><input name="area" list="td-areas" maxlength="40" value="${h(t.area)}"></label>
        <label class="field"><span>Priority</span><select name="priority">${options(priorityOpts, t.priority)}</select></label>
        <label class="field"><span>Status</span><select name="status">${options(statusOpts, t.status)}</select></label>
      </div>
      <datalist id="td-areas">${areas.map((a) => `<option value="${h(a)}">`).join('')}</datalist>
      ${t.id ? `<p class="mini-help">Added ${h(ymd(t.dateAdded))}${t.createdBy ? ` by ${h(t.createdBy)}` : ''}${t.doneAt ? ` · done ${h(ymd(t.doneAt))}` : ''}</p>` : ''}
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
        <button class="btn btn-primary" type="submit">Save</button>
        <button class="btn" type="button" data-td="cancel">Cancel</button>
        ${t.id ? '<button class="btn btn-danger" type="button" data-td="delete" style="margin-left:auto">Delete</button>' : ''}
      </div>
    </form>`;
  }

  routes.todos = async () => {
    const qs = new URLSearchParams();
    for (const k of ['status', 'priority', 'area', 'q']) if (state[k]) qs.set(k, state[k]);
    const res = await api(`/todos?${qs}`);
    setTop('System', 'Todo / Backlog');
    const { counts } = res;
    const filtered = state.priority || state.area || state.q || state.status !== 'not_done';
    const editing = state.editing && (state.editing === 'new' ? { id: '', title: '', details: '', area: '', priority: 'medium', status: 'open' } : res.items.find((t) => t.id === state.editing));

    const rows = res.items.map((t) => {
      const open = state.expanded.has(t.id);
      const done = t.status === 'done';
      return `<tr data-id="${h(t.id)}" style="${done ? 'opacity:0.65' : ''}">
        <td style="width:2.5rem"><input type="checkbox" data-td="done" ${done ? 'checked' : ''} aria-label="Mark “${h(t.title)}” done"></td>
        <td class="muted" style="width:3rem">#${h(t.number)}</td>
        <td>
          <button type="button" class="linkish" data-td="expand" aria-expanded="${open}" style="border:0;background:none;padding:0;font:inherit;color:inherit;text-align:left;cursor:pointer;font-weight:600;${done ? 'text-decoration:line-through' : ''}">${h(t.title)}</button>
          ${t.details ? (open ? `<div class="mini-help" style="white-space:pre-wrap;margin-top:0.3rem">${h(t.details)}</div>` : `<div class="mini-help" style="overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${h(t.details)}</div>`) : ''}
        </td>
        <td>${t.area ? `<span class="badge neutral">${h(t.area)}</span>` : ''}</td>
        <td><span class="badge priority-${h(t.priority)}">${h(PRIORITY_LABEL[t.priority] || t.priority)}</span></td>
        <td><select data-td="status" aria-label="Status of “${h(t.title)}”">${options(statusOpts, t.status)}</select></td>
        <td style="white-space:nowrap" class="muted">${h(ymd(t.dateAdded))}${t.doneAt ? `<br>done ${h(ymd(t.doneAt))}` : ''}</td>
        <td><button class="btn small" type="button" data-td="edit">Edit</button></td>
      </tr>`;
    }).join('');

    const root = view(`
      ${editing ? editPanel(editing, res.areas) : ''}
      <form class="panel" id="td-quick" style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:flex-end;margin-bottom:1rem">
        <label class="field" style="flex:1 1 16rem"><span>Quick add</span><input name="title" maxlength="200" placeholder="What needs doing?" required></label>
        <label class="field" style="flex:0 1 10rem"><span>Area</span><input name="area" list="td-quick-areas" maxlength="40" value="${h(state.area)}"></label>
        <datalist id="td-quick-areas">${res.areas.map((a) => `<option value="${h(a)}">`).join('')}</datalist>
        <label class="field" style="flex:0 1 8rem"><span>Priority</span><select name="priority">${options(priorityOpts, 'medium')}</select></label>
        <button class="btn btn-primary" type="submit">Add</button>
        <button class="btn" type="button" data-td="new">More detail…</button>
      </form>
      <div class="toolbar" style="flex-wrap:wrap">
        <input id="td-q" type="search" placeholder="Search title or details" value="${h(state.q)}" aria-label="Search todos">
        <select id="td-status" aria-label="Status">${options([{ value: 'not_done', label: 'Not done (open + in progress)' }, ...statusOpts], state.status, { empty: 'All statuses' })}</select>
        <select id="td-priority" aria-label="Priority">${options(priorityOpts, state.priority, { empty: 'All priorities' })}</select>
        <select id="td-area" aria-label="Area">${options(res.areas.map((a) => ({ value: a, label: a })), state.area, { empty: 'All areas' })}</select>
        ${filtered ? '<button class="btn small" type="button" id="td-clear">Reset filters</button>' : ''}
        <span class="muted">${h(counts.open)} open · ${h(counts.in_progress)} in progress · ${h(counts.done)} done</span>
      </div>
      <div class="panel table-wrap"><table class="catalog">
        <thead><tr><th aria-label="Done"></th><th>No</th><th>Todo</th><th>Area</th><th>Priority</th><th>Status</th><th>Added</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="8" class="empty">${filtered ? 'Nothing matches these filters.' : 'Nothing to do. Add the next thing above.'}</td></tr>`}</tbody>
      </table></div>
      <p class="mini-help" style="margin-top:0.75rem">Started from the open items in docs/STATUS.md. Ticking an item marks it done and records the date; untick to reopen.</p>`);

    const reload = () => routes.todos().catch(fail);
    const save = async (id, body, msg) => {
      try {
        await api(id ? `/todos/${encodeURIComponent(id)}` : '/todos', { method: id ? 'PUT' : 'POST', body });
        if (msg) toast(msg);
        reload();
      } catch (err) { fail(err); }
    };

    $('#td-quick', root).addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target));
      save('', fd, 'Todo added');
    });
    $('#td-edit', root)?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target));
      const id = editing.id;
      try {
        await api(id ? `/todos/${encodeURIComponent(id)}` : '/todos', { method: id ? 'PUT' : 'POST', body: fd });
        toast(id ? 'Todo saved' : 'Todo added');
        state.editing = null;
        reload();
      } catch (err) { fail(err); }
    });

    const set = (k) => (e) => { state[k] = e.target.value.trim(); reload(); };
    $('#td-q', root).addEventListener('change', set('q'));
    $('#td-status', root).addEventListener('change', set('status'));
    $('#td-priority', root).addEventListener('change', set('priority'));
    $('#td-area', root).addEventListener('change', set('area'));
    $('#td-clear', root)?.addEventListener('click', () => { Object.assign(state, { status: 'not_done', priority: '', area: '', q: '' }); reload(); });

    root.addEventListener('change', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (!tr) return;
      if (e.target.matches('[data-td="done"]')) save(tr.dataset.id, { status: e.target.checked ? 'done' : 'open' }, e.target.checked ? 'Marked done' : 'Reopened');
      if (e.target.matches('[data-td="status"]')) save(tr.dataset.id, { status: e.target.value }, 'Status updated');
    });
    root.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-td]')?.dataset.td;
      const tr = e.target.closest('tr[data-id]');
      if (act === 'expand' && tr) {
        if (state.expanded.has(tr.dataset.id)) state.expanded.delete(tr.dataset.id); else state.expanded.add(tr.dataset.id);
        reload();
      } else if (act === 'edit' && tr) {
        state.editing = tr.dataset.id;
        await reload();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else if (act === 'new') {
        state.editing = 'new';
        reload();
      } else if (act === 'cancel') {
        state.editing = null;
        reload();
      } else if (act === 'delete' && editing?.id) {
        if (!confirm(`Delete todo #${editing.number} “${editing.title}”? This can't be undone (marking it done keeps a record).`)) return;
        try {
          await api(`/todos/${encodeURIComponent(editing.id)}`, { method: 'DELETE' });
          toast('Todo deleted');
          state.editing = null;
          reload();
        } catch (err) { fail(err); }
      }
    });
  };
}
