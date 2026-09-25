import crypto from 'crypto';
import https from 'https';

// Ported from the Lapanza backend (server/payfast.js) -- same hard-won
// details: PHP-style urlencoding, fixed field order, skipEmpty only on the
// outbound redirect, separate sandbox/live credential sets.

// Payfast's shared public sandbox account. Safe to commit -- sandbox only.
// Tested 2026-09-25: this shared account rejects EVERY signature (including
// with the passphrase its docs publish) but accepts unsigned requests, so
// with it we send the redirect unsigned purely to make local checkout
// clickable. Any real account (own sandbox or live) is always signed.
const SANDBOX_MERCHANT_ID = '10000100';
const SANDBOX_MERCHANT_KEY = '46f0cd694581a';

function getConfig() {
  const mode = process.env.PAYFAST_MODE === 'live' ? 'live' : 'sandbox';
  if (mode === 'live') {
    return {
      mode,
      merchantId: process.env.PAYFAST_MERCHANT_ID || '',
      merchantKey: process.env.PAYFAST_MERCHANT_KEY || '',
      passphrase: process.env.PAYFAST_PASSPHRASE || '',
    };
  }
  const ownSandbox = Boolean(process.env.PAYFAST_SANDBOX_MERCHANT_ID);
  return {
    mode,
    merchantId: ownSandbox ? process.env.PAYFAST_SANDBOX_MERCHANT_ID : SANDBOX_MERCHANT_ID,
    merchantKey: ownSandbox ? process.env.PAYFAST_SANDBOX_MERCHANT_KEY || '' : SANDBOX_MERCHANT_KEY,
    passphrase: ownSandbox ? process.env.PAYFAST_SANDBOX_PASSPHRASE || '' : '',
    sharedDemo: !ownSandbox,
  };
}

export function payfastMode() {
  return getConfig().mode;
}

const URLS = {
  sandbox: { process: 'https://sandbox.payfast.co.za/eng/process', host: 'sandbox.payfast.co.za' },
  live: { process: 'https://www.payfast.co.za/eng/process', host: 'www.payfast.co.za' },
};

function phpUrlEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/%20/g, '+')
    .replace(/[!'()*~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

export function buildSignature(orderedPairs, passphrase, { skipEmpty = true } = {}) {
  const parts = orderedPairs
    .filter(([, v]) => !skipEmpty || (v !== undefined && v !== null && v !== ''))
    .map(([k, v]) => `${k}=${phpUrlEncode(v ?? '')}`);
  if (passphrase) parts.push(`passphrase=${phpUrlEncode(passphrase)}`);
  return crypto.createHash('md5').update(parts.join('&')).digest('hex');
}

export function buildPayfastRedirect({ order, siteUrl, apiUrl, paymentMethod }) {
  const config = getConfig();
  if (!config.merchantId || !config.merchantKey) throw new Error('Payfast is not configured');
  const orderedPairs = [
    ['merchant_id', config.merchantId],
    ['merchant_key', config.merchantKey],
    ['return_url', `${siteUrl}/checkout-complete.html?order=${order.id}`],
    ['cancel_url', `${siteUrl}/checkout.html?cancelled=${order.id}`],
    ['notify_url', `${apiUrl}/api/payfast/itn`],
    ['name_first', order.firstName || 'Customer'],
    ['name_last', order.lastName || ''],
    ['email_address', order.email || ''],
    ['m_payment_id', order.id],
    ['amount', (order.totalCents / 100).toFixed(2)],
    ['item_name', `Procom Solutions order ${order.orderNumber}`],
    ['custom_str1', order.orderNumber],
    ['payment_method', paymentMethod === 'payfast_eft' ? 'ef' : 'cc'],
  ];
  const fields = orderedPairs.filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!config.sharedDemo) fields.push(['signature', buildSignature(orderedPairs, config.passphrase)]);
  return { actionUrl: URLS[config.mode].process, fields };
}

function postForm(hostname, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve(out.trim()));
      },
    );
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('Payfast validate request timed out')));
    req.write(body);
    req.end();
  });
}

// Signature + server-to-server validate + amount are hard gates.
export async function verifyItn(rawBody, parsedBody, expectedCents, sourceIp) {
  const config = getConfig();
  const { signature, ...fields } = parsedBody;
  const signatureValid = buildSignature(Object.entries(fields), config.passphrase, { skipEmpty: false }) === signature;
  let serverConfirmed = false;
  try {
    serverConfirmed = (await postForm(URLS[config.mode].host, '/eng/query/validate', rawBody)) === 'VALID';
  } catch (err) {
    console.error('Payfast validate call failed:', err.message);
  }
  const amountValid = Math.round(Number(fields.amount_gross) * 100) === Number(expectedCents);
  console.log(`Payfast ITN from ${sourceIp || '?'} for ${fields.m_payment_id}: signature=${signatureValid} server=${serverConfirmed} amount=${amountValid}`);
  return {
    valid: signatureValid && serverConfirmed && amountValid,
    signatureValid,
    serverConfirmed,
    amountValid,
    paymentStatus: fields.payment_status,
    orderId: fields.m_payment_id,
    pfPaymentId: fields.pf_payment_id,
  };
}
