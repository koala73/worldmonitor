declare const process: { env: Record<string, string | undefined> };

import type {
  ServerContext,
  GetShippingRatesRequest,
  GetShippingRatesResponse,
  ShippingIndex,
  ShippingRatePoint,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

import { cachedFetchJson } from '../../../_shared/redis';
import { CHROME_UA } from '../../../_shared/constants';
// @ts-expect-error — .mjs module, no declaration file
import { detectSpike } from './_scoring.mjs';

const FRED_API_BASE = 'https://api.stlouisfed.org/fred';
const REDIS_CACHE_KEY = 'supply_chain:shipping:v2';
const REDIS_CACHE_TTL = 3600;

interface FredSeriesConfig {
  seriesId: string;
  name: string;
  unit: string;
  frequency: string;
}

const SHIPPING_SERIES: FredSeriesConfig[] = [
  { seriesId: 'PCU483111483111', name: 'Deep Sea Freight PPI', unit: 'index', frequency: 'm' },
  { seriesId: 'TSIFRGHT', name: 'Freight Transportation Index', unit: 'index', frequency: 'm' },
];

async function fetchFredSeries(cfg: FredSeriesConfig): Promise<ShippingIndex | null> {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) return null;

  try {
    const params = new URLSearchParams({
      series_id: cfg.seriesId,
      api_key: apiKey,
      file_type: 'json',
      frequency: cfg.frequency,
      sort_order: 'desc',
      limit: '24',
    });

    const response = await fetch(`${FRED_API_BASE}/series/observations?${params}`, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return null;

    const data = await response.json() as { observations?: Array<{ date: string; value: string }> };
    const observations = (data.observations || [])
      .map((obs): ShippingRatePoint | null => {
        const value = parseFloat(obs.value);
        if (isNaN(value) || obs.value === '.') return null;
        return { date: obs.date, value };
      })
      .filter((o): o is ShippingRatePoint => o !== null)
      .reverse();

    if (observations.length === 0) return null;

    const currentValue = observations[observations.length - 1]!.value;
    const previousValue = observations.length > 1 ? observations[observations.length - 2]!.value : currentValue;
    const changePct = previousValue !== 0 ? ((currentValue - previousValue) / previousValue) * 100 : 0;

    const spikeAlert = detectSpike(observations);

    return {
      indexId: cfg.seriesId,
      name: cfg.name,
      currentValue,
      previousValue,
      changePct,
      unit: cfg.unit,
      history: observations,
      spikeAlert,
    };
  } catch {
    return null;
  }
}

export async function getShippingRates(
  _ctx: ServerContext,
  _req: GetShippingRatesRequest,
): Promise<GetShippingRatesResponse> {
  try {
    const result = await cachedFetchJson<GetShippingRatesResponse>(
      REDIS_CACHE_KEY,
      REDIS_CACHE_TTL,
      async () => {
        const results = await Promise.all(SHIPPING_SERIES.map(fetchFredSeries));
        const indices = results.filter((r): r is ShippingIndex => r !== null);
        if (indices.length === 0) return null;
        return { indices, fetchedAt: new Date().toISOString(), upstreamUnavailable: false };
      },
    );

    return result ?? { indices: [], fetchedAt: new Date().toISOString(), upstreamUnavailable: true };
  } catch {
    return { indices: [], fetchedAt: new Date().toISOString(), upstreamUnavailable: true };
  }
}
