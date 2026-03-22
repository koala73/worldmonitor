/**
 * Marker Icons Service
 *
 * Provides icon definitions for deck.gl IconLayer.
 * Uses pre-cached icon objects for stable references.
 */

import type { MarkerTier } from './marker-tier';

export type MarkerShape = 'diamond' | 'square' | 'hexagon' | 'star';

/**
 * Icon definition for deck.gl IconLayer
 */
export interface IconDefinition {
  url: string;
  width: number;
  height: number;
  mask: boolean;
}

/**
 * Get icon name based on shape and tier
 */
export function getMarkerIconName(shape: MarkerShape, tier: MarkerTier): string {
  const sizeLabel = tier === 1 ? 'large' : tier === 2 ? 'medium' : 'small';
  return `${shape}-${sizeLabel}`;
}

/**
 * Get icon size based on tier
 */
export function getMarkerSizeForTier(tier: MarkerTier, shape: MarkerShape = 'diamond'): number {
  if (shape === 'star' && tier === 1) return 28; // Stars are slightly larger
  return tier === 1 ? 24 : tier === 2 ? 16 : 12;
}

/**
 * Pre-cached icon definitions for stable references
 * deck.gl IconLayer requires stable object references for getIcon
 */
const ICON_CACHE: Record<string, IconDefinition> = {};

/**
 * Get cached icon definition for a specific shape and tier
 * Returns the same object reference for the same parameters
 */
export function getMarkerIcon(shape: MarkerShape, tier: MarkerTier): IconDefinition {
  const key = `${shape}-${tier}`;
  if (!ICON_CACHE[key]) {
    const size = getMarkerSizeForTier(tier, shape);
    ICON_CACHE[key] = {
      url: `/icons/map-markers/${getMarkerIconName(shape, tier)}.svg`,
      width: size,
      height: size,
      mask: true,
    };
  }
  return ICON_CACHE[key];
}

/**
 * Icon mapping for IconLayer (legacy format, kept for tests)
 */
export const MARKER_ICON_MAPPING: Record<string, { x: number; y: number; width: number; height: number; mask: boolean }> = {
  // Diamond shapes
  'diamond-small': { x: 0, y: 0, width: 12, height: 12, mask: true },
  'diamond-medium': { x: 0, y: 0, width: 16, height: 16, mask: true },
  'diamond-large': { x: 0, y: 0, width: 24, height: 24, mask: true },
  // Square shapes
  'square-small': { x: 0, y: 0, width: 12, height: 12, mask: true },
  'square-medium': { x: 0, y: 0, width: 16, height: 16, mask: true },
  'square-large': { x: 0, y: 0, width: 24, height: 24, mask: true },
  // Hexagon shapes
  'hexagon-small': { x: 0, y: 0, width: 12, height: 12, mask: true },
  'hexagon-medium': { x: 0, y: 0, width: 16, height: 16, mask: true },
  'hexagon-large': { x: 0, y: 0, width: 24, height: 24, mask: true },
  // Star shapes
  'star-small': { x: 0, y: 0, width: 12, height: 12, mask: true },
  'star-medium': { x: 0, y: 0, width: 16, height: 16, mask: true },
  'star-large': { x: 0, y: 0, width: 28, height: 28, mask: true },
};

/**
 * Get icon URL for a specific shape and tier
 */
export function getMarkerIconUrl(shape: MarkerShape, tier: MarkerTier): string {
  const iconName = getMarkerIconName(shape, tier);
  return `/icons/map-markers/${iconName}.svg`;
}
