// Admin -> Site settings (overrides the core routes.settings in admin.js).
// Same keys and the same PUT /api/admin/settings as before -- only reorganised
// into clear sections with help text, validated in the browser, with a
// margin check against Payfast fees and links to settings that live on other
// pages. Every dynamic value goes through kit.h().

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const digits = (s) => String(s || '').replace(/[\s\-().]/g, '');
const FALLBACK_FEE_PCT = 3.5; // Payfast card, incl VAT, if the Finance estimate can't be read

// Fee on a typical R1,000 order as a % incl VAT, using the DEAREST payment method
// switched on in Financial overview -> Payfast fees (worst case for the margin).
function payfastFeePct(fin, vatRatePct) {
  const card = fin?.payfastFees?.pricing || fin?.payfastFees?.card;
  if (!card || !Number.isFinite(Number(card.pct))) return { pct: FALLBACK_FEE_PCT, fromFinance: false };
  const order = 100000;
  const base = Math.max((order * Number(card.pct)) / 100 + (Number(card.fixedCents) || 0), Number(card.minCents) || 0);
  const withVat = fin.payfastFees.addVat ? base * (1 + (Number(vatRatePct) || 0) / 100) : base;
  return { pct: (withVat / order) * 100, fromFinance: true };
}

// markup m on cost incl VAT -> share of the selling price above that cost = m / (1 + m).
export function marginCheck(markupPct, feePct) {
  const m = Math.max(0, Number(markupPct) || 0) / 100;
  const marginPct = (m / (1 + m)) * 100;
  const headroomPct = marginPct - feePct;
  const level = headroomPct <= 0 ? 'bad' : headroomPct < 8 ? 'warn' : 'ok';
  return { marginPct, headroomPct, level };
}

export function validateSettings(s) {
  const errors = {};
  const warnings = [];
  if (!String(s.siteName || '').trim()) errors.siteName = 'Enter the shop name.';
  if (String(s.announcement || '').length > 160) errors.announcement = 'Keep the announcement under 160 characters so it fits on a phone.';
  for (const k of ['contactEmail', 'ownerNotifyEmail']) {
    if (!EMAIL_RE.test(String(s[k] || '').trim())) errors[k] = 'Enter a valid email address, e.g. name@example.com.';
  }
  const phone = digits(s.contactPhone);
  if (phone && !/^(\+27|0)\d{9}$/.test(phone) && !/^\+\d{8,15}$/.test(phone)) errors.contactPhone = 'Enter a phone number like 082 663 9608 or +27 82 663 9608.';
  const wa = String(s.whatsappNumber || '').trim();
  if (wa) {
    if (!/^\d{10,15}$/.test(wa)) errors.whatsappNumber = 'Digits only in international format, no + or spaces, e.g. 27826639608.';
    else if (wa.startsWith('0')) errors.whatsappNumber = 'Start with the country code instead of 0, e.g. 27826639608.';
    else if (!wa.startsWith('27')) warnings.push('The WhatsApp number does not start with 27 (South Africa). Check it is right.');
  }
  const markup = Number(s.defaultMarkupPct);
  if (!Number.isFinite(markup) || markup < 0 || markup > 300) errors.defaultMarkupPct = 'Markup must be between 0% and 300%.';
  const vat = Number(s.vatRatePct);
  if (!Number.isFinite(vat) || vat < 0 || vat > 30) errors.vatRatePct = 'VAT rate must be between 0% and 30% (South Africa: 15%).';
  else if (vat !== 15) warnings.push(`VAT rate is ${vat}% (South Africa is 15%). Supplier prices are grossed up by this rate.`);
  if (s.vatRegistered && !/^4\d{9}$/.test(digits(s.vatNumber))) errors.vatNumber = 'A South African VAT number has 10 digits and starts with 4.';
  const w = Number(s.defaultWeightG);
  if (!Number.isFinite(w) || w < 1 || w > 100000) errors.defaultWeightG = 'Weight must be between 1 g and 100,000 g.';
  return { errors, warnings };
}

export default function register(routes, kit) {
  const { $, $$, h, api, toast, fail, view, setTop, siteSettings } = kit;

  routes.settings = async () => {
    setTop('Settings', 'Site settings');
    const [s, fin] = await Promise.all([siteSettings(true), api('/finance/settings').catch(() => null)]);

    const field = (key, label, help = '', { type = 'text', attrs = '' } = {}) => `<label class="field" data-field="${key}">
        <span>${h(label)}</span>
        <input name="${key}" type="${type}" value="${h(s[key])}" ${attrs} aria-describedby="help-${key} err-${key}">
        ${help ? `<small class="mini-help" id="help-${key}">${help}</small>` : ''}
        <small class="error hidden" id="err-${key}" role="alert" style="color:var(--danger);font-size:0.8rem"></small>
      </label>`;
    const section = (title, intro, body) => `<section class="panel stack gap-3">
        <div class="section-head"><h3>${h(title)}</h3></div>
        <p class="mini-help" style="margin-top:-0.4rem">${intro}</p>
        ${body}
      </section>`;
    const link = (hash, label, what) => `<li style="margin:0.35rem 0"><a href="${hash}"><strong>${h(label)}</strong></a> <span class="muted">— ${h(what)}</span></li>`;

    const root = view(`<form id="setform" novalidate>
      <div id="set-summary" class="panel hidden" role="alert" style="margin-bottom:1rem;border-left:4px solid var(--danger)"></div>
      <div class="grid-2" style="align-items:start">
        ${section('Business & contact', 'Who customers are dealing with and how they reach you. Shown in the footer, contact page, policies and emails.', `
          ${field('legalEntity', 'Legal entity', 'The business name in the footer, terms and privacy policy.')}
          ${field('contactEmail', 'Public email', 'Shown on the site and used as the reply-to address.', { type: 'email', attrs: 'autocomplete="email"' })}
          ${field('contactPhone', 'Public phone', 'e.g. 082 663 9608.', { type: 'tel' })}
          ${field('whatsappNumber', 'WhatsApp number', 'International digits only, no + or spaces — 27826639608. Used for the WhatsApp buttons.', { attrs: 'inputmode="numeric"' })}
          ${field('hours', 'Business hours', 'Free text, e.g. Mon–Fri 08:00–17:00 · Sat 09:00–13:00.')}`)}

        ${section('Storefront', 'What visitors see at the top of every page.', `
          ${field('siteName', 'Shop name', 'Used in page titles, emails and invoices.', { attrs: 'required maxlength="80"' })}
          ${field('tagline', 'Tagline', 'One line under the name, also used as the home page description.', { attrs: 'maxlength="160"' })}
          ${field('announcement', 'Announcement bar', 'Short message across the top of the site. Leave blank to hide it. Max 160 characters.', { attrs: 'maxlength="200"' })}`)}

        ${section('Pricing & VAT', 'Auto price = supplier cost excl VAT × (1 + VAT) × (1 + markup), rounded up to the next rand. A product or category markup overrides the default.', `
          ${field('defaultMarkupPct', 'Default markup %', 'On supplier cost incl VAT. Changing it reprices every auto-priced product that has no product or category markup of its own.', { type: 'number', attrs: 'step="0.5" min="0" max="300"' })}
          <div id="margin-check" class="panel" style="padding:0.75rem 0.9rem;box-shadow:none" aria-live="polite"></div>
          ${field('vatRatePct', 'VAT rate %', 'Supplier prices include VAT that we pay as a cost. South Africa: 15%.', { type: 'number', attrs: 'step="0.5" min="0" max="30"' })}
          <label class="field checkbox"><input type="checkbox" name="vatRegistered" ${s.vatRegistered ? 'checked' : ''}><span>Business is VAT-registered</span></label>
          <p class="mini-help" style="margin-top:-0.4rem">Procom is <strong>not</strong> VAT-registered today, so invoices show no VAT. Only tick this once registered with SARS.</p>
          ${field('vatNumber', 'VAT number', 'Only needed when VAT-registered (10 digits, starts with 4).', { attrs: 'inputmode="numeric"' })}`)}

        <div class="stack gap-3">
          ${section('Products', 'Defaults for products imported from supplier lists.', `
            ${field('defaultWeightG', 'Default product weight (g)', 'Supplier lists have no weights, so products without one count as this. Only matters for store-wide courier brackets (not SMD’s flat fee).', { type: 'number', attrs: 'min="1" max="100000" step="1"' })}`)}

          ${section('Email & notifications', 'Emails go out through the shop’s Gmail account (set on the server).', `
            ${field('ownerNotifyEmail', 'Send new-order & enquiry notifications to', 'Where you get told about paid orders and contact-form messages.', { type: 'email' })}`)}
        </div>
      </div>

      <div id="set-warnings" class="panel hidden" style="margin-top:1rem;border-left:4px solid var(--warn)"></div>
      <div style="display:flex;gap:0.75rem;align-items:center;margin:1rem 0;flex-wrap:wrap">
        <button class="btn btn-primary" type="submit">Save settings</button>
        <span class="muted" id="set-dirty"></span>
      </div>

      <section class="panel">
        <div class="section-head"><h3>Settings on other pages</h3></div>
        <ul style="margin:0.4rem 0 0;padding-left:1.1rem">
          ${link('#/suppliers', 'Suppliers → Delivery', 'courier fee, free-delivery threshold, collection address and hours per supplier (e.g. SMD R150, free from R5,000).')}
          ${link('#/shipping', 'Shipping options', 'store-wide courier brackets by weight, PUDO and local delivery.')}
          ${link('#/financial-overview', 'Financial overview → fee estimates', 'Payfast card/EFT fee percentages used for profit figures and the margin check above.')}
          ${link('#/newsletters', 'Newsletters → sending limits', 'daily send limit and batch size for Gmail.')}
          ${link('#/backups', 'Backups → off-site', 'daily database backups and off-site copies.')}
          ${link('#/admins', 'Admin users', 'who can sign in to this admin.')}
          ${link('#/promos', 'Promo codes', 'and Specials: discounts, capped so nothing sells below cost incl VAT.')}
        </ul>
      </section>
    </form>`);

    const form = $('#setform', root);
    const read = () => {
      const fd = Object.fromEntries(new FormData(form));
      delete fd.vatRegistered;
      return { ...fd, vatRegistered: form.vatRegistered.checked };
    };
    const initial = JSON.stringify(read());

    function renderMargin() {
      const v = read();
      const fee = payfastFeePct(fin, v.vatRatePct);
      const c = marginCheck(v.defaultMarkupPct, fee.pct);
      const colour = { ok: 'var(--ok)', warn: 'var(--warn)', bad: 'var(--danger)' }[c.level];
      const box = $('#margin-check', root);
      box.style.borderLeft = `4px solid ${colour}`;
      const pct = (n) => `${n.toFixed(1)}%`;
      const verdict = c.level === 'bad'
        ? `<strong style="color:${colour}">Loses money:</strong> at this markup Payfast fees are bigger than the margin, so every card sale loses money.`
        : c.level === 'warn'
          ? `<strong style="color:${colour}">Thin margin:</strong> any special or promo code bigger than about <strong>${pct(Math.max(0, c.headroomPct))}</strong> loses money once Payfast fees are counted (the discount cap only protects cost incl VAT, not fees).`
          : `<strong style="color:${colour}">OK:</strong> discounts up to about ${pct(c.headroomPct)} still cover Payfast fees.`;
      kit.setHtml(box, `<p style="margin:0 0 0.3rem">${verdict}</p>
        <p class="mini-help" style="margin:0">Margin above cost incl VAT = markup ÷ (1 + markup) = <strong>${pct(c.marginPct)}</strong> of the selling price. Payfast fees ≈ <strong>${pct(fee.pct)}</strong> incl VAT on a R1,000 order${fee.fromFinance ? ` (dearest method switched on: ${kit.h(fin.payfastFees.pricing?.name || 'card')}, from Financial overview)` : ' (typical; set the real rates in Financial overview)'}. Category markups (e.g. Phones, Laptops at 10%) are not covered by this check.</p>`);
    }

    function showErrors({ errors, warnings }) {
      $$('[data-field]', root).forEach((l) => {
        const key = l.dataset.field;
        const msg = errors[key];
        const err = $(`#err-${key}`, root);
        err.textContent = msg || '';
        err.classList.toggle('hidden', !msg);
        l.querySelector('input')?.setAttribute('aria-invalid', msg ? 'true' : 'false');
      });
      const n = Object.keys(errors).length;
      const sum = $('#set-summary', root);
      sum.classList.toggle('hidden', !n);
      if (n) kit.setHtml(sum, `<strong>Fix ${n} field${n === 1 ? '' : 's'} before saving:</strong> ${Object.keys(errors).map((k) => `<a href="#" data-jump="${h(k)}">${h($(`[data-field="${k}"] > span`, root)?.textContent || k)}</a>`).join(', ')}`);
      const warn = $('#set-warnings', root);
      warn.classList.toggle('hidden', !warnings.length);
      if (warnings.length) kit.setHtml(warn, warnings.map((w) => `<p style="margin:0.2rem 0">${h(w)}</p>`).join(''));
    }

    let touched = false;
    form.addEventListener('input', (e) => {
      if (['defaultMarkupPct', 'vatRatePct'].includes(e.target.name)) renderMargin();
      $('#set-dirty', root).textContent = JSON.stringify(read()) !== initial ? 'Unsaved changes' : '';
      if (touched) showErrors(validateSettings(read()));
    });
    form.addEventListener('change', () => { if (touched) showErrors(validateSettings(read())); });
    root.addEventListener('click', (e) => {
      const j = e.target.closest('[data-jump]');
      if (!j) return;
      e.preventDefault();
      $(`[name="${j.dataset.jump}"]`, root)?.focus();
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      touched = true;
      const body = read();
      const check = validateSettings(body);
      showErrors(check);
      if (Object.keys(check.errors).length) {
        $(`[name="${Object.keys(check.errors)[0]}"]`, root)?.focus();
        return;
      }
      const repricing = Number(body.defaultMarkupPct) !== Number(s.defaultMarkupPct) || Number(body.vatRatePct) !== Number(s.vatRatePct);
      if (repricing && !confirm('Changing the default markup or VAT rate reprices every auto-priced product without its own or a category markup. Prices on the live shop change immediately. Continue?')) return;
      try {
        const r = await api('/settings', { method: 'PUT', body });
        await siteSettings(true); // refresh the admin-wide cache (dashboard etc.)
        toast(`Settings saved${r.repriced ? ` · ${r.repriced} products repriced` : ''}`);
        routes.settings().catch(fail);
      } catch (err) { fail(err); }
    });

    renderMargin();
    showErrors({ errors: {}, warnings: validateSettings(read()).warnings });
  };
}
