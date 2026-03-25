import { describe, it, expect } from 'vitest';
import { scoreMatch, bestMatch } from '../../src/matchers/canonical.js';
import type { CanonicalProduct } from '../../src/db/models.js';

const baseCanonical: CanonicalProduct = {
  id: 'c1',
  canonicalName: 'Basmati Rice 1kg',
  brandNorm: 'Tilda',
  category: 'rice',
  variantNorm: null,
  sizeValue: 1000,
  sizeUnit: 'g',
  baseQuantity: 1000,
  baseUnit: 'g',
  active: true,
  createdAt: new Date(),
};

describe('scoreMatch', () => {
  it('gives high score for exact brand+category+size match', () => {
    const result = scoreMatch(
      { rawTitle: 'Tilda Basmati Rice 1kg', rawBrand: 'Tilda', rawSizeText: '1kg', categoryText: 'rice' },
      baseCanonical,
    );
    expect(result.score).toBeGreaterThanOrEqual(85);
    expect(result.status).toBe('auto');
  });

  it('gives review score for partial match (no brand)', () => {
    const result = scoreMatch(
      { rawTitle: 'Basmati Rice 1kg', rawBrand: null, rawSizeText: '1kg', categoryText: 'rice' },
      baseCanonical,
    );
    expect(result.score).toBeGreaterThanOrEqual(50);
  });

  it('rejects clearly wrong product', () => {
    const result = scoreMatch(
      { rawTitle: 'Sunflower Oil 2L', rawBrand: 'Generic', rawSizeText: '2L', categoryText: 'oil' },
      baseCanonical,
    );
    expect(result.status).toBe('reject');
  });
});

describe('bestMatch', () => {
  it('returns null when no candidates', () => {
    expect(bestMatch({ rawTitle: 'Eggs 12 Pack' }, [])).toBeNull();
  });

  it('returns best scoring non-reject match', () => {
    const result = bestMatch(
      { rawTitle: 'Tilda Basmati Rice 1kg', rawBrand: 'Tilda', rawSizeText: '1kg', categoryText: 'rice' },
      [baseCanonical],
    );
    expect(result?.canonicalProductId).toBe('c1');
    expect(result?.score).toBeGreaterThanOrEqual(85);
  });
});
