/**
 * Marker Icons Service Tests
 *
 * Tests for simplified marker shapes (FR #107):
 * - circle: Core infrastructure (Semiconductor Hubs, Data Centers)
 * - diamond: Professional/HQ (Tech HQs, Accelerators)
 * - triangle: Growth/Unicorns (Irish Unicorns)
 * - square: Foundation (Cloud Regions)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  getMarkerIconName,
  getMarkerSizeForTier,
  getMarkerIconUrl,
  getMarkerIcon,
  MARKER_ICON_MAPPING,
  type MarkerShape,
} from '../src/services/marker-icons.ts';
import type { MarkerTier } from '../src/services/marker-tier.ts';

describe('Marker Icons Service', () => {
  describe('getMarkerIconName', () => {
    it('returns correct name for circle shape', () => {
      assert.equal(getMarkerIconName('circle', 1), 'circle-large');
      assert.equal(getMarkerIconName('circle', 2), 'circle-medium');
      assert.equal(getMarkerIconName('circle', 3), 'circle-small');
    });

    it('returns correct name for diamond shape', () => {
      assert.equal(getMarkerIconName('diamond', 1), 'diamond-large');
      assert.equal(getMarkerIconName('diamond', 2), 'diamond-medium');
      assert.equal(getMarkerIconName('diamond', 3), 'diamond-small');
    });

    it('returns correct name for triangle shape', () => {
      assert.equal(getMarkerIconName('triangle', 1), 'triangle-large');
      assert.equal(getMarkerIconName('triangle', 2), 'triangle-medium');
      assert.equal(getMarkerIconName('triangle', 3), 'triangle-small');
    });

    it('returns correct name for square shape', () => {
      assert.equal(getMarkerIconName('square', 1), 'square-large');
      assert.equal(getMarkerIconName('square', 2), 'square-medium');
      assert.equal(getMarkerIconName('square', 3), 'square-small');
    });
  });

  describe('getMarkerSizeForTier', () => {
    it('returns correct sizes for all tiers', () => {
      assert.equal(getMarkerSizeForTier(1, 'circle'), 24);
      assert.equal(getMarkerSizeForTier(2, 'circle'), 16);
      assert.equal(getMarkerSizeForTier(3, 'circle'), 12);
    });

    it('returns same sizes for all shapes (simplified design)', () => {
      const shapes: MarkerShape[] = ['circle', 'diamond', 'triangle', 'square'];
      for (const shape of shapes) {
        assert.equal(getMarkerSizeForTier(1, shape), 24, `Tier 1 ${shape} should be 24px`);
        assert.equal(getMarkerSizeForTier(2, shape), 16, `Tier 2 ${shape} should be 16px`);
        assert.equal(getMarkerSizeForTier(3, shape), 12, `Tier 3 ${shape} should be 12px`);
      }
    });

    it('uses circle size when shape not specified', () => {
      assert.equal(getMarkerSizeForTier(1), 24);
      assert.equal(getMarkerSizeForTier(2), 16);
      assert.equal(getMarkerSizeForTier(3), 12);
    });
  });

  describe('getMarkerIconUrl', () => {
    it('returns correct URL path', () => {
      assert.equal(getMarkerIconUrl('circle', 1), '/icons/map-markers/circle-large.svg');
      assert.equal(getMarkerIconUrl('diamond', 2), '/icons/map-markers/diamond-medium.svg');
      assert.equal(getMarkerIconUrl('triangle', 3), '/icons/map-markers/triangle-small.svg');
      assert.equal(getMarkerIconUrl('square', 1), '/icons/map-markers/square-large.svg');
    });
  });

  describe('MARKER_ICON_MAPPING', () => {
    it('has all 12 icon mappings (4 shapes × 3 tiers)', () => {
      assert.equal(Object.keys(MARKER_ICON_MAPPING).length, 12);
    });

    it('has correct dimensions for all icons', () => {
      const shapes: MarkerShape[] = ['circle', 'diamond', 'triangle', 'square'];
      const sizes = ['small', 'medium', 'large'];

      for (const shape of shapes) {
        for (const size of sizes) {
          const key = `${shape}-${size}`;
          const mapping = MARKER_ICON_MAPPING[key];
          assert.ok(mapping, `Missing mapping for ${key}`);
          assert.ok(mapping.width > 0, `${key} should have positive width`);
          assert.ok(mapping.height > 0, `${key} should have positive height`);
          assert.equal(mapping.mask, true, `${key} should have mask=true for color tinting`);
        }
      }
    });

    it('all large icons have same size (simplified design)', () => {
      assert.equal(MARKER_ICON_MAPPING['circle-large']?.width, 24);
      assert.equal(MARKER_ICON_MAPPING['diamond-large']?.width, 24);
      assert.equal(MARKER_ICON_MAPPING['triangle-large']?.width, 24);
      assert.equal(MARKER_ICON_MAPPING['square-large']?.width, 24);
    });
  });

  describe('getMarkerIcon', () => {
    it('returns cached icon definition with correct properties', () => {
      const icon = getMarkerIcon('circle', 1);
      assert.ok(icon.url.startsWith('data:image/svg+xml;base64,'), 'URL should be a data URL');
      assert.equal(icon.width, 24);
      assert.equal(icon.height, 24);
      assert.equal(icon.mask, true);
    });

    it('returns same object reference for same parameters (caching)', () => {
      const icon1 = getMarkerIcon('diamond', 2);
      const icon2 = getMarkerIcon('diamond', 2);
      assert.strictEqual(icon1, icon2, 'Should return same cached object');
    });

    it('returns different objects for different parameters', () => {
      const icon1 = getMarkerIcon('triangle', 1);
      const icon2 = getMarkerIcon('triangle', 2);
      assert.notStrictEqual(icon1, icon2);
    });

    it('all tier 1 icons have same dimensions (simplified design)', () => {
      const circleIcon = getMarkerIcon('circle', 1);
      const diamondIcon = getMarkerIcon('diamond', 1);
      const triangleIcon = getMarkerIcon('triangle', 1);
      const squareIcon = getMarkerIcon('square', 1);
      assert.equal(circleIcon.width, 24);
      assert.equal(diamondIcon.width, 24);
      assert.equal(triangleIcon.width, 24);
      assert.equal(squareIcon.width, 24);
    });

    it('generates valid SVG data URL for circle', () => {
      const icon = getMarkerIcon('circle', 1);
      const base64Part = icon.url.replace('data:image/svg+xml;base64,', '');
      const decoded = atob(base64Part);
      assert.ok(decoded.includes('<svg'), 'Should contain SVG element');
      assert.ok(decoded.includes('<path') || decoded.includes('A10 10'), 'Should contain circle path');
      assert.ok(decoded.includes('fill="white"'), 'Should have white fill for masking');
    });

    it('generates valid SVG data URL for triangle', () => {
      const icon = getMarkerIcon('triangle', 1);
      const base64Part = icon.url.replace('data:image/svg+xml;base64,', '');
      const decoded = atob(base64Part);
      assert.ok(decoded.includes('<svg'), 'Should contain SVG element');
      assert.ok(decoded.includes('<path'), 'Should contain path element');
      assert.ok(decoded.includes('fill="white"'), 'Should have white fill for masking');
    });
  });

  describe('Shape usage guidelines (FR #107)', () => {
    it('circle is valid for core infrastructure layers', () => {
      // Semiconductor Hubs, Data Centers, Startup Hubs
      const icon = getMarkerIcon('circle', 1);
      assert.ok(icon, 'Circle should be available');
    });

    it('diamond is valid for professional/HQ layers', () => {
      // Tech HQs, Accelerators
      const icon = getMarkerIcon('diamond', 1);
      assert.ok(icon, 'Diamond should be available');
    });

    it('triangle is valid for growth/unicorn layers', () => {
      // Irish Unicorns
      const icon = getMarkerIcon('triangle', 1);
      assert.ok(icon, 'Triangle should be available');
    });

    it('square is valid for foundation layers', () => {
      // Cloud Regions
      const icon = getMarkerIcon('square', 1);
      assert.ok(icon, 'Square should be available');
    });
  });
});
