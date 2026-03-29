import type {
  ServerContext,
  GetCountryRiskRequest,
  GetCountryRiskResponse,
  CiiScore,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { TIER1_COUNTRIES } from './_shared';

const RISK_SCORES_KEY = 'risk:scores:sebuf:stale:v1';
const ADVISORIES_KEY = 'intelligence:advisories:v1';
const SANCTIONS_KEY = 'sanctions:pressure:v1';

export async function getCountryRisk(
  _ctx: ServerContext,
  req: GetCountryRiskRequest,
): Promise<GetCountryRiskResponse> {
  const code = req.countryCode?.toUpperCase() ?? '';

  const empty: GetCountryRiskResponse = {
    countryCode: code,
    countryName: TIER1_COUNTRIES[code] ?? code,
    cii: undefined,
    advisoryLevel: '',
    sanctionsActive: false,
    sanctionsCount: 0,
    fetchedAt: Date.now(),
  };

  if (!code) return empty;

  const [riskRaw, advisoriesRaw, sanctionsRaw] = await Promise.all([
    getCachedJson(RISK_SCORES_KEY, true).catch(() => null),
    getCachedJson(ADVISORIES_KEY, true).catch(() => null),
    getCachedJson(SANCTIONS_KEY, true).catch(() => null),
  ]);

  const ciiScores: CiiScore[] = (riskRaw as any)?.ciiScores ?? [];
  const cii = ciiScores.find((s) => s.region === code);

  const byCountry: Record<string, string> = (advisoriesRaw as any)?.byCountry ?? {};
  const advisoryLevel = byCountry[code] ?? '';

  const sanctionCountries: Array<{ countryCode: string; entryCount: number }> =
    (sanctionsRaw as any)?.countries ?? [];
  const sanctionEntry = sanctionCountries.find(
    (c) => c.countryCode?.toUpperCase() === code,
  );
  const sanctionsCount = sanctionEntry?.entryCount ?? 0;

  return {
    countryCode: code,
    countryName: TIER1_COUNTRIES[code] ?? code,
    cii,
    advisoryLevel,
    sanctionsActive: sanctionsCount > 0,
    sanctionsCount,
    fetchedAt: Date.now(),
  };
}
