import { dataFreshness, type SeedHealthUpdate } from '@/services/data-freshness';
import {
  getHealthMappedSourceIds,
  HEALTH_CHECK_SOURCE_MAP,
} from '@/services/health-freshness-map';
import type { DataSourceId } from '@/types';

export { HEALTH_CHECK_SOURCE_MAP, getHealthMappedSourceIds } from '@/services/health-freshness-map';

interface HealthCheck {
  status?: string;
  records?: number | null;
  seedAgeMin?: number | null;
  maxStaleMin?: number | null;
  contentAgeMin?: number | null;
  maxContentAgeMin?: number | null;
}

interface HealthResponse {
  status?: string;
  checkedAt?: string;
  checks?: Record<string, HealthCheck>;
  problems?: Record<string, HealthCheck>;
}

// Detailed /api/health (full `checks`) is operator/enterprise-key-gated since
// #4715 — an anonymous dashboard calling it 401s on every tick (#4902). The
// compact variant is keyless: same per-check shape, but only non-OK entries
// land in `problems` and healthy checks are omitted entirely.
const PUBLIC_HEALTH_ENDPOINT = '/api/health?compact=1';

// One 401/403 per window is enough signal that the endpoint got (re-)gated;
// without suppression the 60s scheduler re-errors every tick, flooding the
// console and Sentry (same caller-sweep flood class as #4865).
const AUTH_GATE_SUPPRESS_MS = 15 * 60_000;
let authGateSuppressedUntilMs = 0;

export function __resetHealthFreshnessForTests(): void {
  authGateSuppressedUntilMs = 0;
}

export interface RefreshHealthFreshnessOptions {
  fetchFn?: typeof fetch;
  endpoint?: string;
  signal?: AbortSignal;
  urlResolver?: (path: string) => string;
}

function statusRank(status: string): number {
  switch (status) {
    case 'SEED_ERROR':
    case 'REDIS_DOWN':
    case 'REDIS_PARTIAL':
      return 5;
    case 'EMPTY':
    case 'EMPTY_DATA':
      return 4;
    case 'STALE_SEED':
    case 'STALE_CONTENT':
    case 'COVERAGE_PARTIAL':
      return 3;
    case 'EMPTY_ON_DEMAND':
      return 2;
    case 'OK_CASCADE':
      return 1;
    case 'OK':
    // An optional source adapter this deployment never configured. Ranks with OK
    // on purpose: it is not a degradation, so it must never outrank a real signal
    // when picking the worst status for a data source.
    case 'NOT_CONFIGURED':
      return 0;
    default:
      return 0;
  }
}

function stalenessRatio(update: SeedHealthUpdate): number {
  const ageMin = update.status === 'STALE_CONTENT' && update.contentAgeMin != null
    ? update.contentAgeMin
    : update.seedAgeMin;
  const maxAgeMin = update.status === 'STALE_CONTENT' && update.maxContentAgeMin != null
    ? update.maxContentAgeMin
    : update.maxStaleMin;
  if (ageMin == null || maxAgeMin == null) return 0;
  if (maxAgeMin === 0) {
    return ageMin === 0 ? 0 : Number.POSITIVE_INFINITY;
  }
  return ageMin / maxAgeMin;
}

function isRedisOutageStatus(status: string | undefined): status is 'REDIS_DOWN' | 'REDIS_PARTIAL' {
  return status === 'REDIS_DOWN' || status === 'REDIS_PARTIAL';
}

function getMappedSourceIds(): DataSourceId[] {
  return getHealthMappedSourceIds();
}

export async function refreshDataFreshnessFromHealth(options: RefreshHealthFreshnessOptions = {}): Promise<number> {
  if (Date.now() < authGateSuppressedUntilMs) return 0;
  const fetchFn = options.fetchFn ?? ((...args) => globalThis.fetch(...args));
  const endpoint = options.endpoint ?? PUBLIC_HEALTH_ENDPOINT;
  const url = options.urlResolver
    ? options.urlResolver(endpoint)
    : (await import('@/services/runtime')).toApiUrl(endpoint);
  const resp = await fetchFn(url, {
    headers: { Accept: 'application/json' },
    // Cloudflare's zone Browser-Cache-TTL override rewrites the origin's
    // max-age=0 to 30min (#4910); a browser-cached body older than the 15-min
    // FRESH_THRESHOLD would flip every synthesized-OK source to stale.
    // no-cache = revalidate every poll; the CDN's 60s edge cache (#4907)
    // still absorbs the origin cost.
    cache: 'no-cache',
    signal: options.signal,
  });

  if (resp.status === 401 || resp.status === 403) {
    authGateSuppressedUntilMs = Date.now() + AUTH_GATE_SUPPRESS_MS;
    throw new Error(`health freshness fetch failed: ${resp.status} (endpoint is auth-gated; suppressing retries)`);
  }

  // REDIS_DOWN now returns HTTP 503 with a JSON body {status:'REDIS_DOWN', ...}
  // and no `checks` (see api/health.js). Parse the body first and only treat a
  // non-2xx as a hard fetch failure when it ISN'T a recognized Redis-outage
  // payload — otherwise the outage branch below never runs and mapped sources
  // keep stale freshness state during an outage instead of being flagged.
  let payload: HealthResponse | null = null;
  try {
    payload = await resp.json() as HealthResponse;
  } catch {
    payload = null;
  }
  if (!payload || (!resp.ok && !isRedisOutageStatus(payload.status))) {
    throw new Error(`health freshness fetch failed: ${resp.status}`);
  }
  const checkedAtMs = payload.checkedAt ? Date.parse(payload.checkedAt) : Date.now();
  const checkedAt = Number.isFinite(checkedAtMs) ? checkedAtMs : Date.now();
  const updatesBySource = new Map<DataSourceId, SeedHealthUpdate>();
  const checks: Record<string, HealthCheck> = payload.checks ?? { ...(payload.problems ?? {}) };

  if (Object.keys(checks).length === 0 && isRedisOutageStatus(payload.status)) {
    const status = payload.status;
    const updates = getMappedSourceIds().map((sourceId) => ({
      sourceId,
      status,
      records: 0,
      checkedAtMs: checkedAt,
    }));
    dataFreshness.recordSeedHealth(updates);
    return updates.length;
  }

  // Compact responses omit healthy checks (only non-OK entries land in
  // `problems`), so a mapped check that is absent was evaluated server-side
  // and found within budget. Synthesize OK-as-of-checkedAt for those:
  // seedAgeMin 0 is required because recordSeedHealth keeps lastUpdate null
  // on an age-less update and calculateStatus then reports no_data.
  if (!payload.checks && typeof payload.status === 'string') {
    for (const checkName of Object.keys(HEALTH_CHECK_SOURCE_MAP)) {
      if (!(checkName in checks)) checks[checkName] = { status: 'OK', seedAgeMin: 0 };
    }
  }

  for (const [checkName, check] of Object.entries(checks)) {
    const sourceIds = HEALTH_CHECK_SOURCE_MAP[checkName];
    if (!sourceIds?.length || !check.status) continue;
    for (const sourceId of sourceIds) {
      const next = {
        sourceId,
        status: check.status,
        records: check.records,
        seedAgeMin: check.seedAgeMin,
        maxStaleMin: check.maxStaleMin,
        contentAgeMin: check.contentAgeMin,
        maxContentAgeMin: check.maxContentAgeMin,
        checkedAtMs: checkedAt,
      };
      const existing = updatesBySource.get(sourceId);
      if (
        !existing ||
        statusRank(next.status) > statusRank(existing.status) ||
        (statusRank(next.status) === statusRank(existing.status) && stalenessRatio(next) > stalenessRatio(existing))
      ) {
        updatesBySource.set(sourceId, next);
      }
    }
  }

  const updates = [...updatesBySource.values()];
  dataFreshness.recordSeedHealth(updates);
  return updates.length;
}
