/**
 * IMF WEO per-country data — fetches the four IMF SDMX-3.0 seeded keys
 * (macro, growth, labor, external) via /api/bootstrap and returns the
 * subset for one country. Used by CountryDeepDivePanel Economic
 * Indicators + Country Facts cards (issue #3027).
 *
 * Network policy: single bootstrap GET with comma-separated keys; result
 * is memoised for ~10 min since WEO is a monthly release.
 */

import { toApiUrl } from '@/services/runtime';

export interface ImfMacroEntry {
  inflationPct: number | null;
  currentAccountPct: number | null;
  govRevenuePct: number | null;
  cpiIndex: number | null;
  cpiEopPct: number | null;
  govExpenditurePct: number | null;
  primaryBalancePct: number | null;
  year: number | null;
}

export interface ImfGrowthEntry {
  realGdpGrowthPct: number | null;
  gdpPerCapitaUsd: number | null;
  realGdp: number | null;
  gdpPerCapitaPpp: number | null;
  gdpPpp: number | null;
  investmentPct: number | null;
  savingsPct: number | null;
  savingsInvestmentGap: number | null;
  year: number | null;
}

export interface ImfLaborEntry {
  unemploymentPct: number | null;
  populationMillions: number | null;
  year: number | null;
}

export interface ImfExternalEntry {
  exportsUsd: number | null;
  importsUsd: number | null;
  tradeBalanceUsd: number | null;
  currentAccountUsd: number | null;
  importVolumePctChg: number | null;
  exportVolumePctChg: number | null;
  year: number | null;
}

export interface ImfCountryBundle {
  macro: ImfMacroEntry | null;
  growth: ImfGrowthEntry | null;
  labor: ImfLaborEntry | null;
  external: ImfExternalEntry | null;
  fetchedAt: number;
}

interface ImfBootstrapPayload {
  data?: {
    imfMacro?: { countries?: Record<string, ImfMacroEntry> };
    imfGrowth?: { countries?: Record<string, ImfGrowthEntry> };
    imfLabor?: { countries?: Record<string, ImfLaborEntry> };
    imfExternal?: { countries?: Record<string, ImfExternalEntry> };
  };
}

const CACHE_TTL_MS = 10 * 60 * 1000;
let cachedBundle: { fetchedAt: number; payload: ImfBootstrapPayload['data'] } | null = null;
let inFlight: Promise<ImfBootstrapPayload['data']> | null = null;

async function fetchBundle(): Promise<ImfBootstrapPayload['data']> {
  if (cachedBundle && Date.now() - cachedBundle.fetchedAt < CACHE_TTL_MS) {
    return cachedBundle.payload;
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const resp = await fetch(
        toApiUrl('/api/bootstrap?keys=imfMacro,imfGrowth,imfLabor,imfExternal'),
        { signal: AbortSignal.timeout(8_000) },
      );
      if (!resp.ok) return undefined;
      const payload = (await resp.json()) as ImfBootstrapPayload;
      cachedBundle = { fetchedAt: Date.now(), payload: payload.data };
      return payload.data;
    } catch {
      return undefined;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * Look up a country's IMF data across all four themed seeders.
 * Returns null entries for any theme that has no data for this country
 * (or whose seeder is offline). Never throws.
 */
export async function getImfCountryBundle(iso2Code: string): Promise<ImfCountryBundle> {
  const code = iso2Code.toUpperCase();
  const data = await fetchBundle();
  return {
    macro: data?.imfMacro?.countries?.[code] ?? null,
    growth: data?.imfGrowth?.countries?.[code] ?? null,
    labor: data?.imfLabor?.countries?.[code] ?? null,
    external: data?.imfExternal?.countries?.[code] ?? null,
    fetchedAt: cachedBundle?.fetchedAt ?? Date.now(),
  };
}

/**
 * Pure helper — selects up to N IMF-derived indicators ranked by
 * highest-signal-first ordering for the Economic Indicators card.
 * Exported so unit tests don't need to mock the network.
 */
export function buildImfEconomicIndicators(bundle: ImfCountryBundle): {
  label: string;
  value: string;
  trend: 'up' | 'down' | 'flat';
  source: string;
}[] {
  const out: { label: string; value: string; trend: 'up' | 'down' | 'flat'; source: string }[] = [];

  const growth = bundle.growth?.realGdpGrowthPct;
  if (growth != null && Number.isFinite(growth)) {
    out.push({
      label: 'Real GDP Growth',
      value: `${growth >= 0 ? '+' : ''}${growth.toFixed(1)}%`,
      trend: growth > 0.5 ? 'up' : growth < -0.5 ? 'down' : 'flat',
      source: 'IMF WEO',
    });
  }

  const inflation = bundle.macro?.inflationPct;
  if (inflation != null && Number.isFinite(inflation)) {
    out.push({
      label: 'CPI Inflation',
      value: `${inflation >= 0 ? '+' : ''}${inflation.toFixed(1)}%`,
      // High inflation = bad for stability; flag downward trend on >5%.
      trend: inflation > 5 ? 'down' : inflation < 1 ? 'flat' : 'up',
      source: 'IMF WEO',
    });
  }

  const lur = bundle.labor?.unemploymentPct;
  if (lur != null && Number.isFinite(lur)) {
    out.push({
      label: 'Unemployment',
      value: `${lur.toFixed(1)}%`,
      trend: lur > 10 ? 'down' : lur < 5 ? 'up' : 'flat',
      source: 'IMF WEO',
    });
  }

  const gdpPc = bundle.growth?.gdpPerCapitaUsd;
  if (gdpPc != null && Number.isFinite(gdpPc)) {
    const formatted = gdpPc >= 1000
      ? `$${(gdpPc / 1000).toFixed(1)}k`
      : `$${gdpPc.toFixed(0)}`;
    out.push({
      label: 'GDP / Capita',
      value: formatted,
      trend: 'flat',
      source: 'IMF WEO',
    });
  }

  return out;
}
