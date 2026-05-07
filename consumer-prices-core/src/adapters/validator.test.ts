import { describe, it, expect } from 'vitest';
import { validateSearchHit, AUTO_MATCH_THRESHOLD } from './validator.js';
import type { BasketItem } from '../config/types.js';

const item = (over: Partial<BasketItem> = {}): BasketItem => ({
  id: 'x',
  category: 'x',
  canonicalName: 'x',
  weight: 0.1,
  baseUnit: 'g',
  ...over,
});

describe('validateSearchHit — known bad log examples', () => {
  it('rejects mango sugar baby for White Sugar 1kg', () => {
    const r = validateSearchHit({
      canonicalName: 'White Sugar 1kg',
      productName: 'mango sugar baby india 1 kg',
      sizeText: '1 kg',
      item: item({
        baseUnit: 'g', minBaseQty: 900, maxBaseQty: 1100,
        negativeTokens: ['baby', 'brown', 'mascavo', 'sachets'],
      }),
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.some((s) => s.startsWith('negative-token:baby'))).toBe(true);
  });

  it('rejects vegan gouda for Processed Cheese Slices', () => {
    const r = validateSearchHit({
      canonicalName: 'Processed Cheese Slices 200g',
      productName: 'vegan gouda slices 200g',
      sizeText: '200 g',
      item: item({
        baseUnit: 'g', minBaseQty: 180, maxBaseQty: 220,
        negativeTokens: ['vegan', 'gouda', 'cheddar'],
      }),
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.some((s) => s.startsWith('negative-token:vegan'))).toBe(true);
  });

  it('rejects onion powder for Onions 1kg', () => {
    const r = validateSearchHit({
      canonicalName: 'Onions 1kg',
      productName: 'Onion Powder 100g',
      sizeText: '100 g',
      item: item({
        baseUnit: 'g', minBaseQty: 900, maxBaseQty: 1100,
        negativeTokens: ['powder', 'flakes'],
      }),
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.some((s) => s.startsWith('negative-token:powder'))).toBe(true);
  });

  it('rejects chopped canned tomatoes for Tomatoes Fresh 1kg', () => {
    const r = validateSearchHit({
      canonicalName: 'Tomatoes Fresh 1kg',
      productName: 'Chopped Tomatoes 400g canned',
      sizeText: '400 g',
      item: item({
        baseUnit: 'g', minBaseQty: 900, maxBaseQty: 1100,
        negativeTokens: ['chopped', 'peeled', 'sauce', 'paste', 'canned'],
      }),
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.some((s) => s.startsWith('negative-token:'))).toBe(true);
  });

  it('rejects plant-based yogurt for Plain Yogurt 500g', () => {
    const r = validateSearchHit({
      canonicalName: 'Plain Yogurt 500g',
      productName: 'Plant-Based Almond Yogurt 500g',
      sizeText: '500 g',
      item: item({
        baseUnit: 'g', minBaseQty: 450, maxBaseQty: 550,
        negativeTokens: ['drink', 'drinking', 'plant-based', 'vegan'],
      }),
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.some((s) => s.startsWith('negative-token:plant-based'))).toBe(true);
  });

  it('rejects drinking yogurt for Plain Yogurt 500g', () => {
    const r = validateSearchHit({
      canonicalName: 'Plain Yogurt 500g',
      productName: 'Dairy Drinking Yogurt 500g',
      sizeText: '500 g',
      item: item({
        baseUnit: 'g', minBaseQty: 450, maxBaseQty: 550,
        negativeTokens: ['drink', 'drinking', 'plant-based', 'vegan'],
      }),
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.some((s) => s.startsWith('negative-token:drinking'))).toBe(true);
  });
});

describe('validateSearchHit — positive counterparts must still pass', () => {
  it('accepts normal white sugar 1kg', () => {
    const r = validateSearchHit({
      canonicalName: 'White Sugar 1kg',
      productName: 'Al Khaleej White Sugar 1 kg',
      sizeText: '1 kg',
      item: item({
        baseUnit: 'g', minBaseQty: 900, maxBaseQty: 1100,
        negativeTokens: ['brown', 'baby', 'mascavo', 'sachets', 'powdered'],
      }),
    });
    expect(r.ok).toBe(true);
    expect(r.signals.sizeWindow).toBe('pass');
    expect(r.score).toBeGreaterThanOrEqual(AUTO_MATCH_THRESHOLD);
  });

  // Regression: "cane" is a legitimate descriptor for white cane sugar.
  // An earlier iteration of negativeTokens included "cane" and would have
  // downgraded real SKUs to candidate. Guard against any future edit that
  // re-adds "cane" without considering this positive case.
  it('accepts white cane sugar 1kg — cane is not a class error', () => {
    const r = validateSearchHit({
      canonicalName: 'White Sugar 1kg',
      productName: 'Silver Spoon White Cane Sugar 1kg',
      sizeText: '1 kg',
      item: item({
        baseUnit: 'g', minBaseQty: 900, maxBaseQty: 1100,
        negativeTokens: ['brown', 'baby', 'mascavo', 'sachets', 'powdered'],
      }),
    });
    expect(r.ok).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(AUTO_MATCH_THRESHOLD);
  });

  it('accepts fresh whole onions 1kg', () => {
    const r = validateSearchHit({
      canonicalName: 'Onions 1kg',
      productName: 'Fresh Red Onions 1kg',
      sizeText: '1kg',
      item: item({
        baseUnit: 'g', minBaseQty: 900, maxBaseQty: 1100,
        negativeTokens: ['powder', 'flakes'],
      }),
    });
    expect(r.ok).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(AUTO_MATCH_THRESHOLD);
  });

  // Regression: compact size tokens like "1kg" used to be kept as identity
  // tokens, but Firecrawl often emits "1 kg" (spaced) which tokenises to
  // ["1","kg"] — both below the length>2 floor — so "1kg" could never
  // match. For short canonical names like "Onions 1kg", that dropped the
  // token overlap from 1.0 to 0.5 and pushed valid hits below the
  // AUTO_MATCH_THRESHOLD. Size fidelity is already enforced by the
  // quantity-window check; identity tokens should ignore size.
  it('overlap ignores compact size token so spaced-size extractions pass', () => {
    const r = validateSearchHit({
      canonicalName: 'Onions 1kg',
      productName: 'Fresh Red Onions 1 kg',
      sizeText: '1 kg',
      item: item({
        baseUnit: 'g', minBaseQty: 900, maxBaseQty: 1100,
        negativeTokens: ['powder', 'flakes'],
      }),
    });
    expect(r.ok).toBe(true);
    expect(r.signals.tokenOverlap).toBe(1);
    expect(r.score).toBeGreaterThanOrEqual(AUTO_MATCH_THRESHOLD);
  });

  it('accepts fresh tomatoes 1kg', () => {
    const r = validateSearchHit({
      canonicalName: 'Tomatoes Fresh 1kg',
      productName: 'Fresh Tomatoes 1kg',
      sizeText: '1 kg',
      item: item({
        baseUnit: 'g', minBaseQty: 900, maxBaseQty: 1100,
        negativeTokens: ['chopped', 'peeled', 'sauce', 'paste', 'canned'],
      }),
    });
    expect(r.ok).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(AUTO_MATCH_THRESHOLD);
  });

  it('accepts normal plain yogurt 500g', () => {
    const r = validateSearchHit({
      canonicalName: 'Plain Yogurt 500g',
      productName: 'Al Ain Plain Yogurt 500g',
      sizeText: '500 g',
      item: item({
        baseUnit: 'g', minBaseQty: 450, maxBaseQty: 550,
        negativeTokens: ['drink', 'drinking', 'plant-based', 'vegan'],
      }),
    });
    expect(r.ok).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(AUTO_MATCH_THRESHOLD);
  });

  it('accepts processed cheese slices 200g', () => {
    const r = validateSearchHit({
      canonicalName: 'Processed Cheese Slices 200g',
      productName: 'Kraft Processed Cheese Slices 200g',
      sizeText: '200g',
      item: item({
        baseUnit: 'g', minBaseQty: 180, maxBaseQty: 220,
        negativeTokens: ['vegan', 'gouda', 'cheddar'],
      }),
    });
    expect(r.ok).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(AUTO_MATCH_THRESHOLD);
  });
});

describe('validateSearchHit — quantity window', () => {
  it('rejects 400g for a 500g target outside the allowed window', () => {
    const r = validateSearchHit({
      canonicalName: 'Plain Yogurt 500g',
      productName: 'Plain Yogurt 400g',
      sizeText: '400g',
      item: item({ baseUnit: 'g', minBaseQty: 450, maxBaseQty: 550 }),
    });
    expect(r.ok).toBe(false);
    expect(r.signals.sizeWindow).toBe('fail');
    expect(r.reasons.some((s) => s.startsWith('size-window-fail'))).toBe(true);
  });

  it('rejects 2.5kg for a 1kg target', () => {
    const r = validateSearchHit({
      canonicalName: 'White Sugar 1kg',
      productName: 'White Sugar 2.5 kg',
      sizeText: '2.5 kg',
      item: item({ baseUnit: 'g', minBaseQty: 900, maxBaseQty: 1100 }),
    });
    expect(r.ok).toBe(false);
    expect(r.signals.sizeWindow).toBe('fail');
  });

  it('accepts 505g for a 500g target inside the window', () => {
    const r = validateSearchHit({
      canonicalName: 'Plain Yogurt 500g',
      productName: 'Plain Yogurt 505g',
      sizeText: '505g',
      item: item({ baseUnit: 'g', minBaseQty: 450, maxBaseQty: 550 }),
    });
    expect(r.ok).toBe(true);
    expect(r.signals.sizeWindow).toBe('pass');
  });

  it('treats unknown size as neutral (does not hard-fail)', () => {
    const r = validateSearchHit({
      canonicalName: 'Plain Yogurt 500g',
      productName: 'Plain Yogurt',
      sizeText: undefined,
      item: item({ baseUnit: 'g', minBaseQty: 450, maxBaseQty: 550 }),
    });
    expect(r.signals.sizeWindow).toBe('unknown');
    expect(r.ok).toBe(true);
  });
});

describe('validateSearchHit — non-food and token overlap', () => {
  it('rejects seeds for a vegetable basket item', () => {
    const r = validateSearchHit({
      canonicalName: 'Tomatoes Fresh 1kg',
      productName: 'GGOOT Tomato Seeds 100 pcs Vegetable Garden',
      sizeText: undefined,
      item: item({ baseUnit: 'g' }),
    });
    expect(r.ok).toBe(false);
    expect(r.signals.nonFoodIndicatorHit).toBe('seeds');
  });

  it('rejects low token overlap', () => {
    const r = validateSearchHit({
      canonicalName: 'Basmati Rice 1kg',
      productName: 'Olive Oil 500ml',
      sizeText: '500ml',
      item: item({ baseUnit: 'g' }),
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.some((s) => s.startsWith('low-token-overlap'))).toBe(true);
  });

  it('returns empty-product-name reason for missing productName', () => {
    const r = validateSearchHit({
      canonicalName: 'Milk 1L',
      productName: undefined,
      sizeText: undefined,
      item: item(),
    });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('empty-product-name');
    expect(r.score).toBe(0);
  });
});
