import { getDb } from './db.js';
import { saveCategory } from './catalog.js';
import { listFeedItems } from './feed.js';

// SMD's Infant Essential pricelist labels ~90% of its items "Baby & Toddler",
// which is useless as a shop menu. This sorts each item into a storefront
// sub-category by name, creates any missing categories and lists the lot.
// Colour variants stay separate products (the catalogue has no variants).

// First match wins, so the order matters: e.g. "Bottles & Accessories
// Cleanser" is cleaning, not a bottle; "Gravity Ball Bubblegum" is a cup.
const RULES = [
  ['Toys & Games', 'Outdoor & Bubble Toys', /^avalanche/i],
  ['Health & Wellness', 'Adult Incontinence', /lifree/i],
  ['Home & Kitchen', 'Kitchen & Drinkware', /loop & co/i],
  ['Baby & Toddler', 'Nappy & Changing Bags', /totes babe|diaper backpack|caddy|shoulder bag/i],
  ['Baby & Toddler', 'Maternity & Breastfeeding', /breast|nipple shield|nipple puller|nipple care|maternity|milk storage|milk saver|milk valve|lanolin|storage bag/i],
  ['Baby & Toddler', 'Sterilising & Cleaning', /steril|cleanser|brush for|bottle brush|sponge bottle|nipple brush|laundry|straw brush|bottles & accessories/i],
  ['Baby & Toddler', 'Bottles & Teats', /bottle(?!s &)|nipple|nurser|teat|juice feeder|cleft palate|straw set|powder milk container/i],
  ['Baby & Toddler', 'Feeding & Weaning', /plate|bowl|spoon|fork|snack cup|straw cup|training cup|bib|food maker|weaning|feeding bundle|mag mag|feeding dish/i],
  ['Baby & Toddler', 'Dummies & Teethers', /pacifier|dummy|soother|teether/i],
  ['Baby & Toddler', 'Oral Care', /tooth|gum wipe/i],
  ['Baby & Toddler', 'Health & Safety', /thermometer|nose cleaner|nail sc|cooling sheet|mosquito lotion|mosquito patch|safety pin|comb|hairbrush|starter kit/i],
  ['Baby & Toddler', 'Wipes', /wipe|moisturi[sz]ing cloth/i],
  ['Baby & Toddler', 'Bath & Skin Care', /wash|shampoo|lotion|oil|cream|powder|gel|travel set|mist|serum|cotton/i],
  ['Baby & Toddler', 'Blankets & Swaddles', /blanket|swaddle/i],
  ['Baby & Toddler', 'Baby Toys & Keepsakes', /stacking|milestone card/i],
  ['Baby & Toddler', 'Hair Accessories', /headband/i],
];

// Monthly file names differ ("SMD_Infant_Essential_Pricelist_for_September_2026.xlsx"),
// but all contain "Infant". Other SMD lists can carry the same brands.
const SOURCE_FILE = '%infant%';

export function classifyInfantItem(name) {
  const hit = RULES.find(([, , re]) => re.test(name || ''));
  return hit ? { parent: hit[0], sub: hit[1] } : null;
}

function findCategory(db, name, parentId) {
  return db
    .prepare(`SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND ${parentId ? 'parent_id = ?' : 'parent_id IS NULL'}`)
    .get(...(parentId ? [name, parentId] : [name]));
}

// Existing categories are reused by name, so running this twice is harmless.
function ensureCategory(db, name, parentId, created) {
  const found = findCategory(db, name, parentId);
  if (found) return found.id;
  const sortOrder = db.prepare(`SELECT COUNT(*) n FROM categories WHERE ${parentId ? 'parent_id = ?' : 'parent_id IS NULL'}`).get(...(parentId ? [parentId] : [])).n;
  created.push(name);
  return saveCategory({ name, parentId, sortOrder }, null, db).id;
}

// dryRun reports what would happen without creating or listing anything.
export function autoListInfantEssential({ supplierId, dryRun = false } = {}, db = getDb()) {
  if (!supplierId) throw new Error('Choose the SMD supplier first');
  const rows = db
    .prepare(`SELECT f.id, f.code, f.name, p.id AS product_id, p.category_id
      FROM feed_items f LEFT JOIN products p ON p.supplier_id = f.supplier_id AND p.supplier_code = f.code
      WHERE f.supplier_id = ? AND f.in_latest_import = 1 AND f.source_file LIKE ?
      ORDER BY f.name`)
    .all(supplierId, SOURCE_FILE);

  const groups = new Map(); // "Parent › Sub" -> { parent, sub, toList: [], toCategorise: [] }
  const unmatched = [];
  let alreadyCategorised = 0;
  for (const r of rows) {
    const c = classifyInfantItem(r.name);
    if (!c) {
      unmatched.push({ code: r.code, name: r.name });
      continue;
    }
    if (r.product_id && r.category_id) {
      alreadyCategorised++; // an admin's category choice wins
      continue;
    }
    const key = `${c.parent} › ${c.sub}`;
    if (!groups.has(key)) groups.set(key, { ...c, toList: [], toCategorise: [] });
    const g = groups.get(key);
    r.product_id ? g.toCategorise.push(r.product_id) : g.toList.push(r.id);
  }

  const summary = [...groups.entries()]
    .map(([category, g]) => ({ category, newListings: g.toList.length, categorised: g.toCategorise.length }))
    .sort((a, b) => a.category.localeCompare(b.category));
  const result = { itemsFound: rows.length, summary, unmatched, alreadyCategorised, categoriesCreated: [], created: 0, categorised: 0, errors: [] };
  if (dryRun) return result;

  const run = db.transaction(() => {
    const setCat = db.prepare('UPDATE products SET category_id = ?, updated_at = ? WHERE id = ?');
    const ts = new Date().toISOString();
    for (const g of groups.values()) {
      const parentId = ensureCategory(db, g.parent, null, result.categoriesCreated);
      const categoryId = ensureCategory(db, g.sub, parentId, result.categoriesCreated);
      if (g.toList.length) {
        const r = listFeedItems({ feedIds: g.toList, categoryId, markupPct: null, active: true }, db);
        result.created += r.created;
        result.errors.push(...r.errors);
      }
      for (const id of g.toCategorise) result.categorised += setCat.run(categoryId, ts, id).changes;
    }
  });
  run();
  return result;
}
