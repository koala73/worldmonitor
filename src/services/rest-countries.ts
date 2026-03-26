// REST Countries — no API key, CORS-friendly, called directly from the browser.
// https://restcountries.com/v3.1/alpha/{code}

export interface CountryMeta {
  name: string;
  capital: string;
  region: string;
  subregion: string;
  population: number;
  area: number;
  flag: string;      // emoji flag
  flagUrl: string;   // PNG URL
  currencies: string[];
  languages: string[];
  borders: string[]; // ISO3 codes
  latlng: [number, number];
  timezones: string[];
  tld: string[];
}

const cache = new Map<string, { data: CountryMeta; ts: number }>();
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours — country data changes rarely

export async function fetchCountryMeta(code: string): Promise<CountryMeta | null> {
  if (!code || code.length < 2) return null;
  const key = code.toUpperCase();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.data;
  try {
    const res = await fetch(
      `https://restcountries.com/v3.1/alpha/${encodeURIComponent(key)}?fields=name,capital,region,subregion,population,area,flag,flags,currencies,languages,borders,latlng,timezones,tld`,
      { headers: { Accept: 'application/json' } },
    );
    if (!res.ok) return null;
    const raw = await res.json();
    const d = Array.isArray(raw) ? raw[0] : raw;
    if (!d) return null;

    const meta: CountryMeta = {
      name: d.name?.common ?? d.name?.official ?? key,
      capital: Array.isArray(d.capital) ? (d.capital[0] ?? '') : '',
      region: d.region ?? '',
      subregion: d.subregion ?? '',
      population: d.population ?? 0,
      area: d.area ?? 0,
      flag: d.flag ?? '',
      flagUrl: d.flags?.png ?? d.flags?.svg ?? '',
      currencies: Object.values(d.currencies ?? {}).map((c: any) => `${c.name} (${c.symbol ?? ''})`),
      languages: Object.values(d.languages ?? {}),
      borders: Array.isArray(d.borders) ? d.borders : [],
      latlng: Array.isArray(d.latlng) && d.latlng.length >= 2 ? [d.latlng[0], d.latlng[1]] : [0, 0],
      timezones: Array.isArray(d.timezones) ? d.timezones : [],
      tld: Array.isArray(d.tld) ? d.tld : [],
    };
    cache.set(key, { data: meta, ts: Date.now() });
    return meta;
  } catch {
    return null;
  }
}
