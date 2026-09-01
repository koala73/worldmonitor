import type {
  ServerContext,
  GetCountryFactsRequest,
  GetCountryFactsResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { cachedFetchJson } from '../../../_shared/redis';
import iso2ToIso3Json from '../../../../shared/iso2-to-iso3.json';

const FACTS_TTL = 86400;
const NEGATIVE_TTL = 120;
const UPSTREAM_TIMEOUT = 10_000;
const WIKIDATA_ATTEMPTS = 2;
const WIKIMEDIA_UA = 'WorldMonitorCountryFacts/1.0 (https://worldmonitor.app; monitor@worldmonitor.app)';
const ISO2_TO_ISO3 = iso2ToIso3Json as Record<string, string>;

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
  const iso3 = ISO2_TO_ISO3[code];
  if (!iso3) return null;
  try {
    return await cachedFetchJson<WikiResult>(
      `intel:country-facts:wikidata:v5:${code}`,
      FACTS_TTL,
      async () => {
        const sparql = `SELECT ?countryLabel ?headLabel ?officeLabel ?population ?area ?capitalLabel ?languageLabel ?currencyLabel WHERE { ?country wdt:P297 "${code}"; wdt:P298 "${iso3}". OPTIONAL { ?country p:P35 ?headStatement. ?headStatement ps:P35 ?head. FILTER NOT EXISTS { ?headStatement pq:P582 ?headEnd } OPTIONAL { ?headStatement pq:P39 ?office } } OPTIONAL { ?country wdt:P1082 ?population } OPTIONAL { ?country wdt:P2046 ?area } OPTIONAL { ?country wdt:P36 ?capital } OPTIONAL { ?country p:P37 ?languageStatement. ?languageStatement ps:P37 ?language. FILTER NOT EXISTS { ?languageStatement pq:P518 ?languageRegion } FILTER NOT EXISTS { ?languageStatement pq:P582 ?languageEnd } } OPTIONAL { ?country p:P38 ?currencyStatement. ?currencyStatement ps:P38 ?currency. FILTER NOT EXISTS { ?currencyStatement pq:P518 ?currencyRegion } FILTER NOT EXISTS { ?currencyStatement pq:P582 ?currencyEnd } } SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul" } } ORDER BY ?capitalLabel ?languageLabel ?currencyLabel`;
        const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`;

        for (let attempt = 0; attempt < WIKIDATA_ATTEMPTS; attempt += 1) {
          let resp: Response;
          try {
            resp = await fetch(url, {
              headers: { 'User-Agent': WIKIMEDIA_UA, Accept: 'application/json' },
              signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
            });
          } catch (error) {
            if (attempt === WIKIDATA_ATTEMPTS - 1) throw error;
            continue;
          }
          if (!resp.ok) {
            if (attempt === 0 && resp.status >= 500) continue;
            throw new Error(`Wikidata SPARQL HTTP ${resp.status}`);
          }
          const data = (await resp.json()) as WikidataResponse;
          const bindings = data.results?.bindings ?? [];
          const expectedName = displayCountryName(code);
          const matchingBindings = bindings.filter(binding => (
            cleanLabel(binding.countryLabel?.value).localeCompare(expectedName, 'en', {
              sensitivity: 'base',
            }) === 0
          ));
          return parseWikidataFacts(matchingBindings.length > 0 ? matchingBindings : bindings);
        }

        throw new Error('Wikidata SPARQL exhausted retries');
      },
      NEGATIVE_TTL,
      // Transient 429/5xx/network errors must not become NEG_SENTINEL. A 200
      // with no bindings still returns null and is negative-cached as empty.
      { cacheFetcherErrors: false },
    );
  } catch {
    return null;
  }
}

function parseWikidataFacts(bindings: WikidataBinding[]): WikiResult | null {
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

  return {
    headOfState: firstLabel('headLabel'),
    headOfStateTitle: firstLabel('officeLabel'),
    population: Math.trunc(firstNumber('population')),
    areaSqKm: firstNumber('area'),
    capital: firstLabel('capitalLabel'),
    languages: uniqueLabels(bindings.map(binding => binding.languageLabel?.value)),
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
            headers: { 'User-Agent': WIKIMEDIA_UA },
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
