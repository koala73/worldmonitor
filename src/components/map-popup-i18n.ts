/**
 * Display-only localization helpers for map marker popups (#10065).
 *
 * Every helper maps a raw provider/config value to a catalogue label and falls
 * back to the original value when no mapping exists, so unknown enums are shown
 * verbatim rather than guessed. Raw values stay in use for CSS classes, filters
 * and exports; only the visible label goes through these helpers.
 */
import { getCurrentLanguageTag, t } from '@/services/i18n';
import { nameToCountryCode } from '@/services/country-geometry';

function toKeySlug(raw: string): string {
  const words = raw
    .trim()
    .replace(/&/g, ' and ')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return words.map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1))).join('');
}

/** Look up `${prefix}.${slug(raw)}`; return null when the catalogue has no entry. */
export function lookupLabel(prefix: string, raw: string | null | undefined): string | null {
  if (!raw) return null;
  const slug = toKeySlug(raw);
  if (!slug) return null;
  const key = `${prefix}.${slug}`;
  const value = t(key);
  return typeof value === 'string' && value && value !== key ? value : null;
}

function upper(value: string): string {
  try {
    return value.toLocaleUpperCase(getCurrentLanguageTag());
  } catch {
    return value.toUpperCase();
  }
}

/** Severity / intensity / level values (Moderate, Minor, high, spike…). */
export function severityLabel(raw: string | null | undefined, opts: { upper?: boolean } = {}): string {
  const label = lookupLabel('popups.levels', raw) ?? (raw ?? '');
  return opts.upper === false ? label : upper(label);
}

/** Lifecycle / operating status values (active, decommissioned, operating…). */
export function statusLabel(raw: string | null | undefined, opts: { upper?: boolean } = {}): string {
  const label = lookupLabel('popups.statusValues', raw) ?? (raw ?? '');
  return opts.upper === false ? label : upper(label);
}

/** MITRE ATT&CK tactic names. */
export function aptTacticLabel(raw: string): string {
  return lookupLabel('popups.aptTactics', raw) ?? raw;
}

/** APT target-sector controlled vocabulary. */
const APT_SECTOR_ALIASES: Record<string, string> = { ngos: 'ngo' };

export function aptSectorLabel(raw: string): string {
  const alias = APT_SECTOR_ALIASES[raw.trim().toLowerCase()];
  return lookupLabel('popups.aptSectors', alias ?? raw) ?? raw;
}

// Recurring non-English / variant spellings seen in WMO SWIC feeds, mapped to
// the English canonical event name used for the catalogue key.
const WEATHER_EVENT_ALIASES: Record<string, string> = {
  thunderstorms: 'thunderstorm',
  orage: 'thunderstorm',
  orages: 'thunderstorm',
  pluie: 'rain',
  'pluie periode humide': 'rain',
  forestfire: 'forest fire',
  'aviso de lluvias de nivel amarillo': 'yellow rain warning',
  'aviso de lluvias de nivel naranja': 'orange rain warning',
  'aviso de tormentas de nivel amarillo': 'yellow thunderstorm warning',
  'wind yellow warning': 'yellow wind warning',
  'rain yellow': 'yellow rain warning',
};

function normalizeEventName(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Weather/alert event names (NWS CAP event types, ECCC alert names, IMD
 * bulletins, recurring WMO SWIC hazards). Case and whitespace are normalized
 * before lookup; unknown events are returned verbatim.
 */
export function weatherEventLabel(raw: string | null | undefined, opts: { upper?: boolean } = {}): string {
  if (!raw) return '';
  const normalized = normalizeEventName(raw);
  const label = (normalized && lookupLabel('popups.weatherEvents', WEATHER_EVENT_ALIASES[normalized] ?? normalized)) || raw;
  return opts.upper ? upper(label) : label;
}

/** Datacenter ownership sector (Private, Public, Public/Private). */
export function datacenterSectorLabel(raw: string): string {
  return lookupLabel('popups.datacenter.sectors', raw) ?? raw;
}

// Names used by data sets that Intl.DisplayNames('en') does not emit verbatim.
const COUNTRY_ALIASES: Record<string, string> = {
  'united states of america': 'US',
  'united states': 'US',
  usa: 'US',
  'korea (republic of)': 'KR',
  'republic of korea': 'KR',
  'korea, republic of': 'KR',
  'south korea': 'KR',
  'north korea': 'KP',
  'russian federation': 'RU',
  'iran (islamic republic of)': 'IR',
  'viet nam': 'VN',
  'taiwan, province of china': 'TW',
  'united kingdom of great britain and northern ireland': 'GB',
  uk: 'GB',
  uae: 'AE',
  'czech republic': 'CZ',
  turkey: 'TR',
  'türkiye': 'TR',
};

let englishRegionIndex: Map<string, string> | null = null;

function buildEnglishRegionIndex(): Map<string, string> {
  const index = new Map<string, string>();
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    return index;
  }
  const A = 'A'.charCodeAt(0);
  for (let i = 0; i < 26; i++) {
    for (let j = 0; j < 26; j++) {
      const code = String.fromCharCode(A + i, A + j);
      try {
        const name = names.of(code);
        if (name && name !== code && !index.has(name.toLowerCase())) index.set(name.toLowerCase(), code);
      } catch {
        // invalid code for this engine
      }
    }
  }
  return index;
}

/** ISO 3166-1 alpha-2 code for an English country name, when unambiguous. */
export function countryCodeForName(name: string): string | null {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return null;
  if (/^[a-z]{2}$/.test(normalized)) return normalized.toUpperCase();
  const alias = COUNTRY_ALIASES[normalized];
  if (alias) return alias;
  englishRegionIndex ??= buildEnglishRegionIndex();
  return englishRegionIndex.get(normalized) ?? nameToCountryCode(normalized);
}

/** Localized country name for structured country fields; original when unknown. */
export function countryLabel(raw: string | null | undefined): string {
  if (!raw) return '';
  const lang = getCurrentLanguageTag();
  const code = countryCodeForName(raw);
  if (!code) return raw;
  if (lang === 'en') return raw;
  try {
    const localized = new Intl.DisplayNames([lang], { type: 'region' }).of(code);
    return localized && localized !== code ? localized : raw;
  } catch {
    return raw;
  }
}

/** True when a city field only repeats the country (e.g. GDELT country-level hits). */
export function isSameLocation(city: string | null | undefined, country: string | null | undefined): boolean {
  if (!city || !country) return false;
  const norm = (s: string) => s.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
  if (norm(city) === norm(country)) return true;
  const a = countryCodeForName(city);
  return a !== null && a === countryCodeForName(country);
}

const COMPASS = new Set(['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']);
const RELATIVE_PLACE = /^(\d+(?:\.\d+)?)\s?km\s+([NSEW]{1,3})\s+of\s+(.+)$/;

/**
 * Localize the compass direction in USGS-style "6 km SE of Pitaloza Arriba, Panama".
 * The distance and place name are kept verbatim; anything that does not parse
 * unambiguously is returned unchanged.
 */
export function localizeRelativePlace(place: string | null | undefined): string {
  if (!place) return '';
  if (getCurrentLanguageTag() === 'en') return place;
  const match = RELATIVE_PLACE.exec(place.trim());
  if (!match) return place;
  const [, distance, dir, rest] = match;
  if (!distance || !dir || !rest || !COMPASS.has(dir)) return place;
  const direction = lookupLabel('popups.compass', dir.toLowerCase());
  if (!direction) return place;
  const out = t('popups.earthquake.relativePlace', { distance, direction, place: rest });
  return out && out !== 'popups.earthquake.relativePlace' ? out : place;
}

const GDELT_REPORT_TITLE = /^(.*)\s\((\d+) reports?\)$/;

/** Parse the GDELT seed's "<place> (<n> reports)" title into its parts. */
export function parseGdeltReportTitle(title: string | null | undefined): { place: string; count: number } | null {
  if (!title) return null;
  const match = GDELT_REPORT_TITLE.exec(title.trim());
  if (!match?.[1]) return null;
  const count = Number(match[2]);
  return Number.isFinite(count) ? { place: match[1].trim(), count } : null;
}
