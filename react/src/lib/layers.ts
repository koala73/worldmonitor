/** Overlay layer metadata for React map toggles (labels from LAYER_REGISTRY). */

import { LAYER_KEYS, type LayerKey } from './url-state';

export type OverlayKind = 'point' | 'line';

export interface OverlayDef {
  key: LayerKey;
  label: string;
  kind: OverlayKind;
  /** Accent for empty-source visibility indicator in UI */
  color: string;
}

const LABELS: Partial<Record<LayerKey, { label: string; kind: OverlayKind; color: string }>> = {
  conflicts: { label: 'Conflict Zones', kind: 'point', color: '#c62828' },
  bases: { label: 'Military Bases', kind: 'point', color: '#1565c0' },
  cables: { label: 'Undersea Cables', kind: 'line', color: '#00838f' },
  pipelines: { label: 'Pipelines', kind: 'line', color: '#6a1b9a' },
  hotspots: { label: 'Intel Hotspots', kind: 'point', color: '#ef6c00' },
  convoHotspots: { label: 'Convo Hotspots', kind: 'point', color: '#c62828' },
  aiUsage: { label: 'AI Usage', kind: 'point', color: '#1565c0' },
  aiPolicy: { label: 'AI Policy', kind: 'point', color: '#5e35b1' },
  nuclear: { label: 'Nuclear Sites', kind: 'point', color: '#f9a825' },
  irradiators: { label: 'Gamma Irradiators', kind: 'point', color: '#ff8f00' },
  ais: { label: 'AIS Shipping', kind: 'point', color: '#0277bd' },
  military: { label: 'Military', kind: 'point', color: '#37474f' },
  protests: { label: 'Protests', kind: 'point', color: '#ad1457' },
  sanctions: { label: 'Sanctions', kind: 'point', color: '#455a64' },
  weather: { label: 'Weather', kind: 'point', color: '#0288d1' },
  natural: { label: 'Natural Hazards', kind: 'point', color: '#558b2f' },
  outages: { label: 'Outages', kind: 'point', color: '#bf360c' },
  cyberThreats: { label: 'Cyber Threats', kind: 'point', color: '#6a1b9a' },
  datacenters: { label: 'Datacenters', kind: 'point', color: '#283593' },
  waterways: { label: 'Waterways', kind: 'line', color: '#00695c' },
  tradeRoutes: { label: 'Trade Routes', kind: 'line', color: '#4527a0' },
  fires: { label: 'Fires', kind: 'point', color: '#d84315' },
  ucdpEvents: { label: 'UCDP Events', kind: 'point', color: '#b71c1c' },
  iranAttacks: { label: 'Iran Attacks', kind: 'point', color: '#c62828' },
  ciiChoropleth: { label: 'CII Choropleth', kind: 'point', color: '#5d4037' },
  stockExchanges: { label: 'Stock Exchanges', kind: 'point', color: '#2e7d32' },
  financialCenters: { label: 'Financial Centers', kind: 'point', color: '#1b5e20' },
  centralBanks: { label: 'Central Banks', kind: 'point', color: '#33691e' },
  commodityHubs: { label: 'Commodity Hubs', kind: 'point', color: '#827717' },
  commodityPorts: { label: 'Commodity Ports', kind: 'point', color: '#f57f17' },
  storageFacilities: { label: 'Storage Facilities', kind: 'point', color: '#e65100' },
  fuelShortages: { label: 'Fuel Shortages', kind: 'point', color: '#ff6f00' },
  liveTankers: { label: 'Live Tankers', kind: 'point', color: '#01579b' },
  startupHubs: { label: 'Startup Hubs', kind: 'point', color: '#00695c' },
  techHQs: { label: 'Tech HQs', kind: 'point', color: '#004d40' },
  techEvents: { label: 'Tech Events', kind: 'point', color: '#00796b' },
  cloudRegions: { label: 'Cloud Regions', kind: 'point', color: '#00838f' },
  accelerators: { label: 'Accelerators', kind: 'point', color: '#b47800' },
  positiveEvents: { label: 'Positive Events', kind: 'point', color: '#43a047' },
  happiness: { label: 'Happiness', kind: 'point', color: '#7cb342' },
  speciesRecovery: { label: 'Species Recovery', kind: 'point', color: '#558b2f' },
  renewableInstallations: { label: 'Renewables', kind: 'point', color: '#2e7d32' },
  webcams: { label: 'Webcams', kind: 'point', color: '#546e7a' },
  minerals: { label: 'Minerals', kind: 'point', color: '#795548' },
  spaceports: { label: 'Spaceports', kind: 'point', color: '#37474f' },
  flights: { label: 'Flights', kind: 'point', color: '#0277bd' },
  economic: { label: 'Economic', kind: 'point', color: '#1565c0' },
  displacement: { label: 'Displacement', kind: 'point', color: '#6d4c41' },
  satellites: { label: 'Satellites', kind: 'point', color: '#4527a0' },
  gulfInvestments: { label: 'Gulf Investments', kind: 'point', color: '#00838f' },
  resilienceScore: { label: 'Resilience Score', kind: 'point', color: '#00695c' },
  kindness: { label: 'Kindness', kind: 'point', color: '#66bb6a' },
};

/**
 * Primary overlays in the map Overlays dropdown.
 * Includes AI Footprint A–E density layers so they are reachable outside the drawer.
 */
export const PRIMARY_OVERLAY_KEYS: LayerKey[] = [
  'conflicts',
  'bases',
  'cables',
  'pipelines',
  'nuclear',
  'irradiators',
  'military',
  'ais',
  'protests',
  'sanctions',
  'weather',
  'natural',
  'outages',
  'tradeRoutes',
  'waterways',
  // AI Footprint A–E
  'techHQs',
  'convoHotspots',
  'aiUsage',
  'startupHubs',
  'accelerators',
  'datacenters',
  'cloudRegions',
  'aiPolicy',
  'techEvents',
];

export function getOverlayDef(key: LayerKey): OverlayDef {
  const meta = LABELS[key] ?? { label: key, kind: 'point' as const, color: '#607d8b' };
  return { key, label: meta.label, kind: meta.kind, color: meta.color };
}

export function listPrimaryOverlays(): OverlayDef[] {
  return PRIMARY_OVERLAY_KEYS.map(getOverlayDef);
}

export function listAllOverlays(): OverlayDef[] {
  return LAYER_KEYS.map(getOverlayDef);
}

export const EMPTY_FEATURE_COLLECTION = {
  type: 'FeatureCollection' as const,
  features: [] as Array<never>,
};
