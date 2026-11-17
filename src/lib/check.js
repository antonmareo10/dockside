// The Dockside check engine. Deterministic: the same note, history and
// settings always give the same result. Every discrepancy cites the source
// line it came from and the money at stake. Pure functions.

import { approxEqual, formatMoney, formatPct, formatQty, numbersIn, round2, roundN } from './num.js';
import { findReference, itemKeyFor, unitsDiffer } from './history.js';
import { looseText, supplierKey } from './text.js';

export const ENGINE_VERSION = '1.0.0';

export const DEFAULT_SETTINGS = Object.freeze({
  priceThresholdPct: 3,
  allowedVatRates: [4, 10, 21],
  lineTolerance: 0.01,
  totalsTolerance: 0.02,
  currency: 'EUR',
});

export const CODES = Object.freeze({
  PRICE_ABOVE_REFERENCE: 'Price above reference',
  OVER_DELIVERY: 'More than ordered',
  BILLED_NOT_RECEIVED: 'Billed but not received',
  SHORT_DELIVERY: 'Short delivery',
  LINE_TOTAL_MISMATCH: 'Line total does not add up',
  VAT_RATE_INVALID: 'Invalid VAT rate',
  VAT_RATE_CHANGED: 'VAT rate changed',
  VAT_RATE_MISSING: 'VAT rate missing',
  VAT_TOTAL_MISMATCH: 'VAT total does not add up',
  SUBTOTAL_MISMATCH: 'Subtotal does not add up',
  TOTAL_MISMATCH: 'Total does not add up',
  MISSING_TOTALS: 'No total to check',
  DUPLICATE_NOTE: 'Duplicate delivery note',
  DUPLICATE_LINE: 'Item listed twice',
  UNIT_CHANGED: 'Unit changed',
  NO_PRICE_HISTORY: 'New item',
  PRICE_BELOW_REFERENCE: 'Price below reference',
  UNVERIFIED_SOURCE: 'Extraction not verified',
  UNREADABLE: 'Nothing could be read',
  MISSING_SUPPLIER: 'Supplier not found',
  PARSE_SKIPPED_LINE: 'Row skipped',
  SUPPLIER_GUESSED: 'Supplier guessed',
  PRICE_DERIVED: 'Price derived from total',
});

export function normalizeSettings(raw = {}) {
  const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  const t = Number(s.priceThresholdPct);
  s.priceThresholdPct = Number.isFinite(t) && t >= 0 && t <= 100 ? t : DEFAULT_SETTINGS.priceThresholdPct;
  if (!Array.isArray(s.allowedVatRates) || !s.allowedVatRates.length) s.allowedVatRates = [...DEFAULT_SETTINGS.allowedVatRates];
  s.allowedVatRates = s.allowedVatRates.map(Number).filter((n) => Number.isFinite(n));
  return s;
}

const unitLabel = (u) => (u ? ` ${u}` : '');

function refText(ref) {
  if (!ref) return '';
  if (ref.source === 'agreed') return 'agreed price list';
  const parts = [];
  if (ref.noteNumber) parts.push(`note ${ref.noteNumber}`);
  if (ref.date) parts.push(`on ${ref.date}`);
  if (ref.issueKey) parts.push(`(${ref.issueKey})`);
  return parts.join(' ') || 'price history';
}

function vatBreakdown(rows, rateOf, baseOf) {
  const byRate = new Map();
  for (const r of rows) {
    const rate = rateOf(r);
    if (rate === null || rate === undefined) return null;
    byRate.set(rate, (byRate.get(rate) || 0) + baseOf(r));
  }
  let vat = 0;
  const breakdown = [];
  for (const [rate, base] of [...byRate.entries()].sort((a, b) => a[0] - b[0])) {
    const amount = round2((round2(base) * rate) / 100);
    breakdown.push({ rate, base: round2(base), vat: amount });
    vat += amount;
  }
  return { vat: round2(vat), breakdown };
}

// The name this supplier is already known by: the one on its oldest price history entry. A note typed as
// "HUERTA VALDELUZ S.COOP." then shows as "Huerta Valdeluz S.Coop.". Matching always uses the key, never the name.
function knownSupplierName(key, history) {
  let first = null;
  for (const e of history) {
    if (e.supplierKey !== key || !e.supplierName) continue;
    const older = first && ((e.date || '').localeCompare(first.date || '') || (e.recordedAt || '').localeCompare(first.recordedAt || '')) < 0;
    if (!first || older) first = e;
  }
  return first?.supplierName ?? null;
}

/**
 * Check one parsed delivery note.
 * @param {object} note output of parseDeliveryNote
 * @param {object} ctx
 * @param {Array} [ctx.history] accepted/disputed price entries for this supplier
 * @param {Array} [ctx.priceList] agreed prices for this supplier
 * @param {object} [ctx.settings] overrides for DEFAULT_SETTINGS
 * @param {string|null} [ctx.duplicateOf] issue key where the same supplier + note number was already booked
 * @param {string|null} [ctx.originalText] original document text, used to verify agent extractions
 * @param {string|null} [ctx.issueKey] issue being checked
 */
export function checkDeliveryNote(note, ctx = {}) {
  const settings = normalizeSettings(ctx.settings);
  const history = ctx.history || [];
  const priceList = ctx.priceList || [];
  const discrepancies = [];
  const push = (d) => {
    discrepancies.push({
      id: `D${discrepancies.length + 1}`,
      severity: 'warning',
      lineNo: null,
      source: null,
      sku: null,
      description: null,
      expected: null,
      actual: null,
      amount: 0,
      disputable: false,
      ...d,
      title: CODES[d.code] ?? d.code,
    });
  };

  const supplier = { name: note.supplier ?? null, key: note.supplier ? supplierKey(note.supplier) : 'unknown-supplier' };
  if (note.supplier) supplier.name = knownSupplierName(supplier.key, history) ?? note.supplier;

  for (const w of note.warnings || []) {
    push({
      code: w.code,
      severity: w.code === 'SUPPLIER_GUESSED' ? 'info' : 'warning',
      lineNo: w.lineNo ?? null,
      source: w.source ?? null,
      message: w.message,
    });
  }

  if (!note.lines?.length) {
    push({
      code: 'UNREADABLE',
      severity: 'warning',
      message: 'No item lines could be read from this note. Dockside never marks a note OK without reading it.',
    });
    return finalize({ note, settings, supplier, discrepancies, lines: [], totals: null, amountInDispute: 0, disputeBasis: 'gross', ctx });
  }

  if (!note.supplier) {
    push({ code: 'MISSING_SUPPLIER', severity: 'warning', message: 'No supplier name found, so prices were not compared with history.' });
  }

  // ---- verify extracted lines against the original document (agent / MCP path)
  const verify = note.format === 'json' && typeof ctx.originalText === 'string' && ctx.originalText.trim().length > 0;
  const docLoose = verify ? looseText(ctx.originalText) : '';
  const unverified = new Set();
  if (verify) {
    note.lines.forEach((l, i) => {
      if (!l.source) {
        unverified.add(i);
        push({ code: 'UNVERIFIED_SOURCE', lineNo: l.lineNo, sku: l.sku, description: l.description, message: 'This line came without a quote from the note, so it could not be verified.' });
        return;
      }
      if (!docLoose.includes(looseText(l.source))) {
        unverified.add(i);
        push({ code: 'UNVERIFIED_SOURCE', lineNo: l.lineNo, source: l.source, sku: l.sku, description: l.description, message: 'The quoted text was not found in the original note.' });
        return;
      }
      const nums = numbersIn(l.source);
      const has = (v) => v === null || v === undefined || nums.some((n) => Math.abs(n - v) < 0.0005);
      const missing = [];
      if (!has(l.qty)) missing.push(`quantity ${formatQty(l.qty)}`);
      if (!has(l.unitPrice)) missing.push(`price ${l.unitPrice}`);
      if (l.lineTotal !== null && !has(l.lineTotal)) missing.push(`total ${l.lineTotal}`);
      if (missing.length) {
        unverified.add(i);
        push({ code: 'UNVERIFIED_SOURCE', lineNo: l.lineNo, source: l.source, sku: l.sku, description: l.description, message: `The quoted line does not contain the extracted ${missing.join(' and ')}.` });
      }
    });
  }

  // ---- duplicate items on the same note
  const seenItems = new Map();
  note.lines.forEach((l) => {
    const k = itemKeyFor(l);
    if (seenItems.has(k)) {
      push({
        code: 'DUPLICATE_LINE',
        lineNo: l.lineNo,
        source: l.source,
        sku: l.sku,
        description: l.description,
        message: `${l.description ?? l.sku} also appears on line ${seenItems.get(k)}. Check it was not billed twice.`,
      });
    } else seenItems.set(k, l.lineNo);
  });

  const singleTotalsRate = Object.keys(note.totals?.vatByRate || {}).length === 1 ? Number(Object.keys(note.totals.vatByRate)[0]) : null;

  // ---- per line
  const lines = note.lines.map((l, i) => {
    const flags = [];
    const out = { ...l, flags, reference: null, priceDeltaPct: null };
    const disc = l.discountPct ? l.discountPct / 100 : 0;
    let price = l.unitPrice;
    if (price === null && l.lineTotal !== null && l.qty) {
      price = roundN(l.lineTotal / l.qty / (1 - disc || 1), 4);
      out.unitPrice = price;
      flags.push('PRICE_DERIVED');
      push({ code: 'PRICE_DERIVED', severity: 'info', lineNo: l.lineNo, source: l.source, sku: l.sku, description: l.description, message: `No unit price on the line; ${price} worked out from the line total.` });
    }
    if (unverified.has(i)) flags.push('UNVERIFIED_SOURCE');
    const base = { lineNo: l.lineNo, source: l.source, sku: l.sku, description: l.description };
    const item = l.description ?? l.sku;

    const computedNet = round2(l.qty * price * (1 - disc));
    const billedNet = l.lineTotal !== null ? l.lineTotal : computedNet;
    out.computedTotal = computedNet;
    out.billedTotal = billedNet;

    if (l.lineTotal !== null && !approxEqual(l.lineTotal, computedNet, settings.lineTolerance)) {
      const amount = round2(l.lineTotal - computedNet);
      flags.push('LINE_TOTAL_MISMATCH');
      push({
        ...base,
        code: 'LINE_TOTAL_MISMATCH',
        severity: amount > 0 ? 'error' : 'warning',
        expected: computedNet,
        actual: l.lineTotal,
        amount,
        disputable: amount > 0,
        message: `${formatQty(l.qty)} x ${formatMoney(price)}${disc ? ` less ${l.discountPct}%` : ''} = ${formatMoney(computedNet)}, but the line says ${formatMoney(l.lineTotal)}.`,
      });
    }

    // quantities
    const capOrdered = l.ordered !== null && l.ordered !== undefined ? Math.min(l.qty, l.ordered) : l.qty;
    const fairQty = l.received !== null && l.received !== undefined ? Math.min(capOrdered, l.received) : capOrdered;
    const unitNet = price * (1 - disc);
    if (l.ordered !== null && l.ordered !== undefined) {
      if (l.qty > l.ordered + 1e-9) {
        const amount = round2((l.qty - l.ordered) * unitNet);
        flags.push('OVER_DELIVERY');
        push({ ...base, code: 'OVER_DELIVERY', severity: 'error', expected: l.ordered, actual: l.qty, amount, disputable: amount > 0, message: `Billed ${formatQty(l.qty)}${unitLabel(l.unit)} of ${item}, but only ${formatQty(l.ordered)} were ordered.` });
      } else if (l.qty < l.ordered - 1e-9) {
        const missingValue = round2((l.ordered - l.qty) * unitNet);
        flags.push('SHORT_DELIVERY');
        push({ ...base, code: 'SHORT_DELIVERY', severity: 'warning', expected: l.ordered, actual: l.qty, amount: 0, missingValue, message: `Ordered ${formatQty(l.ordered)}${unitLabel(l.unit)}, delivered ${formatQty(l.qty)}. ${formatMoney(missingValue)} of goods still to come or to reorder.` });
      }
    }
    if (l.received !== null && l.received !== undefined && l.received < capOrdered - 1e-9) {
      const amount = round2((capOrdered - fairQty) * unitNet);
      flags.push('BILLED_NOT_RECEIVED');
      push({ ...base, code: 'BILLED_NOT_RECEIVED', severity: 'error', expected: l.received, actual: l.qty, amount, disputable: amount > 0, message: `Billed ${formatQty(l.qty)}${unitLabel(l.unit)} of ${item}, but ${formatQty(l.received)} were counted at the door.` });
    }

    // price against reference
    let fairPrice = price;
    const ref = note.supplier ? findReference({ line: l, history, priceList, noteDate: note.date, issueKey: ctx.issueKey ?? null }) : null;
    out.reference = ref;
    if (ref) {
      if (unitsDiffer(l.unit, ref.unit)) {
        flags.push('UNIT_CHANGED');
        push({ ...base, code: 'UNIT_CHANGED', severity: 'warning', expected: ref.unit, actual: l.unit, message: `Unit changed from ${ref.unit} to ${l.unit} since ${refText(ref)}, so the price was not compared.` });
      } else if (ref.unitPrice > 0 && price !== null) {
        const deltaPct = ((price - ref.unitPrice) / ref.unitPrice) * 100;
        out.priceDeltaPct = roundN(deltaPct, 1);
        if (deltaPct > settings.priceThresholdPct + 1e-9) {
          fairPrice = ref.unitPrice;
          const amount = round2((price - ref.unitPrice) * fairQty * (1 - disc));
          flags.push('PRICE_ABOVE_REFERENCE');
          push({
            ...base,
            code: 'PRICE_ABOVE_REFERENCE',
            severity: 'error',
            expected: ref.unitPrice,
            actual: price,
            amount,
            disputable: amount > 0,
            deltaPct: roundN(deltaPct, 1),
            referenceSource: ref.source,
            referenceDate: ref.date,
            referenceIssueKey: ref.issueKey,
            referenceNote: ref.noteNumber,
            message: `Billed ${formatMoney(price)}${l.unit ? `/${l.unit}` : ''} for ${item}; the reference is ${formatMoney(ref.unitPrice)} from ${refText(ref)}. That is ${formatPct(deltaPct)}, over the ${settings.priceThresholdPct}% threshold.`,
          });
        } else if (deltaPct < -settings.priceThresholdPct - 1e-9) {
          flags.push('PRICE_BELOW_REFERENCE');
          push({ ...base, code: 'PRICE_BELOW_REFERENCE', severity: 'info', expected: ref.unitPrice, actual: price, deltaPct: roundN(deltaPct, 1), message: `${item} is ${formatPct(deltaPct)} against the reference of ${formatMoney(ref.unitPrice)} from ${refText(ref)}.` });
        }
      }
    } else if (note.supplier) {
      flags.push('NO_PRICE_HISTORY');
      push({ ...base, code: 'NO_PRICE_HISTORY', severity: 'info', message: `First time ${item} appears for this supplier. Its price becomes the reference once the note is approved.` });
    }

    // VAT
    let rate = l.vatRate;
    if ((rate === null || rate === undefined) && singleTotalsRate !== null) {
      rate = singleTotalsRate;
      out.vatRate = rate;
      flags.push('VAT_RATE_FROM_TOTALS');
    }
    let fairRate = rate;
    if (rate === null || rate === undefined) {
      flags.push('VAT_RATE_MISSING');
      push({ ...base, code: 'VAT_RATE_MISSING', severity: 'warning', message: 'No VAT rate on this line, so its VAT could not be checked.' });
    } else if (!settings.allowedVatRates.includes(rate)) {
      const refRate = ref?.vatRate ?? null;
      const knownRef = refRate !== null && settings.allowedVatRates.includes(refRate);
      if (knownRef) fairRate = refRate;
      const amount = knownRef ? round2((billedNet * (rate - refRate)) / 100) : 0;
      flags.push('VAT_RATE_INVALID');
      push({
        ...base,
        code: 'VAT_RATE_INVALID',
        severity: 'error',
        expected: knownRef ? refRate : settings.allowedVatRates.join('/'),
        actual: rate,
        amount,
        disputable: amount > 0,
        message: `VAT rate ${rate}% is not one of the allowed rates (${settings.allowedVatRates.join(', ')}%).${knownRef ? ` This supplier charged ${refRate}% for it before.` : ''}`,
      });
    } else if (ref?.vatRate !== null && ref?.vatRate !== undefined && ref.vatRate !== rate) {
      const amount = round2((billedNet * (rate - ref.vatRate)) / 100);
      flags.push('VAT_RATE_CHANGED');
      push({ ...base, code: 'VAT_RATE_CHANGED', severity: 'warning', expected: ref.vatRate, actual: rate, amount, disputable: false, message: `Charged ${rate}% VAT on ${item}; this supplier charged ${ref.vatRate}% last time (${refText(ref)}). Worth a look: ${formatMoney(Math.abs(amount))} of VAT.` });
    }

    out.vatRate = rate ?? null;
    out.fairQty = roundN(fairQty, 3);
    out.fairPrice = fairPrice;
    out.fairRate = fairRate ?? null;
    out.fairTotal = round2(fairQty * fairPrice * (1 - disc));
    return out;
  });

  // ---- note level totals
  const tol = settings.totalsTolerance;
  const computedSubtotal = round2(lines.reduce((s, l) => s + l.billedTotal, 0));
  const computedVatInfo = vatBreakdown(lines, (l) => l.vatRate, (l) => l.billedTotal);
  const computedVat = computedVatInfo ? computedVatInfo.vat : null;
  const stated = note.totals || {};
  const freeText = note.format === 'free-text';

  if (stated.subtotal !== null && stated.subtotal !== undefined && !approxEqual(stated.subtotal, computedSubtotal, tol)) {
    const amount = round2(stated.subtotal - computedSubtotal);
    const severity = amount > 0 && !freeText ? 'error' : 'warning';
    push({
      code: 'SUBTOTAL_MISMATCH',
      severity,
      lineNo: stated.sources?.subtotal?.lineNo ?? null,
      source: stated.sources?.subtotal?.source ?? null,
      expected: computedSubtotal,
      actual: stated.subtotal,
      amount,
      disputable: severity === 'error',
      message: freeText
        ? `The lines Dockside read add up to ${formatMoney(computedSubtotal)}, but the note says ${formatMoney(stated.subtotal)}. A line may not have been read; check the note.`
        : `Subtotal on the note is ${formatMoney(stated.subtotal)}; the lines add up to ${formatMoney(computedSubtotal)}.`,
    });
  }
  if (stated.vat !== null && stated.vat !== undefined && computedVat !== null && !approxEqual(stated.vat, computedVat, tol)) {
    const amount = round2(stated.vat - computedVat);
    push({
      code: 'VAT_TOTAL_MISMATCH',
      severity: amount > 0 && !freeText ? 'error' : 'warning',
      lineNo: stated.sources?.vat?.lineNo ?? null,
      source: stated.sources?.vat?.source ?? null,
      expected: computedVat,
      actual: stated.vat,
      amount,
      disputable: amount > 0 && !freeText,
      message: `VAT on the note is ${formatMoney(stated.vat)}; VAT on the lines is ${formatMoney(computedVat)} (${computedVatInfo.breakdown.map((b) => `${b.rate}% of ${formatMoney(b.base)}`).join(', ')}).`,
    });
  }
  const subForTotal = stated.subtotal ?? computedSubtotal;
  const vatForTotal = stated.vat ?? computedVat;
  if (stated.total !== null && stated.total !== undefined) {
    if (vatForTotal !== null && !approxEqual(stated.total, round2(subForTotal + vatForTotal), tol)) {
      const expected = round2(subForTotal + vatForTotal);
      const amount = round2(stated.total - expected);
      push({
        code: 'TOTAL_MISMATCH',
        severity: amount > 0 && !freeText ? 'error' : 'warning',
        lineNo: stated.sources?.total?.lineNo ?? null,
        source: stated.sources?.total?.source ?? null,
        expected,
        actual: stated.total,
        amount,
        disputable: amount > 0 && !freeText,
        message: `Total on the note is ${formatMoney(stated.total)}; subtotal plus VAT is ${formatMoney(expected)}.`,
      });
    }
  } else {
    push({ code: 'MISSING_TOTALS', severity: 'warning', message: 'The note has no total, so the sum could not be checked.' });
  }

  const billedSubtotal = stated.subtotal ?? computedSubtotal;
  const billedVat = stated.vat ?? computedVat;
  const billedTotal = stated.total ?? (billedVat !== null ? round2(billedSubtotal + billedVat) : null);

  const fairSubtotal = round2(lines.reduce((s, l) => s + l.fairTotal, 0));
  const fairVatInfo = vatBreakdown(lines, (l) => l.fairRate, (l) => l.fairTotal);
  const fairVat = fairVatInfo ? fairVatInfo.vat : null;
  const fairTotal = fairVat !== null ? round2(fairSubtotal + fairVat) : null;

  // Money in dispute = what each line overcharges, the VAT on that, and any
  // overcharge in the note's own arithmetic. Built from the lines that were
  // read, so a line the parser missed can never inflate it.
  const lineDisputeNet = round2(lines.reduce((s, l) => s + (l.billedTotal - l.fairTotal), 0));
  const vatDiff = computedVat !== null && fairVat !== null ? round2(computedVat - fairVat) : 0;
  const arithmetic = round2(
    discrepancies
      .filter((d) => d.disputable && ['SUBTOTAL_MISMATCH', 'VAT_TOTAL_MISMATCH', 'TOTAL_MISMATCH'].includes(d.code))
      .reduce((s, d) => s + d.amount, 0)
  );
  let amountInDispute = Math.max(0, round2(lineDisputeNet + vatDiff + arithmetic));
  let disputeBasis = computedVat !== null && fairVat !== null ? 'gross' : 'net';

  if (ctx.duplicateOf) {
    push({
      code: 'DUPLICATE_NOTE',
      severity: 'error',
      actual: note.number,
      amount: billedSubtotal,
      disputable: true,
      message: `Note ${note.number} from ${supplier.name ?? 'this supplier'} was already booked in ${ctx.duplicateOf}. Paying it again would pay twice.`,
    });
    amountInDispute = billedTotal ?? billedSubtotal;
    disputeBasis = billedTotal !== null ? 'gross' : 'net';
  }

  const totals = {
    billed: { subtotal: billedSubtotal, vat: billedVat, total: billedTotal },
    computed: { subtotal: computedSubtotal, vat: computedVat, total: computedVat !== null ? round2(computedSubtotal + computedVat) : null, vatBreakdown: computedVatInfo?.breakdown ?? null },
    fair: { subtotal: fairSubtotal, vat: fairVat, total: fairTotal },
    stated: { subtotal: stated.subtotal ?? null, vat: stated.vat ?? null, total: stated.total ?? null },
  };
  return finalize({ note, settings, supplier, discrepancies, lines, totals, amountInDispute, disputeBasis, ctx });
}

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

function finalize({ note, settings, supplier, discrepancies, lines, totals, amountInDispute, disputeBasis, ctx }) {
  discrepancies.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.lineNo ?? 1e9) - (b.lineNo ?? 1e9));
  discrepancies.forEach((d, i) => {
    d.id = `D${i + 1}`;
  });
  const counts = { error: 0, warning: 0, info: 0 };
  for (const d of discrepancies) counts[d.severity] += 1;
  let status;
  if (!lines.length) status = 'UNREADABLE';
  else if (counts.error > 0 || amountInDispute > 0.005) status = 'DISPUTE';
  else if (counts.warning > 0) status = 'REVIEW';
  else status = 'OK';

  const fmt = (v) => formatMoney(v, settings.currency);
  let summary;
  if (status === 'UNREADABLE') summary = 'Nothing could be read from this note, so nothing was checked.';
  else if (status === 'OK') summary = `All ${lines.length} lines match price history, quantities, VAT and totals.`;
  else {
    const n = counts.error + counts.warning;
    summary = `${n} ${n === 1 ? 'thing needs' : 'things need'} a look across ${lines.length} lines`;
    if (amountInDispute > 0.005) summary += `, ${fmt(amountInDispute)} in dispute${disputeBasis === 'gross' ? ' incl. VAT' : ' before VAT'}`;
    summary += '.';
  }

  return {
    engineVersion: ENGINE_VERSION,
    status,
    summary,
    supplier,
    number: note.number ?? null,
    date: note.date ?? null,
    po: note.po ?? null,
    format: note.format,
    lineCount: lines.length,
    amountInDispute: round2(amountInDispute),
    disputeBasis,
    counts,
    discrepancies,
    lines,
    totals,
    settings: { priceThresholdPct: settings.priceThresholdPct, allowedVatRates: settings.allowedVatRates, currency: settings.currency },
    issueKey: ctx.issueKey ?? null,
  };
}
