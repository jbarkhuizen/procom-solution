import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';

process.env.UPLOADS_DIR = path.join(os.tmpdir(), 'procom-test-uploads');
process.env.DISABLE_BACKUPS = '1';

const { useMemoryDb } = await import('./db.js');
const feed = await import('./feed.js');
const { classifyItem, autoList, tidyParentLevel } = await import('./smd-autolist.js');

let db;
let supplierId;
beforeEach(() => {
  db = useMemoryDb();
  supplierId = db.prepare('SELECT id FROM suppliers').get().id;
});

const classifyInfantItem = (name) => classifyItem('infant', { name });
const sub = (name) => classifyInfantItem(name)?.sub;
const autoListInfantEssential = (opts) => autoList({ ...opts, list: 'infant' });

test('classifies names whose keywords overlap', () => {
  assert.equal(sub('Pigeon - Baby Bottles & Accessories Cleanser 500ml'), 'Sterilising & Cleaning');
  assert.equal(sub('Pigeon - Sponge Bottle Brush'), 'Sterilising & Cleaning');
  assert.equal(sub('Pigeon Startouch Straw Cup With Gravity Ball Bubblegum Pop 250ml'), 'Feeding & Weaning');
  assert.equal(sub('Pigeon Breast Pads ComfyFeel 50 Pc Box'), 'Maternity & Breastfeeding');
  assert.equal(sub('Pigeon Softouch Nipple Blister Pack 2 Pcs (M)'), 'Bottles & Teats');
  assert.equal(sub('Pigeon - ANTI-MOSQUITO LOTION 50G'), 'Health & Safety');
  assert.equal(sub('Pigeon - Anti-Mosquito Wipe 12P/PK'), 'Wipes');
  assert.equal(sub('Pigeon Baby Tooth & Gum Wipes - Natural (20 Pcs)'), 'Oral Care');
  assert.equal(sub('Totes Babe Wavy Series Stroller Caddy Grey'), 'Nappy & Changing Bags');
  assert.equal(sub('Echo Baby Silicone Stacking Rings - Ocean'), 'Baby Toys & Keepsakes');
  assert.deepEqual(classifyInfantItem('Avalanche Double Bubble - Cyclone'), { parent: 'Toys & Games', sub: 'Outdoor & Bubble Toys', quote: false });
  assert.deepEqual(classifyInfantItem('Lifree Powerful L - 10 Pc'), { parent: 'Health & Beauty', sub: 'Personal Care & Wellness', quote: false });
  assert.equal(classifyInfantItem('Something unrelated'), null);
});

const csv = [
  'code,name,price',
  'EB-1000-BL,Echo Baby Silicone Suction Plate - Powder Blue,129.99',
  'EB-1000-IV,Echo Baby Silicone Suction Plate - Ivory,129.99',
  'SEL-8013,Pigeon - Baby Bottles & Accessories Cleanser 500ml,75.80',
  'LAC-PDQ-TQ,Loop & Co Bottle Buddies PDQ,3900',
  'X-1,Mystery item,10',
].join('\n');

test('dry run changes nothing; real run creates categories and lists each colour separately', async () => {
  await feed.importFile({ supplierId, fileName: 'SMD_Infant_Essential_Pricelist.csv', buffer: Buffer.from(csv) });
  await feed.importFile({ supplierId, fileName: 'SMD_Cash_Wholesale.csv', buffer: Buffer.from('code,name,price\nOTHER,Echo Baby Bib,50\n'), completeList: false });
  const cats = () => db.prepare('SELECT COUNT(*) n FROM categories').get().n;
  const before = cats();

  const dry = autoListInfantEssential({ supplierId, dryRun: true });
  assert.equal(dry.itemsFound, 5, 'only rows from the Infant Essential file');
  assert.deepEqual(dry.unmatched.map((u) => u.code), ['X-1']);
  assert.equal(cats(), before);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM products').get().n, 0);

  const r = autoListInfantEssential({ supplierId, dryRun: false });
  assert.equal(r.created, 4);
  assert.deepEqual(r.errors, []);
  // Baby & Toddler and Home & Kitchen are seeded; only their sub-categories are new.
  assert.deepEqual(r.categoriesCreated.sort(), ['Feeding & Weaning', 'Food Storage & Drinkware', 'Sterilising & Cleaning']);
  const placed = db.prepare(`SELECT p.supplier_code code, c.name cat, parent.name parent, p.markup_pct FROM products p
    JOIN categories c ON c.id = p.category_id JOIN categories parent ON parent.id = c.parent_id ORDER BY code`).all();
  assert.deepEqual(placed.map((p) => [p.code, p.parent, p.cat]), [
    ['EB-1000-BL', 'Baby & Toddler', 'Feeding & Weaning'],
    ['EB-1000-IV', 'Baby & Toddler', 'Feeding & Weaning'],
    ['LAC-PDQ-TQ', 'Home & Kitchen', 'Food Storage & Drinkware'],
    ['SEL-8013', 'Baby & Toddler', 'Sterilising & Cleaning'],
  ]);
  assert.ok(placed.every((p) => p.markup_pct == null), 'default markup');

  // Second run: nothing new, no duplicate categories.
  const n = cats();
  const again = autoListInfantEssential({ supplierId, dryRun: false });
  assert.equal(again.created, 0);
  assert.equal(again.alreadyCategorised, 4);
  assert.equal(cats(), n);
});

test('a listed product without a category gets one; an admin-chosen category is kept', async () => {
  await feed.importFile({ supplierId, fileName: 'SMD_Infant_Essential_Pricelist.csv', buffer: Buffer.from(csv) });
  const fid = (code) => db.prepare('SELECT id FROM feed_items WHERE code = ?').get(code).id;
  const gaming = db.prepare("SELECT id FROM categories WHERE slug = 'gaming'").get().id;
  feed.listFeedItems({ feedIds: [fid('EB-1000-BL')] });
  feed.listFeedItems({ feedIds: [fid('SEL-8013')], categoryId: gaming });

  const r = autoListInfantEssential({ supplierId, dryRun: false });
  assert.equal(r.categorised, 1);
  assert.equal(r.alreadyCategorised, 1);
  assert.equal(db.prepare("SELECT category_id FROM products WHERE supplier_code = 'SEL-8013'").get().category_id, gaming);
  const cat = db.prepare("SELECT c.name FROM products p JOIN categories c ON c.id = p.category_id WHERE p.supplier_code = 'EB-1000-BL'").get();
  assert.equal(cat.name, 'Feeding & Weaning');
});

// ---------------------------------------------------------------- cash wholesale

const cash = (name, category = '', sheet = '') => classifyItem('cash', { name, category, sheet });
const where = (...a) => {
  const c = cash(...a);
  return c?.skip ? `skip: ${c.skip}` : c && `${c.parent} › ${c.sub}`;
};

test('cash wholesale: product name beats SMD category, and rule order holds', () => {
  assert.equal(where('Lenovo Laptop V15 AMD Ryzen3 8/256', 'Devices'), 'Computers & Peripherals › Laptops & Tablets');
  assert.equal(where('Volkano Brio Plus Series USB-C 65w Laptop Charger', 'Devices'), 'Computers & Peripherals › Computer Accessories');
  assert.equal(where('Supanova Azura Ladies 15.6" Laptop Tote Bag Black', 'Bags'), 'Bags & Laptop Cases › Laptop Bags & Backpacks');
  assert.equal(where('IPHONE 16 128GB BLACK(Cellular Bundle)', 'Devices'), 'Mobile & Wearables › Phones');
  assert.equal(where('Volkano Active Tech Serene Series Watch with Heart Rate Monitor - Silver', 'Wearables'), 'Mobile & Wearables › Smartwatches');
  assert.equal(where('Volkano 24-inch Full HD IPS Monitor with HDMI/VGA, 100 Hz', 'Devices'), 'Computers & Peripherals › Monitors');
  assert.equal(where('Volkano Steel Series Full Motion Single Monitor Desk Mount 17" - 32"', 'Computer Accessories'), 'Computers & Peripherals › Laptop & Monitor Stands');
  assert.equal(where('Sony ULT Wear NC - Black', 'Audio'), 'Audio › Headphones');
  assert.equal(where('Amplify Wingman Series 8" Party Speaker with Microphone - Black', 'Audio'), 'Audio › Speakers');
  assert.equal(where('Disney Frozen Bluetooth Mini Karaoke Machine with Belt Hook', 'Audio'), 'Audio › Microphones & Karaoke');
  assert.equal(where('Ellies Ultra Series - Alkaline Batteries AA 4 Pack - WT', 'Electrical'), 'Power & Electrical › Batteries');
  assert.equal(where('Insta360 X5 Battery', 'Photography'), 'Cameras & Photography › Camera Accessories');
  assert.equal(where('TP-Link Tapo T100 Smart 868mhz Motion Sensor - CR2032 Battery', 'Smart Home', 'Tapo'), 'Smart Home & Lighting › Smart Home');
  assert.equal(where('Ellies Secure Series - Wireless Doorbell - Battery operated Receiver and Transmitter', 'Electrical'), 'Power & Electrical › Switches, Sockets & Wiring');
  assert.equal(where('Volkano Galactic Mini Moon LED Mood Light – Battery Operated', 'Lighting'), 'Smart Home & Lighting › Lamps & Indoor Lighting');
  assert.equal(where('Volkano Extra Series CR2016 Pack of 2 Batteries', 'Electrical'), 'Power & Electrical › Batteries');
  assert.equal(where('TP-Link Vigi C330I 3MP 6mm Outdoor Bullet Network Camera', 'Networking', 'VIGI'), 'Networking › Security Cameras');
  assert.equal(where('SA Filament PLA Hyper Filament 1kg - Black', 'Devices', 'SA Filament'), '3D Printing › Filament – PLA');
  assert.equal(where('SA Filament Silk PLA Plus Filament 1kg - Brown', 'Devices', 'SA Filament'), '3D Printing › Filament – PLA');
  assert.equal(where('SA Filament PETG Speed Green Filament 1kg,1.75mm', 'Devices', 'SA Filament'), '3D Printing › Filament – PETG');
  assert.equal(where('SA Filament ABS Premium Filament 1kg - Black', 'Devices', 'SA Filament'), '3D Printing › Filament – ABS & ASA');
  assert.equal(where('SA Filament TPU 95A 500g - Red', 'Devices', 'SA Filament'), '3D Printing › Filament – TPU & Specialist');
  assert.equal(where('Creality K1 Max 3D Printer 300x300x300', 'Devices', 'Creality'), 'skip: Creality: listed from the Creality list');
  assert.equal(where('Volkano On The Go PDQ Box', 'Display Unit', 'Volkano'), 'skip: Display stand, not for sale');
  assert.deepEqual(cash('Mercury VX Gaming Chair - Black', 'Furniture'), { parent: 'Gaming', sub: 'Gaming Chairs & Desks', quote: true });
  assert.equal(where('VX Gaming Electra Series Rocking Gaming Chair with LED lights', 'Gaming'), 'Gaming › Gaming Chairs & Desks');
  assert.deepEqual(cash('Samsung Galaxy S24 256gb DS Black', 'Devices'), { parent: 'Mobile & Wearables', sub: 'Phones', quote: false, markup: 10 });
  assert.equal(cash('Something', 'Brand New SMD Category'), null);
});

test('cash wholesale: skips wrong prices, flags quoted delivery, previews new categories', async () => {
  const file = [
    'code,name,category,price',
    'LAP-1,Lenovo Laptop V15 AMD Ryzen3 8/256,Devices,6999',
    'CH-1,Mercury VX Gaming Chair - Black,Furniture,1299.99',
    'PDQ-1,Volkano On The Go PDQ Box,Display Unit,0.01',
    'TOS-1,TOSLINK Male to TOSLINK Male 3m,Televisions,1082026',
    'SCR-1,Connex E-Luminate Pull-Down Projector Screen 100in - 16:9,Devices,599',
    'MNT-1,Volkano Steel Series Tilt TV Wall Mount for 23" - 43" TVs,Televisions,104.34',
  ].join('\n');
  await feed.importFile({ supplierId, fileName: 'SMD_Cash_wholesale_September_pricelist_2026_-1.csv', buffer: Buffer.from(file) });

  const dry = autoList({ list: 'cash', supplierId, dryRun: true });
  assert.deepEqual(dry.summary.map((g) => [g.category, g.newListings]), [
    ['Computers & Peripherals › Laptops & Tablets', 1],
    ['Gaming › Gaming Chairs & Desks', 1],
    ['TV & Video › Projectors & Screens', 1],
    ['TV & Video › TV Wall Mounts & Stands', 1],
  ]);
  assert.deepEqual(dry.newCategories, [
    'Computers & Peripherals › Laptops & Tablets (10% markup)',
    'Gaming › Gaming Chairs & Desks (delivery quoted)',
    'TV & Video',
    'TV & Video › Projectors & Screens',
    'TV & Video › TV Wall Mounts & Stands',
  ]);
  assert.deepEqual(dry.heavy.map((i) => i.code), ['SCR-1'], 'a 100" screen is heavy; a 43" mount is not');
  assert.deepEqual(dry.skipped.map((g) => [g.reason, g.items.map((i) => i.code)]), [
    ['Display stand, not for sale', ['PDQ-1']],
    ['Price looks wrong (R1082026.00)', ['TOS-1']],
  ]);

  const r = autoList({ list: 'cash', supplierId, dryRun: false });
  assert.equal(r.created, 4);
  assert.equal(r.quoted, 1);
  const quote = (code) => db.prepare('SELECT quote_delivery FROM products WHERE supplier_code = ?').get(code).quote_delivery;
  assert.equal(quote('SCR-1'), 1);
  assert.equal(quote('MNT-1'), null, 'inherits from its category');
  assert.equal(db.prepare("SELECT markup_pct FROM categories WHERE name = 'Laptops & Tablets'").get().markup_pct, 10);
  const chairs = db.prepare("SELECT quote_delivery FROM categories WHERE name = 'Gaming Chairs & Desks'").get();
  assert.equal(chairs.quote_delivery, 1);
  const laptops = db.prepare("SELECT quote_delivery FROM categories WHERE name = 'Laptops & Tablets'").get();
  assert.equal(laptops.quote_delivery, 0);
});

test('unknown pricelist is rejected', () => {
  assert.throws(() => autoList({ list: 'nope', supplierId }), /Unknown pricelist/);
});

test('tidy: parent-level products move into the matching sub-category, never across parents', async () => {
  const file = [
    'code,name,category,price',
    'G-1,VX Gaming Phoenix Series Wireless Gaming Mouse,Gaming,299',
    'G-2,Sony INZONE H9 Wireless Noise Cancelling Gaming Headset,Gaming,2999',
    'A-1,Sony XB100 Portable Bluetooth Speak - Black,Audio,899',
    'N-1,TP-Link TL-SG108 8-Port Gigabit Desktop Switch,Networking,300',
    'LAP-1,Lenovo Laptop V15 AMD Ryzen3 8/256,Devices,6999',
  ].join('\n');
  await feed.importFile({ supplierId, fileName: 'SMD Cash wholesale September pricelist 2026 -1.csv', buffer: Buffer.from(file) });
  const fid = (code) => db.prepare('SELECT id FROM feed_items WHERE code = ?').get(code).id;
  const cat = (slug) => db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug).id;
  // Hand-listed straight onto parents, as on the live site.
  feed.listFeedItems({ feedIds: ['G-1', 'G-2', 'A-1'].map(fid), categoryId: cat('gaming') });
  feed.listFeedItems({ feedIds: [fid('N-1')], categoryId: cat('networking') });
  // Give Gaming its sub-categories; Networking's "Switches" is seeded.
  autoList({ list: 'cash', supplierId, dryRun: false }); // lists LAP-1, creates nothing under Gaming yet
  const gaming = cat('gaming');
  const catalog = await import('./catalog.js');
  catalog.saveCategory({ name: 'Gaming Mice & Keyboards', parentId: gaming }, null, db);

  const dry = tidyParentLevel({ supplierId });
  assert.equal(dry.found, 4);
  assert.deepEqual(dry.moves, [
    { category: 'Gaming › Gaming Mice & Keyboards', count: 1 },
    { category: 'Networking › Switches', count: 1 },
  ]);
  assert.deepEqual(dry.missingSub.map((i) => i.code), ['G-2'], 'Gaming Headsets does not exist yet');
  assert.deepEqual(dry.otherParent.map((i) => [i.code, i.suggested]), [['A-1', 'Audio › Speakers']]);
  const where = (code) => db.prepare('SELECT c.name FROM products p JOIN categories c ON c.id = p.category_id WHERE p.supplier_code = ?').get(code).name;
  assert.equal(where('G-1'), 'Gaming', 'dry run moves nothing');

  const r = tidyParentLevel({ supplierId, dryRun: false });
  assert.equal(r.moved, 2);
  assert.equal(where('G-1'), 'Gaming Mice & Keyboards');
  assert.equal(where('N-1'), 'Switches');
  assert.equal(where('G-2'), 'Gaming');
  assert.equal(where('A-1'), 'Gaming', 'never moved across parents');
  assert.equal(tidyParentLevel({ supplierId }).moves.length, 0, 'second run has nothing to move');
});
