import { describe, expect, it } from 'vitest';
import { parseSize } from './size';

// #5445: a comma-decimal size used to parse as a confident wrong number
// (the scan resumed after the comma), and `litro`/`litros` was unmapped so a
// 1.5 L bottle was published as a 1 L basket item. The two fixes are coupled:
// mapping the unit without the separator fix would have parsed "1,5 Litros"
// as 5 L and hard-failed the quantity window for the right product.
describe('parseSize decimal separators (#5445)', () => {
  it.each([
    ['Aprox. 2,8 Kg', 2800, 'g'],
    ['1,5Kg', 1500, 'g'],
    ['1,4 kg', 1400, 'g'],
    ['0,9 l', 900, 'ml'],
    ['0,500 litro', 500, 'ml'],
    ['0,125 litros', 125, 'ml'],
    ['1,5 Litros', 1500, 'ml'],
    ['1 Litro', 1000, 'ml'],
  ])('parses the comma decimal in %s as %d %s', (raw, baseQuantity, baseUnit) => {
    const parsed = parseSize(raw);
    expect(parsed?.baseQuantity).toBeCloseTo(baseQuantity, 6);
    expect(parsed?.baseUnit).toBe(baseUnit);
    expect(parsed?.packCount).toBe(1);
  });

  it('drops a thousands separator instead of parsing the digits after it', () => {
    expect(parseSize('1,500 g')?.baseQuantity).toBe(1500);
    expect(parseSize('2,000 ml')?.baseQuantity).toBe(2000);
  });

  it('keeps dot decimals and plain sizes exactly as before', () => {
    expect(parseSize('1.5 kg')?.baseQuantity).toBe(1500);
    expect(parseSize('500 g')?.baseQuantity).toBe(500);
    expect(parseSize('6 x 1,5 l')).toMatchObject({ packCount: 6, baseQuantity: 9000, baseUnit: 'ml' });
  });

  it('still returns null for an unknown unit rather than inventing a quantity', () => {
    expect(parseSize('1,5 unidades')).toBeNull();
    expect(parseSize('2,8')).toBeNull();
  });
});
