import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';

process.env.UPLOADS_DIR = path.join(os.tmpdir(), 'procom-test-uploads');
process.env.DISABLE_BACKUPS = '1';

const { useMemoryDb } = await import('./db.js');
const catalog = await import('./catalog.js');
const orders = await import('./orders.js');
const vault = await import('./vault.js');

let db;
beforeEach(() => {
  db = useMemoryDb();
  process.env.VAULT_KEY = 'test-vault-key-0123456789';
});

const customer = { firstName: 'Ann', lastName: 'Lee', email: 'ann@example.com', phone: '0821234567', addressLine1: '1 Main Rd', city: 'Pretoria', postalCode: '0081' };
const noAddr = { firstName: 'Ann', email: 'ann@example.com', phone: '0821234567' };

// ------------------------------------------------------------ vendor details

test('vault: round trip, random IV, and a clear error without or with a wrong key', () => {
  const a = vault.encryptSecret('Portal#Pass1');
  assert.notEqual(a, vault.encryptSecret('Portal#Pass1'), 'same text encrypts differently each time');
  assert.doesNotMatch(a, /Portal/);
  assert.equal(vault.decryptSecret(a), 'Portal#Pass1');
  process.env.VAULT_KEY = 'another-key-entirely-xyz';
  assert.throws(() => vault.decryptSecret(a), /current key/);
});

test('vault: without VAULT_KEY the server creates its own key file once (owner-only) and keeps using it', () => {
  const file = path.join(os.tmpdir(), `procom-vault-${crypto.randomUUID()}`);
  delete process.env.VAULT_KEY;
  process.env.VAULT_KEY_FILE = file;
  try {
    const enc = vault.encryptSecret('abc');
    assert.ok(fs.existsSync(file));
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const keyText = fs.readFileSync(file, 'utf8');
    assert.equal(vault.decryptSecret(enc), 'abc');
    vault.encryptSecret('again');
    assert.equal(fs.readFileSync(file, 'utf8'), keyText, 'never replaced');
  } finally {
    delete process.env.VAULT_KEY_FILE;
    fs.rmSync(file, { force: true });
  }
});

test('supplier portal password: stored encrypted, never listed, kept when left blank, removable', () => {
  // Made up at run time: no credential-looking literal in the repo (secret scanners).
  const pw = `t-${crypto.randomUUID()}`;
  const s = catalog.saveSupplier({ name: 'Esquire', address: '71 Landmarks Ave', orderProcess: 'Order on the portal', website: 'www.esquire.co.za', portalUsername: 'someone', portalPassword: pw }, null, db);
  const raw = db.prepare('SELECT portal_password_enc FROM suppliers WHERE id = ?').get(s.id).portal_password_enc;
  assert.match(raw, /^v1:/);
  assert.ok(!raw.includes(pw));
  assert.equal(s.hasPortalPassword, true);
  assert.equal(s.website, 'https://www.esquire.co.za');
  assert.ok(!JSON.stringify(catalog.listSuppliers(db)).includes(pw));
  assert.ok(!JSON.stringify(catalog.listSuppliers(db)).includes(raw), 'ciphertext not listed either');
  assert.equal(catalog.supplierPortalPassword(s.id, db).password, pw);

  // The admin form sends a blank password field when it is not being changed.
  const again = catalog.saveSupplier({ name: 'Esquire', portalPassword: '', phone: '011 000 0000' }, s.id, db);
  assert.equal(catalog.supplierPortalPassword(s.id, db).password, pw);
  assert.equal(again.address, '71 Landmarks Ave', 'fields left out are kept');
  catalog.saveSupplier({ name: 'Esquire', clearPortalPassword: true }, s.id, db);
  assert.equal(catalog.listSuppliers(db).find((x) => x.id === s.id).hasPortalPassword, false);
});

// --------------------------------------------- own courier + courier insurance

function setup() {
  const sup = catalog.saveSupplier({ name: 'Esquire', collectionEnabled: true, collectionAddress: '71 Landmarks Avenue, Samrand', collectionHours: 'Mon–Fri 09:00–16:00', ownCourierEnabled: true, publicLabel: 'Samrand warehouse' }, null, db);
  const tv = catalog.saveCategory({ name: 'Televisions', quoteDelivery: true, courierInsurancePct: 3 }, null, db);
  const cables = catalog.saveCategory({ name: 'Cables' }, null, db);
  const mk = (name, categoryId, priceCents) => catalog.saveProduct({ name, categoryId, supplierId: sup.id, priceMode: 'manual', priceCents, costCents: priceCents / 2 }, null, db);
  return { sup, tvP: mk('Hisense 55 Inch TV', tv.id, 1000000), cable: mk('HDMI cable', cables.id, 10000) };
}

test('own courier: free, no delivery address needed, logged and on the supplier sheet', () => {
  const { sup, cable } = setup();
  const plan = orders.deliveryPlanForCart([{ productId: cable.id, quantity: 1 }], db);
  assert.deepEqual(plan[0].options.map((o) => o.id).slice(0, 2), ['collect', 'own_courier']);
  const o = orders.createOrder({ customer: noAddr, delivery: { [sup.id]: 'own_courier' }, items: [{ productId: cable.id, quantity: 1 }] }, db);
  assert.equal(o.shippingCents, 0);
  assert.equal(o.totalCents, 10000);
  assert.equal(o.shipments[0].collection.address, '71 Landmarks Avenue, Samrand');
  assert.ok(o.events.some((e) => /own courier/.test(e.message)));
  assert.match(orders.supplierOrderSheet(o)[0].text, /OWN COURIER/);
});

test('courier insurance: 3% of the TV price as its own line when our courier carries it, never on collect / own courier', () => {
  const { sup, tvP, cable } = setup();
  const cart = [{ productId: tvP.id, quantity: 1 }, { productId: cable.id, quantity: 2 }];
  const quote = orders.deliveryPlanForCart(cart, db)[0].options.find((x) => x.id === 'quote');
  assert.equal(quote.insuranceCents, 30000, '3% of R10,000 -- the cable is not insured');
  assert.match(quote.insuranceName, /3% of Hisense 55 Inch TV/);
  assert.equal(orders.deliveryPlanForCart(cart, db)[0].options.find((x) => x.id === 'collect').insuranceCents, 0);

  const o = orders.createOrder({ customer, delivery: { [sup.id]: 'quote' }, items: cart }, db);
  assert.equal(o.insuranceCents, 30000);
  assert.equal(o.shippingCents, 30000, 'delivery itself quoted later; insurance charged now');
  assert.equal(o.totalCents, 1000000 + 20000 + 30000);
  assert.match(orders.supplierOrderSheet(o)[0].text, /insurance/i);

  const collected = orders.createOrder({ customer: noAddr, delivery: { [sup.id]: 'collect' }, items: cart }, db);
  assert.equal(collected.insuranceCents, 0);
  assert.equal(collected.totalCents, 1020000);
});

test('courier insurance is inherited by sub-categories; blank means "same as parent"', () => {
  const tv = catalog.saveCategory({ name: 'TV & Video', courierInsurancePct: 3 }, null, db);
  const sub = catalog.saveCategory({ name: 'Smart TVs', parentId: tv.id, courierInsurancePct: '' }, null, db);
  const off = catalog.saveCategory({ name: 'TV Cables', parentId: tv.id, courierInsurancePct: 0 }, null, db);
  const map = catalog.courierInsuranceByCategory(db);
  assert.equal(map.get(sub.id), 3);
  assert.equal(map.has(off.id), false, '0 switches it off below');
  // An older caller that does not know the field keeps it.
  catalog.saveCategory({ name: 'TV & Video' }, tv.id, db);
  assert.equal(catalog.courierInsuranceByCategory(db).get(tv.id), 3);
});

test('storefront products say which warehouse ships them -- public label only, never the supplier name', () => {
  const { cable } = setup();
  const pub = catalog.getPublicProductBySlug(cable.slug, db).product;
  assert.equal(pub.shipsFrom, 'Samrand warehouse');
  assert.ok(!JSON.stringify(pub).includes('Esquire'), 'supplier name not in public data');
  const listed = catalog.queryProducts({ q: 'HDMI' }, db).items[0];
  assert.equal(listed.shipsFrom, 'Samrand warehouse');
  assert.ok(!JSON.stringify(listed).includes('Esquire'));
  // A second warehouse gets a different icon colour.
  const other = catalog.saveSupplier({ name: 'SMD', publicLabel: 'Edenvale warehouse' }, null, db);
  const p2 = catalog.saveProduct({ name: 'Mouse', supplierId: other.id, priceMode: 'manual', priceCents: 5000 }, null, db);
  const tones = catalog.queryProducts({}, db).items.map((p) => [p.id, p.shipsFromTone]);
  assert.notEqual(new Map(tones).get(p2.id), new Map(tones).get(cable.id));
});
