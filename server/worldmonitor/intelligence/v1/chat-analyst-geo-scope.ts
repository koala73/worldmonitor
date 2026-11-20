/**
 * The places a chat-analyst question names, and which digest headlines cover
 * them (#10863).
 *
 * Retrieval used to match raw question words against titles, so "Latin
 * America" became the keywords `latin` and `america`: the digest's `latam`
 * bucket never matched, "Americans" did, and "brazil" missed "Brazilian".
 * A region phrase now selects its digest category plus headlines that mention
 * a member country; a country name matches through `shared/country-mention.js`
 * (names, aliases, demonyms, exclusions).
 */
import {
  CODE_TOKEN_ALLOWLIST,
  countryDisplayName,
  countryMentionTerms,
  mentionsCountry,
  normalizeMentionText,
  type CountryMentionTerms,
} from '../../../../shared/country-mention.js';
import { resolveCountryCode } from '../../../../shared/country-code-resolve';
import {
  getForecastMacroRegionMembers,
  type ForecastMacroRegionId,
} from '../../../../shared/forecast-macro-regions.js';

interface RegionDefinition {
  label: string;
  /** Digest category key (`news:digest:v1:*` → `categories.<key>`). */
  category: string;
  macroRegions: ForecastMacroRegionId[];
  /**
   * Corrections to the forecast taxonomy, which files countries by strategic
   * theatre: Mexico sits in north-america, North Africa in mena, Malta in
   * mena, Central Asia in europe. A reader asking about "Latin America" or
   * "Africa" means the continent.
   */
  extraMembers?: string[];
  excludedMembers?: string[];
  /**
   * Explicit member list, replacing the taxonomy (a sub-region the taxonomy
   * does not model, such as South America).
   */
  members?: string[];
  /**
   * Whether the digest bucket alone is evidence. Off for sub-regions: the
   * `asia` bucket carries China and Japan stories, which say nothing about
   * South Asia.
   */
  bucketCounts?: boolean;
  /** Lowercase, space-separated, matched as whole tokens. */
  phrases: string[];
}

const REGIONS: RegionDefinition[] = [
  {
    label: 'Latin America',
    category: 'latam',
    macroRegions: ['latam'],
    extraMembers: ['MX'],
    phrases: ['latin america', 'latin american', 'latam'],
  },
  {
    label: 'Central America',
    category: 'latam',
    macroRegions: [],
    members: ['BZ', 'CR', 'GT', 'HN', 'NI', 'PA', 'SV'],
    bucketCounts: false,
    phrases: ['central america', 'central american'],
  },
  {
    label: 'the Caribbean',
    category: 'latam',
    macroRegions: [],
    members: [
      'AG', 'AI', 'AW', 'BB', 'BL', 'BQ', 'BS', 'CU', 'CW', 'DM', 'DO', 'GD', 'GP', 'HT', 'JM',
      'KN', 'KY', 'LC', 'MF', 'MQ', 'MS', 'PR', 'SX', 'TC', 'TT', 'VC', 'VG', 'VI',
    ],
    bucketCounts: false,
    phrases: ['caribbean'],
  },
  {
    label: 'South America',
    category: 'latam',
    macroRegions: [],
    members: ['AR', 'BO', 'BR', 'CL', 'CO', 'EC', 'FK', 'GF', 'GY', 'PE', 'PY', 'SR', 'UY', 'VE'],
    bucketCounts: false,
    phrases: ['south america', 'south american'],
  },
  {
    label: 'the Middle East',
    category: 'middleeast',
    macroRegions: ['mena'],
    excludedMembers: ['MT'],
    phrases: ['middle east', 'middle eastern', 'mena', 'persian gulf', 'gulf states'],
  },
  { label: 'South Asia', category: 'asia', macroRegions: ['south-asia'], bucketCounts: false, phrases: ['south asia', 'south asian'] },
  { label: 'East Asia', category: 'asia', macroRegions: ['east-asia'], bucketCounts: false, phrases: ['east asia', 'east asian'] },
  {
    label: 'Asia',
    category: 'asia',
    macroRegions: ['east-asia', 'south-asia'],
    extraMembers: ['KG', 'KZ', 'TJ', 'TM', 'UZ'],
    phrases: ['asia pacific', 'asia', 'asian', 'apac'],
  },
  {
    label: 'Sub-Saharan Africa',
    category: 'africa',
    macroRegions: ['sub-saharan-africa'],
    bucketCounts: false,
    phrases: ['sub saharan africa', 'sub saharan african'],
  },
  {
    label: 'Africa',
    category: 'africa',
    macroRegions: ['sub-saharan-africa'],
    extraMembers: ['DJ', 'DZ', 'EG', 'LY', 'MA', 'TN'],
    phrases: ['africa', 'african'],
  },
  {
    label: 'Europe',
    category: 'europe',
    macroRegions: ['europe'],
    extraMembers: ['MT'],
    excludedMembers: ['KG', 'KZ', 'TJ', 'TM', 'UZ'],
    phrases: ['europe', 'european'],
  },
];

const REGION_BY_PHRASE = new Map<string, RegionDefinition>(
  REGIONS.flatMap((region) => region.phrases.map((phrase) => [phrase, region] as const)),
);

/**
 * Tokens of three letters or fewer that name a country. Everything else that
 * short is left alone: `resolveCountryCode` accepts any alpha-2/alpha-3 shape,
 * so "can", "per" and "are" would resolve to Canada, Peru and the UAE.
 * Lowercase "us" stays a keyword ("tell us …"); uppercase "US" is the country.
 */
const SHORT_COUNTRY_TOKENS: Record<string, string> = { usa: 'US', uk: 'GB', uae: 'AE', drc: 'CD' };
const UPPERCASE_ONLY_COUNTRY_TOKENS: Record<string, string> = { US: 'US' };

const MAX_PHRASE_TOKENS = 5;
const MAX_SCOPE_COUNTRIES = 4;
const MAX_SCOPE_REGIONS = 3;

export interface GeoCountry {
  code: string;
  label: string;
  terms: CountryMentionTerms;
}

export interface GeoRegion {
  label: string;
  category: string;
  /** The region's own phrases, normalized, for a headline that names it. */
  phrases: string[];
  bucketCounts: boolean;
  members: CountryMentionTerms[];
}

export interface GeoScope {
  countries: GeoCountry[];
  regions: GeoRegion[];
  /** The question with every place phrase removed, for keyword extraction. */
  residualQuery: string;
}

const termsCache = new Map<string, CountryMentionTerms>();

function termsFor(code: string): CountryMentionTerms {
  let terms = termsCache.get(code);
  if (!terms) {
    terms = countryMentionTerms(code);
    termsCache.set(code, terms);
  }
  return terms;
}

function regionMembers(region: RegionDefinition): string[] {
  const excluded = new Set(region.excludedMembers ?? []);
  const codes = new Set([
    ...(region.members ?? []),
    ...region.macroRegions.flatMap((id) => getForecastMacroRegionMembers(id)),
    ...(region.extraMembers ?? []),
  ]);
  return [...codes].filter((code) => !excluded.has(code));
}

function resolveCountryPhrase(raw: string[], lower: string): string | null {
  if (raw.length === 1 && lower.length <= 3) {
    return SHORT_COUNTRY_TOKENS[lower] ?? UPPERCASE_ONLY_COUNTRY_TOKENS[raw[0]!] ?? null;
  }
  return resolveCountryCode(lower);
}

export function resolveGeoScope(query: string): GeoScope {
  const tokens = query.normalize('NFKD').replace(/\p{Diacritic}/gu, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const countries: GeoCountry[] = [];
  const regions: GeoRegion[] = [];
  const residual: string[] = [];

  for (let i = 0; i < tokens.length;) {
    let consumed = 0;
    for (let n = Math.min(MAX_PHRASE_TOKENS, tokens.length - i); n >= 1 && consumed === 0; n -= 1) {
      const raw = tokens.slice(i, i + n);
      const lower = raw.join(' ').toLowerCase();
      const region = REGION_BY_PHRASE.get(lower);
      if (region) {
        if (regions.length < MAX_SCOPE_REGIONS && !regions.some((r) => r.label === region.label)) {
          regions.push({
            label: region.label,
            category: region.category,
            phrases: region.phrases,
            bucketCounts: region.bucketCounts ?? true,
            members: regionMembers(region).map(termsFor),
          });
        } else if (regions.length >= MAX_SCOPE_REGIONS) {
          residual.push(...raw);
        }
        consumed = n;
        continue;
      }
      const code = resolveCountryPhrase(raw, lower);
      if (code) {
        const label = countryDisplayName(code);
        if (!label) continue;
        if (countries.length < MAX_SCOPE_COUNTRIES && !countries.some((c) => c.code === code)) {
          countries.push({ code, label, terms: termsFor(code) });
        } else if (countries.length >= MAX_SCOPE_COUNTRIES) {
          // Past the cap the place still narrows retrieval as a plain keyword.
          residual.push(...raw);
        }
        consumed = n;
      }
    }
    if (consumed === 0) {
      residual.push(tokens[i]!);
      consumed = 1;
    }
    i += consumed;
  }

  return { countries, regions, residualQuery: residual.join(' ') };
}

export function hasGeoScope(scope: GeoScope): boolean {
  return scope.countries.length > 0 || scope.regions.length > 0;
}

/**
 * `mentionsCountry` compiles a regex per term; a substring pre-check skips it
 * for the near-every headline that cannot match.
 */
function mentions(rawTitle: string, normalizedTitle: string, terms: CountryMentionTerms): boolean {
  const candidate = terms.names.some((name) => name && normalizedTitle.includes(name))
    || terms.demonyms.some((demonym) => demonym && rawTitle.includes(demonym))
    // "US tariffs on steel": the shared matcher accepts allowlisted codes.
    || (CODE_TOKEN_ALLOWLIST.has(terms.code) && rawTitle.includes(terms.code));
  return candidate && mentionsCountry(rawTitle, terms);
}

export interface PlaceMatch {
  countries: Set<string>;
  regions: Set<string>;
  /**
   * How strongly the headline covers the scope: one per place it names, half
   * for a region it reaches only through its digest bucket (an outlet's
   * bucket also carries that outlet's off-region stories).
   */
  score: number;
}

/** Which of the scope's places a headline covers, by text or by digest category. */
export function matchPlaces(scope: GeoScope, title: string, category: string | undefined): PlaceMatch {
  const normalized = normalizeMentionText(title);
  const countries = new Set<string>();
  const regions = new Set<string>();
  let score = 0;
  for (const country of scope.countries) {
    if (mentions(title, normalized, country.terms)) {
      countries.add(country.code);
      score += 1;
    }
  }
  for (const region of scope.regions) {
    const namesRegion = region.phrases.some((phrase) => new RegExp(`(^|[^a-z0-9])${phrase}(?=$|[^a-z0-9])`).test(normalized));
    if (namesRegion || region.members.some((terms) => mentions(title, normalized, terms))) {
      regions.add(region.label);
      score += 1;
    } else if (region.bucketCounts && category && category === region.category) {
      regions.add(region.label);
      score += 0.5;
    }
  }
  return { countries, regions, score };
}
