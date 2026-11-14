import type { MatchedAcquisition, OrbitalEvidence } from './match';
import type { PointPassLookup } from './pass-client';
import { CELESTRAK_CREDIT, COPERNICUS_CREDIT, USGS_LANDSAT_CREDIT } from '../../../shared/orbital/image-credit.js';

/** Credit lines the sources ask for, worded as in the source attribution manifest. */
export const IMAGE_CREDIT = {
  copernicus: COPERNICUS_CREDIT,
  usgs: USGS_LANDSAT_CREDIT,
  eumetsat: 'Contains EUMETSAT Meteosat imagery',
  gibs: 'NASA GIBS / EOSDIS',
  gibsAcknowledgement: "We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS).",
  celestrak: CELESTRAK_CREDIT,
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

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

function listJoin(items: string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : (items[0] ?? '');
}

/** What NASA GIBS supplied to one result: its daily mosaic families and any geostationary frames. */
function gibsSupplied(evidence: OrbitalEvidence | null): string | null {
  const families = [...new Set(evidence?.mosaics.filter((mosaic) => mosaic.days.length > 0).map((mosaic) => mosaic.source.split(' ')[0]!) ?? [])];
  const frames = evidence?.frames.some((frame) => frame.latest && frame.archive === 'nasa-gibs') ?? false;
  const supplied = [families.length > 0 ? `daily ${listJoin(families)} mosaics` : null, frames ? 'geostationary frames' : null].filter((part): part is string => part !== null);
  return supplied.length > 0 ? supplied.join(' and ') : null;
}

/** A source's entry for one result, naming what it supplied, or null when the result holds nothing from it. */
type CreditRule = (lookup: PointPassLookup, evidence: OrbitalEvidence | null) => ResultCredit | null;

/** Every source the lookup can show, in the order their credits read. */
const CREDIT_RULES: readonly CreditRule[] = [
  (lookup) => (lookup.passes.length > 0 ? { source: 'CelesTrak', text: 'orbit elements', href: 'https://celestrak.org' } : null),
  (_, evidence) => {
    const sentinel = evidence?.acquisitions.filter((acquisition) => acquisition.profileId !== 'landsat') ?? [];
    return sentinel.length > 0 ? { source: 'Copernicus Sentinel', text: lowerFirst(IMAGE_CREDIT.copernicus(yearSpan(sentinel))) } : null;
  },
  (_, evidence) => (evidence?.acquisitions.some((acquisition) => acquisition.profileId === 'landsat') ? { source: 'USGS Landsat', text: IMAGE_CREDIT.usgs } : null),
  (_, evidence) => {
    const supplied = gibsSupplied(evidence);
    return supplied ? { source: IMAGE_CREDIT.gibs, text: supplied } : null;
  },
  (_, evidence) => (evidence?.frames.some((frame) => frame.latest && frame.archive === 'eumetsat') ? { source: 'EUMETSAT', text: lowerFirst(IMAGE_CREDIT.eumetsat) } : null),
];

/** The credit lines for the sources present in one lookup result. */
export function resultCredits(lookup: PointPassLookup, evidence: OrbitalEvidence | null): ResultCredit[] {
  return CREDIT_RULES.map((rule) => rule(lookup, evidence)).filter((credit): credit is ResultCredit => credit !== null);
}
