/**
 * Marker Icons Service
 *
 * Provides icon definitions for deck.gl IconLayer.
 * Uses inline SVG data URLs for reliable rendering.
 */

import type { MarkerTier } from './marker-tier';

export type MarkerShape = 'circle' | 'diamond' | 'triangle' | 'square';

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
export function getMarkerSizeForTier(tier: MarkerTier, _shape: MarkerShape = 'circle'): number {
  return tier === 1 ? 24 : tier === 2 ? 16 : 12;
}

/**
 * SVG path definitions for each shape
 * All shapes are white filled for mask coloring
 *
 * Shapes (4 total - simplified design):
 * - circle: Core infrastructure (Semiconductor Hubs, Data Centers)
 * - diamond: Professional/HQ (Tech HQs, Accelerators)
 * - triangle: Growth/Unicorns (Irish Unicorns)
 * - square: Foundation (Cloud Regions)
 */
const SVG_PATHS: Record<MarkerShape, string> = {
  circle: 'M12 2 A10 10 0 1 0 12 22 A10 10 0 1 0 12 2',
  diamond: 'M12 2 L22 12 L12 22 L2 12 Z',
  triangle: 'M12 3 L22 21 L2 21 Z',
  square: 'M3 3 H21 V21 H3 Z',
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
  'circle-small': { x: 0, y: 0, width: 12, height: 12, mask: true },
  'circle-medium': { x: 0, y: 0, width: 16, height: 16, mask: true },
  'circle-large': { x: 0, y: 0, width: 24, height: 24, mask: true },
  'diamond-small': { x: 0, y: 0, width: 12, height: 12, mask: true },
  'diamond-medium': { x: 0, y: 0, width: 16, height: 16, mask: true },
  'diamond-large': { x: 0, y: 0, width: 24, height: 24, mask: true },
  'triangle-small': { x: 0, y: 0, width: 12, height: 12, mask: true },
  'triangle-medium': { x: 0, y: 0, width: 16, height: 16, mask: true },
  'triangle-large': { x: 0, y: 0, width: 24, height: 24, mask: true },
  'square-small': { x: 0, y: 0, width: 12, height: 12, mask: true },
  'square-medium': { x: 0, y: 0, width: 16, height: 16, mask: true },
  'square-large': { x: 0, y: 0, width: 24, height: 24, mask: true },
};

/**
 * Get icon URL for a specific shape and tier
 */
export function getMarkerIconUrl(shape: MarkerShape, tier: MarkerTier): string {
  const iconName = getMarkerIconName(shape, tier);
  return `/icons/map-markers/${iconName}.svg`;
}


