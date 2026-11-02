// Text normalisation helpers shared by the parser and the price history.

export function stripAccents(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Lowercase, no accents, punctuation turned into spaces, single spaces. */
export function normalize(s) {
  return stripAccents(String(s ?? ''))
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, ' ')
    .trim();
}

/** Safe key fragment for Forge KVS keys: /^[a-zA-Z0-9:._\s-#]+$/ */
export function slug(s) {
  return stripAccents(String(s ?? ''))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

const LEGAL_SUFFIXES = /\b(s\s*\.?\s*l\s*\.?\s*u?|s\s*\.?\s*a\s*\.?\s*u?|s\s*\.?\s*coop|sociedad cooperativa|ltd|llc|inc|co|gmbh|sarl|srl|bv)\b\.?/gi;

/** Supplier identity used to group history: "Pescados Rompeolas, S.L." -> "pescados-rompeolas". */
export function supplierKey(name) {
  const cleaned = stripAccents(String(name ?? '')).replace(LEGAL_SUFFIXES, ' ');
  return slug(cleaned) || 'unknown-supplier';
}

const STOPWORDS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'en', 'y', 'the', 'of', 'and', 'a', 'x']);

export function tokens(s) {
  return normalize(s)
    .split(' ')
    .filter((t) => t && !STOPWORDS.has(t));
}

export function jaccard(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / (A.size + B.size - inter);
}

const UNIT_ALIASES = {
  kg: ['kg', 'kgs', 'kilo', 'kilos', 'kilogram', 'kilograms', 'kilogramo', 'kilogramos'],
  g: ['g', 'gr', 'grs', 'gram', 'grams', 'gramo', 'gramos'],
  l: ['l', 'lt', 'lts', 'litre', 'litres', 'liter', 'liters', 'litro', 'litros'],
  unit: ['u', 'ud', 'uds', 'un', 'unit', 'units', 'unidad', 'unidades', 'pc', 'pcs', 'ea', 'each', 'pieza', 'piezas'],
  case: ['case', 'cases', 'caja', 'cajas', 'box', 'boxes', 'cj', 'ctn', 'carton'],
  bottle: ['bottle', 'bottles', 'bot', 'btl', 'botella', 'botellas'],
  pack: ['pack', 'packs', 'paquete', 'paquetes', 'pkt'],
  dozen: ['dozen', 'doz', 'docena', 'docenas', 'dz'],
  bunch: ['bunch', 'bunches', 'manojo', 'manojos'],
  tray: ['tray', 'trays', 'bandeja', 'bandejas'],
};

const UNIT_LOOKUP = new Map();
for (const [canonical, aliases] of Object.entries(UNIT_ALIASES)) {
  for (const a of aliases) UNIT_LOOKUP.set(a, canonical);
}

export function normalizeUnit(u) {
  if (u === null || u === undefined || u === '') return null;
  const n = normalize(u).replace(/\s+/g, '');
  return UNIT_LOOKUP.get(n) ?? n;
}

export const UNIT_WORDS = [...UNIT_LOOKUP.keys()];

/** Collapse whitespace and case for "does this cited line appear in the document" checks. */
export function looseText(s) {
  return stripAccents(String(s ?? ''))
    .toLowerCase()
    .replace(/[\s ]+/g, ' ')
    .trim();
}
