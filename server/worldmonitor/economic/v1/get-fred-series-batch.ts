import type {
  ServerContext,
  GetFredSeriesBatchRequest,
  GetFredSeriesBatchResponse,
  FredSeries,
  FredObservation,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getCachedJsonBatch, cachedFetchJson } from '../../../_shared/redis';
import { toUniqueSortedLimited } from '../../../_shared/normalize-list';

const FRED_API_BASE = 'https://api.stlouisfed.org/fred';
const REDIS_CACHE_KEY = 'economic:fred:v1';
const REDIS_CACHE_TTL = 3600;

const ALLOWED_SERIES = new Set([
  'WALCL', 'FEDFUNDS', 'T10Y2Y', 'UNRATE', 'CPIAUCSL', 'DGS10', 'VIXCLS',
  'GDP', 'M2SL', 'DCOILWTICO',
]);

async function fetchSingleFred(seriesId: string, limit: number): Promise<FredSeries | undefined> {
  try {
    const apiKey = process.env.FRED_API_KEY;
    if (!apiKey) return undefined;

    const obsParams = new URLSearchParams({
      series_id: seriesId, api_key: apiKey, file_type: 'json', sort_order: 'desc', limit: String(limit),
    });
    const metaParams = new URLSearchParams({
      series_id: seriesId, api_key: apiKey, file_type: 'json',
    });

    const [obsResult, metaResult] = await Promise.allSettled([
      fetch(`${FRED_API_BASE}/series/observations?${obsParams}`, {
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000),
      }),
      fetch(`${FRED_API_BASE}/series?${metaParams}`, {
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000),
      }),
    ]);

    if (obsResult.status === 'rejected') return undefined;
    const obsResponse = obsResult.value;
    if (!obsResponse.ok) return undefined;

    const obsData = await obsResponse.json() as { observations?: Array<{ date: string; value: string }> };
    const observations: FredObservation[] = (obsData.observations || [])
      .map((obs) => { const v = parseFloat(obs.value); return isNaN(v) || obs.value === '.' ? null : { date: obs.date, value: v }; })
      .filter((o): o is FredObservation => o !== null)
      .reverse();

    let title = seriesId;
    let units = '';
    let frequency = '';

    const metaResponse = metaResult.status === 'fulfilled' ? metaResult.value : null;
    if (metaResponse?.ok) {
      const metaData = await metaResponse.json() as { seriess?: Array<{ title?: string; units?: string; frequency?: string }> };
      const meta = metaData.seriess?.[0];
      if (meta) { title = meta.title || seriesId; units = meta.units || ''; frequency = meta.frequency || ''; }
    }

    return { seriesId, title, units, frequency, observations };
  } catch {
    return undefined;
  }
}

export async function getFredSeriesBatch(
  _ctx: ServerContext,
  req: GetFredSeriesBatchRequest,
): Promise<GetFredSeriesBatchResponse> {
  try {
    const normalized = req.seriesIds
      .map((id) => id.trim().toUpperCase())
      .filter((id) => ALLOWED_SERIES.has(id));
    const limitedList = toUniqueSortedLimited(normalized, 10);
    const limit = req.limit > 0 ? Math.min(req.limit, 1000) : 120;

    const results: Record<string, FredSeries> = {};
    const toFetch: string[] = [];

    const cacheKeys = limitedList.map((id) => `${REDIS_CACHE_KEY}:${id}:${limit}`);
    const cachedMap = await getCachedJsonBatch(cacheKeys);

    for (let i = 0; i < limitedList.length; i++) {
      const id = limitedList[i]!;
      const cached = cachedMap.get(cacheKeys[i]!) as { series?: FredSeries } | undefined;
      if (cached?.series) {
        results[id] = cached.series;
      } else if (cached === undefined) {
        toFetch.push(id);
      }
    }

    // Fetch all uncached series in parallel (max 10, each hits separate FRED endpoint)
    await Promise.allSettled(
      toFetch.map(async (id) => {
        const cacheResult = await cachedFetchJson<{ series?: FredSeries }>(
          `${REDIS_CACHE_KEY}:${id}:${limit}`,
          REDIS_CACHE_TTL,
          async () => {
            const series = await fetchSingleFred(id, limit);
            return series ? { series } : null;
          },
        );
        if (cacheResult?.series) results[id] = cacheResult.series;
      }),
    );

    return {
      results,
      fetched: Object.keys(results).length,
      requested: limitedList.length,
    };
  } catch {
    return { results: {}, fetched: 0, requested: 0 };
  }
}
