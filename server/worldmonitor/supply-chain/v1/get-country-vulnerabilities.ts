import type {
  GetCountryVulnerabilitiesRequest,
  GetCountryVulnerabilitiesResponse,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { requiresRedistributableProvidersForDirectRpc } from '../../../_shared/provider-redistribution';
import {
  VULNERABILITY_COHORT_KEY,
  countryVulnerabilityShardKey,
  enforceCommodityRedistributionPolicy,
  hasCurrentRedistributionPolicy,
  isMatchingShard,
  mapCommodityVulnerability,
  type RawVulnerabilityCohort,
  type RawCountryShard,
  stringValue,
  vulnerabilityShardSlot,
} from './_vulnerability-projection';

export async function getCountryVulnerabilities(
  ctx: ServerContext,
  req: GetCountryVulnerabilitiesRequest,
): Promise<GetCountryVulnerabilitiesResponse> {
  const iso2 = (req.iso2 || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(iso2)) {
    throw new ValidationError([{ field: 'iso2', description: 'iso2 must be a 2-letter uppercase ISO country code' }]);
  }

  const persistedPayload = await getCachedJson(VULNERABILITY_COHORT_KEY, true)
    .catch(() => null) as RawVulnerabilityCohort | null;
  const payload = hasCurrentRedistributionPolicy(persistedPayload) ? persistedPayload : null;
  let country = payload?.countries?.[iso2];
  let shardUnavailable = false;
  if (payload && !payload.countries) {
    const slot = vulnerabilityShardSlot(payload.slot);
    const countryIds = Array.isArray(payload.countryIds)
      ? payload.countryIds.filter((id): id is string => typeof id === 'string')
      : null;
    if (slot === undefined || countryIds == null) {
      shardUnavailable = true;
    } else if (countryIds.includes(iso2)) {
      const shard = await getCachedJson(countryVulnerabilityShardKey(slot, iso2), true)
        .catch(() => null) as RawCountryShard | null;
      if (isMatchingShard(payload, shard) && shard?.country?.iso2 === iso2) country = shard.country;
      else shardUnavailable = true;
    }
  }
  const requireRedistributable = requiresRedistributableProvidersForDirectRpc(ctx.request);
  return {
    iso2,
    country: stringValue(country?.name),
    vulnerabilities: Array.isArray(country?.vulnerabilities)
      ? country.vulnerabilities
        .map((record) => enforceCommodityRedistributionPolicy(
          record,
          requireRedistributable,
        ))
        .map(mapCommodityVulnerability)
      : [],
    generatedAt: stringValue(payload?.generatedAt),
    methodologyVersion: stringValue(payload?.methodologyVersion),
    upstreamUnavailable: payload == null || shardUnavailable,
  };
}
