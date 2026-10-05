import { buildSyncReportDocx, reportFileName } from './sync-report.js';
import nodemailer from 'nodemailer';
import { getDb } from './db.js';
import { getSettings } from './settings.js';
import { escapeHtml, formatRand } from './util.js';

let transport = null;

function getTransport() {
  if (transport) return transport;
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return null;
  transport = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  return transport;
}

// Tests/scripts: capture mail instead of sending (e.g. nodemailer's jsonTransport).
export function useTransport(t) {
  transport = t;
}

// Never throws -- a mail outage must not fail a payment webhook or checkout.
// `headers`: optional extra headers (e.g. List-Unsubscribe for newsletters).
export async function sendMail({ to, subject, html, replyTo, headers, attachments }) {
  const t = getTransport();
  if (!t) {
    console.log(`[mail disabled] would send "${subject}" to ${to}`);
    return false;
  }
  try {
    const s = getSettings();
    await t.sendMail({ from: `"${s.siteName}" <${process.env.GMAIL_USER}>`, to, subject, html, replyTo, ...(headers ? { headers } : {}), ...(attachments ? { attachments } : {}) });
    return true;
  } catch (err) {
    console.error('Mail send failed:', err.message);
    return false;
  }
}

export function layout(title, body) {
  const s = getSettings();
  return `<!doctype html><html><body style="margin:0;background:#f7f3eb;font-family:Arial,sans-serif;color:#1a1612">
  <div style="max-width:620px;margin:0 auto;padding:28px 20px">
    <p style="font-size:20px;font-weight:700;margin:0 0 4px">Procom <span style="color:#c24b28;font-style:italic">Solutions</span></p>
    <p style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#c24b28;margin:0 0 20px">${escapeHtml(title)}</p>
    <div style="background:#fffdf8;border:1px solid #e5ddd0;border-radius:6px;padding:22px">${body}</div>
    <p style="font-size:12px;color:#6a5f54;margin-top:18px">${escapeHtml(s.legalEntity)} · ${escapeHtml(s.contactEmail)} · ${escapeHtml(s.contactPhone)}</p>
  </div></body></html>`;
}

// Where and how to collect a shipment, for order emails. Kept out of public
// pages on purpose (the address identifies the supplier).
export function collectionBlock(c) {
  if (!c) return '';
  const map = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.address)}`;
  return `<p style="margin:0 0 6px"><strong>Collection address:</strong><br>${escapeHtml(c.address)}</p>
     ${c.hours ? `<p style="margin:0 0 6px"><strong>Hours:</strong> ${escapeHtml(c.hours)}</p>` : ''}
     ${c.requirements ? `<p style="margin:0 0 6px"><strong>What to bring:</strong> ${escapeHtml(c.requirements)}</p>` : ''}
     <p style="margin:0"><a href="${escapeHtml(map)}" style="color:#c24b28">Open in Google Maps</a></p>`;
}

const collectShipments = (order) => (order.shipments || []).filter((sh) => sh.method === 'collect');
const ownCourierShipments = (order) => (order.shipments || []).filter((sh) => sh.method === 'own_courier');

// Customer sends their own courier: where it collects, and what we need from them.
function ownCourierBlock(order, sh) {
  const s = getSettings();
  return `<div style="background:#efe7d8;padding:12px;border-radius:4px;margin-bottom:12px">
    <p style="margin:0 0 8px"><strong>You're sending your own courier${order.shipments.length > 1 ? ` for the items from our ${escapeHtml(sh.label)}` : ''}.</strong>
    Please email your courier's <strong>waybill</strong> and the <strong>collection date</strong> to <a href="mailto:${escapeHtml(s.contactEmail)}" style="color:#c24b28">${escapeHtml(s.contactEmail)}</a>${s.whatsappNumber ? ` or WhatsApp ${escapeHtml(s.contactPhone)}` : ''}, quoting order ${escapeHtml(order.orderNumber)}. Book the collection for ${escapeHtml(sh.collection?.leadText || 'at least 2–3 business days after payment')}.</p>
    ${collectionBlock(sh.collection)}</div>`;
}

// withSupplier: owner copy -- shows which supplier each line is ordered from.
export function itemsTable(order, { withSupplier = false } = {}) {
  const supplierOf = (i) => (i.fulfilment === 'stock' ? 'Own stock' : i.supplierName || 'Supplier');
  const rows = order.items
    .map((i) => `<tr><td style="padding:6px 0">${escapeHtml(i.name)} × ${i.quantity}${withSupplier ? `<br><span style="font-size:12px;color:#6a5f54">${escapeHtml(supplierOf(i))}${i.supplierCode ? ` · ${escapeHtml(i.supplierCode)}` : ''}</span>` : ''}</td><td style="padding:6px 0;text-align:right">${formatRand(i.lineTotalCents)}</td></tr>`)
    .join('');
  return `<table style="width:100%;border-collapse:collapse;font-size:14px">${rows}
    ${order.discountCents ? `<tr><td style="padding:6px 0">Discount${order.promoCode ? ` (${escapeHtml(order.promoCode)})` : ''}</td><td style="padding:6px 0;text-align:right">−${formatRand(order.discountCents)}</td></tr>` : ''}
    <tr><td style="padding:6px 0;border-top:1px solid #e5ddd0">Delivery: ${escapeHtml(order.shippingName)}</td><td style="padding:6px 0;border-top:1px solid #e5ddd0;text-align:right">${formatRand(order.shippingCents - (order.insuranceCents || 0))}</td></tr>
    ${(order.shipments || []).filter((sh) => sh.insuranceCents).map((sh) => `<tr><td style="padding:6px 0">${escapeHtml(sh.insuranceName || 'Courier insurance')}</td><td style="padding:6px 0;text-align:right">${formatRand(sh.insuranceCents)}</td></tr>`).join('')}
    <tr><td style="padding:6px 0;font-weight:700">Total</td><td style="padding:6px 0;text-align:right;font-weight:700">${formatRand(order.totalCents)}</td></tr></table>`;
}

export function sendOrderConfirmation(order) {
  const html = layout(
    `Order ${order.orderNumber} confirmed`,
    `<p>Hi ${escapeHtml(order.firstName)},</p>
     <p>Thank you — your payment was received and your order <strong>${escapeHtml(order.orderNumber)}</strong> is being processed.
     ${order.shipments.some((sh) => sh.method !== 'collect' && sh.method !== 'own_courier') ? "Items for delivery ship directly from our warehouse; we'll email you the tracking number as soon as they're dispatched." : ''}</p>
     ${collectShipments(order).map((sh) => `<div style="background:#efe7d8;padding:12px;border-radius:4px;margin-bottom:12px"><p style="margin:0 0 8px"><strong>You're collecting${order.shipments.length > 1 ? ` the items from our ${escapeHtml(sh.label)}` : ' this order'}.</strong> Please wait for our <strong>collection notice</strong> email before you go — ${escapeHtml(sh.collection?.leadText || 'typically 2–3 business days after payment')}.</p>${collectionBlock(sh.collection)}</div>`).join('')}
     ${ownCourierShipments(order).map((sh) => ownCourierBlock(order, sh)).join('')}
     ${order.deliveryQuote ? `<p style="background:#efe7d8;padding:12px;border-radius:4px"><strong>Delivery quote to follow:</strong> your order includes large items, so delivery wasn't charged at checkout. We'll contact you within 1 business day with the courier cost to your address, before anything ships.</p>` : ''}
     ${itemsTable(order)}`,
  );
  return sendMail({ to: order.email, subject: `Procom Solutions — order ${order.orderNumber} confirmed`, html });
}

export function sendOwnerNewOrder(order) {
  const s = getSettings();
  const dropship = order.items.filter((i) => i.fulfilment === 'dropship');
  const suppliers = [...new Set(dropship.map((i) => i.supplierName || 'Supplier'))];
  const html = layout(
    `New paid order ${order.orderNumber}`,
    `<p><strong>${escapeHtml(order.firstName)} ${escapeHtml(order.lastName)}</strong> · ${escapeHtml(order.email)} · ${escapeHtml(order.phone)}</p>
     ${collectShipments(order).map((sh) => `<p style="background:#efe7d8;padding:12px;border-radius:4px"><strong>Customer will collect from the ${escapeHtml(sh.label)}.</strong> Ask the warehouse to pack and hold it under ${escapeHtml(order.orderNumber)}, then click “Ready for collection” on the order in admin to email the collection notice.</p>`).join('')}
     ${ownCourierShipments(order).map((sh) => `<p style="background:#efe7d8;padding:12px;border-radius:4px"><strong>Customer's own courier collects from the ${escapeHtml(sh.label)}.</strong> Wait for their waybill and collection date, then pass them to the supplier with the order.</p>`).join('')}
     ${order.deliveryQuote ? `<p style="background:#c24b28;color:#fff;padding:12px;border-radius:4px"><strong>Delivery quote needed.</strong> This order contains large items — get a courier price to ${escapeHtml([order.address.suburb, order.address.city, order.address.postalCode].filter(Boolean).join(', '))} and send the customer the quote.</p>` : ''}
     ${itemsTable(order, { withSupplier: true })}
     ${dropship.length ? `<p style="margin-top:16px"><strong>${dropship.length} line(s) to order from ${escapeHtml(suppliers.join(' and '))}.</strong> Open the order in admin for the supplier order sheet${suppliers.length > 1 ? 's (one per supplier)' : ''}.</p>` : ''}`,
  );
  return sendMail({ to: s.ownerNotifyEmail, subject: `New order ${order.orderNumber} — ${formatRand(order.totalCents)}${suppliers.length ? ` — ${suppliers.join(' + ')}` : ''}${order.deliveryQuote ? ' — DELIVERY QUOTE NEEDED' : ''}${order.collection ? ' — COLLECTION' : ''}${ownCourierShipments(order).length ? ' — OWN COURIER' : ''}`, html, replyTo: order.email });
}

export function sendShippedNotice(order) {
  const html = layout(
    `Order ${order.orderNumber} is on its way`,
    `<p>Hi ${escapeHtml(order.firstName)},</p>
     <p>Your order has been dispatched via <strong>${escapeHtml(order.shippingName)}</strong>.</p>
     ${order.trackingNumber ? `<p>Tracking number: <strong>${escapeHtml(order.trackingNumber)}</strong></p>` : ''}
     ${itemsTable(order)}`,
  );
  return sendMail({ to: order.email, subject: `Procom Solutions — order ${order.orderNumber} shipped`, html });
}

// The collection notice: the warehouse releases the goods to whoever shows it
// (with ID), so it carries the order number and the exact items to hand over.
export function sendCollectionReady(order, shipment) {
  const items = order.items.filter((i) => !shipment?.productIds || shipment.productIds.includes(i.productId));
  const html = layout(
    `Collection notice — order ${order.orderNumber}`,
    `<p>Hi ${escapeHtml(order.firstName)},</p>
     <p>Your order is packed and <strong>ready for collection</strong>. Show this email (printed or on your phone) at the counter.</p>
     <div style="border:2px solid #1a1612;border-radius:4px;padding:14px;margin:12px 0">
       <p style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#c24b28;margin:0 0 6px">Collection notice</p>
       <p style="font-size:22px;font-weight:700;margin:0 0 4px">Order ${escapeHtml(order.orderNumber)}</p>
       <p style="margin:0 0 10px">Ordered by ${escapeHtml(order.firstName)} ${escapeHtml(order.lastName)} · ${escapeHtml(order.phone)}</p>
       <table style="width:100%;border-collapse:collapse;font-size:14px">${items.map((i) => `<tr><td style="padding:4px 0">${i.quantity} × ${escapeHtml(i.name)}</td></tr>`).join('')}</table>
     </div>
     <div style="background:#efe7d8;padding:12px;border-radius:4px;margin-bottom:12px">${collectionBlock(shipment?.collection)}</div>`,
  );
  return sendMail({ to: order.email, subject: `Procom Solutions — order ${order.orderNumber} ready for collection (collection notice)`, html });
}

// Supplier sync reports go to Site settings -> "Supplier update emails"
// (owner 2026-10-05: lapanzaonline@gmail.com), with a Word overview attached.
const reportRecipients = (s) => String(s.supplierReportEmail || s.ownerNotifyEmail || '').split(/[,;\s]+/).filter(Boolean).join(', ');

// Shop-price changes this run (sync-report.js diffPrices): rows for the email + Word.
function changeRows(changes) {
  if (!changes) return [];
  return [
    ['Went on special', changes.newSpecials.length],
    ['Shop price reduced', changes.priceDown.length],
    ['Shop price increased', changes.priceUp],
    ['Specials ended', changes.specialsEnded],
    ['Newly listed in the shop', changes.newlyListed],
  ];
}

export const REPORT_MODES = ['every', 'daily', 'off'];
export const reportMode = (s = getSettings()) => (REPORT_MODES.includes(s.supplierReportMode) ? s.supplierReportMode : 'every');

// Every sync is recorded; the email goes out now ('every'), later in the
// once-a-day email ('daily', supplier-digest.js) or not at all ('off').
// A connection check started from admin is always emailed at once.
async function deliverSyncReport(label, report, { subject, html, summaryRows }) {
  const s = getSettings();
  const mode = report.check ? 'every' : reportMode(s);
  if (!report.check) {
    try {
      getDb().prepare('INSERT INTO sync_report_runs (supplier, started_at, ok, error, summary_json, changes_json, sent) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(label, report.startedAt, report.ok ? 1 : 0, report.error || '', JSON.stringify(summaryRows), report.changes ? JSON.stringify(report.changes) : null, mode === 'every' ? 1 : 0);
    } catch (err) {
      console.error('Could not record the sync report:', err.message);
    }
  }
  if (mode !== 'every') return false;
  const attachments = report.check ? undefined : await reportAttachment(label, report, summaryRows);
  return sendMail({ to: reportRecipients(s), subject, html, attachments });
}

export { reportRecipients, changesHtml };

async function reportAttachment(supplierLabel, report, summaryRows) {
  try {
    const content = await buildSyncReportDocx({ supplierLabel, startedAt: report.startedAt, ok: report.ok, error: report.error, summaryRows, changes: report.changes || null });
    return [{ filename: reportFileName(supplierLabel, report.startedAt), content, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }];
  } catch (err) {
    console.error('Sync report document failed:', err.message);
    return undefined; // the email still goes out
  }
}

function changesHtml(changes, row, table, list) {
  if (!changes) return '';
  const r = (c) => formatRand(c);
  let html = `<h3 style="font-size:15px;margin:12px 0 0">Shop prices this run</h3>${table(changeRows(changes).map(([k, v]) => row(k, v)))}`;
  if (changes.newSpecials.length) html += `<p style="margin:0">Went on special (biggest savings first):</p>${list(changes.newSpecials.map((x) => `${x.name} (${x.sku}): ${r(x.normalCents)} → ${r(x.specialCents)}`), 15)}`;
  if (changes.priceDown.length) html += `<p style="margin:0">Price reduced (biggest first):</p>${list(changes.priceDown.map((x) => `${x.name} (${x.sku}): ${r(x.fromCents)} → ${r(x.toCents)}`), 15)}`;
  if (changes.newSpecials.length || changes.priceDown.length) html += '<p style="font-size:13px;margin:0 0 12px">The full lists are in the attached Word document.</p>';
  return html;
}

// Status email after every Esquire API sync (esquire.js), success or failure.
export async function sendEsquireReport(report) {
  const s = getSettings();
  const im = report.import;
  const al = report.autoList;
  const row = (label, value) => `<tr><td style="padding:4px 0">${escapeHtml(label)}</td><td style="padding:4px 0;text-align:right;font-weight:700">${escapeHtml(String(value))}</td></tr>`;
  const table = (rows) => `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:8px 0 16px">${rows.join('')}</table>`;
  const list = (items, max = 30) =>
    `<ul style="font-size:13px;margin:4px 0 16px;padding-left:18px">${items.slice(0, max).map((i) => `<li>${escapeHtml(i)}</li>`).join('')}${items.length > max ? `<li>… and ${items.length - max} more</li>` : ''}</ul>`;
  const toList = al ? al.summary.reduce((n, g) => n + g.newListings, 0) : 0;
  const when = new Date(report.startedAt).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'medium', timeStyle: 'short' });

  let body = `<p>${escapeHtml(when)} · ${report.trigger === 'scheduled' ? 'scheduled run' : 'run started from admin'} · ${report.seconds ?? 0}s</p>`;
  if (!report.ok) {
    body += `<p style="background:#c24b28;color:#fff;padding:12px;border-radius:4px"><strong>The sync did not complete.</strong><br>${escapeHtml(report.error)}</p>
      <p>Nothing was changed in the shop by this run. The next scheduled run will try again.</p>`;
  } else {
    body += `<h3 style="font-size:15px;margin:12px 0 0">Feed</h3>${table([
      row('Products in Esquire feed', report.feedRows),
      row('Left out (groups we don’t sell)', report.leftOut.reduce((n, g) => n + g.n, 0)),
      row('Imported', report.sellableRows),
      row('New to the feed', im.rowsNew),
      row('Cost changes', im.priceChanges),
      row('Shop prices updated', im.productsRepriced),
      row('Listed products now out of stock', im.productsMarkedOut),
      row('Listed products back in stock', im.productsBackInStock),
      row('Hidden from the shop (left the feed)', im.productsHidden || 0),
      row('Shown again (back in the feed)', im.productsUnhidden || 0),
      row('Photos queued for download', im.imagesQueued),
    ])}`;
    body += changesHtml(report.changes, row, table, list);
    if (report.autoListOn) {
      body += `<h3 style="font-size:15px;margin:12px 0 0">Auto-list</h3>${table([
        row('New products listed', al.created),
        row('Marked delivery quoted (heavy)', al.quoted),
        row('Categories created', al.categoriesCreated.length),
        row('Errors', al.errors.length),
      ])}`;
      if (al.categoriesCreated.length) body += `<p style="margin:0">New categories:</p>${list(al.categoriesCreated)}`;
      if (al.errors.length) body += `<p style="margin:0">Errors:</p>${list(al.errors, 10)}`;
    } else {
      body += `<p style="background:#efe7d8;padding:12px;border-radius:4px"><strong>Auto-list is off.</strong> ${toList} product(s) would be listed by the approved rules${al.newCategories.length ? `, creating ${al.newCategories.length} categories` : ''}. Switch it on in Admin → Warehouse feed → Esquire once the category table is approved.</p>`;
    }
    if (al.unmatched.length) body += `<p style="margin:0"><strong>${al.unmatched.length} product(s) not recognised</strong> by the category rules (not listed):</p>${list(al.unmatched.map((u) => `${u.code} — ${u.name}`))}`;
    if (al.skipped.length) body += `<p style="margin:0">Imported but not listed (your call — list by hand, or ask for a rule):</p>${list(al.skipped.map((g) => `${g.items.length} · ${g.reason}`))}`;
    if (report.leftOut.length) body += `<p style="margin:0">Left out of the import:</p>${list(report.leftOut.map((g) => `${g.n} · ${g.reason}`))}`;
  }

  const ch = report.changes;
  const subject = report.ok
    ? `Esquire sync — ${im.rowsNew} new, ${im.priceChanges} cost changes, ${ch ? `${ch.newSpecials.length} on special, ${ch.priceDown.length} price down, ` : ''}${im.productsMarkedOut} out of stock${report.autoListOn ? `, ${al.created} listed` : ''}`
    : 'Esquire sync FAILED';
  const summaryRows = report.ok
    ? [
      ['Products in Esquire feed', report.feedRows],
      ['Imported', report.sellableRows],
      ['New to the feed', im.rowsNew],
      ['Cost changes', im.priceChanges],
      ['Shop prices updated', im.productsRepriced],
      ...changeRows(ch),
      ['Listed products now out of stock', im.productsMarkedOut],
      ['Listed products back in stock', im.productsBackInStock],
      ['Hidden from the shop (left the feed)', im.productsHidden || 0],
      ['Shown again (back in the feed)', im.productsUnhidden || 0],
      ...(report.autoListOn ? [['New products listed', al.created]] : []),
    ]
    : [];
  return deliverSyncReport('Esquire', report, { subject, html: layout('Esquire feed sync', body), summaryRows });
}

// After every SMD API run (smd-api.js). A connection check says so: nothing changed.
export async function sendSmdReport(report) {
  const s = getSettings();
  const st = report.stats || {};
  const row = (label, value) => `<tr><td style="padding:4px 0">${escapeHtml(label)}</td><td style="padding:4px 0;text-align:right;font-weight:700">${escapeHtml(String(value ?? '—'))}</td></tr>`;
  const table = (rows) => `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:8px 0 16px">${rows.join('')}</table>`;
  const list = (items, max = 1000) =>
    `<ul style="font-size:13px;margin:4px 0 16px;padding-left:18px">${items.slice(0, max).map((i) => `<li>${escapeHtml(i)}</li>`).join('')}${items.length > max ? `<li>… and ${items.length - max} more</li>` : ''}</ul>`;
  const when = new Date(report.startedAt).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'medium', timeStyle: 'short' });
  const verb = report.check ? 'would be' : 'were';
  let body = `<p>${escapeHtml(when)} · ${report.check ? '<strong>connection check — nothing in the shop was changed</strong>' : report.trigger === 'scheduled' ? 'scheduled run' : 'run started from admin'} · ${report.seconds ?? 0}s</p>`;
  if (!report.ok) {
    body += `<p style="background:#c24b28;color:#fff;padding:12px;border-radius:4px"><strong>The SMD sync did not complete.</strong><br>${escapeHtml(report.error)}</p><p>Nothing was changed in the shop by this run.</p>`;
  } else {
    body += `<h3 style="font-size:15px;margin:12px 0 0">What SMD sent</h3>${table([
      row('Products', report.api.products),
      row('Prices', report.api.prices),
      row('Stock levels', report.api.stock),
      row('Products with photos', report.api.photoSkus),
    ])}<h3 style="font-size:15px;margin:12px 0 0">Your SMD products (${st.listed})</h3>${table([
      row('Found in the API', `${st.matched} (${st.listed ? Math.round((st.matched / st.listed) * 100) : 0}%)`),
      row('Not in the API', st.notInApi),
      row(`Costs that ${verb} raised / lowered`, `${st.costUp} / ${st.costDown}`),
      row('On SMD special now (shown as Sale)', st.specials),
      row(`Specials that ${verb} ended`, st.specialsEnded),
      row(`Marked out of stock`, st.markedOut),
      row(`Back in stock`, st.backInStock),
      row(`Hidden from the shop (not in the API)`, st.hidden),
      row(`Shown again (back in the API)`, st.unhidden),
      row('Low stock (5 or fewer)', st.lowStock),
      row(`Descriptions that ${verb} filled`, st.descriptions),
      row(`Products that ${verb} get full-size photos`, st.photoSets),
      ...(report.check ? [] : [row('Shop prices updated', report.repriced)]),
    ])}`;
    body += changesHtml(report.changes, row, table, list);
    if (st.missingNotMarked) body += `<p style="background:#efe7d8;padding:12px;border-radius:4px"><strong>${st.notInApi} of your SMD products are not in the API</strong> — too many to be real sell-outs, so they were left as they are (probably an incomplete API response). Examples:</p>${list(st.missingSample || [])}`;
    else if (st.missingSample?.length) body += `<p style="margin:0">Not in the API (${verb} hidden from the shop):</p>${list(st.missingSample)}`;
    if (report.stats?.biggestChanges?.length) body += `<p style="margin:0">Biggest cost changes:</p>${list(report.stats.biggestChanges.map((c) => `${c.name} (${c.sku}): ${formatRand(c.from)} → ${formatRand(c.to)} excl VAT`))}`;
    if (st.newSkus) body += `<p style="margin:0"><strong>${st.newSkus} SMD products you don't sell yet</strong> ${report.check ? 'would appear' : 'are now'} in Admin → Warehouse feed (supplier SMD), by SMD category:</p>${list(Object.entries(st.newSkuCategories).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([c, n]) => `${n} · ${c}`))}`;
    const al = report.autoList;
    if (al) {
      const would = al.summary.reduce((n, g) => n + g.newListings, 0);
      body += report.autoListOn && !report.check
        ? `<h3 style="font-size:15px;margin:12px 0 0">Auto-list (new SMD products)</h3>${table([row('New products listed', al.created), row('Categories created', al.categoriesCreated.length), row('Errors', al.errors.length)])}${al.categoriesCreated.length ? list(al.categoriesCreated) : ''}`
        : `<p style="background:#efe7d8;padding:12px;border-radius:4px"><strong>Auto-list ${report.autoListOn ? '' : 'is off'}:</strong> ${would} new SMD product(s) would be listed${al.newCategories.length ? `, creating ${al.newCategories.length} categories` : ''}.${report.autoListOn ? '' : ' Switch it on in Admin → Warehouse feed → SMD live API once the category table is approved.'}</p>`;
      if (al.unmatched.length) body += `<p style="margin:0"><strong>${al.unmatched.length} new SMD product(s) not recognised</strong> by the category rules (not listed):</p>${list(al.unmatched.slice(0, 30).map((u) => `${u.code} — ${u.name}`))}`;
    }
    if (report.check) body += `<p style="background:#efe7d8;padding:12px;border-radius:4px">If this looks right, switch the SMD sync on in Admin → Warehouse feed → SMD live API. It then runs at 06:30, 12:30 and 18:30.</p>`;
  }
  const subject = !report.ok
    ? `SMD sync FAILED${report.check ? ' (connection check)' : ''}`
    : report.check
      ? `SMD connection check — ${st.matched} of ${st.listed} products found, nothing changed`
      : `SMD sync — ${st.costUp + st.costDown} cost changes, ${report.changes ? `${report.changes.newSpecials.length} on special, ${report.changes.priceDown.length} price down, ` : ''}${st.markedOut} out of stock, ${st.backInStock} back`;
  const summaryRows = report.ok
    ? [
      ['Products SMD sent', report.api.products],
      ['Your SMD products', st.listed],
      ['Found in the API', st.matched],
      ['Costs raised', st.costUp],
      ['Costs lowered', st.costDown],
      ['Shop prices updated', report.repriced ?? 0],
      ...changeRows(report.changes),
      ['On SMD special now', st.specials],
      ['Marked out of stock', st.markedOut],
      ['Back in stock', st.backInStock],
      ['Hidden from the shop (not in the API)', st.hidden],
      ['Shown again (back in the API)', st.unhidden],
      ['New SMD products not in the shop yet', st.newSkus],
      ...(report.autoList && report.autoListOn && !report.check ? [['New products listed', report.autoList.created]] : []),
    ]
    : [];
  return deliverSyncReport('SMD', report, { subject, html: layout('SMD live API', body), summaryRows });
}

export function sendContactNotice({ name, email, phone, message }) {
  const s = getSettings();
  return sendMail({
    to: s.ownerNotifyEmail,
    replyTo: email,
    subject: `Website enquiry from ${name}`,
    html: layout('Website enquiry', `<p><strong>${escapeHtml(name)}</strong> · ${escapeHtml(email)} · ${escapeHtml(phone)}</p><p style="white-space:pre-wrap">${escapeHtml(message)}</p>`),
  });
}
