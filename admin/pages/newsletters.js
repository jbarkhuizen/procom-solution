// Admin → Marketing → Newsletters. See server/features/newsletters.js.
//   #/newsletters                 campaigns + sending status + limits
//   #/newsletters/c/<id> | /new   editor: blocks or plain text, live preview,
//                                 test email -> approve -> send, delivery stats
//   #/newsletters/subscribers     who is opted in (CSV export)
//   #/newsletters/suppressions    the do-not-email list

const STATUS = {
  draft: ['Draft', 'neutral'],
  approved: ['Approved', 'info'],
  sending: ['Sending', 'warn'],
  paused: ['Paused', 'bad'],
  sent: ['Sent', 'ok'],
  cancelled: ['Cancelled', 'neutral'],
};
const SUB_STATUS = {
  pending: ['Awaiting confirmation', 'warn'],
  confirmed: ['Confirmed', 'ok'],
  unsubscribed: ['Unsubscribed', 'bad'],
  unverified: ['Account not verified', 'warn'],
  disabled: ['Account disabled', 'bad'],
};
const REC_STATUS = { queued: 'info', sending: 'warn', sent: 'ok', failed: 'bad', skipped: 'neutral' };
const BLOCK_LABEL = { heading: 'Heading', text: 'Text', image: 'Image', button: 'Button', products: 'Product cards', divider: 'Divider' };

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(name, head, rows) {
  const csv = [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export default function register(routes, kit) {
  const { $, h, rand, fmtDate, api, toast, fail, view, setTop, setHtml } = kit;
  const badge = (map, s) => {
    const v = map[s] || [s, 'neutral'];
    const [label, cls] = Array.isArray(v) ? v : [s, v];
    return `<span class="badge ${h(cls)}">${h(label)}</span>`;
  };
  const tabs = (active) => `<div class="toolbar">
    ${[['', 'Campaigns'], ['subscribers', 'Subscribers'], ['suppressions', 'Do-not-email list']]
      .map(([k, l]) => `<a class="btn small ${k === active ? 'btn-primary' : ''}" href="#/newsletters${k ? `/${k}` : ''}">${h(l)}</a>`).join('')}
  </div>`;

  routes.newsletters = async (sub, id) => {
    if (sub === 'c' && id) return editor(id);
    if (sub === 'new') return editor(null);
    if (sub === 'subscribers') return subscribers();
    if (sub === 'suppressions') return suppressions();
    return campaigns();
  };

  // ------------------------------------------------------------ campaigns

  async function campaigns() {
    setTop('Marketing', 'Newsletters', '<a class="btn btn-primary" href="#/newsletters/new">+ New campaign</a>');
    const o = await api('/newsletters/overview');
    const u = o.usage;
    const queued = o.campaigns.reduce((n, c) => n + (['sending', 'paused'].includes(c.status) ? c.counts.queued : 0), 0);
    const root = view(`${tabs('')}
      <div class="stats">
        <div class="stat-card"><div class="label">Opted in</div><div class="value">${o.audience.total}</div><div class="mini-help">${o.audience.subscribers} signups · ${o.audience.accounts} accounts</div></div>
        <div class="stat-card"><div class="label">Sent today (SAST)</div><div class="value">${u.used} <span class="muted" style="font-size:1rem">/ ${u.cap}</span></div><div class="mini-help">${u.remaining} left today</div></div>
        <div class="stat-card"><div class="label">Waiting in the queue</div><div class="value">${queued}</div><div class="mini-help">${queued && u.cap ? `about ${Math.ceil(queued / u.cap)} day(s) at the daily limit` : 'nothing waiting'}</div></div>
        <div class="stat-card"><div class="label">Sender</div><div class="value" style="font-size:1.3rem">${u.paused ? '<span class="badge bad">Paused</span>' : '<span class="badge ok">Running</span>'}</div><div class="mini-help">${u.batchSize} emails per minute</div></div>
      </div>
      <div class="panel table-wrap">
        <table class="catalog"><thead><tr><th>Subject</th><th>Status</th><th class="num">Recipients</th><th>Progress</th><th>Created</th></tr></thead><tbody>
        ${o.campaigns.map((c) => `<tr data-id="${h(c.id)}" style="cursor:pointer">
            <td><strong>${h(c.subject)}</strong><br><span class="mini-help">${c.mode === 'text' ? 'Plain text' : `${c.blocks.length} block(s)`}${c.createdBy ? ` · by ${h(c.createdBy)}` : ''}</span></td>
            <td>${badge(STATUS, c.status)}</td>
            <td class="num">${c.recipients || '—'}</td>
            <td class="mini-help">${c.recipients ? `${c.counts.sent} sent · ${c.counts.queued} queued${c.counts.failed ? ` · ${c.counts.failed} failed` : ''}${c.counts.skipped ? ` · ${c.counts.skipped} skipped` : ''}` : c.testSentAt ? `Test sent ${h(fmtDate(c.testSentAt))}` : 'Not tested yet'}</td>
            <td>${h(fmtDate(c.createdAt))}</td></tr>`).join('') || '<tr><td colspan="5"><div class="empty">No campaigns yet — click “+ New campaign”.</div></td></tr>'}
        </tbody></table>
      </div>
      <details class="panel" style="margin-top:1rem"><summary><strong>Sending limits</strong> <span class="mini-help">— Gmail allows about 500 emails a day in total, order emails included</span></summary>
        <form id="nl-limits" class="grid-3" style="margin-top:0.8rem;align-items:end">
          <label class="field"><span>Newsletters per day (SAST, all campaigns + tests)</span><input name="dailyCap" type="number" min="0" max="2000" value="${h(u.cap)}"></label>
          <label class="field"><span>Emails per minute</span><input name="batchSize" type="number" min="1" max="100" value="${h(u.batchSize)}"></label>
          <label class="field checkbox"><input type="checkbox" name="paused" ${u.paused ? 'checked' : ''}><span>Pause all sending</span></label>
          <div><button class="btn btn-primary">Save limits</button></div>
        </form>
        <p class="mini-help">When the day's limit is reached, sending stops and carries on automatically after midnight. A server restart doesn't lose the queue.</p>
      </details>
      <p class="mini-help" style="margin-top:1rem">Only people who opted in get newsletters: footer/newsletter-page signups who clicked the confirmation link, and customers who ticked “email me specials” on their verified account. Anyone on the do-not-email list is skipped. Every email has a one-click unsubscribe link.</p>`);
    root.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (tr) location.hash = `#/newsletters/c/${encodeURIComponent(tr.dataset.id)}`;
    });
    $('#nl-limits', root).addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await api('/newsletters/settings', { method: 'PUT', body: { dailyCap: f.dailyCap.value, batchSize: f.batchSize.value, paused: f.paused.checked } });
        toast('Limits saved');
        campaigns();
      } catch (err) { fail(err); }
    });
  }

  // --------------------------------------------------------------- editor

  async function editor(id) {
    let c = id ? await api(`/newsletters/campaigns/${encodeURIComponent(id)}`) : null;
    const testTo = (await api('/newsletters/test-address').catch(() => ({ to: '' }))).to;
    let state = { subject: c?.subject || '', mode: c?.mode || 'blocks', blocks: c?.blocks?.length ? structuredClone(c.blocks) : [{ type: 'heading', text: '' }, { type: 'text', text: '' }], bodyText: c?.bodyText || '' };
    let dirty = !c;
    const products = new Map(); // id -> picker item (names/prices for chosen products)
    const allIds = () => state.blocks.filter((b) => b.type === 'products').flatMap((b) => b.ids || []);
    if (allIds().length) (await api(`/newsletters/products?ids=${encodeURIComponent(allIds().join(','))}`).catch(() => [])).forEach((p) => products.set(p.id, p));

    const editable = () => !c || ['draft', 'approved'].includes(c.status);
    setTop('Newsletters', c ? c.subject : 'New campaign', '<a class="btn" href="#/newsletters">← Campaigns</a>');
    const root = view(`<div class="editor-layout">
      <div class="stack gap-3">
        <div class="panel" id="nl-form"></div>
        <div id="nl-delivery"></div>
      </div>
      <div class="stack gap-3">
        <div class="panel" id="nl-steps"></div>
        <div class="panel"><div class="section-head"><h3>Preview</h3><span class="mini-help">Prices are live — they're read again when each batch goes out.</span></div>
          <div id="nl-warn" class="mini-help"></div>
          <iframe id="nl-preview" class="newsletter-preview" sandbox="" title="Email preview" style="min-height:560px"></iframe></div>
      </div>
    </div>`);

    // ---- form
    const blockFields = (b, i) => {
      const dis = editable() ? '' : 'disabled';
      switch (b.type) {
        case 'heading': return `<input data-f="text" data-i="${i}" maxlength="200" value="${h(b.text)}" placeholder="e.g. This week's specials" ${dis}>`;
        case 'text': return `<textarea data-f="text" data-i="${i}" rows="4" placeholder="Write a paragraph. Leave an empty line between paragraphs; web links become clickable." ${dis}>${h(b.text)}</textarea>`;
        case 'image': return `<div class="grid-2"><input data-f="url" data-i="${i}" value="${h(b.url)}" placeholder="Image address (https://… or /uploads/…)" ${dis}><input data-f="alt" data-i="${i}" value="${h(b.alt)}" placeholder="Description (for screen readers)" ${dis}></div>
          <input data-f="link" data-i="${i}" value="${h(b.link)}" placeholder="Optional: link when clicked (https://… or /shop.html)" style="margin-top:0.4rem" ${dis}>`;
        case 'button': return `<div class="grid-2"><input data-f="text" data-i="${i}" maxlength="80" value="${h(b.text)}" placeholder="Label, e.g. Shop the specials" ${dis}><input data-f="url" data-i="${i}" value="${h(b.url)}" placeholder="Link, e.g. /specials.html" ${dis}></div>`;
        case 'products': return `<div class="stack gap-2">
            ${(b.ids || []).map((pid, j) => {
              const p = products.get(pid);
              return `<div class="row-card" style="padding:0.4rem 0.6rem;display:flex;justify-content:space-between;align-items:center;gap:0.5rem">
                <span>${p ? `${h(p.name)} <span class="mini-help">${rand(p.priceCents)}${p.onSpecial ? ' · on special' : ''}${p.minOrderQty > 1 ? ` · min ${p.minOrderQty}` : ''}</span>` : `<span class="muted">Not in the shop any more (${h(pid)})</span>`}</span>
                ${editable() ? `<button type="button" class="btn small" data-act="rm-product" data-i="${i}" data-j="${j}">Remove</button>` : ''}</div>`;
            }).join('') || '<span class="mini-help">No products chosen yet.</span>'}
            ${editable() && (b.ids || []).length < 12 ? `<input data-product-search="${i}" placeholder="Search products by name, brand or code…" autocomplete="off"><div data-product-results="${i}" class="stack gap-2"></div>` : ''}
          </div>`;
        default: return '<span class="mini-help">A thin line between sections.</span>';
      }
    };
    const renderForm = () => {
      const dis = editable() ? '' : 'disabled';
      setHtml($('#nl-form', root), `<form id="nl-edit" class="stack gap-3">
        <label class="field"><span>Subject line</span><input name="subject" maxlength="150" value="${h(state.subject)}" placeholder="e.g. Up to 20% off keyboards this week" ${dis}></label>
        <div class="toolbar" style="margin:0"><span class="field-label">Content</span>
          <label class="field checkbox"><input type="radio" name="mode" value="blocks" ${state.mode === 'blocks' ? 'checked' : ''} ${dis}><span>Blocks</span></label>
          <label class="field checkbox"><input type="radio" name="mode" value="text" ${state.mode === 'text' ? 'checked' : ''} ${dis}><span>Plain text</span></label></div>
        ${state.mode === 'text'
          ? `<label class="field"><span>Email text</span><textarea name="bodyText" rows="14" placeholder="Leave an empty line between paragraphs." ${dis}>${h(state.bodyText)}</textarea></label>`
          : `<div class="stack gap-2">${state.blocks.map((b, i) => `<div class="row-card" style="display:block">
              <div class="section-head" style="margin-bottom:0.4rem"><strong>${h(BLOCK_LABEL[b.type] || b.type)}</strong>
                ${editable() ? `<span class="row-card-actions"><button type="button" class="btn small" data-act="up" data-i="${i}" ${i ? '' : 'disabled'}>↑</button><button type="button" class="btn small" data-act="down" data-i="${i}" ${i < state.blocks.length - 1 ? '' : 'disabled'}>↓</button><button type="button" class="btn small btn-danger" data-act="del" data-i="${i}">✕</button></span>` : ''}</div>
              <div class="field">${blockFields(b, i)}</div></div>`).join('')}
            ${editable() ? `<div class="toolbar" style="margin:0">${Object.entries(BLOCK_LABEL).map(([t, l]) => `<button type="button" class="btn small" data-add="${t}">+ ${h(l)}</button>`).join('')}</div>` : ''}</div>`}
        ${editable() ? `<div class="row-card-actions">${c ? '<button type="button" class="btn btn-danger" data-act="delete-campaign">Delete</button>' : '<span></span>'}<button type="button" class="btn btn-primary" data-act="save">${dirty ? 'Save draft' : 'Saved'}</button></div>` : '<p class="mini-help">This campaign has been sent (or is sending), so it can no longer be edited.</p>'}
      </form>`);
    };

    // ---- workflow steps
    const renderSteps = () => {
      const s = c?.status || 'draft';
      const step = (n, done, title, body) => `<div class="row-card" style="display:block;${done ? 'opacity:0.75' : ''}"><strong>${done ? '✓' : `${n}.`} ${h(title)}</strong><div style="margin-top:0.35rem">${body}</div></div>`;
      const tested = Boolean(c?.testSentAt) && !dirty;
      setHtml($('#nl-steps', root), `<div class="section-head"><h3>Send</h3>${c ? badge(STATUS, s) : ''}</div>
        <div class="stack gap-2">
        ${step(1, Boolean(c) && !dirty, 'Save the draft', dirty ? '<span class="mini-help">You have unsaved changes.</span>' : '<span class="mini-help">Saved.</span>')}
        ${step(2, tested, 'Send yourself a test', `<div class="toolbar" style="margin:0"><input id="nl-test-to" type="email" value="${h(c?.testSentTo || testTo)}" style="flex:1;min-width:10rem"><button type="button" class="btn" data-act="test" ${c && editable() ? '' : 'disabled'}>Send test</button></div>
          <span class="mini-help">${c?.testSentAt ? `Last test: ${h(fmtDate(c.testSentAt))} to ${h(c.testSentTo)}. ` : ''}Open it on your phone and check prices, links and pictures.</span>`)}
        ${step(3, ['approved', 'sending', 'paused', 'sent'].includes(s) && !dirty, 'Approve', `<button type="button" class="btn" data-act="approve" ${s === 'draft' && tested ? '' : 'disabled'}>Approve campaign</button>
          ${c?.approvedAt ? `<span class="mini-help"> Approved ${h(fmtDate(c.approvedAt))}${c.approvedBy ? ` by ${h(c.approvedBy)}` : ''}</span>` : ''}`)}
        ${step(4, ['sending', 'paused', 'sent'].includes(s), 'Send to everyone who opted in', `<button type="button" class="btn btn-primary" data-act="send" ${s === 'approved' && !dirty ? '' : 'disabled'}>Send now</button>
          <span class="mini-help"> Queued in small batches; the daily limit is shared by all campaigns.</span>`)}
        </div>`);
    };

    // ---- delivery stats
    const renderDelivery = async () => {
      const box = $('#nl-delivery', root);
      if (!c || !['sending', 'paused', 'sent', 'cancelled'].includes(c.status)) return setHtml(box, '');
      const list = await api(`/newsletters/campaigns/${encodeURIComponent(c.id)}/recipients`);
      const k = c.counts;
      setHtml(box, `<div class="panel">
        <div class="section-head"><h3>Delivery</h3><span class="row-card-actions">
          ${c.status === 'sending' ? '<button type="button" class="btn small" data-act="pause">Pause</button>' : ''}
          ${c.status === 'paused' ? '<button type="button" class="btn small" data-act="resume">Resume</button>' : ''}
          ${['sending', 'paused'].includes(c.status) ? '<button type="button" class="btn small btn-danger" data-act="cancel">Cancel the rest</button>' : ''}
          ${k.failed && ['sent', 'sending', 'paused'].includes(c.status) ? '<button type="button" class="btn small" data-act="retry">Retry failed</button>' : ''}
          <button type="button" class="btn small" data-act="refresh">Refresh</button></span></div>
        <div class="newsletter-analytics">
          <div><span>Recipients</span><strong>${c.recipients}</strong></div>
          <div><span>Sent</span><strong>${k.sent}</strong></div>
          <div><span>Waiting</span><strong>${k.queued + k.sending}</strong></div>
          <div><span>Failed</span><strong>${k.failed}</strong></div>
          <div><span>Skipped</span><strong>${k.skipped}</strong></div>
          <p class="newsletter-analytics-note">Queued ${h(fmtDate(c.queuedAt))}${c.finishedAt ? ` · finished ${h(fmtDate(c.finishedAt))}` : ''}. Skipped = unsubscribed or suppressed after the campaign was queued, or cancelled. “Sent” means Gmail accepted it — opens aren't tracked.</p>
        </div>
        <div class="table-wrap" style="max-height:22rem;margin-top:0.8rem"><table class="catalog"><thead><tr><th>Email</th><th>Via</th><th>Status</th><th>When</th></tr></thead><tbody>
          ${list.map((r) => `<tr><td>${h(r.email)}</td><td>${r.source === 'account' ? 'Account' : 'Signup'}</td><td>${badge(REC_STATUS, r.status)}${r.error ? `<br><span class="mini-help">${h(r.error)}</span>` : ''}</td><td class="mini-help">${h(fmtDate(r.sentAt || r.attemptedAt || r.queuedAt))}</td></tr>`).join('')}
        </tbody></table></div></div>`);
    };

    // ---- preview (debounced; server renders exactly what is emailed)
    let timer;
    let seq = 0;
    const preview = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const mine = ++seq;
        try {
          const r = await api('/newsletters/preview', { method: 'POST', body: state });
          if (mine !== seq) return;
          $('#nl-preview', root).srcdoc = r.html;
          setHtml($('#nl-warn', root), r.warnings.map((w) => `<p class="error-text">${h(w)}</p>`).join(''));
        } catch (err) {
          if (mine === seq) setHtml($('#nl-warn', root), `<p class="error-text">${h(err.message)}</p>`);
        }
      }, 400);
    };

    const refreshAll = () => {
      renderForm();
      renderSteps();
      preview();
    };
    const markDirty = () => {
      if (!dirty) {
        dirty = true;
        renderSteps();
        const save = root.querySelector('[data-act="save"]');
        if (save) save.textContent = 'Save draft';
      }
      preview();
    };

    const save = async () => {
      if (c?.status === 'approved' && !confirm('Saving changes sends this campaign back to draft — you will need to send a new test and approve it again. Continue?')) return false;
      const saved = await api(c ? `/newsletters/campaigns/${encodeURIComponent(c.id)}` : '/newsletters/campaigns', { method: c ? 'PUT' : 'POST', body: state });
      const isNew = !c;
      c = saved;
      dirty = false;
      if (isNew) history.replaceState(null, '', `#/newsletters/c/${encodeURIComponent(c.id)}`);
      setTop('Newsletters', c.subject, '<a class="btn" href="#/newsletters">← Campaigns</a>');
      refreshAll();
      return true;
    };

    // ---- events
    root.addEventListener('input', (e) => {
      const t = e.target;
      if (t.name === 'subject') state.subject = t.value;
      else if (t.name === 'bodyText') state.bodyText = t.value;
      else if (t.dataset.f) state.blocks[Number(t.dataset.i)][t.dataset.f] = t.value;
      else if (t.dataset.productSearch !== undefined) return searchProducts(t);
      else return;
      markDirty();
    });
    root.addEventListener('change', (e) => {
      if (e.target.name === 'mode') {
        state.mode = e.target.value;
        dirty = true;
        refreshAll();
      }
    });

    root.addEventListener('submit', (e) => e.preventDefault()); // Enter in a field must not reload

    let searchTimer;
    const searchProducts = (input) => {
      clearTimeout(searchTimer);
      const i = Number(input.dataset.productSearch);
      const out = root.querySelector(`[data-product-results="${i}"]`);
      const q = input.value.trim();
      if (q.length < 2) return setHtml(out, '');
      searchTimer = setTimeout(async () => {
        try {
          const list = await api(`/newsletters/products?q=${encodeURIComponent(q)}`);
          list.forEach((p) => products.set(p.id, p));
          const chosen = new Set(state.blocks[i].ids || []);
          setHtml(out, list.filter((p) => !chosen.has(p.id)).slice(0, 8).map((p) => `<button type="button" class="btn small" style="justify-content:flex-start;text-align:left" data-act="add-product" data-i="${i}" data-id="${h(p.id)}">+ ${h(p.name)} · ${rand(p.priceCents)}${p.onSpecial ? ' (special)' : ''}${p.inStock ? '' : ' · out of stock'}</button>`).join('') || '<span class="mini-help">No matching products in the shop.</span>');
        } catch (err) { fail(err); }
      }, 300);
    };

    root.addEventListener('click', async (e) => {
      const add = e.target.closest('[data-add]');
      if (add) {
        const t = add.dataset.add;
        state.blocks.push(t === 'products' ? { type: t, ids: [] } : t === 'divider' ? { type: t } : { type: t, text: '', url: '', alt: '', link: '' });
        dirty = true;
        return refreshAll();
      }
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const i = Number(btn.dataset.i);
      const cid = c ? encodeURIComponent(c.id) : '';
      const act = async (path, msg) => {
        c = await api(`/newsletters/campaigns/${cid}/${path}`, { method: 'POST' });
        if (msg) toast(msg);
        refreshAll();
        await renderDelivery();
      };
      try {
        switch (btn.dataset.act) {
          case 'up':
          case 'down': {
            const j = btn.dataset.act === 'up' ? i - 1 : i + 1;
            [state.blocks[i], state.blocks[j]] = [state.blocks[j], state.blocks[i]];
            dirty = true;
            return refreshAll();
          }
          case 'del':
            state.blocks.splice(i, 1);
            dirty = true;
            return refreshAll();
          case 'add-product':
            state.blocks[i].ids = [...(state.blocks[i].ids || []), btn.dataset.id];
            dirty = true;
            return refreshAll();
          case 'rm-product':
            state.blocks[i].ids.splice(Number(btn.dataset.j), 1);
            dirty = true;
            return refreshAll();
          case 'save':
            if (await save()) toast('Draft saved');
            return;
          case 'delete-campaign':
            if (!confirm(`Delete “${c.subject}”?`)) return;
            await api(`/newsletters/campaigns/${cid}`, { method: 'DELETE' });
            toast('Deleted');
            location.hash = '#/newsletters';
            return;
          case 'test': {
            if (dirty && !(await save())) return;
            const to = $('#nl-test-to', root).value.trim();
            c = await api(`/newsletters/campaigns/${encodeURIComponent(c.id)}/test`, { method: 'POST', body: { to } });
            toast(`Test sent to ${to}`);
            return refreshAll();
          }
          case 'approve':
            if (!confirm('Approve this campaign? Check the test email first — prices, links and pictures.')) return;
            return act('approve', 'Approved — ready to send');
          case 'send': {
            const o = await api('/newsletters/overview');
            if (!confirm(`Send “${c.subject}” to ${o.audience.total} people who opted in? At most ${o.usage.cap} go out per day, ${o.usage.batchSize} a minute.`)) return;
            return act('send', 'Queued — sending in batches');
          }
          case 'pause': return act('pause', 'Paused');
          case 'resume': return act('resume', 'Resumed');
          case 'cancel':
            if (!confirm('Cancel the emails that have not gone out yet? This cannot be undone.')) return;
            return act('cancel', 'Cancelled');
          case 'retry': return act('retry-failed', 'Failed emails queued again');
          case 'refresh':
            c = await api(`/newsletters/campaigns/${cid}`);
            renderSteps();
            return renderDelivery();
          default:
        }
      } catch (err) { fail(err); }
    });

    refreshAll();
    await renderDelivery();
  }

  // ---------------------------------------------------------- subscribers

  async function subscribers() {
    setTop('Marketing', 'Newsletter subscribers', '<button class="btn btn-primary" data-nl-csv>Export CSV</button>');
    const d = await api('/newsletters/subscribers');
    const rows = [...d.subscribers, ...d.accounts].sort((a, b) => String(b.subscribedAt || '').localeCompare(String(a.subscribedAt || '')));
    const sourceLabel = (r) => (r.kind === 'account' ? 'Account checkbox' : { footer: 'Footer signup', 'newsletter-page': 'Newsletter page', 'resubscribe-link': 'Re-subscribed from email link' }[r.source] || r.source || '—');
    const root = view(`${tabs('subscribers')}
      <div class="toolbar"><input id="nl-q" placeholder="Search email…" style="max-width:20rem"><span class="muted">${d.audience.total} receive newsletters (${d.audience.subscribers} signups, ${d.audience.accounts} accounts)</span></div>
      <div class="panel table-wrap"><table class="catalog"><thead><tr><th>Email</th><th>Status</th><th>Opted in via</th><th>Opted in</th><th>Confirmed</th><th>Gets emails</th><th></th></tr></thead>
        <tbody id="nl-rows"></tbody></table></div>
      <p class="mini-help">Signups must click the link in the confirmation email before they get anything. Account customers opt in with the checkbox on their verified account. Consent time and source are kept as proof of opt-in (POPIA). “Delete” removes a signup's record entirely (right to be forgotten); to stop emails but remember the choice, use “Don't email”.</p>`);
    const draw = () => {
      const q = $('#nl-q', root).value.trim().toLowerCase();
      const list = rows.filter((r) => !q || r.email.includes(q) || String(r.name || '').toLowerCase().includes(q));
      setHtml($('#nl-rows', root), list.map((r) => `<tr>
          <td>${h(r.email)}${r.name ? `<br><span class="mini-help">${h(r.name)}</span>` : ''}</td>
          <td>${badge(SUB_STATUS, r.status)}${r.suppressed ? ` <span class="badge bad">Do not email (${h(r.suppressed)})</span>` : ''}</td>
          <td>${h(sourceLabel(r))}</td>
          <td class="mini-help">${h(fmtDate(r.subscribedAt))}</td>
          <td class="mini-help">${h(fmtDate(r.confirmedAt)) || '—'}</td>
          <td>${r.receives ? '<span class="badge ok">Yes</span>' : '<span class="badge neutral">No</span>'}</td>
          <td><div class="row-card-actions">${r.suppressed ? '' : `<button class="btn small" data-act="suppress" data-email="${h(r.email)}">Don't email</button>`}${r.kind === 'subscriber' ? `<button class="btn small btn-danger" data-act="delete" data-id="${h(r.id)}" data-email="${h(r.email)}">Delete</button>` : ''}</div></td>
        </tr>`).join('') || '<tr><td colspan="7"><div class="empty">Nobody yet. The signup form is in the footer of every page.</div></td></tr>');
    };
    draw();
    $('#nl-q', root).addEventListener('input', draw);
    $('[data-nl-csv]').addEventListener('click', () => downloadCsv(
      `newsletter-subscribers-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Email', 'Name', 'Type', 'Status', 'Opted in via', 'Opted in at', 'Confirmed at', 'Unsubscribed at', 'Do not email', 'Gets emails'],
      rows.map((r) => [r.email, r.name || '', r.kind, r.status, sourceLabel(r), r.subscribedAt || '', r.confirmedAt || '', r.unsubscribedAt || '', r.suppressed, r.receives ? 'yes' : 'no']),
    ));
    root.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      try {
        if (btn.dataset.act === 'suppress') {
          const note = prompt(`Stop all newsletters to ${btn.dataset.email}? Optional note (e.g. “asked by phone”):`, '');
          if (note === null) return;
          await api('/newsletters/suppressions', { method: 'POST', body: { email: btn.dataset.email, note } });
          toast('Added to the do-not-email list');
        } else if (btn.dataset.act === 'delete') {
          if (!confirm(`Delete the signup record for ${btn.dataset.email}? Use this for “please delete my details” requests.`)) return;
          await api(`/newsletters/subscribers/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' });
          toast('Deleted');
        }
        subscribers();
      } catch (err) { fail(err); }
    });
  }

  // --------------------------------------------------------- suppressions

  async function suppressions() {
    setTop('Marketing', 'Do-not-email list');
    const list = await api('/newsletters/suppressions');
    const reason = { unsubscribe: 'Unsubscribed', admin: 'Added by admin', bounce: 'Bounced' };
    const root = view(`${tabs('suppressions')}
      <form id="nl-sup" class="panel toolbar" style="align-items:end">
        <label class="field" style="flex:1;min-width:14rem"><span>Email address</span><input name="email" type="email" required placeholder="someone@example.com"></label>
        <label class="field" style="flex:1;min-width:14rem"><span>Note (optional)</span><input name="note" maxlength="300" placeholder="e.g. asked by WhatsApp"></label>
        <button class="btn btn-primary">Add to list</button>
      </form>
      <div class="panel table-wrap"><table class="catalog"><thead><tr><th>Email</th><th>Why</th><th>Since</th><th></th></tr></thead><tbody>
        ${list.map((s) => `<tr><td>${h(s.email)}</td><td>${h(reason[s.reason] || s.reason)}${s.note ? `<br><span class="mini-help">${h(s.note)}</span>` : ''}</td><td class="mini-help">${h(fmtDate(s.createdAt))}</td>
          <td><button class="btn small" data-rm="${h(s.email)}">Remove</button></td></tr>`).join('') || '<tr><td colspan="4"><div class="empty">Nobody on the list.</div></td></tr>'}
      </tbody></table></div>
      <p class="mini-help">Addresses here never get a newsletter or a signup confirmation. Someone who unsubscribed is lifted off the list only if they later opt in again themselves (confirmation link or their account checkbox). Removing an address does <strong>not</strong> subscribe it.</p>`);
    $('#nl-sup', root).addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/newsletters/suppressions', { method: 'POST', body: { email: e.target.email.value, note: e.target.note.value } });
        toast('Added');
        suppressions();
      } catch (err) { fail(err); }
    });
    root.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-rm]');
      if (!b || !confirm(`Remove ${b.dataset.rm} from the do-not-email list? They still won't get newsletters unless they opt in.`)) return;
      try {
        await api(`/newsletters/suppressions/${encodeURIComponent(b.dataset.rm)}`, { method: 'DELETE' });
        toast('Removed');
        suppressions();
      } catch (err) { fail(err); }
    });
  }
}
