/**
 * RPC: getCountryImageryEvidence -- serves the per-country projection that
 * scripts/seed-orbital-sites.mjs publishes. Only confirmed change flags are
 * returned. While the change signal is in shadow the seeder keeps flags out of
 * the canonical records, so nothing here can surface a shadow flag.
 */
import type {
  GetCountryImageryEvidenceRequest,
  GetCountryImageryEvidenceResponse,
  ServerContext,
  WatchedSiteEvidence,
} from '../../../../src/generated/server/worldmonitor/orbital/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/orbital/v1/service_server';
import { ORBITAL_COUNTRY_KEY_PREFIX, ORBITAL_SITES_KEY } from '../../../_shared/cache-keys';
import { getCachedJson } from '../../../_shared/redis';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';

/** Must equal scripts/_orbital-sites.mjs SITES_SCHEMA and ROLLUP_MAX_AGE_MS; pinned by tests. */
export const ORBITAL_SITES_SCHEMA = 1;
export const ORBITAL_ROLLUP_MAX_AGE_MS = 3 * 86_400_000;

const COUNTRY_CODE = /^[A-Z]{2}$/;

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown) => (typeof value === 'string' ? value : '');
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

function toSite(site: Json): WatchedSiteEvidence {
  const observation = isRecord(site.lastObservation) ? site.lastObservation : null;
  const next = isRecord(site.nextWindow) ? site.nextWindow : null;
  const flag = isRecord(site.flag) ? site.flag : null;
  const confirmed = flag?.state === 'confirmed' && isRecord(flag.confirmed) ? flag.confirmed : null;
  return {
    siteId: str(site.siteId),
    name: str(site.name),
    lat: num(site.lat),
    lon: num(site.lon),
    surface: str(site.surface),
    originLists: Array.isArray(site.originLists) ? site.originLists.filter((v): v is string => typeof v === 'string') : [],
    evaluatedAt: num(site.evaluatedAt),
    ...(observation && { lastObservation: { itemId: str(observation.itemId), profileId: str(observation.profileId), datetime: str(observation.datetime) } }),
    ...(next && { nextWindow: { profileId: str(next.profileId), time: str(next.time) } }),
    operators: Array.isArray(site.operators) ? site.operators.filter((v): v is string => typeof v === 'string') : [],
    ...(confirmed && flag && {
      confirmedFlag: {
        wording: str(flag.wording),
        itemId: str(confirmed.itemId),
        datetime: str(confirmed.datetime),
        geometryKey: str(confirmed.geometryKey),
        updatedAt: num(flag.updatedAt),
      },
    }),
  };
}

function unavailable(countryCode: string, siteCount = 0): GetCountryImageryEvidenceResponse {
  return { countryCode, asOf: 0, stale: true, siteCount, confirmedFlagCount: 0, sites: [] };
}

/** A rollup is served only when it is the one the index names and its oldest site is fresh enough. */
export function toCountryEvidence(countryCode: string, index: unknown, rollup: unknown, nowMs: number): GetCountryImageryEvidenceResponse {
  if (!isRecord(index) || index.schema !== ORBITAL_SITES_SCHEMA || !isRecord(index.countries)) return unavailable(countryCode);
  const entry = index.countries[countryCode];
  if (!isRecord(entry)) return { countryCode, asOf: 0, stale: false, siteCount: 0, confirmedFlagCount: 0, sites: [] };
  const current = isRecord(rollup) &&
    rollup.schema === ORBITAL_SITES_SCHEMA &&
    rollup.countryCode === countryCode &&
    rollup.revision === entry.revision &&
    Array.isArray(rollup.sites) &&
    nowMs - num(rollup.asOf) <= ORBITAL_ROLLUP_MAX_AGE_MS;
  if (!current) return unavailable(countryCode, num(entry.siteCount));
  const sites = (rollup.sites as unknown[]).filter(isRecord).map(toSite);
  return {
    countryCode,
    asOf: num(rollup.asOf),
    stale: false,
    siteCount: sites.length,
    confirmedFlagCount: sites.filter((site) => site.confirmedFlag).length,
    sites,
  };
}

export async function getCountryImageryEvidence(
  ctx: ServerContext,
  req: GetCountryImageryEvidenceRequest,
): Promise<GetCountryImageryEvidenceResponse> {
  const countryCode = req.countryCode ?? '';
  if (!COUNTRY_CODE.test(countryCode)) {
    throw new ValidationError([{ field: 'country_code', description: 'country_code must be an upper-case ISO 3166-1 alpha-2 code' }]);
  }
  const [index, rollup] = await Promise.all([
    getCachedJson(ORBITAL_SITES_KEY, true),
    getCachedJson(`${ORBITAL_COUNTRY_KEY_PREFIX}${countryCode}`, true),
  ]);
  const response = toCountryEvidence(countryCode, index, rollup, Date.now());
  return response.stale ? markNoStoreFallbackResponse(ctx.request, response) : response;
}
