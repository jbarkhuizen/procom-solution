// Advertise → Platform rules: where we advertise, the basic posting rules per
// platform, and for group platforms (Facebook/WhatsApp Groups) each group's
// allowed posting days. "Copy platforms & rules from Lapanza3d" merges the
// owner's Lapanza3d list in by name (preview first). See server/features/marketing.js.

const ACTION_BADGE = { add: ['Add', 'ok'], update: ['Update', 'warn'], same: ['No change', 'neutral'] };

export default function register(routes, kit) {
  const { $, h, api, toast, fail, view, setTop, setHtml } = kit;

  routes['platform-rules'] = async () => {
    setTop(
      'Advertise',
      'Platform rules',
      `<button class="btn" data-pr="copy">Copy platforms &amp; rules from Lapanza3d</button>
       <button class="btn btn-primary" data-pr="new">+ Platform</button>`,
    );
    const [meta, platforms] = await Promise.all([api('/marketing/meta'), api('/marketing/platforms')]);
    const days = (g) => (g.allowedDays.length ? g.allowedDays.join(', ') : '<span class="muted">Any day</span>');

    const card = (p) => `<div class="panel stack gap-2" data-platform="${h(p.id)}" style="margin-bottom:0.75rem">
      <div class="section-head"><h3>${h(p.name)} ${p.active ? '' : '<span class="badge neutral">Retired</span>'}${p.hasGroups ? ' <span class="badge info">Groups</span>' : ''}</h3>
        <span><span class="muted">${p.advertCount} advert${p.advertCount === 1 ? '' : 's'}</span> <button class="btn small" data-edit-platform="${h(p.id)}">Edit</button></span></div>
      <p class="muted" style="margin:0;white-space:pre-line">${h(p.notes) || 'No rules noted yet.'}</p>
      ${p.hasGroups ? `<div class="table-wrap"><table class="catalog">
          <thead><tr><th>Group</th><th>Allowed posting days</th><th>Notes</th></tr></thead>
          <tbody>${p.groups.map((g) => `<tr data-group="${h(g.id)}" style="cursor:pointer"><td><strong>${h(g.groupName)}</strong></td><td>${days(g)}</td><td style="white-space:pre-line">${h(g.notes) || '<span class="muted">—</span>'}</td></tr>`).join('') ||
            '<tr><td colspan="3"><div class="empty">No groups yet.</div></td></tr>'}</tbody></table></div>
        <div><button class="btn small" data-add-group="${h(p.id)}">+ Group</button></div>` : ''}
    </div>`;

    const root = view(`
      <div id="pr-copy" class="panel stack gap-3 hidden" style="margin-bottom:1rem"></div>
      <div class="editor-layout">
        <div>${platforms.map(card).join('') || '<div class="panel"><div class="empty">No platforms yet — add one, or copy Lapanza3d\'s list.</div></div>'}</div>
        <div class="panel sticky-panel" id="pr-editor"><p class="muted">Select a platform or group to edit.</p>
          <p class="mini-help">Groups only allow posts on their ticked days; Adverts warns when a planned date breaks that. No days ticked = any day. Retire a platform (untick Active) to stop using it without losing its adverts.</p></div>
      </div>`);
    const editorEl = $('#pr-editor', root);

    const platformEditor = (p) => {
      setHtml(
        editorEl,
        `<form id="pf" class="stack gap-3"><div class="section-head"><h3>${p ? `Edit ${h(p.name)}` : 'New platform'}</h3></div>
        <label class="field"><span>Platform name</span><input name="name" required maxlength="120" value="${h(p?.name)}" placeholder="e.g. Facebook Marketplace"></label>
        <label class="field checkbox"><input type="checkbox" name="hasGroups" ${p?.hasGroups ? 'checked' : ''}><span>Has groups (each with its own allowed days)</span></label>
        <label class="field"><span>Rules / notes for posting here</span><textarea name="notes" rows="5" maxlength="2000">${h(p?.notes)}</textarea></label>
        <label class="field checkbox"><input type="checkbox" name="active" ${!p || p.active ? 'checked' : ''}><span>Active</span></label>
        <div class="row-card-actions">${p ? '<button type="button" class="btn btn-danger" id="pf-del">Delete</button>' : '<span></span>'}<button class="btn btn-primary">Save</button></div></form>`,
      );
      const form = $('#pf', root);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = { name: form.name.value, notes: form.notes.value, hasGroups: form.hasGroups.checked, active: form.active.checked };
        try {
          await api(p ? `/marketing/platforms/${p.id}` : '/marketing/platforms', { method: p ? 'PUT' : 'POST', body });
          toast('Platform saved');
          routes['platform-rules']();
        } catch (err) { fail(err); }
      });
      $('#pf-del', root)?.addEventListener('click', async () => {
        if (!confirm(`Delete ${p.name}${p.groups.length ? ` and its ${p.groups.length} group(s)` : ''}?`)) return;
        try { await api(`/marketing/platforms/${p.id}`, { method: 'DELETE' }); toast('Deleted'); routes['platform-rules'](); } catch (err) { fail(err); }
      });
    };

    const groupEditor = (platform, g) => {
      setHtml(
        editorEl,
        `<form id="gf" class="stack gap-3"><div class="section-head"><h3>${g ? 'Edit group' : `New ${h(platform.name)} group`}</h3></div>
        <label class="field"><span>Group name</span><input name="groupName" required maxlength="200" value="${h(g?.groupName)}"></label>
        <div class="field"><span>Allowed posting days</span><div class="row-card-actions" style="flex-wrap:wrap;justify-content:flex-start">
          ${meta.weekdays.map((d) => `<label class="field checkbox" style="margin:0"><input type="checkbox" name="day" value="${h(d)}" ${g?.allowedDays.includes(d) ? 'checked' : ''}><span>${h(d)}</span></label>`).join('')}
        </div><span class="mini-help">None ticked = any day.</span></div>
        <label class="field"><span>Notes (group rules, admin contact, …)</span><textarea name="notes" rows="4" maxlength="2000">${h(g?.notes)}</textarea></label>
        <div class="row-card-actions">${g ? '<button type="button" class="btn btn-danger" id="gf-del">Delete</button>' : '<span></span>'}<button class="btn btn-primary">Save</button></div></form>`,
      );
      const form = $('#gf', root);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = { groupName: form.groupName.value, notes: form.notes.value, allowedDays: [...form.querySelectorAll('[name="day"]:checked')].map((c) => c.value) };
        try {
          await api(g ? `/marketing/groups/${g.id}` : `/marketing/platforms/${platform.id}/groups`, { method: g ? 'PUT' : 'POST', body });
          toast('Group saved');
          routes['platform-rules']();
        } catch (err) { fail(err); }
      });
      $('#gf-del', root)?.addEventListener('click', async () => {
        if (!confirm(`Delete group ${g.groupName}?`)) return;
        try { await api(`/marketing/groups/${g.id}`, { method: 'DELETE' }); toast('Deleted'); routes['platform-rules'](); } catch (err) { fail(err); }
      });
    };

    const badge = (a) => {
      const [label, cls] = ACTION_BADGE[a] || [a, 'neutral'];
      return `<span class="badge ${cls}">${h(label)}</span>`;
    };

    const showCopy = async () => {
      const box = $('#pr-copy', root);
      box.classList.remove('hidden');
      setHtml(box, '<p class="muted">Reading Lapanza3d\'s platforms…</p>');
      let prev;
      try {
        prev = await api('/marketing/lapanza-copy');
        if (!prev.ok) throw new Error(prev.error);
      } catch (err) {
        setHtml(
          box,
          `<div class="section-head"><h3>Copy from Lapanza3d</h3></div>
          <p class="error-text">${h(err.message)}</p>
          <p class="mini-help">The server reads Lapanza3d's database read-only from <code>${h(meta.lapanzaDb)}</code> (set <code>LAPANZA_DB</code> in the server's environment to change it). Nothing was changed.</p>
          <div><button class="btn" data-copy-close>Close</button></div>`,
        );
        return;
      }
      const s = prev.summary;
      const nothing = !s.platformsAdded && !s.platformsUpdated && !s.groupsAdded && !s.groupsUpdated;
      const rows = prev.platforms.flatMap((p) => [
        `<tr><td><strong>${h(p.name)}</strong>${p.active ? '' : ' <span class="muted">(retired)</span>'}</td><td>Platform</td><td>${badge(p.action)}${p.changes.length ? `<br><span class="mini-help">${h(p.changes.join(', '))}</span>` : ''}</td><td class="mini-help" style="white-space:pre-line">${h(p.notes)}</td></tr>`,
        ...p.groups.map((g) => `<tr><td style="padding-left:1.5rem">${h(g.groupName)}</td><td>Group · ${h(g.allowedDays.join(', ') || 'any day')}</td><td>${badge(g.action)}${g.changes.length ? `<br><span class="mini-help">${h(g.changes.join(', '))}</span>` : ''}</td><td class="mini-help" style="white-space:pre-line">${h(g.notes)}</td></tr>`),
      ]);
      setHtml(
        box,
        `<div class="section-head"><h3>Copy from Lapanza3d — preview</h3><button class="btn small" data-copy-close>Close</button></div>
        <p>${nothing ? 'Everything already matches Lapanza3d — nothing to copy.' : `Will add <strong>${s.platformsAdded}</strong> platform(s) and <strong>${s.groupsAdded}</strong> group(s), and update <strong>${s.platformsUpdated}</strong> platform(s) and <strong>${s.groupsUpdated}</strong> group(s) to match Lapanza3d.`}</p>
        <p class="mini-help">Matched by platform name and group name (ignoring capitals). Updates copy Lapanza3d's notes, has-groups, active and order for platforms, and allowed days + notes for groups. Nothing is deleted${prev.procomOnly.length ? ` — Procom-only platforms stay as they are: ${h(prev.procomOnly.join(', '))}` : ''}. Adverts and images are not copied. Lapanza3d's database is only read, never changed.</p>
        <div class="table-wrap"><table class="catalog"><thead><tr><th>Name</th><th>What</th><th>Action</th><th>Notes (from Lapanza3d)</th></tr></thead>
        <tbody>${rows.join('') || '<tr><td colspan="4"><div class="empty">Lapanza3d has no platforms.</div></td></tr>'}</tbody></table></div>
        <div class="row-card-actions"><button class="btn" data-copy-close>Cancel</button><button class="btn btn-primary" data-copy-apply ${nothing ? 'disabled' : ''}>Apply copy</button></div>`,
      );
      $('[data-copy-apply]', box)?.addEventListener('click', async (e) => {
        e.target.disabled = true;
        try {
          const r = await api('/marketing/lapanza-copy', { method: 'POST' });
          const t = r.summary;
          toast(`Copied: ${t.platformsAdded} platform(s) + ${t.groupsAdded} group(s) added, ${t.platformsUpdated + t.groupsUpdated} updated`);
          routes['platform-rules']();
        } catch (err) { e.target.disabled = false; fail(err); }
      });
    };

    root.addEventListener('click', (e) => {
      if (e.target.closest('[data-copy-close]')) return $('#pr-copy', root).classList.add('hidden');
      const ep = e.target.closest('[data-edit-platform]');
      if (ep) return platformEditor(platforms.find((p) => p.id === ep.dataset.editPlatform));
      const ag = e.target.closest('[data-add-group]');
      if (ag) return groupEditor(platforms.find((p) => p.id === ag.dataset.addGroup), null);
      const tr = e.target.closest('tr[data-group]');
      if (tr) {
        const p = platforms.find((x) => x.id === tr.closest('[data-platform]').dataset.platform);
        groupEditor(p, p.groups.find((g) => g.id === tr.dataset.group));
      }
    });
    $('[data-pr="new"]').addEventListener('click', () => platformEditor(null));
    $('[data-pr="copy"]').addEventListener('click', showCopy);
  };
}
