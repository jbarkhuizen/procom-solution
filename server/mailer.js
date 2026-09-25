import nodemailer from 'nodemailer';
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

// Never throws -- a mail outage must not fail a payment webhook or checkout.
export async function sendMail({ to, subject, html, replyTo }) {
  const t = getTransport();
  if (!t) {
    console.log(`[mail disabled] would send "${subject}" to ${to}`);
    return false;
  }
  try {
    const s = getSettings();
    await t.sendMail({ from: `"${s.siteName}" <${process.env.GMAIL_USER}>`, to, subject, html, replyTo });
    return true;
  } catch (err) {
    console.error('Mail send failed:', err.message);
    return false;
  }
}

function layout(title, body) {
  const s = getSettings();
  return `<!doctype html><html><body style="margin:0;background:#f7f3eb;font-family:Arial,sans-serif;color:#1a1612">
  <div style="max-width:620px;margin:0 auto;padding:28px 20px">
    <p style="font-size:20px;font-weight:700;margin:0 0 4px">Procom <span style="color:#c24b28;font-style:italic">Solutions</span></p>
    <p style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#c24b28;margin:0 0 20px">${escapeHtml(title)}</p>
    <div style="background:#fffdf8;border:1px solid #e5ddd0;border-radius:6px;padding:22px">${body}</div>
    <p style="font-size:12px;color:#6a5f54;margin-top:18px">${escapeHtml(s.legalEntity)} · ${escapeHtml(s.contactEmail)} · ${escapeHtml(s.contactPhone)}</p>
  </div></body></html>`;
}

function itemsTable(order) {
  const rows = order.items
    .map((i) => `<tr><td style="padding:6px 0">${escapeHtml(i.name)} × ${i.quantity}</td><td style="padding:6px 0;text-align:right">${formatRand(i.lineTotalCents)}</td></tr>`)
    .join('');
  return `<table style="width:100%;border-collapse:collapse;font-size:14px">${rows}
    <tr><td style="padding:6px 0;border-top:1px solid #e5ddd0">Delivery: ${escapeHtml(order.shippingName)}</td><td style="padding:6px 0;border-top:1px solid #e5ddd0;text-align:right">${formatRand(order.shippingCents)}</td></tr>
    <tr><td style="padding:6px 0;font-weight:700">Total</td><td style="padding:6px 0;text-align:right;font-weight:700">${formatRand(order.totalCents)}</td></tr></table>`;
}

export function sendOrderConfirmation(order) {
  const html = layout(
    `Order ${order.orderNumber} confirmed`,
    `<p>Hi ${escapeHtml(order.firstName)},</p>
     <p>Thank you — your payment was received and your order <strong>${escapeHtml(order.orderNumber)}</strong> is being processed.
     Most items ship directly from our warehouse; we'll email you the tracking number as soon as it's dispatched.</p>
     ${itemsTable(order)}`,
  );
  return sendMail({ to: order.email, subject: `Procom Solutions — order ${order.orderNumber} confirmed`, html });
}

export function sendOwnerNewOrder(order) {
  const s = getSettings();
  const dropship = order.items.filter((i) => i.fulfilment === 'dropship');
  const html = layout(
    `New paid order ${order.orderNumber}`,
    `<p><strong>${escapeHtml(order.firstName)} ${escapeHtml(order.lastName)}</strong> · ${escapeHtml(order.email)} · ${escapeHtml(order.phone)}</p>
     ${itemsTable(order)}
     ${dropship.length ? `<p style="margin-top:16px"><strong>${dropship.length} line(s) to order from the warehouse.</strong> Open the order in admin for the supplier order sheet.</p>` : ''}`,
  );
  return sendMail({ to: s.ownerNotifyEmail, subject: `New order ${order.orderNumber} — ${formatRand(order.totalCents)}`, html, replyTo: order.email });
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

export function sendContactNotice({ name, email, phone, message }) {
  const s = getSettings();
  return sendMail({
    to: s.ownerNotifyEmail,
    replyTo: email,
    subject: `Website enquiry from ${name}`,
    html: layout('Website enquiry', `<p><strong>${escapeHtml(name)}</strong> · ${escapeHtml(email)} · ${escapeHtml(phone)}</p><p style="white-space:pre-wrap">${escapeHtml(message)}</p>`),
  });
}
