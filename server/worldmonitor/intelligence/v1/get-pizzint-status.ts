import type {
  ServerContext,
  GetPizzintStatusRequest,
  GetPizzintStatusResponse,
  PizzintStatus,
  PizzintLocation,
  GdeltTensionPair,
  TrendDirection,
  DataFreshness,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { UPSTREAM_TIMEOUT_MS } from './_shared';
import { CHROME_UA } from '../../../_shared/constants';
import { getCachedJson, setCachedJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'intel:pizzint:v1';
const REDIS_CACHE_TTL = 600; // 10 min

// ========================================================================
// Constants
// ========================================================================

const PIZZINT_API = 'https://www.pizzint.watch/api/dashboard-data';
const GDELT_BATCH_API = 'https://www.pizzint.watch/api/gdelt/batch';
const DEFAULT_GDELT_PAIRS = 'usa_russia,russia_ukraine,usa_china,china_taiwan,usa_iran,usa_venezuela';

// ========================================================================
// RPC handler
// ========================================================================

export async function getPizzintStatus(
  _ctx: ServerContext,
  req: GetPizzintStatusRequest,
): Promise<GetPizzintStatusResponse> {
  // Redis shared cache
  const cacheKey = `${REDIS_CACHE_KEY}:${req.includeGdelt ? 'gdelt' : 'base'}`;
  const cached = (await getCachedJson(cacheKey)) as GetPizzintStatusResponse | null;
  if (cached?.pizzint) return cached;

  let pizzint: PizzintStatus | undefined;
  try {
    const resp = await fetch(PIZZINT_API, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`PizzINT API returned ${resp.status}`);

    const raw = (await resp.json()) as {
      success?: boolean;
      data?: Array<{
        place_id: string;
        name: string;
        address: string;
        current_popularity: number;
        percentage_of_usual: number | null;
        is_spike: boolean;
        spike_magnitude: number | null;
        data_source: string;
        recorded_at: string;
        data_freshness: string;
        is_closed_now?: boolean;
        lat?: number;
        lng?: number;
      }>;
    };
    if (raw.success && raw.data) {
        const locations: PizzintLocation[] = raw.data.map((d) => ({
          placeId: d.place_id,
          name: d.name,
          address: d.address,
          currentPopularity: d.current_popularity,
          percentageOfUsual: d.percentage_of_usual ?? 0,
          isSpike: d.is_spike,
          spikeMagnitude: d.spike_magnitude ?? 0,
          dataSource: d.data_source,
          recordedAt: d.recorded_at,
          dataFreshness: (d.data_freshness === 'fresh' ? 'DATA_FRESHNESS_FRESH' : 'DATA_FRESHNESS_STALE') as DataFreshness,
          isClosedNow: d.is_closed_now ?? false,
          lat: d.lat ?? 0,
          lng: d.lng ?? 0,
        }));

        const openLocations = locations.filter((l) => !l.isClosedNow);
        const activeSpikes = locations.filter((l) => l.isSpike).length;
        const avgPop = openLocations.length > 0
          ? openLocations.reduce((s, l) => s + l.currentPopularity, 0) / openLocations.length
          : 0;

        // DEFCON calculation
        let adjusted = avgPop;
        if (activeSpikes > 0) adjusted += activeSpikes * 10;
        adjusted = Math.min(100, adjusted);
        let defconLevel = 5;
        let defconLabel = 'Normal Activity';
        if (adjusted >= 85) { defconLevel = 1; defconLabel = 'Maximum Activity'; }
        else if (adjusted >= 70) { defconLevel = 2; defconLabel = 'High Activity'; }
        else if (adjusted >= 50) { defconLevel = 3; defconLabel = 'Elevated Activity'; }
        else if (adjusted >= 25) { defconLevel = 4; defconLabel = 'Above Normal'; }

        const hasFresh = locations.some((l) => l.dataFreshness === 'DATA_FRESHNESS_FRESH');

        pizzint = {
          defconLevel,
          defconLabel,
          aggregateActivity: Math.round(avgPop),
          activeSpikes,
          locationsMonitored: locations.length,
          locationsOpen: openLocations.length,
          updatedAt: Date.now(),
          dataFreshness: (hasFresh ? 'DATA_FRESHNESS_FRESH' : 'DATA_FRESHNESS_STALE') as DataFreshness,
          locations,
        };
      }
    } catch (_) { /* PizzINT unavailable — continue to GDELT */ }

  // Fetch GDELT tension pairs
  let tensionPairs: GdeltTensionPair[] = [];
  if (req.includeGdelt) {
    try {
      const url = `${GDELT_BATCH_API}?pairs=${encodeURIComponent(DEFAULT_GDELT_PAIRS)}&method=gpr`;
      const resp = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (resp.ok) {
        const raw = (await resp.json()) as Record<string, Array<{ t: number; v: number }>>;
        tensionPairs = Object.entries(raw).map(([pairKey, dataPoints]) => {
          const countries = pairKey.split('_');
          const latest = dataPoints[dataPoints.length - 1]!;
          const prev = dataPoints.length > 1 ? dataPoints[dataPoints.length - 2]! : latest;
          const change = prev.v > 0 ? ((latest.v - prev.v) / prev.v) * 100 : 0;
          const trend: TrendDirection = change > 5
            ? 'TREND_DIRECTION_RISING'
            : change < -5
              ? 'TREND_DIRECTION_FALLING'
              : 'TREND_DIRECTION_STABLE';

          return {
            id: pairKey,
            countries,
            label: countries.map((c) => c.toUpperCase()).join(' - '),
            score: latest?.v ?? 0,
            trend,
            changePercent: Math.round(change * 10) / 10,
            region: 'global',
          };
        });
      }
    } catch { /* gdelt unavailable */ }
  }

  const result: GetPizzintStatusResponse = { pizzint, tensionPairs };
  if (pizzint) {
    setCachedJson(cacheKey, result, REDIS_CACHE_TTL).catch(() => {});
  }
  return result;
}
