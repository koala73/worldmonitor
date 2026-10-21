/**
 * Renewable energy data service -- displays World Bank renewable electricity
 * indicator (EG.ELC.RNEW.ZS) for global + regional breakdown.
 *
 * Data is pre-seeded by seed-wb-indicators.mjs on Railway and read
 * from bootstrap/Redis. Never calls WB API from the frontend.
 *
 * EIA installed capacity (solar, wind, coal) still uses the RPC
 * endpoint since it's a different data source (not World Bank).
 */

import { createCircuitBreaker } from '@/utils/circuit-breaker';
import { getHydratedData } from '@/services/bootstrap';
import { toApiUrl } from '@/services/runtime';

// ---- Types ----

export interface RegionRenewableData {
  code: string;       // World Bank region code (e.g., "1W", "EAS")
  name: string;       // Human-readable name (e.g., "World", "East Asia & Pacific")
  percentage: number;  // Latest renewable electricity % value
  year: number;       // Year of latest data point
}

export interface RenewableEnergyData {
  globalPercentage: number;          // Latest global renewable electricity %
  globalYear: number;                // Year of latest global data
  historicalData: Array<{ year: number; value: number }>;  // Global time-series
  regions: RegionRenewableData[];    // Regional breakdown
}

export type RenewableDataState = 'live' | 'cached' | 'unavailable';

export interface RenewableEnergyFetchResult {
  data: RenewableEnergyData | null;
  state: RenewableDataState;
  cachedAt: number | null;
}

interface RenewableEnergySnapshot {
  data: RenewableEnergyData;
  cachedAt: number;
}

export const RENEWABLE_DATA_STALE_CEILING_MS = 7 * 24 * 60 * 60 * 1000;
export const RENEWABLE_DATA_CACHE_KEY = 'world-bank-v2';

export interface RenewableEnergyServiceOptions {
  breakerName?: string;
  cacheKey?: string;
  persistCache?: boolean;
  getHydrated?: () => unknown;
  fetchImpl?: typeof globalThis.fetch;
}

function isPercentage(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function isObservationYear(value: unknown): value is number {
  return Number.isInteger(value)
    && (value as number) >= 1900
    && (value as number) <= new Date().getUTCFullYear() + 1;
}

export function isRenewableEnergyData(value: unknown): value is RenewableEnergyData {
  if (typeof value !== 'object' || value === null) return false;
  const data = value as Partial<RenewableEnergyData>;

  if (!isPercentage(data.globalPercentage) || !isObservationYear(data.globalYear)) return false;
  if (!Array.isArray(data.historicalData) || data.historicalData.length === 0) return false;
  if (!data.historicalData.every(point =>
    typeof point === 'object'
    && point !== null
    && isObservationYear(point.year)
    && isPercentage(point.value)
  )) return false;
  if (!Array.isArray(data.regions)) return false;

  return data.regions.every(region =>
    typeof region === 'object'
    && region !== null
    && typeof region.code === 'string'
    && region.code.length > 0
    && typeof region.name === 'string'
    && region.name.length > 0
    && isPercentage(region.percentage)
    && isObservationYear(region.year)
  );
}

function isRenewableEnergySnapshot(value: unknown): value is RenewableEnergySnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const snapshot = value as Partial<RenewableEnergySnapshot>;
  return isRenewableEnergyData(snapshot.data)
    && typeof snapshot.cachedAt === 'number'
    && Number.isFinite(snapshot.cachedAt)
    && snapshot.cachedAt > 0;
}

const capacityBreaker = createCircuitBreaker<CapacitySeries[]>({
  name: 'Energy Capacity',
  cacheTtlMs: 60 * 60 * 1000,
  persistCache: true,
});

// ---- Data Fetching (from Railway seed via bootstrap) ----

export function createRenewableEnergyService(options: RenewableEnergyServiceOptions = {}) {
  const breaker = createCircuitBreaker<RenewableEnergySnapshot | null>({
    name: options.breakerName ?? 'Renewable Energy',
    cacheTtlMs: 60 * 60 * 1000, // 1h — World Bank data changes yearly
    persistCache: options.persistCache ?? true,
    // Match the weekly seed-health contract. Older observations remain visible
    // in the payload's `globalYear`; this ceiling bounds retrieval staleness.
    persistentStaleCeilingMs: RENEWABLE_DATA_STALE_CEILING_MS,
  });
  const cacheKey = options.cacheKey ?? RENEWABLE_DATA_CACHE_KEY;
  const getHydrated = options.getHydrated ?? (() => getHydratedData('renewableEnergy'));
  const fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));

  async function fetchFresh(): Promise<RenewableEnergyData> {
    // 1. Try bootstrap hydration cache (first page load)
    const hydrated = getHydrated();
    if (isRenewableEnergyData(hydrated)) return hydrated;

    // 2. Fetch from the canonical bootstrap endpoint directly.
    try {
      const resp = await fetchImpl(toApiUrl('/api/bootstrap?keys=renewableEnergy'), {
        signal: AbortSignal.timeout(5_000),
      });
      if (resp.ok) {
        const payload = (await resp.json()) as { data?: { renewableEnergy?: unknown } };
        if (isRenewableEnergyData(payload.data?.renewableEnergy)) {
          return payload.data.renewableEnergy;
        }
      }
    } catch { /* fall through */ }

    // Throw so the breaker can preserve a validated last-known-good entry.
    // Without one, execute() returns null and the panel fails closed.
    throw new Error('Renewable energy data unavailable');
  }

  async function fetchData(): Promise<RenewableEnergyFetchResult> {
    let freshSnapshot: RenewableEnergySnapshot | null = null;
    const snapshot = await breaker.execute<RenewableEnergySnapshot | null>(
      async () => {
        freshSnapshot = {
          data: await fetchFresh(),
          cachedAt: Date.now(),
        };
        return freshSnapshot;
      },
      null,
      {
        // The versioned key prevents pre-fix entries—which may contain the old
        // hardcoded snapshot—from being mistaken for canonical observations.
        cacheKey,
        shouldCache: isRenewableEnergySnapshot,
      },
    );
    if (
      snapshot === null
      || Date.now() - snapshot.cachedAt > RENEWABLE_DATA_STALE_CEILING_MS
    ) {
      return {
        data: null,
        state: 'unavailable',
        cachedAt: null,
      };
    }

    // Object identity keeps classification atomic even when stale-while-
    // revalidate completes between execute() and this continuation.
    const state: RenewableDataState = snapshot === freshSnapshot ? 'live' : 'cached';

    return {
      data: snapshot.data,
      state,
      cachedAt: state === 'cached' ? snapshot.cachedAt : null,
    };
  }

  return {
    fetchFresh,
    fetch: fetchData,
  };
}

const renewableEnergyService = createRenewableEnergyService();

export async function fetchRenewableEnergyDataFresh(): Promise<RenewableEnergyData> {
  return renewableEnergyService.fetchFresh();
}

/**
 * Fetch renewable energy data with bounded persistent last-known-good caching.
 */
export async function fetchRenewableEnergyData(): Promise<RenewableEnergyFetchResult> {
  return renewableEnergyService.fetch();
}

// ========================================================================
// EIA Installed Capacity (solar, wind, coal)
// ========================================================================

export interface CapacityDataPoint {
  year: number;
  capacityMw: number;
}

export interface CapacitySeries {
  source: string;   // 'SUN', 'WND', 'COL'
  name: string;     // 'Solar', 'Wind', 'Coal'
  data: CapacityDataPoint[];
}

/**
 * Fetch installed generation capacity for solar, wind, and coal from EIA.
 * Returns typed CapacitySeries[] ready for panel rendering.
 * Gracefully degrades: on failure returns empty array.
 */
export async function fetchEnergyCapacity(): Promise<CapacitySeries[]> {
  return capacityBreaker.execute(async () => {
    const { fetchEnergyCapacityRpc } = await import('@/services/economic');
    const resp = await fetchEnergyCapacityRpc(['SUN', 'WND', 'COL'], 25);
    return resp.series.map(s => ({
      source: s.energySource,
      name: s.name,
      data: s.data.map(d => ({ year: d.year, capacityMw: d.capacityMw })),
    }));
  }, []);
}
