import ExcelJS from 'exceljs';
import { parse as parseCsv } from 'csv-parse/sync';
import { XMLParser } from 'fast-xml-parser';

// Every supplier format is converted to the same shape:
//   { format, tables: [{ name, headers: string[], rows: string[][], images: Map<rowIndex, Buffer> }], warnings }
// Column mapping, preview and import then work identically for all formats.

export const FIELDS = ['code', 'name', 'brand', 'category', 'cost', 'image', 'moq'];

// Normalised header text -> field. Exact matches win over "contains" matches.
const ALIASES = {
  code: ['product code', 'code', 'sku', 'item code', 'stock code', 'part number', 'part no', 'product id', 'item number', 'model', 'model number', 'barcode'],
  name: ['name', 'description', 'product name', 'title', 'item name', 'product description', 'product', 'item description'],
  brand: ['brand', 'manufacturer', 'make', 'vendor', 'brand name'],
  category: ['category', 'group', 'product type', 'type', 'department', 'product category', 'category name'],
  // Order = priority: true cost columns first; retail/RRP only as a last resort
  // (the preview shows what matched, and the admin can change it).
  cost: ['cost excl vat', 'cost ex vat', 'cost', 'price excl vat', 'price ex vat', 'dealer price', 'price', 'unit price', 'wholesale price', 'cost price', 'your price', 'nett price', 'net price', 'price incl vat', 'selling price', 'retail price', 'retail', 'rrp'],
  image: ['image', 'image url', 'picture', 'pictures', 'photo', 'image link', 'img', 'image src', 'thumbnail', 'main image'],
  moq: ['moq', 'min order qty', 'minimum order quantity', 'min qty', 'pack size', 'minimum quantity'],
};

export function normHeader(h) {
  return String(h ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Best column for each field. Returns { field: headerText }.
export function guessMapping(headers) {
  const norm = headers.map(normHeader);
  const used = new Set();
  const mapping = {};
  for (const pass of ['exact', 'contains']) {
    for (const field of FIELDS) {
      if (mapping[field]) continue;
      for (const alias of ALIASES[field]) {
        const idx = norm.findIndex((h, i) => !used.has(i) && h && (pass === 'exact' ? h === alias : h.includes(alias)));
        if (idx >= 0) {
          mapping[field] = headers[idx];
          used.add(idx);
          break;
        }
      }
    }
  }
  return mapping;
}

function headerScore(cells) {
  const m = guessMapping(cells.map((c) => String(c ?? '')));
  return (m.code ? 2 : 0) + (m.name ? 2 : 0) + (m.cost ? 2 : 0) + (m.brand ? 1 : 0) + (m.category ? 1 : 0);
}

// Picks the header row within the first rows of a grid (some sheets have titles above).
function tableFromGrid(name, grid, images = new Map()) {
  let headerRow = 0;
  let best = -1;
  for (let r = 0; r < Math.min(grid.length, 12); r++) {
    const s = headerScore(grid[r] || []);
    if (s > best) {
      best = s;
      headerRow = r;
    }
  }
  const headers = (grid[headerRow] || []).map((h, i) => String(h ?? '').trim() || `Column ${i + 1}`);
  const rows = [];
  const rowImages = new Map();
  for (let r = headerRow + 1; r < grid.length; r++) {
    const row = grid[r] || [];
    if (!row.some((c) => String(c ?? '').trim())) continue;
    if (images.has(r)) rowImages.set(rows.length, images.get(r));
    rows.push(headers.map((_, i) => String(row[i] ?? '').trim()));
  }
  return { name, headers, rows, images: rowImages, headerScore: best };
}

// ---------------------------------------------------------------------- XLSX

function cellText(cell) {
  const v = cell?.value;
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.result != null) return String(v.result);
    if (v.text != null) return String(v.text);
    if (v.hyperlink) return String(v.hyperlink);
    return '';
  }
  return String(v);
}

async function parseXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const tables = [];
  for (const ws of wb.worksheets) {
    const grid = [];
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const cells = [];
      for (let c = 1; c <= ws.columnCount; c++) cells.push(cellText(row.getCell(c)));
      grid.push(cells);
    }
    // Embedded photos anchored in a row (grid index = 0-based row).
    const images = new Map();
    for (const img of ws.getImages()) {
      const tl = img.range?.tl;
      if (!tl) continue;
      const row = Math.floor(tl.nativeRow ?? tl.row ?? 0);
      const media = wb.getImage(Number(img.imageId));
      if (media?.buffer && !images.has(row)) images.set(row, media.buffer);
    }
    const t = tableFromGrid(ws.name, grid, images);
    if (t.rows.length) tables.push(t);
  }
  // Workbooks often carry cover/index sheets. If some sheets clearly are
  // product lists (code + name + price headings), keep only those.
  const productSheets = tables.filter((t) => t.headerScore >= 6);
  return { tables: productSheets.length ? productSheets : tables };
}

// ----------------------------------------------------------------------- CSV

function parseCsvBuffer(buffer) {
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  // Sniff across several lines: exports often start with a title line that has no separators.
  const sample = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 10);
  const delimiter = [',', ';', '\t', '|']
    .map((d) => [d, sample.reduce((n, l) => n + l.split(d).length - 1, 0)])
    .sort((a, b) => b[1] - a[1])[0][0];
  const grid = parseCsv(text, { delimiter, relax_column_count: true, relax_quotes: true, skip_empty_lines: true, trim: true });
  return { tables: [tableFromGrid('CSV', grid)] };
}

// ----------------------------------------------------------- JSON / XML records

// Flattens one record to { "key": "value" } (nested objects become "a.b").
function flattenRecord(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v == null) out[key] = '';
    else if (Array.isArray(v)) {
      const first = v.find((x) => x != null);
      if (first && typeof first === 'object') flattenRecord(first['#text'] != null ? { [k]: first['#text'] } : first, prefix ? key : k, out);
      else out[key] = v.filter((x) => x != null).join(', ');
    } else if (typeof v === 'object') {
      if (v['#text'] != null && Object.keys(v).length <= 2) out[key] = String(v['#text']);
      else flattenRecord(v, key, out);
    } else out[key] = String(v);
  }
  return out;
}

// The record list is the largest array of objects anywhere in the document.
function findRecords(node, best = { arr: null, path: '' }, path = '') {
  if (Array.isArray(node)) {
    const objs = node.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
    if (objs.length && objs.length > (best.arr?.length || 0)) {
      best.arr = objs;
      best.path = path;
    }
    node.forEach((x) => findRecords(x, best, path));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) findRecords(v, best, path ? `${path}.${k}` : k);
  }
  return best;
}

function tableFromRecords(name, records) {
  const flat = records.map((r) => flattenRecord(r));
  const headers = [];
  for (const r of flat) for (const k of Object.keys(r)) if (!headers.includes(k)) headers.push(k);
  return { name, headers, rows: flat.map((r) => headers.map((h) => String(r[h] ?? '').trim())), images: new Map() };
}

function parseJsonBuffer(buffer) {
  let doc;
  try {
    doc = JSON.parse(buffer.toString('utf8').replace(/^﻿/, ''));
  } catch (err) {
    throw new Error(`Not valid JSON: ${err.message}`);
  }
  const { arr, path } = findRecords(doc);
  if (!arr) throw new Error('No list of products found in the JSON file');
  return { tables: [tableFromRecords(path || 'JSON', arr)] };
}

function parseXmlBuffer(buffer) {
  // fast-xml-parser never fetches external entities/DTDs (no XXE).
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', textNodeName: '#text', parseTagValue: false, trimValues: true });
  let doc;
  try {
    doc = parser.parse(buffer.toString('utf8'));
  } catch (err) {
    throw new Error(`Not valid XML: ${err.message}`);
  }
  let { arr, path } = findRecords(doc);
  if (!arr) {
    // A single <product> isn't an array -- fall back to the deepest object with several fields.
    const single = [];
    const walk = (n) => {
      if (n && typeof n === 'object' && !Array.isArray(n)) {
        const scalars = Object.values(n).filter((v) => typeof v !== 'object').length;
        if (scalars >= 2) single.push(n);
        Object.values(n).forEach(walk);
      }
    };
    walk(doc);
    if (!single.length) throw new Error('No list of products found in the XML file');
    arr = [single[single.length - 1]];
    path = 'XML';
  }
  return { tables: [tableFromRecords(path || 'XML', arr)] };
}

// ----------------------------------------------------------------------- PDF

const PRICE_RE = /^R\s?\d{1,3}(?:[ , ]?\d{3})*(?:[.,]\d{2})?$/;
// Supplier codes: no spaces, no lowercase, contains a digit or dash (FD-CT-22, VX-147-BK[V3], ENDER-3V3).
const CODE_RE = /^(?=.*[\d-])[A-Z0-9][A-Z0-9\-_./[\]]{3,}$/;
const IGNORE_RE = /^(buy now|shop now|order now|add to cart|new|sale|special)$/i;

async function pdfSegments(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const raw = tc.items
      .filter((it) => typeof it.str === 'string' && it.str.length)
      .map((it) => ({ x: it.transform[4], y: it.transform[5], w: it.width, h: Math.abs(it.transform[3]) || 10, s: it.str }));
    pages.push(mergeFragments(raw));
  }
  return pages;
}

// Rejoins text that the PDF split mid-word. Common in designed flyers where
// ligature glyphs (ff, ti) become their own items: "Co" "ff" "ee" -> "Coffee".
// A whitespace-only item wedged inside a word is an unmapped ligature; "ti" is
// by far the most common one in product copy ("Floa ng" -> "Floating").
export function mergeFragments(items) {
  const byLine = new Map();
  for (const it of items) {
    const key = Math.round(it.y);
    const line = byLine.get(key) || byLine.get(key - 1) || byLine.get(key + 1);
    if (line) line.push(it);
    else byLine.set(key, [it]);
  }
  const out = [];
  for (const line of byLine.values()) {
    line.sort((a, b) => a.x - b.x);
    let cur = null;
    for (let i = 0; i < line.length; i++) {
      const it = line[i];
      const gap = cur ? it.x - (cur.x + cur.w) : Infinity;
      const tight = gap < it.h * 0.25;
      if (cur && !it.s.trim() && tight) {
        const next = line[i + 1];
        const nextGap = next ? next.x - (it.x + it.w) : Infinity;
        if (next && nextGap < it.h * 0.25 && /[a-z]$/i.test(cur.s) && /^[a-z]/.test(next.s)) {
          cur.s += 'ti';
          cur.w = it.x + it.w - cur.x;
          continue;
        }
      }
      if (cur && tight) {
        cur.s += it.s;
        cur.w = it.x + it.w - cur.x;
      } else if (cur && gap < it.h * 0.9 && !/^\s*$/.test(it.s)) {
        cur.s += (/\s$/.test(cur.s) || /^\s/.test(it.s) ? '' : ' ') + it.s;
        cur.w = it.x + it.w - cur.x;
      } else {
        if (cur) out.push(cur);
        cur = it.s.trim() ? { ...it } : null;
      }
    }
    if (cur) out.push(cur);
  }
  // Some fonts emit the unmapped ligature as U+0000 inside the text instead.
  return out.map((s) => ({ ...s, s: s.s.replace(/\u0000/g, 'ti').replace(/\s+/g, ' ').trim() })).filter((s) => s.s);
}

// Table-style PDF: a header line with Code/Name/Price headings defines columns.
function pdfAsTable(segments, pageNo) {
  const lines = groupLines(segments);
  let header = null;
  for (const line of lines) {
    if (headerScore(line.map((s) => s.s)) >= 6) {
      header = line;
      break;
    }
  }
  if (!header) return null;
  const cols = header.map((s) => s.x);
  const rows = [];
  for (const line of lines.filter((l) => l[0].y < header[0].y - 1)) {
    const row = header.map(() => '');
    for (const seg of line) {
      let idx = 0;
      for (let c = 0; c < cols.length; c++) if (seg.x >= cols[c] - 4) idx = c;
      row[idx] = row[idx] ? `${row[idx]} ${seg.s}` : seg.s;
    }
    if (row.some(Boolean)) rows.push(row);
  }
  return { name: `Page ${pageNo}`, headers: header.map((s) => s.s), rows, images: new Map() };
}

function groupLines(segments) {
  const lines = [];
  for (const s of [...segments].sort((a, b) => b.y - a.y)) {
    const line = lines.find((l) => Math.abs(l[0].y - s.y) <= Math.max(2, s.h * 0.4));
    if (line) line.push(s);
    else lines.push([s]);
  }
  return lines.map((l) => l.sort((a, b) => a.x - b.x));
}

// Flyer/catalogue-style PDF: each product is a card with a code, name lines and a
// price below. Pair each code with the nearest price beneath it in the same
// column, and take the text between them (closest to that column) as the name.
export function pdfAsCards(segments) {
  const center = (s) => s.x + s.w / 2;
  const codes = segments.filter((s) => CODE_RE.test(s.s) && !PRICE_RE.test(s.s));
  const prices = segments.filter((s) => PRICE_RE.test(s.s));
  const usedPrices = new Set();
  const cards = [];
  for (const code of codes.sort((a, b) => b.y - a.y || a.x - b.x)) {
    const below = prices
      .filter((p) => !usedPrices.has(p) && p.y < code.y && code.y - p.y < 260)
      .map((p) => ({ p, score: Math.abs(center(p) - center(code)) + (code.y - p.y) * 0.3 }))
      .sort((a, b) => a.score - b.score)[0];
    if (!below || Math.abs(center(below.p) - center(code)) > 160) continue;
    usedPrices.add(below.p);
    cards.push({ code, price: below.p, parts: [] });
  }
  for (const seg of segments) {
    if (CODE_RE.test(seg.s) || PRICE_RE.test(seg.s) || IGNORE_RE.test(seg.s)) continue;
    const owners = cards.filter((c) => seg.y < c.code.y + 1 && seg.y > c.price.y - 1);
    if (!owners.length) continue;
    const owner = owners.sort((a, b) => Math.abs(center(a.code) - center(seg)) - Math.abs(center(b.code) - center(seg)))[0];
    owner.parts.push(seg);
  }
  return cards.map((c) => {
    const name = c.parts
      .sort((a, b) => b.y - a.y || a.x - b.x)
      .map((p) => p.s)
      .join(' ')
      .replace(/\s*\|\s*/g, ' | ')
      .replace(/\s+/g, ' ')
      .replace(/^\|\s*|\s*\|$/g, '')
      .trim();
    const brand = /^[A-Z][A-Za-z0-9&]+$/.test(name.split(' ')[0] || '') ? name.split(' ')[0] : '';
    return [c.code.s, name || c.code.s, brand, c.price.s];
  });
}

async function parsePdf(buffer) {
  let pages;
  try {
    pages = await pdfSegments(buffer);
  } catch (err) {
    throw new Error(`Could not read the PDF: ${err.message}`);
  }
  const all = pages.flat();
  if (!all.length) throw new Error('This PDF has no selectable text (it is probably a scanned image). Ask the supplier for Excel/CSV, or a text-based PDF.');
  const tables = pages.map((segs, i) => pdfAsTable(segs, i + 1)).filter((t) => t && t.rows.length);
  const warnings = [];
  if (tables.length) return { tables, warnings };
  // Flyer mode, page by page so a code never pairs with a price on another page.
  const rows = pages.flatMap((segs) => pdfAsCards(segs));
  if (!rows.length) throw new Error('No products recognised in this PDF (looked for a Code/Name/Price table, or product cards with a code and an R price).');
  warnings.push('PDF read in flyer mode (product cards). Names are taken from the text between each code and its price; check them in the preview. Photos are not extracted from PDFs.');
  return { tables: [{ name: 'PDF flyer', headers: ['Product Code', 'Name', 'Brand', 'Cost Excl VAT'], rows, images: new Map() }], warnings };
}

// ------------------------------------------------------------------ dispatch

export function detectFormat(fileName, buffer) {
  const ext = String(fileName || '').toLowerCase().split('.').pop();
  const head = buffer.subarray(0, 8).toString('latin1');
  if (head.startsWith('%PDF')) return 'pdf';
  if (head.startsWith('PK')) {
    if (ext === 'xls') throw new Error('Old .xls files are not supported — open it in Excel and "Save As" .xlsx');
    return 'xlsx';
  }
  if (['csv', 'txt', 'tsv'].includes(ext)) return 'csv';
  if (ext === 'json') return 'json';
  if (ext === 'xml') return 'xml';
  const text = buffer.subarray(0, 200).toString('utf8').replace(/^﻿/, '').trimStart();
  if (text.startsWith('{') || text.startsWith('[')) return 'json';
  if (text.startsWith('<')) return 'xml';
  if (ext === 'xls') throw new Error('Old .xls files are not supported — open it in Excel and "Save As" .xlsx');
  throw new Error('Unsupported file. Use .xlsx, .csv, .json, .xml or .pdf');
}

export async function parseFeedFile(fileName, buffer) {
  const format = detectFormat(fileName, buffer);
  const parsers = { xlsx: parseXlsx, csv: parseCsvBuffer, json: parseJsonBuffer, xml: parseXmlBuffer, pdf: parsePdf };
  const res = await parsers[format](buffer);
  return { format, tables: res.tables.filter((t) => t.rows.length), warnings: res.warnings || [] };
}
