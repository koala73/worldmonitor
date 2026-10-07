import type {
  ServerContext,
  GetCountryRiskRequest,
  GetCountryRiskResponse,
  CiiScore,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { CII_RISK_SCORE_CACHE_KEYS } from '../../../_shared/cache-keys';
import { TIER1_COUNTRIES } from './_shared';

const RISK_SCORES_KEY = CII_RISK_SCORE_CACHE_KEYS.stale;
const ADVISORIES_KEY = 'intelligence:advisories:v1';
// Full ISO2 → entryCount map across all OFAC entries (not the top-12 summary slice).
const SANCTIONS_COUNTS_KEY = 'sanctions:country-counts:v1';
const UNKNOWN_CII_COMPUTED_AT = 0;

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
      fetchedAt: UNKNOWN_CII_COMPUTED_AT,
      upstreamUnavailable: false,
    };
  }

  const [riskRaw, advisoriesRaw, sanctionsRaw] = await Promise.all([
    getCachedJson(RISK_SCORES_KEY),
    getCachedJson(ADVISORIES_KEY, true),
    getCachedJson(SANCTIONS_COUNTS_KEY, true),
  ]);

  // Missing keys or empty country coverage fail closed before CDN-caching partial
  // data as valid. An empty global map does not establish a country-level zero.
  if (sanctionsRaw === null || Object.keys(sanctionsRaw as Record<string, number>).length === 0
    || riskRaw === null || advisoriesRaw === null) {
    return {
      countryCode: code,
      countryName: resolveCountryName(code, (advisoriesRaw as any)?.byCountryName),
      cii: undefined,
      advisoryLevel: '',
      sanctionsActive: false,
      sanctionsCount: 0,
      fetchedAt: UNKNOWN_CII_COMPUTED_AT,
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
    fetchedAt: cii?.computedAt ?? UNKNOWN_CII_COMPUTED_AT,
    upstreamUnavailable: false,
  };
}
