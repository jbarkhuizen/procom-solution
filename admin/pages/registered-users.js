// Customers → Registered users: customer logins, with resend verification,
// verify manually, send password reset, disable/enable and delete.
export default function register(routes, kit) {
  const { h, fmtDate, api, toast, fail, view, setTop } = kit;

  routes['registered-users'] = async () => {
    setTop('Customers', 'Registered users');
    const list = await api('/registered-users');
    const verified = list.filter((u) => u.emailVerified).length;
    const root = view(`
      <div class="toolbar"><span class="muted">${list.length} account${list.length === 1 ? '' : 's'} · ${verified} verified</span></div>
      <div class="panel table-wrap"><table class="catalog">
        <thead><tr><th>Customer</th><th>Status</th><th class="num">Orders</th><th>Created</th><th>Last login</th><th></th></tr></thead>
        <tbody>${
          list.map((u) => `<tr>
            <td><a href="#/clients/${h(encodeURIComponent(u.email))}"><strong>${h(`${u.firstName} ${u.lastName}`.trim() || '—')}</strong></a><br><span class="muted">${h(u.email)}</span></td>
            <td>${u.emailVerified ? '<span class="badge ok">Verified</span>' : '<span class="badge warn">Unverified</span>'}${u.disabled ? ' <span class="badge bad">Disabled</span>' : ''}${u.newsletter ? ' <span class="badge info">Newsletter</span>' : ''}</td>
            <td class="num">${u.orderCount}</td>
            <td>${h(fmtDate(u.createdAt))}</td>
            <td>${h(fmtDate(u.lastLoginAt)) || '<span class="muted">Never</span>'}</td>
            <td><div class="row-card-actions">
              ${u.emailVerified ? '' : `<button class="btn small" data-act="resend" data-id="${h(u.id)}">Resend verification</button><button class="btn small" data-act="verify" data-id="${h(u.id)}">Mark verified</button>`}
              ${u.disabled ? '' : `<button class="btn small" data-act="reset" data-id="${h(u.id)}">Password reset</button>`}
              <button class="btn small" data-act="${u.disabled ? 'enable' : 'disable'}" data-id="${h(u.id)}">${u.disabled ? 'Enable' : 'Disable'}</button>
              <button class="btn small btn-danger" data-act="delete" data-id="${h(u.id)}" data-email="${h(u.email)}">Delete</button>
            </div></td>
          </tr>`).join('') || '<tr><td colspan="6" class="empty">No customer accounts yet.</td></tr>'
        }</tbody></table></div>
      <p class="mini-help">Customers register on the website (Account in the header). They must confirm their email before they can log in. Disable blocks login and signs them out; Delete removes the login only — their orders stay and still show under Clients.</p>`);

    root.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const id = encodeURIComponent(btn.dataset.id);
      try {
        switch (btn.dataset.act) {
          case 'resend':
            await api(`/registered-users/${id}/resend-verification`, { method: 'POST' });
            toast('Verification email sent');
            return;
          case 'reset':
            await api(`/registered-users/${id}/send-reset`, { method: 'POST' });
            toast('Password reset email sent (link valid for 1 hour)');
            return;
          case 'verify':
            if (!confirm('Mark this email as verified without the customer clicking the link?')) return;
            await api(`/registered-users/${id}/verify`, { method: 'POST' });
            toast('Marked as verified');
            break;
          case 'disable':
          case 'enable':
            await api(`/registered-users/${id}/disabled`, { method: 'PUT', body: { disabled: btn.dataset.act === 'disable' } });
            toast(btn.dataset.act === 'disable' ? 'Account disabled' : 'Account enabled');
            break;
          case 'delete':
            if (!confirm(`Delete the account for ${btn.dataset.email}? Their orders are kept.`)) return;
            await api(`/registered-users/${id}`, { method: 'DELETE' });
            toast('Account deleted');
            break;
          default:
            return;
        }
        routes['registered-users']();
      } catch (err) {
        fail(err);
      }
    });
  };
}
