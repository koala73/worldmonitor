import { getHydratedData } from '@/services/bootstrap';
import { toApiUrl } from '@/services/runtime';
import { INSIGHTS_MAX_AGE_MS, isAcceptedInsightsSnapshot } from '../../shared/insights-snapshot.js';

export interface ServerInsightStory {
  primaryTitle: string;
  primarySource: string;
  primaryLink: string;
  pubDate: string;
  /** Articles in the cluster — a volume signal, not a corroboration signal. */
  sourceCount: number;
  /**
   * Distinct PUBLISHERS behind the cluster (#6428). Written by
   * scripts/seed-insights.mjs via countPublisherFamilies, so nine BBC feed
   * labels count once. Optional only because a payload cached before the
   * field existed would not carry it; consumers must fail closed rather than
   * fall back to sourceCount, which counts articles.
   */
  uniqueSourceCount?: number;
  importanceScore: number;
  /** 0-100 source reliability, distinct from importanceScore. Absent on pre-rollout cache. */
  credibilityScore?: number;
  velocity: { level: string; sourcesPerHour: number };
  isAlert: boolean;
  category: string;
  threatLevel: string;
  countryCode: string | null;
}

export interface ServerBriefSource {
  title: string;
  source: string;
  url: string;
  publishedAt?: string;
}

export interface ServerInsights {
  worldBrief: string;
  /** #4921: one cited line per top story from the synthesis call —
   * absent on pre-rollout payloads and single-headline (L2) briefs. */
  briefStoryLines?: Array<{ n: number; text: string }>;
  /** #4921: age window of the source material behind this brief. */
  sourceAgeRange?: { newestMs: number; oldestMs: number } | null;
  worldBriefSources?: ServerBriefSource[];
  briefProvider: string;
  status: 'ok' | 'degraded';
  topStories: ServerInsightStory[];
  generatedAt: string;
  clusterCount: number;
  multiSourceCount: number;
  fastMovingCount: number;
  /** #4920 coverage provenance — present on payloads seeded after the
   * completeness-measurement rollout; absent on older cached payloads. */
  provenance?: {
    storiesConsidered: number;
    sourcesConsidered: number;
    selectionDrops?: { admissibility: number; sourceCap: number; overflow: number };
  };
}

let cached: ServerInsights | null = null;
let inFlight: Promise<ServerInsights | null> | null = null;
let inFlightAbort: AbortController | null = null;
let inFlightAbortTimer: ReturnType<typeof setTimeout> | null = null;
let inFlightDeadlineMs = 0;
/**
 * True once this page drained a hydrated insights payload that failed
 * validation. Empty slots (`undefined` from production `getHydratedData`,
 * or `null` from harness stubs) are not a consumed body and must not set
 * this flag. The slot is drain-once; the flag only skips a second drain.
 * It must not skip `fetchServerInsights()`: persistent FAST-tier cache can
 * be up to 24h old while insights freshness is 1h, and the credentialed
 * `?keys=insights` URL is no-store, so the first caller may still recover.
 */
let rejectedHydration = false;
// Server cron interval: scripts/seed-insights.mjs runs every 30 min
// (CACHE_TTL=10800s/3h, maxStaleMin: 30). The previous 15-min freshness gate
// was strictly less than the cron interval, so the panel spent ~50% of every
// 30-min cycle showing UNAVAILABLE + "Waiting for data..." even when the
// system was working perfectly. 60 min = 2× cron interval, gives one full
// missed-tick of headroom before falling through to the client-side path.
// Exported so the regression test asserts against the real value rather than
// inlining a copy that drifts silently when this constant changes.
export const MAX_AGE_MS = INSIGHTS_MAX_AGE_MS;

function isFresh(data: ServerInsights): boolean {
  return isAcceptedInsightsSnapshot(data);
}

function validateInsights(raw: unknown): ServerInsights | null {
  return isAcceptedInsightsSnapshot(raw) ? raw as ServerInsights : null;
}

function consumeHydration(): ServerInsights | null {
  if (rejectedHydration) return null;
  const raw = getHydratedData('insights');
  // Empty slot: production returns undefined; panel harnesses often return
  // null. Neither is a consumed body — on-demand fetch may still recover.
  if (raw == null) return null;
  const data = validateInsights(raw);
  if (data) {
    cached = data;
    return data;
  }
  rejectedHydration = true;
  return null;
}

export function getServerInsights(): ServerInsights | null {
  if (cached && isFresh(cached)) {
    return cached;
  }
  cached = null;
  return consumeHydration();
}

function abortInFlightRequest(): void {
  if (inFlightAbortTimer !== null) {
    clearTimeout(inFlightAbortTimer);
    inFlightAbortTimer = null;
  }
  if (!inFlightAbort || inFlightAbort.signal.aborted) return;
  try {
    inFlightAbort.abort(
      typeof DOMException === 'function'
        ? new DOMException('signal timed out', 'TimeoutError')
        : undefined,
    );
  } catch {
    /* already aborted or exotic AbortController */
  }
}

function armInFlightTimeout(timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  if (deadline <= inFlightDeadlineMs && inFlightAbortTimer !== null) return;
  inFlightDeadlineMs = Math.max(inFlightDeadlineMs, deadline);
  if (inFlightAbortTimer !== null) clearTimeout(inFlightAbortTimer);
  const remaining = inFlightDeadlineMs - Date.now();
  if (remaining <= 0) {
    abortInFlightRequest();
    return;
  }
  inFlightAbortTimer = setTimeout(abortInFlightRequest, remaining);
}

function clearInFlightTimeout(): void {
  if (inFlightAbortTimer !== null) {
    clearTimeout(inFlightAbortTimer);
    inFlightAbortTimer = null;
  }
  inFlightAbort = null;
  inFlightDeadlineMs = 0;
}

/**
 * On-demand refetch of the server-insights snapshot via the bootstrap
 * key-filter endpoint. Used by InsightsPanel when getServerInsights() returns
 * null because the bootstrap hydration cache is empty — typically:
 *   - mobile fast-tier abort on 4G (bootstrap.ts:179 — 1.2 s budget),
 *   - cached value went stale (>MAX_AGE_MS) with no second bootstrap fetch,
 *   - hydration never landed (empty slot),
 *   - hydration drained as stale/invalid (persistent FAST-tier cache is 24h;
 *     the credentialed `?keys=insights` URL is no-store and may still recover).
 *
 * Concurrent callers share one in-flight promise (cleared on settle — not a
 * second result cache). The shared abort follows the longest active caller
 * budget so a 2500 ms Pro preview cannot cut off a later 5000 ms panel
 * recovery. A rejected hydration body is not promoted and is not re-drained;
 * the first fetch still runs so a newer Redis snapshot can land. A settled
 * network/validation failure does not latch; a later caller may retry.
 *
 * Mirrors the AAIISentimentPanel fallback shape (AAIISentimentPanel.ts:147).
 *
 * Returns the validated insights on success, null on any failure (network,
 * timeout, validation). Caches the value module-locally on success so
 * subsequent getServerInsights() calls return it without re-fetching.
 */
export async function fetchServerInsights(timeoutMs = 5_000): Promise<ServerInsights | null> {
  const hydrated = getServerInsights();
  if (hydrated) return hydrated;
  if (inFlight) {
    armInFlightTimeout(timeoutMs);
    return inFlight;
  }

  const controller = new AbortController();
  inFlightAbort = controller;
  inFlightDeadlineMs = 0;
  armInFlightTimeout(timeoutMs);

  inFlight = (async () => {
    try {
      const resp = await fetch(toApiUrl('/api/bootstrap?keys=insights'), {
        signal: controller.signal,
      });
      if (!resp.ok) return null;
      const payload = (await resp.json()) as { data?: { insights?: unknown } };
      const data = validateInsights(payload.data?.insights);
      if (data) cached = data;
      return data;
    } catch {
      return null;
    } finally {
      clearInFlightTimeout();
      inFlight = null;
    }
  })();
  return inFlight;
}

export function setServerInsights(data: ServerInsights): void {
  cached = data;
  rejectedHydration = false;
}

/** Test-only: reset module-local cache so suites can exercise the drain-once behavior. */
export function __resetServerInsightsCacheForTests(): void {
  cached = null;
  abortInFlightRequest();
  inFlight = null;
  clearInFlightTimeout();
  rejectedHydration = false;
}
