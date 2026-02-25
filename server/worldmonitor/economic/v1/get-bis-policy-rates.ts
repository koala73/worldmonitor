/**
 * RPC: getBisPolicyRates -- BIS SDMX API (WS_CBPOL)
 * Central bank policy rates for major economies.
 */

import type {
  ServerContext,
  GetBisPolicyRatesRequest,
  GetBisPolicyRatesResponse,
  BisPolicyRate,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { cachedFetchJson } from '../../../_shared/redis';
import { fetchBisCSV, parseBisCSV, parseBisNumber, BIS_COUNTRIES, BIS_COUNTRY_KEYS } from './_bis-shared';

const REDIS_CACHE_KEY = 'economic:bis:policy:v1';
const REDIS_CACHE_TTL = 21600; // 6 hours — monthly data

export async function getBisPolicyRates(
  _ctx: ServerContext,
  _req: GetBisPolicyRatesRequest,
): Promise<GetBisPolicyRatesResponse> {
  try {
    const result = await cachedFetchJson<GetBisPolicyRatesResponse>(REDIS_CACHE_KEY, REDIS_CACHE_TTL, async () => {
      // Single batched request: all countries in one +-delimited key
      const threeMonthsAgo = new Date();
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
      const startPeriod = `${threeMonthsAgo.getFullYear()}-${String(threeMonthsAgo.getMonth() + 1).padStart(2, '0')}`;

      const csv = await fetchBisCSV('WS_CBPOL', `M.${BIS_COUNTRY_KEYS}?startPeriod=${startPeriod}&detail=dataonly`);
      const rows = parseBisCSV(csv);

      // Group rows by country, take last 2 observations
      const byCountry = new Map<string, Array<{ date: string; value: number }>>();
      for (const row of rows) {
        const cc = row['REF_AREA'] || row['Reference area'] || '';
        const date = row['TIME_PERIOD'] || row['Time period'] || '';
        const val = parseBisNumber(row['OBS_VALUE'] || row['Observation value']);
        if (!cc || !date || val === null) continue;
        if (!byCountry.has(cc)) byCountry.set(cc, []);
        byCountry.get(cc)!.push({ date, value: val });
      }

      const rates: BisPolicyRate[] = [];
      for (const [cc, obs] of byCountry) {
        const info = BIS_COUNTRIES[cc];
        if (!info) continue;

        // Sort chronologically and take last 2
        obs.sort((a, b) => a.date.localeCompare(b.date));
        const latest = obs[obs.length - 1];
        const previous = obs.length >= 2 ? obs[obs.length - 2] : undefined;

        if (latest) {
          rates.push({
            countryCode: cc,
            countryName: info.name,
            rate: latest.value,
            previousRate: previous?.value ?? latest.value,
            date: latest.date,
            centralBank: info.centralBank,
          });
        }
      }

      return rates.length > 0 ? { rates } : null;
    });
    return result || { rates: [] };
  } catch (e) {
    console.error('[BIS] Policy rates fetch failed:', e);
    return { rates: [] };
  }
}
