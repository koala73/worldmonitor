import type { MatchedAcquisition, OrbitalEvidence } from './match';
import type { PointPassLookup } from './pass-client';

/** Credit lines the sources ask for, worded as in the source attribution manifest. */
export const IMAGE_CREDIT = {
  copernicus: (years: string | number) => `Contains modified Copernicus Sentinel data ${years}`,
  usgs: 'Landsat imagery courtesy of the U.S. Geological Survey',
  eumetsat: 'Contains EUMETSAT Meteosat imagery',
  gibs: 'NASA GIBS / EOSDIS',
  gibsAcknowledgement: "We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS).",
  celestrak: 'Orbit elements from CelesTrak',
} as const;

export function acquisitionCredit(acquisition: MatchedAcquisition): string {
  return acquisition.profileId === 'landsat' ? IMAGE_CREDIT.usgs : IMAGE_CREDIT.copernicus(new Date(acquisition.startMs).getUTCFullYear());
}

function yearSpan(acquisitions: readonly MatchedAcquisition[]): string {
  const years = acquisitions.map((acquisition) => new Date(acquisition.startMs).getUTCFullYear());
  const first = Math.min(...years);
  const last = Math.max(...years);
  return first === last ? String(first) : `${first}-${last}`;
}

export const ORBITAL_WATCH_DOCS_URL = 'https://www.worldmonitor.app/docs/orbital-watch';

export interface ResultCredit {
  source: string;
  text: string;
  href?: string;
}

/** A source's credit line for one result, or null when the result holds nothing from it. */
type CreditRule = (lookup: PointPassLookup, evidence: OrbitalEvidence | null) => ResultCredit | null;

/** Every source the lookup can show, in the order their credits read. */
const CREDIT_RULES: readonly CreditRule[] = [
  (lookup) => (lookup.passes.length > 0 ? { source: 'CelesTrak', text: IMAGE_CREDIT.celestrak, href: 'https://celestrak.org' } : null),
  (_, evidence) => {
    const sentinel = evidence?.acquisitions.filter((acquisition) => acquisition.profileId !== 'landsat') ?? [];
    return sentinel.length > 0 ? { source: 'Copernicus Sentinel', text: IMAGE_CREDIT.copernicus(yearSpan(sentinel)) } : null;
  },
  (_, evidence) => (evidence?.acquisitions.some((acquisition) => acquisition.profileId === 'landsat') ? { source: 'USGS Landsat', text: IMAGE_CREDIT.usgs } : null),
  (_, evidence) =>
    evidence?.mosaics.some((mosaic) => mosaic.days.length > 0) || evidence?.frames.some((frame) => frame.latest && frame.archive === 'nasa-gibs')
      ? { source: 'NASA GIBS', text: IMAGE_CREDIT.gibsAcknowledgement }
      : null,
  (_, evidence) => (evidence?.frames.some((frame) => frame.latest && frame.archive === 'eumetsat') ? { source: 'EUMETSAT', text: IMAGE_CREDIT.eumetsat } : null),
];

/** The credit lines for the sources present in one lookup result. */
export function resultCredits(lookup: PointPassLookup, evidence: OrbitalEvidence | null): ResultCredit[] {
  return CREDIT_RULES.map((rule) => rule(lookup, evidence)).filter((credit): credit is ResultCredit => credit !== null);
}
