import { getDb } from './db.js';
import { saveCategory, bulkUpdateProducts } from './catalog.js';
import { listFeedItems } from './feed.js';
import { SMD_LISTS } from './smd-rules.js';
import { ESQUIRE_LIST } from './esquire-rules.js';

// Every list the auto-list knows; tidyParentLevel() stays SMD-only.
export const AUTOLIST_LISTS = { ...SMD_LISTS, esquire: ESQUIRE_LIST };

// One-click listing of an imported SMD pricelist: each row is sorted into a
// storefront sub-category by the rules in smd-rules.js, missing categories
// are created and the rows are listed at the default markup. Colour variants
// stay separate products (the catalogue has no variants).

// Supplier typos: display stands at R0.01, a cable at R1,082,026.
const MIN_COST_CENTS = 100;
const MAX_COST_CENTS = 10_000_000;

function getList(key) {
  const list = AUTOLIST_LISTS[key];
  if (!list) throw new Error(`Unknown pricelist "${key}"`);
  return list;
}

// -> { parent, sub, quote, markup? } | { skip } | null (no rule matched)
export function classifyItem(listKey, { name = '', category = '', sheet = '' }) {
  const rule = getList(listKey).rules.find(
    (x) => (!x.cat || x.cat.test(category)) && (!x.sheet || x.sheet.test(sheet)) && (!x.name || x.name.test(name)),
  );
  if (!rule) return null;
  if (rule.skip) return { skip: rule.skip };
  return { parent: rule.parent, sub: rule.sub, quote: Boolean(rule.quote), ...(rule.markup != null && { markup: rule.markup }), ...(rule.insurance != null && { insurance: rule.insurance }) };
}

const rand = (cents) => `R${(cents / 100).toFixed(2)}`;

function findCategory(db, name, parentId) {
  return db
    .prepare(`SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND ${parentId ? 'parent_id = ?' : 'parent_id IS NULL'}`)
    .get(...(parentId ? [name, parentId] : [name]));
}

// Existing categories are reused by name (their settings untouched), so
// running this twice is harmless.
function ensureCategory(db, name, parentId, { quote = false, markup = null, insurance = null } = {}, created) {
  const found = findCategory(db, name, parentId);
  if (found) return found.id;
  const sortOrder = db.prepare(`SELECT COUNT(*) n FROM categories WHERE ${parentId ? 'parent_id = ?' : 'parent_id IS NULL'}`).get(...(parentId ? [parentId] : [])).n;
  created.push(name);
  return saveCategory({ name, parentId, sortOrder, quoteDelivery: quote, markupPct: markup, courierInsurancePct: insurance }, null, db).id;
}

const categoryNotes = (g) => [g.quote && 'delivery quoted', g.markup != null && `${g.markup}% markup`, g.insurance != null && `${g.insurance}% courier insurance`].filter(Boolean).join(', ');

// Categories the run would create, as "Parent › Sub" (or "Parent" when the
// parent itself is missing). Shown in the preview so a near-duplicate of an
// existing category (e.g. "Filament" vs "Filaments") is caught before writing.
function missingCategories(db, groups) {
  const out = new Set();
  for (const g of groups) {
    const parent = findCategory(db, g.parent, null);
    if (!parent) out.add(g.parent);
    if (!parent || !findCategory(db, g.sub, parent.id)) out.add(`${g.parent} › ${g.sub}${categoryNotes(g) ? ` (${categoryNotes(g)})` : ''}`);
  }
  return [...out].sort();
}

// dryRun reports what would happen without creating or listing anything.
export function autoList({ list: listKey, supplierId, dryRun = false } = {}, db = getDb()) {
  const list = getList(listKey);
  if (!supplierId) throw new Error('Choose the supplier first');
  const rows = db
    .prepare(`SELECT f.id, f.code, f.name, f.category, f.source_sheet, f.cost_cents, p.id AS product_id, p.category_id
      FROM feed_items f LEFT JOIN products p ON p.supplier_id = f.supplier_id AND p.supplier_code = f.code
      WHERE f.supplier_id = ? AND f.in_latest_import = 1 AND f.source_file LIKE ?
      ORDER BY f.name`)
    .all(supplierId, list.sourceFile);

  const groups = new Map(); // "Parent › Sub" -> { parent, sub, quote, toList: [], toCategorise: [] }
  const unmatched = [];
  const skipped = new Map(); // reason -> [{ code, name }]
  const heavy = []; // [{ code, name }] -> product marked "delivery quoted"
  let alreadyCategorised = 0;
  for (const r of rows) {
    if (r.product_id && r.category_id) {
      alreadyCategorised++; // an admin's category choice wins
      continue;
    }
    let c = classifyItem(listKey, { name: r.name, category: r.category, sheet: r.source_sheet });
    if (c && !c.skip && (r.cost_cents < MIN_COST_CENTS || r.cost_cents > MAX_COST_CENTS)) c = { skip: `Price looks wrong (${rand(r.cost_cents)})` };
    if (!c) {
      unmatched.push({ code: r.code, name: r.name });
      continue;
    }
    if (c.skip) {
      if (!skipped.has(c.skip)) skipped.set(c.skip, []);
      skipped.get(c.skip).push({ code: r.code, name: r.name });
      continue;
    }
    const key = `${c.parent} › ${c.sub}`;
    if (!groups.has(key)) groups.set(key, { ...c, toList: [], toCategorise: [] });
    const g = groups.get(key);
    r.product_id ? g.toCategorise.push(r.product_id) : g.toList.push(r.id);
    if (list.heavy?.test(r.name)) heavy.push({ code: r.code, name: r.name });
  }

  const summary = [...groups.entries()]
    .map(([category, g]) => ({ category, newListings: g.toList.length, categorised: g.toCategorise.length }))
    .sort((a, b) => a.category.localeCompare(b.category));
  const result = {
    list: list.label,
    itemsFound: rows.length,
    summary,
    newCategories: missingCategories(db, groups.values()),
    skipped: [...skipped.entries()].map(([reason, items]) => ({ reason, items })).sort((a, b) => a.reason.localeCompare(b.reason)),
    unmatched,
    heavy,
    alreadyCategorised,
    categoriesCreated: [],
    created: 0,
    categorised: 0,
    quoted: 0,
    errors: [],
  };
  if (dryRun) return result;

  const run = db.transaction(() => {
    const setCat = db.prepare('UPDATE products SET category_id = ?, updated_at = ? WHERE id = ?');
    // Only products without an admin-set delivery choice (NULL = inherit).
    const setQuote = db.prepare('UPDATE products SET quote_delivery = 1, updated_at = ? WHERE supplier_id = ? AND supplier_code = ? AND quote_delivery IS NULL');
    const ts = new Date().toISOString();
    for (const g of groups.values()) {
      const parentId = ensureCategory(db, g.parent, null, {}, result.categoriesCreated);
      const categoryId = ensureCategory(db, g.sub, parentId, g, result.categoriesCreated);
      if (g.toList.length) {
        const r = listFeedItems({ feedIds: g.toList, categoryId, markupPct: null, active: true }, db);
        result.created += r.created;
        result.errors.push(...r.errors);
      }
      for (const id of g.toCategorise) result.categorised += setCat.run(categoryId, ts, id).changes;
    }
    for (const h of heavy) result.quoted += setQuote.run(ts, supplierId, h.code).changes;
  });
  run();
  return result;
}

// Products listed by hand straight onto a top-level category that now has
// sub-categories (e.g. "Gaming") are invisible from those sub-category
// pages. This moves each one into the sub-category the rules pick -- but only
// when the rule's parent is the product's current parent: an admin's choice
// of parent is kept, and nothing moves across the tree. Sub-categories are
// never created here; a missing one is reported.
export function tidyParentLevel({ supplierId, dryRun = true } = {}, db = getDb()) {
  if (!supplierId) throw new Error('Choose the SMD supplier first');
  const parents = db
    .prepare('SELECT c.id, c.name FROM categories c WHERE c.parent_id IS NULL AND EXISTS (SELECT 1 FROM categories s WHERE s.parent_id = c.id)')
    .all();
  const result = { found: 0, moves: [], otherParent: [], noRule: [], missingSub: [], moved: 0 };
  if (!parents.length) return result;
  const byParent = new Map(parents.map((p) => [p.id, p.name]));
  const seen = new Set();
  const targets = new Map(); // sub id -> { category, ids: [] }

  for (const [listKey, list] of Object.entries(SMD_LISTS)) {
    const rows = db
      .prepare(`SELECT p.id, p.name, p.category_id, f.code, f.name AS feed_name, f.category, f.source_sheet
        FROM products p JOIN feed_items f ON f.supplier_id = p.supplier_id AND f.code = p.supplier_code
        WHERE p.supplier_id = ? AND f.source_file LIKE ? AND p.category_id IN (${parents.map(() => '?').join(',')})
        ORDER BY p.name`)
      .all(supplierId, list.sourceFile, ...parents.map((p) => p.id));
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      result.found++;
      const current = byParent.get(r.category_id);
      const item = { code: r.code, name: r.name, current };
      const c = classifyItem(listKey, { name: r.feed_name, category: r.category, sheet: r.source_sheet });
      if (!c || c.skip) {
        result.noRule.push(item);
        continue;
      }
      if (c.parent.toLowerCase() !== current.toLowerCase()) {
        result.otherParent.push({ ...item, suggested: `${c.parent} › ${c.sub}` });
        continue;
      }
      const sub = findCategory(db, c.sub, r.category_id);
      if (!sub) {
        result.missingSub.push({ ...item, suggested: `${c.parent} › ${c.sub}` });
        continue;
      }
      const key = `${current} › ${c.sub}`;
      if (!targets.has(sub.id)) targets.set(sub.id, { category: key, ids: [] });
      targets.get(sub.id).ids.push(r.id);
    }
  }
  result.moves = [...targets.values()].map((t) => ({ category: t.category, count: t.ids.length })).sort((a, b) => a.category.localeCompare(b.category));
  if (dryRun) return result;
  // set-category also reprices, in case the sub-category carries its own markup.
  const run = db.transaction(() => {
    for (const [subId, t] of targets) result.moved += bulkUpdateProducts({ ids: t.ids, action: 'set-category', value: subId }, db).changes;
  });
  run();
  return result;
}
