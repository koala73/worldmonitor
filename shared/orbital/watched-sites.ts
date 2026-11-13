// The watched-site registry: places the site seeder evaluates every day for their latest
// confirmed image, next imaging windows and reconnaissance coverage. Composed from the
// curated lists the map already shows, so a site is only watched because one of them
// names it. `npm run generate` writes the composed list to
// scripts/shared/orbital-watched-sites.generated.mjs, the copy the seeder reads.
import countryNamesToIso2 from '../country-names.json';
import { CHOKEPOINT_COUNTRY_CODES } from '../chokepoint-countries.js';
import { CONFLICT_ZONES, INTEL_HOTSPOTS, STRATEGIC_WATERWAYS } from '../geo-data';
import { MILITARY_BASES_EXPANDED } from '../military-bases-data';
import { NUCLEAR_FACILITIES } from '../nuclear-facilities-data';
import { PORTS } from '../ports-data';

export type WatchedSiteOriginList =
  | 'hotspot'
  | 'conflict-zone'
  | 'military-base'
  | 'nuclear-facility'
  | 'port'
  | 'chokepoint';

export interface WatchedSiteOrigin {
  list: WatchedSiteOriginList;
  /** The entry's id in that list. */
  id: string;
}

export interface WatchedSite {
  /** `<list>:<id>` of the site's first origin. */
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** ISO 3166-1 alpha-2 code of the country the site is attributed to. */
  countryCode: string;
  /** Maritime sites (ports, chokepoints) get imaging evidence but no land change score. */
  surface: 'land' | 'maritime';
  origins: WatchedSiteOrigin[];
}

// Hotspots and conflict zones carry no country field; each is attributed to the country
// its marker sits in, or to the main country of a multi-country region.
const HOTSPOT_COUNTRY: Readonly<Record<string, string>> = {
  sahel: 'ML', haiti: 'HT', horn_africa: 'SO', pak_afghan: 'PK', dc: 'US', silicon_valley: 'US',
  wall_street: 'US', houston: 'US', moscow: 'RU', beijing: 'CN', kyiv: 'UA', taipei: 'TW',
  tehran: 'IR', telaviv: 'IL', pyongyang: 'KP', london: 'GB', brussels: 'BE', caracas: 'VE',
  mexico: 'MX', nuuk: 'GL', riyadh: 'SA', cairo: 'EG', baghdad: 'IQ', damascus: 'SY',
  doha: 'QA', ankara: 'TR', beirut: 'LB', sanaa: 'YE', abudhabi: 'AE',
};

const CONFLICT_ZONE_COUNTRY: Readonly<Record<string, string>> = {
  iran: 'IR', strait_hormuz: 'IR', ukraine: 'UA', gaza: 'PS', south_lebanon: 'LB',
  yemen_redsea: 'YE', sudan: 'SD', myanmar: 'MM', korean_dmz: 'KR', pak_afghan: 'PK',
};

// Host-country spellings in the base and port tables that the shared name map lacks.
const COUNTRY_NAME_ALIASES: Readonly<Record<string, string>> = {
  'china (sar)': 'HK', 'uk (gibraltar)': 'GI', 'republic of somaliland': 'SO',
  'united kingdoms': 'GB', america: 'US', quatar: 'QA',
};

// Bases the table lists with host country "Disputed": attributed to the territory that
// administers them.
const DISPUTED_BASE_COUNTRY: Readonly<Record<string, string>> = {
  unnamed_military_base: 'CN', unnamed_military_base_2: 'CN', unnamed_military_base_3: 'CN',
  unnamed_military_base_4: 'CN', rothera_research_station: 'AQ', raf_gibraltar: 'GI',
  port_stanley_airport: 'FK',
};

const NAME_TO_ISO2 = countryNamesToIso2 as Readonly<Record<string, string>>;

function iso2ForCountryName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const key = name.trim().toLowerCase();
  return COUNTRY_NAME_ALIASES[key] ?? NAME_TO_ISO2[key];
}

export interface WatchedSiteCandidate {
  origin: WatchedSiteOrigin;
  name: string;
  lat: number;
  lon: number;
  countryCode: string | undefined;
  surface: WatchedSite['surface'];
}

function candidates(): WatchedSiteCandidate[] {
  return [
    ...INTEL_HOTSPOTS.map((h) => ({
      origin: { list: 'hotspot' as const, id: h.id }, name: h.name, lat: h.lat, lon: h.lon,
      countryCode: HOTSPOT_COUNTRY[h.id], surface: 'land' as const,
    })),
    ...CONFLICT_ZONES.map((z) => ({
      origin: { list: 'conflict-zone' as const, id: z.id }, name: z.name, lat: z.center[1], lon: z.center[0],
      countryCode: CONFLICT_ZONE_COUNTRY[z.id], surface: 'land' as const,
    })),
    ...MILITARY_BASES_EXPANDED.map((b) => ({
      origin: { list: 'military-base' as const, id: b.id }, name: b.name, lat: b.lat, lon: b.lon,
      countryCode: DISPUTED_BASE_COUNTRY[b.id] ?? iso2ForCountryName(b.country), surface: 'land' as const,
    })),
    ...NUCLEAR_FACILITIES.map((f) => ({
      origin: { list: 'nuclear-facility' as const, id: f.id }, name: f.name, lat: f.lat, lon: f.lon,
      countryCode: f.operator, surface: 'land' as const,
    })),
    ...PORTS.map((p) => ({
      origin: { list: 'port' as const, id: p.id }, name: p.name, lat: p.lat, lon: p.lon,
      countryCode: iso2ForCountryName(p.country), surface: 'maritime' as const,
    })),
    ...STRATEGIC_WATERWAYS.map((w) => ({
      origin: { list: 'chokepoint' as const, id: w.id }, name: w.name, lat: w.lat, lon: w.lon,
      countryCode: (CHOKEPOINT_COUNTRY_CODES as Record<string, readonly string[]>)[w.chokepointId]?.[0],
      surface: 'maritime' as const,
    })),
  ];
}

const cellKey = (lat: number, lon: number) => `${Math.round(lat * 100)},${Math.round(lon * 100)}`;

/**
 * Entries of different lists at the same 0.01-degree cell become one site that keeps
 * every origin. Throws when an entry has no country attribution, so a new list entry
 * cannot silently drop out of the registry.
 */
export function composeWatchedSites(input: WatchedSiteCandidate[] = candidates()): WatchedSite[] {
  const byCell = new Map<string, WatchedSite>();
  const unattributed: string[] = [];
  for (const c of input) {
    if (!c.countryCode) {
      unattributed.push(`${c.origin.list}:${c.origin.id}`);
      continue;
    }
    const key = cellKey(c.lat, c.lon);
    const held = byCell.get(key);
    if (held) {
      held.origins.push(c.origin);
      if (c.surface === 'land') held.surface = 'land';
      continue;
    }
    byCell.set(key, {
      id: `${c.origin.list}:${c.origin.id}`,
      name: c.name,
      lat: c.lat,
      lon: c.lon,
      countryCode: c.countryCode,
      surface: c.surface,
      origins: [c.origin],
    });
  }
  if (unattributed.length) throw new Error(`watched sites without a country: ${unattributed.join(', ')}`);
  return [...byCell.values()].sort((a, b) => a.id.localeCompare(b.id));
}
