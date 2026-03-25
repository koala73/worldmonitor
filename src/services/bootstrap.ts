import { getPersistentCache, setPersistentCache } from '@/services/persistent-cache';
import { isDesktopRuntime, toApiUrl } from '@/services/runtime';

const hydrationCache = new Map<string, unknown>();
const BOOTSTRAP_CACHE_PREFIX = 'bootstrap:tier:';
const BOOTSTRAP_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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

function populateCache(data: Record<string, unknown>): void {
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

async function fetchTier(tier: 'fast' | 'slow', signal: AbortSignal): Promise<BootstrapTierHydrationState> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    const cached = await readCachedTier(tier, true); // age gate skipped: any snapshot beats blank offline
    if (cached) {
      populateCache(cached.data);
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
      populateCache(cached.data);
      return { source: 'cached', updatedAt: cached.updatedAt };
    }
    return { ...EMPTY_TIER_STATE };
  }

  let mergedData = { ...liveData };
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

  populateCache(mergedData);
  void setPersistentCache(getTierCacheKey(tier), mergedData, saveUpdatedAt).catch(() => {});
  return tierState;
}

export async function fetchBootstrapData(): Promise<void> {
  hydrationCache.clear();
  lastHydrationState = {
    source: 'none',
    tiers: {
      fast: { ...EMPTY_TIER_STATE },
      slow: { ...EMPTY_TIER_STATE },
    },
  };

  const fastCtrl = new AbortController();
  const slowCtrl = new AbortController();
  const desktop = isDesktopRuntime();
  const fastTimeout = setTimeout(() => fastCtrl.abort(), desktop ? 5_000 : 1_200);
  const slowTimeout = setTimeout(() => slowCtrl.abort(), desktop ? 8_000 : 1_800);

  try {
    const [slowState, fastState] = await Promise.all([
      fetchTier('slow', slowCtrl.signal),
      fetchTier('fast', fastCtrl.signal),
    ]);

    lastHydrationState = {
      source: combineHydrationSources([fastState, slowState]),
      tiers: {
        fast: fastState,
        slow: slowState,
      },
    };
  } finally {
    clearTimeout(fastTimeout);
    clearTimeout(slowTimeout);
  }
}
