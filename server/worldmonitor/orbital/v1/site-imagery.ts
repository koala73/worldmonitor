/**
 * Watched-site imagery for agents: the country evidence the REST RPC serves, cut to what
 * an answer cites — each site's latest archive image with its date and credit, and its
 * next imaging pass. Change flags are left out while change scoring is shadowed (#10708);
 * `siteImagery` is the one place they would join once it is lifted.
 */
import type {
  GetCountryImageryEvidenceResponse,
  WatchedSiteEvidence,
} from '../../../../src/generated/server/worldmonitor/orbital/v1/service_server';
import { CELESTRAK_CREDIT, sceneCredit } from '../../../../shared/orbital/image-credit.js';

export interface SiteImage {
  itemId: string;
  profileId: string;
  datetime: string;
  credit: string;
}

export interface SitePass {
  profileId: string;
  time: string;
}

export interface SiteImagery {
  siteId: string;
  name: string;
  latestImage: SiteImage | null;
  nextPass: SitePass | null;
}

export interface CountrySiteImagery {
  countryCode: string;
  asOf: number;
  stale: boolean;
  siteCount: number;
  sites: SiteImagery[];
  credits: string[];
}

export function siteImagery(site: WatchedSiteEvidence): SiteImagery {
  const image = site.lastObservation;
  const pass = site.nextWindow;
  return {
    siteId: site.siteId,
    name: site.name,
    latestImage: image ? { itemId: image.itemId, profileId: image.profileId, datetime: image.datetime, credit: sceneCredit(image.profileId, image.datetime) } : null,
    nextPass: pass ? { profileId: pass.profileId, time: pass.time } : null,
  };
}

/** Every credit the listed sites owe, once each: the image archives, then the orbit elements behind a pass. */
export function imageryCredits(sites: readonly SiteImagery[]): string[] {
  const credits = [...new Set(sites.map((site) => site.latestImage?.credit ?? '').filter(Boolean))].sort();
  if (sites.some((site) => site.nextPass)) credits.push(CELESTRAK_CREDIT);
  return credits;
}

/** The country's sites with their imagery, newest image first. */
export function countrySiteImagery(evidence: GetCountryImageryEvidenceResponse): CountrySiteImagery {
  const sites = evidence.sites.map(siteImagery)
    .sort((a, b) => (b.latestImage?.datetime ?? '').localeCompare(a.latestImage?.datetime ?? '') || a.siteId.localeCompare(b.siteId));
  return { countryCode: evidence.countryCode, asOf: evidence.asOf, stale: evidence.stale, siteCount: evidence.siteCount, sites, credits: imageryCredits(sites) };
}
