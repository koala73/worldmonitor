import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  findNewBullets,
  findRemovedBullets,
  mergeTranslatedFeatures,
  sameStringArray,
} from '../scripts/_product-config-helpers.mjs';

describe('product config helpers', () => {
  describe('sameStringArray', () => {
    it('returns true for identical arrays', () => {
      assert.equal(sameStringArray(['a', 'b'], ['a', 'b']), true);
    });

    it('returns false for different lengths', () => {
      assert.equal(sameStringArray(['a'], ['a', 'b']), false);
    });

    it('returns false for different order', () => {
      assert.equal(sameStringArray(['a', 'b'], ['b', 'a']), false);
    });

    it('returns false for non-array inputs', () => {
      assert.equal(sameStringArray(null, ['a']), false);
      assert.equal(sameStringArray(['a'], undefined), false);
    });
  });

  describe('findNewBullets', () => {
    it('returns empty for non-array inputs', () => {
      assert.deepEqual(findNewBullets(null, ['a']), []);
      assert.deepEqual(findNewBullets(['a'], undefined), []);
    });

    it('returns empty when arrays are identical', () => {
      assert.deepEqual(findNewBullets(['a', 'b'], ['a', 'b']), []);
    });

    it('returns empty when current is shorter', () => {
      assert.deepEqual(findNewBullets(['a', 'b'], ['a']), []);
    });

    it('detects trailing appends', () => {
      assert.deepEqual(findNewBullets(['a', 'b'], ['a', 'b', 'c']), ['c']);
    });

    it('detects mid-array insertions', () => {
      assert.deepEqual(findNewBullets(['a', 'c'], ['a', 'b', 'c']), ['b']);
    });

    it('detects same-length replacements', () => {
      assert.deepEqual(findNewBullets(['a', 'b', 'c'], ['a', 'b', 'd']), ['d']);
    });

    it('detects combined remove and add', () => {
      assert.deepEqual(findNewBullets(['a', 'b'], ['x', 'b', 'c']), ['x', 'c']);
    });
  });

  describe('findRemovedBullets', () => {
    it('returns empty for non-array inputs', () => {
      assert.deepEqual(findRemovedBullets(null, ['a']), []);
      assert.deepEqual(findRemovedBullets(['a'], undefined), []);
    });

    it('returns empty when arrays are identical', () => {
      assert.deepEqual(findRemovedBullets(['a', 'b'], ['a', 'b']), []);
    });

    it('detects removals', () => {
      assert.deepEqual(findRemovedBullets(['a', 'b', 'c'], ['a', 'b']), ['c']);
    });

    it('detects same-length replacements', () => {
      assert.deepEqual(findRemovedBullets(['a', 'b', 'c'], ['a', 'b', 'd']), ['c']);
    });
  });

  describe('mergeTranslatedFeatures', () => {
    it('appends new bullets as placeholders on pure append', () => {
      const result = mergeTranslatedFeatures(['a', 'b'], ['A', 'B'], ['A', 'B', 'C']);
      assert.deepEqual(result.features, ['a', 'b', 'C']);
      assert.equal(result.appendedCount, 1);
      assert.equal(result.trimmedCount, 0);
      assert.equal(result.changed, true);
    });

    it('caps appends to available slots to prevent overshoot', () => {
      const result = mergeTranslatedFeatures(['a', 'b'], ['A', 'B'], ['X', 'B', 'C']);
      assert.deepEqual(result.features, ['a', 'b', 'X']);
      assert.equal(result.features.length, 3);
      assert.equal(result.appendedCount, 1);
    });

    it('detects same-length replacements and fills the freed slot', () => {
      const result = mergeTranslatedFeatures(['a', 'b', 'C'], ['A', 'B', 'C'], ['A', 'B', 'D']);
      assert.deepEqual(result.features, ['a', 'b', 'D']);
      assert.equal(result.appendedCount, 1);
      assert.equal(result.trimmedCount, 1);
    });

    it('preserves translations when no placeholders match removed bullets', () => {
      const result = mergeTranslatedFeatures(['tA', 'tB'], ['A', 'B'], ['A', 'B', 'C']);
      assert.deepEqual(result.features, ['tA', 'tB', 'C']);
      assert.equal(result.trimmedCount, 0);
      assert.equal(result.appendedCount, 1);
    });

    it('trims trailing placeholders that match removed English bullets', () => {
      const result = mergeTranslatedFeatures(['a', 'b', 'C'], ['A', 'B', 'C'], ['A', 'B']);
      assert.deepEqual(result.features, ['a', 'b']);
      assert.equal(result.trimmedCount, 1);
      assert.equal(result.appendedCount, 0);
    });

    it('does not trim non-trailing bullets even if they match removed English', () => {
      const result = mergeTranslatedFeatures(['C', 'a', 'b'], ['A', 'B', 'C'], ['A', 'B']);
      assert.deepEqual(result.features, ['C', 'a', 'b'].slice(0, 2));
      assert.equal(result.trimmedCount, 0);
      assert.equal(result.positionalTrimmedCount, 1);
    });

    it('positional-trims excess translated bullets of removed features', () => {
      const result = mergeTranslatedFeatures(['tA', 'tB', 'tC'], ['A', 'B', 'C'], ['A', 'B']);
      assert.deepEqual(result.features, ['tA', 'tB']);
      assert.equal(result.positionalTrimmedCount, 1);
      assert.equal(result.trimmedCount, 0);
    });

    it('handles empty current features', () => {
      const result = mergeTranslatedFeatures([], ['A', 'B'], ['A', 'B', 'C']);
      assert.deepEqual(result.features, ['C']);
      assert.equal(result.appendedCount, 1);
    });

    it('handles empty generated features', () => {
      const result = mergeTranslatedFeatures(['a', 'b'], ['A', 'B'], []);
      assert.deepEqual(result.features, []);
      assert.equal(result.positionalTrimmedCount, 2);
    });

    it('returns unchanged when nothing to do', () => {
      const result = mergeTranslatedFeatures(['a', 'b'], ['A', 'B'], ['A', 'B']);
      assert.deepEqual(result.features, ['a', 'b']);
      assert.equal(result.changed, false);
    });
  });
});
