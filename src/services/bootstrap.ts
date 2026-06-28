import { getPersistentCache, setPersistentCache } from '@/services/persistent-cache';
import { isDesktopRuntime, toApiUrl } from '@/services/runtime';

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

export function getHydratedData(key: string): unknown | undefined {
  const val = hydrationCache.get(key);
  if (val !== undefined) hydrationCache.delete(key);
  return val;
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

async function fetchTier(
  tier: 'fast' | 'slow',
  signal: AbortSignal,
  shouldCommit: CommitGuard = () => true,
): Promise<BootstrapTierHydrationState> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    const cached = await readCachedTier(tier, true); // age gate skipped: any snapshot beats blank offline
    if (cached) {
      populateCache(cached.data, shouldCommit);
      return { source: 'cached', updatedAt: cached.updatedAt };
    }
    return { ...EMPTY_TIER_STATE };
  }

  let liveData: Record<string, unknown> = {};
  let missingKeys: string[] = [];

  try {
    const resp = await fetch(toApiUrl(`/api/bootstrap?tier=${tier}`), { signal });
    if (resp.ok) {
      const payload = (await resp.json()) as {
        data?: Record<string, unknown>;
        missing?: string[];
      };
      liveData = payload.data ?? {};
      missingKeys = Array.isArray(payload.missing) ? payload.missing : [];
    }
  } catch {
    // Fall through to cached tier.
  }

  if (Object.keys(liveData).length === 0) {
    const cached = await readCachedTier(tier);
    if (cached) {
      populateCache(cached.data, shouldCommit);
      return { source: 'cached', updatedAt: cached.updatedAt };
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
      const slowTimeout = setTimeout(() => slowCtrl.abort(), desktop ? 8_000 : 3_000);

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
  const fastTimeout = setTimeout(() => fastCtrl.abort(), desktop ? 5_000 : 1_200);
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
};
