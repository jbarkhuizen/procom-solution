// Admin → Marketing → Specials. See server/features/specials.js.
// A special shows on the storefront as the price with the normal price struck
// through. It never goes below cost incl VAT: the "Capped" column and the
// preview show which products hit that floor.

const STATE_BADGE = {
  running: ['Running', 'ok'],
  scheduled: ['Scheduled', 'info'],
  ended: ['Ended', 'neutral'],
  off: ['Off', 'bad'],
};
const TARGET_LABEL = { product: 'Product', category: 'Category', brand: 'Brand' };

async function categoryOpts(kit) {
  const { tree } = await kit.categories(true);
  const path = [];
  return kit.flattenTree(tree).map((c) => {
    path.length = c.depth;
    path.push(c.name);
    return { value: c.id, label: path.join(' › ') };
  });
}

export default function register(routes, kit) {
  const { $, h, rand, toRands, api, toast, fail, view, setTop, options, setHtml } = kit;
  const n = (v) => Number(v || 0).toLocaleString('en-ZA');
  const badge = (s) => {
    const [l, c] = STATE_BADGE[s] || [s, 'neutral'];
    return `<span class="badge ${c}">${h(l)}</span>`;
  };
  const discount = (s) => (s.kind === 'percent' ? `${s.percentOff}% off` : `Special price ${rand(s.priceCents)}`);
  const dates = (s) => (s.startsAt || s.endsAt ? `${s.startsAt || '…'} → ${s.endsAt || '…'}` : 'No end date');

  function previewHtml(r) {
    const head = `<p><strong>${n(r.affected)}</strong> of ${n(r.products)} product(s) get a lower price.
      ${r.capped ? `<span class="badge warn">Cost floor</span> ${n(r.capped)} capped at cost incl VAT.` : '<span class="badge ok">No product hits the cost floor</span>'}
      ${r.notLower ? `<br><span class="mini-help">${n(r.notLower)} unchanged — the special would not be below their normal price.</span>` : ''}</p>`;
    if (!r.items.length) return head;
    const rows = r.items
      .map(
        (i) => `<tr><td>${h(i.name)}<br><span class="mini-help">${h(i.sku)}${i.active ? '' : ' · hidden'}</span></td>
        <td class="num">${rand(i.normalCents)}</td>
        <td class="num">${i.lower ? `<strong>${rand(i.specialCents)}</strong>` : '<span class="muted">no change</span>'}${i.capped ? `<br><span class="mini-help">asked ${rand(i.requestedCents)}</span>` : ''}</td>
        <td class="num">${rand(i.floorCents)}</td>
        <td>${i.capped ? '<span class="badge warn">Capped</span>' : ''}</td></tr>`,
      )
      .join('');
    return `${head}<div class="table-wrap" style="max-height:420px;overflow:auto"><table class="catalog"><thead><tr><th>Product</th><th class="num">Normal</th><th class="num">Special</th><th class="num">Cost floor</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      ${r.items.length < r.products ? `<p class="mini-help">Showing ${n(r.items.length)} of ${n(r.products)} (capped first).</p>` : ''}`;
  }

  routes.specials = async () => {
    setTop('Marketing', 'Specials', '<button class="btn btn-primary" data-special-new>+ Special</button>');
    const [list, cats, meta] = await Promise.all([api('/specials'), categoryOpts(kit), api('/specials/options')]);
    const root = view(`<div class="editor-layout">
      <div class="panel table-wrap">
        <p class="mini-help" style="margin-bottom:0.75rem">A running special replaces the price in the shop, with the normal price struck through. When several specials cover a product the lowest price wins. No special goes below cost incl VAT — those products are capped at cost and counted under <em>Capped</em>. Admin screens keep showing the normal price.</p>
        <table class="catalog"><thead><tr><th>Special</th><th>For</th><th>Discount</th><th>When</th><th class="num">Products</th><th class="num">Capped</th></tr></thead><tbody>
        ${
          list
            .map(
              (s) => `<tr data-id="${h(s.id)}" style="cursor:pointer">
            <td><strong>${h(s.label)}</strong></td>
            <td>${h(TARGET_LABEL[s.targetType])}<br><span class="mini-help">${h(s.targetName)}</span></td>
            <td>${h(discount(s))}</td>
            <td>${badge(s.state)}<br><span class="mini-help">${h(dates(s))}</span></td>
            <td class="num">${n(s.affected)}${s.affected !== s.products ? `<br><span class="mini-help">of ${n(s.products)}</span>` : ''}</td>
            <td class="num">${s.capped ? `<span class="badge warn">${n(s.capped)}</span>` : '<span class="muted">0</span>'}</td></tr>`,
            )
            .join('') || '<tr><td colspan="6"><div class="empty">No specials yet.</div></td></tr>'
        }
        </tbody></table>
        <div id="special-preview" style="margin-top:1rem"></div>
      </div>
      <div class="panel sticky-panel" id="special-editor"><p class="muted">Select a special to edit, or add a new one.</p></div>
    </div>`);

    const editor = (s) => {
      root.querySelectorAll('tr[data-id]').forEach((tr) => tr.classList.toggle('selected', Boolean(s) && tr.dataset.id === s.id));
      setHtml($('#special-preview', root), '');
      let productId = s?.targetType === 'product' ? s.targetId : '';
      let productName = s?.targetType === 'product' ? s.targetName : '';
      setHtml(
        $('#special-editor', root),
        `<form id="spform" class="stack gap-3"><div class="section-head"><h3>${s ? 'Edit special' : 'New special'}</h3></div>
        <label class="field"><span>Label (shown to you; e.g. Month-end special)</span><input name="label" maxlength="80" value="${h(s?.label || '')}" placeholder="Month-end special"></label>
        <label class="field"><span>Special for</span><select name="targetType">${options([{ value: 'product', label: 'One product' }, { value: 'category', label: 'A category (incl. its sub-categories)' }, { value: 'brand', label: 'A brand' }], s?.targetType || 'category')}</select></label>
        <div data-target="product" class="stack gap-3">
          <label class="field"><span>Find product (name, SKU or supplier code)</span><input id="sp-search" type="search" autocomplete="off" placeholder="Type to search…"></label>
          <div id="sp-results" class="stack"></div>
          <p class="mini-help">Selected: <strong id="sp-picked">${h(productName || 'none')}</strong></p>
        </div>
        <label class="field" data-target="category"><span>Category</span><select name="categoryId">${options(cats, s?.targetType === 'category' ? s.targetId : '', { empty: 'Choose…' })}</select></label>
        <label class="field" data-target="brand"><span>Brand</span><input name="brand" list="sp-brands" value="${h(s?.targetType === 'brand' ? s.targetId : '')}"></label>
        <datalist id="sp-brands">${meta.brands.map((b) => `<option value="${h(b.name)}">${h(b.count)} products</option>`).join('')}</datalist>
        <div class="grid-2"><label class="field"><span>Discount type</span><select name="kind">${options([{ value: 'percent', label: 'Percentage off' }, { value: 'price', label: 'Fixed special price (one product)' }], s?.kind || 'percent')}</select></label>
        <label class="field" data-kind="percent"><span>Percentage off</span><input name="percentOff" type="number" step="0.5" min="0.5" max="99" value="${h(s?.kind === 'percent' ? s.percentOff : 5)}"></label>
        <label class="field" data-kind="price"><span>Special price R</span><input name="price" type="number" step="0.01" min="0" value="${h(s?.kind === 'price' ? toRands(s.priceCents) : '')}"></label></div>
        <div class="grid-2" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)"><label class="field"><span>Starts (blank = now)</span><input name="startsAt" type="date" style="min-width:0;width:100%" value="${h(s?.startsAt)}"></label>
        <label class="field"><span>Ends (blank = never)</span><input name="endsAt" type="date" style="min-width:0;width:100%" value="${h(s?.endsAt)}"></label></div>
        <label class="field checkbox"><input type="checkbox" name="active" ${!s || s.active ? 'checked' : ''}><span>Active</span></label>
        <p class="mini-help">Percentages round up to the whole rand. Dates are South African days, start and end day included; a change shows in the shop within a minute. Today is ${h(meta.today)}.</p>
        <div class="row-card-actions">${s ? '<button type="button" class="btn btn-danger" id="sp-del">Delete</button>' : '<span></span>'}<span style="display:flex;gap:0.5rem;flex-wrap:wrap;justify-content:flex-end"><button type="button" class="btn" id="sp-preview">Preview products</button> <button class="btn btn-primary">Save</button></span></div></form>`,
      );
      const form = $('#spform', root);
      const sync = () => {
        const type = form.targetType.value;
        if (type !== 'product' && form.kind.value === 'price') form.kind.value = 'percent';
        form.kind.querySelector('option[value="price"]').disabled = type !== 'product';
        form.querySelectorAll('[data-target]').forEach((el) => (el.style.display = el.dataset.target === type ? '' : 'none'));
        form.querySelectorAll('[data-kind]').forEach((el) => (el.style.display = el.dataset.kind === form.kind.value ? '' : 'none'));
      };
      form.targetType.addEventListener('change', sync);
      form.kind.addEventListener('change', sync);
      sync();

      // Product picker: admin product search, click a result to choose it.
      let timer;
      let found = [];
      $('#sp-search', root).addEventListener('input', (e) => {
        clearTimeout(timer);
        const q = e.target.value.trim();
        timer = setTimeout(async () => {
          if (q.length < 2) return setHtml($('#sp-results', root), '');
          try {
            const res = await api(`/products?q=${encodeURIComponent(q)}&pageSize=10&status=active`);
            found = res.items;
            setHtml(
              $('#sp-results', root),
              found.map((p) => `<button type="button" class="btn small" style="justify-content:flex-start;text-align:left;margin-bottom:0.25rem" data-pick="${h(p.id)}">${h(p.name)} · ${rand(p.priceCents)}</button>`).join('') || '<p class="mini-help">No match.</p>',
            );
          } catch (err) { fail(err); }
        }, 300);
      });
      $('#sp-results', root).addEventListener('click', (e) => {
        const b = e.target.closest('[data-pick]');
        if (!b) return;
        const p = found.find((x) => x.id === b.dataset.pick);
        productId = p.id;
        productName = p.name;
        $('#sp-picked', root).textContent = p.name;
        setHtml($('#sp-results', root), '');
        $('#sp-search', root).value = '';
      });

      const body = () => {
        const f = Object.fromEntries(new FormData(form));
        const targetId = f.targetType === 'product' ? productId : f.targetType === 'category' ? f.categoryId : f.brand;
        return { label: f.label, targetType: f.targetType, targetId, kind: f.kind, percentOff: f.percentOff, price: f.price, startsAt: f.startsAt, endsAt: f.endsAt, active: form.active.checked };
      };
      $('#sp-preview', root).addEventListener('click', async () => {
        try {
          const r = await api('/specials/preview', { method: 'POST', body: body() });
          setHtml($('#special-preview', root), `<div class="section-head"><h3>Preview</h3></div>${previewHtml(r)}`);
          $('#special-preview', root).scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch (err) { fail(err); }
      });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api(s ? `/specials/${s.id}` : '/specials', { method: s ? 'PUT' : 'POST', body: body() });
          toast('Special saved');
          routes.specials();
        } catch (err) { fail(err); }
      });
      $('#sp-del', root)?.addEventListener('click', async () => {
        if (!confirm(`Delete "${s.label}"? Prices go back to normal straight away.`)) return;
        try { await api(`/specials/${s.id}`, { method: 'DELETE' }); toast('Deleted'); routes.specials(); } catch (err) { fail(err); }
      });
    };

    root.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (tr) editor(list.find((s) => s.id === tr.dataset.id));
    });
    $('[data-special-new]').addEventListener('click', () => editor(null));
  };
}
