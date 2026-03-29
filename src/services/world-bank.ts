/**
 * World Bank REST API — free, no API key, CORS-enabled.
 * Fetches key economic indicators per country with a 1-hour in-memory cache.
 */

export interface WorldBankProfile {
  iso: string;
  gdpUsd: number | null;        // NY.GDP.MKTP.CD
  gdpPerCapita: number | null;  // NY.GDP.PCAP.CD
  militaryPctGdp: number | null; // MS.MIL.XPND.GD.ZS
  tradePctGdp: number | null;   // NE.TRD.GNFS.ZS
  population: number | null;    // SP.POP.TOTL
  year: number | null;
}

const INDICATORS = [
  'NY.GDP.MKTP.CD',
  'NY.GDP.PCAP.CD',
  'MS.MIL.XPND.GD.ZS',
  'NE.TRD.GNFS.ZS',
  'SP.POP.TOTL',
] as const;

const profileCache = new Map<string, { profile: WorldBankProfile; fetchedAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const CACHE_MAX_ENTRIES = 250;

/** Evict the oldest entries when the cache grows too large. */
function evictOldCacheEntries(): void {
  if (profileCache.size <= CACHE_MAX_ENTRIES) return;
  const cutoff = Date.now() - CACHE_TTL_MS;
  for (const [k, v] of profileCache) {
    if (v.fetchedAt < cutoff) profileCache.delete(k);
    if (profileCache.size <= CACHE_MAX_ENTRIES) break;
  }
}

async function fetchIndicator(iso: string, indicator: string): Promise<{ value: number | null; year: number | null }> {
  const url = `https://api.worldbank.org/v2/country/${iso}/indicator/${indicator}?format=json&mrv=3`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { value: null, year: null };
    const json = await res.json() as [unknown, { value: number | null; date: string }[] | null];
    const rows = json[1];
    if (!Array.isArray(rows)) return { value: null, year: null };
    for (const row of rows) {
      if (row.value != undefined) {
        return { value: row.value, year: Number.parseInt(row.date, 10) };
      }
    }
    return { value: null, year: null };
  } catch {
    // Network error or timeout — return nulls so callers degrade gracefully
    return { value: null, year: null };
  }
}

export async function fetchWorldBankProfile(iso: string): Promise<WorldBankProfile> {
  const key = iso.toUpperCase();
  const cached = profileCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.profile;
  }

  const results = await Promise.allSettled(
    INDICATORS.map(ind => fetchIndicator(key, ind))
  );

  const get = (i: number) => {
    const r = results[i];
    if (!r) return { value: null as number | null, year: null as number | null };
    return r.status === 'fulfilled' ? r.value : { value: null as number | null, year: null as number | null };
  };

  const gdp = get(0);
  const gdpCap = get(1);
  const mil = get(2);
  const trade = get(3);
  const pop = get(4);

  const year = gdp.year ?? gdpCap.year ?? pop.year;

  const profile: WorldBankProfile = {
    iso: key,
    gdpUsd: gdp.value,
    gdpPerCapita: gdpCap.value,
    militaryPctGdp: mil.value,
    tradePctGdp: trade.value,
    population: pop.value,
    year,
  };

  evictOldCacheEntries();
  profileCache.set(key, { profile, fetchedAt: Date.now() });
  return profile;
}

/** Format a WorldBankProfile as a compact context string for AI prompts */
export function formatWorldBankContext(wb: WorldBankProfile): string {
  const parts: string[] = [];

  if (wb.gdpUsd != undefined) {
    const t = wb.gdpUsd / 1e12;
    parts.push(t >= 0.1 ? `GDP $${t.toFixed(2)}T` : `GDP $${(wb.gdpUsd / 1e9).toFixed(1)}B`);
  }
  if (wb.gdpPerCapita != undefined) {
    parts.push(`GDP/cap $${Math.round(wb.gdpPerCapita).toLocaleString()}`);
  }
  if (wb.militaryPctGdp != undefined) {
    parts.push(`Military ${wb.militaryPctGdp.toFixed(1)}% GDP`);
  }
  if (wb.population != undefined) {
    const m = wb.population / 1e6;
    parts.push(m >= 1 ? `Pop ${m.toFixed(1)}M` : `Pop ${Math.round(wb.population / 1e3)}K`);
  }
  if (wb.tradePctGdp != undefined) {
    parts.push(`Trade ${wb.tradePctGdp.toFixed(0)}% GDP`);
  }

  if (parts.length === 0) return '';
  return `Economic (World Bank ${wb.year ?? ''}): ${parts.join(' | ')}`;
}
