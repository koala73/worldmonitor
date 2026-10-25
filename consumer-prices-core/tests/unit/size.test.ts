import { describe, it, expect } from 'vitest';
import { parseSize, unitPrice } from '../../src/normalizers/size.js';

describe('parseSize', () => {
  it('parses simple gram weights', () => {
    const r = parseSize('500g');
    expect(r?.baseQuantity).toBe(500);
    expect(r?.baseUnit).toBe('g');
    expect(r?.packCount).toBe(1);
  });

  it('parses kilograms and converts to grams', () => {
    const r = parseSize('1kg');
    expect(r?.baseQuantity).toBe(1000);
    expect(r?.baseUnit).toBe('g');
  });

  it('parses multi-pack patterns (2x200g)', () => {
    const r = parseSize('2x200g');
    expect(r?.packCount).toBe(2);
    expect(r?.sizeValue).toBe(200);
    expect(r?.baseQuantity).toBe(400);
  });

  it('parses multi-pack with × symbol', () => {
    const r = parseSize('6×1L');
    expect(r?.packCount).toBe(6);
    expect(r?.baseQuantity).toBe(6000);
    expect(r?.baseUnit).toBe('ml');
  });

  it('parses litre variants', () => {
    expect(parseSize('1L')?.baseQuantity).toBe(1000);
    expect(parseSize('1.5l')?.baseQuantity).toBe(1500);
    expect(parseSize('500ml')?.baseQuantity).toBe(500);
  });

  // Regression (#6267): only the `l`/`L` symbol and the singular spellings
  // were mapped, so Noon UAE's "3 Liters" parsed to null. A null parse makes
  // the validator's quantity window report `unknown` — not a hard fail — so a
  // 3L bottle was accepted as the 1L basket item at ~3x the price.
  it('parses spelled-out litres, singular and plural', () => {
    for (const raw of ['3 Liters', '3 Litres', '3 liter', '3 litre', '3 LITERS']) {
      const r = parseSize(raw);
      expect(r?.baseQuantity, raw).toBe(3000);
      expect(r?.baseUnit, raw).toBe('ml');
    }
  });

  it('parses spelled-out mass units, singular and plural', () => {
    expect(parseSize('500 grams')?.baseQuantity).toBe(500);
    expect(parseSize('500 gramme')?.baseQuantity).toBe(500);
    expect(parseSize('1 kilogram')?.baseQuantity).toBe(1000);
    expect(parseSize('2 kilos')?.baseQuantity).toBe(2000);
    expect(parseSize('400 gm')?.baseQuantity).toBe(400);
    expect(parseSize('400 gms')?.baseQuantity).toBe(400);
    expect(parseSize('2 pounds')?.baseQuantity).toBeCloseTo(907.184);
    expect(parseSize('8 ounces')?.baseQuantity).toBeCloseTo(226.796);
  });

  it('parses spelled-out volume units below a litre', () => {
    expect(parseSize('750 millilitres')?.baseQuantity).toBe(750);
    expect(parseSize('750 milliliters')?.baseQuantity).toBe(750);
    expect(parseSize('33 centilitres')?.baseQuantity).toBe(330);
    expect(parseSize('2 gallons')?.baseQuantity).toBeCloseTo(7570.82);
  });

  // The plural fallback strips ONE trailing `s` only after a direct miss, so
  // units whose plural is itself a key keep resolving directly.
  it('keeps directly-mapped plural count units resolving to ct', () => {
    expect(parseSize('24 pcs')?.baseUnit).toBe('ct');
    expect(parseSize('24 pieces')?.baseUnit).toBe('ct');
    expect(parseSize('6 sachets')?.baseUnit).toBe('ct');
  });

  // Deliberately still unmapped — see normalizeUnit's comment. Mapping any of
  // these would make more canonical names parse, which LOOSENS the adapter's
  // missing-size rejection instead of tightening it.
  it('leaves pack, unidades and pint unparsed', () => {
    expect(parseSize('24 pack')).toBeNull();
    expect(parseSize('12 unidades')).toBeNull();
    expect(parseSize('2 pint')).toBeNull();
  });

  // UNIT_MAP was an object literal, so `UNIT_MAP['constructor']` resolved
  // through the prototype chain to a truthy Function and produced a
  // ParsedSize with a NaN baseQuantity and an undefined baseUnit.
  it('returns null for prototype-chain keys', () => {
    expect(parseSize('5 constructor')).toBeNull();
  });

  it('parses count units', () => {
    const r = parseSize('12 rolls');
    expect(r?.baseQuantity).toBe(12);
    expect(r?.baseUnit).toBe('ct');
  });

  it('parses piece counts', () => {
    const r = parseSize('24 pcs');
    expect(r?.baseQuantity).toBe(24);
  });

  it('parses gallon', () => {
    const r = parseSize('1 gallon');
    expect(r?.baseUnit).toBe('ml');
    expect(r?.baseQuantity).toBeCloseTo(3785.41);
  });

  it('parses gal abbreviation', () => {
    const r = parseSize('1gal');
    expect(r?.baseUnit).toBe('ml');
    expect(r?.baseQuantity).toBeCloseTo(3785.41);
  });

  it('parses pack word separator (24 pack 16oz)', () => {
    const r = parseSize('24 pack 16oz');
    expect(r?.packCount).toBe(24);
    expect(r?.sizeValue).toBe(16);
    expect(r?.baseUnit).toBe('g');
    expect(r?.baseQuantity).toBeCloseTo(24 * 16 * 28.3495);
  });

  it('returns null for unparseable text', () => {
    expect(parseSize('large')).toBeNull();
    expect(parseSize(null)).toBeNull();
    expect(parseSize('')).toBeNull();
  });

  it('computes unit price correctly', () => {
    const size = parseSize('1kg')!;
    const up = unitPrice(10, size);
    expect(up).toBeCloseTo(0.01); // 10 AED per 1000g = 0.01 per g
  });

  it('normalizes explicit count packs only with count-item context', () => {
    const size = parseSize('12 Pack', { baseUnit: 'ct', marketCode: 'ae' });
    expect(size).toMatchObject({ packCount: 1, baseQuantity: 12, baseUnit: 'ct', rawText: '12 Pack' });
    expect(unitPrice(16.25, size!)).toBeCloseTo(16.25 / 12);
    expect(parseSize('12 Pack')).toBeNull();
    expect(parseSize('12 Pack', { baseUnit: 'g', marketCode: 'ae' })).toBeNull();
  });

  it('normalizes a GB volume pint without choosing a unit for other markets', () => {
    const size = parseSize('2 Pint', { baseUnit: 'ml', marketCode: 'gb' });
    expect(size).toMatchObject({ packCount: 1, baseUnit: 'ml', rawText: '2 Pint' });
    expect(size?.baseQuantity).toBeCloseTo(1136.5225);
    expect(unitPrice(1.2, size!)).toBeCloseTo(1.2 / 1136.5225);
    expect(parseSize('2 Pint')).toBeNull();
    expect(parseSize('2 Pint', { baseUnit: 'ml', marketCode: 'us' })).toBeNull();
    expect(parseSize('2 Pint', { baseUnit: 'g', marketCode: 'gb' })).toBeNull();
  });

  it.each(['0 Pack', '-12 Pack', '1.5 Pack', '9007199254740992 Pack', '2x6 Pack', '12 Packs', '12 PACKS', 'case of 12 Pack', 'Each'])('declines ambiguous or invalid count label %s', raw => {
    expect(parseSize(raw, { baseUnit: 'ct', marketCode: 'ae' })).toBeNull();
  });

  it.each(['0 Pint', '-2 Pint', '2x2 Pint', '2 Pint or 1L', 'case of 2 Pint'])('declines ambiguous or invalid pint label %s', raw => {
    expect(parseSize(raw, { baseUnit: 'ml', marketCode: 'gb' })).toBeNull();
  });
});
