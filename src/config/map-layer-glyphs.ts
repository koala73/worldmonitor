import type { MapLayers } from '@/types';
import { LAYER_REGISTRY } from './map-layer-definitions';

/**
 * Category identity for DeckGL map markers (#10139).
 *
 * Each point-marker deck layer id maps to the picker layer that owns it, so
 * the map can draw the same symbol the Layers menu shows next to that layer
 * (`LAYER_REGISTRY[key].icon`) and name the layer in hover tooltips. Line,
 * fill, arc and heatmap layers are deliberately absent: a point glyph does not
 * describe them.
 */
export const DECK_POINT_LAYER_CATEGORY: Readonly<Record<string, keyof MapLayers>> = {
  'hotspots-layer': 'hotspots',
  'iran-events-layer': 'iranAttacks',
  'bases-layer': 'bases',
  'bases-cluster-layer': 'bases',
  'nuclear-layer': 'nuclear',
  'irradiators-layer': 'irradiators',
  'radiation-watch-layer': 'radiationWatch',
  'spaceports-layer': 'spaceports',
  'storage-facilities-layer': 'storageFacilities',
  'fuel-shortages-layer': 'fuelShortages',
  'datacenters-layer': 'datacenters',
  'datacenter-clusters-layer': 'datacenters',
  'military-flights-layer': 'military',
  'military-flight-clusters-layer': 'military',
  'military-vessels-layer': 'military',
  'military-vessel-clusters-layer': 'military',
  'flight-delays-layer': 'flights',
  'aircraft-emergencies': 'aircraftEmergencies',
  'protest-clusters-layer': 'protests',
  'ucdp-events-layer': 'ucdpEvents',
  'displacement-events-layer': 'displacement',
  'climate-heatmap-layer': 'climate',
  'weather-layer': 'weather',
  'canada-alerts-layer': 'canadaAlerts',
  'outages-layer': 'outages',
  'cyber-threats-layer': 'cyberThreats',
  'natural-events-layer': 'natural',
  'earthquakes-layer': 'natural',
  'fires-layer': 'fires',
  'waterways-layer': 'waterways',
  'economic-centers-layer': 'economic',
  'minerals-layer': 'minerals',
  'disease-outbreaks-layer': 'diseaseOutbreaks',
  'live-tankers-layer': 'liveTankers',
  'webcam-layer': 'webcams',
  'startup-hubs-layer': 'startupHubs',
  'tech-hq-clusters-layer': 'techHQs',
  'accelerators-layer': 'accelerators',
  'cloud-regions-layer': 'cloudRegions',
  'tech-event-clusters-layer': 'techEvents',
  'stock-exchanges-layer': 'stockExchanges',
  'financial-centers-layer': 'financialCenters',
  'central-banks-layer': 'centralBanks',
  'commodity-hubs-layer': 'commodityHubs',
  'gulf-investments-layer': 'gulfInvestments',
  'positive-events-layer': 'positiveEvents',
  'kindness-layer': 'kindness',
  'species-recovery-layer': 'speciesRecovery',
  'renewable-installations-layer': 'renewableInstallations',
  'mining-sites-layer': 'miningSites',
  'processing-plants-layer': 'processingPlants',
  'commodity-ports-layer': 'commodityPorts',
};

/**
 * From this zoom every point layer gets glyphs. Below it the world view is too
 * dense, so only sparse layers (at most CATEGORY_GLYPH_SPARSE_LIMIT markers)
 * keep a smaller glyph.
 */
export const CATEGORY_GLYPH_MIN_ZOOM = 3;
export const CATEGORY_GLYPH_SPARSE_LIMIT = 120;

/**
 * Glyph edge in CSS pixels for a layer of `markerCount` markers at `zoom`;
 * 0 means draw no glyphs. Grows with zoom and caps at 20px.
 */
export function categoryGlyphSizePx(zoom: number, markerCount: number): number {
  if (!Number.isFinite(zoom) || markerCount <= 0) return 0;
  if (zoom < CATEGORY_GLYPH_MIN_ZOOM) return markerCount <= CATEGORY_GLYPH_SPARSE_LIMIT ? 12 : 0;
  return Math.min(20, Math.round(14 + (zoom - CATEGORY_GLYPH_MIN_ZOOM) * 2));
}

/** Map-layer key that owns a deck layer id, ignoring the `-ghost` pick twin. */
export function categoryForDeckLayerId(layerId: string): keyof MapLayers | undefined {
  const id = layerId.endsWith('-ghost') ? layerId.slice(0, -'-ghost'.length) : layerId;
  return DECK_POINT_LAYER_CATEGORY[id];
}

/**
 * Decode a registry icon (HTML numeric entities such as `&#9992;`) into the
 * text drawn on canvas. A variation selector asks for emoji presentation so
 * symbols like ✈ and ⚔ match the colour glyphs the Layers menu shows.
 */
export function decodeLayerIcon(icon: string): string {
  const text = icon.replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code: string) => {
    const value = code[0]!.toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : parseInt(code, 10);
    return Number.isFinite(value) ? String.fromCodePoint(value) : '';
  });
  return text.endsWith('️') ? text : `${text}️`;
}

/** Glyph text for a map layer, from the same registry the Layers menu uses. */
export function categoryGlyphForLayer(key: keyof MapLayers): string {
  return decodeLayerIcon(LAYER_REGISTRY[key].icon);
}
