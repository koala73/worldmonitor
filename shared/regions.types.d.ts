// Type definitions for the Regional Intelligence Model.
// Mirrors the future proto shape (proto/worldmonitor/intelligence/v1/service.proto)
// so the Phase 1 codegen lands as a drop-in replacement.
//
// See docs/internal/pro-regional-intelligence-upgrade.md for the full spec.

export type RegionId =
  | 'mena'
  | 'east-asia'
  | 'europe'
  | 'north-america'
  | 'south-asia'
  | 'latam'
  | 'sub-saharan-africa'
  | 'global';

export type RegimeLabel =
  | 'calm'
  | 'stressed_equilibrium'
  | 'coercive_stalemate'
  | 'fragmentation_risk'
  | 'managed_deescalation'
  | 'escalation_ladder';

export type ScenarioName = 'base' | 'escalation' | 'containment' | 'fragmentation';
export type ScenarioHorizon = '24h' | '7d' | '30d';

export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low';

export type ActorRole = 'aggressor' | 'stabilizer' | 'swing' | 'broker';
export type ActorLeverageDomain =
  | 'energy'
  | 'military'
  | 'diplomatic'
  | 'economic'
  | 'maritime';

export type LeverageMechanism =
  | 'sanctions'
  | 'naval_posture'
  | 'energy_supply'
  | 'alliance_shift'
  | 'trade_friction';

export type EvidenceType =
  | 'vessel_track'
  | 'flight_surge'
  | 'news_headline'
  | 'cii_spike'
  | 'chokepoint_status'
  | 'sanctions_move'
  | 'market_signal'
  | 'mobility_disruption';

export type DriverOrientation = 'pressure' | 'buffer';

export type TriggerOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'delta_gt' | 'delta_lt';
export type TriggerBaseline = 'trailing_7d' | 'trailing_30d' | 'fixed';

export type TriggerReason =
  | 'scheduled_6h'
  | 'regime_shift'
  | 'trigger_activation'
  | 'corridor_break'
  | 'leverage_shift';

export interface SnapshotMeta {
  snapshot_id: string;
  model_version: string;
  scoring_version: string;
  geography_version: string;
  snapshot_confidence: number;
  missing_inputs: string[];
  stale_inputs: string[];
  valid_until: number;
  trigger_reason: TriggerReason;
  narrative_provider: string;
  narrative_model: string;
}

export interface RegimeState {
  label: RegimeLabel;
  previous_label: RegimeLabel | '';
  transitioned_at: number;
  transition_driver: string;
}

export interface BalanceDriver {
  axis: keyof Omit<BalanceVector, 'pressures' | 'buffers' | 'net_balance'>;
  description: string;
  magnitude: number;
  evidence_ids: string[];
  orientation: DriverOrientation;
}

export interface BalanceVector {
  // Pressures (high = bad)
  coercive_pressure: number;
  domestic_fragility: number;
  capital_stress: number;
  energy_vulnerability: number;
  // Buffers (high = good)
  alliance_cohesion: number;
  maritime_access: number;
  energy_leverage: number;
  // Derived
  net_balance: number;
  // Decomposition
  pressures: BalanceDriver[];
  buffers: BalanceDriver[];
}

export interface ActorState {
  actor_id: string;
  name: string;
  role: ActorRole;
  leverage_domains: ActorLeverageDomain[];
  leverage_score: number;
  delta: number;
  evidence_ids: string[];
}

export interface LeverageEdge {
  from_actor_id: string;
  to_actor_id: string;
  mechanism: LeverageMechanism;
  strength: number;
  evidence_ids: string[];
}

export interface TransmissionPath {
  start: string;
  mechanism: string;
  end: string;
  severity: AlertSeverity;
  corridor_id: string;
  confidence: number;
  latency_hours: number;
  impacted_asset_class: string;
  impacted_regions: RegionId[];
  magnitude_low: number;
  magnitude_high: number;
  magnitude_unit: string;
  template_id: string;
  template_version: string;
}

export interface ScenarioLane {
  name: ScenarioName;
  probability: number;
  trigger_ids: string[];
  consequences: string[];
  transmissions: TransmissionPath[];
}

export interface ScenarioSet {
  horizon: ScenarioHorizon;
  lanes: ScenarioLane[];
}

export interface TriggerThreshold {
  metric: string;
  operator: TriggerOperator;
  value: number;
  window_minutes: number;
  baseline: TriggerBaseline;
}

export interface Trigger {
  id: string;
  description: string;
  threshold: TriggerThreshold;
  activated: boolean;
  activated_at: number;
  scenario_lane: ScenarioName;
  evidence_ids: string[];
}

export interface TriggerLadder {
  active: Trigger[];
  watching: Trigger[];
  dormant: Trigger[];
}

export interface AirspaceStatus {
  airspace_id: string;
  status: 'open' | 'restricted' | 'closed';
  reason: string;
}

export interface FlightCorridorStress {
  corridor: string;
  stress_level: number;
  rerouted_flights_24h: number;
}

export interface AirportNodeStatus {
  icao: string;
  name: string;
  status: 'normal' | 'disrupted' | 'closed';
  disruption_reason: string;
}

export interface MobilityState {
  airspace: AirspaceStatus[];
  flight_corridors: FlightCorridorStress[];
  airports: AirportNodeStatus[];
  reroute_intensity: number;
  notam_closures: string[];
}

export interface EvidenceItem {
  id: string;
  type: EvidenceType;
  source: string;
  summary: string;
  confidence: number;
  observed_at: number;
  theater: string;
  corridor: string;
}

export interface NarrativeSection {
  text: string;
  evidence_ids: string[];
}

export interface RegionalNarrative {
  situation: NarrativeSection;
  balance_assessment: NarrativeSection;
  outlook_24h: NarrativeSection;
  outlook_7d: NarrativeSection;
  outlook_30d: NarrativeSection;
  watch_items: NarrativeSection[];
}

export interface RegionalSnapshot {
  region_id: RegionId;
  generated_at: number;
  meta: SnapshotMeta;
  regime: RegimeState;
  balance: BalanceVector;
  actors: ActorState[];
  leverage_edges: LeverageEdge[];
  scenario_sets: ScenarioSet[];
  transmission_paths: TransmissionPath[];
  triggers: TriggerLadder;
  mobility: MobilityState;
  evidence: EvidenceItem[];
  narrative: RegionalNarrative;
}

// ────────────────────────────────────────────────────────────────────────────
// Diff output (used by alert layer)
// ────────────────────────────────────────────────────────────────────────────

export interface SnapshotDiff {
  regime_changed: { from: RegimeLabel | ''; to: RegimeLabel } | null;
  scenario_jumps: { horizon: ScenarioHorizon; lane: ScenarioName; from: number; to: number }[];
  trigger_activations: { id: string; description: string }[];
  trigger_deactivations: { id: string }[];
  corridor_breaks: { corridor_id: string; from: string; to: string }[];
  leverage_shifts: { actor_id: string; from: number; to: number; delta: number }[];
  buffer_failures: { axis: string; from: number; to: number }[];
  reroute_waves: { affected_corridors: string[] } | null;
  mobility_disruptions: { airspace?: string; reroute_intensity?: number }[];
}
