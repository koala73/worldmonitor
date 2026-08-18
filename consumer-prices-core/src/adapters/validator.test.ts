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

  it('treats a structurally-absent size as neutral (does not hard-fail)', () => {
    const r = validateSearchHit({
      canonicalName: 'Plain Yogurt 500g',
      productName: 'Plain Yogurt',
      sizeText: undefined,
      item: item({ baseUnit: 'g', minBaseQty: 450, maxBaseQty: 550 }),
    });
    expect(r.signals.sizeWindow).toBe('absent');
    expect(r.ok).toBe(true);
  });
});

// #6868: `unknown` used to score 0.2 whether there was nothing to check or the
// parser/carve-out simply declined to judge. Full token overlap then landed at
// 0.85 and published as `auto`. Split the neutral bucket so "could not verify"
// no longer clears AUTO_MATCH_THRESHOLD on overlap alone.
describe('validateSearchHit — absent vs unverified size (#6868)', () => {
  // Nothing to verify keeps the old 0.2 weight, so a full-overlap hit still
  // publishes. Without this fixture a future edit that lowers every non-pass
  // size to 0.05 would silently demote every retailer that omits sizeText.
  it('keeps a missing sizeText above the auto-match threshold', () => {
    const r = validateSearchHit({
      canonicalName: 'Plain Yogurt 500g',
      productName: 'Al Ain Plain Yogurt',
      sizeText: undefined,
      item: item({ baseUnit: 'g', minBaseQty: 450, maxBaseQty: 550 }),
    });
    expect(r.signals.sizeWindow).toBe('absent');
    expect(r.ok).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(AUTO_MATCH_THRESHOLD);
    // 1.0*0.55 + 0.2 + 0.1 = 0.85
    expect(r.score).toBeCloseTo(0.85);
  });

  it('keeps an item with no quantity window above the auto-match threshold', () => {
    const r = validateSearchHit({
      canonicalName: 'Plain Yogurt 500g',
      productName: 'Al Ain Plain Yogurt 500g',
      sizeText: '500g',
      item: item({ baseUnit: 'g' }), // no min/max → nothing to verify
    });
    expect(r.signals.sizeWindow).toBe('absent');
    expect(r.ok).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(AUTO_MATCH_THRESHOLD);
  });

  // The largest route into the old neutral bucket: sizeText is present but
  // parseSize cannot read it (`pack`, `unidades`, `pint`, …). Overlap alone
  // must no longer publish.
  it('demotes an unparseable sizeText below the auto-match threshold', () => {
    const r = validateSearchHit({
      canonicalName: 'Drinking Water 24 Pack 16oz',
      productName: 'Great Value Drinking Water 24 Pack',
      sizeText: '24 pack',
      item: item({
        baseUnit: 'ml', minBaseQty: 6000, maxBaseQty: 10000,
        negativeTokens: ['sparkling', 'flavored', 'flavoured'],
      }),
    });
    expect(r.signals.sizeWindow).toBe('unverified');
    expect(r.ok).toBe(true);
    expect(r.score).toBeLessThan(AUTO_MATCH_THRESHOLD);
    // 1.0*0.55 + 0.05 + 0.1 = 0.70
    expect(r.score).toBeCloseTo(0.7);
  });

  it('demotes other common unparseable unit tokens the same way', () => {
    for (const sizeText of ['12 unidades', '2 pint', '6 count', '1 litro']) {
      const r = validateSearchHit({
        canonicalName: 'Full Fat Fresh Milk 1L',
        productName: 'Full Fat Fresh Milk',
        sizeText,
        item: item({ baseUnit: 'ml', minBaseQty: 900, maxBaseQty: 1100 }),
      });
      expect(r.signals.sizeWindow, sizeText).toBe('unverified');
      expect(r.score, sizeText).toBeLessThan(AUTO_MATCH_THRESHOLD);
    }
  });

  // Deliberate carve-outs (count packaging weight, density-reconcilable
  // cross-dimension) are also "could not verify" — they decline to hard-reject
  // but must not score as if nothing was checked.
  it('scores a count-item packaging-weight carve-out as unverified', () => {
    const r = validateSearchHit({
      canonicalName: 'Fresh Eggs 10 Pack',
      productName: 'Farm Table Fresh Eggs (10+2Free) 660g',
      sizeText: '660g',
      item: item({ baseUnit: 'ct', minBaseQty: 10, maxBaseQty: 15 }),
    });
    expect(r.ok).toBe(true);
    expect(r.signals.sizeWindow).toBe('unverified');
    expect(r.score).toBeLessThan(AUTO_MATCH_THRESHOLD);
  });
});

// Both cases below were observed live on Noon UAE while diagnosing #6182.
// They are not coverage gaps: every gate passed and the row reached the price
// index carrying a confidently WRONG product, which no coverage metric sees.
describe('validateSearchHit — wrong-product admissions (#6267)', () => {
  // Defect A: "3 Liters" did not parse, so the quantity window reported
  // `unknown` (neutral) instead of running. A 3L bottle was accepted as the
  // 1L basket item at score 0.85 — above AUTO_MATCH_THRESHOLD, so it became
  // an `auto` match and entered the aggregates at ~3x the true price.
  it('rejects a 3-litre bottle for the 1L oil item', () => {
    const r = validateSearchHit({
      canonicalName: 'Sunflower Oil 1L',
      productName: 'Noor Sunflower Oil',
      sizeText: '3 Liters',
      item: item({ baseUnit: 'ml', minBaseQty: 900, maxBaseQty: 1100 }),
    });
    expect(r.ok).toBe(false);
    expect(r.signals.sizeWindow).toBe('fail');
    expect(r.signals.extractedBaseQty).toBe(3000);
    expect(r.reasons).toContain('size-window-fail:3000ml');
  });

  // Defect B: identity tokens ["drinking","water"] matched `water` alone for
  // exactly 0.5 overlap — over the 0.4 floor — and a 160g size against an
  // `ml` item evaluated to `unknown` rather than fail, so nothing rejected it.
  it('rejects a 160g tin of tuna for the 1.5L drinking-water item', () => {
    const r = validateSearchHit({
      canonicalName: 'Drinking Water 1.5L',
      productName: 'Rio Mare Light Meat Tuna In Water',
      sizeText: '160g',
      item: item({ baseUnit: 'ml', minBaseQty: 1400, maxBaseQty: 1600 }),
    });
    expect(r.ok).toBe(false);
    expect(r.signals.sizeWindow).toBe('unit-mismatch');
    expect(r.signals.extractedBaseQty).toBe(160);
    expect(r.signals.extractedBaseUnit).toBe('g');
    expect(r.reasons).toContain('size-unit-mismatch:160g-vs-ml');
  });

  // The mismatch rule is confined to CONTENT measures. A count-based item
  // legitimately carries a packaging weight, so this real Cold Storage SG hit
  // must keep passing — a blanket "parsed unit != baseUnit is a fail" rule
  // would have rejected it.
  it('still accepts a 10+2 egg pack listed by its 660g packaging weight', () => {
    const r = validateSearchHit({
      canonicalName: 'Fresh Eggs 10 Pack',
      productName: 'Farm Table Fresh Eggs (10+2Free) 660g',
      sizeText: '660g',
      item: item({ baseUnit: 'ct', minBaseQty: 10, maxBaseQty: 15 }),
    });
    expect(r.ok).toBe(true);
    // Carve-out: not a hard reject, but #6868 scores it as unverified rather
    // than the old neutral `unknown` that published at 0.85.
    expect(r.signals.sizeWindow).toBe('unverified');
    expect(r.signals.extractedBaseQty).toBe(660);
  });

  // `oz` maps to grams, but US retail writes fluid ounces identically. The US
  // basket declares "Vegetable Oil 48oz" in `ml` (window 1200-1600), so a rule
  // that rejected every mass-vs-volume mismatch would reject the CORRECT
  // product. 1361g is 1134-1701ml across the density band, which overlaps.
  it('does not reject a US oz-labelled bottle against an ml item', () => {
    const r = validateSearchHit({
      canonicalName: 'Vegetable Oil 48oz',
      productName: 'Crisco Pure Vegetable Oil 48 oz',
      sizeText: '48 oz',
      item: item({ baseUnit: 'ml', minBaseQty: 1200, maxBaseQty: 1600 }),
    });
    expect(r.ok).toBe(true);
    expect(r.signals.sizeWindow).toBe('unverified');
  });

  // Mirror of the case above. The US basket declares "Plain Yogurt 32oz" in
  // `g`, so a retailer writing the tub as fluid ounces parses to `ml`. The
  // ounce family must not decide a category error in either direction.
  it('does not reject a fl-oz-labelled tub against a mass item', () => {
    const r = validateSearchHit({
      canonicalName: 'Plain Yogurt 32oz',
      productName: 'Great Value Plain Lowfat Yogurt 32 fl oz',
      sizeText: '32 fl oz',
      item: item({ baseUnit: 'g', minBaseQty: 800, maxBaseQty: 1000 }),
    });
    expect(r.ok).toBe(true);
    expect(r.signals.sizeWindow).toBe('unverified');
  });

  // A real 1L bottle of cooking oil weighs ~910g, and Indian storefronts print
  // the net weight rather than the volume. Rejecting every mass-vs-volume
  // mismatch would delete this correct price on a retailer that runs the
  // strict validator, turning a good observation into a silent coverage gap.
  it('keeps a 1L oil bottle listed by its 910g net weight', () => {
    const r = validateSearchHit({
      canonicalName: 'Sunflower Oil 1L',
      productName: 'Pranajay Organic Sunflower Oil Cold Pressed 1 Ltr',
      sizeText: '910 g',
      item: item({ baseUnit: 'ml', minBaseQty: 900, maxBaseQty: 1100 }),
    });
    expect(r.ok).toBe(true);
    expect(r.signals.sizeWindow).toBe('unverified');
  });

  // The other half of the same rule, and the reason it keys on magnitude
  // rather than on the unit token: exempting the ounce family outright would
  // wave through a 128oz (1 gallon) jug as the 48oz item — defect A again, at
  // 2.7x. 3629g is 3024-4536ml across the band, entirely above the window.
  it('rejects a 128oz gallon jug for the 48oz oil item', () => {
    const r = validateSearchHit({
      canonicalName: 'Vegetable Oil 48oz',
      productName: 'Crisco Pure Vegetable Oil 128 oz',
      sizeText: '128 oz',
      item: item({ baseUnit: 'ml', minBaseQty: 1200, maxBaseQty: 1600 }),
    });
    expect(r.ok).toBe(false);
    expect(r.signals.sizeWindow).toBe('unit-mismatch');
  });

  // Same rule, opposite extreme. A water-testing kit shares both identity
  // tokens with the drinking-water item and trips none of its negative
  // tokens, so before the magnitude check its 0.04oz size was waved through
  // as an ambiguous unit and it scored 0.85 — an `auto` match on a non-food.
  it('rejects a 0.04oz water test kit for the drinking-water item', () => {
    const r = validateSearchHit({
      canonicalName: 'Drinking Water 24 Pack 16oz',
      productName: 'YAHHU Drinking Water Quality Coliforms Test Kit Powder',
      sizeText: '0.04 oz',
      item: item({
        baseUnit: 'ml', minBaseQty: 10000, maxBaseQty: 12000,
        negativeTokens: ['sparkling', 'flavored', 'flavoured'],
      }),
    });
    expect(r.ok).toBe(false);
    expect(r.signals.sizeWindow).toBe('unit-mismatch');
  });

  // The count exemption runs in both directions: a `ct` size against a mass
  // item ("6 rolls" for a 400g loaf) is packaging, not a category error.
  it('does not reject a count size against a mass item', () => {
    const r = validateSearchHit({
      canonicalName: 'White Sliced Bread 400g',
      productName: 'White Sliced Bread 12 Slices',
      sizeText: '12 pcs',
      item: item({ baseUnit: 'g', minBaseQty: 350, maxBaseQty: 450 }),
    });
    expect(r.signals.sizeWindow).toBe('unverified');
    expect(r.ok).toBe(true);
  });

  // A wrong-category hit scores below AUTO_MATCH_THRESHOLD even before this
  // fix, so it landed as a `candidate` rather than in the aggregates. The
  // 3L-oil case did NOT — it scored 0.85 and matched `auto`. Pin both so a
  // future scoring change cannot quietly promote either.
  it('scores both rejected hits below the auto-match threshold', () => {
    const oil = validateSearchHit({
      canonicalName: 'Sunflower Oil 1L',
      productName: 'Noor Sunflower Oil',
      sizeText: '3 Liters',
      item: item({ baseUnit: 'ml', minBaseQty: 900, maxBaseQty: 1100 }),
    });
    const tuna = validateSearchHit({
      canonicalName: 'Drinking Water 1.5L',
      productName: 'Rio Mare Light Meat Tuna In Water',
      sizeText: '160g',
      item: item({ baseUnit: 'ml', minBaseQty: 1400, maxBaseQty: 1600 }),
    });
    expect(oil.score).toBeLessThan(AUTO_MATCH_THRESHOLD);
    expect(tuna.score).toBeLessThan(AUTO_MATCH_THRESHOLD);
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
