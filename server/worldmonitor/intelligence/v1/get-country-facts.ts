import type {
  ServerContext,
  GetCountryFactsRequest,
  GetCountryFactsResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { cachedFetchJson } from '../../../_shared/redis';
import unToIso2Json from '../../../../shared/un-to-iso2.json';

const FACTS_TTL = 86400;
const NEGATIVE_TTL = 120;
const UPSTREAM_TIMEOUT = 10_000;
const WIKIDATA_ATTEMPTS = 2;
const WIKIMEDIA_UA = 'WorldMonitorCountryFacts/1.0 (https://worldmonitor.app; monitor@worldmonitor.app)';
const ISO2_TO_M49 = Object.fromEntries(
  Object.entries(unToIso2Json as Record<string, string>).map(([m49, iso2]) => [iso2, m49]),
) as Record<string, string>;

interface WikidataBinding {
  country?: { value?: string };
  countryLabel?: { value?: string };
  m49?: { value?: string };
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
  const m49 = ISO2_TO_M49[code];
  if (!m49) return null;
  try {
    return await cachedFetchJson<WikiResult>(
      `intel:country-facts:wikidata:v5:${code}`,
      FACTS_TTL,
      async () => {
        const entityQuery = `SELECT ?country ?countryLabel ?m49 WHERE { ?country wdt:P297 "${code}". OPTIONAL { ?country wdt:P2082 ?m49 } SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul" } } LIMIT 10`;
        const entityBindings = await fetchWikidataBindings(entityQuery);
        const entityId = resolveEntityId(entityBindings, m49);
        if (!entityId) return null;

        const factsQuery = `SELECT ?countryLabel ?headLabel ?officeLabel ?population ?area ?capitalLabel ?languageLabel ?currencyLabel WHERE { VALUES ?country { wd:${entityId} } OPTIONAL { ?country p:P35 ?headStatement. ?headStatement ps:P35 ?head. FILTER NOT EXISTS { ?headStatement pq:P582 ?headEnd } OPTIONAL { ?headStatement pq:P39 ?office } } OPTIONAL { ?country wdt:P1082 ?population } OPTIONAL { ?country wdt:P2046 ?area } OPTIONAL { ?country wdt:P36 ?capital } OPTIONAL { ?country p:P37 ?languageStatement. ?languageStatement ps:P37 ?language. FILTER NOT EXISTS { ?languageStatement pq:P518 ?languageRegion } FILTER NOT EXISTS { ?languageStatement pq:P582 ?languageEnd } } OPTIONAL { ?country p:P38 ?currencyStatement. ?currencyStatement ps:P38 ?currency. FILTER NOT EXISTS { ?currencyStatement pq:P582 ?currencyEnd } FILTER NOT EXISTS { ?currencyStatement pq:P518 ?currencyRegion. ?currencyRegion wdt:P297 ?currencyRegionCode. FILTER(?currencyRegionCode != "${code}") } } SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul" } } ORDER BY ?capitalLabel ?languageLabel ?currencyLabel LIMIT 100`;
        return parseWikidataFacts(await fetchWikidataBindings(factsQuery));
      },
      NEGATIVE_TTL,
      { cacheFetcherErrors: false },
    );
  } catch {
    return null;
  }
}

async function fetchWikidataBindings(sparql: string): Promise<WikidataBinding[]> {
  const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`;

  for (let attempt = 0; attempt < WIKIDATA_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { 'User-Agent': WIKIMEDIA_UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
      });
    } catch (error) {
      if (attempt === WIKIDATA_ATTEMPTS - 1) throw error;
      continue;
    }

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < WIKIDATA_ATTEMPTS - 1) continue;
      throw new Error(`Wikidata request failed with status ${response.status}`);
    }

    try {
      const data = (await response.json()) as WikidataResponse;
      return data.results?.bindings ?? [];
    } catch (error) {
      if (attempt === WIKIDATA_ATTEMPTS - 1) throw error;
    }
  }

  throw new Error('Wikidata request failed');
}

function resolveEntityId(bindings: WikidataBinding[], expectedM49: string): string | null {
  const candidates = new Map<string, Set<string>>();
  for (const binding of bindings) {
    const id = binding.country?.value?.match(/\/entity\/(Q\d+)$/)?.[1];
    if (!id) continue;
    const codes = candidates.get(id) ?? new Set<string>();
    const m49 = binding.m49?.value;
    if (m49) codes.add(m49);
    candidates.set(id, codes);
  }

  const m49Matches = [...candidates.entries()]
    .filter(([, codes]) => codes.has(expectedM49))
    .map(([id]) => id);
  if (m49Matches.length === 1) return m49Matches[0] ?? null;
  if (m49Matches.length === 0 && candidates.size === 1) {
    return candidates.keys().next().value ?? null;
  }
  return null;
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
