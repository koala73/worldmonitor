/**
 * Pre-built scenario templates for the supply chain scenario engine.
 *
 * Each template defines a geopolitical or environmental disruption event
 * that can be run through the async scenario worker to compute impact
 * across countries and HS2 sectors.
 *
 * All chokepoint IDs must reference valid entries in chokepoint-registry.ts.
 */

export type ScenarioType =
  | 'conflict'
  | 'weather'
  | 'sanctions'
  | 'tariff_shock'
  | 'infrastructure'
  | 'pandemic';

export interface ScenarioTemplate {
  id: string;
  name: string;
  description: string;
  type: ScenarioType;
  /** IDs from chokepoint-registry.ts */
  affectedChokepointIds: string[];
  /** 0–100 percent of chokepoint capacity blocked */
  disruptionPct: number;
  /** Estimated duration of disruption in days */
  durationDays: number;
  /**
   * HS2 chapter codes affected (e.g. '27' = energy, '85' = electronics).
   * null means ALL sectors are affected.
   */
  affectedHs2: string[] | null;
  /**
   * Additional cost multiplier applied on top of bypass corridor costs.
   * 1.0 = no additional cost; 1.3 = +30% freight cost.
   */
  costShockMultiplier: number;
}

export const SCENARIO_TEMPLATES: readonly ScenarioTemplate[] = [
  {
    id: 'taiwan-strait-full-closure',
    name: 'Taiwan Strait Full Closure',
    description:
      'Complete closure of the Taiwan Strait for 30 days — critical impact on electronics, machinery, and vehicle supply chains routed through East Asia.',
    type: 'conflict',
    affectedChokepointIds: ['taiwan_strait'],
    disruptionPct: 100,
    durationDays: 30,
    affectedHs2: ['84', '85', '87'], // machinery, electronics, vehicles
    costShockMultiplier: 1.45,
  },
  {
    id: 'suez-bab-simultaneous',
    name: 'Suez + Bab el-Mandeb Simultaneous Disruption',
    description:
      'Simultaneous 80% blockage of the Suez Canal and Bab el-Mandeb Strait for 60 days — full Red Sea corridor closure affecting all sectors on Asia-Europe routes.',
    type: 'conflict',
    affectedChokepointIds: ['suez', 'bab_el_mandeb'],
    disruptionPct: 80,
    durationDays: 60,
    affectedHs2: null, // all sectors
    costShockMultiplier: 1.35,
  },
  {
    id: 'panama-drought-50pct',
    name: 'Panama Canal Drought — 50% Capacity',
    description:
      'Severe drought reduces Panama Canal capacity to 50% for 90 days — vessels diverted via Cape Horn or Suez, adding 12–18 transit days on transpacific routes.',
    type: 'weather',
    affectedChokepointIds: ['panama'],
    disruptionPct: 50,
    durationDays: 90,
    affectedHs2: null, // all sectors
    costShockMultiplier: 1.22,
  },
  {
    id: 'hormuz-tanker-blockade',
    name: 'Hormuz Strait Tanker Blockade',
    description:
      'Full closure of the Strait of Hormuz for 14 days — complete severance of Persian Gulf energy exports affecting oil, LNG, and petrochemical supply chains.',
    type: 'conflict',
    affectedChokepointIds: ['hormuz_strait'],
    disruptionPct: 100,
    durationDays: 14,
    affectedHs2: ['27', '29'], // energy + petrochemicals
    costShockMultiplier: 2.10,
  },
  {
    id: 'russia-baltic-grain-suspension',
    name: 'Russia Baltic Grain Export Suspension',
    description:
      'Full suspension of Russian grain exports via Baltic ports for 180 days due to expanded sanctions — impacts global wheat and corn supply chains.',
    type: 'sanctions',
    affectedChokepointIds: ['bosphorus', 'dover_strait'],
    disruptionPct: 100,
    durationDays: 180,
    affectedHs2: ['10', '12'], // cereals + oilseeds
    costShockMultiplier: 1.55,
  },
  {
    id: 'us-tariff-escalation-electronics',
    name: 'US Tariff Escalation — Electronics',
    description:
      'US imposes 50% tariff on electronics imports (HS 85) for 365 days — no chokepoint closure but severe cost shock on transpacific container routes carrying consumer electronics.',
    type: 'tariff_shock',
    affectedChokepointIds: [], // tariff shock, not physical closure
    disruptionPct: 0,
    durationDays: 365,
    affectedHs2: ['85'], // electronics
    costShockMultiplier: 1.50,
  },
] as const;

/** Lookup by scenario ID — returns undefined if not found */
export function getScenarioTemplate(id: string): ScenarioTemplate | undefined {
  return SCENARIO_TEMPLATES.find(t => t.id === id);
}

// ─── Runtime types shared between MapContainer and DeckGLMap ─────────────────
// Defined here (no UI imports) to avoid circular dependency.

/** Visual state broadcast to all map renderers when a scenario is active. */
export interface ScenarioVisualState {
  scenarioId: string;
  /** Chokepoint IDs that are fully/partially disrupted in this scenario. */
  disruptedChokepointIds: string[];
  /** ISO2 codes of countries with a non-trivial computed impact score. */
  affectedIso2s: string[];
}

/**
 * Subset of the scenario worker result consumed by the map layer.
 * Full result shape lives in the scenario worker (scenario-worker.mjs).
 */
export interface ScenarioResult {
  affectedChokepointIds: string[];
  topImpactCountries: Array<{ iso2: string; totalImpact: number; impactPct: number }>;
}
