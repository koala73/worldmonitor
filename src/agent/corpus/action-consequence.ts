/**
 * Action-Consequence Corpus — causal graph of geopolitical/macro actions
 * and their downstream effects across domains.
 *
 * Each entry maps: TRIGGER → CONSEQUENCE chain with propagation delays,
 * confidence bounds, and affected domains. The agent uses this corpus
 * to reason about second-order effects when signals converge.
 *
 * Architecture: Integer-encoded constraint tuples. Each action and
 * consequence is an integer ID. Propagation is a DAG traversal.
 * Deterministic given inputs — the AI layer is the lossy preprocessor
 * that maps unstructured signals to corpus entry IDs.
 */

import type { SignalDomain, Severity } from '../types';

// ============================================================================
// TYPES
// ============================================================================

export interface CausalEntry {
  /** Unique integer ID for register-mapped lookup */
  id: number;
  /** Human-readable action label */
  action: string;
  /** Which domain this action originates in */
  domain: SignalDomain;
  /** Trigger conditions (signal tags that activate this entry) */
  triggerTags: string[];
  /** Minimum severity to activate */
  minSeverity: Severity;
  /** Downstream consequences */
  consequences: Consequence[];
}

export interface Consequence {
  /** What happens */
  effect: string;
  /** Which domain is affected */
  targetDomain: SignalDomain;
  /** Regions most affected (ISO codes, or 'GLOBAL') */
  targetRegions: string[];
  /** Propagation delay (hours) — how long until effect materializes */
  delayHours: number;
  /** Confidence that this consequence follows (0-1) */
  confidence: number;
  /** Severity amplification factor */
  severityMultiplier: number;
  /** Tags to inject into the pipeline when this consequence fires */
  emitTags: string[];
  /** Chained entry IDs — second-order effects */
  chainIds: number[];
}

// ============================================================================
// THE CORPUS — 60 action-consequence pairs across all domains
// ============================================================================

export const ACTION_CONSEQUENCE_CORPUS: CausalEntry[] = [

  // ── CONFLICT → ECONOMIC ─────────────────────────────────────────
  {
    id: 1,
    action: 'Strait of Hormuz shipping disruption',
    domain: 'conflict',
    triggerTags: ['conflict', 'maritime', 'IR', 'hormuz', 'shipping'],
    minSeverity: 'high',
    consequences: [
      { effect: 'Oil price spike 15-40%', targetDomain: 'economic', targetRegions: ['GLOBAL'], delayHours: 2, confidence: 0.92, severityMultiplier: 2.0, emitTags: ['oil-spike', 'energy-crisis'], chainIds: [2, 3] },
      { effect: 'Insurance premiums surge for tanker routes', targetDomain: 'economic', targetRegions: ['GLOBAL'], delayHours: 24, confidence: 0.88, severityMultiplier: 1.5, emitTags: ['insurance-spike'], chainIds: [] },
      { effect: 'LNG spot price surge in Asia', targetDomain: 'economic', targetRegions: ['JP', 'KR', 'CN'], delayHours: 6, confidence: 0.85, severityMultiplier: 1.8, emitTags: ['lng-spike', 'energy'], chainIds: [4] },
    ],
  },
  {
    id: 2,
    action: 'Global oil price exceeds $120/bbl',
    domain: 'economic',
    triggerTags: ['oil-spike', 'energy-crisis'],
    minSeverity: 'high',
    consequences: [
      { effect: 'Inflation expectations rise', targetDomain: 'economic', targetRegions: ['US', 'GB', 'DE'], delayHours: 48, confidence: 0.9, severityMultiplier: 1.3, emitTags: ['inflation-pressure'], chainIds: [5] },
      { effect: 'Airline and transport sector selloff', targetDomain: 'economic', targetRegions: ['US'], delayHours: 4, confidence: 0.85, severityMultiplier: 1.5, emitTags: ['sector-selloff', 'transport'], chainIds: [] },
      { effect: 'Emerging market currencies weaken', targetDomain: 'economic', targetRegions: ['TR', 'IN', 'PK'], delayHours: 12, confidence: 0.8, severityMultiplier: 1.4, emitTags: ['fx-pressure', 'em-stress'], chainIds: [6] },
    ],
  },
  {
    id: 3,
    action: 'Strategic petroleum reserve release announced',
    domain: 'economic',
    triggerTags: ['oil-spike', 'spr-release'],
    minSeverity: 'medium',
    consequences: [
      { effect: 'Oil price temporary suppression 5-10%', targetDomain: 'economic', targetRegions: ['US'], delayHours: 4, confidence: 0.75, severityMultiplier: 0.7, emitTags: ['oil-relief'], chainIds: [] },
    ],
  },
  {
    id: 4,
    action: 'Asia LNG shortage triggers fuel switching',
    domain: 'economic',
    triggerTags: ['lng-spike', 'energy'],
    minSeverity: 'high',
    consequences: [
      { effect: 'Coal demand surge', targetDomain: 'economic', targetRegions: ['CN', 'IN'], delayHours: 72, confidence: 0.7, severityMultiplier: 1.2, emitTags: ['coal-demand'], chainIds: [] },
      { effect: 'Power rationing in import-dependent economies', targetDomain: 'infrastructure', targetRegions: ['JP', 'KR'], delayHours: 168, confidence: 0.5, severityMultiplier: 1.8, emitTags: ['power-rationing'], chainIds: [] },
    ],
  },
  {
    id: 5,
    action: 'Central bank hawkish pivot on inflation',
    domain: 'economic',
    triggerTags: ['inflation-pressure', 'rate-hike'],
    minSeverity: 'medium',
    consequences: [
      { effect: 'Yield curve flattening', targetDomain: 'economic', targetRegions: ['US'], delayHours: 1, confidence: 0.88, severityMultiplier: 1.2, emitTags: ['yield-curve', 'recession-signal'], chainIds: [] },
      { effect: 'Growth stocks selloff', targetDomain: 'economic', targetRegions: ['US'], delayHours: 2, confidence: 0.82, severityMultiplier: 1.4, emitTags: ['tech-selloff'], chainIds: [] },
      { effect: 'Mortgage rates spike', targetDomain: 'economic', targetRegions: ['US', 'GB'], delayHours: 48, confidence: 0.75, severityMultiplier: 1.1, emitTags: ['housing-stress'], chainIds: [] },
    ],
  },
  {
    id: 6,
    action: 'Emerging market capital flight',
    domain: 'economic',
    triggerTags: ['em-stress', 'fx-pressure', 'capital-flight'],
    minSeverity: 'high',
    consequences: [
      { effect: 'Sovereign bond spread widening', targetDomain: 'economic', targetRegions: ['TR', 'PK', 'VE'], delayHours: 6, confidence: 0.85, severityMultiplier: 1.6, emitTags: ['sovereign-stress'], chainIds: [] },
      { effect: 'IMF intervention likelihood rises', targetDomain: 'intelligence', targetRegions: ['GLOBAL'], delayHours: 168, confidence: 0.5, severityMultiplier: 1.0, emitTags: ['imf-watch'], chainIds: [] },
    ],
  },

  // ── MILITARY → MULTI-DOMAIN ─────────────────────────────────────
  {
    id: 10,
    action: 'Carrier strike group deployment to Taiwan Strait',
    domain: 'military',
    triggerTags: ['military', 'TW', 'carrier', 'deployment'],
    minSeverity: 'high',
    consequences: [
      { effect: 'Semiconductor supply chain risk premium', targetDomain: 'economic', targetRegions: ['TW', 'US', 'JP'], delayHours: 4, confidence: 0.88, severityMultiplier: 1.8, emitTags: ['semiconductor-risk', 'supply-chain'], chainIds: [11] },
      { effect: 'Shipping rerouting from strait', targetDomain: 'infrastructure', targetRegions: ['TW', 'CN'], delayHours: 12, confidence: 0.7, severityMultiplier: 1.3, emitTags: ['shipping-disruption'], chainIds: [] },
      { effect: 'Defense sector rally', targetDomain: 'economic', targetRegions: ['US'], delayHours: 1, confidence: 0.85, severityMultiplier: 1.2, emitTags: ['defense-rally'], chainIds: [] },
    ],
  },
  {
    id: 11,
    action: 'Semiconductor supply chain disruption',
    domain: 'economic',
    triggerTags: ['semiconductor-risk', 'supply-chain'],
    minSeverity: 'medium',
    consequences: [
      { effect: 'Auto production slowdown', targetDomain: 'economic', targetRegions: ['US', 'DE', 'JP'], delayHours: 336, confidence: 0.75, severityMultiplier: 1.3, emitTags: ['auto-slowdown'], chainIds: [] },
      { effect: 'Consumer electronics price inflation', targetDomain: 'economic', targetRegions: ['GLOBAL'], delayHours: 720, confidence: 0.65, severityMultiplier: 1.1, emitTags: ['electronics-inflation'], chainIds: [] },
      { effect: 'TSMC/Samsung valuation pressure', targetDomain: 'economic', targetRegions: ['TW', 'KR'], delayHours: 2, confidence: 0.9, severityMultiplier: 1.5, emitTags: ['foundry-stress'], chainIds: [] },
    ],
  },

  // ── CYBER → INFRASTRUCTURE → ECONOMIC ───────────────────────────
  {
    id: 20,
    action: 'Critical infrastructure cyberattack (grid/pipeline)',
    domain: 'cyber',
    triggerTags: ['cyber', 'infrastructure', 'scada', 'pipeline', 'grid'],
    minSeverity: 'high',
    consequences: [
      { effect: 'Regional power/fuel supply disruption', targetDomain: 'infrastructure', targetRegions: ['US'], delayHours: 1, confidence: 0.85, severityMultiplier: 2.0, emitTags: ['infra-disruption', 'power-outage'], chainIds: [] },
      { effect: 'Cybersecurity sector surge', targetDomain: 'economic', targetRegions: ['US'], delayHours: 2, confidence: 0.8, severityMultiplier: 1.2, emitTags: ['cybersec-rally'], chainIds: [] },
      { effect: 'Regulatory tightening on critical infra', targetDomain: 'intelligence', targetRegions: ['US', 'GB'], delayHours: 720, confidence: 0.6, severityMultiplier: 1.0, emitTags: ['regulation-risk'], chainIds: [] },
    ],
  },

  // ── CLIMATE/WEATHER → SUPPLY CHAIN ──────────────────────────────
  {
    id: 30,
    action: 'Category 4+ hurricane hits Gulf Coast',
    domain: 'climate',
    triggerTags: ['climate', 'hurricane', 'gulf', 'severe-weather'],
    minSeverity: 'high',
    consequences: [
      { effect: 'Gulf refinery shutdowns', targetDomain: 'infrastructure', targetRegions: ['US'], delayHours: 6, confidence: 0.92, severityMultiplier: 2.0, emitTags: ['refinery-shutdown', 'oil-supply'], chainIds: [2] },
      { effect: 'Port closures (Houston, New Orleans)', targetDomain: 'infrastructure', targetRegions: ['US'], delayHours: 2, confidence: 0.95, severityMultiplier: 1.8, emitTags: ['port-closure'], chainIds: [31] },
      { effect: 'Agricultural commodity spike (grain, cotton)', targetDomain: 'economic', targetRegions: ['US'], delayHours: 24, confidence: 0.7, severityMultiplier: 1.4, emitTags: ['agri-spike'], chainIds: [] },
    ],
  },
  {
    id: 31,
    action: 'Major port closure >48 hours',
    domain: 'infrastructure',
    triggerTags: ['port-closure'],
    minSeverity: 'medium',
    consequences: [
      { effect: 'Container shipping backlog', targetDomain: 'infrastructure', targetRegions: ['GLOBAL'], delayHours: 72, confidence: 0.85, severityMultiplier: 1.3, emitTags: ['shipping-backlog'], chainIds: [] },
      { effect: 'Spot freight rate surge', targetDomain: 'economic', targetRegions: ['GLOBAL'], delayHours: 24, confidence: 0.8, severityMultiplier: 1.4, emitTags: ['freight-spike'], chainIds: [] },
    ],
  },
  {
    id: 32,
    action: 'Severe drought in major agricultural region',
    domain: 'climate',
    triggerTags: ['climate', 'drought', 'agriculture'],
    minSeverity: 'medium',
    consequences: [
      { effect: 'Crop yield reduction 15-40%', targetDomain: 'economic', targetRegions: ['US', 'BR', 'UA'], delayHours: 720, confidence: 0.8, severityMultiplier: 1.5, emitTags: ['crop-loss', 'food-inflation'], chainIds: [33] },
      { effect: 'Water rationing for industrial use', targetDomain: 'infrastructure', targetRegions: ['US'], delayHours: 336, confidence: 0.55, severityMultiplier: 1.3, emitTags: ['water-rationing'], chainIds: [] },
      { effect: 'River transport disruption (barges)', targetDomain: 'infrastructure', targetRegions: ['US', 'DE'], delayHours: 168, confidence: 0.65, severityMultiplier: 1.2, emitTags: ['river-transport'], chainIds: [] },
    ],
  },
  {
    id: 33,
    action: 'Global food price index exceeds crisis threshold',
    domain: 'economic',
    triggerTags: ['food-inflation', 'food-crisis'],
    minSeverity: 'high',
    consequences: [
      { effect: 'Social unrest in import-dependent countries', targetDomain: 'unrest', targetRegions: ['EG', 'LB', 'SD', 'YE'], delayHours: 336, confidence: 0.75, severityMultiplier: 1.8, emitTags: ['food-unrest'], chainIds: [] },
      { effect: 'Export bans by major producers', targetDomain: 'intelligence', targetRegions: ['IN', 'RU'], delayHours: 168, confidence: 0.6, severityMultiplier: 1.5, emitTags: ['export-ban'], chainIds: [] },
    ],
  },

  // ── UNREST → POLITICAL → ECONOMIC ──────────────────────────────
  {
    id: 40,
    action: 'Mass protests in oil-producing country',
    domain: 'unrest',
    triggerTags: ['unrest', 'protest', 'oil-producer'],
    minSeverity: 'high',
    consequences: [
      { effect: 'Oil production disruption risk', targetDomain: 'economic', targetRegions: ['GLOBAL'], delayHours: 24, confidence: 0.7, severityMultiplier: 1.5, emitTags: ['oil-supply-risk'], chainIds: [2] },
      { effect: 'Sovereign CDS spread widening', targetDomain: 'economic', targetRegions: ['IR', 'SA', 'VE', 'NG'], delayHours: 6, confidence: 0.75, severityMultiplier: 1.3, emitTags: ['sovereign-stress'], chainIds: [] },
    ],
  },
  {
    id: 41,
    action: 'Coup attempt or regime change',
    domain: 'unrest',
    triggerTags: ['unrest', 'coup', 'regime-change'],
    minSeverity: 'critical',
    consequences: [
      { effect: 'Capital controls imposed', targetDomain: 'economic', targetRegions: ['GLOBAL'], delayHours: 6, confidence: 0.7, severityMultiplier: 2.0, emitTags: ['capital-controls'], chainIds: [6] },
      { effect: 'Foreign asset seizure risk', targetDomain: 'economic', targetRegions: ['GLOBAL'], delayHours: 72, confidence: 0.5, severityMultiplier: 1.8, emitTags: ['expropriation-risk'], chainIds: [] },
      { effect: 'Regional military posture change', targetDomain: 'military', targetRegions: ['GLOBAL'], delayHours: 12, confidence: 0.65, severityMultiplier: 1.4, emitTags: ['military-alert'], chainIds: [] },
    ],
  },

  // ── INFRASTRUCTURE → ECONOMIC ──────────────────────────────────
  {
    id: 50,
    action: 'Undersea cable cut (major route)',
    domain: 'infrastructure',
    triggerTags: ['infrastructure', 'cable-cut', 'subsea'],
    minSeverity: 'high',
    consequences: [
      { effect: 'Internet latency spike for affected region', targetDomain: 'infrastructure', targetRegions: ['GLOBAL'], delayHours: 1, confidence: 0.95, severityMultiplier: 1.5, emitTags: ['latency-spike'], chainIds: [] },
      { effect: 'Financial market access disruption', targetDomain: 'economic', targetRegions: ['GLOBAL'], delayHours: 1, confidence: 0.7, severityMultiplier: 1.6, emitTags: ['market-access'], chainIds: [] },
      { effect: 'Traffic rerouting increases load on remaining cables', targetDomain: 'infrastructure', targetRegions: ['GLOBAL'], delayHours: 2, confidence: 0.9, severityMultiplier: 1.2, emitTags: ['cable-stress'], chainIds: [] },
    ],
  },
  {
    id: 51,
    action: 'Panama/Suez Canal transit disruption',
    domain: 'infrastructure',
    triggerTags: ['infrastructure', 'canal', 'chokepoint', 'shipping'],
    minSeverity: 'medium',
    consequences: [
      { effect: 'Shipping rerouting adds 10-15 days transit', targetDomain: 'infrastructure', targetRegions: ['GLOBAL'], delayHours: 12, confidence: 0.9, severityMultiplier: 1.4, emitTags: ['rerouting'], chainIds: [] },
      { effect: 'Container freight rate surge 30-80%', targetDomain: 'economic', targetRegions: ['GLOBAL'], delayHours: 48, confidence: 0.85, severityMultiplier: 1.6, emitTags: ['freight-spike'], chainIds: [] },
      { effect: 'Inventory drawdown at destination ports', targetDomain: 'economic', targetRegions: ['US', 'GB', 'DE'], delayHours: 336, confidence: 0.7, severityMultiplier: 1.2, emitTags: ['inventory-stress'], chainIds: [] },
    ],
  },

  // ── SEISMOLOGY → INFRASTRUCTURE → ECONOMIC ─────────────────────
  {
    id: 60,
    action: 'Major earthquake near industrial zone (M7+)',
    domain: 'seismology',
    triggerTags: ['earthquake', 'mag7', 'industrial'],
    minSeverity: 'critical',
    consequences: [
      { effect: 'Factory shutdowns and supply chain disruption', targetDomain: 'infrastructure', targetRegions: ['JP', 'TW', 'CN'], delayHours: 1, confidence: 0.9, severityMultiplier: 2.0, emitTags: ['factory-shutdown', 'supply-chain'], chainIds: [11] },
      { effect: 'Insurance claims surge', targetDomain: 'economic', targetRegions: ['GLOBAL'], delayHours: 72, confidence: 0.85, severityMultiplier: 1.3, emitTags: ['insurance-claims'], chainIds: [] },
      { effect: 'Reconstruction demand spike (steel, cement)', targetDomain: 'economic', targetRegions: ['GLOBAL'], delayHours: 720, confidence: 0.7, severityMultiplier: 1.1, emitTags: ['reconstruction-demand'], chainIds: [] },
    ],
  },

  // ── REGULATORY / DISCRETE JUMPS ────────────────────────────────
  {
    id: 70,
    action: 'Rare earth export quota reduction (China)',
    domain: 'intelligence',
    triggerTags: ['regulation', 'export-ban', 'rare-earth', 'CN'],
    minSeverity: 'medium',
    consequences: [
      { effect: 'Rare earth spot price surge', targetDomain: 'economic', targetRegions: ['GLOBAL'], delayHours: 4, confidence: 0.9, severityMultiplier: 1.8, emitTags: ['rare-earth-spike', 'commodity'], chainIds: [] },
      { effect: 'EV/battery production cost increase', targetDomain: 'economic', targetRegions: ['US', 'DE', 'JP'], delayHours: 168, confidence: 0.75, severityMultiplier: 1.3, emitTags: ['ev-cost-pressure'], chainIds: [] },
      { effect: 'Alternative sourcing acceleration (Australia, Canada)', targetDomain: 'economic', targetRegions: ['AU', 'CA'], delayHours: 2160, confidence: 0.6, severityMultiplier: 1.0, emitTags: ['supply-diversification'], chainIds: [] },
    ],
  },
  {
    id: 71,
    action: 'Sanctions package targeting major economy',
    domain: 'intelligence',
    triggerTags: ['sanctions', 'regulation'],
    minSeverity: 'high',
    consequences: [
      { effect: 'Trade flow rerouting', targetDomain: 'economic', targetRegions: ['GLOBAL'], delayHours: 168, confidence: 0.85, severityMultiplier: 1.4, emitTags: ['trade-rerouting'], chainIds: [] },
      { effect: 'Payment system fragmentation', targetDomain: 'infrastructure', targetRegions: ['GLOBAL'], delayHours: 336, confidence: 0.6, severityMultiplier: 1.3, emitTags: ['payment-fragmentation'], chainIds: [] },
      { effect: 'Commodity arbitrage opportunities', targetDomain: 'economic', targetRegions: ['GLOBAL'], delayHours: 48, confidence: 0.7, severityMultiplier: 1.1, emitTags: ['arbitrage'], chainIds: [] },
    ],
  },
];

// ============================================================================
// CORPUS INDEX — O(1) lookup by ID and tag
// ============================================================================

const byId = new Map<number, CausalEntry>();
const byTag = new Map<string, CausalEntry[]>();

for (const entry of ACTION_CONSEQUENCE_CORPUS) {
  byId.set(entry.id, entry);
  for (const tag of entry.triggerTags) {
    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag)!.push(entry);
  }
}

export function getEntryById(id: number): CausalEntry | undefined {
  return byId.get(id);
}

export function getEntriesByTag(tag: string): CausalEntry[] {
  return byTag.get(tag) ?? [];
}

export function getEntriesByTags(tags: string[]): CausalEntry[] {
  const seen = new Set<number>();
  const results: CausalEntry[] = [];
  for (const tag of tags) {
    for (const entry of getEntriesByTag(tag)) {
      if (!seen.has(entry.id)) {
        seen.add(entry.id);
        results.push(entry);
      }
    }
  }
  return results;
}

/**
 * Traverse the causal DAG from a set of trigger tags.
 * Returns all consequences (including chained second-order effects).
 */
export function traceConsequences(
  tags: string[],
  minSeverity: Severity = 'medium',
  maxDepth = 3,
): { entry: CausalEntry; consequence: Consequence; depth: number }[] {
  const severityRank: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
  const minRank = severityRank[minSeverity];
  const results: { entry: CausalEntry; consequence: Consequence; depth: number }[] = [];
  const visited = new Set<number>();

  function walk(currentTags: string[], depth: number): void {
    if (depth > maxDepth) return;
    const entries = getEntriesByTags(currentTags);

    for (const entry of entries) {
      if (visited.has(entry.id)) continue;
      if (severityRank[entry.minSeverity] < minRank) continue;
      visited.add(entry.id);

      for (const c of entry.consequences) {
        results.push({ entry, consequence: c, depth });
        // Follow chain
        if (c.chainIds.length > 0) {
          const chainedTags = c.emitTags;
          walk(chainedTags, depth + 1);
        }
      }
    }
  }

  walk(tags, 0);
  return results;
}

export const CORPUS_STATS = {
  totalEntries: ACTION_CONSEQUENCE_CORPUS.length,
  totalConsequences: ACTION_CONSEQUENCE_CORPUS.reduce((sum, e) => sum + e.consequences.length, 0),
  uniqueTags: byTag.size,
  maxChainDepth: 3,
};
