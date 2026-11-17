// Synthetic demo data. Every supplier, product, price and note number here is
// invented for the demo; none of it comes from a real business.

import { round2 } from './num.js';
import { itemKeyFor } from './history.js';
import { supplierKey } from './text.js';

export const SUPPLIERS = [
  {
    name: 'Pescados Rompeolas S.L.',
    prefix: 'RP',
    items: [
      { sku: 'PES-101', description: 'Hake fillet, fresh', unit: 'kg', unitPrice: 13.2, vatRate: 10, past: [12.8, 12.95] },
      { sku: 'PES-114', description: 'Mussels, Galician', unit: 'kg', unitPrice: 3.1, vatRate: 10, past: [2.95, 3.1] },
      { sku: 'PES-120', description: 'Squid, cleaned', unit: 'kg', unitPrice: 9.8, vatRate: 10, past: [9.6] },
      { sku: 'PES-131', description: 'Sea bass, whole', unit: 'kg', unitPrice: 11.4, vatRate: 10, past: [11.1] },
    ],
  },
  {
    name: 'Huerta Valdeluz S.Coop.',
    prefix: 'HV',
    items: [
      { sku: 'HV-01', description: 'Pear tomatoes', unit: 'kg', unitPrice: 1.85, vatRate: 4, past: [1.7, 1.8] },
      { sku: 'HV-07', description: 'Romaine lettuce', unit: 'unit', unitPrice: 0.95, vatRate: 4, past: [0.95] },
      { sku: 'HV-12', description: 'Onions, brown', unit: 'kg', unitPrice: 0.78, vatRate: 4, past: [0.75, 0.78] },
      { sku: 'HV-20', description: 'Lemons', unit: 'kg', unitPrice: 1.6, vatRate: 4, past: [1.55] },
      { sku: 'HV-31', description: 'Flat parsley', unit: 'bunch', unitPrice: 0.6, vatRate: 4, past: [0.6] },
    ],
  },
  {
    name: 'Bebidas Cierzo S.A.',
    prefix: 'BC',
    items: [
      { sku: 'BC-330', description: 'Lager beer 33cl x24', unit: 'case', unitPrice: 21.6, vatRate: 21, past: [21.1] },
      { sku: 'BC-500', description: 'Still water 50cl x24', unit: 'case', unitPrice: 6.9, vatRate: 10, past: [6.9] },
      { sku: 'BC-750', description: 'Red wine Tempranillo 75cl', unit: 'bottle', unitPrice: 4.95, vatRate: 21, past: [4.8, 4.95] },
      { sku: 'BC-334', description: 'Cola 33cl x24', unit: 'case', unitPrice: 18.4, vatRate: 21, past: [17.9] },
    ],
  },
  {
    name: 'Lácteos Prado Alto S.L.',
    prefix: 'LPA',
    items: [
      { sku: 'LPA-1', description: 'Whole milk 1 L', unit: 'unit', unitPrice: 0.89, vatRate: 4, past: [0.86, 0.89] },
      { sku: 'LPA-5', description: 'Butter block 1 kg', unit: 'kg', unitPrice: 8.4, vatRate: 10, past: [8.1] },
      { sku: 'LPA-9', description: 'Cream 35% 1 L', unit: 'unit', unitPrice: 3.95, vatRate: 10, past: [3.95] },
      { sku: 'LPA-12', description: 'Eggs L, tray of 30', unit: 'tray', unitPrice: 6.3, vatRate: 4, past: [5.9, 6.1] },
    ],
  },
];

export function supplierByName(name) {
  return SUPPLIERS.find((s) => s.name === name);
}

// History dates: one accepted note per supplier per month, the latest on 20 Oct 2026.
const HISTORY_DATES = ['2026-08-25', '2026-09-22', '2026-10-20'];

/** Accepted price history entries for every demo supplier. */
export function seedHistory() {
  const entries = [];
  SUPPLIERS.forEach((s, si) => {
    const sk = supplierKey(s.name);
    s.items.forEach((item) => {
      const prices = [...item.past, item.unitPrice];
      const dates = HISTORY_DATES.slice(HISTORY_DATES.length - prices.length);
      prices.forEach((price, pi) => {
        const date = dates[pi];
        const noteNumber = `${s.prefix}-${24000 + si * 100 + HISTORY_DATES.indexOf(date) * 30}`;
        entries.push({
          supplierKey: sk,
          supplierName: s.name,
          itemKey: itemKeyFor(item),
          sku: item.sku,
          description: item.description,
          unit: item.unit,
          unitPrice: price,
          vatRate: item.vatRate,
          date,
          issueKey: null,
          noteNumber,
          status: 'accepted',
          recordedAt: `${date}T09:00:00.000Z`,
        });
      });
    });
  });
  return entries;
}

// ---------- note specs ----------

/** Fill in line totals and note totals the way a supplier's system would. */
export function computeNote(spec) {
  const lines = spec.lines.map((l) => ({ ...l, lineTotal: l.lineTotal ?? round2(l.qty * l.unitPrice * (1 - (l.discountPct || 0) / 100)) }));
  const subtotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0));
  const byRate = new Map();
  for (const l of lines) byRate.set(l.vatRate, (byRate.get(l.vatRate) || 0) + l.lineTotal);
  const vatLines = [...byRate.entries()].sort((a, b) => a[0] - b[0]).map(([rate, base]) => ({ rate, base: round2(base), vat: round2((round2(base) * rate) / 100) }));
  const vat = round2(vatLines.reduce((s, v) => s + v.vat, 0));
  const t = spec.totals || {};
  const statedSubtotal = t.subtotal ?? subtotal;
  const statedVat = t.vat ?? vat;
  const total = t.total ?? round2(statedSubtotal + statedVat);
  return { ...spec, lines, totals: { subtotal: statedSubtotal, vat: statedVat, total, vatLines } };
}

const es = (n, d = 2) => n.toFixed(d).replace('.', ',');
const en = (n, d = 2) => n.toFixed(d);
const qtyStr = (n, fmt) => (Number.isInteger(n) ? String(n) : fmt(n, 3).replace(/0+$/, ''));

function header(spec, lang) {
  if (lang === 'es') return [`Proveedor: ${spec.supplier}`, `Albarán nº: ${spec.number}`, `Fecha: ${spec.date.split('-').reverse().join('/')}`];
  return [`Supplier: ${spec.supplier}`, `Delivery note: ${spec.number}`, `Date: ${spec.date}`];
}

function footer(c, lang, fmt) {
  if (c.omitTotals) return [];
  if (lang === 'es') return [`Base imponible: ${fmt(c.totals.subtotal)}`, `IVA: ${fmt(c.totals.vat)}`, `Total: ${fmt(c.totals.total)}`];
  return [`Subtotal: ${fmt(c.totals.subtotal)}`, `VAT: ${fmt(c.totals.vat)}`, `Total: ${fmt(c.totals.total)}`];
}

const hasCol = (lines, key) => lines.some((l) => l[key] !== undefined && l[key] !== null);

function csvQuote(v, delimiter) {
  const s = String(v);
  return s.includes(delimiter) || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Render a note spec as the text a supplier would send. Formats: csv-es, csv-en, pipe-es, pipe-en, aligned-en, free-text, json. */
export function renderNote(spec) {
  const c = computeNote(spec);
  const withOrdered = hasCol(c.lines, 'ordered');
  const withReceived = hasCol(c.lines, 'received');
  switch (spec.format) {
    case 'csv-es': {
      const head = ['Código', 'Descripción', ...(withOrdered ? ['Pedido'] : []), 'Servido', ...(withReceived ? ['Recibido'] : []), 'Ud', 'Precio', 'IVA %', 'Importe'];
      const rows = c.lines.map((l) => [l.sku, l.description, ...(withOrdered ? [qtyStr(l.ordered ?? l.qty, es)] : []), qtyStr(l.qty, es), ...(withReceived ? [qtyStr(l.received ?? l.qty, es)] : []), l.unit, es(l.unitPrice), String(l.vatRate), es(l.lineTotal)]);
      return [...header(c, 'es'), '', head.join(';'), ...rows.map((r) => r.map((v) => csvQuote(v, ';')).join(';')), '', ...footer(c, 'es', es)].join('\n');
    }
    case 'csv-en': {
      const head = ['SKU', 'Description', ...(withOrdered ? ['Ordered'] : []), 'Delivered', ...(withReceived ? ['Received'] : []), 'Unit', 'Unit price', 'VAT %', 'Line total'];
      const rows = c.lines.map((l) => [l.sku, l.description, ...(withOrdered ? [qtyStr(l.ordered ?? l.qty, en)] : []), qtyStr(l.qty, en), ...(withReceived ? [qtyStr(l.received ?? l.qty, en)] : []), l.unit, en(l.unitPrice), String(l.vatRate), en(l.lineTotal)]);
      return [...header(c, 'en'), '', head.join(','), ...rows.map((r) => r.map((v) => csvQuote(v, ',')).join(',')), '', ...footer(c, 'en', en)].join('\n');
    }
    case 'pipe-es':
    case 'pipe-en': {
      const fmt = spec.format === 'pipe-es' ? es : en;
      const lang = spec.format === 'pipe-es' ? 'es' : 'en';
      const head = lang === 'es'
        ? ['Ref', 'Artículo', ...(withOrdered ? ['Pedido'] : []), 'Cantidad', ...(withReceived ? ['Recibido'] : []), 'Ud', 'Precio', 'IVA', 'Importe']
        : ['SKU', 'Item', ...(withOrdered ? ['Ordered'] : []), 'Qty', ...(withReceived ? ['Received'] : []), 'Unit', 'Price', 'VAT %', 'Total'];
      const rows = c.lines.map((l) => [l.sku, l.description, ...(withOrdered ? [qtyStr(l.ordered ?? l.qty, fmt)] : []), qtyStr(l.qty, fmt), ...(withReceived ? [qtyStr(l.received ?? l.qty, fmt)] : []), l.unit, fmt(l.unitPrice), `${l.vatRate}%`, fmt(l.lineTotal)]);
      const toRow = (r) => `| ${r.join(' | ')} |`;
      return [...header(c, lang), '', toRow(head), `|${head.map(() => '---').join('|')}|`, ...rows.map(toRow), '', ...footer(c, lang, fmt)].join('\n');
    }
    case 'aligned-en': {
      const head = ['Code', 'Description', ...(withOrdered ? ['Ordered'] : []), 'Delivered', ...(withReceived ? ['Received'] : []), 'Unit', 'Price', 'VAT', 'Amount'];
      const rows = c.lines.map((l) => [l.sku, l.description, ...(withOrdered ? [qtyStr(l.ordered ?? l.qty, en)] : []), qtyStr(l.qty, en), ...(withReceived ? [qtyStr(l.received ?? l.qty, en)] : []), l.unit, en(l.unitPrice), String(l.vatRate), en(l.lineTotal)]);
      const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
      const toRow = (r) => r.map((v, i) => String(v).padEnd(widths[i])).join('   ').trimEnd();
      return [...header(c, 'en'), '', toRow(head), ...rows.map(toRow), '', ...footer(c, 'en', en)].join('\n');
    }
    case 'free-text': {
      const unitWord = { kg: 'kg', unit: 'ud', case: 'case', bottle: 'bot', bunch: 'bunch', tray: 'tray' };
      const rows = c.lines.map((l) => `${qtyStr(l.qty, es)} ${unitWord[l.unit] ?? l.unit} ${l.description.replace(/,/g, '')} @ ${es(l.unitPrice)} = ${es(l.lineTotal)} (${l.vatRate}%)`);
      return [...header(c, 'en'), '', ...rows, '', ...footer(c, 'en', es)].join('\n');
    }
    case 'json': {
      return JSON.stringify(
        {
          supplier: c.supplier,
          number: c.number,
          date: c.date,
          lines: c.lines.map((l) => ({ sku: l.sku, description: l.description, ...(l.ordered !== undefined ? { ordered: l.ordered } : {}), qty: l.qty, ...(l.received !== undefined ? { received: l.received } : {}), unit: l.unit, unitPrice: l.unitPrice, vatRate: l.vatRate, lineTotal: l.lineTotal })),
          ...(c.omitTotals ? {} : { subtotal: c.totals.subtotal, vatTotal: c.totals.vat, total: c.totals.total }),
        },
        null,
        2
      );
    }
    case 'raw':
      return spec.text;
    default:
      throw new Error(`Unknown demo format: ${spec.format}`);
  }
}

const S = (name) => supplierByName(name);
const item = (supplier, sku) => S(supplier).items.find((i) => i.sku === sku);
const line = (supplier, sku, over = {}) => {
  const it = item(supplier, sku);
  return { sku: it.sku, description: it.description, unit: it.unit, unitPrice: it.unitPrice, vatRate: it.vatRate, ...over };
};

const ROMPEOLAS = 'Pescados Rompeolas S.L.';
const VALDELUZ = 'Huerta Valdeluz S.Coop.';
const CIERZO = 'Bebidas Cierzo S.A.';
const PRADO = 'Lácteos Prado Alto S.L.';

const N1_LINES = [
  line(ROMPEOLAS, 'PES-101', { ordered: 12, qty: 12, unitPrice: 13.9 }),
  line(ROMPEOLAS, 'PES-114', { ordered: 10, qty: 12 }),
  line(ROMPEOLAS, 'PES-120', { ordered: 6, qty: 6 }),
  line(ROMPEOLAS, 'PES-131', { ordered: 8, qty: 8, unitPrice: 11.6 }),
];

/**
 * The demo delivery notes. `expected` is the ground truth used by the tests:
 * codes with severity error or warning, and the index of the line they point to.
 */
export const DEMO_NOTES = [
  {
    id: 'n1-price-and-over-delivery',
    title: 'Hake price up and two kilos of mussels nobody ordered',
    supplier: ROMPEOLAS,
    number: 'RP-24117',
    date: '2026-10-27',
    format: 'csv-es',
    lines: N1_LINES,
    expected: { status: 'DISPUTE', amountInDispute: 16.06, codes: [{ code: 'PRICE_ABOVE_REFERENCE', line: 0 }, { code: 'OVER_DELIVERY', line: 1 }] },
  },
  {
    id: 'n2-line-total-and-vat-rate',
    title: 'Lettuce line does not add up and tomatoes charged at 10% VAT',
    supplier: VALDELUZ,
    number: 'HV-5531',
    date: '2026-10-28',
    format: 'pipe-en',
    lines: [
      line(VALDELUZ, 'HV-01', { qty: 15, vatRate: 10 }),
      line(VALDELUZ, 'HV-07', { qty: 20, lineTotal: 21.0 }),
      line(VALDELUZ, 'HV-12', { qty: 10 }),
      line(VALDELUZ, 'HV-31', { qty: 12 }),
      { sku: 'HV-44', description: 'Basil, potted', unit: 'unit', unitPrice: 1.2, vatRate: 4, qty: 6 },
    ],
    expected: { status: 'DISPUTE', amountInDispute: 2.08, codes: [{ code: 'VAT_RATE_CHANGED', line: 0 }, { code: 'LINE_TOTAL_MISMATCH', line: 1 }], info: [{ code: 'NO_PRICE_HISTORY', line: 4 }] },
  },
  {
    id: 'n3-clean',
    title: 'Drinks order, everything matches',
    supplier: CIERZO,
    number: 'BC-88812',
    date: '2026-10-29',
    format: 'json',
    lines: [line(CIERZO, 'BC-330', { qty: 4 }), line(CIERZO, 'BC-500', { qty: 6 }), line(CIERZO, 'BC-750', { qty: 12 }), line(CIERZO, 'BC-334', { qty: 2 })],
    expected: { status: 'OK', amountInDispute: 0, codes: [] },
  },
  {
    id: 'n4-not-received-and-vat',
    title: 'Two kilos of butter billed but not delivered, eggs at 7% VAT',
    supplier: PRADO,
    number: 'LPA-3090',
    date: '2026-10-30',
    format: 'aligned-en',
    lines: [
      line(PRADO, 'LPA-1', { ordered: 24, qty: 24, received: 24 }),
      line(PRADO, 'LPA-5', { ordered: 10, qty: 10, received: 8 }),
      line(PRADO, 'LPA-9', { ordered: 6, qty: 6, received: 6 }),
      line(PRADO, 'LPA-12', { ordered: 5, qty: 5, received: 5, vatRate: 7 }),
    ],
    totals: { vat: 15.83 },
    expected: { status: 'DISPUTE', amountInDispute: 21.43, codes: [{ code: 'BILLED_NOT_RECEIVED', line: 1 }, { code: 'VAT_RATE_INVALID', line: 3 }, { code: 'VAT_TOTAL_MISMATCH', line: null }] },
  },
  {
    id: 'n5-duplicate',
    title: 'Same fish note sent again a few days later',
    supplier: ROMPEOLAS,
    number: 'RP-24117',
    date: '2026-10-27',
    format: 'csv-en',
    lines: N1_LINES,
    duplicateOfDemo: 'n1-price-and-over-delivery',
    expected: { status: 'DISPUTE', amountInDispute: 391.16, codes: [{ code: 'DUPLICATE_NOTE', line: null }, { code: 'PRICE_ABOVE_REFERENCE', line: 0 }, { code: 'OVER_DELIVERY', line: 1 }] },
  },
  {
    id: 'n6-free-text',
    title: 'Hand-typed produce note, one line Dockside cannot read on its own',
    supplier: VALDELUZ,
    format: 'raw',
    text: [
      'HUERTA VALDELUZ S.COOP.',
      'Albaran 5560 / 02-11-2026',
      'Left at the kitchen door at 7:40',
      '15 kg Onions, brown @ 0,92 = 13,80',
      '3 kg Lemons @ 1,60 = 4,80',
      '1 caja tomate pera (aprox 6kg) 11,10',
      'Base 29,70',
      'IVA 4% 1,19',
      'Total 30,89',
    ].join('\n'),
    expected: {
      status: 'DISPUTE',
      amountInDispute: 2.18,
      codes: [{ code: 'PRICE_ABOVE_REFERENCE', line: 0 }, { code: 'SUBTOTAL_MISMATCH', line: null }, { code: 'VAT_TOTAL_MISMATCH', line: null }],
      info: [{ code: 'SUPPLIER_GUESSED', line: null }, { code: 'VAT_RATE_FROM_TOTALS', line: null }],
    },
  },
  {
    id: 'n7-unreadable',
    title: 'Only a note that a photo was attached',
    supplier: CIERZO,
    format: 'raw',
    text: 'Delivery from Bebidas Cierzo this morning. The paper note was signed by the driver and is in the office tray.',
    expected: { status: 'UNREADABLE', amountInDispute: 0, codes: [{ code: 'UNREADABLE', line: null }] },
  },
];

/**
 * What the Receiving Clerk agent is expected to send for note n6 after
 * reading it: every line with the exact text it came from. Used by tests to
 * show that the engine verifies extractions instead of trusting them.
 */
export const N6_AGENT_EXTRACTION = {
  supplier: 'Huerta Valdeluz S.Coop.',
  number: '5560',
  date: '2026-11-02',
  lines: [
    { lineNo: 4, source: '15 kg Onions, brown @ 0,92 = 13,80', description: 'Onions, brown', qty: 15, unit: 'kg', unitPrice: 0.92, vatRate: 4, lineTotal: 13.8 },
    { lineNo: 5, source: '3 kg Lemons @ 1,60 = 4,80', description: 'Lemons', qty: 3, unit: 'kg', unitPrice: 1.6, vatRate: 4, lineTotal: 4.8 },
    { lineNo: 6, source: '1 caja tomate pera (aprox 6kg) 11,10', description: 'tomate pera (aprox 6kg)', qty: 1, unit: 'case', unitPrice: 11.1, vatRate: 4, lineTotal: 11.1 },
  ],
  subtotal: 29.7,
  vatTotal: 1.19,
  total: 30.89,
};

export function demoNoteText(spec) {
  return spec.format === 'raw' ? spec.text : renderNote(spec);
}

export function demoSummary(spec) {
  const number = spec.number ? ` ${spec.number}` : '';
  return `Delivery note${number} from ${spec.supplier}`;
}
