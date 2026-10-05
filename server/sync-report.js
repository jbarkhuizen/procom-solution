// What a supplier sync (Esquire / SMD API) changed in the shop, for the report
// email and its Word attachment (owner request 2026-10-05: after every sync,
// counts plus the products that went on special and whose price came down).
//
// snapshotPrices() before the sync, diffPrices() after: comparing the shop's
// own prices catches every cause (cost change, supplier special, reprice).
import { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun, HeadingLevel, WidthType, AlignmentType } from 'docx';
import { getDb } from './db.js';
import { formatRand } from './util.js';

export function snapshotPrices(supplierId, db = getDb()) {
  const rows = db.prepare('SELECT id, price_cents, compare_at_cents, active FROM products WHERE supplier_id = ?').all(supplierId);
  return new Map(rows.map((r) => [r.id, r]));
}

const onSpecial = (r) => Boolean(r && r.compare_at_cents && r.compare_at_cents > r.price_cents);

export function diffPrices(before, supplierId, db = getDb()) {
  const rows = db.prepare('SELECT id, sku, name, price_cents, compare_at_cents, active FROM products WHERE supplier_id = ?').all(supplierId);
  const out = { newSpecials: [], specialsEnded: 0, priceDown: [], priceUp: 0, newlyListed: 0 };
  for (const r of rows) {
    const b = before.get(r.id);
    if (!b) {
      if (r.active) out.newlyListed++;
      continue;
    }
    if (!r.active) continue; // hidden products are counted by the sync itself
    if (onSpecial(r) && !onSpecial(b)) out.newSpecials.push({ sku: r.sku, name: r.name, normalCents: r.compare_at_cents, specialCents: r.price_cents });
    else if (onSpecial(b) && !onSpecial(r)) out.specialsEnded++;
    if (r.price_cents < b.price_cents) out.priceDown.push({ sku: r.sku, name: r.name, fromCents: b.price_cents, toCents: r.price_cents });
    else if (r.price_cents > b.price_cents) out.priceUp++;
  }
  const saving = (x) => (x.normalCents - x.specialCents) / x.normalCents;
  out.newSpecials.sort((a, b) => saving(b) - saving(a));
  out.priceDown.sort((a, b) => (b.fromCents - b.toCents) / b.fromCents - (a.fromCents - a.toCents) / a.fromCents);
  return out;
}

// ------------------------------------------------------------ Word document

const rand = (c) => formatRand(c);
const pct = (from, to) => `${Math.round(((from - to) / from) * 100)}%`;
const MAX_ROWS = 2000; // Word stays usable; the email says when a list is cut

function cell(text, { bold = false, right = false, shade = false } = {}) {
  return new TableCell({
    children: [new Paragraph({ alignment: right ? AlignmentType.RIGHT : AlignmentType.LEFT, children: [new TextRun({ text: String(text ?? ''), bold, size: 18 })] })],
    ...(shade ? { shading: { fill: 'EFE7D8' } } : {}),
  });
}

function table(headers, rows, rightCols = []) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ tableHeader: true, children: headers.map((h, i) => cell(h, { bold: true, shade: true, right: rightCols.includes(i) })) }),
      ...rows.map((r) => new TableRow({ children: r.map((v, i) => cell(v, { right: rightCols.includes(i) })) })),
    ],
  });
}

const para = (text, opts = {}) => new Paragraph({ children: [new TextRun({ text, size: 20, ...opts })], spacing: { after: 120 } });

// summaryRows: [[label, value], ...] -- the same figures as the email.
export async function buildSyncReportDocx({ supplierLabel, startedAt, ok, error, summaryRows = [], changes = null }) {
  const when = new Date(startedAt).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'long', timeStyle: 'short' });
  const children = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: `${supplierLabel} update` })] }),
    para(`Procom Solutions · ${when} (South African time)`, { color: '7A6E64' }),
  ];
  if (!ok) {
    children.push(para(`The sync did not complete: ${error}`, { bold: true, color: 'C24B28' }), para('Nothing in the shop was changed by this run. The next scheduled run will try again.'));
  }
  children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Overview')] }));
  children.push(table(['', 'Count'], summaryRows.map(([k, v]) => [k, v]), [1]));

  if (changes) {
    const specials = changes.newSpecials.slice(0, MAX_ROWS);
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(`Went on special (${changes.newSpecials.length})`)] }));
    children.push(specials.length
      ? table(['SKU', 'Product', 'Normal price', 'Special price', 'Saving'], specials.map((x) => [x.sku, x.name, rand(x.normalCents), rand(x.specialCents), pct(x.normalCents, x.specialCents)]), [2, 3, 4])
      : para('No products went on special in this run.'));
    if (changes.newSpecials.length > MAX_ROWS) children.push(para(`… and ${changes.newSpecials.length - MAX_ROWS} more.`));

    const down = changes.priceDown.slice(0, MAX_ROWS);
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(`Price reduced (${changes.priceDown.length})`)] }));
    children.push(down.length
      ? table(['SKU', 'Product', 'Was', 'Now', 'Down'], down.map((x) => [x.sku, x.name, rand(x.fromCents), rand(x.toCents), pct(x.fromCents, x.toCents)]), [2, 3, 4])
      : para('No shop prices came down in this run.'));
    if (changes.priceDown.length > MAX_ROWS) children.push(para(`… and ${changes.priceDown.length - MAX_ROWS} more.`));
  }
  const doc = new Document({ creator: 'Procom Solutions', title: `${supplierLabel} update`, sections: [{ children }] });
  return Packer.toBuffer(doc);
}

export function reportFileName(supplierLabel, startedAt) {
  const t = new Date(Date.parse(startedAt) + 2 * 3600_000).toISOString(); // SAST
  return `${supplierLabel.replace(/\W+/g, '-')}-update-${t.slice(0, 10)}-${t.slice(11, 13)}${t.slice(14, 16)}.docx`;
}

// ------------------------------------------------------------ once-a-day email

// Several runs of one supplier -> one set of lists: specials/price drops from
// every run, one row per product (first "was" price, last "now" price).
export function mergeChanges(list) {
  const specials = new Map();
  const down = new Map();
  const out = { newSpecials: [], priceDown: [], priceUp: 0, specialsEnded: 0, newlyListed: 0 };
  for (const c of list.filter(Boolean)) {
    for (const x of c.newSpecials) specials.set(x.sku, x);
    for (const x of c.priceDown) down.set(x.sku, down.has(x.sku) ? { ...x, fromCents: down.get(x.sku).fromCents } : x);
    out.priceUp += c.priceUp;
    out.specialsEnded += c.specialsEnded;
    out.newlyListed += c.newlyListed;
  }
  const saving = (x) => (x.normalCents - x.specialCents) / x.normalCents;
  out.newSpecials = [...specials.values()].sort((a, b) => saving(b) - saving(a));
  out.priceDown = [...down.values()].filter((x) => x.toCents < x.fromCents).sort((a, b) => (b.fromCents - b.toCents) / b.fromCents - (a.fromCents - a.toCents) / a.fromCents);
  return out;
}

const sastTime = (iso) => new Date(iso).toLocaleTimeString('en-ZA', { timeZone: 'Africa/Johannesburg', hour: '2-digit', minute: '2-digit', hour12: false });

// sections: [{ supplier, runs: [{ startedAt, ok, error, summaryRows }], changes }]
export async function buildDigestDocx({ dateLabel, sections }) {
  const children = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: 'Supplier updates' })] }),
    para(`Procom Solutions · ${dateLabel} · all Esquire and SMD updates of the day`, { color: '7A6E64' }),
  ];
  for (const sec of sections) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(sec.supplier)] }));
    const times = sec.runs.map((r) => sastTime(r.startedAt));
    for (const r of sec.runs.filter((x) => !x.ok)) children.push(para(`${sastTime(r.startedAt)} update did not complete: ${r.error}`, { bold: true, color: 'C24B28' }));
    const labels = [];
    for (const r of sec.runs) for (const [k] of r.summaryRows || []) if (!labels.includes(k)) labels.push(k);
    if (labels.length) {
      children.push(table(['', ...times], labels.map((k) => [k, ...sec.runs.map((r) => (r.summaryRows || []).find(([l]) => l === k)?.[1] ?? '—')]), times.map((_, i) => i + 1)));
    }
    const c = sec.changes;
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(`Went on special (${c.newSpecials.length})`)] }));
    children.push(c.newSpecials.length
      ? table(['SKU', 'Product', 'Normal price', 'Special price', 'Saving'], c.newSpecials.slice(0, MAX_ROWS).map((x) => [x.sku, x.name, rand(x.normalCents), rand(x.specialCents), pct(x.normalCents, x.specialCents)]), [2, 3, 4])
      : para('No products went on special today.'));
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(`Price reduced (${c.priceDown.length})`)] }));
    children.push(c.priceDown.length
      ? table(['SKU', 'Product', 'Was', 'Now', 'Down'], c.priceDown.slice(0, MAX_ROWS).map((x) => [x.sku, x.name, rand(x.fromCents), rand(x.toCents), pct(x.fromCents, x.toCents)]), [2, 3, 4])
      : para('No shop prices came down today.'));
  }
  const doc = new Document({ creator: 'Procom Solutions', title: 'Supplier updates', sections: [{ children }] });
  return Packer.toBuffer(doc);
}
