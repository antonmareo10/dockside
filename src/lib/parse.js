// Delivery note parser: CSV / delimited tables, aligned text tables, simple
// free-text lines and JSON. Deterministic: every value it returns points back
// to the source line it came from. Pure functions.

import { detectDecimalComma, parseNumber, parseRate } from './num.js';
import { normalize, UNIT_WORDS } from './text.js';

export const PARSER_VERSION = '1.0.0';

// Column synonyms (normalised: lowercase, no accents, punctuation -> space).
const COLUMN_SYNONYMS = {
  sku: ['sku', 'code', 'item code', 'product code', 'codigo', 'cod', 'ref', 'reference', 'referencia', 'art', 'cod art', 'codigo articulo'],
  description: ['description', 'descripcion', 'item', 'product', 'producto', 'articulo', 'concepto', 'name', 'nombre', 'detalle'],
  ordered: ['ordered', 'qty ordered', 'ordered qty', 'order qty', 'po qty', 'pedido', 'cant pedida', 'cantidad pedida', 'uds pedidas', 'pedidas'],
  qty: ['qty', 'quantity', 'delivered', 'qty delivered', 'delivered qty', 'billed qty', 'cantidad', 'cant', 'servido', 'servida', 'cant servida', 'cantidad servida', 'entregado', 'entregada', 'uds', 'units'],
  received: ['received', 'qty received', 'received qty', 'counted', 'recibido', 'recibida', 'cant recibida', 'cantidad recibida', 'contado'],
  unit: ['unit', 'uom', 'ud', 'unidad', 'u m', 'um', 'measure', 'formato', 'medida'],
  unitPrice: ['unit price', 'price', 'precio', 'precio unit', 'precio unitario', 'p unit', 'pu', 'price unit', 'eur u', 'unit cost', 'coste', 'tarifa', 'precio ud'],
  discount: ['discount', 'disc', 'disc %', 'discount %', 'dto', 'dto %', 'descuento', '% dto'],
  vatRate: ['vat', 'vat %', 'vat rate', 'iva', 'iva %', '% iva', 'tipo iva', 'tax', 'tax %', 'tipo'],
  lineTotal: ['total', 'line total', 'amount', 'importe', 'net', 'neto', 'importe neto', 'base', 'net amount', 'line amount', 'subtotal'],
};

const HEADER_LOOKUP = new Map();
for (const [field, names] of Object.entries(COLUMN_SYNONYMS)) {
  for (const n of names) HEADER_LOOKUP.set(n, field);
}

function headerField(cell) {
  const n = normalize(cell).replace(/\s*%\s*/g, ' %').trim();
  if (HEADER_LOOKUP.has(n)) return HEADER_LOOKUP.get(n);
  const noPct = n.replace(/\s*%/g, '').trim();
  if (HEADER_LOOKUP.has(noPct)) return HEADER_LOOKUP.get(noPct);
  if (/^(precio|price)\b/.test(noPct)) return 'unitPrice';
  if (/^(iva|vat)\b/.test(noPct)) return 'vatRate';
  if (/^(importe|amount|total)\b/.test(noPct)) return 'lineTotal';
  return null;
}

// ---------- header fields ----------

const AMOUNT = String.raw`(-?\(?[€$£]?\s*\d[\d.,\s]*\d?\s*(?:€|eur|euros)?\)?)`;
const META_PATTERNS = [
  { field: 'supplier', re: /^\s*(?:supplier|vendor|seller|proveedor|from|emisor)\s*[:\-]\s*(.+?)\s*$/i },
  {
    field: 'number',
    re: /^\s*(?:delivery\s*note(?:\s*(?:no\.?|number|num|#|nº))?|albar[aá]n(?:\s*(?:n[º°o]\.?|n[uú]m(?:ero)?\.?|#))?|n[º°o]\.?\s*albar[aá]n|note\s*(?:no\.?|number|#)|dn\s*(?:no\.?|#)?|document\s*(?:no\.?|number))\s*[:#\-]?\s*([A-Za-z0-9][A-Za-z0-9\-\/._]*)\s*$/i,
  },
  { field: 'date', re: /^\s*(?:date|delivery\s*date|fecha(?:\s*(?:de\s*)?(?:entrega|albar[aá]n))?)\s*[:\-]\s*(.+?)\s*$/i },
  { field: 'po', re: /^\s*(?:purchase\s*order|po(?:\s*(?:no\.?|number|#))?|pedido(?:\s*n[º°o]\.?)?|n[º°o]\.?\s*pedido)\s*[:#]\s*([A-Za-z0-9][A-Za-z0-9\-\/._ ]*?)\s*$/i },
];

// Number and date typed on one line: "Albaran 5560 / 02-11-2026", "Nº 5560 - 02/11/2026", "No. 5560, 2026-11-02".
// The number must hold a digit, so "Albarán del 02-11-2026" is not read as a note number.
const NUMBER_DATE = /^\s*(?:delivery\s*note(?:\s*(?:no\.?|number|num|#|nº))?|albar[aá]n(?:\s*(?:n[º°o]\.?|n[uú]m(?:ero)?\.?|#))?|n[º°]\.?|no\.?(?![a-z]))\s*[:#]?\s*(?=[A-Za-z0-9\-._]*\d)([A-Za-z0-9][A-Za-z0-9\-._]*?)\s*(?:[\/|,;]|\s-|\s)\s*(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}|\d{4}-\d{1,2}-\d{1,2})\s*$/i;

const TOTAL_PATTERNS = [
  { field: 'subtotal', re: new RegExp(String.raw`^\s*(?:subtotal|sub-total|net\s*total|total\s*net[o]?|base(?:\s*imponible)?|total\s*base|taxable\s*base|net)\s*(?:\(.*?\))?\s*[:\-]?\s*${AMOUNT}\s*$`, 'i') },
  { field: 'vatByRate', re: new RegExp(String.raw`^\s*(?:vat|iva|cuota\s*iva|tax)\s*\(?\s*(\d{1,2}(?:[.,]\d+)?)\s*%\s*\)?\s*[:\-]?\s*${AMOUNT}\s*$`, 'i') },
  { field: 'vat', re: new RegExp(String.raw`^\s*(?:total\s*)?(?:vat|iva|cuota\s*(?:de\s*)?iva|tax|impuestos?)(?:\s*total)?\s*(?:\(.*?\))?\s*[:\-]?\s*${AMOUNT}\s*$`, 'i') },
  { field: 'total', re: new RegExp(String.raw`^\s*(?:grand\s*total|total\s*(?:a\s*pagar|due|amount|albar[aá]n|factura|eur)?|importe\s*total|amount\s*due)\s*[:\-]?\s*${AMOUNT}\s*$`, 'i') },
];

const MONTHS = {
  jan: 1, ene: 1, january: 1, enero: 1,
  feb: 2, february: 2, febrero: 2,
  mar: 3, march: 3, marzo: 3,
  apr: 4, abr: 4, april: 4, abril: 4,
  may: 5, mayo: 5,
  jun: 6, june: 6, junio: 6,
  jul: 7, july: 7, julio: 7,
  aug: 8, ago: 8, august: 8, agosto: 8,
  sep: 9, sept: 9, september: 9, septiembre: 9, set: 9,
  oct: 10, october: 10, octubre: 10,
  nov: 11, november: 11, noviembre: 11,
  dec: 12, dic: 12, december: 12, diciembre: 12,
};

const pad = (n) => String(n).padStart(2, '0');

function validDate(y, m, d) {
  if (!(y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Parse "2026-10-27", "27/10/2026", "27-10-26", "27 Oct 2026", "27 de octubre de 2026" to ISO. */
export function parseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  m = s.match(/(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return validDate(y, +m[2], +m[1]);
  }
  m = normalize(s).match(/(\d{1,2})\s+(?:de\s+)?([a-z]+)\s+(?:de\s+)?(\d{4})/);
  if (m && MONTHS[m[2]]) return validDate(+m[3], MONTHS[m[2]], +m[1]);
  return null;
}

// ---------- splitting ----------

function splitQuoted(line, delimiter) {
  const cells = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === delimiter && !quoted) {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

const DELIMITERS = [
  { name: 'semicolon', split: (l) => splitQuoted(l, ';') },
  { name: 'tab', split: (l) => l.split('\t').map((c) => c.trim()) },
  {
    name: 'pipe',
    split: (l) => {
      const t = l.trim().replace(/^\|/, '').replace(/\|$/, '');
      return t.split('|').map((c) => c.trim());
    },
  },
  { name: 'comma', split: (l) => splitQuoted(l, ',') },
  { name: 'spaces', split: (l) => l.trim().split(/\s{2,}/).map((c) => c.trim()) },
];

function isSeparatorRow(line) {
  return /^[\s|+\-=_:.*]+$/.test(line) && /[-=_]{3,}/.test(line);
}

function findTable(lines) {
  let best = null;
  lines.forEach((line, idx) => {
    if (!line.trim()) return;
    for (const d of DELIMITERS) {
      const cells = d.split(line);
      if (cells.length < 3) continue;
      const fields = cells.map(headerField);
      const known = fields.filter(Boolean);
      const unique = new Set(known);
      const hasCore = unique.has('description') || unique.has('sku');
      const hasMoney = unique.has('unitPrice') || unique.has('lineTotal');
      if (unique.size >= 3 && hasCore && hasMoney) {
        const score = unique.size * 10 - (cells.length - known.length);
        if (!best || score > best.score) best = { idx, delimiter: d, fields, score };
      }
    }
  });
  return best;
}

// Resolve a header like "Total | VAT | Total" where "total" means the line total.
function dedupeFields(fields) {
  const seen = new Set();
  return fields.map((f) => {
    if (!f) return null;
    if (seen.has(f)) return null;
    seen.add(f);
    return f;
  });
}

function matchMeta(line) {
  const nd = line.match(NUMBER_DATE);
  const ndDate = nd ? parseDate(nd[2]) : null;
  if (ndDate) return { field: 'numberDate', number: nd[1], date: ndDate };
  for (const p of META_PATTERNS) {
    const m = line.match(p.re);
    if (m) return { field: p.field, value: m[1].trim() };
  }
  return null;
}

function matchTotal(line, decimalComma) {
  for (const p of TOTAL_PATTERNS) {
    const m = line.match(p.re);
    if (!m) continue;
    if (p.field === 'vatByRate') {
      const rate = parseRate(m[1], decimalComma);
      const amount = parseNumber(m[2], decimalComma);
      if (rate !== null && amount !== null) return { field: 'vatByRate', rate, value: amount };
      continue;
    }
    const value = parseNumber(m[1], decimalComma);
    if (value !== null) return { field: p.field, value };
  }
  return null;
}

// Simple free-text item line: "12 kg Hake fillet @ 13,90 = 166,80 (10%)".
const UNIT_ALT = UNIT_WORDS.slice()
  .sort((a, b) => b.length - a.length)
  .map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');
const FREE_LINE = new RegExp(
  String.raw`^\s*(?:(?<sku>[A-Z]{1,5}[-_]?\d{1,6}[A-Z]?)\s+)?(?<qty>\d+(?:[.,]\d+)?)\s*(?<unit>${UNIT_ALT})?\.?\s+(?:x\s+|of\s+|de\s+)?(?<desc>[A-Za-zÀ-ÿ][^@=]*?)\s+(?:@|a|at|x)\s*(?<price>\d+(?:[.,]\d+)?)\s*(?:€|eur)?(?:\s*\/\s*[A-Za-z]+)?(?:\s*(?:=|:|->|total)?\s*(?<total>\d+(?:[.,]\d+)?)\s*(?:€|eur)?)?(?:\s*\(?\s*(?:vat|iva)?\s*(?<vat>\d{1,2}(?:[.,]\d+)?)\s*%\s*(?:vat|iva)?\s*\)?)?\s*$`,
  'i'
);

const GENERIC_TITLES = /^(delivery note|albaran|nota de entrega|packing list|packing slip|invoice|factura|goods received|hoja de entrega)( .*)?$/;

function emptyNote(format) {
  return {
    parserVersion: PARSER_VERSION,
    format,
    supplier: null,
    number: null,
    date: null,
    po: null,
    decimalComma: true,
    lines: [],
    totals: { subtotal: null, vat: null, vatByRate: {}, total: null, sources: {} },
    warnings: [],
    sourceText: '',
  };
}

function buildLine(fields, cells, decimalComma, lineNo, source) {
  const get = (f) => {
    const i = fields.indexOf(f);
    return i >= 0 ? cells[i] ?? '' : '';
  };
  const num = (f) => parseNumber(get(f), decimalComma);
  const line = {
    lineNo,
    source,
    sku: get('sku') || null,
    description: get('description') || null,
    ordered: num('ordered'),
    qty: num('qty'),
    received: num('received'),
    unit: get('unit') || null,
    unitPrice: num('unitPrice'),
    discountPct: fields.includes('discount') ? parseRate(get('discount'), decimalComma) : null,
    vatRate: fields.includes('vatRate') ? parseRate(get('vatRate'), decimalComma) : null,
    lineTotal: num('lineTotal'),
  };
  return line;
}

function lineIsUsable(line) {
  return (line.description || line.sku) && line.qty !== null && (line.unitPrice !== null || line.lineTotal !== null);
}

/** Parse plain text (pasted note, CSV, table copied from a PDF). */
export function parseText(input) {
  const sourceText = String(input ?? '').replace(/\r\n?/g, '\n');
  const lines = sourceText.split('\n');
  const note = emptyNote('text');
  note.sourceText = sourceText;
  note.decimalComma = detectDecimalComma(sourceText);

  const table = findTable(lines);
  if (table && table.delimiter.name === 'comma') {
    // A comma-separated table cannot also use decimal commas unless values are quoted.
    note.decimalComma = /"\d+,\d+"/.test(sourceText);
  }
  const tableRows = new Set();
  if (table) {
    note.format = table.delimiter.name === 'spaces' ? 'aligned-table' : table.delimiter.name === 'pipe' ? 'pipe-table' : 'csv';
    const fields = dedupeFields(table.fields);
    tableRows.add(table.idx);
    for (let i = table.idx + 1; i < lines.length; i += 1) {
      const raw = lines[i];
      if (!raw.trim()) {
        tableRows.add(i);
        continue;
      }
      if (isSeparatorRow(raw)) {
        tableRows.add(i);
        continue;
      }
      if (matchTotal(raw, note.decimalComma) || matchMeta(raw)) break;
      const cells = table.delimiter.split(raw);
      if (cells.length < 3) {
        // Not part of the table any more (a footer sentence, a signature...).
        if (!/\d/.test(raw)) break;
        note.warnings.push({ code: 'PARSE_SKIPPED_LINE', lineNo: i + 1, source: raw.trim(), message: 'Row has too few columns to read.' });
        tableRows.add(i);
        continue;
      }
      tableRows.add(i);
      const line = buildLine(fields, cells, note.decimalComma, i + 1, raw.trim());
      if (lineIsUsable(line)) note.lines.push(line);
      else note.warnings.push({ code: 'PARSE_SKIPPED_LINE', lineNo: i + 1, source: raw.trim(), message: 'Row is missing a description, quantity or price.' });
    }
  }

  lines.forEach((raw, idx) => {
    if (tableRows.has(idx) || !raw.trim()) return;
    const meta = matchMeta(raw);
    if (meta) {
      if (meta.field === 'numberDate') {
        if (!note.number) note.number = meta.number;
        if (!note.date) note.date = meta.date;
      } else if (meta.field === 'date') {
        const iso = parseDate(meta.value);
        if (iso && !note.date) note.date = iso;
      } else if (!note[meta.field]) {
        note[meta.field] = meta.value;
      }
      return;
    }
    const total = matchTotal(raw, note.decimalComma);
    if (total) {
      if (total.field === 'vatByRate') {
        note.totals.vatByRate[total.rate] = total.value;
      } else if (note.totals[total.field] === null) {
        note.totals[total.field] = total.value;
        note.totals.sources[total.field] = { lineNo: idx + 1, source: raw.trim() };
      }
      return;
    }
    if (!table) {
      const m = raw.match(FREE_LINE);
      if (m && m.groups.desc && !/^(total|subtotal|iva|vat|base)\b/i.test(m.groups.desc.trim())) {
        const g = m.groups;
        note.lines.push({
          lineNo: idx + 1,
          source: raw.trim(),
          sku: g.sku ?? null,
          description: g.desc.trim().replace(/[,;:]+$/, ''),
          ordered: null,
          qty: parseNumber(g.qty, note.decimalComma),
          received: null,
          unit: g.unit ?? null,
          unitPrice: parseNumber(g.price, note.decimalComma),
          discountPct: null,
          vatRate: g.vat ? parseRate(g.vat, note.decimalComma) : null,
          lineTotal: g.total ? parseNumber(g.total, note.decimalComma) : null,
        });
      }
    }
  });

  if (!table && note.lines.length) note.format = 'free-text';
  if (!table && !note.lines.length) note.format = 'unrecognised';

  // Header fields written on one line: "Supplier: X   Note: Y   Date: Z" are rare; first-line fallback for supplier.
  if (!note.supplier && note.lines.length) {
    const first = lines
      .slice(0, 8)
      .find((l) => l.trim() && !GENERIC_TITLES.test(normalize(l)) && !matchTotal(l, note.decimalComma) && !matchMeta(l) && !/\d{2,}/.test(l) && l.trim().length <= 60 && !findTable([l]));
    if (first) {
      note.supplier = first.trim().replace(/^(albar[aá]n|delivery note)\s*[-:]\s*/i, '');
      note.warnings.push({ code: 'SUPPLIER_GUESSED', lineNo: lines.indexOf(first) + 1, source: first.trim(), message: 'Supplier taken from the first line of the note.' });
    }
  }

  if (note.totals.vat === null && Object.keys(note.totals.vatByRate).length) {
    note.totals.vat = Object.values(note.totals.vatByRate).reduce((a, b) => a + b, 0);
  }
  return note;
}

const pick = (obj, ...keys) => {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return null;
};

/** Parse a structured note (from JSON, the Rovo agent, or an MCP client). */
export function parseJson(input) {
  const data = typeof input === 'string' ? JSON.parse(input) : input;
  const note = emptyNote('json');
  if (!data || typeof data !== 'object') return note;
  const supplier = pick(data, 'supplier', 'vendor', 'proveedor');
  note.supplier = typeof supplier === 'object' && supplier ? pick(supplier, 'name', 'nombre') : supplier;
  note.number = pick(data, 'number', 'noteNumber', 'deliveryNote', 'deliveryNoteNumber', 'albaran', 'id');
  note.number = note.number !== null ? String(note.number) : null;
  note.date = parseDate(pick(data, 'date', 'deliveryDate', 'fecha'));
  note.po = pick(data, 'po', 'purchaseOrder', 'pedido');
  note.decimalComma = typeof data.decimalComma === 'boolean' ? data.decimalComma : true;
  const dc = note.decimalComma;
  const num = (v) => (v === null ? null : parseNumber(v, dc));
  const items = pick(data, 'lines', 'items', 'lineas') || [];
  items.forEach((item, i) => {
    const vat = pick(item, 'vatRate', 'vat', 'iva', 'taxRate');
    note.lines.push({
      lineNo: Number(pick(item, 'lineNo', 'line', 'sourceLine')) || i + 1,
      source: pick(item, 'source', 'sourceText', 'quote') ?? null,
      sku: pick(item, 'sku', 'code', 'ref') !== null ? String(pick(item, 'sku', 'code', 'ref')) : null,
      description: pick(item, 'description', 'name', 'item', 'descripcion'),
      ordered: num(pick(item, 'ordered', 'qtyOrdered', 'orderedQty')),
      qty: num(pick(item, 'qty', 'quantity', 'delivered', 'qtyDelivered')),
      received: num(pick(item, 'received', 'qtyReceived')),
      unit: pick(item, 'unit', 'uom'),
      unitPrice: num(pick(item, 'unitPrice', 'price', 'precio')),
      discountPct: pick(item, 'discountPct', 'discount') !== null ? parseRate(pick(item, 'discountPct', 'discount'), dc) : null,
      vatRate: vat !== null ? parseRate(vat, dc) : null,
      lineTotal: num(pick(item, 'lineTotal', 'total', 'amount', 'importe')),
    });
  });
  const totals = data.totals && typeof data.totals === 'object' ? data.totals : data;
  note.totals.subtotal = num(pick(totals, 'subtotal', 'net', 'base'));
  note.totals.vat = num(pick(totals, 'vatTotal', 'vat', 'iva', 'tax'));
  note.totals.total = num(pick(totals, 'total', 'grandTotal'));
  note.lines = note.lines.filter((l) => {
    if (lineIsUsable(l)) return true;
    note.warnings.push({ code: 'PARSE_SKIPPED_LINE', lineNo: l.lineNo, source: l.source ?? JSON.stringify(l.description ?? ''), message: 'Item is missing a description, quantity or price.' });
    return false;
  });
  return note;
}

/** Entry point: decide the format and parse. */
export function parseDeliveryNote(input) {
  if (input && typeof input === 'object') return parseJson(input);
  const s = String(input ?? '').trim();
  if (s.startsWith('{')) {
    try {
      const note = parseJson(s);
      note.sourceText = s;
      return note;
    } catch {
      // Not valid JSON: fall through and read it as text.
    }
  }
  return parseText(input);
}
