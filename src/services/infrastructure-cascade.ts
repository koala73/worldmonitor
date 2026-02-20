import type {
  InfrastructureNode,
  DependencyEdge,
  CascadeResult,
  CascadeAffectedNode,
  CascadeCountryImpact,
  CascadeImpactLevel,
  UnderseaCable,
  Pipeline,
} from '@/types';
import type { Port } from '@/config/ports';
import { UNDERSEA_CABLES, STRATEGIC_WATERWAYS } from '@/config/geo';
import { PIPELINES } from '@/config/pipelines';
import { PORTS } from '@/config/ports';

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

export interface DependencyGraph {
  nodes: Map<string, InfrastructureNode>;
  edges: DependencyEdge[];
  outgoing: Map<string, DependencyEdge[]>;
  incoming: Map<string, DependencyEdge[]>;
}

let cachedGraph: DependencyGraph | null = null;

export function clearGraphCache(): void {
  cachedGraph = null;
}

function addCablesAsNodes(graph: DependencyGraph): void {
  for (const cable of UNDERSEA_CABLES) {
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

function addPipelinesAsNodes(graph: DependencyGraph): void {
  for (const pipeline of PIPELINES) {
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

function addPortsAsNodes(graph: DependencyGraph): void {
  for (const port of PORTS) {
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

function addChokepointsAsNodes(graph: DependencyGraph): void {
  for (const waterway of STRATEGIC_WATERWAYS) {
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

function addCountriesAsNodes(graph: DependencyGraph): void {
  const countries = new Set<string>();

  for (const cable of UNDERSEA_CABLES) {
    cable.countriesServed?.forEach(c => countries.add(c.country));
    cable.landingPoints?.forEach(lp => countries.add(lp.country));
  }

  for (const pipeline of PIPELINES) {
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

function buildCableCountryEdges(graph: DependencyGraph): void {
  for (const cable of UNDERSEA_CABLES) {
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

function buildPipelineCountryEdges(graph: DependencyGraph): void {
  for (const pipeline of PIPELINES) {
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
function getPortImportance(port: Port): number {
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

function buildPortCountryEdges(graph: DependencyGraph): void {
  for (const port of PORTS) {
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
function getAffectedCountries(port: Port): { code: string; strength: number; reason: string }[] {
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

function buildChokepointEdges(graph: DependencyGraph): void {
  // Connect chokepoints to nearby ports and countries they affect
  for (const waterway of STRATEGIC_WATERWAYS) {
    const chokepointId = `chokepoint:${waterway.id}`;

    // Find ports near this chokepoint
    const nearbyPorts = PORTS.filter(port => {
      const dist = haversineDistance(waterway.lat, waterway.lon, port.lat, port.lon);
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

// Haversine distance for chokepoint proximity
function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function buildDependencyGraph(): DependencyGraph {
  if (cachedGraph) return cachedGraph;

  const graph: DependencyGraph = {
    nodes: new Map(),
    edges: [],
    outgoing: new Map(),
    incoming: new Map(),
  };

  // Add all infrastructure nodes
  addCablesAsNodes(graph);
  addPipelinesAsNodes(graph);
  addPortsAsNodes(graph);
  addChokepointsAsNodes(graph);
  addCountriesAsNodes(graph);

  // Build dependency edges
  buildCableCountryEdges(graph);
  buildPipelineCountryEdges(graph);
  buildPortCountryEdges(graph);      // NEW: Port → Country dependencies
  buildChokepointEdges(graph);       // NEW: Chokepoint → Port/Country dependencies

  cachedGraph = graph;
  return graph;
}

function categorizeImpact(strength: number): CascadeImpactLevel {
  if (strength > 0.8) return 'critical';
  if (strength > 0.5) return 'high';
  if (strength > 0.2) return 'medium';
  return 'low';
}

export function calculateCascade(
  sourceId: string,
  disruptionLevel: number = 1.0
): CascadeResult | null {
  const graph = buildDependencyGraph();
  const source = graph.nodes.get(sourceId);

  if (!source) return null;

  const affected: Map<string, CascadeAffectedNode> = new Map();
  const visited = new Set<string>();
  visited.add(sourceId);

  const queue: { nodeId: string; depth: number; path: string[] }[] = [
    { nodeId: sourceId, depth: 0, path: [sourceId] },
  ];

  while (queue.length > 0) {
    const { nodeId, depth, path } = queue.shift()!;
    if (depth >= 3) continue;

    const dependents = graph.outgoing.get(nodeId) || [];

    for (const edge of dependents) {
      if (visited.has(edge.to)) continue;
      visited.add(edge.to);

      const impactStrength = edge.strength * disruptionLevel * (1 - (edge.redundancy || 0));
      const targetNode = graph.nodes.get(edge.to);

      if (!targetNode || impactStrength < 0.05) continue;

      affected.set(edge.to, {
        node: targetNode,
        impactLevel: categorizeImpact(impactStrength),
        pathLength: depth + 1,
        dependencyChain: [...path, edge.to],
        redundancyAvailable: (edge.redundancy || 0) > 0.3,
        estimatedRecovery: edge.metadata?.estimatedImpact,
      });

      queue.push({
        nodeId: edge.to,
        depth: depth + 1,
        path: [...path, edge.to],
      });
    }
  }

  const countriesAffected: CascadeCountryImpact[] = [];
  for (const [nodeId, affectedNode] of affected) {
    if (affectedNode.node.type === 'country') {
      const code = (affectedNode.node.metadata?.code as string) || nodeId.replace('country:', '');
      countriesAffected.push({
        country: code,
        countryName: affectedNode.node.name,
        impactLevel: affectedNode.impactLevel,
        affectedCapacity: getCapacityForCountry(sourceId, code, graph, affectedNode.dependencyChain),
      });
    }
  }

  countriesAffected.sort((a, b) => {
    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    return (order[a.impactLevel] - order[b.impactLevel]) || (b.affectedCapacity - a.affectedCapacity);
  });

  const redundancies = findRedundancies(sourceId);

  return {
    source,
    affectedNodes: Array.from(affected.values()),
    countriesAffected,
    redundancies,
  };
}

function getCapacityForCountry(
  sourceId: string,
  countryCode: string,
  graph: DependencyGraph,
  dependencyChain: string[],
): number {
  if (sourceId.startsWith('cable:')) {
    const cableId = sourceId.replace('cable:', '');
    const cable = UNDERSEA_CABLES.find(c => c.id === cableId);
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

function findRedundancies(sourceId: string): CascadeResult['redundancies'] {
  if (!sourceId.startsWith('cable:')) return [];

  const cableId = sourceId.replace('cable:', '');
  const sourceCable = UNDERSEA_CABLES.find(c => c.id === cableId);
  if (!sourceCable) return [];

  const sourceCountries = new Set(sourceCable.countriesServed?.map(c => c.country) || []);
  const alternatives: CascadeResult['redundancies'] = [];

  for (const cable of UNDERSEA_CABLES) {
    if (cable.id === cableId) continue;

    const sharedCountries = cable.countriesServed?.filter(c => sourceCountries.has(c.country)) || [];
    if (sharedCountries.length > 0) {
      const avgCapacity = sharedCountries.reduce((sum, c) => sum + c.capacityShare, 0) / sharedCountries.length;
      alternatives.push({
        id: cable.id,
        name: cable.name,
        capacityShare: avgCapacity,
      });
    }
  }

  return alternatives.slice(0, 5);
}

export function getCableById(id: string): UnderseaCable | undefined {
  return UNDERSEA_CABLES.find(c => c.id === id);
}

export function getPipelineById(id: string): Pipeline | undefined {
  return PIPELINES.find(p => p.id === id);
}

export function getPortById(id: string): Port | undefined {
  return PORTS.find((p: Port) => p.id === id);
}

export function getGraphStats(): { nodes: number; edges: number; cables: number; pipelines: number; ports: number; chokepoints: number; countries: number } {
  const graph = buildDependencyGraph();
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
