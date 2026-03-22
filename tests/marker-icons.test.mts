/**
 * Marker Icons Service Tests
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
    it('returns correct name for diamond shape', () => {
      assert.equal(getMarkerIconName('diamond', 1), 'diamond-large');
      assert.equal(getMarkerIconName('diamond', 2), 'diamond-medium');
      assert.equal(getMarkerIconName('diamond', 3), 'diamond-small');
    });

    it('returns correct name for square shape', () => {
      assert.equal(getMarkerIconName('square', 1), 'square-large');
      assert.equal(getMarkerIconName('square', 2), 'square-medium');
      assert.equal(getMarkerIconName('square', 3), 'square-small');
    });

    it('returns correct name for hexagon shape', () => {
      assert.equal(getMarkerIconName('hexagon', 1), 'hexagon-large');
      assert.equal(getMarkerIconName('hexagon', 2), 'hexagon-medium');
      assert.equal(getMarkerIconName('hexagon', 3), 'hexagon-small');
    });

    it('returns correct name for star shape', () => {
      assert.equal(getMarkerIconName('star', 1), 'star-large');
      assert.equal(getMarkerIconName('star', 2), 'star-medium');
      assert.equal(getMarkerIconName('star', 3), 'star-small');
    });
  });

  describe('getMarkerSizeForTier', () => {
    it('returns correct sizes for standard shapes', () => {
      assert.equal(getMarkerSizeForTier(1, 'diamond'), 24);
      assert.equal(getMarkerSizeForTier(2, 'diamond'), 16);
      assert.equal(getMarkerSizeForTier(3, 'diamond'), 12);
    });

    it('returns larger size for Tier 1 star', () => {
      assert.equal(getMarkerSizeForTier(1, 'star'), 28);
      assert.equal(getMarkerSizeForTier(2, 'star'), 16);
      assert.equal(getMarkerSizeForTier(3, 'star'), 12);
    });

    it('uses diamond size when shape not specified', () => {
      assert.equal(getMarkerSizeForTier(1), 24);
      assert.equal(getMarkerSizeForTier(2), 16);
      assert.equal(getMarkerSizeForTier(3), 12);
    });
  });

  describe('getMarkerIconUrl', () => {
    it('returns correct URL path', () => {
      assert.equal(getMarkerIconUrl('diamond', 1), '/icons/map-markers/diamond-large.svg');
      assert.equal(getMarkerIconUrl('square', 2), '/icons/map-markers/square-medium.svg');
      assert.equal(getMarkerIconUrl('hexagon', 3), '/icons/map-markers/hexagon-small.svg');
      assert.equal(getMarkerIconUrl('star', 1), '/icons/map-markers/star-large.svg');
    });
  });

  describe('MARKER_ICON_MAPPING', () => {
    it('has all 12 icon mappings', () => {
      assert.equal(Object.keys(MARKER_ICON_MAPPING).length, 12);
    });

    it('has correct dimensions for all icons', () => {
      const shapes: MarkerShape[] = ['diamond', 'square', 'hexagon', 'star'];
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

    it('star-large is bigger than other large icons', () => {
      assert.equal(MARKER_ICON_MAPPING['star-large'].width, 28);
      assert.equal(MARKER_ICON_MAPPING['diamond-large'].width, 24);
      assert.equal(MARKER_ICON_MAPPING['square-large'].width, 24);
      assert.equal(MARKER_ICON_MAPPING['hexagon-large'].width, 24);
    });
  });

  describe('getMarkerIcon', () => {
    it('returns cached icon definition with correct properties', () => {
      const icon = getMarkerIcon('diamond', 1);
      assert.ok(icon.url.startsWith('data:image/svg+xml;base64,'), 'URL should be a data URL');
      assert.equal(icon.width, 24);
      assert.equal(icon.height, 24);
      assert.equal(icon.mask, true);
    });

    it('returns same object reference for same parameters (caching)', () => {
      const icon1 = getMarkerIcon('square', 2);
      const icon2 = getMarkerIcon('square', 2);
      assert.strictEqual(icon1, icon2, 'Should return same cached object');
    });

    it('returns different objects for different parameters', () => {
      const icon1 = getMarkerIcon('hexagon', 1);
      const icon2 = getMarkerIcon('hexagon', 2);
      assert.notStrictEqual(icon1, icon2);
    });

    it('star tier 1 has larger dimensions', () => {
      const starIcon = getMarkerIcon('star', 1);
      const diamondIcon = getMarkerIcon('diamond', 1);
      assert.equal(starIcon.width, 28);
      assert.equal(diamondIcon.width, 24);
    });

    it('generates valid SVG data URL', () => {
      const icon = getMarkerIcon('diamond', 1);
      const base64Part = icon.url.replace('data:image/svg+xml;base64,', '');
      const decoded = atob(base64Part);
      assert.ok(decoded.includes('<svg'), 'Should contain SVG element');
      assert.ok(decoded.includes('<path'), 'Should contain path element');
      assert.ok(decoded.includes('fill="white"'), 'Should have white fill for masking');
    });
  });
});
