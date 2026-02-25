/**
 * RPC: getBisExchangeRates -- BIS SDMX API (WS_EER)
 * Effective exchange rate indices (real + nominal) for major economies.
 */

import type {
  ServerContext,
  GetBisExchangeRatesRequest,
  GetBisExchangeRatesResponse,
  BisExchangeRate,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getCachedJson, setCachedJson } from '../../../_shared/redis';
import { fetchBisCSV, parseBisCSV, parseBisNumber, BIS_COUNTRIES, BIS_COUNTRY_KEYS } from './_bis-shared';

const REDIS_CACHE_KEY = 'economic:bis:eer:v1';
const REDIS_CACHE_TTL = 21600; // 6 hours — monthly data

export async function getBisExchangeRates(
  _ctx: ServerContext,
  _req: GetBisExchangeRatesRequest,
): Promise<GetBisExchangeRatesResponse> {
  try {
    const cached = (await getCachedJson(REDIS_CACHE_KEY)) as GetBisExchangeRatesResponse | null;
    if (cached?.rates?.length) return cached;

    // Single batched request: R=Real only (nominal is not displayed), B=Broad basket
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    const startPeriod = `${threeMonthsAgo.getFullYear()}-${String(threeMonthsAgo.getMonth() + 1).padStart(2, '0')}`;

    const csv = await fetchBisCSV('WS_EER', `M.R.B.${BIS_COUNTRY_KEYS}?startPeriod=${startPeriod}&detail=dataonly`);
    const rows = parseBisCSV(csv);

    // Group by country, take last 2 observations for change calculation
    const byCountry = new Map<string, Array<{ date: string; value: number }>>();
    for (const row of rows) {
      const cc = row['REF_AREA'] || row['Reference area'] || '';
      const date = row['TIME_PERIOD'] || row['Time period'] || '';
      const val = parseBisNumber(row['OBS_VALUE'] || row['Observation value']);
      if (!cc || !date || val === null) continue;
      if (!byCountry.has(cc)) byCountry.set(cc, []);
      byCountry.get(cc)!.push({ date, value: val });
    }

    const rates: BisExchangeRate[] = [];
    for (const [cc, obs] of byCountry) {
      const info = BIS_COUNTRIES[cc];
      if (!info) continue;

      obs.sort((a, b) => a.date.localeCompare(b.date));
      const latest = obs[obs.length - 1];
      const prev = obs.length >= 2 ? obs[obs.length - 2] : undefined;

      if (latest) {
        const realChange = prev
          ? Math.round(((latest.value - prev.value) / prev.value) * 1000) / 10
          : 0;

        rates.push({
          countryCode: cc,
          countryName: info.name,
          realEer: Math.round(latest.value * 100) / 100,
          nominalEer: 0,
          realChange,
          date: latest.date,
        });
      }
    }

    const result: GetBisExchangeRatesResponse = { rates };
    if (rates.length > 0) {
      setCachedJson(REDIS_CACHE_KEY, result, REDIS_CACHE_TTL).catch(() => {});
    }
    return result;
  } catch (e) {
    console.error('[BIS] Exchange rates fetch failed:', e);
    return { rates: [] };
  }
}
