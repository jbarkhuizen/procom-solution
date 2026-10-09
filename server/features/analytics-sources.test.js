import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import zlib from 'zlib';

process.env.UPLOADS_DIR = path.join(os.tmpdir(), 'procom-test-uploads');
process.env.DISABLE_BACKUPS = '1';
process.env.DISABLE_GEOIP_UPDATE = '1';
process.env.GEOIP_DIR = path.join(os.tmpdir(), `procom-test-geoip-${process.pid}`);
process.env.VAULT_KEY = 'test-vault-key-for-geoip-tests-only';
delete process.env.GMAIL_USER;

const { useMemoryDb } = await import('../db.js');
const channels = await import('./channels.js');
const analytics = await import('./analytics.js');
const geo = await import('./geoip.js');
const orders = await import('../orders.js');

let db;
beforeEach(() => {
  db = useMemoryDb();
  analytics._resetOnline();
  geo._resetGeo();
});

const R = (host, utmSource = '', utmMedium = '') => channels.classifyChannel({ host, utmSource, utmMedium }).key;

test('channels: referrers and campaign tags become readable channels', () => {
  assert.equal(R('google.com'), 'google');
  assert.equal(R('www.google.co.za'), 'google');
  assert.equal(R('bing.com'), 'search');
  assert.equal(R('duckduckgo.com'), 'search');
  for (const h of ['facebook.com', 'l.facebook.com', 'm.facebook.com', 'lm.facebook.com']) assert.equal(R(h), 'facebook', h);
  assert.equal(R('l.instagram.com'), 'instagram');
  assert.equal(R('t.co'), 'x');
  assert.equal(R('mail.google.com'), 'email', 'webmail is not Google search');
  assert.equal(R('someblog.co.za'), 'other');
  assert.equal(R(''), 'direct');
  // tags win over the referrer, and fix the app-browser "direct" case
  assert.equal(R('', 'whatsapp', 'social'), 'whatsapp');
  assert.equal(R('l.facebook.com', 'newsletter', 'email'), 'email');
  assert.equal(R('google.com', 'google', 'cpc'), 'paid');
  assert.equal(R('', 'my-partner', ''), 'other');
  assert.equal(R('', '', 'social'), 'social');
});

test('channels: tags and referring pages are cleaned', () => {
  assert.equal(channels.cleanTag('October-Specials'), 'october-specials');
  assert.equal(channels.cleanTag('Oct%20Sale'), 'oct sale');
  assert.equal(channels.cleanTag('<script>'), '');
  assert.equal(channels.cleanTag('x'.repeat(100)), 'x'.repeat(60), 'long tags are cut to 60 characters');
  assert.equal(channels.cleanRefPath('/blog/best-printers?utm=1#x'), '/blog/best-printers');
  assert.equal(channels.cleanRefPath('/'), '');
  assert.equal(channels.cleanRefPath('//evil.com/x'), '');
  assert.equal(channels.cleanRefPath('/a b<'), '');
  assert.equal(channels.isSearchHost('google.com'), true);
  assert.equal(channels.isSearchHost('someblog.co.za'), false);
});

test('channels: newsletter links to our site get campaign tags, others are left alone', () => {
  const html = '<a href="https://www.procomsolutions.co.za/product.html?p=x">A</a> <a href="https://elsewhere.com/a">B</a> <a href="https://www.procomsolutions.co.za/newsletter.html?unsubscribe=T">U</a> <a href="https://www.procomsolutions.co.za/?utm_source=keep">K</a>';
  const out = channels.addUtmToLinks(html, 'https://www.procomsolutions.co.za', 'October Specials!');
  assert.match(out, /product\.html\?p=x&amp;utm_source=newsletter&amp;utm_medium=email&amp;utm_campaign=october-specials/);
  assert.match(out, /href="https:\/\/elsewhere\.com\/a"/);
  assert.match(out, /unsubscribe=T"/);
  assert.ok(!/unsubscribe=T[^"]*utm_/.test(out));
  assert.match(out, /utm_source=keep"/, 'a link that already has tags is untouched');
});

test('beacon body: referring page only for non-search sites, tags cleaned', () => {
  const blog = analytics.parseView({ v: 'visitor-0001', path: '/', ref: 'someblog.co.za', refPath: '/best-printers?x=1', utmSource: 'Newsletter', utmMedium: 'email', utmCampaign: 'oct sale' });
  assert.deepEqual([blog.referrerHost, blog.referrerPath, blog.utmSource, blog.utmMedium, blog.utmCampaign], ['someblog.co.za', '/best-printers', 'newsletter', 'email', 'oct sale']);
  const g = analytics.parseView({ v: 'visitor-0001', path: '/', ref: 'google.com', refPath: '/search' });
  assert.equal(g.referrerPath, '', 'search engines never get a page');
  const none = analytics.parseView({ v: 'visitor-0001', path: '/', refPath: '/orphan' });
  assert.equal(none.referrerPath, '');
});

const visit = (v, over = {}, opts = {}) => analytics.recordPageView(analytics.parseView({ v, path: '/', ...over }), opts, db);

test('sources summary: channels with carts and orders, campaigns, referring pages, places', () => {
  visit('visitor-g001', { ref: 'google.com' }, { geo: { country: 'ZA', region: 'Gauteng', city: 'Pretoria' } });
  visit('visitor-g002', { ref: 'l.facebook.com' }, { geo: { country: 'ZA', region: 'Western Cape', city: 'Cape Town' } });
  visit('visitor-n001', { ref: '', utmSource: 'newsletter', utmMedium: 'email', utmCampaign: 'october' }, { geo: { country: 'NA', region: 'Khomas', city: 'Windhoek' } });
  visit('visitor-b001', { ref: 'someblog.co.za', refPath: '/best-printers' });
  visit('visitor-d001', {}); // direct, no place
  visit('visitor-d001', { path: '/shop' });
  analytics.recordEvent({ event: 'add_to_cart', visitorId: 'visitor-n001', path: '/product', productId: 'p1', quantity: 1 }, {}, db);
  analytics.recordEvent({ event: 'checkout_start', visitorId: 'visitor-n001', path: '/checkout', quantity: 1 }, {}, db);
  analytics.recordEvent({ event: 'add_to_cart', visitorId: 'visitor-g001', path: '/product', productId: 'p1', quantity: 1 }, {}, db);

  const paid = db.prepare("INSERT INTO orders (id, order_number, status, payment_status, payment_method, first_name, email, phone, subtotal_cents, total_cents, source_channel, source_detail, paid_at, created_at, updated_at) VALUES (?, ?, 'paid', 'paid', 'payfast_card', 'A', 'a@b.c', '1', 1000, ?, ?, ?, ?, 'x', 'x')");
  const now = new Date().toISOString();
  paid.run('o1', 'PC1', 50000, 'email', 'october', now);
  paid.run('o2', 'PC2', 20000, 'google', 'google.com', now);
  paid.run('o3', 'PC3', 10000, '', '', now); // order from before tracking

  const s = analytics.analyticsSummary({ days: 7 }, {}, db).sources;
  const by = Object.fromEntries(s.channels.map((c) => [c.key, c]));
  assert.deepEqual([by.google.visitors, by.facebook.visitors, by.email.visitors, by.other.visitors, by.direct.visitors], [1, 1, 1, 1, 1]);
  assert.deepEqual([by.email.carts, by.email.checkouts, by.email.orders, by.email.revenueCents, by.email.conversionRate], [1, 1, 1, 50000, 100]);
  assert.deepEqual([by.google.carts, by.google.orders], [1, 1]);
  assert.deepEqual(s.untrackedOrders, { orders: 1, revenueCents: 10000 });
  assert.deepEqual(s.campaigns.map((c) => [c.campaign, c.source, c.medium, c.visitors, c.orders]), [['october', 'newsletter', 'email', 1, 1]]);
  assert.deepEqual(s.referringPages.map((r) => [r.host, r.path, r.visitors]), [['someblog.co.za', '/best-printers', 1]]);
  assert.deepEqual(s.locations.countries.map((c) => [c.country, c.visitors]).sort(), [['NA', 1], ['ZA', 2]]);
  assert.deepEqual(s.locations.cities.map((c) => c.city).sort(), ['Cape Town', 'Pretoria', 'Windhoek']);
  assert.deepEqual(s.locations.regions.map((c) => c.region).sort(), ['Gauteng', 'Khomas', 'Western Cape']);
  assert.equal(s.locations.locatedVisitors, 3);
  assert.equal(s.locations.unlocatedVisitors, 2);
});

test('an order records the channel that brought the customer, as a plain label', () => {
  assert.deepEqual(orders.orderSource({ host: 'l.facebook.com', utmSource: '', utmMedium: '', utmCampaign: '' }), { sourceChannel: 'facebook', sourceDetail: 'l.facebook.com' });
  assert.deepEqual(orders.orderSource({ host: '', utmSource: 'newsletter', utmMedium: 'email', utmCampaign: 'october' }), { sourceChannel: 'email', sourceDetail: 'october' });
  assert.deepEqual(orders.orderSource({}), { sourceChannel: 'direct', sourceDetail: '' }, 'analytics on, nothing brought them: direct');
  assert.deepEqual(orders.orderSource(undefined), { sourceChannel: '', sourceDetail: '' }, 'analytics off: nothing recorded');
  assert.deepEqual(orders.orderSource({ host: '<bad host>', utmSource: '<x>' }), { sourceChannel: 'direct', sourceDetail: '' });
});

function tarGz(files) {
  const blocks = [];
  for (const [name, data] of files) {
    const head = Buffer.alloc(512);
    head.write(name, 0, 'utf8');
    head.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
    head[156] = '0'.charCodeAt(0);
    blocks.push(head, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

test('geoip: the database is found inside the MaxMind download', () => {
  const mmdb = Buffer.from('FAKE-MMDB-CONTENT');
  const gz = tarGz([['GeoLite2-City_20261006/COPYRIGHT.txt', Buffer.from('c')], ['GeoLite2-City_20261006/GeoLite2-City.mmdb', mmdb]]);
  assert.deepEqual(geo.extractMmdb(gz), mmdb);
  assert.throws(() => geo.extractMmdb(tarGz([['readme.txt', Buffer.from('x')]])), /did not contain/);
});

test('geoip: account saved with the key encrypted; the key is never returned', () => {
  assert.equal(geo.geoStatus(db).configured, false);
  const st = geo.saveGeoCredentials({ accountId: '123456', licenseKey: 'abcDEF1234567890xyz' }, db);
  assert.deepEqual([st.configured, st.accountId, st.hasKey], [true, '123456', true]);
  assert.ok(!JSON.stringify(st).includes('abcDEF1234567890xyz'));
  const stored = db.prepare("SELECT value FROM ops_settings WHERE key = 'geoip_license_enc'").get().value;
  assert.ok(stored && !stored.includes('abcDEF1234567890xyz'), 'encrypted at rest');
  // blank key keeps the saved one
  geo.saveGeoCredentials({ accountId: '123456', licenseKey: '' }, db);
  assert.equal(geo.geoStatus(db).hasKey, true);
  assert.throws(() => geo.saveGeoCredentials({ accountId: 'abc' }, db), /number/);
  assert.throws(() => geo.saveGeoCredentials({ licenseKey: 'bad key!' }, db), /licence key/);
});

test('geoip: a rejected key or a refusal is reported and stored, not thrown at visitors', async () => {
  await assert.rejects(geo.updateGeoDatabase({ fetchImpl: async () => ({ status: 200, ok: true }) }, db), /Enter the MaxMind/);
  geo.saveGeoCredentials({ accountId: '1', licenseKey: 'abcDEF1234567890xyz' }, db);
  let seenAuth = '';
  await assert.rejects(geo.updateGeoDatabase({ fetchImpl: async (_url, o) => ((seenAuth = o.headers.Authorization), { status: 401, ok: false }) }, db), /rejected the account ID or licence key/);
  assert.match(seenAuth, /^Basic /);
  assert.match(geo.geoStatus(db).lastError, /rejected/);
  await assert.rejects(geo.updateGeoDatabase({ fetchImpl: async () => ({ status: 429, ok: false }) }, db), /daily limit/);
});

test('geoip: place lookup keeps only names; private and unknown addresses give nothing', () => {
  geo.setGeoLookupForTests((ip) => (ip === '41.0.0.1' ? { country: { iso_code: 'ZA' }, subdivisions: [{ names: { en: 'Gauteng' } }], city: { names: { en: 'Pretoria' } } } : null));
  assert.deepEqual(geo.geoFor('41.0.0.1'), { country: 'ZA', region: 'Gauteng', city: 'Pretoria' });
  assert.deepEqual(geo.geoFor('::ffff:41.0.0.1'), { country: 'ZA', region: 'Gauteng', city: 'Pretoria' });
  assert.deepEqual(geo.geoFor('8.8.8.8'), { country: '', region: '', city: '' });
  for (const ip of ['127.0.0.1', '192.168.1.5', '10.0.0.2', '::1', '', undefined]) assert.deepEqual(geo.geoFor(ip), { country: '', region: '', city: '' }, String(ip));
  // the IP never reaches the database
  visit('visitor-geo01', {}, { geo: geo.geoFor('41.0.0.1') });
  const row = db.prepare('SELECT * FROM page_views ORDER BY id DESC LIMIT 1').get();
  assert.ok(!JSON.stringify(row).includes('41.0.0.1'));
  assert.deepEqual([row.country, row.region, row.city], ['ZA', 'Gauteng', 'Pretoria']);
});
