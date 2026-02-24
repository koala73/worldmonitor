/**
 * RPC: getFredSeries -- Federal Reserve Economic Data (FRED) time series
 * Port from api/fred-data.js
 */

declare const process: { env: Record<string, string | undefined> };

import type {
  ServerContext,
  GetFredSeriesRequest,
  GetFredSeriesResponse,
  FredSeries,
  FredObservation,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getCachedJson, setCachedJson } from '../../../_shared/redis';

const FRED_API_BASE = 'https://api.stlouisfed.org/fred';
const REDIS_CACHE_KEY = 'economic:fred:v1';
const REDIS_CACHE_TTL = 3600; // 1 hr — FRED data updates infrequently

async function fetchFredSeries(req: GetFredSeriesRequest): Promise<FredSeries | undefined> {
  try {
    const apiKey = process.env.FRED_API_KEY;
    if (!apiKey) return undefined;

    const limit = req.limit > 0 ? Math.min(req.limit, 1000) : 120;

    // Fetch observations and series metadata in parallel
    const obsParams = new URLSearchParams({
      series_id: req.seriesId,
      api_key: apiKey,
      file_type: 'json',
      sort_order: 'desc',
      limit: String(limit),
    });

    const metaParams = new URLSearchParams({
      series_id: req.seriesId,
      api_key: apiKey,
      file_type: 'json',
    });

    const [obsResponse, metaResponse] = await Promise.all([
      fetch(`${FRED_API_BASE}/series/observations?${obsParams}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      }),
      fetch(`${FRED_API_BASE}/series?${metaParams}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      }),
    ]);

    if (!obsResponse.ok) return undefined;

    const obsData = await obsResponse.json() as { observations?: Array<{ date: string; value: string }> };

    const observations: FredObservation[] = (obsData.observations || [])
      .map((obs) => {
        const value = parseFloat(obs.value);
        if (isNaN(value) || obs.value === '.') return null;
        return { date: obs.date, value };
      })
      .filter((o): o is FredObservation => o !== null)
      .reverse(); // oldest first

    let title = req.seriesId;
    let units = '';
    let frequency = '';

    if (metaResponse.ok) {
      const metaData = await metaResponse.json() as { seriess?: Array<{ title?: string; units?: string; frequency?: string }> };
      const meta = metaData.seriess?.[0];
      if (meta) {
        title = meta.title || req.seriesId;
        units = meta.units || '';
        frequency = meta.frequency || '';
      }
    }

    return {
      seriesId: req.seriesId,
      title,
      units,
      frequency,
      observations,
    };
  } catch {
    return undefined;
  }
}

export async function getFredSeries(
  _ctx: ServerContext,
  req: GetFredSeriesRequest,
): Promise<GetFredSeriesResponse> {
  try {
    const cacheKey = `${REDIS_CACHE_KEY}:${req.seriesId}:${req.limit || 0}`;
    const cached = (await getCachedJson(cacheKey)) as GetFredSeriesResponse | null;
    if (cached?.series) return cached;

    const series = await fetchFredSeries(req);
    const result: GetFredSeriesResponse = { series };
    if (series) {
      setCachedJson(cacheKey, result, REDIS_CACHE_TTL).catch(() => {});
    }
    return result;
  } catch {
    return { series: undefined };
  }
}
