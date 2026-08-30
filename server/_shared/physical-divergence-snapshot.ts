import {
  isPhysicalDivergenceDate,
  isPhysicalDivergenceInstant,
  physicalDivergenceStaleReason,
} from '../../shared/physical-divergence-staleness.js';
import {
  PHYSICAL_DIVERGENCE_CONTRACT,
  buildPhysicalStressComposite,
  isPhysicalDivergenceStoredCompositeReason,
  isPhysicalDivergenceStoredReadingReason,
  physicalDivergenceStateForFreshnessReason,
  type PhysicalDivergenceMetal as ContractPhysicalDivergenceMetal,
  type PhysicalDivergenceRegime,
  type PhysicalDivergenceState,
  type PhysicalDivergenceTrend,
} from '../../shared/physical-divergence-contract.js';

export const PHYSICAL_DIVERGENCE_METHODOLOGY_VERSION = PHYSICAL_DIVERGENCE_CONTRACT.methodologyVersion;
export const PHYSICAL_DIVERGENCE_METALS = PHYSICAL_DIVERGENCE_CONTRACT.metalOrder;

export type PhysicalDivergenceMetal = ContractPhysicalDivergenceMetal;
export type PhysicalDivergenceRawState = PhysicalDivergenceState;
export type PhysicalDivergenceRawRegime = PhysicalDivergenceRegime;
export type PhysicalDivergenceRawTrend = PhysicalDivergenceTrend;

export interface PhysicalDivergenceRawProvenance {
  physicalSource: string;
  physicalSymbol: string;
  physicalAsOf: string;
  paperSource: string;
  paperSymbol: string;
  paperAsOf: string;
  fxSource: string;
  fxPair: string;
  fxAsOf: string;
  historyKey: string;
  historyWindowPoints: number;
  methodologyVersion: string;
}

export interface PhysicalDivergenceRawReading {
  metal: PhysicalDivergenceMetal;
  state: PhysicalDivergenceRawState;
  reason: string;
  regime: PhysicalDivergenceRawRegime | null;
  index: number | null;
  premiumPct: number | null;
  premiumUsdPerOz: number | null;
  percentile: number | null;
  robustZ: number | null;
  delta5d: number | null;
  delta20d: number | null;
  trend5d: PhysicalDivergenceRawTrend | null;
  trend20d: PhysicalDivergenceRawTrend | null;
  historyPoints: number;
  historyWindowStart: string;
  historyWindowEnd: string;
  physicalAsOf: string;
  paperAsOf: string;
  methodologyVersion: string;
  provenance: PhysicalDivergenceRawProvenance;
}

export interface PhysicalDivergenceRawComposite {
  state: PhysicalDivergenceRawState;
  reason: string;
  index: number | null;
  weights: Array<{ metal: PhysicalDivergenceMetal; weight: number; methodologyVersion: string }>;
  methodologyVersion: string;
}

export interface PhysicalDivergenceRawSnapshot {
  readings: PhysicalDivergenceRawReading[];
  composite: PhysicalDivergenceRawComposite;
  evaluatedAt: string;
  methodologyVersion: string;
  transitions: PhysicalDivergenceRawTransition[];
}

export interface PhysicalDivergenceRawTransition {
  id: string;
  metal: PhysicalDivergenceMetal;
  fromRegime: PhysicalDivergenceRawRegime;
  toRegime: PhysicalDivergenceRawRegime;
  detectedAt: number;
  methodologyVersion: string;
}

const RAW_STATES = new Set<PhysicalDivergenceRawState>(PHYSICAL_DIVERGENCE_CONTRACT.states);
const RAW_REGIMES = new Set<PhysicalDivergenceRawRegime>(PHYSICAL_DIVERGENCE_CONTRACT.regimes);
const RAW_TRENDS = new Set<PhysicalDivergenceRawTrend>(PHYSICAL_DIVERGENCE_CONTRACT.trends);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Physical divergence snapshot contains a non-object value');
  }
  return value as Record<string, unknown>;
}

function string(value: unknown): value is string {
  return typeof value === 'string';
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isoInstant(value: unknown): value is string {
  return isPhysicalDivergenceInstant(value);
}

function isoDate(value: unknown): value is string {
  return isPhysicalDivergenceDate(value);
}

function methodology(value: unknown): string {
  if (value !== PHYSICAL_DIVERGENCE_METHODOLOGY_VERSION) {
    throw new TypeError(`Unsupported physical divergence methodology: ${String(value)}`);
  }
  return PHYSICAL_DIVERGENCE_METHODOLOGY_VERSION;
}

function nullableFinite(value: unknown): number | null {
  if (value == null) return null;
  if (!finite(value)) throw new TypeError('Physical divergence snapshot contains a non-finite number');
  return value;
}

function state(value: unknown): PhysicalDivergenceRawState {
  if (!string(value) || !RAW_STATES.has(value as PhysicalDivergenceRawState)) {
    throw new TypeError(`Unknown physical divergence state: ${String(value)}`);
  }
  return value as PhysicalDivergenceRawState;
}

function metal(value: unknown): PhysicalDivergenceMetal {
  if (!PHYSICAL_DIVERGENCE_METALS.includes(value as PhysicalDivergenceMetal)) {
    throw new TypeError(`Unsupported physical divergence metal: ${String(value)}`);
  }
  return value as PhysicalDivergenceMetal;
}

function optionalMissingSource(
  value: unknown,
  valid: (source: string) => boolean,
  readingState: PhysicalDivergenceRawState,
): value is string {
  return string(value) && (valid(value) || (readingState === 'missing_input' && value === ''));
}

function optionalMissingClock(
  value: unknown,
  valid: (clock: unknown) => clock is string,
  readingState: PhysicalDivergenceRawState,
): value is string {
  return valid(value) || (readingState === 'missing_input' && value === '');
}

function provenance(
  value: unknown,
  readingMetal: PhysicalDivergenceMetal,
  readingState: PhysicalDivergenceRawState,
): PhysicalDivergenceRawProvenance {
  const raw = object(value);
  const contract = PHYSICAL_DIVERGENCE_CONTRACT.metals[readingMetal];
  if (
    raw.physicalSymbol !== contract.physicalSymbol
    || !optionalMissingSource(
      raw.physicalSource,
      (source) => source.startsWith(`Shanghai Gold Exchange ${contract.physicalSymbol} `),
      readingState,
    )
    || !optionalMissingClock(raw.physicalAsOf, isoDate, readingState)
    || raw.paperSymbol !== contract.paperSymbol
    || !optionalMissingSource(
      raw.paperSource,
      (source) => source === `COMEX ${contract.paperSymbol} futures snapshot`,
      readingState,
    )
    || !optionalMissingClock(raw.paperAsOf, isoInstant, readingState)
    || !optionalMissingSource(
      raw.fxSource,
      (source) => source === 'shared:fx-rates:v1',
      readingState,
    )
    || !optionalMissingSource(raw.fxPair, (pair) => pair === 'CNY/USD', readingState)
    || !optionalMissingClock(raw.fxAsOf, isoInstant, readingState)
    || raw.historyKey !== contract.historyKey
    || raw.historyWindowPoints !== PHYSICAL_DIVERGENCE_CONTRACT.history.windowPoints
  ) throw new TypeError('Physical divergence reading has invalid provenance');
  return {
    physicalSource: raw.physicalSource,
    physicalSymbol: contract.physicalSymbol,
    physicalAsOf: raw.physicalAsOf,
    paperSource: raw.paperSource,
    paperSymbol: contract.paperSymbol,
    paperAsOf: raw.paperAsOf,
    fxSource: raw.fxSource,
    fxPair: raw.fxPair,
    fxAsOf: raw.fxAsOf,
    historyKey: contract.historyKey,
    historyWindowPoints: PHYSICAL_DIVERGENCE_CONTRACT.history.windowPoints,
    methodologyVersion: methodology(raw.methodologyVersion),
  };
}

function regime(value: unknown, readingState: PhysicalDivergenceRawState): PhysicalDivergenceRawRegime | null {
  if (readingState !== 'ok') {
    if (value != null) throw new TypeError('Non-ok physical divergence reading carries a regime');
    return null;
  }
  if (!string(value) || !RAW_REGIMES.has(value as PhysicalDivergenceRawRegime)) {
    throw new TypeError(`Unknown physical premium regime: ${String(value)}`);
  }
  return value as PhysicalDivergenceRawRegime;
}

function trend(value: unknown, readingState: PhysicalDivergenceRawState): PhysicalDivergenceRawTrend | null {
  if (readingState !== 'ok') {
    if (value != null) throw new TypeError('Non-ok physical divergence reading carries a trend');
    return null;
  }
  if (!string(value) || !RAW_TRENDS.has(value as PhysicalDivergenceRawTrend)) {
    throw new TypeError(`Unknown physical premium trend: ${String(value)}`);
  }
  return value as PhysicalDivergenceRawTrend;
}

function transition(value: unknown): PhysicalDivergenceRawTransition {
  const raw = object(value);
  const transitionMetal = metal(raw.metal);
  if (
    !string(raw.fromRegime)
    || !RAW_REGIMES.has(raw.fromRegime as PhysicalDivergenceRawRegime)
    || !string(raw.toRegime)
    || !RAW_REGIMES.has(raw.toRegime as PhysicalDivergenceRawRegime)
    || raw.fromRegime === raw.toRegime
    || !finite(raw.detectedAt)
    || !Number.isInteger(raw.detectedAt)
    || raw.detectedAt <= 0
  ) throw new TypeError('Physical divergence snapshot has an invalid transition');
  const expectedId = `physical-premium:${transitionMetal}:${raw.fromRegime}-${raw.toRegime}:${raw.detectedAt}`;
  if (raw.id !== expectedId || methodology(raw.methodologyVersion) !== PHYSICAL_DIVERGENCE_METHODOLOGY_VERSION) {
    throw new TypeError('Physical divergence snapshot has an invalid transition identity');
  }
  return {
    id: expectedId,
    metal: transitionMetal,
    fromRegime: raw.fromRegime as PhysicalDivergenceRawRegime,
    toRegime: raw.toRegime as PhysicalDivergenceRawRegime,
    detectedAt: raw.detectedAt,
    methodologyVersion: PHYSICAL_DIVERGENCE_METHODOLOGY_VERSION,
  };
}

function reading(value: unknown): PhysicalDivergenceRawReading {
  const raw = object(value);
  const readingMetal = metal(raw.metal);
  const readingState = state(raw.state);
  const readingProvenance = provenance(raw.provenance, readingMetal, readingState);
  if (!string(raw.reason) || !isPhysicalDivergenceStoredReadingReason(readingState, raw.reason)) {
    throw new TypeError('Physical divergence reading has invalid state metadata');
  }
  if (!finite(raw.historyPoints) || !Number.isInteger(raw.historyPoints) || raw.historyPoints < 0) {
    throw new TypeError('Physical divergence reading has invalid history count');
  }
  const readingIndex = nullableFinite(raw.index);
  const readingPercentile = nullableFinite(raw.percentile);
  const readingRobustZ = nullableFinite(raw.robustZ);
  const readingDelta5d = nullableFinite(raw.delta5d);
  const readingDelta20d = nullableFinite(raw.delta20d);
  const premiumPct = nullableFinite(raw.premiumPct);
  const premiumUsdPerOz = nullableFinite(raw.premiumUsdPerOz);
  if (readingState === 'ok') {
    if (
      readingIndex == null
      || readingIndex < 0
      || readingIndex > 100
      || premiumPct == null
      || premiumUsdPerOz == null
      || readingPercentile == null
      || readingPercentile < 0
      || readingPercentile > 100
      || readingDelta5d == null
      || readingDelta20d == null
      || raw.historyPoints < PHYSICAL_DIVERGENCE_CONTRACT.history.minimumPoints
      || raw.historyPoints > PHYSICAL_DIVERGENCE_CONTRACT.history.windowPoints
    ) throw new TypeError('Ok physical divergence reading is incomplete');
  } else if (
    readingIndex != null
    || readingPercentile != null
    || readingRobustZ != null
    || readingDelta5d != null
    || readingDelta20d != null
  ) {
    throw new TypeError('Non-ok physical divergence reading carries analytical values');
  }
  if (
    !string(raw.historyWindowStart)
    || !string(raw.historyWindowEnd)
    || !optionalMissingClock(raw.physicalAsOf, isoDate, readingState)
    || !optionalMissingClock(raw.paperAsOf, isoInstant, readingState)
    || raw.physicalAsOf !== readingProvenance.physicalAsOf
    || raw.paperAsOf !== readingProvenance.paperAsOf
  ) throw new TypeError('Physical divergence reading and provenance clocks do not match');
  if (
    readingState === 'ok'
    && (!isoDate(raw.historyWindowStart) || !isoDate(raw.historyWindowEnd))
  ) throw new TypeError('Ok physical divergence reading has invalid history bounds');
  return {
    metal: readingMetal,
    state: readingState,
    reason: raw.reason,
    regime: regime(raw.regime, readingState),
    index: readingIndex,
    premiumPct,
    premiumUsdPerOz,
    percentile: readingPercentile,
    robustZ: readingRobustZ,
    delta5d: readingDelta5d,
    delta20d: readingDelta20d,
    trend5d: trend(raw.trend5d, readingState),
    trend20d: trend(raw.trend20d, readingState),
    historyPoints: raw.historyPoints,
    historyWindowStart: raw.historyWindowStart,
    historyWindowEnd: raw.historyWindowEnd,
    physicalAsOf: raw.physicalAsOf,
    paperAsOf: raw.paperAsOf,
    methodologyVersion: methodology(raw.methodologyVersion),
    provenance: readingProvenance,
  };
}

function canonicalWeights(value: unknown): PhysicalDivergenceRawComposite['weights'] {
  if (!Array.isArray(value) || value.length !== PHYSICAL_DIVERGENCE_METALS.length) {
    throw new TypeError('Physical divergence composite has invalid weights');
  }
  const byMetal = new Map(value.map((entry) => {
    const raw = object(entry);
    const weightMetal = metal(raw.metal);
    if (
      !finite(raw.weight)
      || raw.weight !== PHYSICAL_DIVERGENCE_CONTRACT.metals[weightMetal].weight
      || methodology(raw.methodologyVersion) !== PHYSICAL_DIVERGENCE_METHODOLOGY_VERSION
    ) throw new TypeError('Physical divergence composite has an invalid weight');
    return [weightMetal, raw.weight] as const;
  }));
  if (byMetal.size !== PHYSICAL_DIVERGENCE_METALS.length) {
    throw new TypeError('Physical divergence composite repeats a metal weight');
  }
  return PHYSICAL_DIVERGENCE_METALS.map((weightMetal) => ({
    metal: weightMetal,
    weight: PHYSICAL_DIVERGENCE_CONTRACT.metals[weightMetal].weight,
    methodologyVersion: PHYSICAL_DIVERGENCE_METHODOLOGY_VERSION,
  }));
}

function validateStoredComposite(
  value: unknown,
  readings: PhysicalDivergenceRawReading[],
): void {
  const raw = object(value);
  methodology(raw.methodologyVersion);
  canonicalWeights(raw.weights);
  const expected = buildPhysicalStressComposite(readings);
  const actualState = state(raw.state);
  const actualIndex = nullableFinite(raw.index);
  if (
    !string(raw.reason)
    || !isPhysicalDivergenceStoredCompositeReason(actualState, raw.reason)
    || actualState !== expected.state
    || raw.reason !== expected.reason
    || actualIndex !== expected.index
  ) throw new TypeError('Physical divergence composite does not match its member readings');
}

function applyFreshness(
  readings: PhysicalDivergenceRawReading[],
  nowMs: number,
): PhysicalDivergenceRawReading[] {
  if (!Number.isFinite(nowMs)) throw new TypeError('Physical divergence evaluation clock is invalid');
  return readings.map((entry) => {
    if (entry.state !== 'ok' && entry.state !== 'insufficient_history') return entry;
    const staleReason = physicalDivergenceStaleReason({
      physicalAsOf: entry.physicalAsOf,
      paperAsOf: entry.paperAsOf,
      fxAsOf: entry.provenance.fxAsOf,
    }, nowMs);
    if (!staleReason) return entry;
    return {
      ...entry,
      state: physicalDivergenceStateForFreshnessReason(staleReason),
      reason: staleReason,
      regime: null,
      index: null,
      percentile: null,
      robustZ: null,
      delta5d: null,
      delta20d: null,
      trend5d: null,
      trend20d: null,
      // Match the shape of a seeder-produced reading in the same state: the window bounds
      // describe an analysis that no longer stands behind this reading.
      historyWindowStart: '',
      historyWindowEnd: '',
    };
  });
}

/**
 * A state this build does not implement — as opposed to ordinary malformed stored data.
 *
 * #6448 requires that "an unknown/unhandled state must surface as an error, never silently
 * map to 'normal'", so a consumer must not swallow this one. Everything else the validator
 * rejects (corrupt shapes, a foreign methodology) is data a consumer may isolate and drop.
 *
 * Matched on message prefix rather than a subclass on purpose: `err.constructor.name` is
 * mangled in the minified `api/` bundles, so class identity does not survive the build.
 */
export function isPhysicalDivergenceContractError(error: unknown): boolean {
  return error instanceof Error
    && error.message.startsWith('Unknown physical divergence state:');
}

/**
 * A snapshot written under a methodology this build does not implement. Distinct from an
 * unknown state: this is ordinary producer/consumer deploy skew (the Railway seeder and the
 * Vercel API ship independently), so a read path should fail closed with a reason rather
 * than 500 for the length of the rollout window.
 */
export function isUnsupportedPhysicalDivergenceMethodology(error: unknown): boolean {
  return error instanceof Error
    && error.message.startsWith('Unsupported physical divergence methodology:');
}

export function normalizePhysicalDivergenceSnapshot(
  value: unknown,
  nowMs = Date.now(),
): PhysicalDivergenceRawSnapshot {
  const raw = object(value);
  methodology(raw.methodologyVersion);
  if (!isoInstant(raw.evaluatedAt) || !Array.isArray(raw.readings) || !Array.isArray(raw.transitions)) {
    throw new TypeError('Physical divergence snapshot has an invalid envelope');
  }
  const storedReadings = raw.readings.map(reading);
  if (
    storedReadings.length !== PHYSICAL_DIVERGENCE_METALS.length
    || new Set(storedReadings.map((entry) => entry.metal)).size !== PHYSICAL_DIVERGENCE_METALS.length
  ) throw new TypeError('Physical divergence snapshot must contain gold and silver readings');
  validateStoredComposite(raw.composite, storedReadings);
  const readings = applyFreshness(storedReadings, nowMs);
  return {
    readings,
    composite: buildPhysicalStressComposite(readings),
    evaluatedAt: raw.evaluatedAt,
    methodologyVersion: PHYSICAL_DIVERGENCE_METHODOLOGY_VERSION,
    transitions: raw.transitions.map(transition),
  };
}
