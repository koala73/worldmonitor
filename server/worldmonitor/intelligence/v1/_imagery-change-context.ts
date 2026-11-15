import type { ImageryChangeContext } from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { ORBITAL_COUNTRY_KEY_PREFIX, ORBITAL_SITES_KEY } from '../../../_shared/cache-keys';
import { confirmedSiteFlags, readCountryRollup, scoredSiteCount } from '../../../../shared/orbital/country-rollup.js';

export const imageryChangeKeys = (countryCode: string): [string, string] =>
  [ORBITAL_SITES_KEY, `${ORBITAL_COUNTRY_KEY_PREFIX}${countryCode}`];

/**
 * Confirmed change flags of a country's watched sites, out of the sites whose change
 * scoring is published, from a current rollup only. While scoring is shadowed no site is
 * scored, so there is no context at all; sites never scored (e.g. maritime) are not counted.
 */
export function imageryChangeContext(rollupRaw: unknown, indexRaw: unknown, countryCode: string, nowMs: number): ImageryChangeContext | undefined {
  const read = readCountryRollup(rollupRaw, indexRaw, countryCode, nowMs);
  if (read.status !== 'current') return undefined;
  const scored = scoredSiteCount(read.rollup);
  if (scored === 0) return undefined;
  return {
    watchedSiteCount: scored,
    confirmedSites: confirmedSiteFlags(read.rollup)
      .map((flag) => ({ siteId: flag.siteId, name: flag.name, confirmedAt: Date.parse(flag.confirmed.datetime) })),
  };
}
