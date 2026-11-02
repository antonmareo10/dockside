// Number and money helpers. Pure functions, no Forge imports.

/** Round half away from zero to 2 decimals, avoiding binary float drift (1.005 -> 1.01). */
export function round2(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);
  return sign * Number(Math.round(Number(`${abs}e2`)) + 'e-2');
}

/** Round to n decimals with the same strategy as round2. */
export function roundN(value, n) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);
  return sign * Number(Math.round(Number(`${abs}e${n}`)) + `e-${n}`);
}

export function approxEqual(a, b, tolerance = 0.01) {
  if (a === null || b === null || a === undefined || b === undefined) return false;
  return Math.abs(a - b) <= tolerance + 1e-9;
}

const CURRENCY = /(€|eur(?:os?)?\b|\$|usd\b|£)/gi;

/**
 * Parse a number written in Spanish or English style.
 * decimalComma=true means "1.234,56" style; false means "1,234.56" style.
 * Returns null when the text holds no number.
 */
export function parseNumber(raw, decimalComma = true) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  let s = String(raw).replace(CURRENCY, '').replace(/[\s   ']/g, '').trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.endsWith('-')) {
    negative = true;
    s = s.slice(0, -1);
  }
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  s = s.replace(/%$/, '');
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;

  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  if (hasDot && hasComma) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (hasComma) {
    if (decimalComma) {
      if ((s.match(/,/g) || []).length > 1) {
        s = s.replace(/,/g, '');
      } else {
        s = s.replace(',', '.');
      }
    } else if (/^\d{1,3}(,\d{3})+$/.test(s)) {
      s = s.replace(/,/g, '');
    } else {
      s = s.replace(',', '.');
    }
  } else if (hasDot) {
    if ((s.match(/\./g) || []).length > 1) {
      s = s.replace(/\./g, '');
    } else if (decimalComma && /^\d{1,3}\.\d{3}$/.test(s)) {
      s = s.replace('.', '');
    }
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** Parse a VAT rate: "10", "10%", "10,0 %", "0.10" -> 10. */
export function parseRate(raw, decimalComma = true) {
  const n = parseNumber(raw, decimalComma);
  if (n === null) return null;
  const pct = n > 0 && n < 1 ? n * 100 : n;
  return roundN(pct, 2);
}

/**
 * Decide whether a document writes decimals with a comma.
 * Counts "12,40"-style against "12.40"-style tokens.
 */
export function detectDecimalComma(text) {
  const commaHits = (text.match(/\d,\d{1,2}(?!\d)/g) || []).length;
  const dotHits = (text.match(/\d\.\d{1,2}(?!\d)/g) || []).length;
  if (commaHits === dotHits) return !/\d\.\d{2}(?!\d)/.test(text);
  return commaHits > dotHits;
}

/** Extract every number that appears in a piece of text, in both decimal styles. */
export function numbersIn(text) {
  const out = new Set();
  const tokens = String(text).match(/\d[\d.,]*/g) || [];
  for (const raw of tokens) {
    const t = raw.replace(/[.,]+$/, '');
    for (const dc of [true, false]) {
      const n = parseNumber(t, dc);
      if (n !== null) out.add(roundN(n, 4));
    }
  }
  return [...out];
}

export function formatMoney(value, currency = 'EUR') {
  if (value === null || value === undefined) return 'n/a';
  const symbol = currency === 'EUR' ? '€' : `${currency} `;
  const v = round2(value);
  const sign = v < 0 ? '-' : '';
  const [int, dec] = Math.abs(v).toFixed(2).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${symbol}${grouped}.${dec}`;
}

export function formatPct(value) {
  if (value === null || value === undefined) return 'n/a';
  const v = roundN(value, 1);
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
}

export function formatQty(value) {
  if (value === null || value === undefined) return 'n/a';
  return String(roundN(value, 3));
}
