// Synthetic, labelled corpus for the scorecard. A fixed-seed generator writes
// delivery notes from the four invented demo suppliers, in five formats, and
// injects known problems. Each note carries its ground truth, so the scorecard
// can count what the engine found, missed or flagged wrongly.
//
// What this measures: that parsing and checks hold up across formats, decimal
// styles, header languages and combinations of problems. What it does not
// measure: accuracy on real suppliers' documents, which no synthetic set can.

import { round2 } from '../src/lib/num.js';
import { renderNote, SUPPLIERS } from '../src/lib/demo.js';

export const CORPUS_SEED = 20261102;
export const CORPUS_SIZE = 120;

export const INJECTIONS = [
  'PRICE_ABOVE_REFERENCE',
  'OVER_DELIVERY',
  'SHORT_DELIVERY',
  'BILLED_NOT_RECEIVED',
  'LINE_TOTAL_MISMATCH',
  'VAT_RATE_INVALID',
  'VAT_RATE_CHANGED',
  'VAT_TOTAL_MISMATCH',
  'SUBTOTAL_MISMATCH',
  'TOTAL_MISMATCH',
  'MISSING_TOTALS',
  'DUPLICATE_NOTE',
  'DUPLICATE_LINE',
];

const FORMATS = ['csv-es', 'csv-en', 'pipe-es', 'pipe-en', 'aligned-en', 'json', 'free-text'];
// Free text has no ordered/received columns, so quantity problems are not injected there.
const NEEDS_COLUMNS = new Set(['OVER_DELIVERY', 'SHORT_DELIVERY', 'BILLED_NOT_RECEIVED']);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateCorpus({ seed = CORPUS_SEED, size = CORPUS_SIZE } = {}) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const notes = [];
  const booked = [];

  for (let n = 0; n < size; n += 1) {
    const supplier = pick(SUPPLIERS);
    const format = FORMATS[n % FORMATS.length];
    const items = supplier.items.slice().sort(() => rnd() - 0.5).slice(0, int(2, supplier.items.length));
    const withQtyColumns = format !== 'free-text' && rnd() < 0.6;
    const lines = items.map((it) => {
      // Small honest price drift, always inside the 3% threshold.
      const drift = 1 + (rnd() * 0.04 - 0.02);
      const unitPrice = Math.max(0.01, round2(it.unitPrice * drift));
      const qty = int(2, 30);
      const line = { sku: it.sku, description: it.description, unit: it.unit, unitPrice, vatRate: it.vatRate, qty };
      if (withQtyColumns) {
        line.ordered = qty;
        line.received = qty;
      }
      return line;
    });

    const truth = [];
    const totals = {};
    let omitTotals = false;
    let duplicateOf = null;
    const available = INJECTIONS.filter((c) => !(format === 'free-text' && NEEDS_COLUMNS.has(c)) && !(NEEDS_COLUMNS.has(c) && !withQtyColumns) && !(c === 'DUPLICATE_NOTE' && !booked.some((b) => b.supplier === supplier.name)));
    // One note in five is clean; the rest get one or two problems on different lines.
    const howMany = n % 5 === 0 ? 0 : int(1, 2);
    const used = new Set();
    const usedLines = new Set();
    const freeLine = () => {
      const candidates = lines.map((_, i) => i).filter((i) => !usedLines.has(i));
      if (!candidates.length) return null;
      const i = pick(candidates);
      usedLines.add(i);
      return i;
    };
    const noteLevel = new Set(['VAT_TOTAL_MISMATCH', 'SUBTOTAL_MISMATCH', 'TOTAL_MISMATCH', 'MISSING_TOTALS']);
    for (let k = 0; k < howMany; k += 1) {
      const options = available.filter((c) => !used.has(c) && !(noteLevel.has(c) && [...used].some((u) => noteLevel.has(u))));
      if (!options.length) break;
      const code = pick(options);
      used.add(code);
      if (noteLevel.has(code)) {
        if (code === 'MISSING_TOTALS') omitTotals = true;
        else {
          const delta = round2(int(50, 900) / 100);
          if (code === 'VAT_TOTAL_MISMATCH') totals.vatDelta = delta;
          if (code === 'SUBTOTAL_MISMATCH') totals.subtotalDelta = delta;
          if (code === 'TOTAL_MISMATCH') totals.totalDelta = delta;
        }
        truth.push({ code, line: null });
        continue;
      }
      if (code === 'DUPLICATE_NOTE') {
        duplicateOf = pick(booked.filter((b) => b.supplier === supplier.name));
        truth.push({ code, line: null });
        continue;
      }
      if (code === 'DUPLICATE_LINE') {
        if (lines.length >= supplier.items.length + 1) continue;
        const i = freeLine();
        if (i === null) continue;
        lines.push({ ...lines[i] });
        usedLines.add(lines.length - 1);
        truth.push({ code, line: lines.length - 1 });
        continue;
      }
      const i = freeLine();
      if (i === null) continue;
      const l = lines[i];
      const base = supplier.items.find((x) => x.sku === l.sku);
      switch (code) {
        case 'PRICE_ABOVE_REFERENCE':
          l.unitPrice = round2(base.unitPrice * (1 + 0.05 + rnd() * 0.25));
          break;
        case 'OVER_DELIVERY':
          l.ordered = Math.max(1, l.qty - int(1, 4));
          break;
        case 'SHORT_DELIVERY':
          l.ordered = l.qty + int(1, 5);
          break;
        case 'BILLED_NOT_RECEIVED':
          l.received = Math.max(0, l.qty - int(1, 3));
          break;
        case 'LINE_TOTAL_MISMATCH':
          l.lineTotal = round2(round2(l.qty * l.unitPrice) + int(50, 500) / 100);
          break;
        case 'VAT_RATE_INVALID':
          l.vatRate = pick([7, 16, 18]);
          break;
        case 'VAT_RATE_CHANGED':
          l.vatRate = pick([4, 10, 21].filter((r) => r !== base.vatRate));
          break;
        default:
          break;
      }
      truth.push({ code, line: i });
    }

    const number = duplicateOf ? duplicateOf.number : `${supplier.prefix}-${70000 + n}`;
    const date = `2026-11-${String(1 + (n % 27)).padStart(2, '0')}`;
    const spec = { supplier: supplier.name, number, date, format, lines, omitTotals };
    // Note-level injections are applied on top of the honest totals the supplier's system would print.
    const honest = renderInputs(spec);
    if (totals.vatDelta) spec.totals = { vat: round2(honest.vat + totals.vatDelta) };
    if (totals.subtotalDelta) spec.totals = { subtotal: round2(honest.subtotal + totals.subtotalDelta), vat: honest.vat };
    if (totals.totalDelta) spec.totals = { total: round2(honest.subtotal + honest.vat + totals.totalDelta) };
    const text = renderNote(spec);
    notes.push({ id: `c${String(n + 1).padStart(3, '0')}`, format, supplier: supplier.name, number, text, truth, duplicateOf: duplicateOf ? duplicateOf.id : null, clean: truth.length === 0 });
    if (!duplicateOf) booked.push({ id: `c${String(n + 1).padStart(3, '0')}`, supplier: supplier.name, number });
  }
  return notes;
}

function renderInputs(spec) {
  const lines = spec.lines.map((l) => ({ ...l, lineTotal: l.lineTotal ?? round2(l.qty * l.unitPrice) }));
  const subtotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0));
  const byRate = new Map();
  for (const l of lines) byRate.set(l.vatRate, (byRate.get(l.vatRate) || 0) + l.lineTotal);
  const vat = round2([...byRate.entries()].reduce((s, [rate, base]) => s + round2((round2(base) * rate) / 100), 0));
  return { subtotal, vat };
}
