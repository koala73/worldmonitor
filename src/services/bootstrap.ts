import { getPersistentCache, setPersistentCache } from '@/services/persistent-cache';
import { isDesktopRuntime, toApiUrl } from '@/services/runtime';
import {
  buildBootstrapTransferRumSample,
  readBootstrapEncodedBodySize,
  selectBootstrapTransferRumTier,
  utf8TextBytes,
  type BootstrapTransferRumOutcome,
  type BootstrapTransferRumSample,
  type BootstrapTransferRumTier,
} from '@/bootstrap/bootstrap-transfer-rum';
import { isDebugBearRumActive, reportBootstrapTransferRum } from '@/bootstrap/debugbear-rum';
import { getWebVitalsFormFactor } from '@/bootstrap/web-vitals-utils';
import { bootstrapTierKeyNames } from '../../shared/bootstrap-tier-keys.js';

const hydrationCache = new Map<string, unknown>();
const BOOTSTRAP_CACHE_PREFIX = 'bootstrap:tier:';
const BOOTSTRAP_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
type CommitGuard = () => boolean;

export type BootstrapDataSource = 'live' | 'cached' | 'mixed' | 'none';

export interface BootstrapTierHydrationState {
  source: BootstrapDataSource;
  updatedAt: number | null;
}

export interface BootstrapHydrationState {
  source: BootstrapDataSource;
  tiers: {
    fast: BootstrapTierHydrationState;
    slow: BootstrapTierHydrationState;
  };
}

const EMPTY_TIER_STATE: BootstrapTierHydrationState = { source: 'none', updatedAt: null };

/**
 * Abort budgets per tier and runtime. Named and exported so the budget is
 * assertable directly — it was previously pinned by regex-scanning this file
 * for bare numeric literals, which matched any number in the module.
 *
 * The web numbers are load-bearing: the fast tier sits on the first-paint
 * critical path, and the slow tier was raised 1.8s → 3.0s to stop a hydration
 * cascade where aborted tier fetches left panels in empty-state. Desktop gets
 * longer budgets for different network and dependency-loading constraints.
 * Do not move these without RUM / Sentry evidence.
 */
export const BOOTSTRAP_TIER_TIMEOUT_MS = {
  web: { fast: 1_200, slow: 3_000 },
  desktop: { fast: 5_000, slow: 8_000 },
} as const;

let lastHydrationState: BootstrapHydrationState = {
  source: 'none',
  tiers: {
    fast: { ...EMPTY_TIER_STATE },
    slow: { ...EMPTY_TIER_STATE },
  },
};
let bootstrapGeneration = 0;
let activeSlowCtrl: AbortController | null = null;
let slowTierSettled: Promise<void> | null = null;
let bootstrapTransferRumTier: BootstrapTransferRumTier | null = null;
let bootstrapTransferRumReported = false;
let bootstrapTransferRumReporter = reportBootstrapTransferRum;
let bootstrapTransferRumEnabled = isDebugBearRumActive;
let encodedBodySizeResolver = readBootstrapEncodedBodySize;

function selectedBootstrapTransferRumTier(): BootstrapTransferRumTier {
  bootstrapTransferRumTier ??= selectBootstrapTransferRumTier();
  return bootstrapTransferRumTier;
}

function maybeReportBootstrapTransferRum(
  tier: BootstrapTransferRumTier,
  outcome: BootstrapTransferRumOutcome,
  startedAt: number,
  decodedBytes = -1,
  encodedBytes = -1,
  shouldCommit: CommitGuard,
): void {
  if (
    !shouldCommit()
    || bootstrapTransferRumReported
    || !bootstrapTransferRumEnabled()
    || selectedBootstrapTransferRumTier() !== tier
  ) return;
  const result = buildBootstrapTransferRumSample({
    tier,
    outcome,
    durationMs: Math.max(0, performance.now() - startedAt),
    decodedBytes,
    encodedBytes,
    deviceClass: getWebVitalsFormFactor(),
  });
  if (!result.accepted) return;
  bootstrapTransferRumReported = true;
  try {
    bootstrapTransferRumReporter(result.sample);
  } catch {
    // Telemetry must never affect bootstrap hydration or recovery.
  }
}

function shouldMeasureBootstrapTransferRum(
  tier: BootstrapTransferRumTier,
  shouldCommit: CommitGuard,
): boolean {
  return shouldCommit()
    && !bootstrapTransferRumReported
    && bootstrapTransferRumEnabled()
    && selectedBootstrapTransferRumTier() === tier;
}

export function getHydratedData(key: string): unknown | undefined {
  const val = hydrationCache.get(key);
  if (val !== undefined) hydrationCache.delete(key);
  return val;
}

// In-flight coalescing for on-demand keys: a panel and a map layer can both ask
// for the same key in the same tick, and we want one request, not two.
const onDemandInflight = new Map<string, Promise<unknown | undefined>>();

// The on-demand keys `/api/bootstrap?keys=<name>&public=1` will serve without
// credentials. The ON-DEMAND PORTION cannot drift: this set, the server's
// allowlist (ON_DEMAND_KEYS, api/bootstrap.js) and the wm-session interceptor's
// bypass set (PUBLIC_SINGLE_KEY_BOOTSTRAP_KEYS, wm-session.ts) all derive it
// from the same `bootstrapTierKeyNames('on-demand')` call.
//
// The other two additionally accept PUBLIC_WEATHER_BOOTSTRAP_KEY on that URL
// shape (#5386), so they are supersets of this one — that difference is
// intentional, not drift. weatherAlerts rides the fast tier, so ensureHydrated's
// tier-hydration path already covers it and its direct reader is
// src/services/weather.ts; adding it here would only enable a fetch no caller
// makes.
const PUBLIC_ON_DEMAND_BOOTSTRAP_KEYS = new Set(bootstrapTierKeyNames('on-demand'));

/**
 * Hydration for keys that ride in NEITHER bootstrap tier (#5300).
 *
 * Returns the tier-hydrated value if one is present (so a key promoted back into
 * a tier keeps working unchanged), otherwise fetches it through its own
 * CDN-shielded public URL — `?keys=<name>&public=1`, one key per URL, one CDN
 * entry per key.
 *
 * This must NOT fall back to the domain RPC: the RPC reads the same Redis key
 * with no CDN in front of it, so routing misses there would relocate the egress
 * rather than remove it — the trap that made #5263's RPC work a no-op until
 * #5287. Callers keep their existing RPC fallback for the failure case; this
 * simply gives them a cached path to try first.
 */
export async function ensureHydrated(key: string): Promise<unknown | undefined> {
  const hydrated = getHydratedData(key);
  if (hydrated !== undefined) return hydrated;

  // The public URL below only serves keys in the on-demand tier
  // (isPublicOnDemandBootstrapRequest, api/bootstrap.js); anything else falls
  // through to validateApiKey, which sees no credential — this request omits
  // them — and answers 401. Issuing it anyway is not merely wasted: the
  // wm-session interceptor waves through credential-less bootstrap reads only
  // for keys on the public single-key URL shape (PUBLIC_SINGLE_KEY_BOOTSTRAP_KEYS,
  // wm-session.ts), so
  // a non-on-demand key enters session recovery, which mints a fresh cookie and
  // replays a request that still omits credentials, draws the same 401, and
  // reports `wm_session_route_401` — blaming the anonymous session for a
  // request that never presented one. That was 100% of WORLDMONITOR-XP
  // (~125/hr, all route `/api/bootstrap`), via the `slow`-tier key
  // `crossStraitActivity`. Callers already treat undefined as "use your own
  // fallback", which is exactly what the 401 produced.
  if (!PUBLIC_ON_DEMAND_BOOTSTRAP_KEYS.has(key)) return undefined;

  const existing = onDemandInflight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const resp = await fetch(
        toApiUrl(`/api/bootstrap?keys=${encodeURIComponent(key)}&public=1`),
        { credentials: 'omit', signal: AbortSignal.timeout(10_000) },
      );
      if (!resp.ok) return undefined;
      const payload = (await resp.json()) as { data?: Record<string, unknown> };
      return payload.data?.[key];
    } catch {
      return undefined;
    } finally {
      onDemandInflight.delete(key);
    }
  })();

  onDemandInflight.set(key, promise);
  return promise;
}

export function markBootstrapAsLive(): void {
  if (lastHydrationState.source === 'cached' || lastHydrationState.source === 'mixed') {
    const now = Date.now();
    lastHydrationState = {
      source: 'live',
      tiers: {
        fast: lastHydrationState.tiers.fast.source !== 'none'
          ? { source: 'live', updatedAt: now }
          : { ...lastHydrationState.tiers.fast },
        slow: lastHydrationState.tiers.slow.source !== 'none'
          ? { source: 'live', updatedAt: now }
          : { ...lastHydrationState.tiers.slow },
      },
    };
  }
}

export function getBootstrapHydrationState(): BootstrapHydrationState {
  return {
    source: lastHydrationState.source,
    tiers: {
      fast: { ...lastHydrationState.tiers.fast },
      slow: { ...lastHydrationState.tiers.slow },
    },
  };
}

function populateCache(data: Record<string, unknown>, shouldCommit: CommitGuard): void {
  if (!shouldCommit()) return;
  for (const [k, v] of Object.entries(data)) {
    if (v !== null && v !== undefined) {
      hydrationCache.set(k, v);
    }
  }
}

function getTierCacheKey(tier: 'fast' | 'slow'): string {
  return `${BOOTSTRAP_CACHE_PREFIX}${tier}`;
}

async function readCachedTier(tier: 'fast' | 'slow', allowStale = false): Promise<{ data: Record<string, unknown>; updatedAt: number } | null> {
  try {
    const cached = await getPersistentCache<Record<string, unknown>>(getTierCacheKey(tier));
    if (!cached?.data || Object.keys(cached.data).length === 0) return null;
    if (!allowStale && Date.now() - cached.updatedAt > BOOTSTRAP_CACHE_MAX_AGE_MS) return null;
    return { data: cached.data, updatedAt: cached.updatedAt };
  } catch {
    return null;
  }
}

function combineHydrationSources(states: BootstrapTierHydrationState[]): BootstrapDataSource {
  const nonEmpty = states.filter((state) => state.source !== 'none');
  if (nonEmpty.length === 0) return 'none';
  if (nonEmpty.every((state) => state.source === 'live')) return 'live';
  if (nonEmpty.every((state) => state.source === 'cached')) return 'cached';
  return 'mixed';
}

interface BootstrapTierPayload {
  data: Record<string, unknown>;
  missing: string[];
}

function validateBootstrapTierPayload(payload: unknown): BootstrapTierPayload | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const data = (payload as { data?: unknown }).data;
  const missing = (payload as { missing?: unknown }).missing;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (!Array.isArray(missing) || !missing.every((key) => typeof key === 'string')) return null;
  return { data: data as Record<string, unknown>, missing };
}

function parseBootstrapTierPayload(text: string): BootstrapTierPayload | null {
  try {
    return validateBootstrapTierPayload(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

function isAbortFailure(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted
    || (error != null
      && typeof error === 'object'
      && 'name' in error
      && error.name === 'AbortError');
}

async function fetchTier(
  tier: 'fast' | 'slow',
  signal: AbortSignal,
  shouldCommit: CommitGuard = () => true,
): Promise<BootstrapTierHydrationState> {
  const requestStartedAt = performance.now();
  const requestUrl = toApiUrl(`/api/bootstrap?tier=${tier}&public=1`);
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    const cached = await readCachedTier(tier, true); // age gate skipped: any snapshot beats blank offline
    if (cached) {
      populateCache(cached.data, shouldCommit);
      maybeReportBootstrapTransferRum(
        tier,
        'cached-fallback',
        requestStartedAt,
        -1,
        -1,
        shouldCommit,
      );
      return { source: 'cached', updatedAt: cached.updatedAt };
    }
    maybeReportBootstrapTransferRum(
      tier,
      'network-error',
      requestStartedAt,
      -1,
      -1,
      shouldCommit,
    );
    return { ...EMPTY_TIER_STATE };
  }

  let liveData: Record<string, unknown> = {};
  let missingKeys: string[] = [];
  let completedResponse = false;
  let failedOutcome: Exclude<BootstrapTransferRumOutcome, 'complete' | 'cached-fallback'> | null = null;

  try {
    // public=1 gives the shared seed bundle a cache key distinct from the legacy
    // credentialed tier URL. credentials:'omit' also avoids sending cookies to
    // a route whose contract is explicitly public (see #5249).
    const resp = await fetch(requestUrl, { signal, credentials: 'omit' });
    if (!resp.ok) {
      failedOutcome = 'http-error';
    } else {
      try {
        const readTransferBody = shouldMeasureBootstrapTransferRum(tier, shouldCommit);
        const responseText = readTransferBody ? await resp.text() : null;
        const measureTransfer = responseText !== null
          && shouldMeasureBootstrapTransferRum(tier, shouldCommit);
        const decodedBytes = measureTransfer && responseText !== null ? utf8TextBytes(responseText) : -1;
        const payload = responseText === null
          ? validateBootstrapTierPayload(await resp.json() as unknown)
          : parseBootstrapTierPayload(responseText);
        if (!payload) {
          failedOutcome = 'parse-error';
        } else {
          completedResponse = true;
          liveData = payload.data;
          missingKeys = payload.missing;
          maybeReportBootstrapTransferRum(
            tier,
            'complete',
            requestStartedAt,
            decodedBytes,
            measureTransfer ? encodedBodySizeResolver(requestUrl, decodedBytes) : -1,
            shouldCommit,
          );
        }
      } catch (error) {
        failedOutcome = isAbortFailure(error, signal) ? 'abort' : 'network-error';
      }
    }
  } catch (error) {
    failedOutcome = isAbortFailure(error, signal) ? 'abort' : 'network-error';
    // Fall through to cached tier.
  }

  if (Object.keys(liveData).length === 0) {
    const cached = await readCachedTier(tier);
    if (cached) {
      populateCache(cached.data, shouldCommit);
      if (!completedResponse) {
        maybeReportBootstrapTransferRum(
          tier,
          'cached-fallback',
          requestStartedAt,
          -1,
          -1,
          shouldCommit,
        );
      }
      return { source: 'cached', updatedAt: cached.updatedAt };
    }
    if (!completedResponse) {
      maybeReportBootstrapTransferRum(
        tier,
        failedOutcome ?? 'network-error',
        requestStartedAt,
        -1,
        -1,
        shouldCommit,
      );
    }
    return { ...EMPTY_TIER_STATE };
  }

  const mergedData = { ...liveData };
  let tierState: BootstrapTierHydrationState = { source: 'live', updatedAt: null };
  let saveUpdatedAt: number | undefined;

  if (missingKeys.length > 0) {
    const cached = await readCachedTier(tier);
    if (cached) {
      let filledAny = false;
      for (const key of missingKeys) {
        if (!(key in mergedData) && cached.data[key] !== undefined) {
          mergedData[key] = cached.data[key];
          filledAny = true;
        }
      }
      if (filledAny) {
        tierState = { source: 'mixed', updatedAt: Date.now() };
      }
    }
  }

  populateCache(mergedData, shouldCommit);
  if (shouldCommit()) {
    void setPersistentCache(getTierCacheKey(tier), mergedData, saveUpdatedAt).catch(() => {});
  }
  return tierState;
}

function scheduleAfterNextPaint(fn: () => void): () => void {
  let cancelled = false;
  let started = false;
  let rafId: number | null = null;
  let postPaintTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let fallbackTimeoutId: ReturnType<typeof setTimeout> | null = null;
  const run = (): void => {
    if (cancelled || started) return;
    started = true;
    if (rafId !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    if (postPaintTimeoutId !== null) clearTimeout(postPaintTimeoutId);
    if (fallbackTimeoutId !== null) clearTimeout(fallbackTimeoutId);
    fn();
  };

  if (typeof requestAnimationFrame === 'function') {
    rafId = requestAnimationFrame(() => {
      postPaintTimeoutId = setTimeout(run, 0);
    });
    fallbackTimeoutId = setTimeout(run, 250);
    return () => {
      cancelled = true;
      if (rafId !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
      if (postPaintTimeoutId !== null) clearTimeout(postPaintTimeoutId);
      if (fallbackTimeoutId !== null) clearTimeout(fallbackTimeoutId);
    };
  }

  postPaintTimeoutId = setTimeout(run, 0);
  return () => {
    cancelled = true;
    if (postPaintTimeoutId !== null) clearTimeout(postPaintTimeoutId);
  };
}

function scheduleSlowTierFetch(generation: number, onSlowSettled?: () => void): Promise<void> {
  const desktop = isDesktopRuntime();
  const isCurrentGeneration = (): boolean => generation === bootstrapGeneration;

  return new Promise<void>((resolve) => {
    const cancelScheduledStart = scheduleAfterNextPaint(() => {
      if (!isCurrentGeneration()) {
        resolve();
        return;
      }

      const slowCtrl = new AbortController();
      activeSlowCtrl = slowCtrl;
      const slowTimeout = setTimeout(
        () => slowCtrl.abort(),
        desktop ? BOOTSTRAP_TIER_TIMEOUT_MS.desktop.slow : BOOTSTRAP_TIER_TIMEOUT_MS.web.slow,
      );

      void fetchTier('slow', slowCtrl.signal, isCurrentGeneration)
        .then((slowState) => {
          if (!isCurrentGeneration()) return;
          lastHydrationState = {
            source: combineHydrationSources([lastHydrationState.tiers.fast, slowState]),
            tiers: { fast: lastHydrationState.tiers.fast, slow: slowState },
          };
        })
        .catch(() => {
          // Background failure: leave the slow keys un-hydrated; consumers refetch on demand.
        })
        .finally(() => {
          clearTimeout(slowTimeout);
          if (activeSlowCtrl === slowCtrl) activeSlowCtrl = null;
          if (isCurrentGeneration()) onSlowSettled?.();
          resolve();
        });
    });

    if (!isCurrentGeneration()) {
      cancelScheduledStart();
      resolve();
    }
  });
}

export async function waitForBootstrapSlowTier(timeoutMs = 0): Promise<boolean> {
  const pending = slowTierSettled;
  if (!pending) return true;
  if (timeoutMs <= 0) {
    await pending;
    return true;
  }

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timedOut = Symbol('timedOut');
  const result = await Promise.race([
    pending.then(() => true),
    new Promise<typeof timedOut>((resolve) => {
      timeoutId = setTimeout(() => resolve(timedOut), timeoutMs);
    }),
  ]);
  if (timeoutId !== null) clearTimeout(timeoutId);
  return result !== timedOut;
}

export function cancelBootstrapSlowTier(): void {
  bootstrapGeneration += 1;
  activeSlowCtrl?.abort();
  activeSlowCtrl = null;
  slowTierSettled = null;
}

/**
 * Hydrate the in-memory cache from the bootstrap endpoint.
 *
 * The boot awaits ONLY the small fast tier, commits that state, then schedules the
 * ~410 KB slow tier after the next paint (#4488). A later app checkpoint can wait for
 * the slow tier before visible slow-key consumers start fallback RPCs, but the payload
 * stays off the first-paint critical path.
 *
 * `onSlowSettled` lets the caller (App.ts) re-snapshot the hydration state and refresh
 * the connectivity indicator when the background slow tier lands — `getBootstrapHydrationState`
 * is read via a one-shot snapshot, with no reactive emitter, so a passive update is invisible.
 */
export async function fetchBootstrapData(onSlowSettled?: () => void): Promise<void> {
  const generation = ++bootstrapGeneration;
  const isCurrentGeneration = (): boolean => generation === bootstrapGeneration;

  activeSlowCtrl?.abort();
  activeSlowCtrl = null;
  slowTierSettled = null;
  hydrationCache.clear();
  lastHydrationState = {
    source: 'none',
    tiers: {
      fast: { ...EMPTY_TIER_STATE },
      slow: { ...EMPTY_TIER_STATE },
    },
  };

  const fastCtrl = new AbortController();
  const desktop = isDesktopRuntime();
  // Tier abort budgets:
  // - Fast tier (~10 keys, small payload) keeps an aggressive 1.2 s browser cap; it already meets that budget.
  // - Slow tier carries ~70 bootstrap keys (~500 KB). The previous 1.8 s browser cap was below realistic p95
  //   from a cold CF cache, so it aborted on slow connections. That left the hydration cache empty for those
  //   keys, and downstream per-panel lazy fetches each got a doomed 5 s shot — half of which timed out under
  //   the same conditions, leaving panels stuck in empty-state.
  // - 3.0 s is a conservative bump to avoid that cascade. Further tuning should be driven by RUM / Sentry
  //   data once available; do not move this without evidence.
  // - Desktop budgets (5 s / 8 s) are unchanged — different network and dependency-loading constraints.
  const fastTimeout = setTimeout(
    () => fastCtrl.abort(),
    desktop ? BOOTSTRAP_TIER_TIMEOUT_MS.desktop.fast : BOOTSTRAP_TIER_TIMEOUT_MS.web.fast,
  );
  try {
    const fastState = await fetchTier('fast', fastCtrl.signal, isCurrentGeneration);
    if (!isCurrentGeneration()) return;
    lastHydrationState = {
      source: combineHydrationSources([fastState, lastHydrationState.tiers.slow]),
      tiers: { fast: fastState, slow: lastHydrationState.tiers.slow },
    };
  } finally {
    clearTimeout(fastTimeout);
  }

  if (!isCurrentGeneration()) return;
  slowTierSettled = scheduleSlowTierFetch(generation, onSlowSettled);
}

export const __testing__ = {
  resetBootstrapForTests(): void {
    cancelBootstrapSlowTier();
    hydrationCache.clear();
    bootstrapTransferRumTier = null;
    bootstrapTransferRumReported = false;
    bootstrapTransferRumReporter = reportBootstrapTransferRum;
    bootstrapTransferRumEnabled = isDebugBearRumActive;
    encodedBodySizeResolver = readBootstrapEncodedBodySize;
    lastHydrationState = {
      source: 'none',
      tiers: {
        fast: { ...EMPTY_TIER_STATE },
        slow: { ...EMPTY_TIER_STATE },
      },
    };
  },
  getBootstrapGeneration(): number {
    return bootstrapGeneration;
  },
  setBootstrapTransferRumTierForTests(tier: BootstrapTransferRumTier): void {
    bootstrapTransferRumTier = tier;
  },
  setBootstrapTransferRumReporterForTests(
    reporter: (sample: BootstrapTransferRumSample) => void,
  ): void {
    bootstrapTransferRumReporter = reporter;
  },
  setBootstrapTransferRumEnabledForTests(enabled: boolean): void {
    bootstrapTransferRumEnabled = () => enabled;
  },
  setEncodedBodySizeResolverForTests(
    resolver: (resourceUrl: string, decodedBytes: number) => number,
  ): void {
    encodedBodySizeResolver = resolver;
  },
};
