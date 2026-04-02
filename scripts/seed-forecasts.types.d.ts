/**
 * TypeScript type definitions for seed-forecasts.mjs simulation pipeline.
 *
 * These types are used via JSDoc (@type/@param/@returns) annotations in seed-forecasts.mjs
 * with `// @ts-check` to enable compile-time shape validation.
 *
 * CRITICAL SHAPE NOTES (lessons from production bugs):
 *  - topBucketId / topChannel live under candidatePacket.marketContext — NOT at top level
 *  - commodityKey may contain underscores (e.g. 'crude_oil') and MUST be .replace(/_/g, ' ')
 *    before text-matching against LLM output
 *  - theaterResults MUST store candidateStateId so applySimulationMerge can key the lookup
 *    map by semantic ID, not by positional theaterId
 */

// ---------------------------------------------------------------------------
// Candidate packet (impact expansion input)
// ---------------------------------------------------------------------------

interface CandidateMarketContext {
  topBucketId: string;
  topBucketLabel?: string;
  topBucketPressure?: string;
  topChannel: string;
  topTransmissionStrength?: number;
  topTransmissionConfidence?: number;
  transmissionEdgeCount?: number;
  confirmationScore?: number;
  contradictionScore?: number;
  criticalSignalCount?: number;
  criticalSignalLift?: number;
  criticalSignalTypes?: string[];
  linkedBucketIds?: string[];
  linkedSignalIds?: string[];
  bucketContexts?: Record<string, unknown>;
  consequenceSummary?: string;
}

/** Shape of each entry in snapshot.impactExpansionCandidates */
interface CandidatePacket {
  candidateStateId: string;
  candidateIndex?: number;
  /** Internal commodity key — may contain underscores. Normalize with .replace(/_/g, ' ') before text matching. */
  commodityKey?: string;
  routeFacilityKey?: string;
  stateKind?: string;
  rankingScore?: number;
  /**
   * Market context block — topBucketId and topChannel live HERE, NOT at the top level of CandidatePacket.
   * BUG HISTORY: PRs #2404/#2410 fixed crashes caused by reading candidatePacket.topBucketId directly.
   */
  marketContext: CandidateMarketContext;
  stateSummary?: {
    actors: string[];
    [key: string]: unknown;
  };
}

// ---------------------------------------------------------------------------
// Expanded path (deep forecast evaluation output)
// ---------------------------------------------------------------------------

interface ExpandedPathDirect {
  variableKey?: string;
  hypothesisKey?: string;
  description?: string;
  geography?: string;
  affectedAssets?: string[];
  marketImpact?: string;
  causalLink?: string;
  channel?: string;
  targetBucket?: string;
  region?: string;
  macroRegion?: string;
  countries?: string[];
  assetsOrSectors?: string[];
  commodity?: string;
  dependsOnKey?: string;
  strength?: number;
  confidence?: number;
  analogTag?: string;
  summary?: string;
  evidenceRefs?: string[];
}

interface ExpandedPathCandidate {
  commodityKey?: string;
  routeFacilityKey?: string;
  stateKind?: string;
  topBucketId?: string;
}

/**
 * Compact simulation signal attached to an ExpandedPath when a non-zero adjustment was applied.
 * Written by applySimulationMerge; rendered as a chip in ForecastPanel.
 */
interface SimulationSignal {
  /** Simulation added a positive bonus to this path (bucket-channel match fired). False for negative-only adjustments (invalidator/stabilizer hit without a bucket-channel match). */
  backed: boolean;
  /** Raw adjustment delta (+0.08/+0.04 weighted by simPathConfidence; -0.12/-0.15 flat). */
  adjustmentDelta: number;
  /** Source of the matched channel: 'direct' (from path.direct.channel) | 'market' (from marketContext.topChannel) | 'none'. */
  channelSource: 'direct' | 'market' | 'none';
  /** Path was demoted below the 0.50 acceptance threshold by simulation. */
  demoted: boolean;
  /** Confidence of the matched simulation top-path (0–1). 1.0 when absent/non-finite (fallback). Explicit 0 preserved. Only meaningful when backed=true. */
  simPathConfidence: number;
}

/** A single expanded path produced by the deep forecast LLM evaluation. */
interface ExpandedPath {
  pathId: string;
  type: 'expanded' | 'fast' | string;
  candidateStateId: string;
  acceptanceScore: number;
  mergedAcceptanceScore?: number;
  simulationAdjustment?: number;
  demotedBySimulation?: boolean;
  promotedBySimulation?: boolean;
  /** Compact simulation signal. Present only when applySimulationMerge produced a non-zero adjustment. */
  simulationSignal?: SimulationSignal;
  /** Full SimulationAdjustmentDetail for audit. Present only when simulationAdjustment is set. */
  simulationAdjustmentDetail?: SimulationAdjustmentDetail;
  direct?: ExpandedPathDirect;
  candidate?: ExpandedPathCandidate;
}

// ---------------------------------------------------------------------------
// Simulation package (buildSimulationPackageFromDeepSnapshot output)
// ---------------------------------------------------------------------------

/**
 * One theater entry in SimulationPackage.selectedTheaters.
 * Distinct from TheaterResult (LLM output shape stored in SimulationOutcome).
 *
 * NOTE: When adding fields here, also add them to the uiTheaters projection
 * in writeSimulationOutcome() or they will be invisible in the Redis snapshot.
 */
interface SimulationPackageTheater {
  theaterId: string;
  candidateStateId: string;
  theaterLabel?: string;
  theaterRegion?: string;
  stateKind?: string;
  dominantRegion?: string;
  macroRegions?: string[];
  routeFacilityKey?: string;
  commodityKey?: string;
  topBucketId: string;
  topChannel: string;
  rankingScore?: number;
  criticalSignalTypes: string[];
  /**
   * Role-category strings from candidate stateSummary.actors. Theater-scoped (no cross-theater aggregation).
   * Injected into Round 2 prompt as CANDIDATE ACTOR ROLES. Used as allowlist in sanitizeKeyActorRoles guardrail.
   * keyActors (entity-space) and actorRoles (role-category) are intentionally disjoint vocabularies.
   */
  actorRoles: string[];
}

// ---------------------------------------------------------------------------
// Theater simulation structures
// ---------------------------------------------------------------------------

interface SimulationTopPath {
  pathId: string;
  label: string;
  summary: string;
  confidence: number;
  /** Entity-space actor names (geo-political). Used for narrative/audit. NOT used for overlap bonus scoring. */
  keyActors: string[];
  /** Role-category actor strings from the candidate's stateSummary.actors vocabulary. Used for the +0.04 overlap bonus when actorSource=stateSummary. */
  keyActorRoles?: string[];
  roundByRoundEvolution?: Array<{ round: number; summary: string }>;
  timingMarkers?: Array<{ event: string; timing: string }>;
}

/**
 * One theater's simulation result stored in SimulationOutcome.theaterResults.
 *
 * CRITICAL: candidateStateId MUST be stored here (fix from PR #2374).
 * applySimulationMerge keys its lookup Map by candidateStateId, not theaterId.
 */
interface TheaterResult {
  /** Positional ID assigned during simulation run: "theater-1", "theater-2", etc. */
  theaterId: string;
  /** Semantic ID linking back to CandidatePacket — REQUIRED for merge lookup. */
  candidateStateId: string;
  theaterLabel?: string;
  stateKind?: string;
  topPaths: SimulationTopPath[];
  stabilizers: string[];
  invalidators: string[];
  dominantReactions?: string[];
  timingMarkers?: Array<{ event: string; timing: string }>;
}

/** Full simulation outcome artifact written to R2 and referenced from Redis pointer. */
interface SimulationOutcome {
  runId: string;
  schemaVersion: string;
  runnerVersion?: string;
  sourceSimulationPackageKey?: string;
  theaterResults: TheaterResult[];
  failedTheaters?: Array<{ theaterId: string; reason: string }>;
  globalObservations?: string;
  confidenceNotes?: string;
  generatedAt?: number;
  /** Injected by fetchSimulationOutcomeForMerge to indicate same-run vs fresh-but-different. */
  isCurrentRun?: boolean;
}

// ---------------------------------------------------------------------------
// Simulation merge output
// ---------------------------------------------------------------------------

interface SimulationAdjustmentDetail {
  bucketChannelMatch: boolean;
  /** Backwards-compat alias: equals roleOverlapCount when actorSource=stateSummary, else keyActorsOverlapCount. >=2 triggered the +0.04 bonus. */
  actorOverlapCount: number;
  /** Role-category overlap count (candidate stateSummary.actors vs sim keyActorRoles). Drives +0.04 bonus when actorSource=stateSummary. */
  roleOverlapCount: number;
  /** Entity-space overlap count (candidate actors vs sim keyActors). Drives +0.04 bonus when actorSource=affectedAssets. Telemetry only when actorSource=stateSummary. */
  keyActorsOverlapCount: number;
  invalidatorHit: boolean;
  stabilizerHit: boolean;
  /** Number of candidate-theater actors used for overlap matching. Source is stateSummary.actors if raw list present, else affectedAssets. Never a union. */
  candidateActorCount: number;
  /** Source of candidate actors used for overlap matching (candidate-theater scoped, no union). */
  actorSource: 'stateSummary' | 'affectedAssets' | 'none';
  /** Resolved channel used for bucket-channel matching. */
  resolvedChannel: string;
  /** Source of resolved channel. */
  channelSource: 'direct' | 'market' | 'none';
  /** Confidence of the matched simulation top-path (0–1). 1.0 when absent or non-finite (legacy LLM output fallback). Explicit 0 is preserved as 0 — simulation rated the path unsupported. */
  simPathConfidence: number;
}

interface SimulationAdjustmentRecord {
  pathId: string;
  candidateStateId: string;
  originalAcceptanceScore: number;
  simulationAdjustment: number;
  mergedAcceptanceScore: number;
  details: SimulationAdjustmentDetail;
  wasAccepted: boolean;
  nowAccepted: boolean;
}

/** Flat projection of SimulationAdjustmentDetail written into path-scorecards.json entries. simPathConfidence is omitted (already in simulationSignal). */
interface ScorecardSimDetail {
  bucketChannelMatch:     boolean;
  /** Backwards-compat alias for roleOverlapCount or keyActorsOverlapCount (whichever drove the bonus). */
  actorOverlapCount:      number;
  /** Role-category overlap (stateSummary path). Drives +0.04 when actorSource=stateSummary. */
  roleOverlapCount:       number;
  /** Entity-space overlap via keyActors (affectedAssets path). Drives +0.04 when actorSource=affectedAssets. */
  keyActorsOverlapCount:  number;
  candidateActorCount:    number;
  actorSource:            'stateSummary' | 'affectedAssets' | 'none';
  resolvedChannel:        string;
  channelSource:          'direct' | 'market' | 'none';
  invalidatorHit:         boolean;
  stabilizerHit:          boolean;
}

interface SimulationEvidence {
  outcomeRunId: string;
  isCurrentRun: boolean;
  theaterCount: number;
  adjustments: SimulationAdjustmentRecord[];
  pathsPromoted: number;
  pathsDemoted: number;
  pathsUnchanged: number;
}

// ---------------------------------------------------------------------------
// Redis pointer for latest simulation outcome
// ---------------------------------------------------------------------------

interface SimulationOutcomePointer {
  runId: string;
  outcomeKey: string;
  schemaVersion: string;
  theaterCount: number;
  generatedAt: number;
  uiTheaters?: unknown[];
}
