import type { MapLayers } from '@/types';
import { LAYER_REGISTRY } from './map-layer-definitions';

/**
 * Category identity for DeckGL map markers (#10139).
 *
 * Each point-marker deck layer id maps to the picker layer that owns it, so
 * the map can draw the same symbol the Layers menu shows next to that layer
 * (`LAYER_REGISTRY[key].icon`) and name the layer in hover tooltips. Line,
 * fill, arc and heatmap layers are deliberately absent: a point glyph does not
 * describe them, and so are pulse rings and other decorations; see
 * CATEGORY_GLYPH_EXCLUDED_POINT_LAYER_IDS for the point layers left out on
 * purpose.
 */
export const DECK_POINT_LAYER_CATEGORY: Readonly<Record<string, keyof MapLayers>> = {
  'hotspots-layer': 'hotspots',
  'notam-airspace-markers': 'flights',
  'ports-layer': 'ais',
  'ukmto-incidents-layer': 'ais',
  'ais-disruptions-layer': 'ais',
  'cable-advisories-layer': 'cables',
  'repair-ships-layer': 'cables',
  'apt-groups-layer': 'cyberThreats',
  'traffic-anomalies-layer': 'outages',
  'ddos-locations-layer': 'outages',
  'storm-centers-layer': 'natural',
  'canada-roads-layer': 'canadaRoads',
  'cross-border-points-layer': 'displacement',
  'cross-border-deaths-layer': 'displacement',
  'internal-displacement-regions-layer': 'displacement',
  'trade-chokepoints-layer': 'tradeRoutes',
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
 * Point-marker layers DeckGLMap builds that deliberately get no glyph, with
 * the reason. Every other point layer must be in DECK_POINT_LAYER_CATEGORY.
 */
export const CATEGORY_GLYPH_EXCLUDED_POINT_LAYER_IDS: Readonly<Record<string, string>> = {
  'aircraft-positions-layer': 'already drawn as a plane silhouette',
  'ais-density-layer': 'density cells, not individual objects',
  'notam-airspace-circles': 'airspace areas, not points',
  'notam-overlay-layer': 'closure rings around airports the flight-delay markers already badge',
  'climate-heatmap-layer': 'translucent anomaly areas, not point markers',
  'trade-route-trips-layer': 'animated trip heads along route lines',
  'highlighted-chokepoint-markers': 'selection highlight over chokepoint markers',
  'news-locations-layer': 'news markers, not a picker layer',
  'news-pulse-layer': 'pulse ring decoration',
  'hotspots-pulse': 'pulse ring decoration',
  'protest-clusters-pulse': 'pulse ring decoration',
  'positive-events-pulse': 'pulse ring decoration',
  'kindness-pulse': 'pulse ring decoration',
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

const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
const TILE_SIZE_PX = 512;

export interface MarkerRadiusSpec {
  /** deck.gl unit of `value`: 'meters' (ScatterplotLayer default), 'pixels' or 'common'. */
  units?: string;
  value: number;
  scale?: number;
  minPx?: number;
  maxPx?: number;
  lat: number;
  zoom: number;
}

/**
 * On-screen radius in CSS pixels of a deck.gl marker, mirroring how
 * ScatterplotLayer/IconLayer turn radius or size props into pixels at a zoom:
 * unit conversion, then the min/max pixel clamp. A badge placed at this
 * distance plus its own half-width clears the marker and its status colour.
 */
export function markerPixelRadius(spec: MarkerRadiusSpec): number {
  const raw = (Number.isFinite(spec.value) ? spec.value : 0) * (spec.scale ?? 1);
  const worldPx = TILE_SIZE_PX * 2 ** spec.zoom;
  let px: number;
  if (spec.units === 'pixels') px = raw;
  else if (spec.units === 'common') px = raw * 2 ** spec.zoom;
  else px = raw * worldPx / (EARTH_CIRCUMFERENCE_M * Math.max(0.01, Math.cos(spec.lat * Math.PI / 180)));
  return Math.min(spec.maxPx ?? Number.MAX_SAFE_INTEGER, Math.max(spec.minPx ?? 0, px));
}

/** Map-layer key that owns a deck layer id, ignoring the `-ghost` pick twin. */
export function categoryForDeckLayerId(layerId: string): keyof MapLayers | undefined {
  const id = layerId.endsWith('-ghost') ? layerId.slice(0, -'-ghost'.length) : layerId;
  return DECK_POINT_LAYER_CATEGORY[id];
}

/** U+FE0F VARIATION SELECTOR-16: ask for emoji (colour) presentation. */
const EMOJI_PRESENTATION = '\uFE0F';

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
  return text.endsWith(EMOJI_PRESENTATION) ? text : `${text}${EMOJI_PRESENTATION}`;
}

/** Glyph text for a map layer, from the same registry the Layers menu uses. */
export function categoryGlyphForLayer(key: keyof MapLayers): string {
  return decodeLayerIcon(LAYER_REGISTRY[key].icon);
}
