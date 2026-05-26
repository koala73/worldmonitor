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

const UNIT_MAP: Record<string, { base: string; factor: number }> = {
  kg: { base: 'g', factor: 1000 },
  g: { base: 'g', factor: 1 },
  mg: { base: 'g', factor: 0.001 },
  l: { base: 'ml', factor: 1000 },
  lt: { base: 'ml', factor: 1000 },
  ltr: { base: 'ml', factor: 1000 },
  litre: { base: 'ml', factor: 1000 },
  liter: { base: 'ml', factor: 1000 },
  ml: { base: 'ml', factor: 1 },
  cl: { base: 'ml', factor: 10 },
  oz: { base: 'g', factor: 28.3495 },
  lb: { base: 'g', factor: 453.592 },
  gallon: { base: 'ml', factor: 3785.41 },
  gal: { base: 'ml', factor: 3785.41 },
  fl: { base: 'ml', factor: 29.5735 },
  ct: { base: 'ct', factor: 1 },
  pc: { base: 'ct', factor: 1 },
  pcs: { base: 'ct', factor: 1 },
  piece: { base: 'ct', factor: 1 },
  pieces: { base: 'ct', factor: 1 },
  roll: { base: 'ct', factor: 1 },
  rolls: { base: 'ct', factor: 1 },
  pod: { base: 'ct', factor: 1 },
  pods: { base: 'ct', factor: 1 },
  sheet: { base: 'ct', factor: 1 },
  sheets: { base: 'ct', factor: 1 },
  sachet: { base: 'ct', factor: 1 },
  sachets: { base: 'ct', factor: 1 },
};

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
  const unitDef = UNIT_MAP[rawUnit];

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
