import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDeliveryNote } from '../src/lib/parse.js';
import { checkDeliveryNote } from '../src/lib/check.js';
import { seedHistory, DEMO_NOTES, N6_AGENT_EXTRACTION, demoNoteText } from '../src/lib/demo.js';
import { supplierKey } from '../src/lib/text.js';
import { formatPct } from '../src/lib/num.js';
import { checkCommentAdf } from '../src/lib/report.js';
import { adfToText } from '../src/lib/adf.js';

const HISTORY = seedHistory();
const historyFor = (name) => HISTORY.filter((e) => e.supplierKey === supplierKey(name));
const scored = (r) => r.discrepancies.filter((d) => d.severity !== 'info');

function run(spec, ctx = {}) {
  const text = demoNoteText(spec);
  const note = parseDeliveryNote(text);
  return checkDeliveryNote(note, { history: historyFor(spec.supplier), ...ctx });
}

for (const spec of DEMO_NOTES) {
  test(`demo note ${spec.id}: ${spec.title}`, () => {
    const ctx = spec.duplicateOfDemo ? { duplicateOf: 'DEMO-1' } : {};
    const r = run(spec, ctx);
    const text = demoNoteText(spec);
    const sourceLines = text.split('\n');
    const lineNos = r.lines.map((l) => l.lineNo);
    const got = scored(r)
      .map((d) => ({ code: d.code, line: lineNos.includes(d.lineNo) ? lineNos.indexOf(d.lineNo) : null }))
      .sort((a, b) => a.code.localeCompare(b.code));
    const want = spec.expected.codes.slice().sort((a, b) => a.code.localeCompare(b.code));
    assert.deepEqual(got, want);
    assert.equal(r.status, spec.expected.status);
    assert.equal(r.amountInDispute, spec.expected.amountInDispute);
    for (const inf of spec.expected.info || []) {
      assert.ok(r.discrepancies.some((d) => d.code === inf.code && (inf.line === null || lineNos.indexOf(d.lineNo) === inf.line)), `missing info ${inf.code}`);
    }
    // Every line-level discrepancy quotes the exact source line it came from.
    for (const d of r.discrepancies) {
      if (d.lineNo !== null && d.source) assert.equal(d.source, sourceLines[d.lineNo - 1].trim());
    }
  });
}

test('a clean note is OK only when its totals were checked', () => {
  const r = checkDeliveryNote(parseDeliveryNote(['Supplier: Bebidas Cierzo S.A.', 'SKU;Description;Qty;Unit;Price;VAT;Total', 'BC-330;Lager beer 33cl x24;1;case;21,60;21;21,60'].join('\n')), { history: historyFor('Bebidas Cierzo S.A.') });
  assert.equal(r.status, 'REVIEW');
  assert.deepEqual(scored(r).map((d) => d.code), ['MISSING_TOTALS']);
});

test('price threshold is configurable', () => {
  const spec = DEMO_NOTES[0];
  const strict = run(spec, { settings: { priceThresholdPct: 3 } });
  const loose = run(spec, { settings: { priceThresholdPct: 6 } });
  assert.ok(strict.discrepancies.some((d) => d.code === 'PRICE_ABOVE_REFERENCE'));
  assert.ok(!loose.discrepancies.some((d) => d.code === 'PRICE_ABOVE_REFERENCE'));
  // Sea bass is +1.8%: under both thresholds.
  const zero = run(spec, { settings: { priceThresholdPct: 0 } });
  assert.equal(zero.discrepancies.filter((d) => d.code === 'PRICE_ABOVE_REFERENCE').length, 2);
});

test('an agreed price list beats history', () => {
  const r = run(DEMO_NOTES[0], { priceList: [{ sku: 'PES-101', unitPrice: 13.9, unit: 'kg', vatRate: 10 }] });
  const hake = r.lines.find((l) => l.sku === 'PES-101');
  assert.equal(hake.reference.source, 'agreed');
  assert.ok(!r.discrepancies.some((d) => d.code === 'PRICE_ABOVE_REFERENCE' && d.sku === 'PES-101'));
});

test('the note being re-checked never becomes its own reference', () => {
  const own = [{ supplierKey: 'pescados-rompeolas', itemKey: 'sku-pes-101', sku: 'PES-101', description: 'Hake fillet, fresh', unit: 'kg', unitPrice: 13.9, vatRate: 10, date: '2026-10-27', issueKey: 'DEMO-1', status: 'accepted' }];
  const r = run(DEMO_NOTES[0], { history: [...historyFor('Pescados Rompeolas S.L.'), ...own], issueKey: 'DEMO-1' });
  assert.equal(r.lines[0].reference.unitPrice, 13.2);
});

test('disputed history entries are never used as a reference', () => {
  const disputed = [{ supplierKey: 'pescados-rompeolas', itemKey: 'sku-pes-101', sku: 'PES-101', description: 'Hake fillet, fresh', unit: 'kg', unitPrice: 15, vatRate: 10, date: '2026-10-25', issueKey: 'DEMO-9', status: 'disputed' }];
  const r = run(DEMO_NOTES[0], { history: [...historyFor('Pescados Rompeolas S.L.'), ...disputed] });
  assert.equal(r.lines[0].reference.unitPrice, 13.2);
});

test('a unit change skips the price comparison and says so', () => {
  const text = ['Supplier: Pescados Rompeolas S.L.', 'SKU;Description;Qty;Unit;Price;VAT;Total', 'PES-101;Hake fillet, fresh;3;case;40,00;10;120,00', 'Total: 132,00'].join('\n');
  const r = checkDeliveryNote(parseDeliveryNote(text), { history: historyFor('Pescados Rompeolas S.L.') });
  assert.deepEqual(scored(r).map((d) => d.code), ['UNIT_CHANGED']);
  assert.equal(r.status, 'REVIEW');
});

test('short delivery is flagged but costs nothing', () => {
  const text = ['Supplier: Huerta Valdeluz S.Coop.', 'SKU;Description;Ordered;Qty;Unit;Price;VAT;Total', 'HV-20;Lemons;10;6;kg;1,60;4;9,60', 'Total: 9,98'].join('\n');
  const r = checkDeliveryNote(parseDeliveryNote(text), { history: historyFor('Huerta Valdeluz S.Coop.') });
  const short = r.discrepancies.find((d) => d.code === 'SHORT_DELIVERY');
  assert.equal(short.amount, 0);
  assert.equal(short.missingValue, 6.4);
  assert.equal(r.amountInDispute, 0);
  assert.equal(r.status, 'REVIEW');
});

test('item listed twice on one note', () => {
  const text = ['Supplier: Huerta Valdeluz S.Coop.', 'SKU;Description;Qty;Unit;Price;VAT;Total', 'HV-20;Lemons;2;kg;1,60;4;3,20', 'HV-20;Lemons;2;kg;1,60;4;3,20', 'Total: 6,66'].join('\n');
  const r = checkDeliveryNote(parseDeliveryNote(text), { history: historyFor('Huerta Valdeluz S.Coop.') });
  assert.deepEqual(scored(r).map((d) => d.code), ['DUPLICATE_LINE']);
});

test('agent extraction: every quoted line is checked against the original note', () => {
  const n6 = DEMO_NOTES.find((n) => n.id === 'n6-free-text');
  const original = demoNoteText(n6);
  const r = checkDeliveryNote(parseDeliveryNote(N6_AGENT_EXTRACTION), { history: historyFor(n6.supplier), originalText: original });
  assert.deepEqual(scored(r).map((d) => d.code), ['PRICE_ABOVE_REFERENCE']);
  assert.equal(r.lineCount, 3);
  assert.equal(r.status, 'DISPUTE');
  assert.equal(r.amountInDispute, 2.19);
});

test('agent extraction: an invented line is caught', () => {
  const n6 = DEMO_NOTES.find((n) => n.id === 'n6-free-text');
  const invented = { ...N6_AGENT_EXTRACTION, lines: [...N6_AGENT_EXTRACTION.lines, { lineNo: 7, source: '2 bunch Flat parsley @ 0,60 = 1,20', description: 'Flat parsley', qty: 2, unit: 'bunch', unitPrice: 0.6, vatRate: 4, lineTotal: 1.2 }] };
  const r = checkDeliveryNote(parseDeliveryNote(invented), { history: historyFor(n6.supplier), originalText: demoNoteText(n6) });
  const codes = scored(r).map((d) => d.code);
  assert.ok(codes.includes('UNVERIFIED_SOURCE'));
  assert.ok(codes.includes('SUBTOTAL_MISMATCH'));
  const flagged = r.lines.find((l) => l.description === 'Flat parsley');
  assert.ok(flagged.flags.includes('UNVERIFIED_SOURCE'));
});

test('agent extraction: a changed number inside a real quote is caught', () => {
  const n6 = DEMO_NOTES.find((n) => n.id === 'n6-free-text');
  const tampered = { ...N6_AGENT_EXTRACTION, lines: N6_AGENT_EXTRACTION.lines.map((l, i) => (i === 0 ? { ...l, qty: 16 } : l)) };
  const r = checkDeliveryNote(parseDeliveryNote(tampered), { history: historyFor(n6.supplier), originalText: demoNoteText(n6) });
  const d = r.discrepancies.find((x) => x.code === 'UNVERIFIED_SOURCE');
  assert.match(d.message, /quantity 16/);
});

test('same input, same output', () => {
  const a = run(DEMO_NOTES[3]);
  const b = run(DEMO_NOTES[3]);
  assert.deepEqual(a, b);
});

test('the price change on a line matches the one in its finding', () => {
  // Onions at 0.92 against 0.78 is +17.949...%: rounding to 2 decimals first and then to 1 showed +18.0% in the
  // line table while the finding said +17.9%.
  for (const spec of DEMO_NOTES) {
    const r = run(spec, spec.duplicateOfDemo ? { duplicateOf: 'DEMO-1' } : {});
    for (const d of r.discrepancies.filter((x) => x.code === 'PRICE_ABOVE_REFERENCE')) {
      const line = r.lines.find((l) => l.lineNo === d.lineNo);
      assert.equal(formatPct(line.priceDeltaPct), formatPct(d.deltaPct), `${spec.id} line ${d.lineNo}`);
      assert.ok(d.message.includes(formatPct(line.priceDeltaPct)), `${spec.id} line ${d.lineNo}`);
    }
  }
});

test('the Dockside comment never doubles the full stop after a supplier name', () => {
  // "Pescados Rompeolas S.L." already ends with one; a supplier without a suffix still gets one.
  const withDot = adfToText(checkCommentAdf(run(DEMO_NOTES[0])));
  assert.ok(withDot.startsWith('Dockside checked delivery note RP-24117 from Pescados Rompeolas S.L. 2 things need a look'), withDot.slice(0, 120));
  assert.ok(!withDot.includes('..'));
  const text = ['Supplier: Mercado Central', 'SKU;Description;Qty;Unit;Price;VAT;Total', 'X-1;Salt;1;kg;1,00;10;1,00', 'Total: 1,10'].join('\n');
  const noDot = adfToText(checkCommentAdf(checkDeliveryNote(parseDeliveryNote(text))));
  assert.ok(noDot.startsWith('Dockside checked this delivery note from Mercado Central. '), noDot.slice(0, 120));
});

test('a supplier typed in capitals shows under the name already known for it', () => {
  const n6 = DEMO_NOTES.find((n) => n.id === 'n6-free-text');
  const note = parseDeliveryNote(demoNoteText(n6));
  assert.equal(note.supplier, 'HUERTA VALDELUZ S.COOP.');
  const r = checkDeliveryNote(note, { history: historyFor(n6.supplier) });
  assert.deepEqual(r.supplier, { name: 'Huerta Valdeluz S.Coop.', key: 'huerta-valdeluz' });
  // The quote of what was actually written stays in the finding.
  assert.equal(r.discrepancies.find((d) => d.code === 'SUPPLIER_GUESSED').source, 'HUERTA VALDELUZ S.COOP.');
  // Another supplier's history never renames it, and with no history the name is shown as written.
  assert.equal(checkDeliveryNote(note, { history: historyFor('Bebidas Cierzo S.A.') }).supplier.name, 'HUERTA VALDELUZ S.COOP.');
  assert.equal(checkDeliveryNote(note).supplier.name, 'HUERTA VALDELUZ S.COOP.');
});
