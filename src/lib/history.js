// Supplier price history: how Dockside decides what a line "should" cost.
// Reference order: an agreed price list entry first, then the most recent
// accepted delivery note for the same item. Pure functions.

import { round2, roundN } from './num.js';
import { jaccard, normalize, normalizeUnit, slug, supplierKey } from './text.js';

export const FUZZY_MATCH_MIN = 0.75;

export function itemKeyFor(line) {
  if (line.sku) return `sku-${slug(line.sku)}`;
  return `desc-${slug(normalize(line.description))}`;
}

/**
 * Find which known item a line refers to. Exact SKU first, then exact
 * description, then token overlap (Jaccard >= 0.75) on the description.
 */
export function matchItem(line, entries) {
  if (!entries?.length) return null;
  const key = itemKeyFor(line);
  const exact = entries.filter((e) => e.itemKey === key);
  if (exact.length) return { itemKey: key, how: line.sku ? 'sku' : 'description' };
  if (line.description) {
    const nd = normalize(line.description);
    const byDesc = entries.find((e) => normalize(e.description) === nd);
    if (byDesc) return { itemKey: byDesc.itemKey, how: 'description' };
    let best = null;
    for (const e of entries) {
      const score = jaccard(line.description, e.description);
      if (score >= FUZZY_MATCH_MIN && (!best || score > best.score)) best = { itemKey: e.itemKey, score };
    }
    if (best) return { itemKey: best.itemKey, how: 'similar-description', score: roundN(best.score, 2) };
  }
  return null;
}

const byDateDesc = (a, b) => (b.date || '').localeCompare(a.date || '') || (b.recordedAt || '').localeCompare(a.recordedAt || '');

/**
 * Reference price for a line.
 * @param {object} args
 * @param {object} args.line parsed line
 * @param {Array} args.history entries for this supplier: {itemKey, sku, description, unit, unitPrice, vatRate, date, issueKey, noteNumber, status}
 * @param {Array} [args.priceList] agreed prices for this supplier: {itemKey|sku|description, unitPrice, unit, vatRate}
 * @param {string} [args.noteDate] ISO date of the note being checked
 * @param {string} [args.issueKey] the issue being checked (its own past entries are ignored)
 */
export function findReference({ line, history = [], priceList = [], noteDate = null, issueKey = null }) {
  const agreed = priceList.map((p) => ({ ...p, itemKey: p.itemKey ?? itemKeyFor(p) }));
  const agreedMatch = matchItem(line, agreed);
  if (agreedMatch) {
    const p = agreed.find((a) => a.itemKey === agreedMatch.itemKey);
    return {
      source: 'agreed',
      itemKey: p.itemKey,
      unitPrice: p.unitPrice,
      unit: p.unit ?? null,
      vatRate: p.vatRate ?? null,
      date: p.validFrom ?? null,
      issueKey: null,
      noteNumber: null,
      match: agreedMatch.how,
    };
  }
  const usable = history.filter(
    (e) => e.status === 'accepted' && !(issueKey && e.issueKey === issueKey) && (!noteDate || !e.date || e.date <= noteDate)
  );
  const m = matchItem(line, usable);
  if (!m) return null;
  const latest = usable.filter((e) => e.itemKey === m.itemKey).sort(byDateDesc)[0];
  return {
    source: 'history',
    itemKey: latest.itemKey,
    unitPrice: latest.unitPrice,
    unit: latest.unit ?? null,
    vatRate: latest.vatRate ?? null,
    date: latest.date ?? null,
    issueKey: latest.issueKey ?? null,
    noteNumber: latest.noteNumber ?? null,
    match: m.how,
    matchScore: m.score,
  };
}

/** VAT rate this supplier charged last time for the item, from any accepted entry. */
export function lastVatRate(reference) {
  return reference?.vatRate ?? null;
}

export function unitsDiffer(a, b) {
  const ua = normalizeUnit(a);
  const ub = normalizeUnit(b);
  return Boolean(ua && ub && ua !== ub);
}

/**
 * History entries produced by a checked note. Status is "accepted" when the
 * note was approved (or came out clean) and "disputed" otherwise; only
 * accepted entries are ever used as a reference.
 */
export function entriesFromResult(result, { issueKey, status, recordedAt }) {
  const supplier = result.supplier?.key ?? supplierKey(result.supplier?.name);
  return (result.lines || [])
    .filter((l) => l.unitPrice !== null && !l.flags.includes('UNVERIFIED_SOURCE'))
    .map((l) => ({
      supplierKey: supplier,
      supplierName: result.supplier?.name ?? null,
      itemKey: l.reference?.itemKey ?? itemKeyFor(l),
      sku: l.sku ?? null,
      description: l.description ?? null,
      unit: l.unit ?? null,
      unitPrice: l.unitPrice,
      vatRate: l.vatRate ?? null,
      date: result.date ?? (recordedAt ? recordedAt.slice(0, 10) : null),
      issueKey,
      noteNumber: result.number ?? null,
      status,
      recordedAt: recordedAt ?? null,
    }));
}

/** Merge new entries into an item's stored list, replacing older entries from the same issue. Keeps the newest `cap`. */
export function mergeEntries(existing = [], incoming = [], cap = 60) {
  const issues = new Set(incoming.map((e) => `${e.issueKey}|${e.itemKey}`));
  const kept = existing.filter((e) => !issues.has(`${e.issueKey}|${e.itemKey}`));
  return [...kept, ...incoming].sort(byDateDesc).slice(0, cap);
}

/**
 * Price movement per supplier and item, from accepted history plus open
 * (not yet accepted) price increases found by checks.
 */
export function summarizePriceChanges({ history = [], results = [], since = null } = {}) {
  const groups = new Map();
  for (const e of history) {
    if (e.status !== 'accepted') continue;
    const k = `${e.supplierKey}|${e.itemKey}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const accepted = [];
  for (const entries of groups.values()) {
    const sorted = entries.slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const inWindow = since ? sorted.filter((e) => !e.date || e.date >= since) : sorted;
    if (!inWindow.length) continue;
    const before = since ? sorted.filter((e) => e.date && e.date < since).pop() : null;
    const first = before ?? inWindow[0];
    const last = inWindow[inWindow.length - 1];
    if (first === last || !first.unitPrice) continue;
    const pct = ((last.unitPrice - first.unitPrice) / first.unitPrice) * 100;
    if (Math.abs(pct) < 0.05) continue;
    accepted.push({
      supplierKey: last.supplierKey,
      supplierName: last.supplierName,
      itemKey: last.itemKey,
      sku: last.sku,
      description: last.description,
      from: { unitPrice: first.unitPrice, date: first.date, issueKey: first.issueKey },
      to: { unitPrice: last.unitPrice, date: last.date, issueKey: last.issueKey },
      changePct: roundN(pct, 1),
      kind: 'accepted',
    });
  }
  const pending = [];
  for (const r of results) {
    if (r.decision?.status === 'accepted') continue;
    for (const d of r.discrepancies || []) {
      if (d.code !== 'PRICE_ABOVE_REFERENCE') continue;
      pending.push({
        supplierKey: r.supplier?.key,
        supplierName: r.supplier?.name,
        sku: d.sku,
        description: d.description,
        from: { unitPrice: d.expected, date: d.referenceDate ?? null, issueKey: d.referenceIssueKey ?? null },
        to: { unitPrice: d.actual, date: r.date, issueKey: r.issueKey },
        changePct: d.deltaPct,
        amount: d.amount,
        kind: 'pending',
      });
    }
  }
  const bySupplier = new Map();
  for (const c of [...accepted, ...pending]) {
    const k = c.supplierKey;
    if (!bySupplier.has(k)) bySupplier.set(k, { supplierKey: k, supplierName: c.supplierName, increases: 0, decreases: 0, pendingIncreases: 0, maxIncreasePct: 0, pendingAmount: 0 });
    const s = bySupplier.get(k);
    if (c.kind === 'pending') {
      s.pendingIncreases += 1;
      s.pendingAmount = round2(s.pendingAmount + (c.amount || 0));
    } else if (c.changePct > 0) s.increases += 1;
    else s.decreases += 1;
    if (c.changePct > s.maxIncreasePct) s.maxIncreasePct = c.changePct;
  }
  const suppliers = [...bySupplier.values()].sort((a, b) => b.pendingAmount - a.pendingAmount || b.maxIncreasePct - a.maxIncreasePct);
  return {
    changes: [...pending, ...accepted].sort((a, b) => b.changePct - a.changePct),
    suppliers,
  };
}
