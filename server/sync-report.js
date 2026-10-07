// What a supplier sync (Esquire / SMD API) changed in the shop, for the report
// email and its Word attachment (owner request 2026-10-05: after every sync,
// counts plus the products that went on special and whose price came down;
// 2026-10-06: the Word file is the full record -- every changed product, what
// needs attention, change since the last run -- and the email stays short).
//
// snapshotPrices() before the sync, diffPrices() after: comparing the shop's
// own rows catches every cause (cost change, supplier special, reprice, stock).
import { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun, HeadingLevel, WidthType, AlignmentType, ExternalHyperlink, ShadingType } from 'docx';
import { getDb } from './db.js';
import { formatRand } from './util.js';

// Owner levels (2026-10-06) for "Needs your attention".
export const ATTENTION = { dropPct: 50, risePct: 15, soldDays: 30 };

export function snapshotPrices(supplierId, db = getDb()) {
  const rows = db.prepare('SELECT id, price_cents, cost_cents, compare_at_cents, active, supplier_in_stock, supplier_stock_qty FROM products WHERE supplier_id = ?').all(supplierId);
  return new Map(rows.map((r) => [r.id, r]));
}

const onSpecial = (r) => Boolean(r && r.compare_at_cents && r.compare_at_cents > r.price_cents);

export function diffPrices(before, supplierId, db = getDb()) {
  const rows = db.prepare('SELECT id, sku, name, slug, category_id, price_cents, cost_cents, compare_at_cents, active, supplier_in_stock, supplier_stock_qty FROM products WHERE supplier_id = ?').all(supplierId);
  const cats = new Map(db.prepare('SELECT id, name FROM categories').all().map((c) => [c.id, c.name]));
  let sold = null; // product id -> units sold (paid orders, last N days); only read when something goes out of stock / hidden
  const sold30 = (id) => {
    if (!sold) {
      const since = new Date(Date.now() - ATTENTION.soldDays * 86400_000).toISOString();
      sold = new Map(db.prepare("SELECT oi.product_id id, SUM(oi.quantity) n FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.payment_status = 'paid' AND o.paid_at >= ? GROUP BY oi.product_id").all(since).map((x) => [x.id, x.n]));
    }
    return sold.get(id) || 0;
  };
  const out = { newSpecials: [], specialsEnded: 0, priceDown: [], priceUp: 0, newlyListed: 0, priceUpList: [], specialsEndedList: [], outOfStock: [], backInStock: [], hidden: [], shown: [], newProducts: [] };
  for (const r of rows) {
    const b = before.get(r.id);
    const base = { sku: r.sku, name: r.name, slug: r.slug, id: r.id, category: cats.get(r.category_id) || 'No category' };
    if (!b) {
      if (r.active) {
        out.newlyListed++;
        out.newProducts.push({ ...base, priceCents: r.price_cents });
      }
      continue;
    }
    if (b.active && !r.active) out.hidden.push({ ...base, sold30: sold30(r.id) });
    else if (!b.active && r.active) out.shown.push(base);
    if (!r.active) continue; // hidden products are counted by the sync itself
    const wasSpecial = onSpecial(b);
    if (onSpecial(r) && !wasSpecial) out.newSpecials.push({ ...base, normalCents: r.compare_at_cents, specialCents: r.price_cents });
    else if (wasSpecial && !onSpecial(r)) {
      out.specialsEnded++;
      out.specialsEndedList.push({ ...base, fromCents: b.price_cents, toCents: r.price_cents });
    }
    if (r.price_cents < b.price_cents) out.priceDown.push({ ...base, fromCents: b.price_cents, toCents: r.price_cents, costFromCents: b.cost_cents, costToCents: r.cost_cents });
    else if (r.price_cents > b.price_cents) {
      out.priceUp++;
      out.priceUpList.push({ ...base, fromCents: b.price_cents, toCents: r.price_cents, specialEnded: wasSpecial && !onSpecial(r) });
    }
    if (b.active && b.supplier_in_stock && !r.supplier_in_stock) out.outOfStock.push({ ...base, qty: b.supplier_stock_qty, sold30: sold30(r.id) });
    else if (b.active && !b.supplier_in_stock && r.supplier_in_stock) out.backInStock.push({ ...base, qty: r.supplier_stock_qty });
  }
  sortChanges(out);
  return out;
}

const saving = (x) => (x.normalCents - x.specialCents) / x.normalCents;
const drop = (x) => (x.fromCents - x.toCents) / x.fromCents;
const rise = (x) => (x.toCents - x.fromCents) / x.fromCents;
function sortChanges(out) {
  out.newSpecials.sort((a, b) => saving(b) - saving(a));
  out.priceDown.sort((a, b) => drop(b) - drop(a));
  out.priceUpList.sort((a, b) => rise(b) - rise(a));
  out.outOfStock.sort((a, b) => b.sold30 - a.sold30);
  out.hidden.sort((a, b) => b.sold30 - a.sold30);
}

// ------------------------------------------------------------ needs attention

// [{ level: 'red' | 'amber', text, examples: [names] }]
// `extra` = supplier-specific warnings from the sync itself ([{ level, text }]).
export function buildAttention(changes, extra = []) {
  const items = [];
  const plural = (n, one, many) => (n === 1 ? one : many);
  if (changes) {
    const bigDrops = (changes.priceDown || []).filter((x) => drop(x) * 100 > ATTENTION.dropPct);
    if (bigDrops.length) items.push({ level: 'red', text: `${bigDrops.length} shop ${plural(bigDrops.length, 'price', 'prices')} dropped by more than ${ATTENTION.dropPct}%. Check ${plural(bigDrops.length, 'it is', 'they are')} a real supplier price and not an error.`, examples: bigDrops.slice(0, 3).map((x) => `${x.name} (${x.sku}): ${formatRand(x.fromCents)} → ${formatRand(x.toCents)}`) });
    const bigRises = (changes.priceUpList || []).filter((x) => !x.specialEnded && rise(x) * 100 > ATTENTION.risePct);
    if (bigRises.length) items.push({ level: 'amber', text: `${bigRises.length} shop ${plural(bigRises.length, 'price', 'prices')} rose by more than ${ATTENTION.risePct}% (not because a special ended). Check ${plural(bigRises.length, 'it is', 'they are')} still competitive.`, examples: bigRises.slice(0, 3).map((x) => `${x.name} (${x.sku}): ${formatRand(x.fromCents)} → ${formatRand(x.toCents)}`) });
    const hiddenSold = (changes.hidden || []).filter((x) => x.sold30 > 0);
    if (hiddenSold.length) items.push({ level: 'red', text: `${hiddenSold.length} hidden ${plural(hiddenSold.length, 'product', 'products')} sold in the last ${ATTENTION.soldDays} days. The supplier may have dropped ${plural(hiddenSold.length, 'it', 'them')} by mistake.`, examples: hiddenSold.slice(0, 3).map((x) => `${x.name} (${x.sku}): ${x.sold30} sold`) });
    const outSold = (changes.outOfStock || []).filter((x) => x.sold30 > 0);
    if (outSold.length) items.push({ level: 'amber', text: `${outSold.length} ${plural(outSold.length, 'product', 'products')} that sold in the last ${ATTENTION.soldDays} days went out of stock.`, examples: outSold.slice(0, 3).map((x) => `${x.name} (${x.sku}): ${x.sold30} sold`) });
    const ups = changes.priceUpList || [];
    if (ups.length >= 20) {
      const avg = Math.round((ups.reduce((n, x) => n + rise(x), 0) / ups.length) * 100);
      const ended = ups.filter((x) => x.specialEnded).length;
      items.push({ level: 'amber', text: `${ups.length} shop prices went up (average +${avg}%)${ended ? `, ${ended} of them only because a supplier special ended` : ''}.` });
    }
  }
  return [...items, ...extra];
}

// ------------------------------------------------------------ Word document

const rand = (c) => formatRand(c);
const pct = (from, to) => `${Math.round(((from - to) / from) * 100)}%`;
const signed = (from, to) => `${to >= from ? '+' : '−'}${Math.round((Math.abs(to - from) / from) * 100)}% (${to >= from ? '+' : '−'}${rand(Math.abs(to - from))})`;
const MAX_ROWS = 2000; // Word stays usable; the section says when a list is cut
const COLOR = { red: 'C24B28', green: '2E7D32', amber: 'B7791F', grey: '7A6E64', link: '1F5FA8' };
const FILL = { red: 'FBE9E4', amber: 'FFF4D6', green: 'E6F4EA', head: 'EFE7D8' };
const baseUrl = () => (process.env.SITE_URL || 'https://www.procomsolutions.co.za').replace(/\/$/, '');

const run = (text, o = {}) => new TextRun({ text: String(text ?? ''), size: 18, ...o });
const link = (text, url) => new ExternalHyperlink({ link: url, children: [run(text, { color: COLOR.link, underline: {} })] });

function cell(content, { bold = false, right = false, fill = null, color = null, span = 1, width = null } = {}) {
  const kids = Array.isArray(content) ? content : [run(content, { bold, ...(color ? { color } : {}) })];
  return new TableCell({
    children: [new Paragraph({ alignment: right ? AlignmentType.RIGHT : AlignmentType.LEFT, children: kids })],
    columnSpan: span,
    ...(width ? { width: { size: width, type: WidthType.PERCENTAGE } } : {}),
    ...(fill ? { shading: { type: ShadingType.CLEAR, fill, color: 'auto' } } : {}),
  });
}

// columns: [{ h, right?, w? }]; rows: [[value | TextRun[] | { text, color }]]
// groups: [{ title, rows }] puts a shaded category band above each group.
function table(columns, rows, { groups = null } = {}) {
  const cells = (r) => r.map((v, i) => (v && typeof v === 'object' && !Array.isArray(v) ? cell(v.text, { right: columns[i].right, color: v.color, bold: v.bold, width: columns[i].w }) : cell(v, { right: columns[i].right, width: columns[i].w })));
  const body = groups
    ? groups.flatMap((g) => [new TableRow({ children: [cell(`${g.title} (${g.rows.length})`, { bold: true, fill: FILL.head, span: columns.length })] }), ...g.rows.map((r) => new TableRow({ children: cells(r) }))])
    : rows.map((r) => new TableRow({ children: cells(r) }));
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({ tableHeader: true, children: columns.map((c) => cell(c.h, { bold: true, fill: FILL.head, right: c.right, width: c.w })) }), ...body],
  });
}

const para = (text, opts = {}) => new Paragraph({ children: [new TextRun({ text, size: 20, ...opts })], spacing: { after: 120 } });
const h1 = (text) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(text)] });
const h2 = (text) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(text)] });
const gap = () => new Paragraph({ children: [] });

// Item rows grouped by shop category (largest change first inside a category).
function listTable(columns, items, rowFn) {
  const shown = items.slice(0, MAX_ROWS);
  const cats = [...new Set(shown.map((x) => x.category))].sort((a, b) => a.localeCompare(b));
  const out = [table(columns, shown.map(rowFn), cats.length > 1 ? { groups: cats.map((c) => ({ title: c, rows: shown.filter((x) => x.category === c).map(rowFn) })) } : {})];
  if (items.length > MAX_ROWS) out.push(para(`… and ${items.length - MAX_ROWS} more.`));
  return out;
}

// SKU opens the product in admin; the name opens it in the shop.
const skuCell = (x) => [link(x.sku, `${baseUrl()}/admin/#/products/${x.id}`)];
const nameCell = (x) => [x.slug ? link(x.name, `${baseUrl()}/product.html?p=${encodeURIComponent(x.slug)}`) : run(x.name)];

function section(children, title, items, intro, tableFn, none) {
  children.push(h2(`${title} (${items.length})`));
  if (!items.length) return children.push(para(none, { color: COLOR.grey }));
  if (intro) children.push(para(intro, { color: COLOR.grey }));
  children.push(...tableFn());
}

// The change lists, shared by one run's document and the daily one.
function detailSections(changes, startNo) {
  const c = { newSpecials: [], priceDown: [], outOfStock: [], backInStock: [], hidden: [], shown: [], newProducts: [], ...changes }; // runs recorded before 2026-10-06 lack some lists
  const out = [];
  let n = startNo;
  const num = (t) => `${n++}. ${t}`;
  const avg = (list, f) => Math.round((list.reduce((t, x) => t + f(x), 0) / (list.length || 1)) * 100);
  const downCols = [{ h: 'SKU', w: 14 }, { h: 'Product', w: 40 }, { h: 'Was', right: true, w: 14 }, { h: 'Now', right: true, w: 14 }, { h: 'Change', right: true, w: 18 }];

  out.push(h1(num('Price changes')));
  const down = c.priceDown;
  section(out, 'Prices that went down', down, down.length ? `Average −${avg(down, drop)}%. Grouped by shop category.` : '', () => listTable(downCols, down, (x) => [skuCell(x), nameCell(x), rand(x.fromCents), rand(x.toCents), { text: signed(x.fromCents, x.toCents), color: COLOR.green }]), 'No shop prices came down.');
  const ups = c.priceUpList || [];
  const endedN = ups.filter((x) => x.specialEnded).length;
  if (ups.length) section(out, 'Prices that went up', ups, `Average +${avg(ups, rise)}%.${endedN ? ` ${endedN} of these went up only because a supplier special ended (marked “special ended”).` : ''}`, () => listTable(downCols, ups, (x) => [skuCell(x), nameCell(x), rand(x.fromCents), rand(x.toCents), { text: signed(x.fromCents, x.toCents) + (x.specialEnded ? ' · special ended' : ''), color: rise(x) * 100 > ATTENTION.risePct && !x.specialEnded ? COLOR.red : COLOR.amber }]), '');
  else out.push(h2(`Prices that went up (${c.priceUp || 0})`), para(c.priceUp ? 'The list of these is not available for this run.' : 'No shop prices went up.', { color: COLOR.grey }));

  out.push(h1(num('Specials')));
  section(out, 'Went on special', c.newSpecials, '', () => listTable([{ h: 'SKU', w: 14 }, { h: 'Product', w: 40 }, { h: 'Normal price', right: true, w: 15 }, { h: 'Special price', right: true, w: 15 }, { h: 'Saving', right: true, w: 16 }], c.newSpecials, (x) => [skuCell(x), nameCell(x), rand(x.normalCents), rand(x.specialCents), { text: pct(x.normalCents, x.specialCents), color: COLOR.green }]), 'No products went on special.');
  const ended = c.specialsEndedList || [];
  if (ended.length) section(out, 'Specials that ended', ended, 'The shop price went back to the normal price.', () => listTable([{ h: 'SKU', w: 14 }, { h: 'Product', w: 46 }, { h: 'Special was', right: true, w: 20 }, { h: 'Back to', right: true, w: 20 }], ended, (x) => [skuCell(x), nameCell(x), rand(x.fromCents), rand(x.toCents)]), '');
  else out.push(h2(`Specials that ended (${c.specialsEnded || 0})`), para(c.specialsEnded ? 'The list of these is not available for this run.' : 'No specials ended.', { color: COLOR.grey }));

  out.push(h1(num('Stock')));
  const flip = new Set((c.unstable || []).map((x) => x.sku));
  const flipNote = (x) => (flip.has(x.sku) ? ' · flipped more than once' : '');
  section(out, 'Went out of stock', c.outOfStock, 'Products that sold recently are listed first inside each category.', () => listTable([{ h: 'SKU', w: 14 }, { h: 'Product', w: 44 }, { h: 'Was in stock', right: true, w: 14 }, { h: `Sold, last ${ATTENTION.soldDays} days`, right: true, w: 16 }], c.outOfStock, (x) => [skuCell(x), nameCell(x), x.qty == null ? '—' : x.qty, { text: `${x.sold30 || 0}${flipNote(x)}`, color: x.sold30 ? COLOR.red : null }]), 'Nothing went out of stock.');
  section(out, 'Back in stock', c.backInStock, '', () => listTable([{ h: 'SKU', w: 14 }, { h: 'Product', w: 58 }, { h: 'In stock now', right: true, w: 14 }], c.backInStock, (x) => [skuCell(x), nameCell(x), { text: `${x.qty == null ? '—' : x.qty}${flipNote(x)}`, color: COLOR.green }]), 'Nothing came back in stock.');

  out.push(h1(num('Listing changes')));
  section(out, 'Hidden from the shop', c.hidden, 'The supplier no longer sends these, so they stay hidden until they return.', () => listTable([{ h: 'SKU', w: 14 }, { h: 'Product', w: 56 }, { h: `Sold, last ${ATTENTION.soldDays} days`, right: true, w: 16 }], c.hidden, (x) => [skuCell(x), nameCell(x), { text: x.sold30 || 0, color: x.sold30 ? COLOR.red : null }]), 'Nothing was hidden.');
  section(out, 'Shown again', c.shown, 'Back in the supplier’s list.', () => listTable([{ h: 'SKU', w: 14 }, { h: 'Product', w: 72 }], c.shown, (x) => [skuCell(x), nameCell(x)]), 'Nothing was shown again.');
  section(out, 'New products listed', c.newProducts, '', () => listTable([{ h: 'SKU', w: 14 }, { h: 'Product', w: 58 }, { h: 'Shop price', right: true, w: 14 }], c.newProducts, (x) => [skuCell(x), nameCell(x), rand(x.priceCents)]), 'No new products were listed.');
  return { children: out, next: n };
}

function attentionBox(items) {
  const rows = items.length
    ? items.map((i) => new TableRow({ children: [cell([run(`${i.level === 'red' ? '■ ' : '▲ '}${i.text}`, { bold: true, color: COLOR[i.level] }), ...(i.examples || []).flatMap((e) => [run('', { break: 1 }), run(`   ${e}`, { color: COLOR.grey })])], { fill: FILL[i.level] })] }))
    : [new TableRow({ children: [cell([run('✔ Nothing needs your attention in this run.', { bold: true, color: COLOR.green })], { fill: FILL.green })] })];
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows });
}

// summaryRows / previousRows: [[label, value], ...] (previousRows = the last successful run of this supplier).
// details: [[label, value]] -- section "Run details". notListed: [[category, count]] -- supplier products not in the shop yet.
export async function buildSyncReportDocx({ supplierLabel, startedAt, ok, error, summaryRows = [], previousRows = null, changes = null, attention = [], details = [], notListed = [], seconds = null }) {
  const when = new Date(startedAt).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'long', timeStyle: 'short' });
  const children = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: `${supplierLabel} update` })] }),
    para(`Procom Solutions · ${when} (South African time)${seconds != null ? ` · took ${seconds}s` : ''}${ok ? ' · all OK' : ''}`, { color: COLOR.grey }),
  ];
  if (!ok) {
    children.push(para(`The sync did not complete: ${error}`, { bold: true, color: COLOR.red }), para('Nothing in the shop was changed by this run. The next scheduled run will try again.'));
  }
  if (ok) children.push(h1('1. Needs your attention'), attentionBox(buildAttention(changes, attention)), gap());
  children.push(h1(ok ? '2. Summary' : 'Summary'));
  const prev = new Map((previousRows || []).map(([k, v]) => [k, v]));
  children.push(previousRows
    ? table([{ h: '' }, { h: 'This run', right: true }, { h: 'Last run', right: true }], summaryRows.map(([k, v]) => [k, v, prev.has(k) ? prev.get(k) : '—']))
    : table([{ h: '' }, { h: 'Count', right: true }], summaryRows.map(([k, v]) => [k, v])));

  let next = 3;
  if (changes) {
    const d = detailSections(changes, next);
    children.push(...d.children);
    next = d.next;
  }
  if (ok && notListed.length) {
    children.push(h1(`${next++}. Supplier products not in the shop yet`), para(`${notListed.reduce((t, [, n]) => t + n, 0)} products, by supplier category. They are waiting in Admin → Warehouse feed.`, { color: COLOR.grey }), table([{ h: 'Category' }, { h: 'Products', right: true }], notListed.map(([k, v]) => [k, v])));
  }
  if (ok && details.length) children.push(h1(`${next++}. Run details`), table([{ h: '' }, { h: '', right: true }], details));
  const doc = new Document({ creator: 'Procom Solutions', title: `${supplierLabel} update`, sections: [{ children }] });
  return Packer.toBuffer(doc);
}

export function reportFileName(supplierLabel, startedAt) {
  const t = new Date(Date.parse(startedAt) + 2 * 3600_000).toISOString(); // SAST
  return `${supplierLabel.replace(/\W+/g, '-')}-update-${t.slice(0, 10)}-${t.slice(11, 13)}${t.slice(14, 16)}.docx`;
}

// ------------------------------------------------------------ once-a-day email

const LISTS = ['newSpecials', 'priceDown', 'priceUpList', 'specialsEndedList', 'outOfStock', 'backInStock', 'hidden', 'shown', 'newProducts'];

// Several runs of one supplier -> one set of lists: one row per product (first
// "was" price, last "now" price). A product that went out of stock and came back
// (or the other way round) during the day is listed in both and marked unstable.
export function mergeChanges(list) {
  const maps = Object.fromEntries(LISTS.map((k) => [k, new Map()]));
  const out = { newSpecials: [], priceDown: [], priceUp: 0, specialsEnded: 0, newlyListed: 0, priceUpList: [], specialsEndedList: [], outOfStock: [], backInStock: [], hidden: [], shown: [], newProducts: [], unstable: [] };
  let sawLists = false;
  for (const c of list.filter(Boolean)) {
    for (const k of LISTS) {
      for (const x of c[k] || []) {
        const prev = maps[k].get(x.sku);
        maps[k].set(x.sku, prev && x.fromCents != null ? { ...x, fromCents: prev.fromCents } : x);
      }
    }
    if (c.priceUpList) sawLists = true;
    out.priceUp += c.priceUp;
    out.specialsEnded += c.specialsEnded;
    out.newlyListed += c.newlyListed;
  }
  for (const k of LISTS) out[k] = [...maps[k].values()];
  out.priceDown = out.priceDown.filter((x) => x.toCents < x.fromCents);
  out.priceUpList = out.priceUpList.filter((x) => x.toCents > x.fromCents);
  // A price that went down in the morning and up again later nets out of both lists.
  const upSku = new Set(out.priceUpList.map((x) => x.sku));
  const downSku = new Set(out.priceDown.map((x) => x.sku));
  out.priceDown = out.priceDown.filter((x) => !upSku.has(x.sku));
  out.priceUpList = out.priceUpList.filter((x) => !downSku.has(x.sku));
  if (sawLists) out.priceUp = out.priceUpList.length;
  const back = new Set(out.backInStock.map((x) => x.sku));
  out.unstable = out.outOfStock.filter((x) => back.has(x.sku)).map(({ sku, name }) => ({ sku, name }));
  sortChanges(out);
  return out;
}

const sastTime = (iso) => new Date(iso).toLocaleTimeString('en-ZA', { timeZone: 'Africa/Johannesburg', hour: '2-digit', minute: '2-digit', hour12: false });

// sections: [{ supplier, runs: [{ startedAt, ok, error, summaryRows }], changes }]
export async function buildDigestDocx({ dateLabel, sections }) {
  const children = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: 'Supplier updates' })] }),
    para(`Procom Solutions · ${dateLabel} · all Esquire and SMD updates of the day`, { color: COLOR.grey }),
  ];
  for (const sec of sections) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(sec.supplier)] }));
    const times = sec.runs.map((r) => sastTime(r.startedAt));
    for (const r of sec.runs.filter((x) => !x.ok)) children.push(para(`${sastTime(r.startedAt)} update did not complete: ${r.error}`, { bold: true, color: COLOR.red }));
    children.push(h2('Needs your attention'), attentionBox(buildAttention(sec.changes)), gap());
    const labels = [];
    for (const r of sec.runs) for (const [k] of r.summaryRows || []) if (!labels.includes(k)) labels.push(k);
    if (labels.length) {
      children.push(h2('Each update of the day'), table([{ h: '' }, ...times.map((t) => ({ h: t, right: true }))], labels.map((k) => [k, ...sec.runs.map((r) => (r.summaryRows || []).find(([l]) => l === k)?.[1] ?? '—')])));
    }
    children.push(...detailSections(sec.changes, 1).children);
  }
  const doc = new Document({ creator: 'Procom Solutions', title: 'Supplier updates', sections: [{ children }] });
  return Packer.toBuffer(doc);
}
