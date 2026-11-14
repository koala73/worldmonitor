/**
 * The analyst's watched-site imagery section: for the country in focus, or the watched
 * countries the question names, each site's latest archive image with its date and the
 * next imaging pass. Same keys, currency rule and projection as the Orbital REST RPC.
 * The question is matched in memory only; it is never logged or sent anywhere.
 */
import { countryDisplayName, countryMentionTerms, mentionsCountry } from '../../../../shared/country-mention.js';
import { ORBITAL_COUNTRY_KEY_PREFIX, ORBITAL_SITES_KEY } from '../../../_shared/cache-keys';
import { getCachedJson } from '../../../_shared/redis';
import { toCountryEvidence } from '../../orbital/v1/get-country-imagery-evidence';
import { countrySiteImagery, imageryCredits, type CountrySiteImagery, type SiteImagery } from '../../orbital/v1/site-imagery';

export const MAX_IMAGERY_COUNTRIES = 2;
export const MAX_IMAGERY_SITES = 8;

const day = (iso: string) => iso.slice(0, 10);
const minute = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/** The focus country first, then watched countries the question names, at most two. */
export function imageryCountries(index: unknown, focus: string | null, query: string): string[] {
  const registry = index && typeof index === 'object' && Array.isArray((index as { registryCountries?: unknown }).registryCountries)
    ? ((index as { registryCountries: unknown[] }).registryCountries).filter((code): code is string => typeof code === 'string')
    : [];
  const codes = focus ? [focus] : [];
  for (const code of registry) {
    if (codes.length >= MAX_IMAGERY_COUNTRIES) break;
    if (!codes.includes(code) && query && mentionsCountry(query, countryMentionTerms(code))) codes.push(code);
  }
  return codes.slice(0, MAX_IMAGERY_COUNTRIES);
}

function siteLine(site: SiteImagery): string {
  const image = site.latestImage
    ? `latest image ${day(site.latestImage.datetime)} (${site.latestImage.profileId}, scene ${site.latestImage.itemId})`
    : 'no archive image on record';
  const pass = site.nextPass
    ? `next imaging pass ${minute(site.nextPass.time)} (${site.nextPass.profileId})`
    : 'no imaging pass expected in the next 72 hours';
  return `- ${site.name}: ${image}; ${pass}`;
}

/** Sites the question names come first; the rest keep newest-image order. */
export function formatSiteImagery(imagery: CountrySiteImagery, keywords: readonly string[]): string {
  if (imagery.stale || imagery.sites.length === 0) return '';
  const named = (site: SiteImagery) => keywords.some((word) => word.length >= 4 && site.name.toLowerCase().includes(word.toLowerCase()));
  const sites = [...imagery.sites.filter(named), ...imagery.sites.filter((site) => !named(site))].slice(0, MAX_IMAGERY_SITES);
  const country = countryDisplayName(imagery.countryCode) || imagery.countryCode;
  const credits = imageryCredits(sites);
  return [
    `Watched-Site Imagery — ${country} (evaluated ${day(new Date(imagery.asOf).toISOString())}, ${sites.length} of ${imagery.siteCount} sites)`,
    ...sites.map(siteLine),
    ...(credits.length ? [`Credits: ${credits.join('; ')}`] : []),
  ].join('\n');
}

export async function buildWatchedSiteImagery(
  focus: string | null,
  query: string,
  keywords: readonly string[],
  nowMs: number = Date.now(),
): Promise<string | undefined> {
  const index = await getCachedJson(ORBITAL_SITES_KEY, true);
  const codes = imageryCountries(index, focus, query);
  if (codes.length === 0) return undefined;
  const rollups = await Promise.all(codes.map((code) => getCachedJson(`${ORBITAL_COUNTRY_KEY_PREFIX}${code}`, true)));
  const blocks = codes
    .map((code, i) => formatSiteImagery(countrySiteImagery(toCountryEvidence(code, index, rollups[i], nowMs)), keywords))
    .filter(Boolean);
  return blocks.length ? blocks.join('\n\n') : undefined;
}
