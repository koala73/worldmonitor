/**
 * Infrastructure cascade core — "what if corridor X fails".
 *
 * Builds a dependency graph over undersea cables, pipelines, ports, maritime
 * chokepoints and the countries they serve, then walks it breadth-first to
 * estimate how a single failure propagates.
 *
 * Dependency-free by design (no src/ imports, no DOM, no i18n) so it bundles
 * under Edge/esbuild for server-side tools. The dashboard reaches it through
 * src/services/infrastructure-cascade.ts, which supplies the lazily-loaded
 * cable table and the strategic-waterway list.
 */

import { PIPELINES } from './pipelines-data';
import { PORTS } from './ports-data';
import { haversineKm } from './geo-distance';
import type { PipelineRecord } from './pipelines-data';
import type { PortRecord } from './ports-data';

export type InfrastructureNodeType = 'cable' | 'pipeline' | 'port' | 'chokepoint' | 'country' | 'route';

export interface InfrastructureNode {
  id: string;
  type: InfrastructureNodeType;
  name: string;
  coordinates?: [number, number];
  metadata?: Record<string, unknown>;
}

export type DependencyType =
  | 'serves'
  | 'terminates_at'
  | 'transits_through'
  | 'lands_at'
  | 'depends_on'
  | 'shares_risk'
  | 'alternative_to'
  | 'trade_route'
  | 'controls_access'
  | 'trade_dependency';

export interface DependencyEdge {
  from: string;
  to: string;
  type: DependencyType;
  strength: number;       // 0-1 criticality
  redundancy?: number;    // 0-1 how replaceable
  metadata?: {
    capacityShare?: number;
    alternativeRoutes?: number;
    estimatedImpact?: string;
    portType?: string;
    relationship?: string;
  };
}

export type CascadeImpactLevel = 'critical' | 'high' | 'medium' | 'low';

export interface CascadeAffectedNode {
  node: InfrastructureNode;
  impactLevel: CascadeImpactLevel;
  pathLength: number;
  dependencyChain: string[];
  redundancyAvailable: boolean;
  estimatedRecovery?: string;
}

export interface CascadeCountryImpact {
  country: string;
  countryName: string;
  impactLevel: CascadeImpactLevel;
  affectedCapacity: number;
  criticalSectors?: string[];
}

export interface CascadeResult {
  source: InfrastructureNode;
  affectedNodes: CascadeAffectedNode[];
  countriesAffected: CascadeCountryImpact[];
  economicImpact?: {
    dailyTradeLoss?: number;
    affectedThroughput?: number;
  };
  redundancies?: {
    id: string;
    name: string;
    capacityShare: number;
    /** False when the alternative crosses a chokepoint that a cut cable also crosses. */
    avoidsCutZone?: boolean;
  }[];
  /** Every disrupted node when several were cut together (multi-cable / chokepoint cut). */
  sources?: InfrastructureNode[];
  /** Present when the result rests on estimated rather than measured inputs. */
  dataQuality?: {
    estimated: boolean;
    note: string;
  };
}

/** Structural shape of an undersea cable — mirrors the client `UnderseaCable`. */
export interface CableInput {
  id: string;
  name: string;
  points?: [number, number][];
  landingPoints?: { country: string; countryName?: string; city?: string; lat?: number; lon?: number }[];
  countriesServed?: { country: string; capacityShare: number; isRedundant?: boolean }[];
  capacityTbps?: number;
  rfsYear?: number;
  owners?: string[];
}

/** Structural shape of a maritime chokepoint — mirrors `StrategicWaterway`. */
export interface WaterwayInput {
  id: string;
  name: string;
  lat: number;
  lon: number;
  description?: string;
}

export type PipelineInput = PipelineRecord;
export type PortInput = PortRecord;

export interface CascadeGraphInputs {
  cables: CableInput[];
  waterways: WaterwayInput[];
  pipelines?: PipelineInput[];
  ports?: PortInput[];
}

export interface DependencyGraph {
  nodes: Map<string, InfrastructureNode>;
  edges: DependencyEdge[];
  outgoing: Map<string, DependencyEdge[]>;
  incoming: Map<string, DependencyEdge[]>;
  /** The cable table the graph was built from — cascade scoring reads it back. */
  cables: CableInput[];
}

// Country name lookup
const COUNTRY_NAMES: Record<string, string> = {
  US: 'United States', GB: 'United Kingdom', ES: 'Spain', FR: 'France',
  DE: 'Germany', IT: 'Italy', PT: 'Portugal', NO: 'Norway', DK: 'Denmark',
  NL: 'Netherlands', BE: 'Belgium', SE: 'Sweden', FI: 'Finland', IE: 'Ireland',
  AT: 'Austria', CH: 'Switzerland', GR: 'Greece', CZ: 'Czech Republic',
  JP: 'Japan', CN: 'China', TW: 'Taiwan', HK: 'Hong Kong', SG: 'Singapore',
  KR: 'South Korea', AU: 'Australia', NZ: 'New Zealand', IN: 'India', PK: 'Pakistan',
  AE: 'UAE', SA: 'Saudi Arabia', EG: 'Egypt', KW: 'Kuwait', BH: 'Bahrain',
  OM: 'Oman', QA: 'Qatar', IR: 'Iran', IQ: 'Iraq', TR: 'Turkey', IL: 'Israel',
  JO: 'Jordan', LB: 'Lebanon', SY: 'Syria', YE: 'Yemen',
  NG: 'Nigeria', ZA: 'South Africa', KE: 'Kenya', TZ: 'Tanzania',
  MZ: 'Mozambique', MG: 'Madagascar', SN: 'Senegal', GH: 'Ghana',
  CI: 'Ivory Coast', AO: 'Angola', ET: 'Ethiopia', UG: 'Uganda',
  BR: 'Brazil', AR: 'Argentina', CL: 'Chile',
  PE: 'Peru', CO: 'Colombia', MX: 'Mexico', PA: 'Panama', VE: 'Venezuela',
  IS: 'Iceland', FO: 'Faroe Islands', FJ: 'Fiji', ID: 'Indonesia',
  VN: 'Vietnam', TH: 'Thailand', MY: 'Malaysia', PH: 'Philippines',
  RU: 'Russia', UA: 'Ukraine', PL: 'Poland', RO: 'Romania', HU: 'Hungary',
  CA: 'Canada', DJ: 'Djibouti', BD: 'Bangladesh', LK: 'Sri Lanka', MM: 'Myanmar',
};

function addCablesAsNodes(graph: DependencyGraph, cables: CableInput[]): void {
  for (const cable of cables) {
    const firstPoint = cable.points?.[0];
    graph.nodes.set(`cable:${cable.id}`, {
      id: `cable:${cable.id}`,
      type: 'cable',
      name: cable.name,
      coordinates: firstPoint ? [firstPoint[0], firstPoint[1]] : undefined,
      metadata: {
        capacityTbps: cable.capacityTbps,
        rfsYear: cable.rfsYear,
        owners: cable.owners,
        landingPoints: cable.landingPoints,
      },
    });
  }
}

function addPipelinesAsNodes(graph: DependencyGraph, pipelines: PipelineInput[]): void {
  for (const pipeline of pipelines) {
    const firstPoint = pipeline.points?.[0];
    graph.nodes.set(`pipeline:${pipeline.id}`, {
      id: `pipeline:${pipeline.id}`,
      type: 'pipeline',
      name: pipeline.name,
      coordinates: firstPoint ? [firstPoint[0], firstPoint[1]] : undefined,
      metadata: {
        type: pipeline.type,
        status: pipeline.status,
        capacity: pipeline.capacity,
        operator: pipeline.operator,
        countries: pipeline.countries,
      },
    });
  }
}

function addPortsAsNodes(graph: DependencyGraph, ports: PortInput[]): void {
  for (const port of ports) {
    graph.nodes.set(`port:${port.id}`, {
      id: `port:${port.id}`,
      type: 'port',
      name: port.name,
      coordinates: [port.lon, port.lat],
      metadata: {
        country: port.country,
        type: port.type,
        rank: port.rank,
      },
    });
  }
}

function addChokepointsAsNodes(graph: DependencyGraph, waterways: WaterwayInput[]): void {
  for (const waterway of waterways) {
    graph.nodes.set(`chokepoint:${waterway.id}`, {
      id: `chokepoint:${waterway.id}`,
      type: 'chokepoint',
      name: waterway.name,
      coordinates: [waterway.lon, waterway.lat],
      metadata: {
        description: waterway.description,
      },
    });
  }
}

function addCountriesAsNodes(
  graph: DependencyGraph,
  cables: CableInput[],
  pipelines: PipelineInput[],
): void {
  const countries = new Set<string>();

  for (const cable of cables) {
    cable.countriesServed?.forEach(c => countries.add(c.country));
    cable.landingPoints?.forEach(lp => countries.add(lp.country));
  }

  for (const pipeline of pipelines) {
    pipeline.countries?.forEach(c => {
      const code = c === 'USA' ? 'US' : c === 'Canada' ? 'CA' : c;
      countries.add(code);
    });
  }

  for (const code of countries) {
    graph.nodes.set(`country:${code}`, {
      id: `country:${code}`,
      type: 'country',
      name: COUNTRY_NAMES[code] || code,
      metadata: { code },
    });
  }
}

function addEdge(graph: DependencyGraph, edge: DependencyEdge): void {
  graph.edges.push(edge);

  if (!graph.outgoing.has(edge.from)) graph.outgoing.set(edge.from, []);
  graph.outgoing.get(edge.from)!.push(edge);

  if (!graph.incoming.has(edge.to)) graph.incoming.set(edge.to, []);
  graph.incoming.get(edge.to)!.push(edge);
}

function buildCableCountryEdges(graph: DependencyGraph, cables: CableInput[]): void {
  for (const cable of cables) {
    const cableId = `cable:${cable.id}`;

    cable.countriesServed?.forEach(cs => {
      const countryId = `country:${cs.country}`;
      addEdge(graph, {
        from: cableId,
        to: countryId,
        type: 'serves',
        strength: cs.capacityShare,
        redundancy: cs.isRedundant ? 0.5 : 0,
        metadata: {
          capacityShare: cs.capacityShare,
          estimatedImpact: cs.isRedundant ? 'Medium - redundancy available' : 'High - limited redundancy',
        },
      });
    });

    cable.landingPoints?.forEach(lp => {
      const countryId = `country:${lp.country}`;
      addEdge(graph, {
        from: cableId,
        to: countryId,
        type: 'lands_at',
        strength: 0.3,
        redundancy: 0.5,
      });
    });
  }
}

function buildPipelineCountryEdges(graph: DependencyGraph, pipelines: PipelineInput[]): void {
  for (const pipeline of pipelines) {
    const pipelineId = `pipeline:${pipeline.id}`;

    pipeline.countries?.forEach(country => {
      const code = country === 'USA' ? 'US' : country === 'Canada' ? 'CA' : country;
      const countryId = `country:${code}`;

      if (graph.nodes.has(countryId)) {
        addEdge(graph, {
          from: pipelineId,
          to: countryId,
          type: 'serves',
          strength: 0.2,
          redundancy: 0.3,
        });
      }
    });
  }
}

// Country code normalization for ports
function normalizeCountryCode(country: string): string {
  const mappings: Record<string, string> = {
    'USA': 'US', 'China': 'CN', 'China (SAR)': 'CN', 'Taiwan': 'TW',
    'South Korea': 'KR', 'Netherlands': 'NL', 'Belgium': 'BE',
    'Malaysia': 'MY', 'Thailand': 'TH', 'Greece': 'GR',
    'Saudi Arabia': 'SA', 'Iran': 'IR', 'Qatar': 'QA', 'Russia': 'RU',
    'Egypt': 'EG', 'UK (Gibraltar)': 'GB', 'Djibouti': 'DJ',
    'Yemen': 'YE', 'Panama': 'PA', 'Spain': 'ES', 'Pakistan': 'PK',
    'Sri Lanka': 'LK', 'Japan': 'JP', 'UK': 'GB', 'France': 'FR',
    'Brazil': 'BR', 'India': 'IN', 'Singapore': 'SG', 'Germany': 'DE',
    'UAE': 'AE',
  };
  return mappings[country] || country;
}

// Port importance by type for impact calculation
function getPortImportance(port: PortInput): number {
  const typeWeight: Record<string, number> = {
    'oil': 0.9,     // Oil disruption = major
    'lng': 0.85,    // LNG disruption = major
    'container': 0.7,
    'mixed': 0.6,
    'bulk': 0.5,
    'naval': 0.4,   // Naval = geopolitical but less economic
  };
  const baseWeight = typeWeight[port.type] || 0.5;
  // Higher rank = more important (rank 1-10 get boost)
  const rankBoost = port.rank ? Math.max(0, (20 - port.rank) / 20) * 0.3 : 0;
  return Math.min(1, baseWeight + rankBoost);
}

function buildPortCountryEdges(graph: DependencyGraph, ports: PortInput[]): void {
  for (const port of ports) {
    const portId = `port:${port.id}`;
    const countryCode = normalizeCountryCode(port.country);
    const countryId = `country:${countryCode}`;

    // Create country node if it doesn't exist
    if (!graph.nodes.has(countryId)) {
      graph.nodes.set(countryId, {
        id: countryId,
        type: 'country',
        name: COUNTRY_NAMES[countryCode] || port.country,
        metadata: { code: countryCode },
      });
    }

    const importance = getPortImportance(port);

    // Port → Country edge
    addEdge(graph, {
      from: portId,
      to: countryId,
      type: 'serves',
      strength: importance,
      redundancy: port.rank && port.rank <= 5 ? 0.2 : 0.4, // Major ports harder to replace
      metadata: {
        portType: port.type,
        estimatedImpact: importance > 0.7 ? 'Critical port for country' : 'Regional port',
      },
    });

    // Add dependencies for countries this port serves beyond its own
    // Strategic ports affect multiple countries
    const affectedCountries = getAffectedCountries(port);
    for (const affected of affectedCountries) {
      const affectedCountryId = `country:${affected.code}`;
      if (!graph.nodes.has(affectedCountryId)) {
        graph.nodes.set(affectedCountryId, {
          id: affectedCountryId,
          type: 'country',
          name: COUNTRY_NAMES[affected.code] || affected.code,
          metadata: { code: affected.code },
        });
      }
      addEdge(graph, {
        from: portId,
        to: affectedCountryId,
        type: 'trade_route',
        strength: affected.strength,
        redundancy: 0.5,
        metadata: {
          relationship: affected.reason,
        },
      });
    }
  }
}

// Strategic ports affect countries beyond their location
function getAffectedCountries(port: PortInput): { code: string; strength: number; reason: string }[] {
  const affected: { code: string; strength: number; reason: string }[] = [];

  // Suez Canal ports affect Europe-Asia trade
  if (port.id === 'port_said' || port.id === 'suez_port') {
    affected.push(
      { code: 'DE', strength: 0.6, reason: 'Major EU importer via Suez' },
      { code: 'GB', strength: 0.5, reason: 'UK-Asia trade' },
      { code: 'NL', strength: 0.5, reason: 'Rotterdam connection' },
      { code: 'CN', strength: 0.4, reason: 'China-EU trade route' },
      { code: 'IT', strength: 0.4, reason: 'Mediterranean trade' },
    );
  }

  // Strait of Hormuz ports
  if (port.id === 'bandar_abbas' || port.id === 'fujairah' || port.id === 'ras_tanura') {
    affected.push(
      { code: 'JP', strength: 0.7, reason: 'Oil import dependency' },
      { code: 'KR', strength: 0.6, reason: 'Oil import dependency' },
      { code: 'IN', strength: 0.5, reason: 'Oil imports' },
      { code: 'CN', strength: 0.5, reason: 'Oil imports' },
    );
  }

  // Malacca Strait ports
  if (port.id === 'singapore' || port.id === 'klang' || port.id === 'tanjung_pelepas') {
    affected.push(
      { code: 'CN', strength: 0.6, reason: 'Trade route dependency' },
      { code: 'JP', strength: 0.5, reason: 'Trade route' },
      { code: 'KR', strength: 0.5, reason: 'Trade route' },
    );
  }

  // Panama Canal ports
  if (port.id === 'colon' || port.id === 'balboa') {
    affected.push(
      { code: 'US', strength: 0.5, reason: 'East-West coast shipping' },
      { code: 'CN', strength: 0.4, reason: 'Trade route to US East Coast' },
    );
  }

  // Red Sea/Aden ports (especially relevant with Houthi disruptions)
  if (port.id === 'aden' || port.id === 'djibouti' || port.id === 'hodeidah') {
    affected.push(
      { code: 'DE', strength: 0.5, reason: 'Europe-Asia shipping route' },
      { code: 'GB', strength: 0.5, reason: 'Shipping route' },
      { code: 'IT', strength: 0.4, reason: 'Mediterranean access' },
      { code: 'SA', strength: 0.4, reason: 'Regional trade' },
    );
  }

  return affected;
}

function buildChokepointEdges(
  graph: DependencyGraph,
  waterways: WaterwayInput[],
  ports: PortInput[],
): void {
  // Connect chokepoints to nearby ports and countries they affect
  for (const waterway of waterways) {
    const chokepointId = `chokepoint:${waterway.id}`;

    // Find ports near this chokepoint
    const nearbyPorts = ports.filter(port => {
      const dist = haversineKm(waterway.lat, waterway.lon, port.lat, port.lon);
      return dist < 500; // Within 500km
    });

    for (const port of nearbyPorts) {
      addEdge(graph, {
        from: chokepointId,
        to: `port:${port.id}`,
        type: 'controls_access',
        strength: 0.7,
        redundancy: 0.2,
        metadata: {
          relationship: 'Access controlled by chokepoint',
        },
      });
    }

    // Add dependent countries based on chokepoint
    const dependentCountries = getChokepointDependentCountries(waterway.id);
    for (const dep of dependentCountries) {
      const countryId = `country:${dep.code}`;
      if (!graph.nodes.has(countryId)) {
        graph.nodes.set(countryId, {
          id: countryId,
          type: 'country',
          name: COUNTRY_NAMES[dep.code] || dep.code,
          metadata: { code: dep.code },
        });
      }
      addEdge(graph, {
        from: chokepointId,
        to: countryId,
        type: 'trade_dependency',
        strength: dep.strength,
        redundancy: dep.redundancy,
        metadata: {
          relationship: dep.reason,
        },
      });
    }
  }
}

function getChokepointDependentCountries(chokepointId: string): { code: string; strength: number; redundancy: number; reason: string }[] {
  // Map using actual IDs from STRATEGIC_WATERWAYS
  const dependencies: Record<string, { code: string; strength: number; redundancy: number; reason: string }[]> = {
    'suez': [
      { code: 'DE', strength: 0.6, redundancy: 0.3, reason: 'EU-Asia trade' },
      { code: 'IT', strength: 0.5, redundancy: 0.3, reason: 'Mediterranean' },
      { code: 'GB', strength: 0.5, redundancy: 0.4, reason: 'UK-Asia trade' },
      { code: 'CN', strength: 0.4, redundancy: 0.5, reason: 'China-EU exports' },
    ],
    'hormuz_strait': [
      { code: 'JP', strength: 0.8, redundancy: 0.2, reason: '80% oil imports' },
      { code: 'KR', strength: 0.7, redundancy: 0.2, reason: '70% oil imports' },
      { code: 'IN', strength: 0.6, redundancy: 0.3, reason: '60% oil imports' },
      { code: 'CN', strength: 0.5, redundancy: 0.4, reason: '40% oil imports' },
    ],
    'malacca_strait': [
      { code: 'CN', strength: 0.7, redundancy: 0.3, reason: '80% oil imports transit' },
      { code: 'JP', strength: 0.6, redundancy: 0.3, reason: 'Trade route' },
      { code: 'KR', strength: 0.6, redundancy: 0.3, reason: 'Trade route' },
    ],
    'bab_el_mandeb': [
      { code: 'DE', strength: 0.5, redundancy: 0.4, reason: 'EU shipping' },
      { code: 'GB', strength: 0.5, redundancy: 0.4, reason: 'UK shipping' },
      { code: 'SA', strength: 0.4, redundancy: 0.5, reason: 'Red Sea access' },
    ],
    'panama': [
      { code: 'US', strength: 0.5, redundancy: 0.4, reason: 'Inter-coast shipping' },
      { code: 'CN', strength: 0.4, redundancy: 0.5, reason: 'US East trade' },
    ],
    'gibraltar': [
      { code: 'ES', strength: 0.4, redundancy: 0.5, reason: 'Med access' },
      { code: 'IT', strength: 0.3, redundancy: 0.5, reason: 'Atlantic trade' },
    ],
    'bosphorus': [
      { code: 'RU', strength: 0.6, redundancy: 0.3, reason: 'Black Sea access' },
      { code: 'UA', strength: 0.6, redundancy: 0.3, reason: 'Grain exports' },
      { code: 'RO', strength: 0.4, redundancy: 0.4, reason: 'Black Sea trade' },
    ],
    'dardanelles': [
      { code: 'RU', strength: 0.5, redundancy: 0.3, reason: 'Black Sea access' },
      { code: 'UA', strength: 0.5, redundancy: 0.3, reason: 'Grain exports' },
    ],
    'taiwan_strait': [
      { code: 'TW', strength: 0.9, redundancy: 0.1, reason: 'Taiwan trade lifeline' },
      { code: 'JP', strength: 0.5, redundancy: 0.4, reason: 'Trade route' },
      { code: 'KR', strength: 0.4, redundancy: 0.4, reason: 'Trade route' },
    ],
  };
  return dependencies[chokepointId] || [];
}

export function buildDependencyGraph(inputs: CascadeGraphInputs): DependencyGraph {
  const cables = inputs.cables;
  const pipelines = inputs.pipelines ?? PIPELINES;
  const ports = inputs.ports ?? PORTS;
  const waterways = inputs.waterways;

  const graph: DependencyGraph = {
    nodes: new Map(),
    edges: [],
    outgoing: new Map(),
    incoming: new Map(),
    cables,
  };

  // Add all infrastructure nodes
  addCablesAsNodes(graph, cables);
  addPipelinesAsNodes(graph, pipelines);
  addPortsAsNodes(graph, ports);
  addChokepointsAsNodes(graph, waterways);
  addCountriesAsNodes(graph, cables, pipelines);

  // Build dependency edges
  buildCableCountryEdges(graph, cables);
  buildPipelineCountryEdges(graph, pipelines);
  buildPortCountryEdges(graph, ports);        // Port → Country dependencies
  buildChokepointEdges(graph, waterways, ports); // Chokepoint → Port/Country dependencies

  return graph;
}

function categorizeImpact(strength: number): CascadeImpactLevel {
  if (strength > 0.8) return 'critical';
  if (strength > 0.5) return 'high';
  if (strength > 0.2) return 'medium';
  return 'low';
}

/**
 * Caveat attached to every cable-driven result. The cable table carries no
 * measured per-country capacity or redundancy: `capacityShare` is derived as
 * 1 / landing-country count (capped at 0.30) and `isRedundant` is true for
 * every row, so cable impacts are structural estimates, not measurements.
 */
export const CABLE_ESTIMATE_NOTE =
  'Estimated: cable capacity shares are approximated as 1 / landing-country count (capped at 30%) and every ' +
  'cable-country link is assumed to have redundancy. No measured capacity or redundancy data is used, so ' +
  'impact levels are indicative only.';

/**
 * Chokepoints whose enclosed basin is reachable only through the strait. A
 * cable with a landing point inside the basin must cross the chokepoint even
 * when its simplified route geometry never comes near the strait centre.
 */
export const CHOKEPOINT_ENCLOSED_BASINS: Record<string, { minLat: number; maxLat: number; minLon: number; maxLon: number }[]> = {
  // Persian Gulf west of the Musandam peninsula. Fujairah / Kalba (lon >= 56.3) sit outside on the Gulf of Oman.
  hormuz_strait: [{ minLat: 23.5, maxLat: 30.6, minLon: 47.5, maxLon: 56.2 }],
};

/** A cable route or landing point within this distance of a chokepoint centre counts as crossing it. */
export const CHOKEPOINT_CROSSING_RADIUS_KM = 60;

function cableCrossesChokepoint(cable: CableInput, chokepointKey: string, lat: number, lon: number): boolean {
  for (const [pLon, pLat] of cable.points ?? []) {
    if (haversineKm(pLat, pLon, lat, lon) <= CHOKEPOINT_CROSSING_RADIUS_KM) return true;
  }
  const basins = CHOKEPOINT_ENCLOSED_BASINS[chokepointKey] ?? [];
  const inBasin = (pLat: number, pLon: number) =>
    basins.some(b => pLat >= b.minLat && pLat <= b.maxLat && pLon >= b.minLon && pLon <= b.maxLon);
  let inside = false;
  let outside = false;
  for (const lp of cable.landingPoints ?? []) {
    if (typeof lp.lat !== 'number' || typeof lp.lon !== 'number') continue;
    if (haversineKm(lp.lat, lp.lon, lat, lon) <= CHOKEPOINT_CROSSING_RADIUS_KM) return true;
    if (inBasin(lp.lat, lp.lon)) inside = true;
    else outside = true;
  }
  // A cable lands inside the basin and also outside it, so it must pass through the strait.
  // A cable that stays entirely inside the basin (e.g. Kuwait-Iran) does not cross it.
  return basins.length > 0 && inside && outside;
}

const chokepointCrossingCache = new WeakMap<DependencyGraph, Map<string, Set<string>>>();

/** Chokepoint node ids each cable node crosses (route or landing within radius, or landings both inside and outside an enclosed basin). */
function getCableChokepoints(graph: DependencyGraph): Map<string, Set<string>> {
  const cached = chokepointCrossingCache.get(graph);
  if (cached) return cached;
  const chokepoints = [...graph.nodes.values()].filter(n => n.type === 'chokepoint' && n.coordinates);
  const result = new Map<string, Set<string>>();
  for (const cable of graph.cables) {
    const crossed = new Set<string>();
    for (const cp of chokepoints) {
      const [lon, lat] = cp.coordinates!;
      if (cableCrossesChokepoint(cable, cp.id.replace('chokepoint:', ''), lat, lon)) crossed.add(cp.id);
    }
    result.set(`cable:${cable.id}`, crossed);
  }
  chokepointCrossingCache.set(graph, result);
  return result;
}

/** Cable node ids (`cable:<id>`) whose route crosses the given chokepoint node (e.g. `chokepoint:hormuz_strait`). */
export function getCablesThroughChokepoint(graph: DependencyGraph, chokepointId: string): string[] {
  const id = chokepointId.startsWith('chokepoint:') ? chokepointId : `chokepoint:${chokepointId}`;
  const out: string[] = [];
  for (const [cableId, crossed] of getCableChokepoints(graph)) {
    if (crossed.has(id)) out.push(cableId);
  }
  return out.sort();
}

interface PropagatedNode {
  strength: number;
  pathLength: number;
  dependencyChain: string[];
  redundancyAvailable: boolean;
  estimatedRecovery?: string;
}

/**
 * Breadth-first propagation from one source. A node is only marked visited once
 * an edge actually reaches it above the cutoff, so a weak edge (e.g. a small
 * `serves` share) no longer blocks a stronger edge to the same node (e.g. the
 * same cable's `lands_at` edge).
 */
function propagate(graph: DependencyGraph, sourceId: string, disruptionLevel: number, countryImpactCutoff: number): Map<string, PropagatedNode> {
  const reached = new Map<string, PropagatedNode>();
  const visited = new Set<string>([sourceId]);
  const queue: { nodeId: string; depth: number; path: string[] }[] = [{ nodeId: sourceId, depth: 0, path: [sourceId] }];

  while (queue.length > 0) {
    const { nodeId, depth, path } = queue.shift()!;
    if (depth >= 3) continue;

    // Strongest edge per target first, so the reported chain/strength is the best one.
    const dependents = [...(graph.outgoing.get(nodeId) || [])].sort(
      (a, b) => b.strength * (1 - (b.redundancy || 0)) - a.strength * (1 - (a.redundancy || 0)),
    );

    for (const edge of dependents) {
      if (visited.has(edge.to)) continue;

      const impactStrength = edge.strength * disruptionLevel * (1 - (edge.redundancy || 0));
      const target = graph.nodes.get(edge.to);
      if (!target || impactStrength < (target.type === 'country' ? countryImpactCutoff : 0.05)) continue;
      visited.add(edge.to);

      reached.set(edge.to, {
        strength: impactStrength,
        pathLength: depth + 1,
        dependencyChain: [...path, edge.to],
        redundancyAvailable: (edge.redundancy || 0) > 0.3,
        estimatedRecovery: edge.metadata?.estimatedImpact,
      });

      queue.push({ nodeId: edge.to, depth: depth + 1, path: [...path, edge.to] });
    }
  }

  return reached;
}

function involvesCables(graph: DependencyGraph, sourceIds: string[]): boolean {
  return sourceIds.some(id => graph.nodes.get(id)?.type === 'cable');
}

function buildResult(
  graph: DependencyGraph,
  source: InfrastructureNode,
  sourceIds: string[],
  disruptionLevel: number,
): CascadeResult {
  const sourceSet = new Set(sourceIds);
  const merged = new Map<string, PropagatedNode>();
  const capacityByCountry = new Map<string, number>();

  for (const sid of sourceIds) {
    for (const [nodeId, hit] of propagate(graph, sid, disruptionLevel, sourceIds.length > 1 ? 0 : 0.05)) {
      if (sourceSet.has(nodeId)) continue;
      const node = graph.nodes.get(nodeId)!;
      const prev = merged.get(nodeId);
      if (node.type === 'country') {
        const code = (node.metadata?.code as string) || nodeId.replace('country:', '');
        const capacity = getCapacityForCountry(sid, code, graph, hit.dependencyChain);
        capacityByCountry.set(nodeId, Math.min(1, (capacityByCountry.get(nodeId) ?? 0) + capacity));
        // Independent cuts on the same country add up (capped at total loss).
        merged.set(nodeId, prev
          ? { ...prev, strength: Math.min(1, prev.strength + hit.strength), redundancyAvailable: prev.redundancyAvailable && hit.redundancyAvailable }
          : hit);
      } else if (!prev || hit.strength > prev.strength) {
        merged.set(nodeId, hit);
      }
    }
  }

  const affectedNodes: CascadeAffectedNode[] = [];
  const countriesAffected: CascadeCountryImpact[] = [];
  for (const [nodeId, hit] of merged) {
    if (hit.strength < 0.05) continue;
    const node = graph.nodes.get(nodeId)!;
    const impactLevel = categorizeImpact(hit.strength);
    affectedNodes.push({
      node,
      impactLevel,
      pathLength: hit.pathLength,
      dependencyChain: hit.dependencyChain,
      redundancyAvailable: hit.redundancyAvailable,
      estimatedRecovery: hit.estimatedRecovery,
    });
    if (node.type === 'country') {
      countriesAffected.push({
        country: (node.metadata?.code as string) || nodeId.replace('country:', ''),
        countryName: node.name,
        impactLevel,
        affectedCapacity: capacityByCountry.get(nodeId) ?? 0,
      });
    }
  }

  countriesAffected.sort((a, b) => {
    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    return (order[a.impactLevel] - order[b.impactLevel]) || (b.affectedCapacity - a.affectedCapacity);
  });

  const result: CascadeResult = {
    source,
    affectedNodes,
    countriesAffected,
    redundancies: findRedundancies(graph, sourceIds),
  };
  if (sourceIds.length > 1) result.sources = sourceIds.map(id => graph.nodes.get(id)!);
  if (involvesCables(graph, sourceIds)) result.dataQuality = { estimated: true, note: CABLE_ESTIMATE_NOTE };
  return result;
}

export function calculateCascade(
  graph: DependencyGraph,
  sourceId: string,
  disruptionLevel: number = 1.0,
): CascadeResult | null {
  const source = graph.nodes.get(sourceId);
  if (!source) return null;
  return buildResult(graph, source, [sourceId], disruptionLevel);
}

/**
 * Simultaneous cut of several nodes (e.g. every cable through Hormuz). Per-country
 * impacts and capacity losses add up across the cut set; other nodes keep their
 * strongest hit. Returns null when the cut is empty or any id is unknown.
 */
export function calculateMultiCascade(
  graph: DependencyGraph,
  sourceIds: string[],
  disruptionLevel: number = 1.0,
  label?: string,
): CascadeResult | null {
  const ids = [...new Set(sourceIds)];
  if (ids.length === 0 || ids.some(id => !graph.nodes.has(id))) return null;
  if (ids.length === 1 && !label) return calculateCascade(graph, ids[0]!, disruptionLevel);
  const source: InfrastructureNode = {
    id: `cut:${ids.join('+')}`,
    type: 'route',
    name: label ?? ids.map(id => graph.nodes.get(id)!.name).join(' + '),
    metadata: { sourceIds: ids },
  };
  return buildResult(graph, source, ids, disruptionLevel);
}

/** Cut every cable crossing a chokepoint. Returns null when the chokepoint is unknown or no cable crosses it. */
export function calculateChokepointCableCut(
  graph: DependencyGraph,
  chokepointId: string,
  disruptionLevel: number = 1.0,
): CascadeResult | null {
  const id = chokepointId.startsWith('chokepoint:') ? chokepointId : `chokepoint:${chokepointId}`;
  const chokepoint = graph.nodes.get(id);
  if (!chokepoint) return null;
  const cableIds = getCablesThroughChokepoint(graph, id);
  if (cableIds.length === 0) return null;
  return calculateMultiCascade(graph, cableIds, disruptionLevel, `All cables through ${chokepoint.name} (${cableIds.length})`);
}

function getCapacityForCountry(
  sourceId: string,
  countryCode: string,
  graph: DependencyGraph,
  dependencyChain: string[],
): number {
  if (sourceId.startsWith('cable:')) {
    const cableId = sourceId.replace('cable:', '');
    const cable = graph.cables.find(c => c.id === cableId);
    const countryData = cable?.countriesServed?.find(cs => cs.country === countryCode);
    return countryData?.capacityShare || 0;
  }

  // Check direct edges from source → country
  const countryId = `country:${countryCode}`;
  const outgoing = graph.outgoing.get(sourceId) || [];
  const direct = outgoing.filter(e => e.to === countryId);
  if (direct.length > 0) {
    const effective = direct.map(e => e.strength * (1 - (e.redundancy || 0)));
    return Math.max(...effective);
  }

  // Walk the BFS dependency chain for indirect impacts (e.g. chokepoint → port → country)
  if (dependencyChain.length > 2) {
    let pathCapacity = 1;
    for (let i = 0; i < dependencyChain.length - 1; i++) {
      const from = dependencyChain[i]!;
      const to = dependencyChain[i + 1]!;
      const stepEdges = graph.outgoing.get(from) || [];
      const edge = stepEdges.find(e => e.to === to);
      if (edge) {
        pathCapacity *= edge.strength * (1 - (edge.redundancy || 0));
      } else {
        pathCapacity = 0;
        break;
      }
    }
    if (pathCapacity > 0) return pathCapacity;
  }

  return 0;
}

/**
 * Alternative cables for the countries a cable cut affects. Ranked first by
 * whether the alternative avoids every chokepoint the cut cables cross (the
 * "cut zone"), then by how many affected countries it also serves, then by
 * average (estimated) capacity share. Cables in the cut set are never offered.
 */
function findRedundancies(graph: DependencyGraph, sourceIds: string[]): CascadeResult['redundancies'] {
  const cutCables = sourceIds.filter(id => id.startsWith('cable:'));
  if (cutCables.length === 0) return [];

  const cutSet = new Set(cutCables);
  const crossings = getCableChokepoints(graph);
  const cutZone = new Set<string>();
  const sourceCountries = new Set<string>();
  for (const id of cutCables) {
    crossings.get(id)?.forEach(cp => cutZone.add(cp));
    const cable = graph.cables.find(c => `cable:${c.id}` === id);
    cable?.countriesServed?.forEach(c => sourceCountries.add(c.country));
  }

  const candidates: (NonNullable<CascadeResult['redundancies']>[number] & { shared: number })[] = [];
  for (const cable of graph.cables) {
    const nodeId = `cable:${cable.id}`;
    if (cutSet.has(nodeId)) continue;
    const sharedCountries = cable.countriesServed?.filter(c => sourceCountries.has(c.country)) || [];
    if (sharedCountries.length === 0) continue;
    const crossed = crossings.get(nodeId) ?? new Set<string>();
    const avoidsCutZone = ![...crossed].some(cp => cutZone.has(cp));
    candidates.push({
      id: cable.id,
      name: cable.name,
      capacityShare: sharedCountries.reduce((sum, c) => sum + c.capacityShare, 0) / sharedCountries.length,
      avoidsCutZone,
      shared: sharedCountries.length,
    });
  }

  candidates.sort((a, b) =>
    Number(b.avoidsCutZone) - Number(a.avoidsCutZone) ||
    b.shared - a.shared ||
    b.capacityShare - a.capacityShare ||
    a.name.localeCompare(b.name));

  return candidates.slice(0, 5).map(({ shared: _shared, ...rest }) => rest);
}

export function getCableById(id: string, cables: CableInput[]): CableInput | undefined {
  return cables.find(c => c.id === id);
}

export function getPipelineById(id: string, pipelines: PipelineInput[] = PIPELINES): PipelineInput | undefined {
  return pipelines.find(p => p.id === id);
}

export function getPortById(id: string, ports: PortInput[] = PORTS): PortInput | undefined {
  return ports.find(p => p.id === id);
}

export interface CascadeGraphStats {
  nodes: number;
  edges: number;
  cables: number;
  pipelines: number;
  ports: number;
  chokepoints: number;
  countries: number;
}

export function getGraphStats(graph: DependencyGraph): CascadeGraphStats {
  let cables = 0, pipelines = 0, ports = 0, chokepoints = 0, countries = 0;

  for (const node of graph.nodes.values()) {
    if (node.type === 'cable') cables++;
    else if (node.type === 'pipeline') pipelines++;
    else if (node.type === 'port') ports++;
    else if (node.type === 'chokepoint') chokepoints++;
    else if (node.type === 'country') countries++;
  }

  return {
    nodes: graph.nodes.size,
    edges: graph.edges.length,
    cables,
    pipelines,
    ports,
    chokepoints,
    countries,
  };
}
