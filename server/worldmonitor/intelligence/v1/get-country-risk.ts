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
// Full ISO2 → entryCount map across all OFAC entries (not the top-12 summary slice).
const SANCTIONS_COUNTS_KEY = 'sanctions:country-counts:v1';

function resolveCountryName(
  code: string,
  byCountryName: Record<string, string> | undefined,
): string {
  return TIER1_COUNTRIES[code] ?? byCountryName?.[code] ?? code;
}

export async function getCountryRisk(
  _ctx: ServerContext,
  req: GetCountryRiskRequest,
): Promise<GetCountryRiskResponse> {
  const code = req.countryCode?.toUpperCase() ?? '';

  if (!code) {
    return {
      countryCode: code,
      countryName: '',
      cii: undefined,
      advisoryLevel: '',
      sanctionsActive: false,
      sanctionsCount: 0,
      fetchedAt: Date.now(),
      upstreamUnavailable: false,
    };
  }

  const [riskRaw, advisoriesRaw, sanctionsRaw] = await Promise.all([
    getCachedJson(RISK_SCORES_KEY, true),
    getCachedJson(ADVISORIES_KEY, true),
    getCachedJson(SANCTIONS_COUNTS_KEY, true),
  ]);

  // Any missing upstream key: fail closed to prevent CDN-caching of partial
  // data as if it were valid (e.g. sanctionsActive:false or cii:undefined when
  // the Redis key itself is simply absent, not just untracked for this country).
  if (sanctionsRaw === null || riskRaw === null || advisoriesRaw === null) {
    return {
      countryCode: code,
      countryName: resolveCountryName(code, (advisoriesRaw as any)?.byCountryName),
      cii: undefined,
      advisoryLevel: '',
      sanctionsActive: false,
      sanctionsCount: 0,
      fetchedAt: Date.now(),
      upstreamUnavailable: true,
    };
  }

  const ciiScores: CiiScore[] = (riskRaw as any)?.ciiScores ?? [];
  const cii = ciiScores.find((s) => s.region === code);

  const byCountry: Record<string, string> = (advisoriesRaw as any)?.byCountry ?? {};
  const advisoryLevel = byCountry[code] ?? '';

  const byCountryName: Record<string, string> | undefined = (advisoriesRaw as any)?.byCountryName;

  const sanctionsCount = (sanctionsRaw as Record<string, number>)[code] ?? 0;

  return {
    countryCode: code,
    countryName: resolveCountryName(code, byCountryName),
    cii,
    advisoryLevel,
    sanctionsActive: sanctionsCount > 0,
    sanctionsCount,
    fetchedAt: cii?.computedAt ?? Date.now(),
    upstreamUnavailable: false,
  };
}
