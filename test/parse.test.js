import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDeliveryNote, parseDate } from '../src/lib/parse.js';
import { parseNumber, parseRate, round2, detectDecimalComma } from '../src/lib/num.js';
import { adfToText, doc, paragraph, codeBlock, text } from '../src/lib/adf.js';
import { supplierKey, normalizeUnit } from '../src/lib/text.js';

test('numbers in Spanish and English style', () => {
  assert.equal(parseNumber('1.234,56', true), 1234.56);
  assert.equal(parseNumber('1,234.56', false), 1234.56);
  assert.equal(parseNumber('13,90', true), 13.9);
  assert.equal(parseNumber('13.90', true), 13.9);
  assert.equal(parseNumber('1.250', true), 1250);
  assert.equal(parseNumber('1,250', false), 1250);
  assert.equal(parseNumber('€ 12,40', true), 12.4);
  assert.equal(parseNumber('12,40 €', true), 12.4);
  assert.equal(parseNumber('(3,10)', true), -3.1);
  assert.equal(parseNumber('', true), null);
  assert.equal(parseNumber('abc', true), null);
  assert.equal(parseRate('10%'), 10);
  assert.equal(parseRate('0.21', false), 21);
  assert.equal(round2(1.005), 1.01);
  assert.equal(round2(2.775), 2.78);
  assert.equal(round2(-1.005), -1.01);
  assert.equal(detectDecimalComma('12,40 and 3,10'), true);
  assert.equal(detectDecimalComma('12.40 and 3.10'), false);
});

test('dates in the formats suppliers use', () => {
  assert.equal(parseDate('2026-10-27'), '2026-10-27');
  assert.equal(parseDate('27/10/2026'), '2026-10-27');
  assert.equal(parseDate('27-10-26'), '2026-10-27');
  assert.equal(parseDate('27 Oct 2026'), '2026-10-27');
  assert.equal(parseDate('27 de octubre de 2026'), '2026-10-27');
  assert.equal(parseDate('31/02/2026'), null);
  assert.equal(parseDate('soon'), null);
});

test('supplier keys ignore legal suffixes and accents', () => {
  assert.equal(supplierKey('Lácteos Prado Alto S.L.'), 'lacteos-prado-alto');
  assert.equal(supplierKey('LACTEOS PRADO ALTO, SL'), 'lacteos-prado-alto');
  assert.equal(supplierKey('Huerta Valdeluz S.Coop.'), 'huerta-valdeluz');
  assert.equal(supplierKey('Bebidas Cierzo S.A.'), 'bebidas-cierzo');
  assert.equal(normalizeUnit('Cajas'), 'case');
  assert.equal(normalizeUnit('KG'), 'kg');
  assert.equal(normalizeUnit('uds'), 'unit');
});

test('semicolon CSV with Spanish headers and decimal commas', () => {
  const note = parseDeliveryNote(
    [
      'Proveedor: Pescados Rompeolas S.L.',
      'Albarán nº: RP-1',
      'Fecha: 27/10/2026',
      '',
      'Código;Descripción;Pedido;Servido;Ud;Precio;IVA %;Importe',
      'PES-101;Hake fillet, fresh;12;12;kg;13,90;10;166,80',
      'PES-114;Mussels;10;12;kg;3,10;10;37,20',
      '',
      'Base imponible: 204,00',
      'IVA: 20,40',
      'Total: 224,40',
    ].join('\n')
  );
  assert.equal(note.format, 'csv');
  assert.equal(note.supplier, 'Pescados Rompeolas S.L.');
  assert.equal(note.number, 'RP-1');
  assert.equal(note.date, '2026-10-27');
  assert.equal(note.lines.length, 2);
  assert.deepEqual(
    { ...note.lines[0], source: undefined },
    { lineNo: 6, source: undefined, sku: 'PES-101', description: 'Hake fillet, fresh', ordered: 12, qty: 12, received: null, unit: 'kg', unitPrice: 13.9, discountPct: null, vatRate: 10, lineTotal: 166.8 }
  );
  assert.equal(note.lines[0].source, 'PES-101;Hake fillet, fresh;12;12;kg;13,90;10;166,80');
  assert.equal(note.totals.subtotal, 204);
  assert.equal(note.totals.vat, 20.4);
  assert.equal(note.totals.total, 224.4);
  assert.equal(note.totals.sources.total.lineNo, 11);
});

test('comma CSV with quoted descriptions and dot decimals', () => {
  const note = parseDeliveryNote(['SKU,Description,Qty,Unit,Unit price,VAT %,Line total', 'A-1,"Hake, fresh",2,kg,13.90,10,27.80', 'Total: 30.58'].join('\n'));
  assert.equal(note.lines.length, 1);
  assert.equal(note.lines[0].description, 'Hake, fresh');
  assert.equal(note.lines[0].unitPrice, 13.9);
  assert.equal(note.totals.total, 30.58);
});

test('pipe table copied from a PDF, with separator row and per-rate VAT lines', () => {
  const note = parseDeliveryNote(
    [
      'Supplier: Huerta Valdeluz S.Coop.',
      '| Ref | Artículo | Cantidad | Ud | Precio | IVA | Importe |',
      '|---|---|---|---|---|---|---|',
      '| HV-01 | Pear tomatoes | 15 | kg | 1,85 | 4% | 27,75 |',
      '| HV-12 | Onions | 10 | kg | 0,78 | 4% | 7,80 |',
      'IVA (4%): 1,42',
      'Total: 36,97',
    ].join('\n')
  );
  assert.equal(note.format, 'pipe-table');
  assert.equal(note.lines.length, 2);
  assert.equal(note.lines[1].lineTotal, 7.8);
  assert.equal(note.totals.vat, 1.42);
  assert.deepEqual(note.totals.vatByRate, { 4: 1.42 });
});

test('aligned columns with received quantities', () => {
  const note = parseDeliveryNote(
    [
      'Code    Description         Ordered   Delivered   Received   Unit   Price   VAT   Amount',
      'LPA-5   Butter block 1 kg   10        10          8          kg     8.40    10    84.00',
      'LPA-9   Cream 35% 1 L       6         6           6          unit   3.95    10    23.70',
    ].join('\n')
  );
  assert.equal(note.format, 'aligned-table');
  assert.equal(note.lines.length, 2);
  assert.equal(note.lines[0].received, 8);
  assert.equal(note.lines[1].description, 'Cream 35% 1 L');
});

test('rows the parser cannot read are reported, not silently dropped', () => {
  const note = parseDeliveryNote(['sku;description;qty;price;total', 'A;Apples;3;1,00;3,00', 'B;Pears;;;', 'C;Plums;2;oops;'].join('\n'));
  assert.equal(note.lines.length, 1);
  const skipped = note.warnings.filter((w) => w.code === 'PARSE_SKIPPED_LINE').map((w) => w.lineNo);
  assert.deepEqual(skipped, [3, 4]);
});

test('free-text lines with "@" prices', () => {
  const note = parseDeliveryNote(['Supplier: X', '15 kg Onions, brown @ 0,92 = 13,80', '3 kg Lemons @ 1,60 = 4,80 (4%)', 'Total 19,34'].join('\n'));
  assert.equal(note.format, 'free-text');
  assert.equal(note.lines.length, 2);
  assert.equal(note.lines[0].description, 'Onions, brown');
  assert.equal(note.lines[0].unitPrice, 0.92);
  assert.equal(note.lines[1].vatRate, 4);
});

test('JSON notes, as sent by the agent or an MCP client', () => {
  const note = parseDeliveryNote(JSON.stringify({ supplier: { name: 'Y' }, number: 7, date: '02/11/2026', items: [{ description: 'Milk', quantity: '24', price: '0,89', vat: '4%' }], total: 22.21 }));
  assert.equal(note.format, 'json');
  assert.equal(note.number, '7');
  assert.equal(note.date, '2026-11-02');
  assert.equal(note.lines[0].qty, 24);
  assert.equal(note.lines[0].unitPrice, 0.89);
  assert.equal(note.lines[0].vatRate, 4);
});

test('text that is not a delivery note gives zero lines', () => {
  const note = parseDeliveryNote('Hi team, the delivery came at 8. Photo attached. Thanks!');
  assert.equal(note.lines.length, 0);
  assert.equal(note.format, 'unrecognised');
});

test('ADF descriptions become plain text with stable line numbers', () => {
  const adf = doc(paragraph(text('Supplier: X')), codeBlock('a;b;c\n1;2;3'), {
    type: 'table',
    content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph(text('SKU'))] }, { type: 'tableCell', content: [paragraph(text('Qty'))] }] }],
  });
  assert.equal(adfToText(adf), 'Supplier: X\na;b;c\n1;2;3\nSKU | Qty');
  assert.equal(adfToText(null), '');
});
