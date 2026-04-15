import type {
  IntelligenceServiceHandler,
  ServerContext,
  GetRegionalSnapshotRequest,
  GetRegionalSnapshotResponse,
  RegionalSnapshot,
  SnapshotMeta,
  RegimeState,
  BalanceVector,
  BalanceDriver,
  ActorState,
  LeverageEdge,
  ScenarioSet,
  ScenarioLane,
  TransmissionPath,
  TriggerLadder,
  Trigger,
  TriggerThreshold,
  MobilityState,
  AirspaceStatus,
  FlightCorridorStress,
  AirportNodeStatus,
  EvidenceItem,
  RegionalNarrative,
  NarrativeSection,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

const LATEST_KEY_PREFIX = 'intelligence:snapshot:v1:';
const BY_ID_KEY_PREFIX = 'intelligence:snapshot-by-id:v1:';

// The set of valid region ids is defined in shared/geography.js. We don't
// import the shared module here to avoid cross-directory ESM-in-TS friction;
// the server handler accepts any lowercase kebab id and lets Redis return
// null for unknown regions. Validation happens at the proto layer via the
// regex pattern on region_id.

// ---------------------------------------------------------------------------
// Phase 0 snake_case shape (as persisted by scripts/seed-regional-snapshots.mjs)
// ---------------------------------------------------------------------------
//
// The seed writer in scripts/regional-snapshot/ constructs snapshots with
// snake_case field names matching shared/regions.types.d.ts. The proto layer
// uses camelCase per standard buf codegen. This handler reads the snake_case
// payload from Redis and translates to the camelCase wire format on the way
// out. The adapter is the single source of truth for the field mapping.

/** Phase 0 persisted shape. Only the fields we consume are typed. */
interface PersistedSnapshot {
  region_id?: string;
  generated_at?: number;
  meta?: PersistedMeta;
  regime?: PersistedRegime;
  balance?: PersistedBalance;
  actors?: PersistedActor[];
  leverage_edges?: PersistedLeverageEdge[];
  scenario_sets?: PersistedScenarioSet[];
  transmission_paths?: PersistedTransmissionPath[];
  triggers?: PersistedTriggerLadder;
  mobility?: PersistedMobility;
  evidence?: PersistedEvidence[];
  narrative?: PersistedNarrative;
}

interface PersistedMeta {
  snapshot_id?: string;
  model_version?: string;
  scoring_version?: string;
  geography_version?: string;
  snapshot_confidence?: number;
  missing_inputs?: string[];
  stale_inputs?: string[];
  valid_until?: number;
  trigger_reason?: string;
  narrative_provider?: string;
  narrative_model?: string;
}

interface PersistedRegime {
  label?: string;
  previous_label?: string;
  transitioned_at?: number;
  transition_driver?: string;
}

interface PersistedBalance {
  coercive_pressure?: number;
  domestic_fragility?: number;
  capital_stress?: number;
  energy_vulnerability?: number;
  alliance_cohesion?: number;
  maritime_access?: number;
  energy_leverage?: number;
  net_balance?: number;
  pressures?: PersistedBalanceDriver[];
  buffers?: PersistedBalanceDriver[];
}

interface PersistedBalanceDriver {
  axis?: string;
  description?: string;
  magnitude?: number;
  evidence_ids?: string[];
  orientation?: string;
}

interface PersistedActor {
  actor_id?: string;
  name?: string;
  role?: string;
  leverage_domains?: string[];
  leverage_score?: number;
  delta?: number;
  evidence_ids?: string[];
}

interface PersistedLeverageEdge {
  from_actor_id?: string;
  to_actor_id?: string;
  mechanism?: string;
  strength?: number;
  evidence_ids?: string[];
}

interface PersistedScenarioSet {
  horizon?: string;
  lanes?: PersistedScenarioLane[];
}

interface PersistedScenarioLane {
  name?: string;
  probability?: number;
  trigger_ids?: string[];
  consequences?: string[];
  transmissions?: PersistedTransmissionPath[];
}

interface PersistedTransmissionPath {
  start?: string;
  mechanism?: string;
  end?: string;
  severity?: string;
  corridor_id?: string;
  confidence?: number;
  latency_hours?: number;
  impacted_asset_class?: string;
  impacted_regions?: string[];
  magnitude_low?: number;
  magnitude_high?: number;
  magnitude_unit?: string;
  template_id?: string;
  template_version?: string;
}

interface PersistedTriggerLadder {
  active?: PersistedTrigger[];
  watching?: PersistedTrigger[];
  dormant?: PersistedTrigger[];
}

interface PersistedTrigger {
  id?: string;
  description?: string;
  threshold?: PersistedTriggerThreshold;
  activated?: boolean;
  activated_at?: number;
  scenario_lane?: string;
  evidence_ids?: string[];
}

interface PersistedTriggerThreshold {
  metric?: string;
  operator?: string;
  value?: number;
  window_minutes?: number;
  baseline?: string;
}

interface PersistedMobility {
  airspace?: PersistedAirspace[];
  flight_corridors?: PersistedFlightCorridor[];
  airports?: PersistedAirport[];
  reroute_intensity?: number;
  notam_closures?: string[];
}

interface PersistedAirspace {
  airspace_id?: string;
  status?: string;
  reason?: string;
}

interface PersistedFlightCorridor {
  corridor?: string;
  stress_level?: number;
  rerouted_flights_24h?: number;
}

interface PersistedAirport {
  icao?: string;
  name?: string;
  status?: string;
  disruption_reason?: string;
}

interface PersistedEvidence {
  id?: string;
  type?: string;
  source?: string;
  summary?: string;
  confidence?: number;
  observed_at?: number;
  theater?: string;
  corridor?: string;
}

interface PersistedNarrative {
  situation?: PersistedNarrativeSection;
  balance_assessment?: PersistedNarrativeSection;
  outlook_24h?: PersistedNarrativeSection;
  outlook_7d?: PersistedNarrativeSection;
  outlook_30d?: PersistedNarrativeSection;
  watch_items?: PersistedNarrativeSection[];
}

interface PersistedNarrativeSection {
  text?: string;
  evidence_ids?: string[];
}

// ---------------------------------------------------------------------------
// Adapters: snake_case persisted shape -> camelCase proto shape
// ---------------------------------------------------------------------------

function adaptMeta(raw: PersistedMeta | undefined): SnapshotMeta {
  return {
    snapshotId: raw?.snapshot_id ?? '',
    modelVersion: raw?.model_version ?? '',
    scoringVersion: raw?.scoring_version ?? '',
    geographyVersion: raw?.geography_version ?? '',
    snapshotConfidence: raw?.snapshot_confidence ?? 0,
    missingInputs: raw?.missing_inputs ?? [],
    staleInputs: raw?.stale_inputs ?? [],
    validUntil: raw?.valid_until ?? 0,
    triggerReason: raw?.trigger_reason ?? '',
    narrativeProvider: raw?.narrative_provider ?? '',
    narrativeModel: raw?.narrative_model ?? '',
  };
}

function adaptRegime(raw: PersistedRegime | undefined): RegimeState {
  return {
    label: raw?.label ?? '',
    previousLabel: raw?.previous_label ?? '',
    transitionedAt: raw?.transitioned_at ?? 0,
    transitionDriver: raw?.transition_driver ?? '',
  };
}

function adaptBalanceDriver(raw: PersistedBalanceDriver): BalanceDriver {
  return {
    axis: raw.axis ?? '',
    description: raw.description ?? '',
    magnitude: raw.magnitude ?? 0,
    evidenceIds: raw.evidence_ids ?? [],
    orientation: raw.orientation ?? '',
  };
}

function adaptBalance(raw: PersistedBalance | undefined): BalanceVector {
  return {
    coercivePressure: raw?.coercive_pressure ?? 0,
    domesticFragility: raw?.domestic_fragility ?? 0,
    capitalStress: raw?.capital_stress ?? 0,
    energyVulnerability: raw?.energy_vulnerability ?? 0,
    allianceCohesion: raw?.alliance_cohesion ?? 0,
    maritimeAccess: raw?.maritime_access ?? 0,
    energyLeverage: raw?.energy_leverage ?? 0,
    netBalance: raw?.net_balance ?? 0,
    pressures: (raw?.pressures ?? []).map(adaptBalanceDriver),
    buffers: (raw?.buffers ?? []).map(adaptBalanceDriver),
  };
}

function adaptActor(raw: PersistedActor): ActorState {
  return {
    actorId: raw.actor_id ?? '',
    name: raw.name ?? '',
    role: raw.role ?? '',
    leverageDomains: raw.leverage_domains ?? [],
    leverageScore: raw.leverage_score ?? 0,
    delta: raw.delta ?? 0,
    evidenceIds: raw.evidence_ids ?? [],
  };
}

function adaptLeverageEdge(raw: PersistedLeverageEdge): LeverageEdge {
  return {
    fromActorId: raw.from_actor_id ?? '',
    toActorId: raw.to_actor_id ?? '',
    mechanism: raw.mechanism ?? '',
    strength: raw.strength ?? 0,
    evidenceIds: raw.evidence_ids ?? [],
  };
}

function adaptTransmissionPath(raw: PersistedTransmissionPath): TransmissionPath {
  return {
    start: raw.start ?? '',
    mechanism: raw.mechanism ?? '',
    end: raw.end ?? '',
    severity: raw.severity ?? '',
    corridorId: raw.corridor_id ?? '',
    confidence: raw.confidence ?? 0,
    latencyHours: raw.latency_hours ?? 0,
    impactedAssetClass: raw.impacted_asset_class ?? '',
    impactedRegions: raw.impacted_regions ?? [],
    magnitudeLow: raw.magnitude_low ?? 0,
    magnitudeHigh: raw.magnitude_high ?? 0,
    magnitudeUnit: raw.magnitude_unit ?? '',
    templateId: raw.template_id ?? '',
    templateVersion: raw.template_version ?? '',
  };
}

function adaptScenarioLane(raw: PersistedScenarioLane): ScenarioLane {
  return {
    name: raw.name ?? '',
    probability: raw.probability ?? 0,
    triggerIds: raw.trigger_ids ?? [],
    consequences: raw.consequences ?? [],
    transmissions: (raw.transmissions ?? []).map(adaptTransmissionPath),
  };
}

function adaptScenarioSet(raw: PersistedScenarioSet): ScenarioSet {
  return {
    horizon: raw.horizon ?? '',
    lanes: (raw.lanes ?? []).map(adaptScenarioLane),
  };
}

function adaptTriggerThreshold(raw: PersistedTriggerThreshold | undefined): TriggerThreshold {
  return {
    metric: raw?.metric ?? '',
    operator: raw?.operator ?? '',
    value: raw?.value ?? 0,
    windowMinutes: raw?.window_minutes ?? 0,
    baseline: raw?.baseline ?? '',
  };
}

function adaptTrigger(raw: PersistedTrigger): Trigger {
  return {
    id: raw.id ?? '',
    description: raw.description ?? '',
    threshold: adaptTriggerThreshold(raw.threshold),
    activated: raw.activated ?? false,
    activatedAt: raw.activated_at ?? 0,
    scenarioLane: raw.scenario_lane ?? '',
    evidenceIds: raw.evidence_ids ?? [],
  };
}

function adaptTriggerLadder(raw: PersistedTriggerLadder | undefined): TriggerLadder {
  return {
    active: (raw?.active ?? []).map(adaptTrigger),
    watching: (raw?.watching ?? []).map(adaptTrigger),
    dormant: (raw?.dormant ?? []).map(adaptTrigger),
  };
}

function adaptAirspace(raw: PersistedAirspace): AirspaceStatus {
  return {
    airspaceId: raw.airspace_id ?? '',
    status: raw.status ?? '',
    reason: raw.reason ?? '',
  };
}

function adaptFlightCorridor(raw: PersistedFlightCorridor): FlightCorridorStress {
  return {
    corridor: raw.corridor ?? '',
    stressLevel: raw.stress_level ?? 0,
    reroutedFlights24h: raw.rerouted_flights_24h ?? 0,
  };
}

function adaptAirport(raw: PersistedAirport): AirportNodeStatus {
  return {
    icao: raw.icao ?? '',
    name: raw.name ?? '',
    status: raw.status ?? '',
    disruptionReason: raw.disruption_reason ?? '',
  };
}

function adaptMobility(raw: PersistedMobility | undefined): MobilityState {
  return {
    airspace: (raw?.airspace ?? []).map(adaptAirspace),
    flightCorridors: (raw?.flight_corridors ?? []).map(adaptFlightCorridor),
    airports: (raw?.airports ?? []).map(adaptAirport),
    rerouteIntensity: raw?.reroute_intensity ?? 0,
    notamClosures: raw?.notam_closures ?? [],
  };
}

function adaptEvidence(raw: PersistedEvidence): EvidenceItem {
  return {
    id: raw.id ?? '',
    type: raw.type ?? '',
    source: raw.source ?? '',
    summary: raw.summary ?? '',
    confidence: raw.confidence ?? 0,
    observedAt: raw.observed_at ?? 0,
    theater: raw.theater ?? '',
    corridor: raw.corridor ?? '',
  };
}

function adaptNarrativeSection(raw: PersistedNarrativeSection | undefined): NarrativeSection {
  return {
    text: raw?.text ?? '',
    evidenceIds: raw?.evidence_ids ?? [],
  };
}

function adaptNarrative(raw: PersistedNarrative | undefined): RegionalNarrative {
  return {
    situation: adaptNarrativeSection(raw?.situation),
    balanceAssessment: adaptNarrativeSection(raw?.balance_assessment),
    outlook24h: adaptNarrativeSection(raw?.outlook_24h),
    outlook7d: adaptNarrativeSection(raw?.outlook_7d),
    outlook30d: adaptNarrativeSection(raw?.outlook_30d),
    watchItems: (raw?.watch_items ?? []).map((section) => adaptNarrativeSection(section)),
  };
}

/** Full snake_case -> camelCase adapter for RegionalSnapshot. */
export function adaptSnapshot(raw: PersistedSnapshot): RegionalSnapshot {
  return {
    regionId: raw.region_id ?? '',
    generatedAt: raw.generated_at ?? 0,
    meta: adaptMeta(raw.meta),
    regime: adaptRegime(raw.regime),
    balance: adaptBalance(raw.balance),
    actors: (raw.actors ?? []).map(adaptActor),
    leverageEdges: (raw.leverage_edges ?? []).map(adaptLeverageEdge),
    scenarioSets: (raw.scenario_sets ?? []).map(adaptScenarioSet),
    transmissionPaths: (raw.transmission_paths ?? []).map(adaptTransmissionPath),
    triggers: adaptTriggerLadder(raw.triggers),
    mobility: adaptMobility(raw.mobility),
    evidence: (raw.evidence ?? []).map(adaptEvidence),
    narrative: adaptNarrative(raw.narrative),
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Reads the latest persisted RegionalSnapshot for a region.
 *
 * Pipeline:
 *   1. Read `intelligence:snapshot:v1:{region}:latest` -> snapshot_id (string)
 *   2. Read `intelligence:snapshot-by-id:v1:{snapshot_id}` -> full snapshot (JSON)
 *   3. Adapt snake_case persisted shape to camelCase proto shape
 *   4. Return
 *
 * Returns an empty response (snapshot omitted) when:
 *   - No `:latest` pointer exists (seed has never run or region is unknown)
 *   - The `:latest` pointer references a snapshot that was pruned or TTL'd
 *   - The snapshot JSON is malformed
 *
 * This handler is premium-gated at the gateway layer (see
 * src/shared/premium-paths.ts and server/gateway.ts RPC_CACHE_TIER).
 */
export const getRegionalSnapshot: IntelligenceServiceHandler['getRegionalSnapshot'] = async (
  _ctx: ServerContext,
  req: GetRegionalSnapshotRequest,
): Promise<GetRegionalSnapshotResponse> => {
  const regionId = req.regionId;
  if (!regionId || typeof regionId !== 'string') {
    return {};
  }

  // Step 1: resolve latest pointer -> snapshot_id
  const latestKey = `${LATEST_KEY_PREFIX}${regionId}:latest`;
  const latestRaw = await getCachedJson(latestKey, true);
  // The seed writer stores the id as a bare string (JSON-encoded). getCachedJson
  // returns whatever the JSON parser produced, so we handle both shapes.
  let snapshotId: string | null = null;
  if (typeof latestRaw === 'string') {
    snapshotId = latestRaw;
  } else if (latestRaw && typeof latestRaw === 'object' && 'snapshot_id' in latestRaw) {
    const candidate = (latestRaw as { snapshot_id?: unknown }).snapshot_id;
    if (typeof candidate === 'string') snapshotId = candidate;
  }
  if (!snapshotId) {
    return {};
  }

  // Step 2: resolve snapshot_id -> full snapshot
  const snapKey = `${BY_ID_KEY_PREFIX}${snapshotId}`;
  const persisted = await getCachedJson(snapKey, true) as PersistedSnapshot | null;
  if (!persisted || typeof persisted !== 'object') {
    return {};
  }

  // Step 3: adapt snake_case -> camelCase
  const snapshot = adaptSnapshot(persisted);

  return { snapshot };
};
