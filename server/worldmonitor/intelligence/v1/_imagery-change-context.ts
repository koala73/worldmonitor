import type { ImageryChangeContext } from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { ORBITAL_COUNTRY_KEY_PREFIX, ORBITAL_SITES_KEY } from '../../../_shared/cache-keys';

// The site seeder's reader gate: same schema, the revision the index names, and the oldest
// site evaluated within three days. While change scoring is shadowed, rollups carry no flag.
const SITES_SCHEMA = 1;
const ROLLUP_MAX_AGE_MS = 3 * 86_400_000;

interface RollupSite {
  siteId: string;
  name: string;
  flag: { state: string; confirmed: { datetime: string } | null } | null;
}

interface CountryRollup {
  schema: number;
  countryCode: string;
  asOf: number;
  revision: string;
  sites: RollupSite[];
}

interface SitesIndex {
  countries?: Record<string, { revision: string } | undefined>;
}

export const imageryChangeKeys = (countryCode: string): [string, string] =>
  [ORBITAL_SITES_KEY, `${ORBITAL_COUNTRY_KEY_PREFIX}${countryCode}`];

/** Confirmed change flags of a country's watched sites, from a current rollup only. */
export function imageryChangeContext(rollupRaw: unknown, indexRaw: unknown, countryCode: string, nowMs: number): ImageryChangeContext | undefined {
  const rollup = rollupRaw as CountryRollup | null;
  if (!rollup || rollup.schema !== SITES_SCHEMA || rollup.countryCode !== countryCode || !Array.isArray(rollup.sites)) return undefined;
  if ((indexRaw as SitesIndex | null)?.countries?.[countryCode]?.revision !== rollup.revision) return undefined;
  if (!(nowMs - rollup.asOf <= ROLLUP_MAX_AGE_MS)) return undefined;
  return {
    watchedSiteCount: rollup.sites.length,
    confirmedSites: rollup.sites
      .filter((site) => site.flag?.state === 'confirmed' && site.flag.confirmed)
      .map((site) => ({ siteId: site.siteId, name: site.name, confirmedAt: site.flag!.confirmed!.datetime })),
  };
}
