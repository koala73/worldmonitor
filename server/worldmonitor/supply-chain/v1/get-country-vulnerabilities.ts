import type {
  GetCountryVulnerabilitiesRequest,
  GetCountryVulnerabilitiesResponse,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import {
  mapCommodityVulnerability,
  type RawCountryIndex,
  stringValue,
} from './_vulnerability-projection';

export const COUNTRY_KEY = 'supply-chain:vulnerability:v1';

export async function getCountryVulnerabilities(
  _ctx: ServerContext,
  req: GetCountryVulnerabilitiesRequest,
): Promise<GetCountryVulnerabilitiesResponse> {
  const iso2 = (req.iso2 || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(iso2)) {
    throw new ValidationError([{ field: 'iso2', description: 'iso2 must be a 2-letter uppercase ISO country code' }]);
  }

  const payload = await getCachedJson(COUNTRY_KEY, true).catch(() => null) as RawCountryIndex | null;
  const country = payload?.countries?.[iso2];
  return {
    iso2,
    country: stringValue(country?.name),
    vulnerabilities: Array.isArray(country?.vulnerabilities)
      ? country.vulnerabilities.map(mapCommodityVulnerability)
      : [],
    generatedAt: stringValue(payload?.generatedAt),
    methodologyVersion: stringValue(payload?.methodologyVersion),
    upstreamUnavailable: payload == null,
  };
}
