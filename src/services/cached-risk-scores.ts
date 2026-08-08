import type { CountryScore, ComponentScores } from './country-instability';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { setHasCachedScores } from './country-instability';
import { TIER1_COUNTRIES } from '@/config/countries';
import type { GetRiskScoresResponse, CiiScore, StrategicRisk } from '@/generated/client/worldmonitor/intelligence/v1/service_client';
import { createCircuitBreaker } from '@/utils';
import { getHydratedData } from '@/services/bootstrap';
import { IntelligenceServiceClient } from '@/services/generated-rpc-clients';

// ---- Sebuf client ----

const client = new IntelligenceServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });

// ---- Legacy types (preserved for consumer compatibility) ----

export interface CachedCIIScore {
  code: string;
  name: string;
  score: number;
  level: 'low' | 'normal' | 'elevated' | 'high' | 'critical';
  trend: 'rising' | 'stable' | 'falling';
  change24h: number;
  components: ComponentScores;
  // Null when upstream proto provided no computedAt — adapter MUST NOT fabricate `now`.
  lastUpdated: string | null;
}

export interface CachedStrategicRisk {
  score: number;
  level: string;
  trend: string;
  // Derived from max CII computedAt; null when no CII carries a real timestamp.
  lastUpdated: string | null;
  contributors: Array<{
    country: string;
    code: string;
    score: number;
    level: string;
  }>;
}

export interface CachedRiskScores {
  cii: CachedCIIScore[];
  strategicRisk: CachedStrategicRisk;
  protestCount: number;
  // Derived from max CII computedAt; null when no CII carries a real timestamp.
  computedAt: string | null;
  cached: boolean;
  degraded: boolean;
  stale: boolean;
}

// ---- Proto → legacy adapters ----

const TREND_REVERSE: Record<string, 'rising' | 'stable' | 'falling'> = {
  TREND_DIRECTION_RISING: 'rising',
  TREND_DIRECTION_STABLE: 'stable',
  TREND_DIRECTION_FALLING: 'falling',
};

const SEVERITY_REVERSE: Record<string, string> = {
  SEVERITY_LEVEL_HIGH: 'high',
  SEVERITY_LEVEL_MEDIUM: 'medium',
  SEVERITY_LEVEL_LOW: 'low',
};

function getScoreLevel(score: number): 'low' | 'normal' | 'elevated' | 'high' | 'critical' {
  // Phase 3b / decision L1 — reconciled to the frontend getLevel cutoffs
  // (was 70 / 55 / 40 / 25). The frontend table is the canonical badge banding.
  if (score >= 81) return 'critical';
  if (score >= 66) return 'high';
  if (score >= 51) return 'elevated';
  if (score >= 31) return 'normal';
  return 'low';
}

export function isElevatedCiiScore(score: number): boolean {
  const level = getScoreLevel(score);
  return level === 'elevated' || level === 'high' || level === 'critical';
}

function toCachedCII(proto: CiiScore): CachedCIIScore {
  return {
    code: proto.region,
    name: TIER1_COUNTRIES[proto.region] || proto.region,
    score: proto.combinedScore,
    level: getScoreLevel(proto.combinedScore),
    trend: TREND_REVERSE[proto.trend] || 'stable',
    change24h: proto.dynamicScore,
    components: {
      unrest: proto.components?.ciiContribution ?? 0,
      conflict: proto.components?.geoConvergence ?? 0,
      security: proto.components?.militaryActivity ?? 0,
      information: proto.components?.newsActivity ?? 0,
    },
    // Preserve upstream computedAt verbatim; surface null when absent so the UI does not lie.
    lastUpdated: proto.computedAt ? new Date(proto.computedAt).toISOString() : null,
  };
}

// Strategic-risk and aggregate timestamps are derived from the freshest CII computedAt the
// adapter saw. The proto carries no dedicated timestamp on StrategicRisk or
// GetRiskScoresResponse (see #3800 — server-side end-to-end timestamps are a follow-up).
function deriveMaxCiiTimestamp(ciiScores: CiiScore[]): string | null {
  let max: number | null = null;
  for (const s of ciiScores) {
    if (s.computedAt && (max === null || s.computedAt > max)) max = s.computedAt;
  }
  return max === null ? null : new Date(max).toISOString();
}

function toCachedStrategicRisk(
  risks: StrategicRisk[],
  ciiScores: CiiScore[],
  derivedTimestamp: string | null,
): CachedStrategicRisk {
  const global = risks[0];
  const ciiMap = new Map(ciiScores.map((s) => [s.region, s]));
  return {
    score: global?.score ?? 0,
    level: SEVERITY_REVERSE[global?.level ?? ''] || 'low',
    trend: TREND_REVERSE[global?.trend ?? ''] || 'stable',
    lastUpdated: derivedTimestamp,
    contributors: (global?.factors ?? []).map((code) => {
      const cii = ciiMap.get(code);
      return {
        country: TIER1_COUNTRIES[code] || code,
        code,
        score: cii?.combinedScore ?? 0,
        level: cii ? getScoreLevel(cii.combinedScore) : 'low',
      };
    }),
  };
}

export function toRiskScores(resp: GetRiskScoresResponse): CachedRiskScores {
  const derivedTimestamp = deriveMaxCiiTimestamp(resp.ciiScores);
  return {
    cii: resp.ciiScores.map(toCachedCII),
    strategicRisk: toCachedStrategicRisk(resp.strategicRisks, resp.ciiScores, derivedTimestamp),
    protestCount: 0,
    computedAt: derivedTimestamp,
    cached: true,
    degraded: Boolean(resp.degraded),
    stale: Boolean(resp.stale),
  };
}

// ---- Shape validator (localStorage is attacker-controlled) ----

const VALID_LEVELS = new Set(['low', 'normal', 'elevated', 'high', 'critical']);
const VALID_STRATEGIC_RISK_LEVELS = new Set(['low', 'medium', 'high']);
const VALID_TRENDS = new Set(['rising', 'stable', 'falling']);
const ISO2_RE = /^[A-Z]{2}$/;
const COMPONENT_KEYS = ['unrest', 'conflict', 'security', 'information'] as const;
const CACHED_CII_TIMESTAMP_MIN_MS = Date.UTC(2000, 0, 1);
const CACHED_CII_TIMESTAMP_MAX_FUTURE_MS = 5 * 60 * 1000;

function isFiniteInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isKnownTier1Code(value: unknown): value is string {
  return typeof value === 'string'
    && ISO2_RE.test(value)
    && Object.prototype.hasOwnProperty.call(TIER1_COUNTRIES, value);
}

function isValidComponents(value: unknown): value is ComponentScores {
  if (!value || typeof value !== 'object') return false;
  const components = value as Record<string, unknown>;
  return COMPONENT_KEYS.every((key) => isFiniteInRange(components[key], 0, 100));
}

function isValidCachedCiiTimestamp(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    && timestamp >= CACHED_CII_TIMESTAMP_MIN_MS
    && timestamp <= Date.now() + CACHED_CII_TIMESTAMP_MAX_FUTURE_MS;
}

function isValidCiiEntry(e: unknown): e is CachedCIIScore {
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  return isKnownTier1Code(o.code)
    && typeof o.name === 'string'
    && isFiniteInRange(o.score, 0, 100)
    && VALID_LEVELS.has(o.level as string)
    && VALID_TRENDS.has(o.trend as string)
    && isFiniteInRange(o.change24h, -100, 100)
    && isValidComponents(o.components)
    && isValidCachedCiiTimestamp(o.lastUpdated);
}

function isValidStrategicRisk(value: unknown): value is CachedStrategicRisk {
  if (!value || typeof value !== 'object') return false;
  const risk = value as Record<string, unknown>;
  if (!isFiniteInRange(risk.score, 0, 100)
    || !VALID_STRATEGIC_RISK_LEVELS.has(risk.level as string)
    || !VALID_TRENDS.has(risk.trend as string)
    || !isValidCachedCiiTimestamp(risk.lastUpdated)
    || !Array.isArray(risk.contributors)) return false;

  return risk.contributors.every((value) => {
    if (!value || typeof value !== 'object') return false;
    const contributor = value as Record<string, unknown>;
    return typeof contributor.country === 'string'
      && isKnownTier1Code(contributor.code)
      && isFiniteInRange(contributor.score, 0, 100)
      && VALID_LEVELS.has(contributor.level as string);
  });
}

function canonicalizeCachedCiiEntry(entry: CachedCIIScore): CachedCIIScore {
  return {
    ...entry,
    name: TIER1_COUNTRIES[entry.code] ?? entry.code,
  };
}

function canonicalizeCachedRiskScores(data: CachedRiskScores): CachedRiskScores {
  return {
    ...data,
    cii: data.cii.map(canonicalizeCachedCiiEntry),
    degraded: data.degraded === true,
    stale: data.stale === true,
  };
}

// ---- localStorage persistence (sync prime for getCachedScores) ----

const LS_KEY = 'wm:risk-scores';
const LS_MAX_STALENESS_MS = 60 * 60 * 1000;

function loadFromStorage(): CachedRiskScores | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const { data, savedAt } = JSON.parse(raw);
    if (!Number.isFinite(savedAt) || !Array.isArray(data?.cii) || !isValidStrategicRisk(data?.strategicRisk)) {
      localStorage.removeItem(LS_KEY);
      return null;
    }
    if (Date.now() - savedAt > LS_MAX_STALENESS_MS) {
      localStorage.removeItem(LS_KEY);
      return null;
    }
    if (!data.cii.every(isValidCiiEntry)) {
      localStorage.removeItem(LS_KEY);
      return null;
    }
    return canonicalizeCachedRiskScores(data);
  } catch { return null; }
}

function saveToStorage(data: CachedRiskScores): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ data, savedAt: Date.now() }));
  } catch { /* quota exceeded */ }
}

// ---- Circuit breaker ----

const breaker = createCircuitBreaker<CachedRiskScores>({
  name: 'Risk Scores',
  cacheTtlMs: 30 * 60 * 1000,
  persistCache: true,
  persistentStaleCeilingMs: LS_MAX_STALENESS_MS,
});

// Sync prime from localStorage (before async IndexedDB hydration)
const stored = loadFromStorage();
if (stored && stored.cii.length > 0) {
  breaker.recordSuccess(stored);
  setHasCachedScores(true);
}

function emptyFallback(): CachedRiskScores {
  // No data → no timestamp. The UI must render "—" / "Unavailable", not "Updated now".
  return {
    cii: [],
    strategicRisk: { score: 0, level: 'low', trend: 'stable', lastUpdated: null, contributors: [] },
    protestCount: 0,
    computedAt: null,
    cached: true,
    degraded: true,
    stale: true,
  };
}

// ---- Abort helpers ----

function createAbortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function withCallerAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(createAbortError());

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(createAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export async function fetchCachedRiskScores(signal?: AbortSignal): Promise<CachedRiskScores | null> {
  if (signal?.aborted) throw createAbortError();

  // Layer 1: Bootstrap hydration (one-time, only when breaker has no cached data)
  if (breaker.getCached() === null) {
    const hydrated = getHydratedData('riskScores') as GetRiskScoresResponse | undefined;
    if (hydrated?.ciiScores?.length) {
      const data = toRiskScores(hydrated);
      breaker.recordSuccess(data);
      saveToStorage(data);
      setHasCachedScores(true);
      return data;
    }
  }

  // Layer 2: Circuit breaker (in-memory cache → SWR → IndexedDB → RPC → fallback)
  const result = await withCallerAbort(
    breaker.execute(async () => {
      const resp = await client.getRiskScores({ region: '' });
      const data = toRiskScores(resp);
      saveToStorage(data);
      setHasCachedScores(true);
      return data;
    }, emptyFallback(), { shouldCache: (r) => r.cii.length > 0 }),
    signal,
  );

  if (!result || !Array.isArray(result.cii) || result.cii.length === 0) {
    return null;
  }

  setHasCachedScores(true);
  return result;
}

export function getCachedScores(): CachedRiskScores | null {
  return breaker.getCached();
}

export function hasCachedScores(): boolean {
  return breaker.getCached() !== null;
}

export function toCountryScore(cached: CachedCIIScore): CountryScore {
  return {
    code: cached.code,
    name: cached.name,
    score: cached.score,
    level: cached.level,
    trend: cached.trend,
    change24h: cached.change24h,
    components: cached.components,
    lastUpdated: cached.lastUpdated ? new Date(cached.lastUpdated) : null,
  };
}

export function normalizeCiiCountryCode(code: string): string {
  return code.toUpperCase();
}

export function getCachedCountryScore(code: string): CountryScore | null {
  const normalizedCode = normalizeCiiCountryCode(code);
  const cached = getCachedScores()?.cii.find((score) => score.code === normalizedCode);
  return cached ? toCountryScore(cached) : null;
}

export function getCachedCountryScoreValue(code: string): number | null {
  return getCachedCountryScore(code)?.score ?? null;
}

export function getCachedCountryScores(): CountryScore[] {
  const cached = getCachedScores();
  if (!cached?.cii.length) return [];
  return cached.cii.map(toCountryScore).sort((a, b) => b.score - a.score);
}
