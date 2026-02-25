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

    // Group by country + type (R/N), take latest per combination
    const grouped = new Map<string, Map<string, Array<{ date: string; value: number }>>>();
    for (const row of rows) {
      const cc = row['REF_AREA'] || row['Reference area'] || '';
      const type = row['EER_TYPE'] || row['EER type'] || '';
      const date = row['TIME_PERIOD'] || row['Time period'] || '';
      const val = parseBisNumber(row['OBS_VALUE'] || row['Observation value']);
      if (!cc || !type || !date || val === null) continue;

      if (!grouped.has(cc)) grouped.set(cc, new Map());
      const countryMap = grouped.get(cc)!;
      if (!countryMap.has(type)) countryMap.set(type, []);
      countryMap.get(type)!.push({ date, value: val });
    }

    const rates: BisExchangeRate[] = [];
    for (const [cc, typeMap] of grouped) {
      const info = BIS_COUNTRIES[cc];
      if (!info) continue;

      // Get latest real and nominal values
      const realObs = typeMap.get('R') || [];
      const nomObs = typeMap.get('N') || [];

      realObs.sort((a, b) => a.date.localeCompare(b.date));
      nomObs.sort((a, b) => a.date.localeCompare(b.date));

      const latestReal = realObs[realObs.length - 1];
      const prevReal = realObs.length >= 2 ? realObs[realObs.length - 2] : undefined;
      const latestNom = nomObs[nomObs.length - 1];

      if (latestReal) {
        const realChange = prevReal
          ? Math.round(((latestReal.value - prevReal.value) / prevReal.value) * 1000) / 10
          : 0;

        rates.push({
          countryCode: cc,
          countryName: info.name,
          realEer: Math.round(latestReal.value * 100) / 100,
          nominalEer: latestNom ? Math.round(latestNom.value * 100) / 100 : 0,
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
  } catch {
    return { rates: [] };
  }
}
