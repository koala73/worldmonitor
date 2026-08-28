import filterParamContracts from '../../../../shared/openapi-filter-param-contracts.json';

// ========================================================================
// Constants
// ========================================================================

export const UPSTREAM_TIMEOUT_MS = 10_000;

// Temporal baseline constants
export const BASELINE_TTL = 7776000; // 90 days in seconds
export const MIN_SAMPLES = 10;
export {
  Z_THRESHOLD_LOW,
  Z_THRESHOLD_MEDIUM,
  Z_THRESHOLD_HIGH,
  getBaselineSeverity,
} from '../../../../shared/analysis-temporal-severity';

export const VALID_BASELINE_TYPES = filterParamContracts.infrastructureTemporalBaselineTypes;

// ========================================================================
// Temporal baseline helpers
// ========================================================================

export interface BaselineEntry {
  mean: number;
  m2: number;
  sampleCount: number;
  lastUpdated: string;
}

export function makeBaselineKey(type: string, region: string, weekday: number, month: number): string {
  return `baseline:${type}:${region}:${weekday}:${month}`;
}

export function makeBaselineKeyV2(type: string, region: string, weekday: number, month: number): string {
  return `baseline:v2:${type}:${region}:${weekday}:${month}`;
}

export const COUNT_SOURCE_KEYS: Record<string, string> = {
  news: 'news:insights:v1',
  satellite_fires: 'wildfire:fires:v1',
};

export const TEMPORAL_ANOMALIES_KEY = 'temporal:anomalies:v1';

/**
 * Redis key lifetime. Deliberately LONGER than the rebuild threshold below so an
 * expired-but-usable snapshot survives as the stale fallback: when the snapshot is
 * due for rebuild, whichever request loses the lock race still returns this cached
 * body rather than an empty result.
 */
export const TEMPORAL_ANOMALIES_TTL = 3600;

/**
 * How old a snapshot may get before the next request rebuilds it.
 *
 * This also sets the cadence of `seed-meta:temporal:anomalies`, because the stamp is
 * written ONLY on a successful rebuild — it means "the data was rebuilt recently",
 * not "somebody requested this recently". Health consumers watch that key at
 * maxStaleMin: 45, so this must stay comfortably below 45 minutes or the monitor
 * false-alarms on a single missed cycle. At 20 minutes the alarm has ~2.25x margin
 * and never sits on the refresh period.
 *
 * Changing this without moving those consumers' maxStaleMin is a monitoring change,
 * not just a caching one. See tests/temporal-anomalies-cache.test.mts.
 *
 * fetchedAt on seed-meta:temporal:anomalies is this rebuild clock. The CONTENT
 * clock is newestItemAt / maxContentAgeMin, derived from the upstream payloads
 * themselves (see temporalAnomaliesContentMeta). A frozen-but-200 news or FIRMS
 * feed keeps fetchedAt fresh every cycle; only the observation dates go stale.
 */
export const TEMPORAL_ANOMALIES_REBUILD_AFTER_MS = 20 * 60 * 1000;

/**
 * Content-age budget for `seed-meta:temporal:anomalies`.
 *
 * Sized from the slower upstream's publication calendar, not the 20-minute
 * rebuild cadence. FIRMS area queries use a 1-day window (`/1` in
 * seed-fire-detections.mjs) and NRT files reset at midnight UTC with 3–6h to
 * accumulate; 48h is 2× that window plus the midnight lag. News top-stories
 * are ranked by importance, not recency, so a live digest can still cite
 * stories many hours old — 48h absorbs that without becoming the 12-month
 * blind spot #3845 documented.
 *
 * Health liveness (`fetchedAt` vs maxStaleMin: 45) remains the rebuild clock.
 */
export const TEMPORAL_ANOMALIES_MAX_CONTENT_AGE_MIN = 48 * 60;

/** Matches scripts/_content-age-helpers.mjs CLOCK_SKEW_TOLERANCE_MS. */
const CONTENT_AGE_CLOCK_SKEW_MS = 60 * 60 * 1000;

export interface TemporalAnomaliesContentAge {
  newestItemAt: number;
  oldestItemAt: number;
}

function parseObservationMs(value: unknown, skewLimit: number): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0 || value > skewLimit) return null;
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const ts = Date.parse(value);
    if (!Number.isFinite(ts) || ts <= 0 || ts > skewLimit) return null;
    return ts;
  }
  return null;
}

function reduceTimestamps(timestamps: number[]): TemporalAnomaliesContentAge | null {
  if (timestamps.length === 0) return null;
  let newest = timestamps[0]!;
  let oldest = timestamps[0]!;
  for (const ts of timestamps) {
    if (ts > newest) newest = ts;
    if (ts < oldest) oldest = ts;
  }
  return { newestItemAt: newest, oldestItemAt: oldest };
}

function newsContentClock(
  data: unknown,
  skewLimit: number,
): TemporalAnomaliesContentAge | null | undefined {
  if (data == null || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const payload = data as Record<string, unknown>;
  const timestamps: number[] = [];
  const stories = payload.topStories;
  if (Array.isArray(stories)) {
    for (const story of stories) {
      if (!story || typeof story !== 'object') continue;
      const row = story as Record<string, unknown>;
      for (const field of ['pubDate', 'publishedAt', 'date', 'lastUpdated'] as const) {
        const ts = parseObservationMs(row[field], skewLimit);
        if (ts != null) timestamps.push(ts);
      }
    }
  }
  const range = payload.sourceAgeRange;
  if (range && typeof range === 'object' && !Array.isArray(range)) {
    const window = range as Record<string, unknown>;
    const newest = parseObservationMs(window.newestMs, skewLimit);
    const oldest = parseObservationMs(window.oldestMs, skewLimit);
    if (newest != null) timestamps.push(newest);
    if (oldest != null) timestamps.push(oldest);
  }
  // A contributing news payload with nothing datable is indistinguishable from
  // a frozen feed whose items lost their timestamps. Fail closed.
  return reduceTimestamps(timestamps);
}

function firesContentClock(
  data: unknown,
  skewLimit: number,
): TemporalAnomaliesContentAge | null | undefined {
  if (data == null || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const payload = data as {
    fireDetections?: unknown;
    _firmsState?: unknown;
    _firmsPartial?: unknown;
    _firmsCount?: unknown;
  };
  // Canonical wildfire merge preserves explicit FIRMS coverage failures even
  // when CWFIS/BC still publish. A full loss is Canada-only coverage; a partial
  // loss leaves known regions dark. Neither is a skippable empty FIRMS window —
  // returning undefined here lets a live news clock hide an incomplete global
  // source behind a fresh temporal-anomalies clock.
  if (payload._firmsState === 'failed' || payload._firmsPartial === true) return null;
  // Same outage, older payload shape: before the #7141 follow-up the merge
  // graded FIRMS on promise settlement alone, so a total outage published
  // `{_firmsState: 'ok', _firmsCount: 0}` with Canada-only rows. The producer
  // now marks that 'failed', but a payload written by the previous version can
  // still be in Redis (2h TTL) across a deploy, so fail closed on the declared
  // count too.
  //
  // This deliberately also fails closed on a genuinely empty WORLDWIDE FIRMS
  // window, which is indistinguishable from the outage in this payload shape.
  // That is the intended bias: zero satellite detections across every
  // monitored region in a 1-day window is vanishingly rare, a global FIRMS
  // outage is not, and a false STALE_CONTENT is recoverable where a silently
  // green monitor is the bug this contract exists to prevent. Once legacy
  // payloads age out, the `_firmsState: 'failed'` guard above is what fires.
  if (payload._firmsState === 'ok' && payload._firmsCount === 0) return null;
  const fires = payload.fireDetections;
  if (!Array.isArray(fires) || fires.length === 0) {
    // A live FIRMS 1-day window can be empty in the monitored regions. That is
    // "no satellite observations right now", not "we cannot date this".
    return undefined;
  }
  const timestamps: number[] = [];
  let firmsRows = 0;
  for (const fire of fires) {
    if (!fire || typeof fire !== 'object') continue;
    const row = fire as Record<string, unknown>;
    const source = row.source;
    const isFirms = source == null || source === '' || source === 'firms';
    if (!isFirms) continue;
    firmsRows += 1;
    const ts = parseObservationMs(row.detectedAt, skewLimit);
    if (ts != null) timestamps.push(ts);
  }
  if (firmsRows === 0) {
    // Agency-only payload without an explicit FIRMS failure: skip rather than
    // clock off ignition dates that can be days old on ongoing fires.
    return undefined;
  }
  if (timestamps.length === 0) return null;
  return reduceTimestamps(timestamps);
}

/**
 * Content-age of a temporal-anomalies rebuild from the upstream payloads that
 * actually contributed a count this cycle.
 *
 * Two independently-failing sources (`news:insights:v1`, `wildfire:fires:v1`).
 * One clock per source, reduced with min() — a live fires feed must not hide a
 * frozen news feed, and vice versa. See CONCEPTS.md "Content-Age Contract" and
 * docs/solutions/design-patterns/multi-source-freshness-clock-must-reduce-with-min.md.
 *
 * Returns null when no contributing source is datable, when a contributing
 * source has items that cannot be dated, or when a configured COUNT_SOURCE_KEYS
 * source was not read this cycle. A present source may still skip (empty FIRMS
 * window / agency-only). An *absent* configured source must not: the remaining
 * live clock would otherwise stamp fresh content for partial coverage, and no
 * temporal-anomalies consumer sets minRecordCount. The writer stamps
 * `newestItemAt: null` in the fail-closed case, which classifyKey reads as
 * STALE_CONTENT.
 */
export function temporalAnomaliesContentMeta(
  sources: { news?: unknown; satellite_fires?: unknown },
  nowMs = Date.now(),
): TemporalAnomaliesContentAge | null {
  const skewLimit = nowMs + CONTENT_AGE_CLOCK_SKEW_MS;
  const clocks: TemporalAnomaliesContentAge[] = [];
  for (const clock of [
    // Missing configured source → null (fail closed), not undefined (skip).
    sources.news !== undefined ? newsContentClock(sources.news, skewLimit) : null,
    sources.satellite_fires !== undefined
      ? firesContentClock(sources.satellite_fires, skewLimit)
      : null,
  ]) {
    if (clock === undefined) continue;
    if (clock === null) return null;
    clocks.push(clock);
  }
  if (clocks.length === 0) return null;
  return {
    newestItemAt: Math.min(...clocks.map((clock) => clock.newestItemAt)),
    oldestItemAt: Math.min(...clocks.map((clock) => clock.oldestItemAt)),
  };
}

/**
 * Content clock over ONLY the sources that were actually readable this cycle.
 *
 * Sibling of `temporalAnomaliesContentMeta` for the transient-read-error path.
 * That function fail-closes on an ABSENT configured source, which is right when
 * absence means "the key is gone" — but wrong when it means "this one read
 * timed out", because then every cycle with a Redis blip asserts STALE_CONTENT
 * on live data.
 *
 * The caller still must not mask a KNOWN outage behind a carried-forward clock,
 * so this reports the three states separately rather than collapsing them:
 *   - `fail-closed` — a readable source is explicitly unhealthy or undatable.
 *     Stamp the null; never substitute a prior clock for a source that just
 *     told you it is broken.
 *   - `no-signal`   — every readable source legitimately skipped (empty FIRMS
 *     window / agency-only). Nothing learned this cycle.
 *   - `ok`          — at least one readable source produced a clock.
 */
export type TemporalAnomaliesReadableClock =
  | { status: 'ok'; clock: TemporalAnomaliesContentAge }
  | { status: 'fail-closed' }
  | { status: 'no-signal' };

export function temporalAnomaliesReadableContentMeta(
  sources: { news?: unknown; satellite_fires?: unknown },
  nowMs = Date.now(),
): TemporalAnomaliesReadableClock {
  const skewLimit = nowMs + CONTENT_AGE_CLOCK_SKEW_MS;
  const clocks: TemporalAnomaliesContentAge[] = [];
  for (const clock of [
    // Absent here means "not readable this cycle", which the caller handles —
    // so absence is skipped rather than fail-closed. That is the ONLY
    // difference from temporalAnomaliesContentMeta.
    sources.news !== undefined ? newsContentClock(sources.news, skewLimit) : undefined,
    sources.satellite_fires !== undefined
      ? firesContentClock(sources.satellite_fires, skewLimit)
      : undefined,
  ]) {
    if (clock === undefined) continue;
    if (clock === null) return { status: 'fail-closed' };
    clocks.push(clock);
  }
  if (clocks.length === 0) return { status: 'no-signal' };
  return {
    status: 'ok',
    clock: {
      newestItemAt: Math.min(...clocks.map((clock) => clock.newestItemAt)),
      oldestItemAt: Math.min(...clocks.map((clock) => clock.oldestItemAt)),
    },
  };
}

/**
 * How often a rebuild folds a new sample into the `baseline:v2:*` running mean.
 *
 * Independent of the rebuild cadence on purpose. These were coupled only by
 * accident — a rebuild used to sample every time it ran — so changing the cache
 * interval silently changed the sample rate of a slow-moving signal, shrinking the
 * variance estimate and shifting every z-score. 60 minutes preserves the sampling
 * rate the baselines were accumulated at; change it only as a deliberate
 * statistical decision, never to tune caching.
 */
export const BASELINE_SAMPLE_INTERVAL_MS = 60 * 60 * 1000;
export const BASELINE_LOCK_KEY = 'baseline:lock';
export const BASELINE_LOCK_TTL = 30;


// ========================================================================
// Upstash Redis MGET helper (edge-compatible)
// getCachedJson / setCachedJson are imported from ../../../_shared/redis.ts
// ========================================================================

import { unwrapEnvelope } from '../../../_shared/seed-envelope';

export async function mgetJson(keys: string[]): Promise<(unknown | null)[]> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return keys.map(() => null);
  try {
    const resp = await fetch(`${url}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(['MGET', ...keys]),
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return keys.map(() => null);
    const data = (await resp.json()) as { result?: (string | null)[] };
    // Envelope-aware: several of these count-source keys (wildfire:fires:v1,
    // news:insights:v1) are contract-mode canonical keys post-PR-2.
    return (data.result || []).map(v => v ? unwrapEnvelope(JSON.parse(v)).data : null);
  } catch {
    return keys.map(() => null);
  }
}
