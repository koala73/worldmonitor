/**
 * Single source of truth for the 13 canonical chokepoints.
 *
 * All other chokepoint references in the codebase should derive from or
 * validate against this registry.  Key relationships:
 *   - `id`              → canonical ID used everywhere in this repo
 *   - `geoId`           → same as `id`; matches STRATEGIC_WATERWAYS.id in geo.ts
 *   - `relayName`       → display name used by the AIS relay
 *   - `portwatchName`   → name in PortWatch transit data
 *   - `corridorRiskName`→ name in CorridorRisk feed (null = not covered)
 *   - `baselineId`      → EIA/IEA energy baseline ID (null = no energy model)
 *   - `shockModelSupported` → true for the 4 chokepoints with an energy shock model
 *   - `routeIds`        → TRADE_ROUTES.id values that include this chokepoint
 */
export interface ChokepointRegistryEntry {
  id: string;
  displayName: string;
  /** Same as id — matches STRATEGIC_WATERWAYS.id in geo.ts */
  geoId: string;
  relayName: string;
  portwatchName: string;
  corridorRiskName: string | null;
  /** EIA chokepoint baseline ID.  Null = no EIA baseline. */
  baselineId: string | null;
  /**
   * True for the 4 chokepoints that have an energy shock model
   * (suez, malacca_strait, hormuz_strait, bab_el_mandeb).
   */
  shockModelSupported: boolean;
  /** IDs of TRADE_ROUTES entries whose waypoints include this chokepoint. */
  routeIds: string[];
  lat: number;
  lon: number;
}

export const CHOKEPOINT_REGISTRY: readonly ChokepointRegistryEntry[] = [
  {
    id: 'suez',
    displayName: 'Suez Canal',
    geoId: 'suez',
    relayName: 'Suez Canal',
    portwatchName: 'Suez Canal',
    corridorRiskName: 'Suez',
    baselineId: 'suez',
    shockModelSupported: true,
    routeIds: ['china-europe-suez', 'china-us-east-suez', 'gulf-europe-oil', 'qatar-europe-lng', 'singapore-med', 'india-europe'],
    lat: 30.5,
    lon: 32.3,
  },
  {
    id: 'malacca_strait',
    displayName: 'Strait of Malacca',
    geoId: 'malacca_strait',
    relayName: 'Malacca Strait',
    portwatchName: 'Malacca Strait',
    corridorRiskName: 'Malacca',
    baselineId: 'malacca',
    shockModelSupported: true,
    routeIds: ['china-europe-suez', 'china-us-east-suez', 'gulf-asia-oil', 'qatar-asia-lng', 'india-se-asia', 'china-africa', 'cpec-route'],
    lat: 2.5,
    lon: 101.5,
  },
  {
    id: 'hormuz_strait',
    displayName: 'Strait of Hormuz',
    geoId: 'hormuz_strait',
    relayName: 'Strait of Hormuz',
    portwatchName: 'Strait of Hormuz',
    corridorRiskName: 'Hormuz',
    baselineId: 'hormuz',
    shockModelSupported: true,
    routeIds: ['gulf-europe-oil', 'gulf-asia-oil', 'qatar-europe-lng', 'qatar-asia-lng', 'gulf-americas-cape'],
    lat: 26.5,
    lon: 56.5,
  },
  {
    id: 'bab_el_mandeb',
    displayName: 'Bab el-Mandeb',
    geoId: 'bab_el_mandeb',
    relayName: 'Bab el-Mandeb Strait',
    portwatchName: 'Bab el-Mandeb Strait',
    corridorRiskName: 'Bab el-Mandeb',
    baselineId: 'babelm',
    shockModelSupported: true,
    routeIds: ['china-europe-suez', 'china-us-east-suez', 'gulf-europe-oil', 'qatar-europe-lng', 'singapore-med', 'india-europe'],
    lat: 12.5,
    lon: 43.3,
  },
  {
    id: 'panama',
    displayName: 'Panama Canal',
    geoId: 'panama',
    relayName: 'Panama Canal',
    portwatchName: 'Panama Canal',
    corridorRiskName: 'Panama',
    baselineId: 'panama',
    shockModelSupported: false,
    routeIds: ['china-us-east-panama', 'panama-transit'],
    lat: 9.1,
    lon: -79.7,
  },
  {
    id: 'taiwan_strait',
    displayName: 'Taiwan Strait',
    geoId: 'taiwan_strait',
    relayName: 'Taiwan Strait',
    portwatchName: 'Taiwan Strait',
    corridorRiskName: 'Taiwan',
    baselineId: null,
    shockModelSupported: false,
    routeIds: ['china-us-west', 'intra-asia-container'],
    lat: 24.0,
    lon: 119.5,
  },
  {
    id: 'cape_of_good_hope',
    displayName: 'Cape of Good Hope',
    geoId: 'cape_of_good_hope',
    relayName: 'Cape of Good Hope',
    portwatchName: 'Cape of Good Hope',
    corridorRiskName: 'Cape of Good Hope',
    baselineId: null,
    shockModelSupported: false,
    routeIds: ['brazil-china-bulk', 'gulf-americas-cape', 'asia-europe-cape'],
    lat: -34.36,
    lon: 18.49,
  },
  {
    id: 'gibraltar',
    displayName: 'Strait of Gibraltar',
    geoId: 'gibraltar',
    relayName: 'Gibraltar Strait',
    portwatchName: 'Gibraltar Strait',
    corridorRiskName: null,
    baselineId: null,
    shockModelSupported: false,
    routeIds: ['gulf-europe-oil', 'singapore-med', 'india-europe', 'asia-europe-cape'],
    lat: 35.9,
    lon: -5.6,
  },
  {
    id: 'bosphorus',
    displayName: 'Bosporus Strait',
    geoId: 'bosphorus',
    relayName: 'Bosporus Strait',
    portwatchName: 'Bosporus Strait',
    corridorRiskName: null,
    baselineId: 'turkish',
    shockModelSupported: false,
    routeIds: ['russia-med-oil'],
    lat: 41.1,
    lon: 29.0,
  },
  {
    id: 'korea_strait',
    displayName: 'Korea Strait',
    geoId: 'korea_strait',
    relayName: 'Korea Strait',
    portwatchName: 'Korea Strait',
    corridorRiskName: null,
    baselineId: null,
    shockModelSupported: false,
    routeIds: [],
    lat: 34.0,
    lon: 129.0,
  },
  {
    id: 'dover_strait',
    displayName: 'Dover Strait',
    geoId: 'dover_strait',
    relayName: 'Dover Strait',
    portwatchName: 'Dover Strait',
    corridorRiskName: null,
    baselineId: 'danish',
    shockModelSupported: false,
    routeIds: [],
    lat: 51.0,
    lon: 1.5,
  },
  {
    id: 'kerch_strait',
    displayName: 'Kerch Strait',
    geoId: 'kerch_strait',
    relayName: 'Kerch Strait',
    portwatchName: 'Kerch Strait',
    corridorRiskName: null,
    baselineId: null,
    shockModelSupported: false,
    routeIds: [],
    lat: 45.3,
    lon: 36.6,
  },
  {
    id: 'lombok_strait',
    displayName: 'Lombok Strait',
    geoId: 'lombok_strait',
    relayName: 'Lombok Strait',
    portwatchName: 'Lombok Strait',
    corridorRiskName: null,
    baselineId: null,
    shockModelSupported: false,
    routeIds: [],
    lat: -8.5,
    lon: 115.7,
  },
];

/** Set of canonical IDs for fast membership checks. */
export const CANONICAL_CHOKEPOINT_IDS = new Set(CHOKEPOINT_REGISTRY.map(c => c.id));

/** Lookup by canonical ID. */
export function getChokepoint(id: string): ChokepointRegistryEntry | undefined {
  return CHOKEPOINT_REGISTRY.find(c => c.id === id);
}

/** Chokepoints that have an energy shock model (oil + LNG). */
export const SHOCK_MODEL_CHOKEPOINTS = CHOKEPOINT_REGISTRY.filter(c => c.shockModelSupported);
