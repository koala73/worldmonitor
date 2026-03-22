/**
 * Marker Tier System Tests
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  getSemiconductorTier,
  getDataCenterTier,
  getTechHQTier,
  getUnicornTier,
  getTierRadius,
  getTierColor,
  type MarkerTier,
} from '../src/services/marker-tier.ts';

describe('Marker Tier System', () => {
  describe('getSemiconductorTier', () => {
    it('returns Tier 1 for 2000+ employees', () => {
      assert.equal(getSemiconductorTier(4000), 1);
      assert.equal(getSemiconductorTier(2000), 1);
    });

    it('returns Tier 2 for 500-1999 employees', () => {
      assert.equal(getSemiconductorTier(1000), 2);
      assert.equal(getSemiconductorTier(500), 2);
    });

    it('returns Tier 3 for <500 employees', () => {
      assert.equal(getSemiconductorTier(300), 3);
      assert.equal(getSemiconductorTier(100), 3);
    });
  });

  describe('getDataCenterTier', () => {
    it('returns Tier 1 for hyperscale providers', () => {
      assert.equal(getDataCenterTier('Google Cloud'), 1);
      assert.equal(getDataCenterTier('Meta (Facebook)'), 1);
      assert.equal(getDataCenterTier('Amazon Web Services'), 1);
    });

    it('returns Tier 2 for enterprise providers', () => {
      assert.equal(getDataCenterTier('Microsoft Azure'), 2);
      assert.equal(getDataCenterTier('Equinix'), 2);
    });

    it('returns Tier 3 for others', () => {
      assert.equal(getDataCenterTier('Digital Realty'), 3);
      assert.equal(getDataCenterTier('Unknown Provider'), 3);
    });
  });

  describe('getTechHQTier', () => {
    it('returns Tier 1 for 3000+ employees', () => {
      assert.equal(getTechHQTier(8000), 1);
      assert.equal(getTechHQTier(3000), 1);
    });

    it('returns Tier 2 for 1000-2999 employees', () => {
      assert.equal(getTechHQTier(2500), 2);
      assert.equal(getTechHQTier(1000), 2);
    });

    it('returns Tier 3 for <1000 employees', () => {
      assert.equal(getTechHQTier(500), 3);
      assert.equal(getTechHQTier(undefined), 3);
    });
  });

  describe('getUnicornTier', () => {
    it('returns correct tier for each category', () => {
      assert.equal(getUnicornTier('unicorn'), 1);
      assert.equal(getUnicornTier('high-growth'), 2);
      assert.equal(getUnicornTier('emerging'), 3);
    });
  });

  describe('getTierRadius', () => {
    it('returns larger radius for Tier 1', () => {
      const [radius1] = getTierRadius(1);
      const [radius2] = getTierRadius(2);
      const [radius3] = getTierRadius(3);
      assert.ok(radius1 > radius2, 'Tier 1 should be larger than Tier 2');
      assert.ok(radius2 > radius3, 'Tier 2 should be larger than Tier 3');
    });

    it('returns [baseRadius, minPixels, maxPixels] tuple', () => {
      const result = getTierRadius(1);
      assert.equal(result.length, 3);
      assert.ok(result[0] > 0, 'baseRadius should be positive');
      assert.ok(result[1] > 0, 'minPixels should be positive');
      assert.ok(result[2] > result[1], 'maxPixels should be > minPixels');
    });
  });

  describe('getTierColor', () => {
    it('returns RGBA array with 4 elements', () => {
      const color = getTierColor([100, 100, 100], 1);
      assert.equal(color.length, 4);
    });

    it('returns higher alpha for Tier 1', () => {
      const [, , , alpha1] = getTierColor([100, 100, 100], 1);
      const [, , , alpha2] = getTierColor([100, 100, 100], 2);
      const [, , , alpha3] = getTierColor([100, 100, 100], 3);
      assert.ok(alpha1 > alpha2, 'Tier 1 should have higher alpha than Tier 2');
      assert.ok(alpha2 > alpha3, 'Tier 2 should have higher alpha than Tier 3');
    });

    it('lightens color for lower tiers', () => {
      const [r1] = getTierColor([100, 100, 100], 1);
      const [r2] = getTierColor([100, 100, 100], 2);
      const [r3] = getTierColor([100, 100, 100], 3);
      assert.ok(r2 >= r1, 'Tier 2 should be same or lighter than Tier 1');
      assert.ok(r3 >= r2, 'Tier 3 should be same or lighter than Tier 2');
    });
  });
});
