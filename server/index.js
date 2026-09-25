import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import rateLimit from 'express-rate-limit';

if (fs.existsSync('.env')) process.loadEnvFile('.env');

const { getDb } = await import('./db.js');
const { uploadsDir } = await import('./paths.js');
const auth = await import('./auth.js');
const catalog = await import('./catalog.js');
const feed = await import('./feed.js');
const shipping = await import('./shipping.js');
const orders = await import('./orders.js');
const settings = await import('./settings.js');
const mailer = await import('./mailer.js');
const { buildPayfastRedirect, verifyItn, payfastMode } = await import('./payfast.js');
const { storeProductImage, isAllowedImage, MAX_IMAGE_BYTES } = await import('./images.js');
const { startBackupSchedule, createBackup, listBackups } = await import('./backups.js');
const { escapeHtml } = await import('./util.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 8788;
const HOST = process.env.HOST || '127.0.0.1';
const SITE_URL = (process.env.SITE_URL || `http://localhost:5174`).replace(/\/$/, '');
const API_URL = (process.env.API_URL || SITE_URL).replace(/\/$/, '');

getDb();
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback'); // nginx on the same box sets X-Forwarded-*

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN',
  });
  next();
});

// Payfast ITN needs the exact raw body for signature verification -- register before the JSON parser.
app.post('/api/payfast/itn', express.urlencoded({ extended: false, verify: (req, _res, buf) => (req.rawBody = buf.toString('utf8')) }), async (req, res) => {
  res.status(200).end(); // Payfast wants a fast 200; work continues below.
  try {
    const orderId = req.body.m_payment_id;
    const order = orderId && orders.getOrder(orderId);
    if (!order) return console.error(`ITN for unknown order ${orderId}`);
    const result = await verifyItn(req.rawBody, req.body, order.totalCents, req.ip);
    if (!result.valid) return orders.logOrderEvent(order.id, `Rejected Payfast notification (signature=${result.signatureValid}, confirmed=${result.serverConfirmed}, amount=${result.amountValid})`);
    if (result.paymentStatus === 'COMPLETE') {
      const { changed, order: paid } = orders.markOrderPaid(order.id, { pfPaymentId: result.pfPaymentId });
      if (changed) {
        mailer.sendOrderConfirmation(paid);
        mailer.sendOwnerNewOrder(paid);
      }
    } else {
      orders.logOrderEvent(order.id, `Payfast status: ${result.paymentStatus}`, 'payfast');
    }
  } catch (err) {
    console.error('ITN handling failed:', err);
  }
});

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

const wrap = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (err) {
    if (!res.headersSent) {
      const status = err.status || 400;
      if (status >= 500) console.error(err);
      res.status(status).json({ error: err.message || 'Something went wrong' });
    }
  }
};
const notFound = (what = 'Not found') => Object.assign(new Error(what), { status: 404 });
const orNotFound = (v) => {
  if (v == null || v === false) throw notFound();
  return v;
};

// ------------------------------------------------------------------ public API

const publicLimiter = rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: 'draft-7', legacyHeaders: false });
app.use('/api/', publicLimiter);

app.get('/api/health', (_req, res) => res.json({ ok: true, payfast: payfastMode() }));
app.get('/api/site', wrap(() => settings.publicSettings()));
app.get('/api/categories', wrap(() => catalog.categoryTree({ activeOnly: true })));
app.get('/api/products', wrap((req) => {
  const q = req.query;
  return catalog.queryProducts({
    category: q.category,
    q: q.q,
    brand: q.brand,
    sort: q.sort,
    page: q.page,
    pageSize: q.pageSize || 24,
    featured: q.featured === '1',
    inStock: q.inStock === '1',
    minPrice: q.minPrice,
    maxPrice: q.maxPrice,
  });
}));
app.get('/api/products/:slug', wrap((req) => orNotFound(catalog.getPublicProductBySlug(req.params.slug))));
// Cart refresh: current price/availability for ids held in the browser's cart.
app.post('/api/cart/refresh', wrap((req) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 100).map(String) : [];
  return ids
    .map((id) => catalog.getProduct(id, { admin: false }))
    .filter(Boolean)
    .map((p) => ({ id: p.id, name: p.name, slug: p.slug, priceCents: p.priceCents, image: p.image, weightG: p.weightG, inStock: p.inStock, stockQty: p.stockQty, minOrderQty: p.minOrderQty, active: true }));
}));
app.get('/api/shipping-options', wrap(() => shipping.listShippingOptions({ activeOnly: true })));

const checkoutLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });
app.post('/api/checkout', checkoutLimiter, wrap((req) => {
  const order = orders.createOrder(req.body || {});
  const payfast = buildPayfastRedirect({ order, siteUrl: SITE_URL, apiUrl: API_URL, paymentMethod: order.paymentMethod });
  return { orderId: order.id, orderNumber: order.orderNumber, totalCents: order.totalCents, payfast };
}));
app.get('/api/orders/:id/status', wrap((req) => {
  const o = orNotFound(orders.getOrder(req.params.id));
  return { orderNumber: o.orderNumber, status: o.status, statusLabel: o.statusLabel, paymentStatus: o.paymentStatus, totalCents: o.totalCents, email: o.email.replace(/^(.).*(@.*)$/, '$1***$2') };
}));

const contactLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false });
app.post('/api/contact', contactLimiter, wrap((req) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 100);
  const email = String(b.email || '').trim().slice(0, 160);
  const message = String(b.message || '').trim().slice(0, 4000);
  if (b.website) return { ok: true }; // honeypot
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || message.length < 5) throw new Error('Please fill in your name, a valid email and a message');
  const phone = String(b.phone || '').trim().slice(0, 30);
  getDb().prepare('INSERT INTO contact_messages (id, name, email, phone, message, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(crypto.randomUUID(), name, email, phone, message, new Date().toISOString());
  mailer.sendContactNotice({ name, email, phone, message });
  return { ok: true };
}));

app.get('/sitemap.xml', (_req, res) => {
  const db = getDb();
  const urls = [
    '/', '/shop.html', '/contact.html',
    ...db.prepare('SELECT slug FROM categories WHERE active = 1').all().map((c) => `/shop.html?category=${c.slug}`),
    ...db.prepare('SELECT slug, updated_at FROM products WHERE active = 1').all().map((p) => `/product.html?p=${p.slug}`),
  ];
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <url><loc>${escapeHtml(SITE_URL + u)}</loc></url>`)
    .join('\n')}\n</urlset>`);
});

// ------------------------------------------------------------------ admin auth

const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many attempts — try again in 15 minutes' } });

function setSessionCookie(req, res, token) {
  res.cookie(auth.SESSION_COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: auth.SESSION_TTL_MS, path: '/' });
}

app.get('/api/admin/session', (req, res) => {
  const s = auth.getSession(req.cookies[auth.SESSION_COOKIE]);
  res.json({ needsSetup: !auth.hasAnyAdmin(), authenticated: Boolean(s), username: s?.username || null });
});
app.post('/api/admin/setup', loginLimiter, wrap((req, res) => {
  // Only possible while no admin exists -- same first-run flow as lapanza3d.
  if (auth.hasAnyAdmin()) throw Object.assign(new Error('Setup already completed'), { status: 403 });
  const admin = auth.createAdmin(req.body || {});
  setSessionCookie(req, res, auth.createSession(admin.id));
  return { ok: true, username: admin.username };
}));
app.post('/api/admin/login', loginLimiter, wrap((req, res) => {
  const a = auth.verifyLogin(req.body?.username, req.body?.password);
  if (!a) throw Object.assign(new Error('Incorrect username or password'), { status: 401 });
  setSessionCookie(req, res, auth.createSession(a.id));
  return { ok: true, username: a.username };
}));
app.post('/api/admin/logout', (req, res) => {
  auth.destroySession(req.cookies[auth.SESSION_COOKIE]);
  res.clearCookie(auth.SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

// Everything below requires a session. Mutations also require a same-origin
// request (defence in depth on top of the SameSite=Strict cookie).
function requireAdmin(req, res, next) {
  const s = auth.getSession(req.cookies[auth.SESSION_COOKIE]);
  if (!s) return res.status(401).json({ error: 'Please sign in' });
  if (req.method !== 'GET') {
    const origin = req.get('origin');
    if (origin && new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Cross-origin request blocked' });
  }
  req.admin = s;
  next();
}
const admin = express.Router();
app.use('/api/admin', requireAdmin, admin);

const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES, files: 10 } });
const sheetUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024, files: 1 } });

admin.get('/dashboard', wrap(() => orders.dashboardStats()));

admin.get('/categories', wrap(() => ({ list: catalog.listCategories(), tree: catalog.categoryTree({ activeOnly: false }) })));
admin.post('/categories', wrap((req) => catalog.saveCategory(req.body || {})));
admin.put('/categories/:id', wrap((req) => orNotFound(catalog.saveCategory(req.body || {}, req.params.id))));
admin.delete('/categories/:id', wrap((req) => ({ ok: orNotFound(catalog.deleteCategory(req.params.id)) })));

admin.get('/products', wrap((req) => catalog.queryProducts({ ...req.query, admin: true, pageSize: req.query.pageSize || 50, sort: req.query.sort || 'newest' })));
admin.get('/products/:id', wrap((req) => orNotFound(catalog.getProduct(req.params.id))));
admin.post('/products', wrap((req) => catalog.saveProduct(req.body || {})));
admin.put('/products/:id', wrap((req) => orNotFound(catalog.saveProduct(req.body || {}, req.params.id))));
admin.delete('/products/:id', wrap((req) => ({ ok: orNotFound(catalog.deleteProduct(req.params.id)) })));
admin.post('/products/bulk', wrap((req) => catalog.bulkUpdateProducts(req.body || {})));
admin.post('/products/reprice', wrap(() => ({ changed: catalog.repriceProducts() })));
admin.post('/uploads/images', imageUpload.array('images', 10), wrap(async (req) => {
  const files = req.files || [];
  if (!files.length) throw new Error('No images received');
  const paths = [];
  for (const f of files) {
    if (!isAllowedImage(f.mimetype)) throw new Error(`${f.originalname}: only JPG, PNG, WebP, GIF or AVIF images`);
    paths.push(await storeProductImage(f.buffer));
  }
  return { paths };
}));

admin.get('/suppliers', wrap(() => catalog.listSuppliers()));
admin.post('/suppliers', wrap((req) => catalog.saveSupplier(req.body || {})));
admin.put('/suppliers/:id', wrap((req) => orNotFound(catalog.saveSupplier(req.body || {}, req.params.id))));
admin.delete('/suppliers/:id', wrap((req) => ({ ok: orNotFound(catalog.deleteSupplier(req.params.id)) })));

admin.post('/feed/import', sheetUpload.single('file'), wrap(async (req) => {
  if (!req.file) throw new Error('Choose a .xlsx pricelist to upload');
  if (!/\.xlsx$/i.test(req.file.originalname)) throw new Error('Only .xlsx files are supported');
  return feed.importPricelist({ supplierId: req.body.supplierId, fileName: req.file.originalname, buffer: req.file.buffer });
}));
admin.get('/feed', wrap((req) => feed.listFeed({ ...req.query, singleUnit: req.query.singleUnit === '1', withImage: req.query.withImage === '1', changed: req.query.changed === '1' })));
admin.get('/feed/facets', wrap((req) => feed.feedFacets(req.query.supplierId)));
admin.post('/feed/list', wrap((req) => feed.listFeedItems(req.body || {})));

admin.get('/orders', wrap((req) => orders.listOrders({ ...req.query, includeUnpaid: req.query.includeUnpaid === '1' })));
admin.get('/orders/:id', wrap((req) => {
  const o = orNotFound(orders.getOrder(req.params.id));
  return { ...o, supplierSheets: orders.supplierOrderSheet(o) };
}));
admin.put('/orders/:id', wrap((req) => {
  const result = orNotFound(orders.updateOrder(req.params.id, req.body || {}, req.admin.username));
  if (result.statusChangedTo === 'shipped' && req.body.notifyCustomer !== false) {
    mailer.sendShippedNotice(result.order);
    orders.logOrderEvent(result.order.id, 'Shipping notification emailed to customer', req.admin.username);
  }
  const o = orders.getOrder(req.params.id);
  return { ...o, supplierSheets: orders.supplierOrderSheet(o) };
}));

admin.get('/shipping', wrap(() => shipping.listShippingOptions()));
admin.post('/shipping', wrap((req) => shipping.saveShippingOption(req.body || {})));
admin.put('/shipping/:id', wrap((req) => orNotFound(shipping.saveShippingOption(req.body || {}, req.params.id))));
admin.delete('/shipping/:id', wrap((req) => ({ ok: orNotFound(shipping.deleteShippingOption(req.params.id)) })));

admin.get('/settings', wrap(() => settings.getSettings()));
admin.put('/settings', wrap((req) => {
  const before = settings.getSettings();
  const after = settings.updateSettings(req.body || {});
  const repriced = before.defaultMarkupPct !== after.defaultMarkupPct || before.vatRatePct !== after.vatRatePct ? catalog.repriceProducts() : 0;
  return { ...after, repriced };
}));

admin.get('/messages', wrap(() => getDb().prepare('SELECT * FROM contact_messages ORDER BY created_at DESC LIMIT 200').all()));
admin.put('/messages/:id', wrap((req) => ({ ok: getDb().prepare('UPDATE contact_messages SET handled = ? WHERE id = ?').run(req.body?.handled ? 1 : 0, req.params.id).changes > 0 })));

admin.get('/admins', wrap(() => auth.listAdmins()));
admin.post('/admins', wrap((req) => auth.createAdmin(req.body || {})));
admin.delete('/admins/:id', wrap((req) => ({ ok: orNotFound(auth.deleteAdmin(req.params.id)) })));
admin.put('/admins/:id/password', wrap((req) => ({ ok: orNotFound(auth.resetAdminPassword(req.params.id, req.body?.password)) })));

admin.get('/backups', wrap(() => listBackups()));
admin.post('/backups', wrap(async () => createBackup('manual')));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// --------------------------------------------------------------- static files

app.use('/uploads', express.static(uploadsDir(), { maxAge: '30d', fallthrough: false }));
// Admin files aren't content-hashed, so force revalidation -- otherwise a
// deploy leaves admins running stale JS until their cache expires.
app.use('/admin', express.static(path.join(ROOT, 'admin'), { index: 'index.html', setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));
// In production nginx serves dist/ directly; this makes `npm start` alone usable too.
if (fs.existsSync(path.join(ROOT, 'dist'))) app.use(express.static(path.join(ROOT, 'dist'), { extensions: ['html'] }));

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File too large' : err.message });
  if (err.status === 404) return res.status(404).send('Not found');
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

startBackupSchedule();
app.listen(PORT, HOST, () => console.log(`Procom API on http://${HOST}:${PORT} (admin: /admin/, Payfast ${payfastMode()})`));
