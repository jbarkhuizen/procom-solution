// Admin → Marketing → Promo codes. See server/features/promos.js.
// Every discount is capped so no item goes below its cost incl VAT; the
// "Cost floor" column and the editor's live check show where that bites.

const STATE_BADGE = {
  running: ['Running', 'ok'],
  scheduled: ['Scheduled', 'info'],
  ended: ['Ended', 'neutral'],
  off: ['Off', 'bad'],
};

// Plain-language summary of how often the cost floor limits a code.
export function floorNote(p, f, kit) {
  const { h, rand } = kit;
  if (!f || !f.products) return '<span class="muted">No products in scope</span>';
  const asked = p.kind === 'percent' ? `${p.percentOff}% off` : `${rand(p.amountCents)} off`;
  if (!f.capped) return `<span class="badge ok">Full ${h(asked)}</span>`;
  const limit =
    p.kind === 'percent'
      ? `capped at ~${h(f.typicalCap)}% (lowest ${h(f.lowestCap)}%)`
      : `limited to their margin (typically ${h(rand(f.typicalCap))} per item)`;
  return `<span class="badge warn">Cost floor</span><br><span class="mini-help">${h(asked)} requested — ${limit} on ${f.capped.toLocaleString('en-ZA')} of ${f.products.toLocaleString('en-ZA')} products${f.fullyBlocked ? `; ${f.fullyBlocked.toLocaleString('en-ZA')} can't be discounted at all` : ''}</span>`;
}

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

  routes.promos = async () => {
    setTop('Marketing', 'Promo codes', '<button class="btn btn-primary" data-promo-new>+ Promo code</button>');
    const [list, cats, meta] = await Promise.all([api('/promos'), categoryOpts(kit), api('/promos/options')]);
    const discount = (p) => (p.kind === 'percent' ? `${p.percentOff}% off` : `${rand(p.amountCents)} off`);
    const scope = (p) => [p.categoryName && `in ${p.categoryName}`, p.brand && `brand ${p.brand}`, p.minSubtotalCents && `min order ${rand(p.minSubtotalCents)}`].filter(Boolean).join(' · ');
    const dates = (p) => (p.startsAt || p.endsAt ? `${p.startsAt || '…'} → ${p.endsAt || '…'}` : 'No end date');
    const badge = (s) => {
      const [l, c] = STATE_BADGE[s] || [s, 'neutral'];
      return `<span class="badge ${c}">${h(l)}</span>`;
    };
    const uses = (p) => `${p.uses}${p.maxUses != null ? ` / ${p.maxUses}` : ''}${p.maxUsesPerEmail != null ? `<br><span class="mini-help">${p.maxUsesPerEmail} per customer</span>` : ''}`;

    const root = view(`<div class="editor-layout">
      <div class="panel table-wrap">
        <p class="mini-help" style="margin-bottom:0.75rem">Codes are case-insensitive. Uses, revenue and discount given count <strong>paid</strong> orders only. No code can take an item below its cost incl VAT — the discount is capped automatically and the <em>Cost floor</em> column shows where.</p>
        <table class="catalog"><thead><tr><th>Code</th><th>Discount</th><th>When</th><th class="num">Uses</th><th class="num">Revenue</th><th style="min-width:9rem">Cost floor</th></tr></thead><tbody>
        ${
          list
            .map(
              (p) => `<tr data-id="${h(p.id)}" style="cursor:pointer">
            <td><strong>${h(p.code)}</strong>${p.description ? `<br><span class="muted">${h(p.description)}</span>` : ''}</td>
            <td>${h(discount(p))}${scope(p) ? `<br><span class="mini-help">${h(scope(p))}</span>` : ''}</td>
            <td>${badge(p.state)}<br><span class="mini-help">${h(dates(p))}</span></td>
            <td class="num">${uses(p)}</td>
            <td class="num">${rand(p.revenueCents)}<br><span class="mini-help">${rand(p.discountGivenCents)} off</span></td>
            <td>${floorNote(p, p.floor, kit)}</td></tr>`,
            )
            .join('') || '<tr><td colspan="6"><div class="empty">No promo codes yet — create one and share it in a campaign.</div></td></tr>'
        }
        </tbody></table>
      </div>
      <div class="panel sticky-panel" id="promo-editor"><p class="muted">Select a code to edit, or add a new one.</p></div>
    </div>`);

    const editor = (p) => {
      $$rows().forEach((tr) => tr.classList.toggle('selected', Boolean(p) && tr.dataset.id === p.id));
      setHtml(
        $('#promo-editor', root),
        `<form id="pform" class="stack gap-3"><div class="section-head"><h3>${p ? `Edit ${h(p.code)}` : 'New promo code'}</h3></div>
        <div class="grid-2"><label class="field"><span>Code</span><input name="code" required maxlength="40" value="${h(p?.code)}" placeholder="e.g. WELCOME10" style="text-transform:uppercase"></label>
        <label class="field"><span>Discount type</span><select name="kind">${options([{ value: 'percent', label: 'Percentage off' }, { value: 'fixed', label: 'Rand amount off' }], p?.kind || 'percent')}</select></label></div>
        <label class="field"><span>Note (admin only)</span><input name="description" maxlength="200" value="${h(p?.description)}" placeholder="e.g. Facebook campaign, October"></label>
        <div class="grid-2"><label class="field" data-kind="percent"><span>Percentage off</span><input name="percentOff" type="number" step="0.5" min="0.5" max="90" value="${h(p?.kind === 'percent' ? p.percentOff : 5)}"></label>
        <label class="field" data-kind="fixed"><span>Rand amount off</span><input name="amount" type="number" step="0.01" min="0" value="${h(p?.kind === 'fixed' ? toRands(p.amountCents) : '')}"></label>
        <label class="field"><span>Minimum order R (subtotal)</span><input name="minSubtotal" type="number" step="0.01" min="0" value="${h(p?.minSubtotalCents ? toRands(p.minSubtotalCents) : '')}" placeholder="none"></label></div>
        <label class="field"><span>Only for a category (incl. its sub-categories)</span><select name="categoryId">${options(cats, p?.categoryId || '', { empty: 'Any category' })}</select></label>
        <label class="field"><span>Only for a brand</span><input name="brand" list="promo-brands" value="${h(p?.brand)}" placeholder="Any brand"></label>
        <datalist id="promo-brands">${meta.brands.map((b) => `<option value="${h(b.name)}">`).join('')}</datalist>
        <div class="grid-2" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)"><label class="field"><span>Starts (blank = now)</span><input name="startsAt" type="date" style="min-width:0;width:100%" value="${h(p?.startsAt)}"></label>
        <label class="field"><span>Ends (blank = never)</span><input name="endsAt" type="date" style="min-width:0;width:100%" value="${h(p?.endsAt)}"></label></div>
        <div class="grid-2"><label class="field"><span>Max uses in total</span><input name="maxUses" type="number" min="1" step="1" value="${h(p?.maxUses ?? '')}" placeholder="unlimited"></label>
        <label class="field"><span>Max uses per customer email</span><input name="maxUsesPerEmail" type="number" min="1" step="1" value="${h(p?.maxUsesPerEmail ?? '')}" placeholder="unlimited"></label></div>
        <label class="field checkbox"><input type="checkbox" name="active" ${!p || p.active ? 'checked' : ''}><span>Active</span></label>
        <div id="promo-impact" class="mini-help"></div>
        <p class="mini-help">Dates are South African days, start and end day included. A use counts once the order is paid. Free delivery codes are not supported (delivery is per supplier).</p>
        <div class="row-card-actions">${p ? '<button type="button" class="btn btn-danger" id="p-del">Delete</button>' : '<span></span>'}<button class="btn btn-primary">Save</button></div></form>`,
      );
      const form = $('#pform', root);
      const body = () => ({ ...Object.fromEntries(new FormData(form)), active: form.active.checked });
      const syncKind = () => {
        const kind = form.kind.value;
        form.querySelectorAll('[data-kind]').forEach((el) => (el.style.display = el.dataset.kind === kind ? '' : 'none'));
      };
      // Live check of how the cost floor limits this code.
      let timer;
      let seq = 0;
      const impact = () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          const mine = ++seq;
          const b = body();
          try {
            const f = await api('/promos/impact', { method: 'POST', body: b });
            if (mine !== seq) return;
            const draft = { kind: b.kind, percentOff: Number(b.percentOff), amountCents: Math.round(Number(b.amount) * 100) || 0 };
            setHtml($('#promo-impact', root), `Cost floor check: ${floorNote(draft, f, kit)}`);
          } catch (err) {
            if (mine === seq) $('#promo-impact', root).textContent = err.message;
          }
        }, 350);
      };
      form.kind.addEventListener('change', syncKind);
      form.addEventListener('input', impact);
      form.addEventListener('change', impact);
      syncKind();
      impact();
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api(p ? `/promos/${p.id}` : '/promos', { method: p ? 'PUT' : 'POST', body: body() });
          toast('Promo code saved');
          routes.promos();
        } catch (err) { fail(err); }
      });
      $('#p-del', root)?.addEventListener('click', async () => {
        const note = p.uses ? ` It was used on ${p.uses} paid order(s); those orders keep their discount. Consider unticking Active instead.` : '';
        if (!confirm(`Delete promo code ${p.code}?${note}`)) return;
        try { await api(`/promos/${p.id}`, { method: 'DELETE' }); toast('Deleted'); routes.promos(); } catch (err) { fail(err); }
      });
    };
    const $$rows = () => [...root.querySelectorAll('tr[data-id]')];

    root.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (tr) editor(list.find((p) => p.id === tr.dataset.id));
    });
    $('[data-promo-new]').addEventListener('click', () => editor(null));
  };
}
