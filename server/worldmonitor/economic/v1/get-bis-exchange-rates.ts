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

    // Single batched request: R=Real, N=Nominal, B=Broad basket
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    const startPeriod = `${threeMonthsAgo.getFullYear()}-${String(threeMonthsAgo.getMonth() + 1).padStart(2, '0')}`;

    const csv = await fetchBisCSV('WS_EER', `M.R+N.B.${BIS_COUNTRY_KEYS}?startPeriod=${startPeriod}&detail=dataonly`);
    const rows = parseBisCSV(csv);

    // Group by country + type, take last 2 real obs for change calculation
    const byCountry = new Map<string, {
      real: Array<{ date: string; value: number }>;
      nominal: Array<{ date: string; value: number }>;
    }>();
    for (const row of rows) {
      const cc = row['REF_AREA'] || row['Reference area'] || '';
      const date = row['TIME_PERIOD'] || row['Time period'] || '';
      const type =
        row['EER_TYPE'] ||
        row['Exchange rate index type'] ||
        row['Exchange rate type'] ||
        row['Type'] ||
        (row['SERIES_KEY']?.split('.')?.[1] ?? row['Series key']?.split('.')?.[1] ?? '');
      const val = parseBisNumber(row['OBS_VALUE'] || row['Observation value']);
      if (!cc || !date || val === null || !type) continue;
      if (!byCountry.has(cc)) byCountry.set(cc, { real: [], nominal: [] });
      const bucket = byCountry.get(cc)!;
      if (type === 'R') {
        bucket.real.push({ date, value: val });
      } else if (type === 'N') {
        bucket.nominal.push({ date, value: val });
      }
    }

    const rates: BisExchangeRate[] = [];
    for (const [cc, obs] of byCountry) {
      const info = BIS_COUNTRIES[cc];
      if (!info) continue;

      obs.real.sort((a, b) => a.date.localeCompare(b.date));
      obs.nominal.sort((a, b) => a.date.localeCompare(b.date));
      const latestReal = obs.real[obs.real.length - 1];
      const prevReal = obs.real.length >= 2 ? obs.real[obs.real.length - 2] : undefined;
      const latestNominal = obs.nominal[obs.nominal.length - 1];

      if (latestReal) {
        const realChange = prevReal
          ? Math.round(((latestReal.value - prevReal.value) / prevReal.value) * 1000) / 10
          : 0;

        rates.push({
          countryCode: cc,
          countryName: info.name,
          realEer: Math.round(latestReal.value * 100) / 100,
          nominalEer: latestNominal ? Math.round(latestNominal.value * 100) / 100 : 0,
          realChange,
          date: latestReal.date,
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
