import type {
  ServerContext,
  GetCountryFactsRequest,
  GetCountryFactsResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { cachedFetchJson } from '../../../_shared/redis';
import { CHROME_UA } from '../../../_shared/constants';

const FACTS_TTL = 86400;
const NEGATIVE_TTL = 120;
const UPSTREAM_TIMEOUT = 10_000;

interface WikidataBinding {
  countryLabel?: { value?: string };
  headLabel?: { value?: string };
  officeLabel?: { value?: string };
  population?: { value?: string };
  area?: { value?: string };
  capitalLabel?: { value?: string };
  languageLabel?: { value?: string };
  currencyLabel?: { value?: string };
}

interface WikidataResponse {
  results?: { bindings?: WikidataBinding[] };
}

interface WikipediaSummary {
  extract?: string;
  thumbnail?: { source?: string };
}

const EMPTY: GetCountryFactsResponse = {
  headOfState: '',
  headOfStateTitle: '',
  wikipediaSummary: '',
  wikipediaThumbnailUrl: '',
  population: 0,
  capital: '',
  languages: [],
  currencies: [],
  areaSqKm: 0,
  countryName: '',
};

export async function getCountryFacts(
  _ctx: ServerContext,
  req: GetCountryFactsRequest,
): Promise<GetCountryFactsResponse> {
  if (!req.countryCode) return EMPTY;

  const code = req.countryCode.toUpperCase();
  const countryData = await fetchWikidata(code);
  const countryName = countryData?.countryName || displayCountryName(code);

  const wikiSummary = countryName ? await fetchWikipediaSummary(code, countryName) : null;

  return {
    headOfState: countryData?.headOfState ?? '',
    headOfStateTitle: countryData?.headOfStateTitle ?? '',
    wikipediaSummary: wikiSummary?.extract ?? '',
    wikipediaThumbnailUrl: wikiSummary?.thumbnailUrl ?? '',
    population: countryData?.population ?? 0,
    capital: countryData?.capital ?? '',
    languages: countryData?.languages ?? [],
    currencies: countryData?.currencies ?? [],
    areaSqKm: countryData?.areaSqKm ?? 0,
    countryName,
  };
}

interface WikiResult {
  headOfState: string;
  headOfStateTitle: string;
  population: number;
  areaSqKm: number;
  capital: string;
  languages: string[];
  currencies: string[];
  countryName: string;
}

async function fetchWikidata(code: string): Promise<WikiResult | null> {
  if (!/^[A-Z]{2}$/.test(code)) return null;
  try {
    return await cachedFetchJson<WikiResult>(
      `intel:country-facts:wikidata:v2:${code}`,
      FACTS_TTL,
      async () => {
        try {
          const sparql = `SELECT ?countryLabel ?headLabel ?officeLabel ?population ?area ?capitalLabel ?languageLabel ?currencyLabel WHERE { ?country wdt:P297 "${code}". OPTIONAL { ?country p:P35 ?headStatement. ?headStatement ps:P35 ?head. FILTER NOT EXISTS { ?headStatement pq:P582 ?headEnd } OPTIONAL { ?headStatement pq:P39 ?office } } OPTIONAL { ?country wdt:P1082 ?population } OPTIONAL { ?country wdt:P2046 ?area } OPTIONAL { ?country wdt:P36 ?capital } OPTIONAL { ?country wdt:P37 ?language } OPTIONAL { ?country wdt:P38 ?currency } SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul" } } ORDER BY ?capitalLabel ?languageLabel ?currencyLabel LIMIT 100`;
          const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`;
          const resp = await fetch(url, {
            headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
          });
          if (!resp.ok) return null;
          const data = (await resp.json()) as WikidataResponse;
          return parseWikidataFacts(code, data.results?.bindings ?? []);
        } catch {
          return null;
        }
      },
      NEGATIVE_TTL,
    );
  } catch {
    return null;
  }
}

function parseWikidataFacts(code: string, bindings: WikidataBinding[]): WikiResult | null {
  if (bindings.length === 0) return null;

  const firstLabel = (field: keyof WikidataBinding): string => {
    for (const binding of bindings) {
      const label = cleanLabel(binding[field]?.value);
      if (label) return label;
    }
    return '';
  };
  const firstNumber = (field: 'population' | 'area'): number => {
    for (const binding of bindings) {
      const value = Number(binding[field]?.value);
      if (Number.isFinite(value) && value > 0) return value;
    }
    return 0;
  };

  const primaryLanguage = displayPrimaryLanguage(code);
  const wikidataLanguages = uniqueLabels(bindings.map(binding => binding.languageLabel?.value));

  return {
    headOfState: firstLabel('headLabel'),
    headOfStateTitle: firstLabel('officeLabel'),
    population: Math.trunc(firstNumber('population')),
    areaSqKm: firstNumber('area'),
    capital: firstLabel('capitalLabel'),
    languages: uniqueLabels([primaryLanguage, ...wikidataLanguages]),
    currencies: uniqueLabels(bindings.map(binding => binding.currencyLabel?.value)),
    countryName: firstLabel('countryLabel'),
  };
}

function cleanLabel(value: string | undefined): string {
  const label = value?.trim() ?? '';
  return /^Q\d+$/.test(label) ? '' : label;
}

function uniqueLabels(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const value of values) {
    const label = cleanLabel(value);
    const key = label.toLocaleLowerCase('en');
    if (!label || seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
  }
  return labels;
}

function displayCountryName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? '';
  } catch {
    return '';
  }
}

function displayPrimaryLanguage(code: string): string {
  try {
    const language = new Intl.Locale(`und-${code}`).maximize().language;
    if (!language || language === 'und') return '';
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(language) ?? '';
  } catch {
    return '';
  }
}

interface WikiSummaryResult {
  extract: string;
  thumbnailUrl: string;
}

async function fetchWikipediaSummary(code: string, countryName: string): Promise<WikiSummaryResult | null> {
  try {
    return await cachedFetchJson<WikiSummaryResult>(
      `intel:country-facts:wikisummary:${code}`,
      FACTS_TTL,
      async () => {
        try {
          const encoded = encodeURIComponent(countryName);
          const resp = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encoded}`, {
            headers: { 'User-Agent': CHROME_UA },
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
          });
          if (!resp.ok) return null;
          const data = (await resp.json()) as WikipediaSummary;
          return {
            extract: data.extract ?? '',
            thumbnailUrl: data.thumbnail?.source ?? '',
          };
        } catch {
          return null;
        }
      },
      NEGATIVE_TTL,
    );
  } catch {
    return null;
  }
}
