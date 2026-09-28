// Advertise → Adverts: one row per planned post on a platform (and group):
// image, caption, publish date + time, how many days it runs. Warns when the
// date breaks the group's allowed days (Platform rules). "Copy caption" puts
// the text on the clipboard for pasting into Facebook/WhatsApp; a product
// can be linked into the caption. See server/features/marketing.js.

const state = { show: 'upcoming', platformId: '' };

function todayYmd() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
}

export async function copyText(text, kit) {
  try {
    await navigator.clipboard.writeText(text);
    kit.toast('Caption copied');
  } catch {
    kit.toast('Could not copy automatically — select the caption and press Ctrl+C', true);
  }
}

export default function register(routes, kit) {
  const { $, h, api, toast, fail, view, setTop, options, setHtml } = kit;

  routes.adverts = async (id) => {
    setTop('Advertise', 'Adverts', '<button class="btn btn-primary" data-ad-new>+ Advert</button>');
    const [meta, platforms, all] = await Promise.all([api('/marketing/meta'), api('/marketing/platforms'), api('/marketing/adverts')]);
    const today = todayYmd();
    const list = all
      .filter((a) => (state.show === 'upcoming' ? a.endDate >= today : state.show === 'past' ? a.endDate < today : true))
      .filter((a) => !state.platformId || a.platformId === state.platformId);
    if (state.show === 'past') list.reverse();
    const productUrl = (slug) => `${meta.siteUrl}/product.html?p=${encodeURIComponent(slug)}`;
    const runLabel = (a) => (a.durationDays > 1 ? `${a.durationDays} days (to ${a.endDate})` : '1 day');
    const running = (a) => a.publishDate <= today && a.endDate >= today;

    const root = view(`
      <div class="toolbar">
        <select id="ad-show">${options([{ value: 'upcoming', label: 'Upcoming & running' }, { value: 'past', label: 'Past' }, { value: 'all', label: 'All' }], state.show)}</select>
        <select id="ad-platform-filter">${options(platforms.map((p) => ({ value: p.id, label: p.name })), state.platformId, { empty: 'All platforms' })}</select>
        <span class="muted">${list.length} advert${list.length === 1 ? '' : 's'}</span>
      </div>
      <div class="editor-layout">
        <div class="panel table-wrap"><table class="catalog">
          <thead><tr><th></th><th>Where</th><th>Caption</th><th>Publish</th><th>Runs</th></tr></thead>
          <tbody>${
            list.map((a) => `<tr data-id="${h(a.id)}" style="cursor:pointer">
              <td>${a.imagePath ? `<img class="thumb" src="${h(a.imagePath)}" alt="">` : '<div class="thumb-empty"></div>'}</td>
              <td><strong>${h(a.platformName)}</strong>${a.groupName ? `<br><span class="muted">${h(a.groupName)}</span>` : ''}</td>
              <td style="max-width:22rem"><span style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${h(a.caption) || '<span class="muted">No caption</span>'}</span>${a.productName ? `<span class="mini-help">Product: ${h(a.productName)}</span>` : ''}${a.caption ? `<br><button class="btn small" data-copy="${h(a.id)}" style="margin-top:0.3rem">Copy caption</button>` : ''}</td>
              <td style="white-space:nowrap">${h(a.publishDate)}${a.publishTime ? ` ${h(a.publishTime)}` : ''}${running(a) ? ' <span class="badge ok">Running</span>' : ''}${a.dayWarning ? `<br><span class="badge warn" title="${h(a.dayWarning)}">Day not allowed</span>` : ''}</td>
              <td style="white-space:nowrap">${h(runLabel(a))}</td>
            </tr>`).join('') ||
            `<tr><td colspan="5"><div class="empty">${all.length ? 'No adverts match this filter.' : 'No adverts planned yet — add one, then see it on the Calendar.'}</div></td></tr>`
          }</tbody></table></div>
        <div class="panel sticky-panel" id="ad-editor"><p class="muted">Select an advert to edit, or plan a new one.</p></div>
      </div>`);

    const editor = (a) => {
      root.querySelectorAll('tr[data-id]').forEach((tr) => tr.classList.toggle('selected', Boolean(a) && tr.dataset.id === a.id));
      const usable = platforms.filter((p) => p.active || p.id === a?.platformId);
      if (!usable.length) {
        setHtml($('#ad-editor', root), '<p class="muted">Add an active platform under <a href="#/platform-rules">Platform rules</a> first.</p>');
        return;
      }
      let productId = a?.productId || '';
      let productName = a?.productName || '';
      setHtml(
        $('#ad-editor', root),
        `<form id="adf" class="stack gap-3"><div class="section-head"><h3>${a ? 'Edit advert' : 'New advert'}</h3></div>
        <div class="grid-2"><label class="field"><span>Platform</span><select name="platformId" required>${options(usable.map((p) => ({ value: p.id, label: p.active ? p.name : `${p.name} (retired)` })), a?.platformId || '', { empty: 'Choose…' })}</select></label>
        <label class="field" id="adf-group-wrap"><span>Group</span><select name="groupId"></select></label></div>
        <div class="grid-2" style="grid-template-columns:minmax(0,1.4fr) minmax(0,1fr)"><label class="field"><span>Publish date</span><input name="publishDate" type="date" required style="min-width:0;width:100%" value="${h(a?.publishDate || today)}"></label>
        <label class="field"><span>Time</span><input name="publishTime" type="time" style="min-width:0;width:100%" value="${h(a?.publishTime)}"></label></div>
        <label class="field"><span>Runs for (days, publish day included)</span><input name="durationDays" type="number" min="1" max="365" step="1" value="${h(a?.durationDays || 1)}"></label>
        <div id="adf-warning"></div>
        <div id="adf-rules" class="mini-help"></div>
        <label class="field"><span>Caption</span><textarea name="caption" rows="6" maxlength="4000" placeholder="What the post says">${h(a?.caption)}</textarea></label>
        <div class="row-card-actions" style="justify-content:flex-start"><button type="button" class="btn small" id="adf-copy">Copy caption</button></div>
        <div class="field"><span>Link a product (optional)</span>
          <input type="search" id="adf-product-q" placeholder="Search products to add a link to the caption">
          <div id="adf-product-results" class="stack gap-2"></div>
          <div id="adf-product" class="mini-help"></div></div>
        <div class="field"><span>Image</span>
          ${a?.imagePath ? `<div class="row-card-actions" style="justify-content:flex-start"><img src="${h(a.imagePath)}" alt="" style="max-width:160px;max-height:160px;border-radius:6px;border:1px solid var(--line)"><button type="button" class="btn small" id="adf-img-remove">Remove</button></div>` : ''}
          <input type="file" name="image" accept="image/jpeg,image/png,image/webp,image/gif,image/avif">
          <span class="mini-help">${a?.imagePath ? 'Choose a file to replace it. ' : ''}Saved as a web-friendly copy (max 1200px).</span></div>
        <div class="row-card-actions">${a ? '<button type="button" class="btn btn-danger" id="adf-del">Delete</button>' : '<span></span>'}<button class="btn btn-primary">Save</button></div></form>`,
      );
      const form = $('#adf', root);

      const syncGroups = () => {
        const p = platforms.find((x) => x.id === form.platformId.value);
        const wrap = $('#adf-group-wrap', root);
        const groups = p?.hasGroups ? p.groups : [];
        wrap.style.display = groups.length ? '' : 'none';
        const keep = groups.some((g) => g.id === form.groupId.value) ? form.groupId.value : a?.groupId || '';
        setHtml(form.groupId, options(groups.map((g) => ({ value: g.id, label: `${g.groupName}${g.allowedDays.length ? ` (${g.allowedDays.join(', ')})` : ''}` })), keep, { empty: 'Whole platform / no group' }));
        const g = groups.find((x) => x.id === form.groupId.value);
        const rules = [p?.notes && `<strong>${h(p.name)}:</strong> ${h(p.notes)}`, g?.notes && `<strong>${h(g.groupName)}:</strong> ${h(g.notes)}`].filter(Boolean);
        setHtml($('#adf-rules', root), rules.join('<br>'));
      };
      let seq = 0;
      const checkDay = async () => {
        const mine = ++seq;
        try {
          const r = await api('/marketing/adverts/check', { method: 'POST', body: { groupId: form.groupId.value, publishDate: form.publishDate.value } });
          if (mine === seq) setHtml($('#adf-warning', root), r.warning ? `<p class="badge warn" style="white-space:normal;text-transform:none;letter-spacing:0">⚠ ${h(r.warning)}</p>` : '');
        } catch { /* shown on save */ }
      };
      const showProduct = () => {
        setHtml($('#adf-product', root), productId ? `Linked: <strong>${h(productName || 'product')}</strong> <button type="button" class="btn small" id="adf-product-clear">Unlink</button>` : '');
        $('#adf-product-clear', root)?.addEventListener('click', () => { productId = ''; productName = ''; showProduct(); });
      };
      form.platformId.addEventListener('change', () => { syncGroups(); checkDay(); });
      form.groupId.addEventListener('change', () => { syncGroups(); checkDay(); });
      form.publishDate.addEventListener('change', checkDay);
      syncGroups();
      checkDay();
      showProduct();

      $('#adf-copy', root).addEventListener('click', () => (form.caption.value.trim() ? copyText(form.caption.value, kit) : toast('The caption is empty', true)));

      let searchTimer;
      $('#adf-product-q', root).addEventListener('input', (e) => {
        clearTimeout(searchTimer);
        const q = e.target.value.trim();
        const out = $('#adf-product-results', root);
        if (q.length < 2) return setHtml(out, '');
        searchTimer = setTimeout(async () => {
          try {
            const r = await api(`/products?${new URLSearchParams({ q, pageSize: 8, status: 'active' })}`);
            setHtml(out, r.items.map((p) => `<button type="button" class="picker-row" data-pick="${h(p.id)}"><span>${h(p.name)}</span><span class="muted">${h(kit.rand(p.priceCents))}</span></button>`).join('') || '<span class="muted">No live products match.</span>');
            out.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => {
              const p = r.items.find((x) => x.id === b.dataset.pick);
              productId = p.id;
              productName = p.name;
              const line = `${p.name} — ${kit.rand(p.priceCents).replace(/\s/g, '')}\n${productUrl(p.slug)}`;
              form.caption.value = form.caption.value.trim() ? `${form.caption.value.trim()}\n\n${line}` : line;
              setHtml(out, '');
              $('#adf-product-q', root).value = '';
              showProduct();
            }));
          } catch (err) { fail(err); }
        }, 300);
      });

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = {
          platformId: form.platformId.value,
          groupId: form.groupId.value,
          publishDate: form.publishDate.value,
          publishTime: form.publishTime.value,
          durationDays: form.durationDays.value,
          caption: form.caption.value,
          productId,
        };
        try {
          let saved = await api(a ? `/marketing/adverts/${a.id}` : '/marketing/adverts', { method: a ? 'PUT' : 'POST', body });
          const file = form.image.files[0];
          if (file) {
            const fd = new FormData();
            fd.append('image', file);
            saved = await api(`/marketing/adverts/${saved.id}/image`, { method: 'POST', form: fd });
          }
          toast(saved.dayWarning ? `Saved — note: ${saved.dayWarning}` : 'Advert saved', Boolean(saved.dayWarning));
          routes.adverts();
        } catch (err) { fail(err); }
      });
      $('#adf-img-remove', root)?.addEventListener('click', async () => {
        try { const saved = await api(`/marketing/adverts/${a.id}/image`, { method: 'DELETE' }); toast('Image removed'); editor(saved); } catch (err) { fail(err); }
      });
      $('#adf-del', root)?.addEventListener('click', async () => {
        if (!confirm('Delete this advert?')) return;
        try { await api(`/marketing/adverts/${a.id}`, { method: 'DELETE' }); toast('Deleted'); routes.adverts(); } catch (err) { fail(err); }
      });
    };

    $('#ad-show', root).addEventListener('change', (e) => { state.show = e.target.value; routes.adverts(); });
    $('#ad-platform-filter', root).addEventListener('change', (e) => { state.platformId = e.target.value; routes.adverts(); });
    root.addEventListener('click', (e) => {
      const copy = e.target.closest('[data-copy]');
      if (copy) {
        e.stopPropagation();
        return copyText(all.find((a) => a.id === copy.dataset.copy)?.caption || '', kit);
      }
      const tr = e.target.closest('tr[data-id]');
      if (tr) editor(all.find((a) => a.id === tr.dataset.id));
    });
    $('[data-ad-new]').addEventListener('click', () => editor(null));

    // #/adverts/<id> (from the Calendar) opens that advert; #/adverts/new a blank one.
    if (id === 'new') editor(null);
    else if (id) {
      const target = all.find((a) => a.id === id);
      if (target) editor(target);
    }
  };
}
