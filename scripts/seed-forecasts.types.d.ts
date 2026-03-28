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
  direct?: ExpandedPathDirect;
  candidate?: ExpandedPathCandidate;
}

// ---------------------------------------------------------------------------
// Theater simulation structures
// ---------------------------------------------------------------------------

interface SimulationTopPath {
  pathId: string;
  label: string;
  summary: string;
  confidence: number;
  keyActors: string[];
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
  /** Number of overlapping actors between path and simulation top paths (>=2 triggers +0.04 bonus). */
  actorOverlapCount: number;
  invalidatorHit: boolean;
  stabilizerHit: boolean;
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
