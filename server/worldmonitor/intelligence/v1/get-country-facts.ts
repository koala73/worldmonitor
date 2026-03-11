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

interface RestCountryData {
  name?: { common?: string };
  population?: number;
  capital?: string[];
  languages?: Record<string, string>;
  currencies?: Record<string, { name?: string }>;
  area?: number;
}

interface WikidataBinding {
  headLabel?: { value?: string };
  officeLabel?: { value?: string };
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

  const [rcData, wikiData] = await Promise.all([
    fetchRestCountries(code),
    fetchWikidata(code),
  ]);

  const countryName = rcData?.name?.common ?? '';

  const wikiSummary = countryName ? await fetchWikipediaSummary(code, countryName) : null;

  return {
    headOfState: wikiData?.headOfState ?? '',
    headOfStateTitle: wikiData?.headOfStateTitle ?? '',
    wikipediaSummary: wikiSummary?.extract ?? '',
    wikipediaThumbnailUrl: wikiSummary?.thumbnailUrl ?? '',
    population: rcData?.population ?? 0,
    capital: rcData?.capital?.[0] ?? '',
    languages: rcData?.languages ? Object.values(rcData.languages) : [],
    currencies: rcData?.currencies
      ? Object.values(rcData.currencies).map(c => c.name ?? '').filter(Boolean)
      : [],
    areaSqKm: rcData?.area ?? 0,
    countryName,
  };
}

async function fetchRestCountries(code: string): Promise<RestCountryData | null> {
  try {
    return await cachedFetchJson<RestCountryData>(
      `intel:country-facts:rc:${code}`,
      FACTS_TTL,
      async () => {
        try {
          const resp = await fetch(`https://restcountries.com/v3.1/alpha/${code}`, {
            headers: { 'User-Agent': CHROME_UA },
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
          });
          if (!resp.ok) return null;
          const data = await resp.json();
          const entry = Array.isArray(data) ? data[0] : data;
          if (!entry) return null;
          return {
            name: entry.name,
            population: entry.population,
            capital: entry.capital,
            languages: entry.languages,
            currencies: entry.currencies,
            area: entry.area,
          } as RestCountryData;
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

interface WikiResult {
  headOfState: string;
  headOfStateTitle: string;
}

async function fetchWikidata(code: string): Promise<WikiResult | null> {
  if (!/^[A-Z]{2}$/.test(code)) return null;
  try {
    return await cachedFetchJson<WikiResult>(
      `intel:country-facts:wiki:${code}`,
      FACTS_TTL,
      async () => {
        try {
          const sparql = `SELECT ?headLabel ?officeLabel WHERE { ?country wdt:P297 "${code}". ?country p:P35 ?stmt. ?stmt ps:P35 ?head. FILTER NOT EXISTS { ?stmt pq:P582 ?end } OPTIONAL { ?stmt pq:P39 ?office } SERVICE wikibase:label { bd:serviceParam wikibase:language "en" } } LIMIT 1`;
          const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`;
          const resp = await fetch(url, {
            headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
          });
          if (!resp.ok) return null;
          const data = (await resp.json()) as WikidataResponse;
          const binding = data.results?.bindings?.[0];
          if (!binding) return null;
          return {
            headOfState: binding.headLabel?.value ?? '',
            headOfStateTitle: binding.officeLabel?.value ?? '',
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
