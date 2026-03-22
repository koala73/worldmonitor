/**
 * Marker Icons Service
 *
 * Provides icon definitions for deck.gl IconLayer.
 * Uses inline SVG data URLs for reliable rendering.
 */

import type { MarkerTier } from './marker-tier';

export type MarkerShape = 'diamond' | 'square' | 'hexagon' | 'star';

/**
 * Icon definition for deck.gl IconLayer
 */
export interface IconDefinition {
  id: string;
  url: string;
  width: number;
  height: number;
  mask: boolean;
  anchorY: number;
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
  if (shape === 'star' && tier === 1) return 28;
  return tier === 1 ? 24 : tier === 2 ? 16 : 12;
}

/**
 * SVG path definitions for each shape
 * All shapes are white filled for mask coloring
 */
const SVG_PATHS: Record<MarkerShape, string> = {
  diamond: 'M12 2 L22 12 L12 22 L2 12 Z',
  square: 'M3 3 H21 V21 H3 Z',
  hexagon: 'M12 2 L21 7 L21 17 L12 22 L3 17 L3 7 Z',
  star: 'M12 2 L14.5 9 L22 9 L16 14 L18.5 22 L12 17 L5.5 22 L8 14 L2 9 L9.5 9 Z',
};

/**
 * Generate SVG data URL for a shape
 */
function generateSvgDataUrl(shape: MarkerShape, size: number): string {
  const path = SVG_PATHS[shape];
  // Scale path to fit size (original paths are designed for 24x24)
  const scale = size / 24;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">
    <g transform="scale(${scale})">
      <path d="${path}" fill="white"/>
    </g>
  </svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
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
      id: key,
      url: generateSvgDataUrl(shape, size),
      width: size,
      height: size,
      mask: true,
      anchorY: size,
    };
  }
  return ICON_CACHE[key];
}

/**
 * Icon mapping for IconLayer (legacy format, kept for tests)
 */
export const MARKER_ICON_MAPPING: Record<string, { x: number; y: number; width: number; height: number; mask: boolean }> = {
  'diamond-small': { x: 0, y: 0, width: 12, height: 12, mask: true },
  'diamond-medium': { x: 0, y: 0, width: 16, height: 16, mask: true },
  'diamond-large': { x: 0, y: 0, width: 24, height: 24, mask: true },
  'square-small': { x: 0, y: 0, width: 12, height: 12, mask: true },
  'square-medium': { x: 0, y: 0, width: 16, height: 16, mask: true },
  'square-large': { x: 0, y: 0, width: 24, height: 24, mask: true },
  'hexagon-small': { x: 0, y: 0, width: 12, height: 12, mask: true },
  'hexagon-medium': { x: 0, y: 0, width: 16, height: 16, mask: true },
  'hexagon-large': { x: 0, y: 0, width: 24, height: 24, mask: true },
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

