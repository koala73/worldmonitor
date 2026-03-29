/**
 * Compound Threat Detector — Multi-hazard convergence alert
 *
 * Individual alerts are shown in their own panels. This service detects when
 * MULTIPLE hazards converge on the same area simultaneously — which is far
 * more dangerous than any single event and often gets missed in a busy dashboard.
 *
 * Examples of dangerous compound scenarios:
 *  - Hurricane + power grid failure = no AC during extreme heat for hospital patients
 *  - Earthquake + dam watch = potential dam failure downstream of quake zone
 *  - Wildfire + air quality extreme + evacuation route congestion = mass casualty risk
 *  - Flood + hazmat facility = chemical contamination of floodwater
 *  - Extreme heat + drought + power grid stress = rolling blackouts + agricultural crisis
 *
 * Algorithm:
 *  1. Grid Earth into h3-like cells at ~250km resolution
 *  2. Assign each active alert to cells it affects
 *  3. Count simultaneous hazard categories per cell
 *  4. Flag cells with 3+ simultaneous hazard categories
 */

import { haversineKm } from './proximity-filter';

export type HazardCategory =
  | 'weather'
  | 'seismic'
  | 'wildfire'
  | 'flood'
  | 'industrial'
  | 'nuclear'
  | 'grid'
  | 'cyber'
  | 'disease'
  | 'conflict'
  | 'food'
  | 'maritime';

export interface HazardSignal {
  id: string;
  category: HazardCategory;
  severity: 'critical' | 'high' | 'medium' | 'low';
  lat: number;
  lon: number;
  label: string;
  sourceService: string;
}

export interface CompoundThreat {
  id: string;
  lat: number;
  lon: number;
  radiusKm: number;
  hazards: HazardSignal[];
  hazardCount: number;
  hazardCategories: HazardCategory[];
  overallSeverity: 'critical' | 'high' | 'medium';
  description: string;
  detectedAt: Date;
}

// Known dangerous compound pairings (risk multiplier descriptions)
const COMPOUND_RISK_PATTERNS: {
  categories: HazardCategory[];
  description: string;
  severityBoost: boolean;
}[] = [
  {
    categories: ['weather', 'grid'],
    description: 'Severe weather coinciding with power grid stress — blackout risk during extreme conditions',
    severityBoost: true,
  },
  {
    categories: ['seismic', 'flood'],
    description: 'Earthquake near dam or coastal area — dam failure or tsunami risk',
    severityBoost: true,
  },
  {
    categories: ['seismic', 'nuclear'],
    description: 'Earthquake near nuclear facility — coolant system failure risk',
    severityBoost: true,
  },
  {
    categories: ['wildfire', 'industrial'],
    description: 'Wildfire approaching industrial or chemical facility — toxic smoke risk',
    severityBoost: true,
  },
  {
    categories: ['flood', 'industrial'],
    description: 'Flooding at industrial or hazmat site — chemical contamination of floodwater',
    severityBoost: true,
  },
  {
    categories: ['weather', 'disease'],
    description: 'Severe weather during active disease outbreak — healthcare system compounding',
    severityBoost: false,
  },
  {
    categories: ['grid', 'cyber'],
    description: 'Power grid stress coinciding with cyber incident — coordinated attack possible',
    severityBoost: true,
  },
  {
    categories: ['conflict', 'food'],
    description: 'Active conflict in food-insecure region — acute famine acceleration risk',
    severityBoost: false,
  },
  {
    categories: ['flood', 'disease'],
    description: 'Flooding in area with active disease outbreak — waterborne disease acceleration',
    severityBoost: true,
  },
];

function findMatchingPattern(categories: HazardCategory[]): string {
  const catSet = new Set(categories);
  for (const pattern of COMPOUND_RISK_PATTERNS) {
    if (pattern.categories.every(c => catSet.has(c))) return pattern.description;
  }
  return `${categories.length} simultaneous hazard types in this area`;
}

function computeCompoundSeverity(
  signals: HazardSignal[],
  hazardCount: number
): CompoundThreat['overallSeverity'] {
  const hasCritical = signals.some(s => s.severity === 'critical');
  const hasHigh = signals.some(s => s.severity === 'high');
  if (hasCritical && hazardCount >= 2) return 'critical';
  if (hasCritical || (hasHigh && hazardCount >= 3)) return 'critical';
  if (hasHigh || hazardCount >= 4) return 'high';
  return 'medium';
}

const CLUSTER_RADIUS_KM = 350; // signals within this radius are considered co-located

function clusterSignals(signals: HazardSignal[]): Map<string, HazardSignal[]> {
  const clusters = new Map<string, HazardSignal[]>();
  const assigned = new Set<string>();

  for (let i = 0; i < signals.length; i++) {
    const s = signals[i]!;
    if (assigned.has(s.id)) continue;
    const cluster: HazardSignal[] = [s];
    assigned.add(s.id);

    for (let j = i + 1; j < signals.length; j++) {
      const t = signals[j]!;
      if (assigned.has(t.id)) continue;
      if (haversineKm(s.lat, s.lon, t.lat, t.lon) <= CLUSTER_RADIUS_KM) {
        cluster.push(t);
        assigned.add(t.id);
      }
    }

    clusters.set(s.id, cluster);
  }

  return clusters;
}

export function detectCompoundThreats(signals: HazardSignal[]): CompoundThreat[] {
  if (signals.length < 2) return [];

  const clusters = clusterSignals(signals);
  const threats: CompoundThreat[] = [];

  for (const [centerId, cluster] of clusters) {
    // Only flag clusters with 2+ hazard CATEGORIES
    const categories = [...new Set(cluster.map(s => s.category))];
    if (categories.length < 2) continue;

    // Compute centroid
    const lat = cluster.reduce((sum, s) => sum + s.lat, 0) / cluster.length;
    const lon = cluster.reduce((sum, s) => sum + s.lon, 0) / cluster.length;

    const severity = computeCompoundSeverity(cluster, categories.length);

    threats.push({
      id: `compound-${centerId}-${Date.now()}`,
      lat,
      lon,
      radiusKm: CLUSTER_RADIUS_KM,
      hazards: cluster,
      hazardCount: categories.length,
      hazardCategories: categories,
      overallSeverity: severity,
      description: findMatchingPattern(categories),
      detectedAt: new Date(),
    });
  }

  // Sort: most categories first, then severity
  threats.sort((a, b) => {
    const sOrder = { critical: 0, high: 1, medium: 2 };
    return sOrder[a.overallSeverity] - sOrder[b.overallSeverity] || b.hazardCount - a.hazardCount;
  });

  return threats.slice(0, 20); // cap at 20 compound threats
}

export function compoundSeverityClass(severity: CompoundThreat['overallSeverity']): string {
  return { critical: 'eq-row eq-major', high: 'eq-row eq-strong', medium: 'eq-row eq-moderate' }[severity] ?? 'eq-row';
}

/** Convert common alert types to HazardSignal for compound threat detection */
export function toHazardSignal(
  id: string,
  category: HazardCategory,
  severity: HazardSignal['severity'],
  lat: number,
  lon: number,
  label: string,
  sourceService: string
): HazardSignal {
  return { id, category, severity, lat, lon, label, sourceService };
}
