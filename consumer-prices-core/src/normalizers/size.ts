/**
 * Parses and normalizes product size strings into base units.
 * Handles patterns like: 2x200g, 6x1L, 500ml, 24 rolls, 3 ct, 1kg, 12 pods
 */

export interface ParsedSize {
  packCount: number;
  sizeValue: number;
  sizeUnit: string;
  baseQuantity: number;
  baseUnit: string;
  rawText: string;
}

// A Map, not an object literal: `UNIT_MAP['constructor']` on a literal
// resolves through the prototype chain to a truthy Function, so
// parseSize('5 constructor') used to return a ParsedSize with a NaN
// baseQuantity and an undefined baseUnit instead of null.
const UNIT_MAP = new Map<string, { base: string; factor: number }>([
  ['kg', { base: 'g', factor: 1000 }],
  ['kilo', { base: 'g', factor: 1000 }],
  ['kilogram', { base: 'g', factor: 1000 }],
  ['kilogramme', { base: 'g', factor: 1000 }],
  ['g', { base: 'g', factor: 1 }],
  // `gm` is how AE/IN/SA storefronts routinely write grams; without it a
  // "400 gm" size fails to parse and the quantity window never runs.
  ['gm', { base: 'g', factor: 1 }],
  ['gram', { base: 'g', factor: 1 }],
  ['gramme', { base: 'g', factor: 1 }],
  ['mg', { base: 'g', factor: 0.001 }],
  ['milligram', { base: 'g', factor: 0.001 }],
  ['milligramme', { base: 'g', factor: 0.001 }],
  ['l', { base: 'ml', factor: 1000 }],
  ['lt', { base: 'ml', factor: 1000 }],
  ['ltr', { base: 'ml', factor: 1000 }],
  ['litre', { base: 'ml', factor: 1000 }],
  ['liter', { base: 'ml', factor: 1000 }],
  ['ml', { base: 'ml', factor: 1 }],
  ['millilitre', { base: 'ml', factor: 1 }],
  ['milliliter', { base: 'ml', factor: 1 }],
  ['cl', { base: 'ml', factor: 10 }],
  ['centilitre', { base: 'ml', factor: 10 }],
  ['centiliter', { base: 'ml', factor: 10 }],
  ['oz', { base: 'g', factor: 28.3495 }],
  ['ounce', { base: 'g', factor: 28.3495 }],
  ['lb', { base: 'g', factor: 453.592 }],
  ['pound', { base: 'g', factor: 453.592 }],
  ['gallon', { base: 'ml', factor: 3785.41 }],
  ['gal', { base: 'ml', factor: 3785.41 }],
  ['fl', { base: 'ml', factor: 29.5735 }],
  ['ct', { base: 'ct', factor: 1 }],
  ['pc', { base: 'ct', factor: 1 }],
  ['pcs', { base: 'ct', factor: 1 }],
  ['piece', { base: 'ct', factor: 1 }],
  ['pieces', { base: 'ct', factor: 1 }],
  ['roll', { base: 'ct', factor: 1 }],
  ['rolls', { base: 'ct', factor: 1 }],
  ['pod', { base: 'ct', factor: 1 }],
  ['pods', { base: 'ct', factor: 1 }],
  ['sheet', { base: 'ct', factor: 1 }],
  ['sheets', { base: 'ct', factor: 1 }],
  ['sachet', { base: 'ct', factor: 1 }],
  ['sachets', { base: 'ct', factor: 1 }],
]);

/**
 * Resolve a raw unit token to its UNIT_MAP key. Direct hit first, then one
 * trailing `s` is stripped, so every spelled-out unit gets its plural for free
 * ("3 Liters", "500 grams", "2 kilos") without listing both forms. Units whose
 * plural is already a key (`pcs`, `pieces`) resolve on the direct hit, so the
 * fallback never re-resolves them.
 *
 * Deliberately absent, because each would loosen a gate rather than tighten it:
 * `pack` (PACK_PATTERN already consumes "N pack <size>", and mapping it would
 * make every "N Pack" canonical name parse, weakening the adapter's
 * missing-size rejection), `unidade(s)` (same, for the BR egg item), and
 * `pint` (568ml imperial vs 473ml US — the magnitude is market-dependent).
 */
function normalizeUnit(raw: string): string | null {
  const u = raw.toLowerCase().replace(/\.$/, '');
  if (UNIT_MAP.has(u)) return u;
  if (u.endsWith('s')) {
    const singular = u.slice(0, -1);
    if (UNIT_MAP.has(singular)) return singular;
  }
  return null;
}

const PACK_PATTERN = /^(\d+)\s*(?:[x×]|pack\b)\s*(.+)$/i;
const SIZE_PATTERN = /(\d+(?:\.\d+)?)\s*([a-z]+)/i;

export function parseSize(raw: string | null | undefined): ParsedSize | null {
  if (!raw) return null;

  const text = raw.trim().toLowerCase();

  let packCount = 1;
  let sizeStr = text;

  const packMatch = PACK_PATTERN.exec(text);
  if (packMatch) {
    packCount = parseInt(packMatch[1], 10);
    sizeStr = packMatch[2].trim();
  }

  const sizeMatch = SIZE_PATTERN.exec(sizeStr);
  if (!sizeMatch) return null;

  const sizeValue = parseFloat(sizeMatch[1]);
  const rawUnit = sizeMatch[2].toLowerCase().replace(/\.$/, '');
  const unitKey = normalizeUnit(rawUnit);
  const unitDef = unitKey ? UNIT_MAP.get(unitKey) : undefined;

  if (!unitDef) return null;

  const baseQuantity = packCount * sizeValue * unitDef.factor;

  return {
    packCount,
    sizeValue,
    sizeUnit: rawUnit,
    baseQuantity,
    baseUnit: unitDef.base,
    rawText: raw,
  };
}

export function unitPrice(price: number, size: ParsedSize): number {
  if (size.baseQuantity === 0) return price;
  return price / size.baseQuantity;
}
